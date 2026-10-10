import { describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import { runMultimodalDirectJudge } from './multimodal-direct-judge';
import type { JudgeQuestionRow } from './question-contract';

// runMultimodalDirectJudge is pure-logic once runTaskFn + imageFetchFn are
// stubbed. A throwaway cast suffices — the function only passes db to the stubs.
const mockDb = {} as Db;
const physicsProfile = resolveSubjectProfile('physics');

function makeRow(opts: {
  prompt_md?: string;
  reference_md?: string | null;
  image_refs?: string[];
  metadata?: Record<string, unknown> | null;
}): JudgeQuestionRow {
  return {
    id: 'q-mm',
    kind: 'calculation',
    prompt_md: opts.prompt_md ?? '看图求物块所受合力大小',
    reference_md: opts.reference_md === undefined ? '5 N' : opts.reference_md,
    rubric_json: null,
    choices_md: null,
    judge_kind_override: null,
    image_refs: opts.image_refs ?? ['prompt-figure-1'],
    metadata: opts.metadata ?? null,
  };
}

function llmResponse(
  coarse: 'correct' | 'partial' | 'incorrect',
  score: number,
  extra?: Partial<{ observed_md: string; matched_points: string[]; missing_points: string[] }>,
  probeSignatureMatch?: {
    match: 'gold' | 'target_error' | 'neither' | 'ambiguous';
    explanation_md: string;
  },
) {
  return {
    text: JSON.stringify({
      coarse_outcome: coarse,
      score,
      feedback_md: `feedback for ${coarse}`,
      evidence: {
        observed_md: extra?.observed_md ?? '学生作答内容',
        matched_points: extra?.matched_points ?? [],
        missing_points: extra?.missing_points ?? [],
      },
      confidence: 0.8,
      ...(probeSignatureMatch ? { probe_signature_match: probeSignatureMatch } : {}),
    }),
  };
}

describe('runMultimodalDirectJudge — score composition / clamping', () => {
  it('correct outcome → score clamped into [0.85, 1]', async () => {
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '5 N',
      subjectProfile: physicsProfile,
      runTaskFn: async () => llmResponse('correct', 0.7), // below 0.85 → clamped up
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(0.85);
    expect(result.score_meaning).toBe('correctness');
    expect(result.capability_ref).toEqual({ id: 'multimodal_direct', version: '1.0.0' });
  });

  it('correct outcome with max in-range score stays ≤ 1', async () => {
    // The LLM output schema constrains score to [0, 1], so the compose clamp's
    // upper Math.min(1, ...) bound is exercised with the in-range maximum.
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '5 N',
      subjectProfile: physicsProfile,
      runTaskFn: async () => llmResponse('correct', 1),
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect(result.score).toBe(1);
  });

  it('partial outcome → score clamped into [0.01, 0.84]', async () => {
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '4 N',
      subjectProfile: physicsProfile,
      runTaskFn: async () => llmResponse('partial', 0.99), // above 0.84 → clamped down
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect(result.coarse_outcome).toBe('partial');
    expect(result.score).toBe(0.84);
  });

  it('partial outcome with zero score clamped up to 0.01', async () => {
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '4 N',
      subjectProfile: physicsProfile,
      runTaskFn: async () => llmResponse('partial', 0),
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect(result.score).toBe(0.01);
  });

  it('incorrect outcome → score exactly 0', async () => {
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '100 N',
      subjectProfile: physicsProfile,
      runTaskFn: async () => llmResponse('incorrect', 0.5), // ignored, forced to 0
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
  });
});
