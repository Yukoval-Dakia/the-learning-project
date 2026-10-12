// YUK-1051 (D11) — 通用作答草稿自动保存 hook。
//
// 纪律（preflight §4）：
//   - saved 只在 server ack 之后出现；keepalive 发出不算保存证明。
//   - draft generation 可见（每次内容变更 +1，随 chip 展示）。
//   - 409 → conflict 态（版本冲突可见，不悄悄覆盖）。
//   - latest-wins：保存途中内容又变 → 当前保存落地后立即补一轮（seq 守卫，旧响应
//     无权盖新状态）。
//   - flush({ keepalive:true }) 供 pagehide/退出；finalization 等待 pending uploads
//     是宿主职责（这里只管草稿本文）。
//
// YUK-1483 — 不再用 effect 盯 value。hook 持有一个本次作答（visit）的草稿控制器，
// 宿主在真实事件里下命令：
//   - change(next, from)：用户编辑（输入、选项、附件增删）。from 是这次编辑开始时的值；
//     第一次 change 把它记为服务端恢复基线（不算脏），所以恢复出来的草稿不会被回存。
//   - hold() / resume()：进入不该自动保存的阶段（判分、提交中）时暂停并清掉待发的
//     debounce；回到作答时恢复，若仍有未存改动立刻重新排程。
//   - flush / retry：同前。
// 状态（state/generation/lastSavedAt）是控制器的真实快照，经 useSyncExternalStore 读。
// 订阅随组件挂载；最后一个订阅退出（卸载）时清掉未发的 debounce，并在一个 microtask 后
// 把未存改动 flush 出去（站内导航不丢最后几个字）；同一 tick 内重新订阅（StrictMode）则不
// flush。暂停（hold）时不发。`save` 须在一次作答内保持稳定（按 issuance 等身份 key 宿主）。
//
// YUK-1487 — keepalive flush 遇到在途保存且当前值与它发出的值不同：页面等不了、在途的普通
// fetch 也可能被浏览器取消，所以立刻再发一轮 { keepalive, chained } 保存当前值。宿主对
// chained 发 expected_save_epoch = 已 ack 纪元 + 1：服务端只在 stored > expected 时 409，
// 落库后 stored = existing + 1。在途保存带的是已 ack 纪元 E，链式带 E + 1：
//   - 在途先落（stored E→E+1），链式 E+1 不小于 stored → 落库 E+2，最新值胜；
//   - 链式先落（stored E→E+1），在途 E < E+1 → 409，旧值被拒，最新值仍在。
// 只对恰好一轮在途保存成立，所以每轮在途最多链一次。控制器之后先等链式结果：它成功，
// 在途那轮的失败（多半是被它挤掉的 409）不算冲突。
//
// YUK-1489 — 冲突要能走出来：onConflict 在一轮保存确认为冲突时调用一次（宿主去读服务端
// 当前版本给用户看）；用户选完后宿主调 rebase(server, keep)：把服务端版本记为新基线，
// keep='server' 时本地值也换成它（不发保存），keep='mine' 时恢复自动保存并立刻按新基线
// 存本地值（宿主此时发服务端当前纪元，期间若又有第三方写入照样 409，不会悄悄盖掉）。

import { useMemo, useState, useSyncExternalStore } from 'react';
import type { SaveState } from '@/ui/components/response/SaveStateChip';
import { ApiError } from '@/ui/lib/api';

function defaultSerialize<T>(value: T): string {
  return JSON.stringify(value) ?? '';
}

/**
 * chained = 这一轮是越过在途保存发出的（见文件头）：宿主须发 expected_save_epoch =
 * 已 ack 纪元 + 1，其余时候发已 ack 纪元（无草稿时为 0，不能缺省，否则服务端不做 stale 检查）。
 */
type SaveFn<T> = (value: T, ctx: { keepalive: boolean; chained: boolean }) => Promise<unknown>;

type ChainedOutcome = { ok: true; serialized: string } | { ok: false; error: unknown };

export interface UseResponseDraftAutosaveOptions<T> {
  /** resolve = server ack；reject(ApiError 409) → conflict。一次作答内保持稳定。 */
  save: SaveFn<T>;
  serialize?: (value: T) => string;
  debounceMs?: number;
  /**
   * 自动保存遇到 409 后自己 hold（宿主在冲突时不再允许自动保存，只能重新加载/放弃）。
   * 缺省 false：冲突后仍可 retry。
   */
  holdOnConflict?: boolean;
  /** 一轮保存确认为冲突（409，且不是被链式保存挤掉）时调用；参数是那次的错误。 */
  onConflict?: (error: unknown) => void;
}

