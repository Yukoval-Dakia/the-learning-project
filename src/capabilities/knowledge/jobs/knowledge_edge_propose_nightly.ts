// Phase 2 Dreaming — nightly knowledge_edge propose handler.
//
// Edge propose is a batch run once per day across recent failure attempts
// (cross-attempt pattern matching). Triggered daily at BJT 02:30.
//
// Lane D (YUK-482): this job used to be described as paired with the
// `knowledge_propose_nightly` cron (per-attempt node propose at BJT 02:00, then
// edge propose at 02:30). The node-propose cron + `KnowledgeProposeTask` have
// been removed — see docs/architecture.md §5.1. This edge-propose job is RETAINED
// because edge proposal is a graph-topology maintenance concern (it reads
// `recent_failures` as one input among several), not the "答错 → propose new KC"
// coupling that Lane D unwired. The 02:30 slot no longer has a 02:00 partner to
// 错峰 against, but the time itself is harmless and changing cron schedules has
// ops cost (unregister/re-register queue+schedule); kept as-is until a separate
// reason to move it.

import { and, desc, eq, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import {
  type RunTaskFn,
  runEdgeProposeAndWrite,
} from '@/capabilities/knowledge/server/propose_edge';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { getFailureAttempts, writeEvent } from '@/server/events/queries';
import { resolveSubjectProfile } from '@/subjects/profile';

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  // YUK-583 — test-only seam to drive the backlog-paging path cheaply (mirrors
  // merge_attribution_sweep's `maxRepair` injectable cap). Never set in prod:
  // production always uses EDGE_PROPOSE_SCAN_LIMIT.
  scanLimit?: number;
};

// YUK-583 — watermark anchor-event coordinates. A generic `experimental:*` action
// (NOT a RESERVED_EXPERIMENTAL_ACTION) so it parses via the loose ExperimentalEvent
// escape hatch and matches no proposalWhere()/knowledge-fold predicate — audit-only,
// never a pending inbox item (same fold-fall-through shape as `experimental:kc_dedup_scan`).
const EDGE_PROPOSE_WATERMARK_ACTION = 'experimental:edge_propose_watermark';
// Stable sentinel subject_id (no single KC is the subject of the scan) — mirrors
// kc_dedup_nightly's `subject_id: 'kc_dedup_scan'`.
const EDGE_PROPOSE_WATERMARK_SUBJECT_ID = 'edge_propose_watermark';
// limit 200 = 自然分页: a backlog > 200 advances the cursor only to the 200th event
// this run, and the next run continues from there (never a jump to `now`).
const EDGE_PROPOSE_SCAN_LIMIT = 200;
// First-run-only fallback window (no watermark yet) — the legacy 24h窗, kept so the
// very first run does not re-scan all history (防重扫全史).
const FIRST_RUN_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EdgeProposeWatermark {
  last_processed_at: Date;
  last_processed_event_id: string;
}

/**
 * Recover the续扫 cursor from the LATEST watermark anchor event, or `null` on the
 * first-ever run. Ordered by the PAYLOAD cursor (last_processed_at, then
 * last_processed_event_id) DESC — i.e. the FURTHEST cursor ever recorded, matching
 * the keyset order getFailureAttempts pages by. (Ordering by the row's wall-clock
 * created_at would be fragile if two anchors shared a millisecond; the cursor value
 * is monotonic by construction, so ordering on it is exact.) ISO-8601 UTC strings
 * (written via toISOString below) sort lexically == chronologically.
 */
