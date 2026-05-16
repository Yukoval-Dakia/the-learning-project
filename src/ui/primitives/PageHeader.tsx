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

export function PageHeader({ title, eyebrow, sub, children, className }: PageHeaderProps) {
  return (
    <header className={['mb-[var(--s-6)]', className ?? ''].join(' ').trim()}>
      {eyebrow && (
        <div className="mb-[4px] font-[family:var(--font-mono)] text-[var(--fs-meta)] text-[var(--ink-4)] tracking-[var(--ls-wide)]">
          {eyebrow}
        </div>
      )}
      <div className="flex items-baseline justify-between gap-[var(--s-4)] flex-wrap">
        <div>
          <h1
            className="m-0"
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 'var(--fs-h1)',
              fontWeight: 500,
              lineHeight: 'var(--lh-tight)',
              letterSpacing: 'var(--ls-tight)',
              color: 'var(--ink)',
            }}
          >
            {title}
          </h1>
          {sub && (
            <p
              className="mt-[6px] mb-0"
              style={{
                fontSize: '14.5px',
                color: 'var(--ink-3)',
                lineHeight: 1.55,
                maxWidth: '56ch',
              }}
            >
              {sub}
            </p>
          )}
        </div>
        {children && <div className="flex gap-[8px] items-center">{children}</div>}
      </div>
    </header>
  );
}
