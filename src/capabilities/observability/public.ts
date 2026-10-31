/**
 * Observability cross-capability ports. The composition root gathers server-side
 * truth sources and injects the config facts factory; the read face consumes it here.
 */

export type {
  CoverageLatticeRead,
  GapActivity,
  KcCoverageRow,
  LatticeGap,
  SubjectCoverage,
} from '@/kernel/read-models/coverage-lattice';
export { readProviderCostWindow } from '@/kernel/read-models/provider-cost-projection';
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
  AdminConfigCatalogModelRow,
  AdminConfigProviderAuth,
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
export { loadCalibrationMaturity } from './server/calibration-maturity';
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
export { loadEffectivenessTrend } from './server/effectiveness-trend';
export {
  type EventCorrectionInput,
  type EventCorrectionResult,
  type EventDetail,
  createEventCorrection,
  readEventDetail,
} from './server/event-detail';
export { readHubSyncHealth } from './server/hub-sync';
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
} from './server/subject-admin-read';
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
export { thinCreateSubject } from './server/subject-create';
export {
  auditProfilesFromDb,
  formatDbProfileAuditReport,
} from './server/subject-profile-audit';
export { type TodayCost, loadTodayCost } from './server/today-cost';
export {
  AdminSubjectTraitParamsSchema,
  AdminTraitWriteParamsSchema,
  type EditSharedTraitInput,
  EditSharedTraitInputSchema,
  type EditSubjectTraitInput,
  EditSubjectTraitInputSchema,
  type FanoutIssue,
  ForkSubjectTraitBodySchema,
  type ForkSubjectTraitInput,
  RebindSubjectTraitBodySchema,
  type RebindSubjectTraitInput,
  ResetAdminTraitBodySchema,
  type ResetTraitToSeedInput,
  RollbackAdminTraitBodySchema,
  type RollbackTraitInput,
  type TraitWriteResult,
  editSharedTrait,
  editSubjectTrait,
  forkSubjectTrait,
  rebindSubjectTrait,
  resetTraitToSeed,
  rollbackTrait,
} from './server/trait-control-operations';
