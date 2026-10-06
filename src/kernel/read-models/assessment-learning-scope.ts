import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { InterventionDiagnosticQuestionMetadata } from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

export const LearningScope = z.object({
  version: z.literal(1),
  group_id: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      knowledge_ids: z.array(z.string()),
      difficulty: z.number(),
      kind: z.string(),
      source: z.string(),
      intervention_diagnostic: InterventionDiagnosticQuestionMetadata.optional(),
    }),
  ),
  ability_global_by_knowledge_id: z.record(z.string(), z.string()),
});

/** Restrict frozen tags to issued parts and independently owned root tags. */
export function issuedLearningKnowledgeIds({
  scope,
  groupId,
  partIds,
}: {
  scope: z.infer<typeof LearningScope> | null | undefined;
  groupId: string;
  partIds: readonly string[];
}): string[] {
  if (!scope || scope.group_id !== groupId) return [];
  const issued = new Set(partIds);
  const partKnowledge = new Set(
    scope.questions.filter((row) => issued.has(row.id)).flatMap((row) => row.knowledge_ids),
  );
  const unissuedKnowledge = new Set(
    scope.questions
      .filter((row) => row.id !== groupId && !issued.has(row.id))
      .flatMap((row) => row.knowledge_ids),
  );
  const rootKnowledge = scope.questions.find((row) => row.id === groupId)?.knowledge_ids ?? [];
  return [
    ...new Set([
      ...rootKnowledge.filter((id) => !unissuedKnowledge.has(id) || partKnowledge.has(id)),
      ...partKnowledge,
    ]),
  ];
}

/** Historical receipts remain readable; malformed new snapshots cannot fall back to live tags. */
export async function loadAssessmentLearningScope(
  tx: Db | Tx,
  submissionId: string,
  groupId: string,
) {
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

export async function loadAssessmentLearningScopes(db: Db | Tx, submissionIds: string[]) {
  const scopes = new Map<string, z.infer<typeof LearningScope>>();
  for (let offset = 0; offset < submissionIds.length; offset += 500) {
    const receipts = await db
      .select({ id: event.subject_id, payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_submission'),
          eq(event.subject_kind, 'submission'),
          inArray(event.subject_id, submissionIds.slice(offset, offset + 500)),
        ),
      );
    for (const receipt of receipts) {
      if (receipt.payload.learning_scope !== undefined)
        scopes.set(receipt.id, LearningScope.parse(receipt.payload.learning_scope));
    }
  }
  return scopes;
}
