import { describe, expect, it } from 'vitest';
import type { CollectedSignal } from './candidate-signals';
import { sampleByWeight } from './selection-sampler';
import { statisticalWeights } from './softmax-selection';

function signal(refId: string, mfiScore?: number, diagnosticScore?: number): CollectedSignal {
  return {
    refKind: 'question',
    refId,
    role: 'diagnostic',
    bSource: 'item_calibration',
    mfiScore,
    diagnosticScore,
  };
}

function weightFor(candidates: CollectedSignal[], refId: string): number {
  const candidate = statisticalWeights(candidates).find((item) => item.refId === refId);
  if (!candidate) throw new Error(`weighted candidate ${refId} missing`);
  return candidate.weight;
}

describe('statisticalWeights candidate isolation', () => {
  it('keeps a shared candidate bit-identical across production batch membership and order', () => {
    const a = signal('A', 0.1875, 0.09375);
    const b = signal('B', 0.04, 0.02);
    const c = signal('C', undefined, 0.125);

    const solo = weightFor([a], 'A');
    const inPair = weightFor([a, b], 'A');
    const inReorderedTriple = weightFor([c, a, b], 'A');

    expect(Object.is(inPair, solo)).toBe(true);
    expect(Object.is(inReorderedTriple, solo)).toBe(true);
  });

  it('prefers uncertainty-penalized diagnostic score over raw MFI', () => {
    expect(weightFor([signal('diagnostic-first', 0.2, 0.08)], 'diagnostic-first')).toBe(0.08);
  });

  it('keeps a prompt-omitted candidate in the full statistical sampling pool', () => {
    const candidates = Array.from({ length: 25 }, (_, index) =>
      signal(`candidate-${index.toString().padStart(2, '0')}`, 0.2, index === 24 ? 0.01 : 0.1),
    );
    const weighted = statisticalWeights(candidates);
    const sampled = sampleByWeight(weighted, {
      temperature: 0.25,
      targetCount: 25,
      rng: () => 0,
    });

    expect(weighted).toHaveLength(25);
    expect(sampled.map((candidate) => candidate.refId)).toContain('candidate-24');
    expect(
      sampled.find((candidate) => candidate.refId === 'candidate-24')?.inclusionProbability,
    ).toBe(1);
  });

  it('downweights a difficulty-proxy anchor while preserving the positivity floor', () => {
    const proxy = signal('proxy', 0.2, 0.1);
    proxy.bSource = 'difficulty_proxy';
    const emptyProxy = signal('empty-proxy');
    emptyProxy.bSource = 'difficulty_proxy';

    expect(weightFor([proxy], 'proxy')).toBeCloseTo(0.03);
    expect(weightFor([emptyProxy], 'empty-proxy')).toBeGreaterThan(0);
  });
});