export async function loadEdgeProposeWatermark(db: Db): Promise<EdgeProposeWatermark | null> {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, EDGE_PROPOSE_WATERMARK_ACTION),
        eq(event.subject_kind, 'knowledge'),
        eq(event.subject_id, EDGE_PROPOSE_WATERMARK_SUBJECT_ID),
      ),
    )
    .orderBy(
      desc(sql`${event.payload}->>'last_processed_at'`),
      desc(sql`${event.payload}->>'last_processed_event_id'`),
    )
    .limit(1);
  const payload = rows[0]?.payload as
    | { last_processed_at?: unknown; last_processed_event_id?: unknown }
    | undefined;
  if (typeof payload?.last_processed_at !== 'string') return null;
  if (typeof payload?.last_processed_event_id !== 'string') return null;
  const at = new Date(payload.last_processed_at);
  if (Number.isNaN(at.getTime())) return null;
  return { last_processed_at: at, last_processed_event_id: payload.last_processed_event_id };
}

/**
 * Persist the续扫 cursor as an audit anchor event. RED LINE: only ever called on the
 * success path (see runKnowledgeEdgeProposeNightly). `ingest_at: now` opts the row
 * OUT of the memory-ingestion outbox (memory/triggers.ts `WHERE ingest_at IS NULL`)
 * so this internal bookkeeping row never fans out to Mem0/brief-regen — mirrors
 * merge_attribution_sweep's forensic-event opt-out.
 */
