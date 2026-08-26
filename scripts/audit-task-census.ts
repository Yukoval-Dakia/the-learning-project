import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForbiddenTaskCatalogPatterns } from './lib/task-census-guards';
import {
  type RegistrationEvidence,
  type RunLogContractEvidence,
  collectRegistrationEvidence,
  hasCapabilityJobRegistrationPath,
  inspectRunLogContract,
} from './lib/task-census-infrastructure';
import {
  type CallerEvidence,
  type UnresolvedCaller,
  scanTaskCallers,
} from './lib/task-census-source';

export type AuditResult = {
  readonly ok: boolean;
  readonly catalogCount: number;
  readonly discoveredKinds: readonly string[];
  readonly callersByKind: Readonly<Record<string, readonly CallerEvidence[]>>;
  readonly unresolvedCallers: readonly UnresolvedCaller[];
  readonly unknownCallers: readonly CallerEvidence[];
  readonly nonLiveClassifications: Readonly<Record<string, string>>;
  readonly orphanKinds: readonly string[];
  readonly registrationEvidence: readonly RegistrationEvidence[];
  readonly runLogContract: RunLogContractEvidence;
  readonly profileCriticCaller: CallerEvidence | null;
  readonly errors: readonly string[];
};

export type AuditTaskCensusOptions = {
  readonly catalogKinds: readonly string[];
  readonly sourceRoot: string;
  readonly nonLiveClassifications?: Readonly<Record<string, string>>;
  readonly validateInfrastructure?: boolean;
};

export const LIVE_NON_CALLER_CLASSIFICATIONS = {
  AttributionTask:
    'Retained as a registered compatibility task while production failure attribution invokes AttributionRerankTask after deterministic candidate retrieval.',
} as const;

