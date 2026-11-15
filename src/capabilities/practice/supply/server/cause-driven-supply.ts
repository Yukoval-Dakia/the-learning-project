import type { QuestionKindT } from '@/core/schema/judge-routing';
import type { ActionableWeakPointT } from '@/core/schema/weak-point';
import type { Db, Tx } from '@/db/client';
import { listActiveMisconceptionsForKcs } from '@/kernel/read-models/failure-learning-context';
import { deriveActionableWeakPoints } from '@/kernel/read-models/weak-points';

export const SUPPLY_CAUSE_RECURRENCE_THRESHOLD = 3;

// These are supply format requirements, not proof that an existing item treats the cause.
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

export async function loadSupplyCauseSignals(db: Db | Tx, now: Date = new Date()) {
  const weakPoints = await deriveActionableWeakPoints(db, { now });
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
      items: await listActiveMisconceptionsForKcs(db, [knowledgeId]),
    })),
  );
  return { weak_points: weakPoints, active_misconceptions: activeMisconceptions };
}

export type SupplyCauseSignals = Awaited<ReturnType<typeof loadSupplyCauseSignals>>;
