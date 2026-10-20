// Complete read-only pool dedup check for tier-2 source verification.
// Query visibility, candidate bound, traversal order and verdict stay together.

import { and, ne, or, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { question } from '@/db/schema';
import { DEDUP_OVERLAP_THRESHOLD, maxNgramOverlap } from '../server/question-supply/sourced-dedup';
import type { CheckOutcome } from './source_verify_prechecks';

type QuestionRow = typeof question.$inferSelect;

// dedup — not a near-duplicate of an existing ACTIVE pool question sharing one of
// this question's knowledge points. Deterministic n-gram overlap (reused from
// quiz_verify). No candidates / no knowledge ids → no signal → pass.
export async function checkDedup(db: Db, row: QuestionRow): Promise<CheckOutcome> {
  const knowledgeIds = row.knowledge_ids ?? [];
  if (knowledgeIds.length === 0) {
    return { check: 'dedup', verdict: 'pass', reason: 'no knowledge_ids — dedup not applicable' };
  }
  // Pull existing ACTIVE pool questions that share ANY knowledge point. Mirrors
  // due-list's `knowledge_ids @> [id]::jsonb` containment precedent (due-list.ts:215),
  // OR'd per id for ANY-overlap. Exclude the row itself + drafts. LIMIT keeps the
  // comparison bounded.
  const overlapClauses = knowledgeIds.map(
    (kid) => sql`${question.knowledge_ids} @> ${JSON.stringify([kid])}::jsonb`,
  );
  const candidates = await db
    .select({ id: question.id, prompt_md: question.prompt_md })
    .from(question)
    .where(
      and(
        ne(question.id, row.id),
        // Pool-visibility (红线-4, NULL≡active; legacy active rows carry NULL — a bare
        // ne() would drop them). Shared notDraftPredicate (@/db/predicates).
        notDraftPredicate(question.draft_status),
        or(...overlapClauses),
      ),
    )
    .limit(50);
  if (candidates.length === 0) {
    return { check: 'dedup', verdict: 'pass', reason: 'no existing pool question to compare' };
  }
  let maxOverlap = 0;
  let nearestId = '';
  for (const c of candidates) {
    const overlap = maxNgramOverlap(row.prompt_md, [c.prompt_md]);
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      nearestId = c.id;
    }
  }
  if (maxOverlap >= DEDUP_OVERLAP_THRESHOLD) {
    return {
      check: 'dedup',
      verdict: 'fail',
      reason: `near-duplicate of pool question ${nearestId} (overlap ${maxOverlap.toFixed(2)} >= ${DEDUP_OVERLAP_THRESHOLD})`,
    };
  }
  return {
    check: 'dedup',
    verdict: 'pass',
    reason: `max overlap ${maxOverlap.toFixed(2)} below dedup threshold`,
  };
}
