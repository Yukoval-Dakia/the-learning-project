import './section-head.css';
import type { ReactNode } from 'react';

export interface SectionHeadProps {
  id: string;
  title: string;
  /** Right-hand side: a count, a link. */
  aside?: ReactNode;
}

/** A page section's small heading (接着来 / 等你决定 …); pair the section with aria-labelledby={id}. */
export function SectionHead({ id, title, aside }: SectionHeadProps) {
  return (
    <div className="un-section-head">
      <h2 id={id} className="un-section-title">
        {title}
      </h2>
      {aside && <div className="un-section-aside">{aside}</div>}
    </div>
  );
}
