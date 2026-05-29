/**
 * Tests for runWorkflowJudge — T-OC slice 3 deterministic confidence gate
 * (YUK-145, OC-4). Pure function, no DB / no LLM. See ADR-0026.
 */
import type { TaggingOutputT } from '@/core/schema/tagging';
import { describe, expect, it } from 'vitest';

import { runWorkflowJudge } from './workflow-judge';

function tagging(overall: number, ids: string[]): TaggingOutputT {
  return {
    overall_confidence: overall,
    reasoning: '',
    suggestions: ids.map((id) => ({ knowledge_id: id, confidence: overall, reasoning: '' })),
  };
}

describe('runWorkflowJudge', () => {
  it("routes 'auto' when combined confidence >= threshold with suggestions", () => {
    const result = runWorkflowJudge({
      extractionConfidence: 1,
      tagging: tagging(0.9, ['k1', 'k2']),
      threshold: 0.85,
    });
    expect(result.route).toBe('auto');
    expect(result.confidence).toBeCloseTo(0.9);
    expect(result.prefilled.knowledge_ids).toEqual(['k1', 'k2']);
    // unanswered = item/material, the safe signal (no fabricated attempt).
    expect(result.prefilled.outcome).toBe('unanswered');
  });

  it("routes 'review' when combined confidence < threshold", () => {
    const result = runWorkflowJudge({
      extractionConfidence: 1,
      tagging: tagging(0.5, ['k1']),
      threshold: 0.85,
    });
    expect(result.route).toBe('review');
    expect(result.confidence).toBeCloseTo(0.5);
  });

  it("routes 'review' when there are zero surviving suggestions, even at high confidence", () => {
    const result = runWorkflowJudge({
      extractionConfidence: 1,
      tagging: tagging(0.99, []),
      threshold: 0.85,
    });
    expect(result.route).toBe('review');
    expect(result.prefilled.knowledge_ids).toEqual([]);
  });

  it('uses the WEAKEST LINK: a shaky extraction confidence gates the route', () => {
    // Tagging is confident (0.95) but extraction is shaky (0.4) → combined 0.4.
    const result = runWorkflowJudge({
      extractionConfidence: 0.4,
      tagging: tagging(0.95, ['k1']),
      threshold: 0.85,
    });
    expect(result.confidence).toBeCloseTo(0.4);
    expect(result.route).toBe('review');
  });

  it('routes auto exactly at the threshold boundary', () => {
    const result = runWorkflowJudge({
      extractionConfidence: 0.85,
      tagging: tagging(0.85, ['k1']),
      threshold: 0.85,
    });
    expect(result.route).toBe('auto');
  });

  it('clamps non-finite / out-of-range inputs', () => {
    const result = runWorkflowJudge({
      extractionConfidence: Number.NaN,
      tagging: tagging(2, ['k1']),
      threshold: 0.85,
    });
    // NaN extraction clamps to 0 → combined 0 → review.
    expect(result.confidence).toBe(0);
    expect(result.route).toBe('review');
  });

  it('respects defaultDifficulty / defaultQuestionKind for the prefilled question', () => {
    const result = runWorkflowJudge({
      extractionConfidence: 1,
      tagging: tagging(0.9, ['k1']),
      threshold: 0.85,
      defaultDifficulty: 4,
      defaultQuestionKind: 'translation',
    });
    expect(result.prefilled.difficulty).toBe(4);
    expect(result.prefilled.question_kind).toBe('translation');
  });
});
