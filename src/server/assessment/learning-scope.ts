import { inArray } from 'drizzle-orm';
import {
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  InterventionDiagnosticQuestionMetadata,
} from '@/core/schema/intervention';
import type { Tx } from '@/db/client';
import { question } from '@/db/schema';
import { LearningScope } from '@/kernel/read-models/assessment-learning-scope';

export { loadAssessmentLearningScope } from '@/kernel/read-models/assessment-learning-scope';

import { resolveAbilityGlobalByKnowledgeId } from '@/server/mastery/state';

/** Frozen in the original submission transaction, before any model execution. */
export async function snapshotAssessmentLearningScope(tx: Tx, groupId: string, partIds: string[]) {
  const rows = await tx
    .select({
      id: question.id,
      knowledge_ids: question.knowledge_ids,
      difficulty: question.difficulty,
      kind: question.kind,
      source: question.source,
      metadata: question.metadata,
    })
    .from(question)
    .where(inArray(question.id, [...new Set([groupId, ...partIds])]));
  return LearningScope.parse({
    version: 1,
    group_id: groupId,
    questions: rows
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ metadata, ...row }) => ({
        ...row,
        ...(row.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE
          ? {
              intervention_diagnostic: InterventionDiagnosticQuestionMetadata.parse(
                metadata?.intervention_diagnostic,
              ),
            }
          : {}),
      })),
    ability_global_by_knowledge_id: await resolveAbilityGlobalByKnowledgeId(tx, [
      ...new Set(rows.flatMap((row) => row.knowledge_ids)),
    ]),
  });
}
