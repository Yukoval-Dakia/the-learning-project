/**
 * Observability cross-capability ports.
 *
 * - YUK-1007: the admin config read face's runtime-facts injection seam. The
 *   composition root (server layer) aggregates server-side truth sources
 *   (provider registry, infra cron declarations, runtime constants) and each
 *   capability's consumer-effective facts, then injects the factory here.
 *   The config read face receives runtime facts through that factory.
 */

export {
  type AdminSubjectListRow,
  type AdminSubjectTraits,
  type AdminTraitBindingRow,
  type AdminTraitCatalogRow,
  type TraitJournalPage,
  type TraitJournalPageOptions,
  type TraitJournalRow,
  getAdminSubjectTraits,
  getTraitJournalPage,
  listAdminSubjects,
  listAdminTraits,
} from '@/server/subjects/admin-read';
// Config consumers share the snapshot builder and the existing injected mutation writer.
export { type AdminConfigResponse, AdminConfigResponseSchema } from './api/admin-config-contracts';
export {
  AdminConfigResetBodySchema,
  AdminConfigWriteBodySchema,
  AdminConfigWriteResponseSchema,
} from './api/admin-config-write-contracts';

export {
  AdminCostQuerySchema,
  AdminCostResponseSchema,
  AdminFailuresQuerySchema,
  AdminFailuresResponseSchema,
  AdminRunDetailResponseSchema,
  AdminRunParamsSchema,
  AdminRunStatusSchema,
  AdminRunsQuerySchema,
  AdminRunsResponseSchema,
} from './api/admin-observability-contracts';
export {
  EventCorrectionBodySchema,
  EventCorrectionResponseSchema,
  EventDetailResponseSchema,
  EventParamsSchema,
} from './api/event-contracts';
export type {
  AdminConfigProviderRow,
  AdminConfigRuntimeFacts,
  AdminConfigRuntimeFactsSource,
  AdminConfigRuntimeSection,
  AdminConfigScheduleRow,
} from './server/admin-config-facts';
export {
  __resetAdminConfigRuntimeFactsForTests,
  getAdminConfigRuntimeFacts,
  setAdminConfigRuntimeFacts,
} from './server/admin-config-facts';
export {
  type AdminConfigResetInput,
  type AdminConfigWriteInput,
  patchAdminConfig,
  resetAdminConfig,
} from './server/admin-config-operations';
export type { AdminConfigWriteResult, AdminConfigWriter } from './server/admin-config-writer';
export { setAdminConfigWriter } from './server/admin-config-writer';
export {
  type AdminCostDto,
  type AdminCostOptions,
  AdminCostOptionsSchema,
  type AdminFailureClusterDto,
  type AdminFailuresDto,
  type AdminFailuresOptions,
  AdminFailuresOptionsSchema,
  type AdminRunDetailDto,
  type AdminRunDetailOptions,
  type AdminRunDto,
  type AdminRunTimelineEventDto,
  type AdminRunsDto,
  type AdminRunsOptions,
  AdminRunsOptionsSchema,
  type AdminRunsPageDto,
  loadAdminCost,
  loadAdminFailures,
  loadAdminRunDetail,
  loadAdminRuns,
  parseAdminCostQuery,
  parseAdminFailuresQuery,
  parseAdminRunsQuery,
} from './server/ai-observability';
export { observabilityConfigEffectiveFacts } from './server/config-effective-facts';
export {
  type AdminConfigKeyRow,
  type AdminConfigReadModel,
  type AdminConfigTaskRow,
  type AdminConfigValue,
  buildAdminConfigReadModel,
} from './server/config-read-model';
export {
  type ConjecturePredictionScoreRow,
  type ConjectureScanDiagnostics,
  type ConjectureScoresRead,
  type ConjectureTypedStateRow,
  loadConjectureScores,
} from './server/conjecture-scores';
export {
  type CoverageLatticeRead,
  type GapActivity,
  type KcCoverageRow,
  type LatticeGap,
  type SubjectCoverage,
  loadCoverageLattice,
} from './server/coverage-lattice';
export {
  type EventCorrectionInput,
  type EventCorrectionResult,
  type EventDetail,
  createEventCorrection,
  readEventDetail,
} from './server/event-detail';
export { readHubSyncHealth } from './server/hub-sync';
export { readProviderCostWindow } from './server/provider-cost-projection';
export {
  AdminSubjectCasBodySchema,
  type AdminSubjectCasInput,
  AdminSubjectControlParamsSchema,
  type AdminSubjectControlResult,
  type AdminSubjectValidationResult,
  RenameAdminSubjectBodySchema,
  type RenameAdminSubjectInput,
  type ValidateAdminSubjectInput,
  ValidateAdminSubjectInputSchema,
  renameAdminSubject,
  resetAdminSubject,
  restoreAdminSubject,
  retireAdminSubject,
  validateAdminSubject,
} from './server/subject-control-operations';
export { type TodayCost, loadTodayCost } from './server/today-cost';
