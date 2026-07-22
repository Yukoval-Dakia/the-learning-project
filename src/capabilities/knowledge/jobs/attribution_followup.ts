// Phase 2 (Task #16) — async attribution for failure attempts.
//
// Previously /api/mistakes + /api/ingestion/[id]/import ran the
// AttributionTask inline via the fire-and-forget pattern — non-blocking from the
// response perspective, but tied to the Next.js process lifecycle (crash mid-
// LLM call = work lost) and consuming web-tier resources for an LLM call.
// This handler moves that work to the worker process via pg-boss.
//
// Payload: { attempt_event_id }.
// Behavior: load the chained attempt event (action='attempt', subject_kind='question',
// outcome='failure'), load the question + tree-snapshot of its referenced
// knowledge_ids, call runAttributionAndWriteJudgeEvent (existing helper,
// idempotent — skips when a judge event already exists).
//
// Failures rethrow → pg-boss retries per queue policy. YUK-379 (B1): the
// attribution helper no longer swallows — it returns a discriminant; a
// `retryable` outcome (DB/LLM fault) is rethrown here (→ pg-boss retry → llm_dlq),
// while `permanent` (LLM ok, parse failed) is recorded via a failed_permanent
// ledger row inside the helper and does NOT retry.

import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { runAttributionAndWriteJudgeEvent } from '@/capabilities/knowledge/server/attribute';
import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface AttributionFollowupJobData {
  attempt_event_id: string;
}

export type RunTaskFn = TaskTextRunFn;

export type EnqueueVariantGenFn = (attemptEventId: string) => Promise<void>;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  enqueueVariantGen?: EnqueueVariantGenFn;
};

async function defaultEnqueueVariantGen(attemptEventId: string): Promise<void> {
  // Worker process already has boss started; getStartedBoss() returns the same
  // instance. Caller catches errors — failure to enqueue should not abort the
  // attribution that already succeeded.
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('variant_gen', { attempt_event_id: attemptEventId });
}

export interface RunAttributionFollowupParams {
  db: Db;
  attemptEventId: string;
  runTaskFn: RunTaskFn;
  enqueueVariantGen?: EnqueueVariantGenFn;
}

export interface RunAttributionFollowupResult {
  status:
    | 'attempted'
    | 'skipped:attempt_not_found'
    | 'skipped:not_a_failure_attempt'
    | 'skipped:question_not_found';
}

/**
 * Pure runner — extracted so unit tests can call without pg-boss. Resolves
 * the attempt event + its question + the knowledge tree snapshot, hands off
 * to the existing AttributionTask runner. The helper itself is idempotent
 * (skips when a chained judge event already exists), so re-running this from
 * pg-boss retry is safe.
 */
export async function runAttributionFollowup(
  params: RunAttributionFollowupParams,
): Promise<RunAttributionFollowupResult> {
  const { db, attemptEventId, runTaskFn } = params;

  const eventRows = await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
    })
    .from(event)
    .where(eq(event.id, attemptEventId))
    .limit(1);
  const attempt = eventRows[0];
  if (!attempt) return { status: 'skipped:attempt_not_found' };
  if (
    attempt.action !== 'attempt' ||
    attempt.subject_kind !== 'question' ||
    attempt.outcome !== 'failure'
  ) {
    return { status: 'skipped:not_a_failure_attempt' };
  }

  const qRows = await db
    .select({
      id: question.id,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(eq(question.id, attempt.subject_id))
    .limit(1);
  const q = qRows[0];
  if (!q) return { status: 'skipped:question_not_found' };

  const payload = attempt.payload as {
    answer_md?: string | null;
    referenced_knowledge_ids?: string[];
  };
  const referencedKnowledgeIds =
    payload.referenced_knowledge_ids ?? (q.knowledge_ids as string[]) ?? [];

  // Tree snapshot for knowledge_context. Restrict to nodes the attempt
  // referenced — the prompt is bounded; the LLM doesn't need the whole tree.
  const tree = await loadTreeSnapshot(db);
  const referencedSet = new Set(referencedKnowledgeIds);
  const pickedNodes = tree
    .filter((n) => referencedSet.has(n.id))
    .map((n) => ({ id: n.id, name: n.name, effective_domain: n.effective_domain }));
  const subjectProfile = resolveSubjectProfile(pickedNodes[0]?.effective_domain ?? null);

  const outcome = await runAttributionAndWriteJudgeEvent({
    db,
    attemptEventId,
    input: {
      prompt_md: q.prompt_md,
      reference_md: q.reference_md,
      wrong_answer_md: payload.answer_md ?? '',
      knowledge_context: pickedNodes,
    },
    referencedKnowledgeIds,
    runTaskFn,
    subjectProfile,
  });

  // YUK-379 (B1): a retryable attribution failure (DB / LLM fault) rethrows HERE
  // — before the variant_gen fan-out — so pg-boss retries the whole job (→
  // llm_dlq after the queue's retry_limit) and no empty variant_gen job spins off
  // a mistake that never got a cause. written / skipped / permanent fall through:
  // the attribution attempt is complete (permanent already wrote its own
  // failed_permanent ledger row), so the best-effort fan-out proceeds as before.
  if (outcome.outcome === 'retryable') {
    throw outcome.error;
  }

  // Task #17: fan out to variant_gen. Idempotent on the consumer side
  // (variant_gen checks parent_variant_id uniqueness + cause eligibility),
  // so enqueueing on retry is safe. Best-effort: a failed enqueue must not
  // undo a successful attribution.
  if (params.enqueueVariantGen) {
    try {
      await params.enqueueVariantGen(attemptEventId);
    } catch (err) {
      console.error('[attribution_followup] enqueue variant_gen failed', err);
    }
  }

  return { status: 'attempted' };
}

export function buildAttributionFollowupHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<AttributionFollowupJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  const enqueueVariantGen = deps.enqueueVariantGen ?? defaultEnqueueVariantGen;
  return async (jobs) => {
    for (const job of jobs) {
      const attemptEventId = job.data?.attempt_event_id;
      if (!attemptEventId) {
        console.warn('[attribution_followup] job missing attempt_event_id', job.id);
        continue;
      }
      try {
        const result = await runAttributionFollowup({
          db,
          attemptEventId,
          runTaskFn,
          enqueueVariantGen,
        });
        console.log(`[attribution_followup] ${attemptEventId} → ${result.status}`);
      } catch (err) {
        console.error(`[attribution_followup] ${attemptEventId} failed`, err);
        throw err;
      }
    }
  };
}
