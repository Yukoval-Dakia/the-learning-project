// Agency-owned canonical intervention contract surface.
//
// The JSON vocabulary itself is cross-capability and therefore lives in core;
// this module is the Agency lifecycle's named contract seam from the YUK-796
// design and keeps server callers off table types.
export {
  INTERVENTION_CONTRACT_VERSION,
  PEDAGOGY_METHOD_DEFINITION_VERSION,
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
  PedagogyRecommendation,
  PedagogyRecommendationModelOutput,
} from '@/core/schema/intervention';
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