export interface ResponseDraftAutosave<T> {
  state: SaveState;
  generation: number;
  lastSavedAt: number | null;
  /** 用户编辑：next = 编辑后的值，from = 编辑前的值（首次调用记为恢复基线）。 */
  change: (next: T, from: T) => void;
  /** 暂停自动保存（判分/提交中），清掉待发 debounce。 */
  hold: () => void;
  /** 恢复自动保存；仍有未存改动则重新排程。 */
  resume: () => void;
  /** 立即保存当前值（取消待发 debounce）；keepalive 供 pagehide。 */
  flush: (opts?: { keepalive?: boolean }) => Promise<boolean>;
  retry: () => void;
  /**
   * 冲突后按用户的选择重新对齐：server = 服务端当前版本。keep='server' 换成它（不保存），
   * keep='mine' 保留本地值并立刻保存。都会恢复自动保存。resolve = 是否已与服务端一致。
   */
  rebase: (server: T, keep: 'server' | 'mine') => Promise<boolean>;
}

interface AutosaveSnapshot {
  state: SaveState;
  generation: number;
  lastSavedAt: number | null;
}

class DraftAutosaveController<T> {
  private snapshot: AutosaveSnapshot = { state: 'idle', generation: 0, lastSavedAt: null };
  private listeners = new Set<() => void>();
  // 基线：服务端恢复态 / 最近一次 ACK 的序列化。此后序列化不同 = 脏。
  private baseline: string | null = null;
  private lastSerialized: string | null = null;
  private hasValue = false;
  private value: T | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // seq 守卫：只有最新一轮保存的响应可以写状态（旧成功不盖新失败，反之亦然）。
  private seq = 0;
  private inFlight: Promise<boolean> | null = null;
  // The one save chained past the in-flight request.
  private chained: Promise<ChainedOutcome> | null = null;
  // Bumped on every subscribe/unsubscribe; an unmount flush runs only if nothing re-subscribed.
  private attachSeq = 0;
  private enabled = true;
  private save: SaveFn<T> | null = null;
  private onConflict: ((error: unknown) => void) | undefined;

  constructor(
    private readonly serialize: (value: T) => string,
    private readonly debounceMs: number,
    private readonly holdOnConflict: boolean,
  ) {}

