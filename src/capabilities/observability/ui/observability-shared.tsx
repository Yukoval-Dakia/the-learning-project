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
