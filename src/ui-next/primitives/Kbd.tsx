import type { ReactNode } from 'react';

/** A keyboard hint inside a control. Hidden on touch screens (N5). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="un-kbd">{children}</kbd>;
}
