// SectionLabel — serif heading + rule + optional count. className-driven over the
// .section-label class layer in app/globals.css. Ported from
// docs/design/loom-prototype/components.jsx (SectionLabel).

import type { ReactNode } from 'react';

export interface SectionLabelProps {
  children: ReactNode;
  count?: number | null;
}

export function SectionLabel({ children, count }: SectionLabelProps) {
  return (
    <div className="section-label">
      <h2 className="serif">{children}</h2>
      <span className="rule" />
      {count != null && <span className="count">{count}</span>}
    </div>
  );
}
