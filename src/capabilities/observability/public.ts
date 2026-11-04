/**
 * Observability cross-capability ports. The composition root gathers server-side
 * truth sources and injects the config facts factory; the read face consumes it here.
 */

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
  AdminConfigTaskFacts,
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
  type AdminRequestOutcome,
  type TraitRequestOutcome,
  requestAdminSubjectTraits,
  requestAdminTraitJournal,
  requestAdminTraits,
  requestEditSharedTrait,
  requestEditSubjectTrait,
  requestForkSubjectTrait,
  requestRebindSubjectTrait,
  requestRenameAdminSubject,
  requestResetAdminSubject,
  requestResetTraitToSeed,
  requestRestoreAdminSubject,
  requestRetireAdminSubject,
  requestRollbackTrait,
  requestValidateAdminSubject,
} from './server/admin-control-request';
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
export {
  type BackupConfigHydrator,
  setBackupConfigHydrator,
} from './server/backup/config-hydrator';
// The rehearsal DB proof reads the same table order the backup restores.
export { FK_ORDER } from './server/backup/constants';
export { reconcileBuiltinTraits } from './server/builtin-trait-reconcile';
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
  listAdminSubjects,
} from './server/subject-admin-read';
export {
  type AdminSubjectCasInput,
  type AdminSubjectValidationResult,
  type RenameAdminSubjectInput,
  type ValidateAdminSubjectInput,
  renameAdminSubject,
} from './server/subject-control-operations';
export { thinCreateSubject } from './server/subject-create';
export {
  auditProfilesFromDb,
  formatDbProfileAuditReport,
} from './server/subject-profile-audit';
export {
  type ConfigIncompleteAlert,
  type TaskFailureAlertsRead,
  loadTaskFailureAlerts,
} from './server/task-failure-alerts';
export { type TodayCost, loadTodayCost } from './server/today-cost';
export {
  type EditSharedTraitInput,
  type EditSubjectTraitInput,
  type FanoutIssue,
  type ForkSubjectTraitInput,
  type RebindSubjectTraitInput,
  type ResetTraitToSeedInput,
  type RollbackTraitInput,
  type TraitWriteResult,
  editSharedTrait,
  editSubjectTrait,
  forkSubjectTrait,
  rebindSubjectTrait,
  resetTraitToSeed,
  rollbackTrait,
} from './server/trait-control-operations';
