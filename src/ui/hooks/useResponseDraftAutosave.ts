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
// 订阅随组件挂载；最后一个订阅退出（卸载）时清掉未发的 debounce——已发出的保存仍按原
// 回执落地，不冒充取消。`save` 须在一次作答内保持稳定（按 issuance 等身份 key 宿主）。

import { useMemo, useState, useSyncExternalStore } from 'react';
import type { SaveState } from '@/ui/components/response/SaveStateChip';
import { ApiError } from '@/ui/lib/api';

function defaultSerialize<T>(value: T): string {
  return JSON.stringify(value) ?? '';
}

type SaveFn<T> = (value: T, ctx: { keepalive: boolean }) => Promise<unknown>;

export interface UseResponseDraftAutosaveOptions<T> {
  /** resolve = server ack；reject(ApiError 409) → conflict。一次作答内保持稳定。 */
  save: SaveFn<T>;
  serialize?: (value: T) => string;
  debounceMs?: number;
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
  private enabled = true;
  private save: SaveFn<T> | null = null;

  constructor(
    private readonly serialize: (value: T) => string,
    private readonly debounceMs: number,
  ) {}

  getSnapshot = (): AutosaveSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    // Re-subscribe (StrictMode) with an unsaved edit: re-arm the debounce dropped below.
    if (this.listeners.size === 1 && this.isDirty() && !this.inFlight) this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.clearTimer();
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
    if (this.inFlight) return this.inFlight;
    if (!this.enabled || !this.isDirty()) return Promise.resolve(true);
    this.lastSerialized = this.serialize(this.value as T);
    return this.runSave(opts.keepalive === true);
  }

  retry(save: SaveFn<T>) {
    this.save = save;
    if (this.inFlight) return;
    void this.runSave(false);
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
          const snapshotSerialized = this.serialize(snapshot);
          await (this.save ?? save)(snapshot, { keepalive: alive });
          if (this.seq !== seq) return false;
          this.baseline = snapshotSerialized;
          this.publish({ lastSavedAt: Date.now() });
          if (this.enabled && this.serialize(this.value as T) !== snapshotSerialized) {
            alive = false;
            continue;
          }
          this.publish({ state: 'saved' });
          return true;
        }
      } catch (err) {
        if (this.seq === seq)
          this.publish({
            state: err instanceof ApiError && err.status === 409 ? 'conflict' : 'error',
          });
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
}: UseResponseDraftAutosaveOptions<T>): ResponseDraftAutosave<T> {
  const [controller] = useState(() => new DraftAutosaveController<T>(serialize, debounceMs));
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const commands = useMemo(
    () => ({
      change: (next: T, from: T) => controller.change(next, from, save),
      hold: () => controller.hold(),
      resume: () => controller.resume(save),
      flush: (opts?: { keepalive?: boolean }) => controller.flush(save, opts),
      retry: () => controller.retry(save),
    }),
    [controller, save],
  );
  return { ...snapshot, ...commands };
}
