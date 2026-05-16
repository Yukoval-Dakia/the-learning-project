import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'info' | 'good' | 'hard' | 'again' | 'coral';

export interface BadgeProps {
  tone?: BadgeTone;
  children?: ReactNode;
  /** Animated pulsing dot */
  dot?: boolean;
  /** Static (non-pulsing) dot */
  dotStatic?: boolean;
  className?: string;
}

const TONE_STYLES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--paper-sunk)] text-[var(--ink-3)] border border-[var(--line-soft)]',
  info: 'bg-[var(--info-soft)] text-[var(--info-ink)] border border-[rgba(79,110,142,0.2)]',
  good: 'bg-[var(--good-soft)] text-[var(--good-ink)] border border-[var(--good-line)]',
  hard: 'bg-[var(--hard-soft)] text-[var(--hard-ink)] border border-[var(--hard-line)]',
  again: 'bg-[var(--again-soft)] text-[var(--again-ink)] border border-[var(--again-line)]',
  coral: 'bg-[var(--coral-soft)] text-[var(--coral-ink)] border border-[var(--coral-line)]',
};

export function Badge({ tone = 'neutral', children, dot, dotStatic, className }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-[4px]',
        'text-[11.5px] font-[500] leading-none',
        'px-[8px] py-[3px] rounded-[var(--r-pill)]',
        'font-[family:var(--font-mono)]',
        'tracking-[0.01em] whitespace-nowrap',
        TONE_STYLES[tone],
        className ?? '',
      ]
        .join(' ')
        .trim()}
    >
      {dot && (
        <span
          className={[
            'w-[6px] h-[6px] rounded-full bg-current',
            dotStatic ? 'opacity-70' : 'animate-[pulse_1.4s_cubic-bezier(0.4,0,0.2,1)_infinite]',
          ].join(' ')}
        />
      )}
      {children}
    </span>
  );
}
