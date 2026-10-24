// Nightly knowledge-edge proposal over recent failure attempts, looking for
// cross-attempt graph patterns. Propose-only; the user accepts in the inbox.

import { and, desc, eq, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import {
  type RunEdgeProposeAndWriteParams,
  type RunTaskFn,
  runEdgeProposeAndWrite,
} from '@/capabilities/knowledge/server/propose_edge';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { getFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { resolveSubjectProfile } from '@/subjects/profile';

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  providerAttempt?: RunEdgeProposeAndWriteParams['providerAttempt'];
  pgbossJobId?: string;
  /** Test-only scan-limit override; production uses EDGE_PROPOSE_SCAN_LIMIT. */
  scanLimit?: number;
};

// Generic experimental action, so it is audit-only and never a pending proposal.
const EDGE_PROPOSE_WATERMARK_ACTION = 'experimental:edge_propose_watermark';
const EDGE_PROPOSE_WATERMARK_SUBJECT_ID = 'edge_propose_watermark';
// A larger backlog pages forward across runs; the cursor never jumps to `now`.
const EDGE_PROPOSE_SCAN_LIMIT = 200;
// First run only, so it does not rescan all history.
const FIRST_RUN_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EdgeProposeWatermark {
  last_processed_at: Date;
  last_processed_event_id: string;
}

/**
 * Latest watermark cursor, or null on the first run. Order by the payload cursor, not
 * the row timestamp; the cursor is monotonic and ISO strings sort chronologically.
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
 * Persist the cursor as an audit anchor. Only call on the success path. `ingest_at`
 * opts the row out of memory ingestion.
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
  folded_rubric_rejected: number;
  folded_topology_rejected: number;
  warned_transitive_redundancy: number;
  /** Supersede recommendations awaiting approval; no edge is mutated nightly. */
  reconcile_superseded: number;
  /** 1 when the pipeline swallowed a fault (`ok === false`). */
  llm_failed: number;
  /** 1 when the model was actually called; 0 for an empty tail. */
  llm_attempted: number;
}

/**
 * Scan failure attempts forward from the watermark and run the propose task once.
 * The cursor advances only when `ok` is true, even for a zero-proposal batch, so a
 * declined batch is not rescanned. First run falls back to 24h; later runs page forward.
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
      llm_failed: 0,
      llm_attempted: 0,
    };
  }

  const runTaskFn: RunTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  const {
    ok,
    llm_attempted: llmAttempted,
    ...stats
  } = await runEdgeProposeAndWrite({
    db,
    recentFailures: attempts,
    runTaskFn,
    env: process.env,
    providerAttempt: deps.providerAttempt,
    pgbossJobId: deps.pgbossJobId,
    subjectProfile: await resolveDominantSubjectProfile(db, attempts),
  });

  // Advance only on success. Attempts are ascending, so the last is the new cursor.
  if (ok) {
    const last = attempts[attempts.length - 1];
    await writeEdgeProposeWatermark(db, {
      last_processed_at: last.created_at,
      last_processed_event_id: last.attempt_event_id,
    });
  }

  // Carry `ok` out: it separates a swallowed fault from a batch the model declined.
  // llm_attempted comes from the pipeline, since an empty tree returns before the call.
  return {
    ...stats,
    attempts_considered: attempts.length,
    llm_attempted: llmAttempted ? 1 : 0,
    llm_failed: ok ? 0 : 1,
  };
}

export function buildKnowledgeEdgeProposeNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<JobYieldOutput> {
  return async (jobs) => {
    try {
      const result = await runKnowledgeEdgeProposeNightly(db, {
        pgbossJobId: jobs[0]?.id,
        providerAttempt: {
          db,
          caller: 'worker',
          deadlineAt: new Date(Date.now() + 65_000),
          operationAnchor: jobs[0]?.id,
        },
      });
      console.log('[knowledge_edge_propose_nightly] result', result);
      // Attempted covers both a model call and a swallowed pre-model fault. A truly
      // empty night sets neither and reports idle.
      const attempted = result.llm_attempted || result.llm_failed ? 1 : 0;
      return reportJobYield('knowledge_edge_propose_nightly', {
        attempted,
        succeeded: attempted - result.llm_failed,
        failed: result.llm_failed,
      });
    } catch (err) {
      console.error('[knowledge_edge_propose_nightly] failed', err);
      throw err;
    }
  };
}
