import { describe, expect, it } from 'vitest';
import {
  MultimodalDirectInput,
  MultimodalDirectLlmOutput,
  multimodalDirectV1Capability,
} from './multimodal_direct';

describe('MultimodalDirectInput', () => {
  it('parses valid input with a reference', () => {
    const parsed = MultimodalDirectInput.parse({
      prompt_md: '看图求合力大小',
      reference_md: '5 N',
      image_present: true,
    });
    expect(parsed.prompt_md).toBe('看图求合力大小');
    expect(parsed.reference_md).toBe('5 N');
    expect(parsed.image_present).toBe(true);
  });

  it('accepts a null reference', () => {
    const parsed = MultimodalDirectInput.parse({
      prompt_md: '描述图中现象',
      reference_md: null,
      image_present: true,
    });
    expect(parsed.reference_md).toBeNull();
  });

  it('rejects empty prompt_md', () => {
    expect(() =>
      MultimodalDirectInput.parse({ prompt_md: '', reference_md: null, image_present: false }),
    ).toThrow();
  });
});

describe('MultimodalDirectLlmOutput', () => {
  it('parses well-formed LLM output', () => {
    const parsed = MultimodalDirectLlmOutput.parse({
      coarse_outcome: 'partial',
      score: 0.5,
      feedback_md: '部分正确',
      evidence: {
        observed_md: '学生写了 4 N',
        matched_points: ['识别两个分力'],
        missing_points: ['未做矢量合成'],
      },
      confidence: 0.8,
    });
    expect(parsed.coarse_outcome).toBe('partial');
    expect(parsed.evidence.matched_points).toEqual(['识别两个分力']);
  });

  it('defaults matched_points / missing_points to []', () => {
    const parsed = MultimodalDirectLlmOutput.parse({
      coarse_outcome: 'correct',
      score: 0.9,
      feedback_md: 'ok',
      evidence: { observed_md: 'x' },
      confidence: 0.9,
    });
    expect(parsed.evidence.matched_points).toEqual([]);
    expect(parsed.evidence.missing_points).toEqual([]);
  });

  it('rejects invalid coarse_outcome enum value', () => {
    expect(() =>
      MultimodalDirectLlmOutput.parse({
        coarse_outcome: 'unsupported',
        score: 0,
        feedback_md: 'x',
        evidence: { observed_md: '' },
        confidence: 0,
      }),
    ).toThrow();
  });

  it('rejects empty feedback_md', () => {
    expect(() =>
      MultimodalDirectLlmOutput.parse({
        coarse_outcome: 'correct',
        score: 1,
        feedback_md: '',
        evidence: { observed_md: '' },
        confidence: 1,
      }),
    ).toThrow();
  });
});

describe('multimodalDirectV1Capability manifest', () => {
  it('has expected identity + cost class', () => {
    expect(multimodalDirectV1Capability.manifest.id).toBe('multimodal_direct');
    expect(multimodalDirectV1Capability.manifest.version).toBe('1.0.0');
    expect(multimodalDirectV1Capability.manifest.kind).toBe('judge');
    expect(multimodalDirectV1Capability.manifest.cost_class).toBe('expensive_llm');
    expect(multimodalDirectV1Capability.manifest.latency_class).toBe('sync');
    expect(multimodalDirectV1Capability.manifest.stability).toBe('experimental');
  });

  it('run() returns unsupported server-runtime-required response', async () => {
    const result = await multimodalDirectV1Capability.run({
      question: { foo: 'bar' },
      answer: { content: 'student answer' },
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.score_meaning).toBe('correctness');
    expect(result.capability_ref).toEqual({ id: 'multimodal_direct', version: '1.0.0' });
    expect(result.feedback_md).toContain('JudgeInvoker');
    expect(result.evidence_json).toMatchObject({ reason: 'server_runtime_required' });
  });
});
