import type { ReactNode } from 'react';

export interface ExpandProps {
  open: boolean;
  id?: string;
  children: ReactNode;
}

/**
 * A region that opens its own space (0fr → 1fr) instead of shoving content down in one frame (M9).
 * While closed it is inert, so nothing inside is reachable by keyboard or assistive tech (A1).
 * Pair the trigger with aria-expanded and aria-controls={id}.
 */
export function Expand({ open, id, children }: ExpandProps) {
  return (
    <div id={id} className="un-expand" data-open={open} inert={!open}>
      <div className="un-expand-inner">{children}</div>
    </div>
  );
}
