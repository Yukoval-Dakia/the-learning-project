import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /** 'default' = 16/18px padding, 'lg' = 22/24px padding */
  pad?: 'default' | 'lg';
  /** Show elevated shadow on hover */
  elevated?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { children, pad = 'default', elevated = false, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={[
        'bg-[var(--paper-raised)]',
        'border border-[var(--line)]',
        'rounded-[var(--r-3)]',
        'flex flex-col gap-[8px]',
        'transition-shadow duration-[var(--dur-fast)]',
        pad === 'lg' ? 'px-[24px] py-[22px]' : 'px-[18px] py-[16px]',
        elevated ? 'hover:shadow-[var(--shadow-2)]' : '',
        className ?? '',
      ]
        .join(' ')
        .trim()}
      {...rest}
    >
      {children}
    </div>
  );
});
