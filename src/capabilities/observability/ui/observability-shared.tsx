import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import type { CSSProperties } from 'react';

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

export function statusTone(status: string): BadgeTone {
  if (status === 'success') return 'good';
  if (status === 'failure') return 'again';
  if (status === 'running') return 'info';
  return 'neutral';
}

export function LoadingCard({ label }: { label: string }) {
  return (
    <Card pad="lg">
      <p style={mutedTextStyle}>{label} 加载中...</p>
    </Card>
  );
}

export function ErrorCard({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Card pad="lg">
      <Badge tone="again">error</Badge>
      <p style={mutedTextStyle}>{message}</p>
    </Card>
  );
}

export function Kpi({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-num">{value}</div>
      {note && <div className="kpi-trend">{note}</div>}
    </div>
  );
}

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
    <div style={linkRowStyle}>
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

export const sectionHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--s-3)',
  marginBottom: 'var(--s-3)',
};

export const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontSize: 20,
  fontWeight: 500,
  letterSpacing: 'var(--ls-tight)',
};

export const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--ink-3)',
  fontSize: 13,
  lineHeight: 1.55,
};
