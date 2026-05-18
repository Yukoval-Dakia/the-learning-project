import { exactJudgeCapability } from '@/core/capability/judges/exact';
import { JudgeResultV2 } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';

describe('exactJudgeCapability', () => {
  it('has a valid manifest', () => {
    const manifest = exactJudgeCapability.manifest;
    expect(manifest.id).toBe('exact');
    expect(manifest.kind).toBe('judge');
    expect(manifest.cost_class).toBe('local');
    expect(manifest.latency_class).toBe('sync');
    expect(manifest.stability).toBe('stable');
  });

  it('returns correct for exact match', () => {
    const result = exactJudgeCapability.run({
      question: { reference: '虚词' },
      answer: { content: '虚词' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
    expect(result.score_meaning).toBe('correctness');
    expect(result.confidence).toBe(1);
    expect(result.capability_ref.id).toBe('exact');
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });

  it('returns incorrect for non-match', () => {
    const result = exactJudgeCapability.run({
      question: { reference: '虚词' },
      answer: { content: '实词' },
    });
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
  });

  it('is case-insensitive', () => {
    const result = exactJudgeCapability.run({
      question: { reference: 'ABC' },
      answer: { content: 'abc' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
  });

  it('trims whitespace', () => {
    const result = exactJudgeCapability.run({
      question: { reference: '虚词' },
      answer: { content: '  虚词  ' },
    });
    expect(result.coarse_outcome).toBe('correct');
  });

  it('throws on missing reference', () => {
    expect(() =>
      exactJudgeCapability.run({
        question: {},
        answer: { content: 'abc' },
      }),
    ).toThrow(/reference/);
  });
});
