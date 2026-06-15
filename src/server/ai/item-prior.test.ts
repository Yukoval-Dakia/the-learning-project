import { describe, expect, it } from 'vitest';

import { parseItemPriorOutput } from './item-prior';

describe('parseItemPriorOutput', () => {
  it('parses a well-formed ItemPriorDraft JSON', () => {
    const draft = parseItemPriorOutput(
      '{"b_logit": 1.2, "confidence": 0.4, "reasoning": "三步推理 + 两个前置概念"}',
    );
    expect(draft.b_logit).toBeCloseTo(1.2, 10);
    expect(draft.confidence).toBeCloseTo(0.4, 10);
    expect(draft.reasoning).toContain('三步推理');
  });

  it('brace-slices surrounding prose / code fences', () => {
    const draft = parseItemPriorOutput(
      'Here is the estimate:\n```json\n{"b_logit": -0.5, "confidence": 0.6, "reasoning": "客观题答案空间受限"}\n```\nDone.',
    );
    expect(draft.b_logit).toBeCloseTo(-0.5, 10);
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseItemPriorOutput('no json here')).toThrow(/no JSON object/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseItemPriorOutput('{"b_logit": 1.0, "confidence":}')).toThrow(/JSON.parse/);
  });

  it('throws on schema mismatch (missing reasoning)', () => {
    expect(() => parseItemPriorOutput('{"b_logit": 1.0, "confidence": 0.5}')).toThrow(
      /schema invalid/,
    );
  });

  it('throws when confidence is out of [0,1]', () => {
    expect(() =>
      parseItemPriorOutput('{"b_logit": 1.0, "confidence": 1.5, "reasoning": "x"}'),
    ).toThrow(/schema invalid/);
  });
});
