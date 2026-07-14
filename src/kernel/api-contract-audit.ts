import {
  type ApiRouteDecl,
  type CapabilityManifest,
  apiRouteKey,
  apiSuccessStatuses,
} from './manifest';

export type LegacyApiRouteAllowlist = Record<string, string>;

export interface ApiRouteContractAuditReport {
  total: number;
  declared: number;
  legacy: number;
  errors: string[];
}

export function hasDeclaredApiContract(route: ApiRouteDecl): boolean {
  return (
    typeof route.operationId === 'string' &&
    route.operationId.length > 0 &&
    apiSuccessStatuses(route).length > 0 &&
    route.responses !== undefined
  );
}

export function auditApiRouteContracts(
  capabilities: CapabilityManifest[],
  legacyAllowlist: LegacyApiRouteAllowlist,
): ApiRouteContractAuditReport {
  const routes = capabilities.flatMap((capability) => capability.api?.routes ?? []);
  const routeKeys = new Set(routes.map(apiRouteKey));
  const errors: string[] = [];
  let declared = 0;

  for (const route of routes) {
    const key = apiRouteKey(route);
    if (hasDeclaredApiContract(route)) {
      declared += 1;
      if (legacyAllowlist[key] !== undefined) {
        errors.push(`stale legacy allowlist entry for declared route: ${key}`);
      }
      continue;
    }
    const reason = legacyAllowlist[key];
    if (typeof reason !== 'string' || reason.trim().length < 8) {
      errors.push(`undeclared route is missing an actionable legacy allowlist reason: ${key}`);
    }
  }

  for (const key of Object.keys(legacyAllowlist)) {
    if (!routeKeys.has(key)) errors.push(`legacy allowlist entry has no manifest route: ${key}`);
  }

  return {
    total: routes.length,
    declared,
    legacy: routes.length - declared,
    errors,
  };
}

export function assertApiRouteContractCoverage(
  capabilities: CapabilityManifest[],
  legacyAllowlist: LegacyApiRouteAllowlist,
): ApiRouteContractAuditReport {
  const report = auditApiRouteContracts(capabilities, legacyAllowlist);
  if (report.errors.length > 0) {
    throw new Error(`API route contract audit failed:\n- ${report.errors.join('\n- ')}`);
  }
  return report;
}