export async function writeEdgeProposeWatermark(
  db: Db,
  watermark: EdgeProposeWatermark,
  now: Date = new Date(),
): Promise<void> {
  await writeEvent(db, {
    id: newId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'knowledge_edge_propose_nightly',
    action: EDGE_PROPOSE_WATERMARK_ACTION,
    subject_kind: 'knowledge',
    subject_id: EDGE_PROPOSE_WATERMARK_SUBJECT_ID,
    outcome: 'success',
    payload: {
      last_processed_at: watermark.last_processed_at.toISOString(),
      last_processed_event_id: watermark.last_processed_event_id,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    ingest_at: now,
  });
}

async function resolveDominantSubjectProfile(
  db: Db,
  attempts: Awaited<ReturnType<typeof getFailureAttempts>>,
) {
  const domains = new Set<string>();
  for (const attempt of attempts) {
    const firstKnowledgeId = attempt.referenced_knowledge_ids?.find((id) => id.length > 0);
    if (!firstKnowledgeId) continue;
    try {
      domains.add(await getEffectiveDomain(db, firstKnowledgeId));
    } catch {
      // Missing or malformed knowledge refs fall back below.
    }
  }
  if (domains.size === 1) {
    return resolveSubjectProfile([...domains][0]);
  }
  // Graph-wide edge proposal can span multiple subjects. Until the task input
  // carries per-attempt profiles, use the default profile for mixed/unknown batches.
  return resolveSubjectProfile(null);
}

export interface NightlyResult {
  proposed: number;
  attempts_considered: number;
  skipped_self_loop: number;
  skipped_unknown_node: number;
  skipped_duplicate_edge: number;
  skipped_duplicate_pending: number;
  // P5.4 §5-Q5 / YUK-175 — batch edge proposals folded by the L1 rubric floor.
  folded_rubric_rejected: number;
  // ADR-0034 §2 / YUK-344 — TOPOLOGY gate hard-rejects (cycle / direction
  // contradiction). Previously spread through {...stats} but untyped here.
  folded_topology_rejected: number;
  // ADR-0034 §2 / YUK-344 — TOPOLOGY transitive-redundancy WARNINGS (proposed live
  // but marked). Previously spread through {...stats} but untyped here.
  warned_transitive_redundancy: number;
  // YUK-689 — RECONCILE SUPERSEDE recommendations emitted as pending proposals.
  // Historical result key retained for compatibility; no edge is mutated nightly.
  reconcile_superseded: number;
}

/**
 * Scan failure attempts FORWARD from the durable watermark cursor (YUK-583) and run
 * KnowledgeEdgeProposeTask once with the batch. Replaces the old lossy 24h rolling
 * window: a failure event that landed between the last cursor and the 24h window (a
 * swallowed nightly LLM failure, or a missed cron trigger) is no longer dropped —
 * the cursor is only advanced past events that were actually, successfully processed.
 *
 * - First run (no watermark): fall back to the legacy 24h窗 so we do NOT re-scan all
 *   history, then establish the cursor from that batch.
 * - Every run after: read attempts strictly after (last_processed_at,
 *   last_processed_event_id), ASC, capped at EDGE_PROPOSE_SCAN_LIMIT. A backlog >
 *   limit pages forward across runs (自然分页) — the cursor advances only to the last
 *   event this run processed, NEVER to `now`.
 * - 0 attempts (vacuum tail) → no-op, no LLM call, cursor unchanged (re-scanning the
 *   empty tail next run is a cheap indexed 0-row lookup).
 *
 * RED LINE: the watermark advances iff runEdgeProposeAndWrite returns `ok === true`.
 * `ok` is false ONLY when that pipeline SWALLOWED an error (its catch-all), so a
 * 吞错夜 never advances — the batch is re-scanned next run. A successfully-processed
 * batch advances even when it produced ZERO proposals (the gate is "batch processed",
 * never "proposed > 0" — else a批次 the LLM keeps declining would be re-scanned forever).
 */
export async function runKnowledgeEdgeProposeNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<NightlyResult> {
  const scanLimit = deps.scanLimit ?? EDGE_PROPOSE_SCAN_LIMIT;
  const cursor = await loadEdgeProposeWatermark(db);

  const attempts = cursor
    ? await getFailureAttempts(db, {
        afterCreatedAt: cursor.last_processed_at,
        afterEventId: cursor.last_processed_event_id,
        includeReviewFailures: true,
        order: 'asc',
        limit: scanLimit,
      })
    : await getFailureAttempts(db, {
        since: new Date(Date.now() - FIRST_RUN_FALLBACK_WINDOW_MS),
        includeReviewFailures: true,
        order: 'asc',
        limit: scanLimit,
      });

  if (attempts.length === 0) {
    return {
      proposed: 0,
      attempts_considered: 0,
      skipped_self_loop: 0,
      skipped_unknown_node: 0,
      skipped_duplicate_edge: 0,
      skipped_duplicate_pending: 0,
      folded_rubric_rejected: 0,
      folded_topology_rejected: 0,
      warned_transitive_redundancy: 0,
      reconcile_superseded: 0,
    };
  }

  const runTaskFn: RunTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  const { ok, ...stats } = await runEdgeProposeAndWrite({
    db,
    recentFailures: attempts,
    runTaskFn,
    // YUK-344: pass env explicitly so the live edge-reconcile judge resolves its
    // GLM (ZHIPU) config from the same env the rest of the pipeline uses. The live
    // judge falls back to process.env when env is undefined, but threading it here
    // keeps the nightly handler aligned with judgeEdgeReconcile({ env }) and the
    // runTask provenance ctx (both env-scoped).
    env: process.env,
    subjectProfile: await resolveDominantSubjectProfile(db, attempts),
  });

  // RED LINE (YUK-583): advance the cursor ONLY inside the success path. `ok` is the
  // success/failure discriminant on runEdgeProposeAndWrite's return — false ONLY when
  // it swallowed an error. `attempts` is ASC, so its LAST element is the max
  // (created_at, id) = the new keyset cursor. (attempts.length ≥ 1 here — the vacuum
  // branch returned above.)
  if (ok) {
    const last = attempts[attempts.length - 1];
    await writeEdgeProposeWatermark(db, {
      last_processed_at: last.created_at,
      last_processed_event_id: last.attempt_event_id,
    });
  }

  return { ...stats, attempts_considered: attempts.length };
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<RunTaskFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return result;
}

export function buildKnowledgeEdgeProposeNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runKnowledgeEdgeProposeNightly(db);
      console.log('[knowledge_edge_propose_nightly] result', result);
    } catch (err) {
      console.error('[knowledge_edge_propose_nightly] failed', err);
      throw err;
    }
  };
}
