import type { CSSProperties, ReactNode } from 'react';
import { useId } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export interface SegmentedProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}

/**
 * A single-choice switch with a sliding ink (M9). Built on native radio inputs, so arrow keys,
 * focus and announcements behave like any radio group.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  const name = useId();
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  return (
    <fieldset
      className="un-seg"
      style={{ '--un-seg-n': options.length, '--un-seg-i': index } as CSSProperties}
    >
      <legend className="un-sr-only">{label}</legend>
      <span className="un-seg-ink" aria-hidden="true" />
      {options.map((o) => (
        <label key={o.value} className="un-seg-option un-hit">
          <input
            type="radio"
            className="un-sr-only"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
          />
          {o.label}
          {o.count !== undefined && <span className="un-seg-count un-num">{o.count}</span>}
        </label>
      ))}
    </fieldset>
  );
}
