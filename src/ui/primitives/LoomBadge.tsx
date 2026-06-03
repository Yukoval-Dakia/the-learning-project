// LoomBadge — loom badge primitive. className-driven over the .badge class layer
// (+ .badge.tone-<tone> variants and optional .badge .dot[.pulse]) already
// ported into app/globals.css. Ported from docs/design/loom-prototype/
// components.jsx (Badge, the LIVE prototype source). Additive — does NOT replace
// legacy src/ui/primitives/Badge.tsx.

import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

// Tone vocabulary mirrors the .badge.tone-<tone> classes in app/globals.css.
export type LoomBadgeTone = 'neutral' | 'coral' | 'info' | 'good' | 'hard' | 'again';

export interface LoomBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: LoomBadgeTone;
  /** render a leading status dot — adds a .dot child */
  dot?: boolean;
  /** pulse the leading dot — adds .pulse to the dot (only when dot is set) */
  pulse?: boolean;
  children?: ReactNode;
}

export const LoomBadge = forwardRef<HTMLSpanElement, LoomBadgeProps>(function LoomBadge(
  { tone = 'neutral', dot, pulse, children, className, ...rest },
  ref,
) {
  const cls = ['badge', `tone-${tone}`, className ?? ''].filter(Boolean).join(' ');
  return (
    <span ref={ref} className={cls} {...rest}>
      {dot && <span className={`dot${pulse ? ' pulse' : ''}`} />}
      {children}
    </span>
  );
});