export function auditTaskCensus(options: AuditTaskCensusOptions): AuditResult {
  const { callersByKind, unresolvedCallers } = scanTaskCallers(options.sourceRoot);
  const catalogSet = new Set(options.catalogKinds);
  const nonLiveClassifications = options.nonLiveClassifications ?? {};
  const validateInfrastructure = options.validateInfrastructure ?? true;
  const discoveredKinds = Object.keys(callersByKind).sort();
  const unknownCallers = discoveredKinds
    .filter((kind) => !catalogSet.has(kind))
    .flatMap((kind) => callersByKind[kind] ?? []);
  const orphanKinds = [...catalogSet]
    .filter(
      (kind) => callersByKind[kind] === undefined && nonLiveClassifications[kind] === undefined,
    )
    .sort();
  const invalidClassifications = Object.keys(nonLiveClassifications)
    .filter((kind) => !catalogSet.has(kind))
    .sort();
  const staleClassifications = Object.keys(nonLiveClassifications)
    .filter((kind) => callersByKind[kind] !== undefined)
    .sort();
  const unjustifiedClassifications = Object.entries(nonLiveClassifications)
    .filter(([, reason]) => reason.trim().length === 0)
    .map(([kind]) => kind)
    .sort();
  const registrationEvidence = validateInfrastructure
    ? collectRegistrationEvidence(options.sourceRoot, callersByKind)
    : [];
  const runLogContract = validateInfrastructure
    ? inspectRunLogContract(options.sourceRoot)
    : {
        schemaTaskKindColumn: true,
        runnerCatalogGuard: true,
        lifecycleTaskKind: true,
        startWriterTaskKind: true,
      };
  const profileCriticCallers = callersByKind.ProfileCriticTask ?? [];
  const profileCriticCaller =
    profileCriticCallers.find(
      (caller) => caller.file === 'scripts/compile-profile.ts' && caller.callee === 'runAgentTask',
    ) ?? null;
  const forbiddenPatterns = validateInfrastructure
    ? scanForbiddenTaskCatalogPatterns(options.sourceRoot)
    : [];
  const runLogFailures = Object.entries(runLogContract)
    .filter(([, present]) => !present)
    .map(([contract]) => `Run-log contract missing: ${contract}`);
  const manifestRegistrationEvidence = registrationEvidence.filter(
    (item) => item.registration === 'manifest-job',
  );
  const legacyRegistrationEvidence = registrationEvidence.filter(
    (item) => item.registration === 'legacy-handler',
  );
  const errors = [
    ...(validateInfrastructure && catalogSet.size !== 53
      ? [`Task catalog must contain exactly 53 kinds, received ${catalogSet.size}`]
      : []),
    ...unresolvedCallers.map(
      (caller) =>
        `Unresolved task kind at ${caller.file}:${caller.line}:${caller.column} (${caller.callee}(${caller.expression}, ...))`,
    ),
    ...unknownCallers.map(
      (caller) =>
        `Unknown task kind "${caller.kind}" at ${caller.file}:${caller.line}:${caller.column}`,
    ),
    ...orphanKinds.map((kind) => `Catalog task "${kind}" has no production caller`),
    ...invalidClassifications.map(
      (kind) => `Non-live classification "${kind}" is not present in the catalog`,
    ),
    ...staleClassifications.map(
      (kind) => `Non-live classification "${kind}" is stale because production callers exist`,
    ),
    ...unjustifiedClassifications.map(
      (kind) => `Non-live classification "${kind}" requires a non-empty reason`,
    ),
    ...(validateInfrastructure && !hasCapabilityJobRegistrationPath(options.sourceRoot)
      ? ['Capability job registration path is unresolved']
      : []),
    ...(validateInfrastructure && manifestRegistrationEvidence.length === 0
      ? ['No registered manifest job reaches a recognized task invocation']
      : []),
    // YUK-868 — the transitional "at least one legacy handler reaches a task
    // invocation" assertion is retired: the verify handlers (quiz_verify /
    // source_verify / variant_verify — the last task-invoking central
    // registrations) are now Practice-owned manifest jobs. handlers.ts still
    // mounts non-task housekeeping handlers; the legacy scanner stays live and
    // legacyRegistrationEvidence is still reported, it is just no longer
    // REQUIRED to be non-empty.
    ...runLogFailures,
    ...(validateInfrastructure && profileCriticCaller === null
      ? ['ProfileCriticTask must have its exact CLI caller in scripts/compile-profile.ts']
      : []),
    ...forbiddenPatterns.map(
      (violation) =>
        `Forbidden task catalog pattern at ${violation.file}:${violation.line}:${violation.column}: ${violation.reason}`,
    ),
  ];

  return {
    ok: errors.length === 0,
    catalogCount: catalogSet.size,
    discoveredKinds,
    callersByKind,
    unresolvedCallers,
    unknownCallers,
    nonLiveClassifications,
    orphanKinds,
    registrationEvidence,
    runLogContract,
    profileCriticCaller,
    errors,
  };
}

async function runCli(): Promise<void> {
  const { taskCatalog } = await import('../src/ai/task-catalog.js');
  const result = auditTaskCensus({
    catalogKinds: Object.keys(taskCatalog),
    sourceRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    nonLiveClassifications: LIVE_NON_CALLER_CLASSIFICATIONS,
  });
  if (!result.ok) {
    console.error('Task census audit failed:');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exitCode = 1;
  } else {
    const callerCount = Object.values(result.callersByKind).reduce(
      (count, callers) => count + callers.length,
      0,
    );
    const manifestEvidenceCount = result.registrationEvidence.filter(
      (item) => item.registration === 'manifest-job',
    ).length;
    const legacyEvidenceCount = result.registrationEvidence.filter(
      (item) => item.registration === 'legacy-handler',
    ).length;
    console.log(
      `Task census audit passed: ${result.catalogCount} registered kinds, ${result.discoveredKinds.length} statically invoked kinds, ${Object.keys(result.nonLiveClassifications).length} compatibility kinds, ${callerCount} production call sites, ${manifestEvidenceCount} manifest-job reachability links, ${legacyEvidenceCount} legacy-handler reachability links`,
    );
    console.log(
      '  - run-log contract: ai_task_runs.task_kind -> catalog guard -> TaskKind lifecycle -> start writer',
    );
    for (const [kind, reason] of Object.entries(result.nonLiveClassifications)) {
      console.log(`  - ${kind}: ${reason}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli();
}
