import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  /** Small mono text above title (e.g. breadcrumb or page category) */
  eyebrow?: string;
  /** Subtitle / description below title */
  sub?: string;
  /** Action buttons or badges to the right of the title */
  children?: ReactNode;
  className?: string;
}

// Maps to .page-head / .page-head-row / .page-head-actions in app/globals.css
// (ported from loom-design-v2.1/app.css). Visual semantics live in CSS; this
// primitive is structure only.
export function PageHeader({ title, eyebrow, sub, children, className }: PageHeaderProps) {
  return (
    <header className={['page-head', className ?? ''].filter(Boolean).join(' ')}>
      {eyebrow && <div className="meta">{eyebrow}</div>}
      <div className="page-head-row">
        <div>
          <h1>{title}</h1>
          {sub && <p className="sub">{sub}</p>}
        </div>
        {children && <div className="page-head-actions">{children}</div>}
      </div>
    </header>
  );
}
