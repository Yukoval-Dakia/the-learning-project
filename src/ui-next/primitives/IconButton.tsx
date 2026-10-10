import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Accessible name; required because the button shows only an icon (N5). */
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={['un-icon-btn', 'un-hit', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <span aria-hidden="true" className="un-icon-btn-glyph">
        {icon}
      </span>
    </button>
  );
});
