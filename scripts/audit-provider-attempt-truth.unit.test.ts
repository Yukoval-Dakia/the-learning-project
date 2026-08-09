import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderLaneAuditResult } from './audit-provider-lanes';

const laneAuditMocks = vi.hoisted(() => ({
  auditProviderLanes: vi.fn<(projectRoot: string) => ProviderLaneAuditResult>(),
}));

vi.mock('./audit-provider-lanes', () => ({
  auditProviderLanes: laneAuditMocks.auditProviderLanes,
}));
import {
  PROVIDER_ATTEMPT_TRUTH_PATHS,
  type ProviderAttemptTruthSource,
  collectProviderAttemptTruthViolations,
  runProviderAttemptTruthAudit,
} from './audit-provider-attempt-truth';

const compliantSources = (): ProviderAttemptTruthSource[] =>
  PROVIDER_ATTEMPT_TRUTH_PATHS.map((path) => ({
    path,
    content:
      path === 'src/server/ai/embed.ts'
        ? 'executeDirectProviderAttempt dashscope.embedding'
        : path === 'src/server/memory/reconcile-llm.ts'
          ? 'executeDirectProviderAttempt glm.memory-reconcile'
          : path === 'src/capabilities/knowledge/server/edge-reconcile.ts'
            ? 'executeDirectProviderAttempt glm.knowledge-edge-reconcile'
            : path === 'src/capabilities/ingestion/server/provider-attempts.ts'
              ? 'executeDirectProviderAttempt glm.ocr-layout-parsing tencent.question-mark-agent'
              : path === 'src/server/ai/opaque-provider-operation.ts'
                ? 'createProviderAttemptLifecycle mem0.event-memory'
                : 'export {}',
  }));

describe('provider attempt truth audit', () => {
  beforeEach(() => {
    laneAuditMocks.auditProviderLanes.mockReset().mockReturnValue({
      ok: true,
      findings: [],
      violations: [],
    });
  });

  it('accepts migrated wrappers without legacy accounting', () => {
    expect(collectProviderAttemptTruthViolations(compliantSources())).toEqual([]);
  });

  it('detects imported helper indirection and direct zero accounting', () => {
    const sources = compliantSources().map((source) =>
      source.path === 'src/server/memory/triggers.ts'
        ? {
            ...source,
            content:
              "import { writeCostLedger as persistSpend } from '@/server/ai/log';\npersistSpend({ cost: 0 });",
          }
        : source,
    );
    expect(collectProviderAttemptTruthViolations(sources)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'legacy-cost-write' }),
        expect.objectContaining({ rule: 'zero-cost-accounting' }),
      ]),
    );
  });

  it('detects a closed production surface leaving its attempt wrapper', () => {
    const sources = compliantSources().map((source) =>
      source.path === 'src/server/ai/embed.ts' ? { ...source, content: 'fetch(url)' } : source,
    );
    expect(collectProviderAttemptTruthViolations(sources)).toContainEqual({
      path: 'src/server/ai/embed.ts',
      rule: 'missing-attempt-wrapper',
      detail: 'missing executeDirectProviderAttempt',
    });
  });

  it('delegates repository wire discovery and maps scanner violations', () => {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    laneAuditMocks.auditProviderLanes.mockReturnValue({
      ok: false,
      findings: [],
      violations: [
        {
          path: 'src/capabilities/example/server/provider.ts',
          reason: 'unlisted direct provider wire: unclassified-provider-fetch',
        },
      ],
    });

    expect(runProviderAttemptTruthAudit(projectRoot)).toContainEqual({
      path: 'src/capabilities/example/server/provider.ts',
      rule: 'provider-lane-drift',
      detail: 'unlisted direct provider wire: unclassified-provider-fetch',
    });
    expect(laneAuditMocks.auditProviderLanes).toHaveBeenCalledOnce();
    expect(laneAuditMocks.auditProviderLanes).toHaveBeenCalledWith(projectRoot);
  });
});
