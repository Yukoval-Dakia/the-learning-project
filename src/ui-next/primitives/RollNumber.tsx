import { useState } from 'react';

/** A count that rolls to its new value: up when it grows, down when it shrinks (M9). */
export function RollNumber({ value, className }: { value: number; className?: string }) {
  const [state, setState] = useState({ current: value, previous: null as number | null, n: 0 });
  if (value !== state.current) {
    setState({ current: value, previous: state.current, n: state.n + 1 });
  }
  const direction = state.previous === null || state.current >= state.previous ? 'up' : 'down';
  return (
    <span
      className={['un-roll', 'un-num', className].filter(Boolean).join(' ')}
      data-dir={direction}
    >
      <span key={`now-${state.n}`} className={state.previous === null ? undefined : 'un-roll-in'}>
        {state.current}
      </span>
      {state.previous !== null && (
        <span key={`was-${state.n}`} className="un-roll-out" aria-hidden="true">
          {state.previous}
        </span>
      )}
    </span>
  );
}
