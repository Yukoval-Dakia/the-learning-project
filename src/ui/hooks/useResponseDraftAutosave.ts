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
// 首个观测值视为服务端恢复基线（不算脏）。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaveState } from '@/ui/components/response/SaveStateChip';
import { ApiError } from '@/ui/lib/api';

function defaultSerialize<T>(value: T): string {
  return JSON.stringify(value) ?? '';
}

export interface UseResponseDraftAutosaveOptions<T> {
  value: T;
  /** resolve = server ack；reject(ApiError 409) → conflict。 */
  save: (value: T, ctx: { keepalive: boolean }) => Promise<unknown>;
  serialize?: (value: T) => string;
  debounceMs?: number;
  enabled?: boolean;
}

export interface ResponseDraftAutosave {
  state: SaveState;
  generation: number;
  /** 立即保存当前值（取消待发 debounce）；keepalive 供 pagehide。 */
  flush: (opts?: { keepalive?: boolean }) => void;
  retry: () => void;
  lastSavedAt: number | null;
}

export function useResponseDraftAutosave<T>({
  value,
  save,
  serialize = defaultSerialize,
  debounceMs = 800,
  enabled = true,
}: UseResponseDraftAutosaveOptions<T>): ResponseDraftAutosave {
  const [state, setState] = useState<SaveState>('idle');
  const [generation, setGeneration] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  // 基线：首个观测值（服务端恢复态）。此后序列化不同 = 脏。
  const baselineRef = useRef<string | null>(null);
  const lastSerializedRef = useRef<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // seq 守卫：只有最新一轮保存的响应可以写状态（旧成功不盖新失败，反之亦然）。
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const dirtyAgainRef = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;

  const runSave = useCallback((keepalive: boolean) => {
    const seq = ++seqRef.current;
    inFlightRef.current = true;
    setState('saving');
    const snapshot = valueRef.current;
    void Promise.resolve(saveRef.current(snapshot, { keepalive }))
      .then(() => {
        if (seqRef.current !== seq) return;
        inFlightRef.current = false;
        baselineRef.current = lastSerializedRef.current;
        setLastSavedAt(Date.now());
        if (dirtyAgainRef.current) {
          // 保存途中又改了 —— 立即补一轮（不再等 debounce）。
          dirtyAgainRef.current = false;
          runSave(false);
          return;
        }
        setState('saved');
      })
      .catch((err) => {
        if (seqRef.current !== seq) return;
        inFlightRef.current = false;
        setState(err instanceof ApiError && err.status === 409 ? 'conflict' : 'error');
      });
  }, []);

  // 内容变更追踪：generation +1；去抖排程。
  useEffect(() => {
    const serialized = serializeRef.current(value);
    if (baselineRef.current === null) {
      baselineRef.current = serialized;
      lastSerializedRef.current = serialized;
      return;
    }
    if (serialized === baselineRef.current) return;
    lastSerializedRef.current = serialized;
    setGeneration((g) => g + 1);
    if (!enabled) return;
    if (inFlightRef.current) {
      dirtyAgainRef.current = true;
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      runSave(false);
    }, debounceMs);
  }, [value, debounceMs, enabled, runSave]);

  // 卸载清 timer（组件销毁后不再 setState）。
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const flush = useCallback(
    (opts: { keepalive?: boolean } = {}) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // 无脏内容不空发；在飞的一轮已经是「最新值」（valueRef 同步于渲染）。
      const serialized = serializeRef.current(valueRef.current);
      if (serialized === baselineRef.current) return;
      if (inFlightRef.current) {
        dirtyAgainRef.current = true;
        return;
      }
      lastSerializedRef.current = serialized;
      runSave(opts.keepalive === true);
    },
    [runSave],
  );
  const retry = useCallback(() => {
    if (inFlightRef.current) return;
    runSave(false);
  }, [runSave]);
  return { state, generation, flush, retry, lastSavedAt };
}
