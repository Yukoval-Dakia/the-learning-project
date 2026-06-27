// YUK-495 S5 #41 — recompute verify state machine.
// idle → running → resolved(outcome). `outcome` is the REAL result of the on-device
// re-derivation (summarizeRecompute.overall), not a simulated prop. The brief `running`
// flash is presentational ("觉得是瞬时" — offline + near-instant, not a spinner-wait);
// the math itself is synchronous and already done by the time we render.

import { useCallback, useEffect, useRef, useState } from 'react';

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

export function useRecompute({ auto, outcome, runMs = 540 }: UseRecomputeArgs): UseRecompute {
  const [state, setState] = useState<RcState>(auto ? 'running' : 'idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setState('running');
    timer.current = setTimeout(() => setState(outcome), runMs);
  }, [outcome, runMs]);

  useEffect(() => {
    if (auto) run();
    else setState('idle');
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [auto, run]);

  return { state, run };
}
