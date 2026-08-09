import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditProviderLanes } from './audit-provider-lanes';

export type ProviderAttemptTruthSource = {
  readonly path: string;
  readonly content: string;
};

export type ProviderAttemptTruthViolation = {
  readonly path: string;
  readonly rule:
    | 'legacy-cost-write'
    | 'missing-attempt-wrapper'
    | 'provider-lane-drift'
    | 'zero-cost-accounting';
  readonly detail: string;
};

const WRAPPER_SURFACES = [
  ['src/server/ai/embed.ts', ['executeDirectProviderAttempt', 'dashscope.embedding']],
  ['src/server/memory/reconcile-llm.ts', ['executeDirectProviderAttempt', 'glm.memory-reconcile']],
  [
    'src/capabilities/knowledge/server/edge-reconcile.ts',
    ['executeDirectProviderAttempt', 'glm.knowledge-edge-reconcile'],
  ],
  [
    'src/capabilities/ingestion/server/provider-attempts.ts',
    ['executeDirectProviderAttempt', 'glm.ocr-layout-parsing', 'tencent.question-mark-agent'],
  ],
  [
    'src/server/ai/opaque-provider-operation.ts',
    ['createProviderAttemptLifecycle', 'mem0.event-memory'],
  ],
] as const;

const MIGRATED_COST_SURFACES = [
  'src/server/memory/triggers.ts',
  'src/capabilities/knowledge/server/propose_edge.ts',
  'src/capabilities/ingestion/jobs/tencent_ocr_extract.ts',
  'src/capabilities/ingestion/server/provider-attempts.ts',
] as const;

export const PROVIDER_ATTEMPT_TRUTH_PATHS = [
  ...new Set([
    ...WRAPPER_SURFACES.map(([path]) => path),
    ...MIGRATED_COST_SURFACES,
    'src/server/ai/provider-attempt-runtime.ts',
  ]),
];

export function collectProviderAttemptTruthViolations(
  sources: readonly ProviderAttemptTruthSource[],
): ProviderAttemptTruthViolation[] {
  const byPath = new Map(sources.map((source) => [source.path, source.content]));
  const violations: ProviderAttemptTruthViolation[] = [];
  for (const [path, requiredTokens] of WRAPPER_SURFACES) {
    const content = byPath.get(path) ?? '';
    for (const token of requiredTokens) {
      if (!content.includes(token)) {
        violations.push({ path, rule: 'missing-attempt-wrapper', detail: `missing ${token}` });
      }
    }
  }
  for (const path of [...MIGRATED_COST_SURFACES, 'src/server/ai/provider-attempt-runtime.ts']) {
    const content = byPath.get(path) ?? '';
    for (const symbol of ['writeCostLedger', 'writeLegacyOcrCostLedger']) {
      if (content.includes(symbol)) {
        violations.push({ path, rule: 'legacy-cost-write', detail: `references ${symbol}` });
      }
    }
    if (/\bcost\s*:\s*0(?:\D|$)/u.test(content)) {
      violations.push({ path, rule: 'zero-cost-accounting', detail: 'contains direct cost: 0' });
    }
  }
  return violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.rule.localeCompare(right.rule) ||
      left.detail.localeCompare(right.detail),
  );
}

export function runProviderAttemptTruthAudit(root: string): ProviderAttemptTruthViolation[] {
  const migratedTruthViolations = collectProviderAttemptTruthViolations(
    PROVIDER_ATTEMPT_TRUTH_PATHS.map((path) => ({
      path,
      content: readFileSync(resolve(root, path), 'utf8'),
    })),
  );
  const laneViolations = auditProviderLanes(root).violations.map((violation) => ({
    path: violation.path,
    rule: 'provider-lane-drift' as const,
    detail: violation.reason,
  }));
  return [...migratedTruthViolations, ...laneViolations].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.rule.localeCompare(right.rule) ||
      left.detail.localeCompare(right.detail),
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 ? (args[rootIndex + 1] ?? '.') : '.';
  const violations = runProviderAttemptTruthAudit(root);
  if (json) {
    console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
  } else if (violations.length === 0) {
    console.log('provider-attempt truth audit: PASS');
  } else {
    for (const violation of violations) {
      console.error(`${violation.path}: ${violation.rule}: ${violation.detail}`);
    }
  }
  process.exitCode = violations.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