  getSnapshot = (): AutosaveSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.attachSeq += 1;
    // Re-subscribe (StrictMode) with an unsaved edit: re-arm the debounce dropped below.
    if (this.listeners.size === 1 && this.enabled && this.isDirty() && !this.inFlight)
      this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.clearTimer();
      // Unmount (in-app navigation): send the unsaved edit. Deferred one microtask so a
      // same-tick re-subscribe (StrictMode) cancels it; flush itself honours hold().
      const seq = ++this.attachSeq;
      queueMicrotask(() => {
        const save = this.save;
        if (this.attachSeq === seq && save) void this.flush(save);
      });
    };
  };

  change(next: T, from: T, save: SaveFn<T>) {
    this.save = save;
    if (this.baseline === null) {
      this.baseline = this.serialize(from);
      this.lastSerialized = this.baseline;
    }
    this.value = next;
    this.hasValue = true;
    const serialized = this.serialize(next);
    if (serialized === this.baseline) return;
    if (serialized !== this.lastSerialized) {
      this.lastSerialized = serialized;
      this.publish({ generation: this.snapshot.generation + 1 });
    }
    if (!this.enabled || this.inFlight) return;
    this.schedule();
  }

  hold() {
    this.enabled = false;
    this.clearTimer();
  }

  resume(save: SaveFn<T>) {
    this.save = save;
    this.enabled = true;
    if (!this.inFlight && this.isDirty()) this.schedule();
  }

  flush(save: SaveFn<T>, opts: { keepalive?: boolean } = {}): Promise<boolean> {
    this.save = save;
    this.clearTimer();
    // Await the full save chain, including edits made while an older ACK is pending.
    if (this.inFlight) {
      if (opts.keepalive === true) this.chainPastInFlight(save);
      return this.inFlight;
    }
    if (!this.enabled || !this.isDirty()) return Promise.resolve(true);
    this.lastSerialized = this.serialize(this.value as T);
    return this.runSave(opts.keepalive === true);
  }

  retry(save: SaveFn<T>) {
    this.save = save;
    if (this.inFlight) return;
    void this.runSave(false);
  }

  setConflictHandler(onConflict: ((error: unknown) => void) | undefined) {
    this.onConflict = onConflict;
  }

  rebase(server: T, keep: 'server' | 'mine', save: SaveFn<T>): Promise<boolean> {
    this.save = save;
    this.clearTimer();
    // A save still running decides for itself; the host retries once it settles.
    if (this.inFlight) return this.inFlight.then(() => false);
    const serverSerialized = this.serialize(server);
    this.baseline = serverSerialized;
    if (keep === 'server' || !this.hasValue) {
      this.value = server;
      this.hasValue = true;
    }
    this.lastSerialized = this.serialize(this.value as T);
    this.enabled = true;
    if (!this.isDirty()) {
      this.publish({ state: 'saved' });
      return Promise.resolve(true);
    }
    return this.runSave(false);
  }

  // Pagehide while a save is in flight: the page cannot wait for it and the browser may
  // cancel it, so send the current value now with keepalive — even when it equals what the
  // in-flight request carries, since unload may abort that request. Once per in-flight request.
  private chainPastInFlight(save: SaveFn<T>) {
    if (!this.enabled || this.chained || !this.hasValue) return;
    const value = this.value as T;
    const serialized = this.serialize(value);
    this.chained = save(value, { keepalive: true, chained: true }).then(
      (): ChainedOutcome => ({ ok: true, serialized }),
      (error: unknown): ChainedOutcome => ({ ok: false, error }),
    );
  }

  private async takeChained(): Promise<ChainedOutcome | null> {
    const chained = this.chained;
    if (!chained) return null;
    const outcome = await chained;
    if (this.chained === chained) this.chained = null;
    return outcome;
  }

  private isDirty(): boolean {
    return this.hasValue && this.serialize(this.value as T) !== this.baseline;
  }

  private schedule() {
    this.clearTimer();
    if (this.listeners.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runSave(false);
    }, this.debounceMs);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private publish(patch: Partial<AutosaveSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private runSave(keepalive: boolean): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const save = this.save;
    if (!this.enabled || !save || !this.hasValue) return Promise.resolve(true);
    const seq = ++this.seq;
    this.publish({ state: 'saving' });
    const pending = Promise.resolve().then(async () => {
      let alive = keepalive;
      try {
        for (;;) {
          const snapshot = this.value as T;
          let stored = this.serialize(snapshot);
          let failed = false;
          let failure: unknown;
          try {
            await (this.save ?? save)(snapshot, { keepalive: alive, chained: false });
          } catch (err) {
            failed = true;
            failure = err;
          }
          // A save chained past this one carries a newer value and a higher epoch. Wait for
          // it before the next round (its ACK moves the host's epoch); when it landed, it is
          // what the server holds, and this round's failure was only it being superseded.
          const chained = await this.takeChained();
          if (chained?.ok) stored = chained.serialized;
          else if (failed) throw chained ? chained.error : failure;
          if (this.seq !== seq) return false;
          this.baseline = stored;
          this.publish({ lastSavedAt: Date.now() });
          if (this.enabled && this.serialize(this.value as T) !== stored) {
            alive = false;
            continue;
          }
          this.publish({ state: 'saved' });
          return true;
        }
      } catch (err) {
        const conflict = err instanceof ApiError && err.status === 409;
        if (conflict && this.holdOnConflict) this.hold();
        if (this.seq === seq) {
          this.publish({ state: conflict ? 'conflict' : 'error' });
          if (conflict) this.onConflict?.(err);
        }
        return false;
      } finally {
        if (this.seq === seq) this.inFlight = null;
      }
    });
    this.inFlight = pending;
    return pending;
  }
}

export function useResponseDraftAutosave<T>({
  save,
  serialize = defaultSerialize,
  debounceMs = 800,
  holdOnConflict = false,
  onConflict,
}: UseResponseDraftAutosaveOptions<T>): ResponseDraftAutosave<T> {
  const [controller] = useState(
    () => new DraftAutosaveController<T>(serialize, debounceMs, holdOnConflict),
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  // Every command hands the controller the current conflict handler before it can start a
  // save, so a conflict always reports to the handler of the render that triggered it.
  const commands = useMemo(() => {
    const bind = () => controller.setConflictHandler(onConflict);
    return {
      change: (next: T, from: T) => {
        bind();
        controller.change(next, from, save);
      },
      hold: () => controller.hold(),
      resume: () => {
        bind();
        controller.resume(save);
      },
      flush: (opts?: { keepalive?: boolean }) => {
        bind();
        return controller.flush(save, opts);
      },
      retry: () => {
        bind();
        controller.retry(save);
      },
      rebase: (server: T, keep: 'server' | 'mine') => {
        bind();
        return controller.rebase(server, keep, save);
      },
    };
  }, [controller, save, onConflict]);
  return { ...snapshot, ...commands };
}
