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
export { observabilityConfigEffectiveFacts } from './server/config-effective-facts';

export { readHubSyncHealth } from './server/hub-sync';
