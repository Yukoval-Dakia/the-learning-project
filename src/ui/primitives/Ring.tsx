'use client';

// Ring — conic-gradient percent dial with animated count-up centre. className-driven
// over the .ring class layer in app/globals.css. Ported from
// docs/design/loom-prototype/components.jsx (Ring). prefers-reduced-motion aware
// via useCountUp.

import type { CSSProperties } from 'react';
import { useCountUp } from './useCountUp';

export interface RingProps {
  percent?: number;
  animate?: boolean;
}

export function Ring({ percent = 0, animate = true }: RingProps) {
  const p = useCountUp(percent, { start: animate, dur: 1100 });
  return (
    <div className="ring" style={{ '--p': p } as CSSProperties}>
      <span className="ring-val serif tnum">{Math.round(p)}%</span>
    </div>
  );
}
