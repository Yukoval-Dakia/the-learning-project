import { CapabilityRegistry } from '@/core/capability/registry';
import type { JudgeCapabilityRunner } from '@/core/capability/types';
import type { CapabilityManifestT } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';

function makeStubJudge(id: string, version = '1.0.0'): JudgeCapabilityRunner {
  const manifest: CapabilityManifestT = {
    id,
    kind: 'judge',
    version,
    input_schema: 'StubInput',
    output_schema: 'JudgeResultV2',
    cost_class: 'local',
    latency_class: 'sync',
    stability: 'stable',
  };
  return {
    manifest,
    run: () => ({
      score: 1,
      score_meaning: 'correctness',
      coarse_outcome: 'correct',
      confidence: 1,
      capability_ref: { id, version },
      feedback_md: 'stub',
      evidence_json: {},
    }),
  };
}

describe('CapabilityRegistry', () => {
  it('registers and resolves a judge capability', () => {
    const registry = new CapabilityRegistry();
    const judge = makeStubJudge('exact');
    registry.registerJudge(judge);

    const resolved = registry.resolveJudge('exact');
    expect(resolved).toBeDefined();
    expect(resolved?.manifest.id).toBe('exact');
  });

  it('returns undefined for unregistered capability', () => {
    const registry = new CapabilityRegistry();
    expect(registry.resolveJudge('nonexistent')).toBeUndefined();
  });

  it('lists all registered judge manifests', () => {
    const registry = new CapabilityRegistry();
    registry.registerJudge(makeStubJudge('exact'));
    registry.registerJudge(makeStubJudge('keyword'));

    const manifests = registry.listJudges();
    expect(manifests).toHaveLength(2);
    expect(manifests.map((m) => m.id).sort()).toEqual(['exact', 'keyword']);
  });

  it('throws on duplicate judge registration', () => {
    const registry = new CapabilityRegistry();
    registry.registerJudge(makeStubJudge('exact'));
    expect(() => registry.registerJudge(makeStubJudge('exact'))).toThrow(/already registered/);
  });

  it('hasJudge returns true for registered, false for missing', () => {
    const registry = new CapabilityRegistry();
    registry.registerJudge(makeStubJudge('exact'));
    expect(registry.hasJudge('exact')).toBe(true);
    expect(registry.hasJudge('semantic')).toBe(false);
  });
});
