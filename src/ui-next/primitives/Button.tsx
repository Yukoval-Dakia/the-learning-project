import type { ButtonHTMLAttributes } from 'react';
import { forwardRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'quiet';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** One solid accent button per view at most (H3 in spirit); the rest are secondary or quieter. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  const cls = ['un-btn', `un-btn-${variant}`, `un-btn-${size}`, 'un-hit', className]
    .filter(Boolean)
    .join(' ');
  return <button ref={ref} type={type} className={cls} {...rest} />;
});
