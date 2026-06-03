'use client';

// useCountUp — animate a number from 0 → target with cubic ease-out, honouring
// prefers-reduced-motion. Ported from docs/design/loom-prototype/components.jsx
// (useCountUp).

import { useEffect, useRef, useState } from 'react';

export interface UseCountUpOptions {
  dur?: number;
  start?: boolean;
  decimals?: number;
}

export function useCountUp(
  target: number,
  { dur = 900, start = true, decimals = 0 }: UseCountUpOptions = {},
): number {
  const [val, setVal] = useState(start ? 0 : target);
  const raf = useRef(0);

  useEffect(() => {
    if (!start) {
      setVal(target);
      return;
    }
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setVal(target);
      return;
    }
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - p) ** 3;
      setVal(target * e);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else setVal(target);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, start, dur]);

  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}
