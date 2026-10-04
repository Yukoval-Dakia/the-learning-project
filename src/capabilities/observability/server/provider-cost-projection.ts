import { sql } from 'drizzle-orm';
import type { ProviderCostDetail, ProviderCostWindow } from '@/core/schema/cost-observation';
import type { Db, Tx } from '@/db/client';

export type ProviderCostAggregateRow = {
  readonly dimension: 'total' | 'currency' | 'task' | 'truth' | 'day';
  readonly day: string | null;
  readonly task_kind: string | null;
  readonly currency: string | null;
  readonly entry_kind: 'legacy' | 'attempt' | null;
  readonly cost_basis: 'reported' | 'estimated' | 'unknown' | null;
  readonly cost_ref: string | null;
  readonly cost: number;
  readonly reported_cost: number;
  readonly estimated_cost: number;
  readonly legacy_cost: number;
  // YUK-977 — basis-specific attempt counts mirror the truth columns so a
  // known-zero amount can still show its source (amount alone can't: a zero
  // reported_cost is indistinguishable from "no reported rows").
  readonly reported_attempts: number;
  readonly estimated_attempts: number;
  readonly unknown_attempts: number;
  readonly legacy_rows: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly calls: number;
};

export async function readProviderCostAggregates(
  db: Db | Tx,
  from: Date,
): Promise<ProviderCostAggregateRow[]> {
  return db.execute<ProviderCostAggregateRow>(sql`
    ${projectedCosts(from)}, aggregates AS (
      SELECT 'total'::text AS dimension, NULL::text AS day, NULL::text AS task_kind,
        NULL::text AS currency, NULL::text AS entry_kind, NULL::text AS cost_basis,
        NULL::text AS cost_ref,
        COALESCE(SUM(COALESCE(cost, 0)), 0)::double precision AS cost,
        COALESCE(SUM(CASE WHEN cost_basis = 'reported' THEN COALESCE(cost, 0) ELSE 0 END), 0)::double precision AS reported_cost,
        COALESCE(SUM(CASE WHEN cost_basis = 'estimated' THEN COALESCE(cost, 0) ELSE 0 END), 0)::double precision AS estimated_cost,
        COALESCE(SUM(CASE WHEN entry_kind = 'legacy' THEN COALESCE(cost, 0) ELSE 0 END), 0)::double precision AS legacy_cost,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'reported')::int AS reported_attempts,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'estimated')::int AS estimated_attempts,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'unknown')::int AS unknown_attempts,
        COUNT(*) FILTER (WHERE entry_kind = 'legacy')::int AS legacy_rows,
        COALESCE(SUM(tokens_in), 0)::double precision AS tokens_in,
        COALESCE(SUM(tokens_out), 0)::double precision AS tokens_out,
        COUNT(*)::int AS calls
      FROM projected
      UNION ALL
      SELECT 'currency', NULL, NULL, currency, NULL, NULL, NULL,
        SUM(COALESCE(cost, 0))::double precision,
        SUM(CASE WHEN cost_basis = 'reported' THEN COALESCE(cost, 0) ELSE 0 END)::double precision,
        SUM(CASE WHEN cost_basis = 'estimated' THEN COALESCE(cost, 0) ELSE 0 END)::double precision,
        SUM(CASE WHEN entry_kind = 'legacy' THEN COALESCE(cost, 0) ELSE 0 END)::double precision,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'reported')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'estimated')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'unknown')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'legacy')::int,
        SUM(tokens_in)::double precision, SUM(tokens_out)::double precision, COUNT(*)::int
      FROM projected GROUP BY currency
      UNION ALL
      SELECT 'task', NULL, task_kind, currency, NULL, NULL, NULL,
        SUM(COALESCE(cost, 0))::double precision,
        SUM(CASE WHEN cost_basis = 'reported' THEN COALESCE(cost, 0) ELSE 0 END)::double precision,
        SUM(CASE WHEN cost_basis = 'estimated' THEN COALESCE(cost, 0) ELSE 0 END)::double precision,
        SUM(CASE WHEN entry_kind = 'legacy' THEN COALESCE(cost, 0) ELSE 0 END)::double precision,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'reported')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'estimated')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'unknown')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'legacy')::int,
        SUM(tokens_in)::double precision, SUM(tokens_out)::double precision, COUNT(*)::int
      FROM projected GROUP BY task_kind, currency
      UNION ALL
      SELECT 'truth', NULL, NULL, currency, entry_kind, cost_basis, cost_ref,
        SUM(COALESCE(cost, 0))::double precision, 0::double precision, 0::double precision,
        0::double precision,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'reported')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'estimated')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'unknown')::int,
        0::int, SUM(tokens_in)::double precision, SUM(tokens_out)::double precision, COUNT(*)::int
      FROM projected GROUP BY currency, entry_kind, cost_basis, cost_ref
      UNION ALL
      SELECT 'day', (occurred_at AT TIME ZONE 'UTC')::date::text, NULL, currency,
        NULL, NULL, NULL,
        SUM(COALESCE(cost, 0))::double precision,
        SUM(CASE WHEN cost_basis = 'reported' THEN COALESCE(cost, 0) ELSE 0 END)::double precision,
        SUM(CASE WHEN cost_basis = 'estimated' THEN COALESCE(cost, 0) ELSE 0 END)::double precision,
        SUM(CASE WHEN entry_kind = 'legacy' THEN COALESCE(cost, 0) ELSE 0 END)::double precision,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'reported')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'estimated')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'unknown')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'legacy')::int,
        SUM(tokens_in)::double precision, SUM(tokens_out)::double precision, COUNT(*)::int
      FROM projected GROUP BY (occurred_at AT TIME ZONE 'UTC')::date, currency
    )
    SELECT dimension, day, task_kind, currency, entry_kind, cost_basis, cost_ref,
      cost, reported_cost, estimated_cost, legacy_cost,
      reported_attempts, estimated_attempts, unknown_attempts, legacy_rows,
      tokens_in, tokens_out, calls
    FROM aggregates
  `);
}

