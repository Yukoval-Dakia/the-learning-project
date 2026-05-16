// Phase 1c.1 Step 4 — nightly proposer source switch.
//
// PREVIOUSLY: scanned recent `mistake` rows (created_at > now() - 24h). NOW:
// scans recent failure attempts via getFailureAttempts (single-owner read
// API per ADR-0005), then joins to `question` for prompt/reference text.

import { inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { getFailureAttempts } from '@/server/events/queries';
import { type RunTaskFn, runProposeAndWrite } from '@/server/knowledge/propose';

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

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
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

/**
 * pg-boss handler adapter — scheduler triggers; takes no args.
 */
export function buildKnowledgePropoNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runKnowledgeProposeNightly(db);
    console.log('[knowledge_propose_nightly] result', result);
  };
}
