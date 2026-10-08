/**
 * Observability cross-capability ports.
 *
 * - YUK-1007: the admin config read face's runtime-facts injection seam. The
 *   composition root (server layer) aggregates server-side truth sources
 *   (provider registry, infra cron declarations, runtime constants) and each
 *   capability's consumer-effective facts, then injects the factory here —
 *   observability never imports src/server/* or other capabilities directly
 *   (capability-boundary ratchet stays exact).
 */

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
  type EventCorrectionInput,
  type EventCorrectionResult,
  type EventDetail,
  createEventCorrection,
  readEventDetail,
} from './server/event-detail';
export { readHubSyncHealth } from './server/hub-sync';
export { readProviderCostWindow } from './server/provider-cost-projection';
export { type TodayCost, loadTodayCost } from './server/today-cost';
