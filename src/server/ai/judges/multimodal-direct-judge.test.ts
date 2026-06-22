import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  };
}

function llmResponse(
  coarse: 'correct' | 'partial' | 'incorrect',
  score: number,
  extra?: Partial<{ observed_md: string; matched_points: string[]; missing_points: string[] }>,
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

  it('threads observed_md + matched/missing + image counts into evidence_json', async () => {
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({ image_refs: ['prompt-figure-1'] }),
      answer_md: '4 N',
      student_image_refs: ['student-photo-1'],
      subjectProfile: physicsProfile,
      runTaskFn: async () =>
        llmResponse('partial', 0.5, {
          observed_md: '图中两个分力 3N 和 4N',
          matched_points: ['识别分力'],
          missing_points: ['矢量合成'],
        }),
      imageFetchFn: async (assetIds) =>
        assetIds.map(() => ({ data: 'AAA', mediaType: 'image/png' })),
    });
    expect(result.evidence_json).toMatchObject({
      observed_md: '图中两个分力 3N 和 4N',
      matched_points: ['识别分力'],
      missing_points: ['矢量合成'],
      prompt_image_count: 1,
      student_image_count: 1,
    });
  });
});

describe('runMultimodalDirectJudge — image concat order', () => {
  it('passes prompt figures first, then student answer photos', async () => {
    const calls: string[][] = [];
    let taskInput: unknown;
    const imageFetchFn = vi.fn(async (assetIds: string[]) => {
      calls.push(assetIds);
      // Tag each image's data by asset id so we can assert ordering.
      return assetIds.map((id) => ({ data: id, mediaType: 'image/png' }));
    });
    await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({ image_refs: ['prompt-figure-1'] }),
      answer_md: '学生作答',
      student_image_refs: ['student-photo-1', 'student-photo-2'],
      subjectProfile: physicsProfile,
      runTaskFn: async (_kind, input) => {
        taskInput = input;
        return llmResponse('correct', 0.9);
      },
      imageFetchFn,
    });
    // imageFetchFn is called prompt-channel first, then student-channel.
    expect(calls).toEqual([['prompt-figure-1'], ['student-photo-1', 'student-photo-2']]);
    const multimodal = taskInput as {
      text: string;
      images: Array<{ data: string; mediaType: string }>;
    };
    // images concatenated: prompt first, then student, in order.
    expect(multimodal.images.map((i) => i.data)).toEqual([
      'prompt-figure-1',
      'student-photo-1',
      'student-photo-2',
    ]);
    expect(multimodal.text).toContain('"prompt_image_refs":["prompt-figure-1"]');
    expect(multimodal.text).toContain('"student_image_refs":["student-photo-1","student-photo-2"]');
  });

  it('dispatches the MultimodalDirectJudgeTask kind', async () => {
    let kind = '';
    await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '5 N',
      subjectProfile: physicsProfile,
      runTaskFn: async (k) => {
        kind = k;
        return llmResponse('correct', 0.9);
      },
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect(kind).toBe('MultimodalDirectJudgeTask');
  });
});

describe('runMultimodalDirectJudge — manifest / payload parse', () => {
  it('sends image_present=true when images resolved', async () => {
    let taskInput: unknown;
    await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({ image_refs: ['prompt-figure-1'] }),
      answer_md: '',
      subjectProfile: physicsProfile,
      runTaskFn: async (_k, input) => {
        taskInput = input;
        return llmResponse('correct', 0.9);
      },
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    const payload = JSON.parse((taskInput as { text: string }).text);
    expect(payload.image_present).toBe(true);
    expect(payload.reference_md).toBe('5 N');
  });

  it('passes reference_md as null when question has no reference', async () => {
    let taskInput: unknown;
    await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({ reference_md: null }),
      answer_md: '',
      subjectProfile: physicsProfile,
      runTaskFn: async (_k, input) => {
        taskInput = input;
        return llmResponse('partial', 0.5);
      },
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    const payload = JSON.parse((taskInput as { text: string }).text);
    expect(payload.reference_md).toBeNull();
  });
});

describe('runMultimodalDirectJudge — vision-judge provider override (YUK-482)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes override.provider into ctx when VISION_JUDGE_PROVIDER is set (+ token)', async () => {
    vi.stubEnv('VISION_JUDGE_PROVIDER', 'anthropic-sub');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'tok-123');
    let ctx: unknown;
    await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '5 N',
      subjectProfile: physicsProfile,
      runTaskFn: async (_kind, _input, c) => {
        ctx = c;
        return llmResponse('correct', 0.9);
      },
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect((ctx as { override?: { provider?: string } }).override).toEqual({
      provider: 'anthropic-sub',
      model: undefined,
    });
  });

  it('leaves ctx.override undefined when VISION_JUDGE_PROVIDER is unset', async () => {
    vi.stubEnv('VISION_JUDGE_PROVIDER', '');
    let ctx: unknown;
    await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '5 N',
      subjectProfile: physicsProfile,
      runTaskFn: async (_kind, _input, c) => {
        ctx = c;
        return llmResponse('correct', 0.9);
      },
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect((ctx as { override?: unknown }).override).toBeUndefined();
  });
});

describe('runMultimodalDirectJudge — unsupported / error paths', () => {
  it('returns unsupported when there are no images and no answer text', async () => {
    const runTaskFn = vi.fn();
    const imageFetchFn = vi.fn();
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({ image_refs: [] }),
      answer_md: '   ',
      subjectProfile: physicsProfile,
      runTaskFn,
      imageFetchFn,
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.feedback_md).toContain('no images and no answer text');
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(imageFetchFn).not.toHaveBeenCalled();
  });

  it('returns unsupported when LLM output is non-JSON (parse fail)', async () => {
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '5 N',
      subjectProfile: physicsProfile,
      runTaskFn: async () => ({ text: 'no json here' }),
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('did not match MultimodalDirectLlmOutput schema');
    expect((result.evidence_json as { error?: string }).error).toContain(
      'did not contain a JSON object',
    );
  });

  it('returns unsupported when LLM output fails schema validation', async () => {
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '5 N',
      subjectProfile: physicsProfile,
      runTaskFn: async () => ({
        text: JSON.stringify({ coarse_outcome: 'bogus', score: 2, feedback_md: '', confidence: 5 }),
      }),
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('did not match MultimodalDirectLlmOutput schema');
  });

  it('returns unsupported when imageFetchFn throws', async () => {
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({ image_refs: ['prompt-figure-1'] }),
      answer_md: '5 N',
      subjectProfile: physicsProfile,
      runTaskFn: async () => llmResponse('correct', 0.9),
      imageFetchFn: async () => {
        throw new Error('R2 unavailable');
      },
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('image fetch failed');
    expect((result.evidence_json as { error?: string }).error).toContain('R2 unavailable');
  });

  it('returns unsupported when LLM call throws', async () => {
    const result = await runMultimodalDirectJudge({
      db: mockDb,
      question: makeRow({}),
      answer_md: '5 N',
      subjectProfile: physicsProfile,
      runTaskFn: async () => {
        throw new Error('LLM down');
      },
      imageFetchFn: async () => [{ data: 'AAA', mediaType: 'image/png' }],
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('LLM call failed');
  });
});
