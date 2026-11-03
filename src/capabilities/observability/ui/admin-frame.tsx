// Admin read-only pages (runs / cost / failures / coverage / conjecture; YUK-1473): the shared M3E
// frame. Design record: docs/design/2026-11-03-admin-readonly-m3e.md. Presentation only: every
// query, refresh and navigation stays in the page that owns it; these pieces only lay them out.
import type { ReactNode } from 'react';
import { ToastHost } from '@/ui-next/feedback/ToastHost';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Chip, UiNextRoot } from '@/ui-next/public';
import './admin-m3e.css';

export interface AdminNavLink {
  to: string;
  label: string;
}

/** The pages AdminLinks led to from runs / cost / failures (same targets, same order). */
export const ADMIN_LINKS: readonly AdminNavLink[] = [
  { to: '/admin/config', label: '配置' },
  { to: '/admin/runs', label: '运行记录' },
  { to: '/admin/cost', label: '成本' },
  { to: '/admin/failures', label: '失败记录' },
  { to: '/admin/subjects', label: '学科配置' },
  { to: '/admin/coverage-lattice', label: '供题覆盖' },
  { to: '/admin/conjecture-scores', label: '猜想评分' },
];

export function AdminFrame({ children }: { children: ReactNode }) {
  return (
    <UiNextRoot className="adm-page">
      <main className="adm-main un-m3e-bridge">{children}</main>
      <ToastHost />
    </UiNextRoot>
  );
}

export function AdminNav({
  links,
  current,
  navigate,
}: {
  links: readonly AdminNavLink[];
  current: string;
  navigate: (to: string) => void;
}) {
  return (
    <nav className="adm-nav" aria-label="管理后台">
      {links.map((link) => (
        <a
          key={link.to}
          href={link.to}
          className="adm-nav-link un-hit"
          aria-current={link.to === current ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault();
            navigate(link.to);
          }}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

export function AdminHead({
  kicker,
  title,
  lead,
  actions,
}: {
  kicker: string;
  title: string;
  lead: string;
  actions?: ReactNode;
}) {
  return (
    <header className="adm-head">
      <p className="adm-kicker">{kicker}</p>
      <div className="adm-head-row">
        <h1 className="adm-title">{title}</h1>
        {actions && <div className="adm-head-acts">{actions}</div>}
      </div>
      <p className="adm-lead">{lead}</p>
    </header>
  );
}

export function AdminKpis({ children }: { children: ReactNode }) {
  return <div className="adm-kpis">{children}</div>;
}

export function AdminKpi({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <div className="adm-kpi">
      <div className="adm-kpi-l">{label}</div>
      <div className="adm-kpi-n">{value}</div>
      {note && <div className="adm-kpi-note">{note}</div>}
    </div>
  );
}

/** A titled block: hairline paper, the heading on the left, counts / chips on the right. */
export function AdminPanel({
  id,
  title,
  aside,
  sub,
  flush,
  titleClassName,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  sub?: ReactNode;
  /** A table panel: the body runs edge to edge. */
  flush?: boolean;
  titleClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className="adm-panel" aria-labelledby={id} data-flush={flush ? '' : undefined}>
      <div className="adm-panel-head">
        <div className="adm-panel-heading">
          <h2 id={id} className={['adm-panel-title', titleClassName].filter(Boolean).join(' ')}>
            {title}
          </h2>
          {sub && <p className="adm-panel-sub">{sub}</p>}
        </div>
        {aside && <div className="adm-panel-aside">{aside}</div>}
      </div>
      <div className="adm-panel-body">{children}</div>
    </section>
  );
}

export function AdminLoading({ label }: { label: string }) {
  return (
    <div className="adm-panel adm-loading">
      <SkeletonLines rows={3} label={label} />
    </div>
  );
}

export function AdminError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="adm-error" role="alert">
      <Chip tone="critical">error</Chip>
      <p className="adm-error-text">{message}</p>
    </div>
  );
}

export type AdminAreaStatus = 'loading' | 'error' | 'ok';

/** Loading / error / content for one query, in the order the old Stateful used. */
export function AdminArea({
  status,
  loadingLabel,
  errorText,
  onRetry,
  children,
}: {
  status: AdminAreaStatus;
  loadingLabel: string;
  errorText: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (status === 'loading') return <AdminLoading label={loadingLabel} />;
  if (status === 'error') {
    return (
      <div className="adm-panel adm-retry">
        <RetryLine message={errorText} onRetry={onRetry} />
      </div>
    );
  }
  return children;
}

/** `q.isLoading ? 'loading' : q.isError ? 'error' : 'ok'`, written out. */
export function adminAreaStatus(q: { isLoading: boolean; isError: boolean }): AdminAreaStatus {
  if (q.isLoading) return 'loading';
  if (q.isError) return 'error';
  return 'ok';
}
