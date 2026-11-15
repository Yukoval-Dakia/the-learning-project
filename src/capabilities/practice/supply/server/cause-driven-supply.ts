import type { QuestionKindT } from '@/core/schema/judge-routing';
import { type ActionableWeakPointT, weakPointKey } from '@/core/schema/weak-point';
import type { Db, Tx } from '@/db/client';
import { listDerivableActiveMisconceptionsForKcs } from '@/kernel/read-models/failure-learning-context';
import { deriveActionableWeakPoints } from '@/kernel/read-models/weak-points';
import { answerClassCompatible } from '@/subjects/question-kind';

export const SUPPLY_CAUSE_RECURRENCE_THRESHOLD = 3;

// Pins promise an answer class, including aliases, as the executor does; they do not
// promise a literal display label or prove that the item treats the cause.
export function supplyKindForWeakPoint(point: ActionableWeakPointT): QuestionKindT {
  switch (point.training_destination) {
    case 'concept_review':
    case 'retrieval_practice':
      return 'fill_blank';
    case 'procedural_practice':
      return 'short_answer';
    case 'discrimination_probe':
      return 'choice';
  }
}

export function supplyCauseRef(point: ActionableWeakPointT): string {
  return weakPointKey(point.meta_cause, point.cause_category, point.knowledge_id);
}

export function countSupplyKindCoverage(
  kinds: ReadonlyMap<string, number>,
  requiredKind: string,
): number {
  let count = 0;
  for (const [kind, available] of kinds) {
    if (answerClassCompatible(kind, requiredKind)) count += available;
  }
  return count;
}

export interface SupplyCauseRequirement {
  ref: string;
  knowledge_id: string;
  required_kind: string;
}

export async function loadSupplyCauseSignals(
  db: Db | Tx,
  now: Date = new Date(),
  deferredKnowledgeIds: ReadonlySet<string> = new Set(),
) {
  const derived = await deriveActionableWeakPoints(db, { now });
  const weakPoints = {
    ...derived,
    weak_points: derived.weak_points.filter(
      (point) => point.knowledge_id === null || !deferredKnowledgeIds.has(point.knowledge_id),
    ),
  };
  const knowledgeIds = [
    ...new Set(
      weakPoints.weak_points.flatMap((point) => (point.knowledge_id ? [point.knowledge_id] : [])),
    ),
  ];
  // The public reader returns nodes without edge endpoints. Read each bounded weak-point KC
  // separately so a misconception on one KC is never attributed to every KC in the batch.
  const activeMisconceptions = await Promise.all(
    knowledgeIds.map(async (knowledgeId) => ({
      knowledge_id: knowledgeId,
      items: await listDerivableActiveMisconceptionsForKcs(db, [knowledgeId]),
    })),
  );
  return { weak_points: weakPoints, active_misconceptions: activeMisconceptions };
}

export type SupplyCauseSignals = Awaited<ReturnType<typeof loadSupplyCauseSignals>>;
