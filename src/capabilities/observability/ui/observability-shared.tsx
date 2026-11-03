import type { CSSProperties } from 'react';
import type { ChipTone } from '@/ui-next/public';

export interface AdminSurfaceProps {
  navigate: (to: string) => void;
}

const COST_CURRENCY_SYMBOL: Record<string, string> = { USD: '$', CNY: '¥' };

export function formatMoney(value: number | null | undefined, currency = 'USD'): string {
  const symbol = COST_CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${symbol}${(value ?? 0).toFixed(4)}`;
}

export function currencySymbol(currency: string): string {
  return COST_CURRENCY_SYMBOL[currency] ?? `${currency} `;
}

export function formatTime(value: string | null): string {
  if (!value) return 'running';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortId(id: string): string {
  return id.slice(0, 10);
}

export function statusTone(status: string): ChipTone {
  if (status === 'success') return 'positive';
  if (status === 'failure') return 'critical';
  if (status === 'running') return 'accent';
  return 'neutral';
}

// AdminLinks is the old-look link row; only /admin/config still renders it. The M3E admin pages
// use AdminNav (admin-frame.tsx). It leaves together with the config page's own migration.
function AdminLink({
  to,
  navigate,
  children,
}: {
  to: string;
  navigate: (to: string) => void;
  children: string;
}) {
  return (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function AdminLinks({ navigate }: AdminSurfaceProps) {
  return (
    <div style={{ ...linkRowStyle, flexWrap: 'wrap' }}>
      <AdminLink to="/admin/config" navigate={navigate}>
        配置
      </AdminLink>
      <AdminLink to="/admin/runs" navigate={navigate}>
        runs
      </AdminLink>
      <AdminLink to="/admin/cost" navigate={navigate}>
        cost
      </AdminLink>
      <AdminLink to="/admin/failures" navigate={navigate}>
        failures
      </AdminLink>
      <AdminLink to="/admin/subjects" navigate={navigate}>
        subjects
      </AdminLink>
      <AdminLink to="/admin/coverage-lattice" navigate={navigate}>
        coverage
      </AdminLink>
      <AdminLink to="/admin/conjecture-scores" navigate={navigate}>
        conjecture
      </AdminLink>
    </div>
  );
}

const linkRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
};
