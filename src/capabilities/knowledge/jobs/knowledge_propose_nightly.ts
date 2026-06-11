// Phase 1c.1 Step 4 — nightly proposer source switch.
//
// PREVIOUSLY: scanned recent `mistake` rows (created_at > now() - 24h). NOW:
// scans recent failure attempts via getFailureAttempts (single-owner read
// API per ADR-0005), then joins to `question` for prompt/reference text.

import { inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import { type RunTaskFn, runProposeAndWrite } from '@/capabilities/knowledge/server/propose';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { getFailureAttempts } from '@/server/events/queries';
import { resolveSubjectProfile } from '@/subjects/profile';

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

async function resolveFirstKnowledgeSubjectProfile(db: Db, knowledgeIds: string[] | null) {
  const firstKnowledgeId = knowledgeIds?.find((id) => id.length > 0);
  if (!firstKnowledgeId) return resolveSubjectProfile(null);
  try {
    return resolveSubjectProfile(await getEffectiveDomain(db, firstKnowledgeId));
  } catch {
    return resolveSubjectProfile(null);
  }
}

/**
 * Nightly cron handler — scan the last 24h of failure attempt events and run
 * KnowledgeProposeTask per attempt. Per-attempt try-catch: one failure does
 * not abort the loop.
 *
 * Default runTaskFn delegates to @/server/ai/runner (prod); tests inject mocks.
 */
export async function runKnowledgeProposeNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<{ processed: number; failed: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const attempts = await getFailureAttempts(db, { since: cutoff, limit: 1000 });
  if (attempts.length === 0) return { processed: 0, failed: 0 };

  // Join question by subject_id to get prompt/reference. Single IN query
  // for the question lookup is cheaper than N round-trips.
  //
  // M3 closeout (2026-05-22): canonical use of learning_record.question_id
  // hub field (ADR-0015 §1) — NOT ActivityRef legacy. The shim at
  // src/server/review/activity-ref.ts bridges when an ActivityRef view is
  // needed; this reader stays on the canonical column. Lines 48 + downstream
  // `a.question_id` lookups inherit this justification.
  const questionIds = Array.from(new Set(attempts.map((a) => a.question_id)));
  const questionRows = await db
    .select({
      id: question.id,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
    })
    .from(question)
    .where(inArray(question.id, questionIds));
  const questionById = new Map(questionRows.map((q) => [q.id, q]));

  const runTaskFn: RunTaskFn = deps.runTaskFn ?? defaultRunTaskFn;

  let processed = 0;
  let failed = 0;
  for (const a of attempts) {
    const q = questionById.get(a.question_id);
    if (!q) {
      // attempt event without a matching question row — skip + count as failed
      // (this shouldn't happen in well-formed data; tests seed both).
      console.warn(
        `[knowledge_propose_nightly] attempt ${a.attempt_event_id} has no matching question ${a.question_id}`,
      );
      failed += 1;
      continue;
    }
    try {
      await runProposeAndWrite({
        db,
        mistakeContent: {
          prompt_md: q.prompt_md,
          reference_md: q.reference_md,
          wrong_answer_md: a.answer_md ?? '',
          knowledge_ids_picked: a.referenced_knowledge_ids ?? [],
        },
        runTaskFn,
        subjectProfile: await resolveFirstKnowledgeSubjectProfile(
          db,
          a.referenced_knowledge_ids ?? [],
        ),
      });
      processed += 1;
    } catch (err) {
      console.error(`[knowledge_propose_nightly] attempt ${a.attempt_event_id} failed`, err);
      failed += 1;
    }
  }
  return { processed, failed };
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

/**
 * pg-boss handler adapter — scheduler triggers; takes no args.
 */
export function buildKnowledgePropoNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runKnowledgeProposeNightly(db);
      console.log('[knowledge_propose_nightly] result', result);
    } catch (err) {
      console.error('[knowledge_propose_nightly] failed', err);
      throw err;
    }
  };
}
