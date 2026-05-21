import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { type JudgeQuestionRow, judgeAnswer } from './question-contract';

// judgeAnswer for exact / keyword routes is pure (no DB / no LLM), so a
// throwaway cast suffices for the Db param — none of the runnable routes
// touch it.
const mockDb = {} as Db;

const wenyanProfile = resolveSubjectProfile('wenyan');

describe('M-1 regression: runnable routes ignore multimodal fields', () => {
  const baseChoice: JudgeQuestionRow = {
    id: 'q1',
    kind: 'choice',
    prompt_md: 'Pick A or B',
    reference_md: 'A',
    rubric_json: null,
    choices_md: ['A', 'B'],
    judge_kind_override: null,
  };

  it('exact judge with image_refs returns same verdict as without', async () => {
    const r1 = await judgeAnswer({
      db: mockDb,
      question: baseChoice,
      answer_md: 'A',
      subjectProfile: wenyanProfile,
    });
    const r2 = await judgeAnswer({
      db: mockDb,
      question: { ...baseChoice, image_refs: ['asset_1', 'asset_2'] },
      answer_md: 'A',
      subjectProfile: wenyanProfile,
    });
    expect(r1.route).toBe('exact');
    expect(r2.route).toBe('exact');
    expect(r1.result.coarse_outcome).toBe(r2.result.coarse_outcome);
    expect(r1.result.score).toBe(r2.result.score);
  });

  it('exact judge with figures returns same verdict as without (incorrect path)', async () => {
    const r1 = await judgeAnswer({
      db: mockDb,
      question: baseChoice,
      answer_md: 'B',
      subjectProfile: wenyanProfile,
    });
    const r2 = await judgeAnswer({
      db: mockDb,
      question: {
        ...baseChoice,
        figures: [
          {
            asset_id: 'asset_1',
            role: 'diagram' as const,
            source_page_index: 0,
            source_bbox: { x: 0, y: 0, width: 0.1, height: 0.1 },
            attached_to_index: 'stem',
            attach_confidence: 'high' as const,
          },
        ],
      },
      answer_md: 'B',
      subjectProfile: wenyanProfile,
    });
    expect(r1.route).toBe('exact');
    expect(r2.route).toBe('exact');
    expect(r1.result.coarse_outcome).toBe(r2.result.coarse_outcome);
    expect(r1.result.score).toBe(r2.result.score);
  });

  it('keyword judge with structured set returns same verdict as without', async () => {
    const baseKeyword: JudgeQuestionRow = {
      id: 'q2',
      kind: 'fill_blank',
      prompt_md: 'Translate the term',
      reference_md: null,
      // Rubric requires a `criteria` array; empty is allowed.
      rubric_json: { criteria: [], keywords: ['hello'] },
      choices_md: null,
      judge_kind_override: null,
    };
    const r1 = await judgeAnswer({
      db: mockDb,
      question: baseKeyword,
      answer_md: 'hello world',
      subjectProfile: wenyanProfile,
    });
    const r2 = await judgeAnswer({
      db: mockDb,
      question: {
        ...baseKeyword,
        structured: {
          id: 'q2-stem',
          role: 'standalone',
          prompt_text: 'Translate the term',
        },
        image_refs: ['asset_x'],
      },
      answer_md: 'hello world',
      subjectProfile: wenyanProfile,
    });
    expect(r1.route).toBe('keyword');
    expect(r2.route).toBe('keyword');
    expect(r1.result.coarse_outcome).toBe(r2.result.coarse_outcome);
    expect(r1.result.score).toBe(r2.result.score);
  });
});
