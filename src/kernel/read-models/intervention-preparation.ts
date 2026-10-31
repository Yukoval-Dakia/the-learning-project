// Read-only fence before a paid intervention authoring stage.
// The expected preparation job id is a check input, not part of the authoring
// context, so a restored or superseded job cannot reach the model prompt.

import { desc, eq } from 'drizzle-orm';
import {
  type InterventionAuthoringContextT,
  InterventionDeliveryMode,
  InterventionOutcome,
  InterventionPackage,
  InterventionPreparationAttempt,
  InterventionSettlement,
  InterventionSnapshot,
  InterventionStatus,
  PedagogyRecommendation,
} from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { intervention } from '@/db/schema';
import { getEffectiveProbeResultStatuses } from '@/kernel/read-models/probe-evidence';

type DbLike = Db | Tx;

export type InterventionPreparationStageGuard =
  | {
      status: 'ready';
      context: InterventionAuthoringContextT;
    }
  | {
      status:
        | 'intervention_not_found'
        | 'intervention_not_preparing'
        | 'preparation_job_superseded'
        | 'recommendation_unavailable'
        | 'source_evidence_inactive';
    };

export async function guardInterventionPreparationStage(
  db: DbLike,
  interventionId: string,
  expectedPreparationJobId: string,
): Promise<InterventionPreparationStageGuard> {
  const [row] = await db
    .select({
      status: intervention.status,
      delivery_mode: intervention.delivery_mode,
      outcome: intervention.outcome,
      preparation_job_id: intervention.preparation_job_id,
      source_probe_result_event_id: intervention.source_probe_result_event_id,
      snapshot_json: intervention.snapshot_json,
      recommendation_json: intervention.recommendation_json,
      package_json: intervention.package_json,
      settlement_json: intervention.settlement_json,
      preparation_attempts_json: intervention.preparation_attempts_json,
    })
    .from(intervention)
    .where(eq(intervention.id, interventionId))
    .orderBy(desc(intervention.version))
    .limit(1);
  if (!row) return { status: 'intervention_not_found' };

  // Same contracts as the agency row parser. A corrupt package or attempt list
  // still throws before a status return, so a paid model call cannot start.
  const status = InterventionStatus.parse(row.status);
  InterventionDeliveryMode.parse(row.delivery_mode);
  if (row.outcome !== null) InterventionOutcome.parse(row.outcome);
  const snapshot = InterventionSnapshot.parse(row.snapshot_json);
  const recommendation =
    row.recommendation_json === null ? null : PedagogyRecommendation.parse(row.recommendation_json);
  if (row.package_json !== null) InterventionPackage.parse(row.package_json);
  if (row.settlement_json !== null) InterventionSettlement.parse(row.settlement_json);
  InterventionPreparationAttempt.array().parse(row.preparation_attempts_json);
  if (status !== 'preparing') return { status: 'intervention_not_preparing' };
  if (row.preparation_job_id !== expectedPreparationJobId) {
    return { status: 'preparation_job_superseded' };
  }
  if (recommendation?.kind !== 'recommendation') {
    return { status: 'recommendation_unavailable' };
  }

  const effective = await getEffectiveProbeResultStatuses(db, [row.source_probe_result_event_id], {
    validateDirectChain: true,
  });
  if (effective.get(row.source_probe_result_event_id) !== 'active') {
    return { status: 'source_evidence_inactive' };
  }
  return {
    status: 'ready',
    context: {
      snapshot,
      recommendation,
    },
  };
}
