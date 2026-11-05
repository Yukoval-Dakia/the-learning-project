import {
  type ApiRouteDecl,
  type CapabilityManifest,
  apiRouteKey,
  apiSuccessStatuses,
} from './manifest';

export interface ApiRouteContractAuditReport {
  total: number;
  declared: number;
  /** Routes with no declared contract; every one is an error. */
  undeclared: number;
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
): ApiRouteContractAuditReport {
  const routes = capabilities.flatMap((capability) => capability.api?.routes ?? []);
  const errors: string[] = [];
  let declared = 0;

  for (const route of routes) {
    if (hasDeclaredApiContract(route)) {
      declared += 1;
      continue;
    }
    errors.push(`route has no declared contract: ${apiRouteKey(route)}`);
  }

  return {
    total: routes.length,
    declared,
    undeclared: routes.length - declared,
    errors,
  };
}

export function assertApiRouteContractCoverage(
  capabilities: CapabilityManifest[],
): ApiRouteContractAuditReport {
  const report = auditApiRouteContracts(capabilities);
  if (report.errors.length > 0) {
    throw new Error(`API route contract audit failed:\n- ${report.errors.join('\n- ')}`);
  }
  return report;
}
