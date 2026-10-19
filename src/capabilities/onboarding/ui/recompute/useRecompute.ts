// YUK-495 S5 #41 — recompute verify state machine.
// idle → running → resolved(outcome). `outcome` is the REAL result of the on-device
// re-derivation (summarizeRecompute.overall), not a simulated prop. The brief `running`
// flash is presentational ("觉得是瞬时" — offline + near-instant, not a spinner-wait);
// the math itself is synchronous and already done by the time we render.
//
// Each flash is identified by (run number, outcome, runMs). The flash timer is a resource
// attached through useSyncExternalStore: subscribing to a new flash starts its timer,
// unsubscribing (new flash, unmount) clears it, and the snapshot is whether *this* flash has
// settled — so a changed outcome never shows the previous verdict.

import { useCallback, useState, useSyncExternalStore } from 'react';

export type RcResolved = 'match' | 'drift' | 'preview';
export type RcState = 'idle' | 'running' | RcResolved;

export interface UseRecomputeArgs {
  /** start in `running` and resolve automatically on mount (the static-rest verified state). */
  auto: boolean;
  /** the real outcome to settle on once the flash completes. */
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
  // auto, outcome or runMs changing restarts the flash when auto, or resets to idle when not
  // (same as the previous [auto, run] dependency behaviour).
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
