import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import { resolveAbilityGlobalByKnowledgeId } from '@/server/mastery/state';

const LearningScope = z.object({
  version: z.literal(1),
  group_id: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      knowledge_ids: z.array(z.string()),
      difficulty: z.number(),
      kind: z.string(),
      source: z.string(),
    }),
  ),
  ability_global_by_knowledge_id: z.record(z.string(), z.string()),
});

/** Frozen in the original submission transaction, before any model execution. */
export async function snapshotAssessmentLearningScope(tx: Tx, groupId: string, partIds: string[]) {
  const rows = await tx
    .select({
      id: question.id,
      knowledge_ids: question.knowledge_ids,
      difficulty: question.difficulty,
      kind: question.kind,
      source: question.source,
    })
    .from(question)
    .where(inArray(question.id, [...new Set([groupId, ...partIds])]));
  return LearningScope.parse({
    version: 1,
    group_id: groupId,
    questions: rows.sort((a, b) => a.id.localeCompare(b.id)),
    ability_global_by_knowledge_id: await resolveAbilityGlobalByKnowledgeId(tx, [
      ...new Set(rows.flatMap((row) => row.knowledge_ids)),
    ]),
  });
}

/** Historical receipts remain readable; malformed new snapshots cannot fall back to live tags. */
export async function loadAssessmentLearningScope(tx: Tx, submissionId: string, groupId: string) {
  const [receipt] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_submission'),
        eq(event.subject_kind, 'submission'),
        eq(event.subject_id, submissionId),
      ),
    )
    .limit(1);
  const raw = receipt?.payload.learning_scope;
  if (raw === undefined) return null;
  const scope = LearningScope.parse(raw);
  if (scope.group_id !== groupId) throw new Error('assessment learning scope group mismatch');
  return scope;
}
