'use client';

// useCountUp — animate a number from 0 → target with cubic ease-out, honouring
// prefers-reduced-motion. Ported from docs/design/loom-prototype/components.jsx
// (useCountUp).

import { useState, useSyncExternalStore } from 'react';

export interface UseCountUpOptions {
  dur?: number;
  start?: boolean;
  decimals?: number;
}

/**
 * One count-up run for a fixed (target, start, dur). Creating it has no side effects; the
 * animation frame loop starts when React subscribes and is cancelled when React unsubscribes
 * (unmount, or a new run replacing this one). The snapshot is the current number.
 */
interface CountUpRun {
  target: number;
  start: boolean;
  dur: number;
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => number;
  getServerSnapshot: () => number;
}

function createCountUpRun(target: number, start: boolean, dur: number): CountUpRun {
  const initial = start ? 0 : target;
  let value = initial;
  let done = !start;
  let t0: number | null = null;

  return {
    target,
    start,
    dur,
    getSnapshot: () => value,
    getServerSnapshot: () => initial,
    subscribe(onChange) {
      if (done) return () => {};
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        value = target;
        done = true;
        onChange();
        return () => {};
      }
      // A re-subscribe (StrictMode) continues the same run instead of restarting it.
      if (t0 === null) t0 = performance.now();
      const startedAt = t0;
      let frame = 0;
      const tick = (t: number) => {
        const p = Math.min(1, (t - startedAt) / dur);
        const e = 1 - (1 - p) ** 3;
        if (p < 1) {
          value = target * e;
          frame = requestAnimationFrame(tick);
        } else {
          value = target;
          done = true;
        }
        onChange();
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    },
  };
}

export function useCountUp(
  target: number,
  { dur = 900, start = true, decimals = 0 }: UseCountUpOptions = {},
): number {
  // A new target, start or duration begins a new run from 0, as before. The old run is
  // unsubscribed (its frame cancelled) when React switches to the new one.
  const [stored, setStored] = useState(() => createCountUpRun(target, start, dur));
  let run = stored;
  if (run.target !== target || run.start !== start || run.dur !== dur) {
    run = createCountUpRun(target, start, dur);
    setStored(run);
  }

  const val = useSyncExternalStore(run.subscribe, run.getSnapshot, run.getServerSnapshot);
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}
