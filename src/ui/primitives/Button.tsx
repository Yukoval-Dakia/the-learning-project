import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { IconName } from './Icon';
import { Icon } from './Icon';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'quiet'
  | 'good'
  | 'hard'
  | 'coral'
  | 'info'
  | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  iconRight?: IconName;
  children?: ReactNode;
}

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: ['bg-[var(--coral)] text-white', 'hover:bg-[var(--coral-hover)]'].join(' '),
  secondary: [
    'bg-[var(--paper-raised)] text-[var(--ink)]',
    'border border-[var(--line)]',
    'hover:bg-[var(--paper-tint)]',
  ].join(' '),
  ghost: [
    'text-[var(--ink-2)] px-[10px] py-[6px]',
    'hover:bg-[var(--paper-tint)] hover:text-[var(--ink)]',
  ].join(' '),
  quiet: ['text-[var(--ink-3)] px-[8px] py-[4px] text-[13px]', 'hover:text-[var(--ink)]'].join(' '),
  good: [
    'bg-[var(--good-soft)] text-[var(--good-ink)] border border-[var(--good-line)]',
    'hover:bg-[var(--good)] hover:text-white hover:border-[var(--good)]',
  ].join(' '),
  hard: [
    'bg-[var(--hard-soft)] text-[var(--hard-ink)] border border-[var(--hard-line)]',
    'hover:bg-[var(--hard)] hover:text-white hover:border-[var(--hard)]',
  ].join(' '),
  coral: [
    'bg-[var(--coral-soft)] text-[var(--coral-ink)] border border-[var(--coral-line)]',
    'hover:bg-[var(--coral)] hover:text-white hover:border-[var(--coral)]',
  ].join(' '),
  info: [
    'bg-[var(--info-soft)] text-[var(--info-ink)] border border-[rgba(79,110,142,0.3)]',
    'hover:bg-[var(--info)] hover:text-white hover:border-[var(--info)]',
  ].join(' '),
  danger: [
    'text-[var(--again-ink)] px-[8px] py-[4px] text-[13px]',
    'hover:bg-[var(--again-soft)] hover:text-[var(--again)]',
  ].join(' '),
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size, icon, iconRight, children, className, ...rest },
  ref,
) {
  const iconSize = size === 'sm' ? 13 : 14;
  const baseClass = [
    'inline-flex items-center justify-center gap-[6px]',
    'font-[500] leading-none whitespace-nowrap',
    'rounded-[var(--r-2)] border border-transparent',
    'transition-[background,color,border-color,transform] duration-[var(--dur-fast)]',
    'active:scale-[0.98]',
    'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
    size === 'sm' ? 'px-[10px] py-[6px] text-[12.5px]' : 'px-[13px] py-[9px] text-[13.5px]',
    VARIANT_STYLES[variant],
    className ?? '',
  ]
    .join(' ')
    .trim();

  return (
    <button ref={ref} type="button" className={baseClass} {...rest}>
      {icon && <Icon name={icon} size={iconSize} />}
      {children}
      {iconRight && <Icon name={iconRight} size={iconSize} />}
    </button>
  );
});
