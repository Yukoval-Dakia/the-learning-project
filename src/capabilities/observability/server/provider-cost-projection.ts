import type { Db, Tx } from '@/db/client';
import { sql } from 'drizzle-orm';

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
  const fromIso = from.toISOString();
  return db.execute<ProviderCostAggregateRow>(sql`
    WITH authoritative_attempts AS NOT MATERIALIZED (
      SELECT attempt_id
      FROM provider_attempt
      WHERE finished_at IS NOT NULL
        AND provider_start_reserved_at IS NOT NULL
        AND (attempt_kind = 'opaque_operation' OR COALESCE(wire_count, 0) > 0)
    ), projected AS MATERIALIZED (
      SELECT c.task_kind, c.cost, c.currency, c.entry_kind, c.cost_basis, c.cost_ref,
        c.tokens_in, c.tokens_out, c.occurred_at
      FROM cost_ledger c
      LEFT JOIN authoritative_attempts linked_attempt
        ON linked_attempt.attempt_id = CASE
          WHEN c.task_run_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN c.task_run_id::uuid
          ELSE NULL
        END
      WHERE c.occurred_at >= ${fromIso}
        AND linked_attempt.attempt_id IS NULL
      UNION ALL
      SELECT p.operation_kind, p.cost_amount, COALESCE(p.cost_currency, 'XXX'),
        'attempt', p.cost_basis, p.cost_source,
        COALESCE((p.usage_json->>'input')::double precision, 0)::int,
        COALESCE((p.usage_json->>'output')::double precision, 0)::int,
        p.finished_at
      FROM provider_attempt p
      WHERE p.finished_at >= ${fromIso}
        AND p.finished_at IS NOT NULL
        AND p.provider_start_reserved_at IS NOT NULL
        AND (p.attempt_kind = 'opaque_operation' OR COALESCE(p.wire_count, 0) > 0)
    ), aggregates AS (
      SELECT 'total'::text AS dimension, NULL::text AS day, NULL::text AS task_kind,
        NULL::text AS currency, NULL::text AS entry_kind, NULL::text AS cost_basis,
        NULL::text AS cost_ref,
        COALESCE(SUM(COALESCE(cost, 0)), 0)::double precision AS cost,
        COALESCE(SUM(CASE WHEN cost_basis = 'reported' THEN COALESCE(cost, 0) ELSE 0 END), 0)::double precision AS reported_cost,
        COALESCE(SUM(CASE WHEN cost_basis = 'estimated' THEN COALESCE(cost, 0) ELSE 0 END), 0)::double precision AS estimated_cost,
        COALESCE(SUM(CASE WHEN entry_kind = 'legacy' THEN COALESCE(cost, 0) ELSE 0 END), 0)::double precision AS legacy_cost,
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
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'unknown')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'legacy')::int,
        SUM(tokens_in)::double precision, SUM(tokens_out)::double precision, COUNT(*)::int
      FROM projected GROUP BY task_kind, currency
      UNION ALL
      SELECT 'truth', NULL, NULL, currency, entry_kind, cost_basis, cost_ref,
        SUM(COALESCE(cost, 0))::double precision, 0::double precision, 0::double precision,
        0::double precision,
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
        COUNT(*) FILTER (WHERE entry_kind = 'attempt' AND cost_basis = 'unknown')::int,
        COUNT(*) FILTER (WHERE entry_kind = 'legacy')::int,
        SUM(tokens_in)::double precision, SUM(tokens_out)::double precision, COUNT(*)::int
      FROM projected GROUP BY (occurred_at AT TIME ZONE 'UTC')::date, currency
    )
    SELECT dimension, day, task_kind, currency, entry_kind, cost_basis, cost_ref,
      cost, reported_cost, estimated_cost, legacy_cost, unknown_attempts, legacy_rows,
      tokens_in, tokens_out, calls
    FROM aggregates
  `);
}
