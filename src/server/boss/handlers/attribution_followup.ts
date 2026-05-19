// Phase 2 (Task #16) — async attribution for failure attempts.
//
// Previously /api/mistakes + /api/ingestion/[id]/import ran the
// AttributionTask inline via `next/server.after()` — non-blocking from the
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
// Failures rethrow → pg-boss retries per queue policy. Attribution helper
// already swallows LLM errors internally; only DB/lookup errors propagate.

import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { runAttributionAndWriteJudgeEvent } from '@/server/knowledge/attribute';
import { loadTreeSnapshot } from '@/server/knowledge/tree';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface AttributionFollowupJobData {
  attempt_event_id: string;
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

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

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
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

  await runAttributionAndWriteJudgeEvent({
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
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
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
