// Btn — loom button primitive. className-driven over the .btn class layer
// already ported into app/globals.css. Ported from docs/design/loom-prototype/
// components.jsx (Btn). Additive — does NOT replace legacy src/ui/primitives/Button.tsx.

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { LoomIcon } from './LoomIcon';
import type { LoomIconName } from './LoomIcon';

export type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'good' | 'hard' | 'again';

export type BtnSize = 'sm' | 'lg';

export interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: BtnSize;
  icon?: LoomIconName;
  iconEnd?: LoomIconName;
  block?: boolean;
  children?: ReactNode;
}

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  { variant = 'secondary', size, icon, iconEnd, block, children, className, ...rest },
  ref,
) {
  const cls = [
    'btn',
    `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '',
    block ? 'btn-block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const iconSize = size === 'sm' ? 15 : 17;
  return (
    <button ref={ref} type="button" className={cls} {...rest}>
      {icon && <LoomIcon name={icon} size={iconSize} />}
      {children}
      {iconEnd && <LoomIcon name={iconEnd} size={iconSize} />}
    </button>
  );
});
