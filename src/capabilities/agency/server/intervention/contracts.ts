// Agency-owned canonical intervention contract surface.
//
// The JSON vocabulary is cross-capability and lives in core; this module is the
// Agency lifecycle's contract seam and keeps server callers off table types.

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
  InterventionPreparationAttempt,
  InterventionSnapshot,
  InterventionStatus,
  PEDAGOGY_METHOD_DEFINITION_VERSION,
  PedagogyRecommendation,
  PedagogyRecommendationModelOutput,
} from '@/core/schema/intervention';
