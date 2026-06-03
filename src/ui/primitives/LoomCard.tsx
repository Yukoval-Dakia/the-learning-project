// LoomCard — loom card primitive. className-driven over the .card class layer
// (+ .card-pad / .card-pad-lg / .card-hover / .card-sunk variants) already
// ported into app/globals.css. Ported from docs/design/loom-prototype/
// components.jsx (Card, the LIVE prototype source). Additive — does NOT replace
// legacy src/ui/primitives/Card.tsx.

import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

export interface LoomCardProps extends HTMLAttributes<HTMLDivElement> {
  /** standard padding — adds .card-pad */
  pad?: boolean;
  /** larger padding — adds .card-pad-lg */
  padLg?: boolean;
  /** hover lift affordance — adds .card-hover */
  hover?: boolean;
  /** sunken/inset surface — adds .card-sunk */
  sunk?: boolean;
  children?: ReactNode;
}

export const LoomCard = forwardRef<HTMLDivElement, LoomCardProps>(function LoomCard(
  { pad, padLg, hover, sunk, className, children, ...rest },
  ref,
) {
  const cls = [
    'card',
    pad ? 'card-pad' : '',
    padLg ? 'card-pad-lg' : '',
    hover ? 'card-hover' : '',
    sunk ? 'card-sunk' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div ref={ref} className={cls} {...rest}>
      {children}
    </div>
  );
});
