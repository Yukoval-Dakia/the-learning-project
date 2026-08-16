// Agency-owned canonical intervention contract surface.
//
// The JSON vocabulary itself is cross-capability and therefore lives in core;
// this module is the Agency lifecycle's named contract seam from the YUK-796
// design and keeps server callers off table types.

export type {
  InterventionAuthoringContextT,
  InterventionDeliveryModeT,
  InterventionOutcomeT,
  InterventionPackageModelOutputT,
  InterventionPackageReviewAuditT,
  InterventionPackageReviewModelOutputT,
  InterventionPackageT,
  InterventionPreparationAttemptT,
  InterventionSnapshotT,
  InterventionStatusT,
  PedagogyRecommendationModelOutputT,
  PedagogyRecommendationT,
} from '@/core/schema/intervention';
export {
  INTERVENTION_CONTRACT_VERSION,
  InterventionAuthoringContext,
  InterventionDeliveryMode,
  InterventionOutcome,
  InterventionPackage,
  InterventionPackageModelOutput,
  InterventionPackageReviewAudit,
  InterventionPackageReviewModelOutput,
  InterventionPreparationAttempt,
  InterventionSnapshot,
  InterventionStatus,
  PEDAGOGY_METHOD_DEFINITION_VERSION,
  PedagogyRecommendation,
  PedagogyRecommendationModelOutput,
} from '@/core/schema/intervention';
