import { exactJudgeCapability } from '@/core/capability/judges/exact';
import { keywordJudgeCapability } from '@/core/capability/judges/keyword';
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

describe('keywordJudgeCapability', () => {
  it('has a valid manifest', () => {
    const manifest = keywordJudgeCapability.manifest;
    expect(manifest.id).toBe('keyword');
    expect(manifest.kind).toBe('judge');
    expect(manifest.cost_class).toBe('local');
    expect(manifest.stability).toBe('stable');
  });

  it('returns correct when all keywords hit', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['虚词', '代词'] },
      answer: { content: '虚词是一种代词' },
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
    expect(result.score_meaning).toBe('correctness');
    expect(result.capability_ref.id).toBe('keyword');
    expect(JudgeResultV2.safeParse(result).success).toBe(true);
  });

  it('returns partial for some keyword hits', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['虚词', '代词', '连词'] },
      answer: { content: '虚词分析' },
    });
    expect(result.coarse_outcome).toBe('partial');
    expect(result.score).toBeCloseTo(1 / 3);
  });

  it('returns incorrect for zero hits', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['虚词'] },
      answer: { content: '完全无关' },
    });
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
  });

  it('returns correct at 85% threshold', () => {
    const result = keywordJudgeCapability.run({
      question: { keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      answer: { content: 'a b c d e f missing_last' },
    });
    expect(result.coarse_outcome).toBe('correct');
  });

  it('throws on missing keywords', () => {
    expect(() =>
      keywordJudgeCapability.run({
        question: {},
        answer: { content: 'abc' },
      }),
    ).toThrow(/keywords/);
  });
});
