import { describeCosts } from '@/ui/lib/cost-presentation';
import type { ChipTone } from '@/ui-next/public';

export interface AdminSurfaceProps {
  navigate: (to: string) => void;
}

const COST_CURRENCY_SYMBOL: Record<string, string> = { USD: '$', CNY: '¥' };

/**
 * A known amount. `null` means "unknown", which is never rendered as zero.
 */
export function formatMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '费用未知';
  const symbol = COST_CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${symbol}${value.toFixed(4)}`;
}

export function currencySymbol(currency: string): string {
  return COST_CURRENCY_SYMBOL[currency] ?? `${currency} `;
}

/** The basis of a cost amount: a reported price, an estimate, a legacy row, or unknown. */
export type AdminCostBasis = 'reported' | 'estimated' | 'legacy' | 'unknown';

const BASIS_LABEL: Record<AdminCostBasis, string> = {
  reported: '已报告',
  estimated: '估算',
  legacy: '历史口径',
  unknown: '未知',
};

export function costBasisLabel(basis: AdminCostBasis): string {
  return BASIS_LABEL[basis];
}

/**
 * One run's cost truth, in the same vocabulary as the ledger aggregates: a
 * per-currency known subtotal plus explicit attempt counts. Different
 * currencies are never added together.
 */
export interface AdminRunCostTruth {
  /** Known amount of this run; null when no amount is known. */
  amount: number | null;
  /** Currency of `amount`; null when the run has no single known currency. */
  currency: string | null;
  /** The basis behind the known amount. */
  basis: AdminCostBasis;
  /** Ledger entries whose amount is unknown (never counted as zero spend). */
  unknownEntries: number;
  /** Per-currency known subtotal and attempt counts, for the window total. */
  byCurrency: AdminCostBucket[];
}

export interface AdminCostBucket {
  currency: string;
  cost: number;
  reported_cost: number;
  estimated_cost: number;
  legacy_cost: number;
  reported_attempts: number;
  estimated_attempts: number;
  unknown_attempts: number;
  legacy_rows: number;
}

interface AdminRunCostRow {
  cost_usd: number | null;
  cost_basis: 'reported' | 'estimated' | 'unknown' | null;
  cost_currency: string | null;
  cost_unknown_entries: number;
  cost_by_currency: AdminCostBucket[];
}

/** Read one run's cost truth out of its DTO without inventing a missing amount. */
export function describeRunCost(run: AdminRunCostRow): AdminRunCostTruth {
  const basis: AdminCostBasis =
    run.cost_basis === 'reported' || run.cost_basis === 'estimated' || run.cost_basis === 'unknown'
      ? run.cost_basis
      : 'legacy';
  const buckets = run.cost_by_currency;
  const knownBuckets = buckets.filter(
    (bucket) =>
      bucket.reported_attempts > 0 || bucket.estimated_attempts > 0 || bucket.legacy_rows > 0,
  );
  const unknownEntries = run.cost_unknown_entries;
  const amount = run.cost_usd !== null && Number.isFinite(run.cost_usd) ? run.cost_usd : null;
  return {
    amount,
    currency: run.cost_currency ?? (knownBuckets.length === 1 ? knownBuckets[0].currency : null),
    basis,
    unknownEntries,
    byCurrency: buckets,
  };
}

/**
 * A window total over many runs: the known subtotal per currency plus the
 * number of unknown entries. Currencies are never added together, and an
 * all-unknown window never reads as zero spend.
 */
export function describeCostWindow(runs: readonly AdminRunCostRow[]): {
  amount: string;
  note: string;
  unknownEntries: number;
} {
  const buckets = new Map<string, AdminCostBucket>();
  let unknownEntries = 0;
  let knownRuns = 0;
  for (const run of runs) {
    const truth = describeRunCost(run);
    unknownEntries += truth.unknownEntries;
    if (truth.amount !== null) knownRuns += 1;
    for (const bucket of truth.byCurrency) {
      const existing = buckets.get(bucket.currency);
      buckets.set(
        bucket.currency,
        existing
          ? {
              currency: bucket.currency,
              cost: existing.cost + bucket.cost,
              reported_cost: existing.reported_cost + bucket.reported_cost,
              estimated_cost: existing.estimated_cost + bucket.estimated_cost,
              legacy_cost: existing.legacy_cost + bucket.legacy_cost,
              reported_attempts: existing.reported_attempts + bucket.reported_attempts,
              estimated_attempts: existing.estimated_attempts + bucket.estimated_attempts,
              unknown_attempts: existing.unknown_attempts + bucket.unknown_attempts,
              legacy_rows: existing.legacy_rows + bucket.legacy_rows,
            }
          : { ...bucket },
      );
    }
  }
  // One vocabulary for Today, the cost page and the runs window.
  const described = describeCosts(
    [...buckets.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    4,
  );
  // The shared note already carries the per-currency basis breakdown; only the
  // unknown count is added here, so the two do not repeat each other.
  const unknownNote = unknownEntries > 0 ? `未知费用 ${unknownEntries} 次` : '未知费用 0 次';
  return {
    amount: described.amount,
    note: `${described.breakdown.join('；')}；${unknownNote}；已知运行 ${knownRuns} / ${runs.length}`,
    unknownEntries,
  };
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
