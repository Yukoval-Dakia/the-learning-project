// First-question ranking for the non-due sources (new_check, frontier).
//
// A KC's first presented question must be the most informative one at the learner's
// current ability, not whichever row happens to sort first by id. This module reads the
// admitted questions on the requested KCs, scores them with the shared MFI maths against
// the KC's effective θ̂, and offers the best one or two per KC.

import { and, sql } from 'drizzle-orm';
import { mfiScore } from '@/core/selection-signals';
import { difficultyToLogitB } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import { question } from '@/db/schema';
import { effectiveThetaForKcBatch, getMasteryStates } from '@/kernel/read-models/mastery-state';
import { readHardCalibrationBs } from '@/kernel/read-models/question-difficulty';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';

type DbLike = Db | Tx;

/** Candidates offered per KC: the best first question plus one alternative for the sampler. */
const FIRST_QUESTION_PER_KC = 2;
/** KCs per candidate read: bounds each query's containment OR list. */
const KCS_PER_ROUND = 25;

/**
 * Ranked first questions for `orderedKnowledgeIds` (the caller's priority order), at most
 * `maxItems` overall and {@link FIRST_QUESTION_PER_KC} per KC.
 *
 * A KC with no usable question is a supply gap, not a first question, so it is skipped
 * without consuming the item budget; KCs are read in rounds until enough have a question.
 * Depth rounds keep the caller's KC diversity: the best question of each KC first, then
 * alternatives only while budget remains.
 *
 * `accept` applies caller policy (steering deferral) before the per-KC cut, so a filtered
 * question never occupies a slot. This prefilter scores point MFI; the sampler downstream
 * applies its own criterion (KLP for cold KCs, grid when enabled) to the survivors, so only
 * the candidate set here is decided by MFI. Difficulty is the same hard columnar anchor the
 * supply scanner reads, and missing calibration falls back to the difficulty proxy.
 * Cold-start θ̂ = 0 matches the other selection readers.
 */
export async function pickFirstQuestions(
  db: DbLike,
  orderedKnowledgeIds: readonly string[],
  maxItems: number,
  accept: (knowledgeIds: readonly string[]) => boolean = () => true,
): Promise<Array<{ questionId: string; knowledgeId: string }>> {
  const limit = Math.max(0, Math.floor(maxItems));
  const kcs = [...new Set(orderedKnowledgeIds.filter((id) => id.length > 0))];
  const pairs: Array<{ questionId: string; knowledgeId: string }> = [];
  if (limit === 0 || kcs.length === 0) return pairs;

  const roundSize = Math.max(limit, KCS_PER_ROUND);
  const rankedByKc = new Map<string, string[]>();
  for (let start = 0; start < kcs.length && rankedByKc.size < limit; start += roundSize) {
    const ranked = await rankFirstQuestions(db, kcs.slice(start, start + roundSize), accept);
    for (const [kc, ids] of ranked) {
      if (ids.length > 0) rankedByKc.set(kc, ids);
    }
  }

  const seen = new Set<string>();
  for (let depth = 0; depth < FIRST_QUESTION_PER_KC; depth += 1) {
    for (const kc of kcs) {
      const questionId = rankedByKc.get(kc)?.[depth];
      if (questionId === undefined || seen.has(questionId)) continue;
      seen.add(questionId);
      pairs.push({ questionId, knowledgeId: kc });
      if (pairs.length === limit) return pairs;
    }
  }
  return pairs;
}

/** Best-first admitted question ids per requested KC. */
async function rankFirstQuestions(
  db: DbLike,
  knowledgeIds: readonly string[],
  accept: (knowledgeIds: readonly string[]) => boolean,
): Promise<Map<string, string[]>> {
  const kcs = [...new Set(knowledgeIds.filter((id) => id.length > 0))];
  const out = new Map<string, string[]>();
  if (kcs.length === 0) return out;

  const containment = sql`(${sql.join(
    kcs.map((kc) => sql`${question.knowledge_ids} @> ${JSON.stringify([kc])}::jsonb`),
    sql` OR `,
  )})`;
  const rows = await db
    .select({
      id: question.id,
      knowledge_ids: question.knowledge_ids,
      difficulty: question.difficulty,
    })
    .from(question)
    .where(
      and(
        containment,
        notDraftPredicate(question.draft_status),
        questionSuspendedPredicate(question),
      ),
    )
    .orderBy(question.id);
  if (rows.length === 0) return out;

  const admittedIds = await readAutomaticallyServableQuestionIds(
    db,
    rows.map((row) => row.id),
  );
  const eligible = rows.filter((row) => admittedIds.has(row.id) && accept(row.knowledge_ids ?? []));
  if (eligible.length === 0) return out;

  const [mastery, hardBs] = await Promise.all([
    getMasteryStates(db, kcs, 'knowledge'),
    readHardCalibrationBs(
      db,
      eligible.map((row) => row.id),
    ),
  ]);
  const thetaByKc = await effectiveThetaForKcBatch(
    db,
    kcs.map((knowledgeId) => ({
      knowledgeId,
      thetaKc: mastery.get(knowledgeId)?.theta_hat ?? 0,
    })),
  );

  const scoredByKc = new Map<string, Array<{ id: string; score: number }>>();
  for (const row of eligible) {
    const hard = hardBs.get(row.id);
    const b = hard ?? difficultyToLogitB(row.difficulty);
    for (const kc of row.knowledge_ids ?? []) {
      const theta = thetaByKc.get(kc);
      if (theta === undefined) continue;
      const list = scoredByKc.get(kc) ?? [];
      list.push({ id: row.id, score: mfiScore(theta, b) });
      scoredByKc.set(kc, list);
    }
  }

  for (const [kc, scored] of scoredByKc) {
    // Score ties fall to id so composition stays reproducible across runs.
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    out.set(
      kc,
      scored.slice(0, FIRST_QUESTION_PER_KC).map((entry) => entry.id),
    );
  }
  return out;
}
