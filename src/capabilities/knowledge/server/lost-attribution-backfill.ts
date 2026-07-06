// YUK-379 (B1) — one-time backfill: re-drive attribution for failure attempts
// that were silently lost by the pre-fix swallow bug.
//
// WHY. Before YUK-379, runAttributionAndWriteJudgeEvent swallowed every failure
// (idempotency read / LLM / parse / write) into a console.error + a
// `failed_retryable` cost_ledger row and then returned void. That ledger row is
// triply invisible (task_run_id=NULL → no run-detail join, cost=0 → out of
// aggregates, no query reads the outcome column), so a failure attempt could end
// up with NO judge event and nobody noticing. This census finds those attempts —
// failure attempts lacking a real (non-`attribution_pending`) judge — and
// re-enqueues the EXISTING idempotent `attribution_followup` job for each.
//
// IDEMPOTENT + SAFE. The re-enqueued job runs runAttributionFollowup →
// runAttributionAndWriteJudgeEvent, whose getJudgeForAttempt skip-check no-ops
// when a real judge already exists. So an over-inclusive census wastes at most an
// enqueue (the job skips, zero LLM cost). The census predicate mirrors the
// helper's own skip rule exactly: an attempt is "lost" iff it has no chained
// judge whose payload.attribution_pending IS DISTINCT FROM 'true' (i.e. a
// pending paper placeholder still counts as lost — it needs real attribution).
//
// One-time ops script (scripts/backfill-lost-attribution.ts); NOT wired into any
// live request path and NOT scheduled.

import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { and, asc, eq, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

export interface LostAttributionCensus {
  /** attempt event ids lacking a real (non-pending) chained judge, capped at `limit`. */
  attemptIds: string[];
}

/**
 * Census: failure attempts (`action='attempt'`, `subject_kind='question'`,
 * `outcome='failure'`) that have NO chained judge event whose payload's
 * `attribution_pending` is DISTINCT FROM `'true'`. Ordered oldest-first, capped
 * at `limit`. Read-only.
 */
export async function censusLostAttributions(
  db: Db,
  opts: { limit: number },
): Promise<LostAttributionCensus> {
  const judge = alias(event, 'judge');
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'attempt'),
        eq(event.subject_kind, 'question'),
        eq(event.outcome, 'failure'),
        notExists(
          db
            .select({ one: sql`1` })
            .from(judge)
            .where(
              and(
                eq(judge.action, 'judge'),
                eq(judge.subject_kind, 'event'),
                eq(judge.caused_by_event_id, event.id),
                sql`(${judge.payload} ->> 'attribution_pending') is distinct from 'true'`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id))
    .limit(opts.limit);
  return { attemptIds: rows.map((r) => r.id) };
}

export type EnqueueAttributionFollowupFn = (attemptEventId: string) => Promise<void>;

export interface RunLostAttributionBackfillParams {
  db: Db;
  /** When true (default in the CLI), census only — zero writes, zero enqueues. */
  dryRun: boolean;
  /** Per-run cap on how many attempts are re-enqueued (CLI default 25). */
  limit: number;
  /** Enqueue fn — injected so the DB test drives it without a live pg-boss. */
  send?: EnqueueAttributionFollowupFn;
}

export interface LostAttributionBackfillResult {
  mode: 'dry-run' | 'apply';
  /** number of lost attempts the census found (capped at `limit`). */
  found: number;
  /** number of attribution_followup jobs enqueued (0 in dry-run). */
  enqueued: number;
  /** the attempt ids the census matched — for CLI reporting. */
  attemptIds: string[];
}

/**
 * Runs the census and, unless `dryRun`, re-enqueues one idempotent
 * `attribution_followup` job per lost attempt via the injected `send`.
 */
export async function runLostAttributionBackfill(
  params: RunLostAttributionBackfillParams,
): Promise<LostAttributionBackfillResult> {
  const { db, dryRun, limit } = params;
  const census = await censusLostAttributions(db, { limit });
  if (dryRun) {
    return {
      mode: 'dry-run',
      found: census.attemptIds.length,
      enqueued: 0,
      attemptIds: census.attemptIds,
    };
  }
  const send = params.send;
  if (!send) {
    throw new Error('runLostAttributionBackfill: `send` is required in apply mode');
  }
  let enqueued = 0;
  for (const attemptEventId of census.attemptIds) {
    await send(attemptEventId);
    enqueued += 1;
  }
  return {
    mode: 'apply',
    found: census.attemptIds.length,
    enqueued,
    attemptIds: census.attemptIds,
  };
}
