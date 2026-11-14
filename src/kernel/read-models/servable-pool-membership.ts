// Canonical current servable review-pool membership, keyed by knowledge point.
//
// One owner for the "is there a servable question for KC K today" question: the
// scheduling variant-rotation prefetch and the question-bank selection_miss
// fulfillment read share this projection so a replenished KC stops looking like
// a gap and a drained KC keeps dispatching acquisition work. Membership is
// question-id + KC-bucket only — no solution bodies leave the kernel boundary.
//
// Membership semantics: candidate = non-draft question row whose knowledge_ids
// contains K, in a lifecycle group that is not suspended/withdrawn; member =
// readAutomaticallyServableQuestionIds (group admitted + general_pool
// availability + purpose gate + serving decision). memberCount counts members
// per KC; memberQuestionIds lists them unordered (callers own ordering — the
// prefetch re-sorts by created_at/id itself).
import { type SQL, and, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import { question } from '@/db/schema';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';

export interface ServablePoolMembership {
  /** KC → admitted member question ids (order unspecified). Empty/absent ⇒ KC has no servable member. */
  memberQuestionIds: ReadonlyMap<string, readonly string[]>;
  /** KC → number of admitted member questions. */
  memberCount: ReadonlyMap<string, number>;
}

function knowledgeContains(knowledgeId: string) {
  return sql`${question.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`;
}

/**
 * The candidate-pool WHERE clause for servable membership over `question`:
 * non-draft, KC-containing (OR over `knowledgeIds`), in a non-suspended,
 * non-withdrawn lifecycle group. Exposed so a caller that must project full
 * ordered rows (the variant-rotation prefetch) filters on the identical
 * candidate predicate instead of re-declaring it.
 */
export function servablePoolCandidatePredicate(knowledgeIds: readonly string[]): SQL {
  const ids = [...new Set(knowledgeIds)];
  const containment = sql`(${sql.join(
    ids.map((kc) => knowledgeContains(kc)),
    sql` OR `,
  )})`;
  return and(
    notDraftPredicate(question.draft_status),
    containment,
    questionSuspendedPredicate(question),
  ) as SQL;
}

/**
 * Current servable review-pool membership for the given KCs. Read-only, no
 * effects; a KC whose pool drains between two reads resurfaces as a gap, and a
 * replenished KC drops out — this is a same-current-pool projection, not a
 * global consistency guarantee.
 */
export async function readServablePoolMembership(
  db: Db | Tx,
  knowledgeIds: readonly string[],
): Promise<ServablePoolMembership> {
  const memberQuestionIds = new Map<string, string[]>();
  const memberCount = new Map<string, number>();
  const ids = [...new Set(knowledgeIds)];
  if (ids.length === 0) return { memberQuestionIds, memberCount };
  const rows = await db
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(servablePoolCandidatePredicate(ids));
  const admitted = await readAutomaticallyServableQuestionIds(
    db,
    rows.map((row) => row.id),
  );
  const requested = new Set(ids);
  for (const row of rows) {
    if (!admitted.has(row.id)) continue;
    for (const kc of row.knowledge_ids ?? []) {
      if (!requested.has(kc)) continue;
      const bucket = memberQuestionIds.get(kc);
      if (bucket) bucket.push(row.id);
      else memberQuestionIds.set(kc, [row.id]);
      memberCount.set(kc, (memberCount.get(kc) ?? 0) + 1);
    }
  }
  return { memberQuestionIds, memberCount };
}
