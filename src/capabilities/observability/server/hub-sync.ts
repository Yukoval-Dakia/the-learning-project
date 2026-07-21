// YUK-384 — durable hub-sync reconciler health read model (operator contract).
//
// One PostgreSQL aggregate over `hub_sync_reconciliation` using filtered
// aggregates. Generation lag crosses the TypeScript boundary as TEXT (bigint-safe,
// never a JS number). Ages are floored whole seconds; a null age means "no such
// row" (no dirty / no invalid). Operator alerts documented in the rollout doc key
// off these fields: oldest dirty > 5m, expired leases persisting > 2 recovery
// cycles, invalid document > 15m, and a monotonically growing ready backlog.

import { sql } from 'drizzle-orm';

import type { Db } from '@/db/client';

export type HubSyncResidentStatus =
  | 'pending'
  | 'claimed'
  | 'applying'
  | 'retry_wait'
  | 'acknowledged'
  | 'cancelled';

export interface HubSyncHealth {
  by_status: Record<HubSyncResidentStatus, number>;
  dirty_count: number;
  ready_count: number;
  expired_lease_count: number;
  invalid_document_count: number;
  oldest_dirty_age_seconds: number | null;
  oldest_invalid_age_seconds: number | null;
  max_consecutive_failure_count: number;
  max_generation_lag: string;
  last_acknowledged_at: string | null;
  last_repair_key: string | null;
}

type HealthRow = {
  pending: string | number;
  claimed: string | number;
  applying: string | number;
  retry_wait: string | number;
  acknowledged: string | number;
  cancelled: string | number;
  dirty_count: string | number;
  ready_count: string | number;
  expired_lease_count: string | number;
  invalid_document_count: string | number;
  oldest_dirty_age_seconds: string | number | null;
  oldest_invalid_age_seconds: string | number | null;
  max_consecutive_failure_count: string | number;
  max_generation_lag: string | number;
  last_acknowledged_at: string | Date | null;
  last_repair_key: string | null;
};

export async function readHubSyncHealth(db: Db): Promise<HubSyncHealth> {
  const rows = await db.execute<HealthRow>(sql`
    select
      count(*) filter (where status = 'pending')       as pending,
      count(*) filter (where status = 'claimed')       as claimed,
      count(*) filter (where status = 'applying')      as applying,
      count(*) filter (where status = 'retry_wait')    as retry_wait,
      count(*) filter (where status = 'acknowledged')  as acknowledged,
      count(*) filter (where status = 'cancelled')     as cancelled,
      count(*) filter (where acknowledged_generation < generation) as dirty_count,
      count(*) filter (
        where status in ('pending', 'retry_wait') and next_attempt_at <= clock_timestamp()
      ) as ready_count,
      count(*) filter (
        where status in ('claimed', 'applying') and lease_expires_at < clock_timestamp()
      ) as expired_lease_count,
      count(*) filter (where last_error_class = 'invalid_document') as invalid_document_count,
      floor(extract(epoch from (
        clock_timestamp() - min(last_dirty_at) filter (where acknowledged_generation < generation)
      )))::bigint as oldest_dirty_age_seconds,
      floor(extract(epoch from (
        clock_timestamp() - min(last_error_at) filter (where last_error_class = 'invalid_document')
      )))::bigint as oldest_invalid_age_seconds,
      coalesce(max(consecutive_failure_count), 0) as max_consecutive_failure_count,
      coalesce(max(generation - acknowledged_generation), 0)::text as max_generation_lag,
      max(acknowledged_at) as last_acknowledged_at,
      max(last_repair_key) as last_repair_key
    from hub_sync_reconciliation
  `);

  const r = rows[0];
  const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

  return {
    by_status: {
      pending: Number(r.pending),
      claimed: Number(r.claimed),
      applying: Number(r.applying),
      retry_wait: Number(r.retry_wait),
      acknowledged: Number(r.acknowledged),
      cancelled: Number(r.cancelled),
    },
    dirty_count: Number(r.dirty_count),
    ready_count: Number(r.ready_count),
    expired_lease_count: Number(r.expired_lease_count),
    invalid_document_count: Number(r.invalid_document_count),
    oldest_dirty_age_seconds: num(r.oldest_dirty_age_seconds),
    oldest_invalid_age_seconds: num(r.oldest_invalid_age_seconds),
    max_consecutive_failure_count: Number(r.max_consecutive_failure_count),
    max_generation_lag: String(r.max_generation_lag),
    last_acknowledged_at: r.last_acknowledged_at
      ? new Date(r.last_acknowledged_at).toISOString()
      : null,
    last_repair_key: r.last_repair_key ?? null,
  };
}
