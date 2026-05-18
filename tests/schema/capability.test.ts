import {
  CapabilityManifest,
  CapabilityRef,
  CapabilityRunRef,
  JudgeResultV2,
} from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';

describe('CapabilityManifest', () => {
  const validManifest = {
    id: 'exact',
    kind: 'judge',
    version: '1.0.0',
    input_schema: 'ExactJudgeInput',
    output_schema: 'JudgeResultV2',
    cost_class: 'local',
    latency_class: 'sync',
    stability: 'stable',
  };

  it('accepts a valid judge manifest', () => {
    const result = CapabilityManifest.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it('accepts manifest with optional replaced_by', () => {
    const result = CapabilityManifest.safeParse({
      ...validManifest,
      stability: 'deprecated',
      replaced_by: 'exact_v2',
    });
    expect(result.success).toBe(true);
  });

  it('accepts renderer kind', () => {
    const result = CapabilityManifest.safeParse({
      ...validManifest,
      id: 'katex',
      kind: 'renderer',
    });
    expect(result.success).toBe(true);
  });

  it('accepts scheduler kind', () => {
    const result = CapabilityManifest.safeParse({
      ...validManifest,
      id: 'fsrs',
      kind: 'scheduler',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown kind', () => {
    expect(CapabilityManifest.safeParse({ ...validManifest, kind: 'parser' }).success).toBe(false);
  });

  it('rejects unknown cost_class', () => {
    expect(CapabilityManifest.safeParse({ ...validManifest, cost_class: 'free' }).success).toBe(
      false,
    );
  });

  it('rejects missing version', () => {
    const { version: _, ...noVersion } = validManifest;
    expect(CapabilityManifest.safeParse(noVersion).success).toBe(false);
  });
});

describe('CapabilityRef', () => {
  it('accepts valid ref', () => {
    const result = CapabilityRef.safeParse({ id: 'semantic', version: '1.4.1' });
    expect(result.success).toBe(true);
  });

  it('rejects empty id', () => {
    expect(CapabilityRef.safeParse({ id: '', version: '1.0.0' }).success).toBe(false);
  });
});

describe('CapabilityRunRef', () => {
  it('accepts full run ref with optional prompt/model fields', () => {
    const result = CapabilityRunRef.safeParse({
      capability: { id: 'semantic', version: '1.2.0' },
      input_schema_version: '1.0.0',
      output_schema_version: '1.0.0',
      config_hash: 'abc123',
      prompt_version: '2.1.0',
      model_ref: 'claude-sonnet-4-20250514',
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal run ref without prompt/model', () => {
    const result = CapabilityRunRef.safeParse({
      capability: { id: 'exact', version: '1.0.0' },
      input_schema_version: '1.0.0',
      output_schema_version: '1.0.0',
      config_hash: 'def456',
    });
    expect(result.success).toBe(true);
  });
});

describe('JudgeResultV2', () => {
  const baseResult = {
    score_meaning: 'correctness',
    confidence: 1,
    capability_ref: { id: 'exact', version: '1.0.0' },
    feedback_md: '反馈',
    evidence_json: {},
  };

  it('accepts semantically valid correct, partial, incorrect, and unsupported results', () => {
    expect(
      JudgeResultV2.safeParse({ ...baseResult, coarse_outcome: 'correct', score: 1 }).success,
    ).toBe(true);
    expect(
      JudgeResultV2.safeParse({ ...baseResult, coarse_outcome: 'partial', score: 0.5 }).success,
    ).toBe(true);
    expect(
      JudgeResultV2.safeParse({ ...baseResult, coarse_outcome: 'incorrect', score: 0 }).success,
    ).toBe(true);
    expect(
      JudgeResultV2.safeParse({
        ...baseResult,
        coarse_outcome: 'unsupported',
        score: null,
        confidence: 0,
      }).success,
    ).toBe(true);
  });

  it('rejects impossible outcome and score combinations', () => {
    expect(
      JudgeResultV2.safeParse({ ...baseResult, coarse_outcome: 'correct', score: 0 }).success,
    ).toBe(false);
    expect(
      JudgeResultV2.safeParse({ ...baseResult, coarse_outcome: 'partial', score: 0 }).success,
    ).toBe(false);
    expect(
      JudgeResultV2.safeParse({ ...baseResult, coarse_outcome: 'incorrect', score: 0.5 }).success,
    ).toBe(false);
    expect(
      JudgeResultV2.safeParse({ ...baseResult, coarse_outcome: 'unsupported', score: 0 }).success,
    ).toBe(false);
  });

  it('requires feedback for non-correct outcomes', () => {
    expect(
      JudgeResultV2.safeParse({
        ...baseResult,
        coarse_outcome: 'incorrect',
        score: 0,
        feedback_md: '',
      }).success,
    ).toBe(false);
    expect(
      JudgeResultV2.safeParse({
        ...baseResult,
        coarse_outcome: 'unsupported',
        score: null,
        confidence: 0,
        feedback_md: '',
      }).success,
    ).toBe(false);
  });
});
