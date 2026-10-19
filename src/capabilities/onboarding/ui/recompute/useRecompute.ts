// idle, then a short running flash, then the real on-device outcome.
// The math is already done. The flash is presentational, not a wait for work.
// Each flash is (run, outcome, runMs). The timer lives on the subscription:
// a new flash or unmount clears it, so a changed outcome never shows the previous verdict.

import { useCallback, useState, useSyncExternalStore } from 'react';

export type RcResolved = 'match' | 'drift' | 'preview';
export type RcState = 'idle' | 'running' | RcResolved;

export interface UseRecomputeArgs {
  /** Start in running and resolve on mount. The resting state is already verified. */
  auto: boolean;
  /** The real outcome to show once the flash ends. */
  outcome: RcResolved;
  /** flash duration (ms). */
  runMs?: number;
}

export interface UseRecompute {
  state: RcState;
  run: () => void;
}

const noop = () => {};

export function useRecompute({ auto, outcome, runMs = 540 }: UseRecomputeArgs): UseRecompute {
  // 0 = idle (no flash requested); every run / auto restart bumps it.
  const [runNo, setRunNo] = useState(auto ? 1 : 0);
  // Changing auto, outcome, or runMs restarts the flash when auto, and returns to idle otherwise.
  const [inputs, setInputs] = useState({ auto, outcome, runMs });
  if (inputs.auto !== auto || inputs.outcome !== outcome || inputs.runMs !== runMs) {
    setInputs({ auto, outcome, runMs });
    setRunNo((n) => (auto ? n + 1 : 0));
  }

  const flashKey = runNo === 0 ? null : `${runNo}:${outcome}:${runMs}`;
  // Per-instance record of the last flash whose timer fired.
  const [flash] = useState<{ settled: string | null }>(() => ({ settled: null }));

  const subscribe = useCallback(
    (notify: () => void) => {
      if (flashKey === null || flash.settled === flashKey) return noop;
      const timer = setTimeout(() => {
        flash.settled = flashKey;
        notify();
      }, runMs);
      return () => clearTimeout(timer);
    },
    [flash, flashKey, runMs],
  );
  const settled = useSyncExternalStore(
    subscribe,
    () => flashKey !== null && flash.settled === flashKey,
    () => false,
  );

  const run = useCallback(() => setRunNo((n) => n + 1), []);

  const state: RcState = flashKey === null ? 'idle' : settled ? outcome : 'running';
  return { state, run };
}
