import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ChipTone = 'neutral' | 'accent' | 'positive' | 'caution' | 'critical';

/** A static label. Status tones carry meaning only, never decoration. */
export function Chip({ tone = 'neutral', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`un-chip un-chip-${tone}`}>{children}</span>;
}

export interface ChipToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'aria-pressed'> {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
}

/** A filter chip that toggles; exposes its state with aria-pressed. */
export function ChipToggle({
  pressed,
  onPressedChange,
  className,
  children,
  ...rest
}: ChipToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={['un-chip', 'un-chip-toggle', 'un-hit', className].filter(Boolean).join(' ')}
      onClick={() => onPressedChange(!pressed)}
      {...rest}
    >
      {children}
    </button>
  );
}
