// Admin config read face's injected fact-host port. The DTO shape lives in
// core/config/contracts/admin (the config owner produces it); this module only
// holds the process-level injection slot so the route can read fresh facts and
// report facts_injected=false before the composition root installs them.
import type {
  AdminConfigRuntimeFacts,
  AdminConfigRuntimeFactsSource,
} from '@/core/config/contracts/admin';

let factsSource: AdminConfigRuntimeFactsSource | undefined;

/** Injected at boot; the last injection wins. */
export function setAdminConfigRuntimeFacts(source: AdminConfigRuntimeFactsSource): void {
  factsSource = source;
}

/** Route-side read; null means the face reports facts_injected=false. */
export function getAdminConfigRuntimeFacts(): AdminConfigRuntimeFacts | null {
  return factsSource?.() ?? null;
}

/** Test isolation. */
export function __resetAdminConfigRuntimeFactsForTests(): void {
  factsSource = undefined;
}