/** Shared authority/dedup seam. Link authority is intentionally not window-filtered. */
function projectedCosts(from: Date, to?: Date) {
  const fromIso = from.toISOString();
  return sql`
    WITH authoritative_attempts AS NOT MATERIALIZED (
      SELECT attempt_id
      FROM provider_attempt
      WHERE finished_at IS NOT NULL
        AND provider_start_reserved_at IS NOT NULL
        AND (attempt_kind = 'opaque_operation' OR COALESCE(wire_count, 0) > 0)
    ), projected AS MATERIALIZED (
      SELECT c.task_kind, c.cost, c.currency, c.entry_kind, c.cost_basis, c.cost_ref,
        c.tokens_in, c.tokens_out, c.occurred_at,
        c.provider, c.model, NULL::text AS lane_id, 'cost_ledger'::text AS source,
        NULL::int AS wire_count, 'unclassified'::text AS usage_basis,
        'tokens'::text AS usage_unit, NULL::text AS usage_source,
        c.tokens_in::double precision AS usage_input, c.tokens_out::double precision AS usage_output,
        NULL::double precision AS usage_total
      FROM cost_ledger c
      LEFT JOIN authoritative_attempts linked_attempt
        ON linked_attempt.attempt_id = CASE
          WHEN c.task_run_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN c.task_run_id::uuid
          ELSE NULL
        END
      WHERE c.occurred_at >= ${fromIso}
        AND linked_attempt.attempt_id IS NULL
        ${to ? sql`AND c.occurred_at < ${to.toISOString()}` : sql``}
      UNION ALL
      SELECT p.operation_kind, p.cost_amount, COALESCE(p.cost_currency, 'XXX'),
        'attempt', p.cost_basis, p.cost_source,
        COALESCE((p.usage_json->>'input')::double precision, 0)::int,
        COALESCE((p.usage_json->>'output')::double precision, 0)::int,
        p.finished_at, p.provider, p.model, p.lane_id, 'provider_attempt', p.wire_count,
        p.usage_json->>'basis', p.usage_json->>'unit', p.usage_json->>'source',
        (p.usage_json->>'input')::double precision,
        (p.usage_json->>'output')::double precision,
        (p.usage_json->>'total')::double precision
      FROM provider_attempt p
      WHERE p.finished_at >= ${fromIso}
        ${to ? sql`AND p.finished_at < ${to.toISOString()}` : sql``}
        AND p.finished_at IS NOT NULL
        AND p.provider_start_reserved_at IS NOT NULL
        AND (p.attempt_kind = 'opaque_operation' OR COALESCE(p.wire_count, 0) > 0)
    )`;
}

/** Fixed observation window; terminal failed/retried calls still contribute their real cost. */
export async function readProviderCostWindow(
  db: Db | Tx,
  from: Date,
  to: Date,
): Promise<ProviderCostWindow> {
  if (!(Number.isFinite(from.getTime()) && Number.isFinite(to.getTime()) && from < to))
    throw new RangeError('Provider cost window must be finite and increasing');
  const details = await db.execute<ProviderCostDetail>(sql`
    ${projectedCosts(from, to)}
    SELECT provider, model, lane_id, task_kind, source, entry_kind, cost_basis, cost_ref, currency,
      SUM(cost)::double precision AS amount, COUNT(*)::int AS records,
      SUM(wire_count)::double precision AS wire_calls,
      COUNT(*) FILTER (WHERE wire_count IS NULL)::int AS unknown_wire_records,
      usage_basis, usage_unit, usage_source,
      SUM(usage_input)::double precision AS usage_input,
      SUM(usage_output)::double precision AS usage_output,
      SUM(usage_total)::double precision AS usage_total,
      COUNT(*) FILTER (WHERE usage_input IS NULL)::int AS missing_input_records,
      COUNT(*) FILTER (WHERE usage_output IS NULL)::int AS missing_output_records,
      COUNT(*) FILTER (WHERE usage_total IS NULL)::int AS missing_total_records
    FROM projected
    GROUP BY provider, model, lane_id, task_kind, source, entry_kind, cost_basis, cost_ref, currency,
      usage_basis, usage_unit, usage_source
    ORDER BY provider, model, lane_id, task_kind, source, entry_kind, cost_basis, cost_ref, currency,
      usage_basis, usage_unit, usage_source
  `);
  const currencies = new Map<string, ProviderCostWindow['by_currency'][number]>();
  let records = 0;
  for (const row of details) {
    records += row.records;
    const bucket = currencies.get(row.currency) ?? {
      currency: row.currency,
      cost: 0,
      reported_cost: 0,
      estimated_cost: 0,
      legacy_cost: 0,
      reported_attempts: 0,
      estimated_attempts: 0,
      unknown_attempts: 0,
      legacy_rows: 0,
    };
    const amount = row.amount ?? 0; // known subtotal; unknown counts remain explicit
    bucket.cost += amount;
    if (row.entry_kind === 'legacy') {
      bucket.legacy_cost += amount;
      bucket.legacy_rows += row.records;
    } else if (row.cost_basis === 'reported') {
      bucket.reported_cost += amount;
      bucket.reported_attempts += row.records;
    } else if (row.cost_basis === 'estimated') {
      bucket.estimated_cost += amount;
      bucket.estimated_attempts += row.records;
    } else {
      bucket.unknown_attempts += row.records;
    }
    currencies.set(row.currency, bucket);
  }
  return {
    scope: 'all_activity',
    records,
    by_currency: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    details,
  };
}
