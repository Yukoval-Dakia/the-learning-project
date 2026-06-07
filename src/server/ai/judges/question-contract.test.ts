import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { type JudgeQuestionRow, judgeAnswer, resolveQuestionJudgeRoute } from './question-contract';

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

describe('M1 §C: semanticInput threads subjectProfile into LLM payload', () => {
  it('SemanticJudgeTask receives subject_profile and multimodal carriers', async () => {
    const captured: { kind: string; input: unknown; ctx: unknown }[] = [];
    const runTaskFn = async (kind: string, input: unknown, ctx: unknown) => {
      captured.push({ kind, input, ctx });
      return {
        text: JSON.stringify({
          score: 0.9,
          coarse_outcome: 'correct',
          confidence: 0.9,
          feedback_md: 'ok',
          evidence_json: { matched_points: ['p1'], missing_points: [] },
        }),
      };
    };

    const mathProfile = resolveSubjectProfile('math');
    const row: JudgeQuestionRow = {
      id: 'q-m1c',
      kind: 'short_answer',
      prompt_md: 'Why?',
      reference_md: 'Because.',
      rubric_json: { required_points: ['p1'] },
      choices_md: null,
      judge_kind_override: 'semantic',
      figures: [],
      image_refs: ['asset_42'],
      structured: null,
    };

    await judgeAnswer({
      db: mockDb,
      question: row,
      answer_md: 'Because of p1.',
      subjectProfile: mathProfile,
      runTaskFn,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe('SemanticJudgeTask');
    const semanticPayload = (captured[0].input as { question: Record<string, unknown> }).question;
    expect(semanticPayload.subject_profile).toMatchObject({
      id: 'math',
      display_name: expect.any(String),
    });
    expect(semanticPayload.image_refs).toEqual(['asset_42']);
    expect(semanticPayload.figures).toEqual([]);
    expect(semanticPayload.structured).toBeNull();
  });
});

describe('YUK-36 regression: unit_dimension LLM fallback uses registered task with runtime ctx', () => {
  it('passes UnitDimensionFallback through judgeAnswer with db + subjectProfile ctx', async () => {
    const captured: { kind: string; input: unknown; ctx: unknown }[] = [];
    const runTaskFn = async (kind: string, input: unknown, ctx: unknown) => {
      captured.push({ kind, input, ctx });
      return {
        text: JSON.stringify({
          student_value_si: 30,
          student_unit_si: 'm/s',
          equivalent_to_reference: true,
          parser_confidence: 0.95,
        }),
      };
    };
    const physicsProfile = resolveSubjectProfile('physics');
    const result = await judgeAnswer({
      db: mockDb,
      question: {
        id: 'q-unit-fallback',
        kind: 'calculation',
        prompt_md: '速度是多少？',
        reference_md: '30 m/s',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
        metadata: { reference_value: 30, reference_unit: 'm/s' },
      },
      answer_md: '三十米每秒',
      subjectProfile: physicsProfile,
      runTaskFn,
    });

    expect(result.route).toBe('unit_dimension');
    expect(result.result.coarse_outcome).toBe('correct');
    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe('UnitDimensionFallback');
    expect(captured[0].input).toMatchObject({
      text: expect.stringContaining('三十米每秒'),
    });
    expect(captured[0].ctx).toMatchObject({
      db: mockDb,
      subjectProfile: { id: 'physics' },
    });
  });
});

describe('M2.1: resolveQuestionJudgeRoute — derivation kind', () => {
  it('routes derivation to steps for math profile (preferredRoutes includes steps)', async () => {
    const { resolveQuestionJudgeRoute } = await import('./question-contract');
    const mathProfile = resolveSubjectProfile('math');
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-d1',
        kind: 'derivation',
        prompt_md: '求 ∫(2x+3)dx',
        reference_md: 'x² + 3x + C',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
      },
      mathProfile,
    );
    expect(route).toBe('steps');
  });

  it('routes derivation to semantic for wenyan profile (no steps in preferredRoutes)', async () => {
    const { resolveQuestionJudgeRoute } = await import('./question-contract');
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-d2',
        kind: 'derivation',
        prompt_md: 'derivation in wenyan context',
        reference_md: 'ref',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
      },
      wenyanProfile,
    );
    // wenyan profile preferredRoutes does NOT include 'steps' — falls back to semantic
    expect(route).toBe('semantic');
  });

  it('judgeAnswer routes derivation to steps; returns unsupported when rubric lacks reference_solution', async () => {
    // M2.2: 'steps' is now runnable. With no reference_solution in rubric,
    // runStepsJudge short-circuits to unsupported BEFORE any LLM call.
    const mathProfile = resolveSubjectProfile('math');
    const result = await judgeAnswer({
      db: mockDb,
      question: {
        id: 'q-d3',
        kind: 'derivation',
        prompt_md: '求导',
        reference_md: 'x',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
      },
      answer_md: '答案',
      subjectProfile: mathProfile,
    });
    expect(result.route).toBe('steps');
    expect(result.result.coarse_outcome).toBe('unsupported');
    expect(result.result.feedback_md).toContain('reference_solution missing');
  });
});

describe('YUK-201: resolveQuestionJudgeRoute — multimodal_direct routing + regression', () => {
  const mathProfile = resolveSubjectProfile('math');
  const physicsProfile = resolveSubjectProfile('physics');

  it('override → multimodal_direct (override branch fires first, any subject)', () => {
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-ov',
        kind: 'short_answer',
        prompt_md: 'anything',
        reference_md: 'ref',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: 'multimodal_direct',
      },
      // even wenyan (which does NOT prefer it) honors an explicit override
      wenyanProfile,
    );
    expect(route).toBe('multimodal_direct');
  });

  it('physics calc WITH figure + no reference_solution → gated auto-route to multimodal_direct', () => {
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-mm-auto',
        kind: 'short_answer', // non-choice, non-derivation; calc kind hits unit_dimension first
        prompt_md: '看图描述受力',
        reference_md: null,
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
        image_refs: ['fig-1'],
      },
      physicsProfile,
    );
    expect(route).toBe('multimodal_direct');
  });

  // Reverse of the gate's "figure present" half: same physics short_answer that
  // auto-routes WITH a figure must NOT gate to multimodal_direct when there is no
  // image (image_refs empty / absent). Proves the `(image_refs?.length ?? 0) > 0`
  // gate half is load-bearing — it falls through to the normal short_answer route
  // (physics prefers semantic). Complements the WITH-figure positive test above.
  it('physics short_answer WITHOUT figure does NOT gate to multimodal_direct (→ semantic)', () => {
    const routeEmpty = resolveQuestionJudgeRoute(
      {
        id: 'q-mm-noimg-empty',
        kind: 'short_answer',
        prompt_md: '描述受力',
        reference_md: null,
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
        image_refs: [], // explicitly empty
      },
      physicsProfile,
    );
    expect(routeEmpty).toBe('semantic');

    const routeMissing = resolveQuestionJudgeRoute(
      {
        id: 'q-mm-noimg-missing',
        kind: 'short_answer',
        prompt_md: '描述受力',
        reference_md: null,
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
        // image_refs omitted entirely
      },
      physicsProfile,
    );
    expect(routeMissing).toBe('semantic');
  });

  // Regression: physics CALC question keeps unit_dimension precedence even with a
  // figure — the unit_dimension branch is checked BEFORE the multimodal_direct
  // gate (§2 ordering).
  it('physics calculation WITH figure still routes unit_dimension (precedence preserved)', () => {
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-calc-fig',
        kind: 'calculation',
        prompt_md: '看图求合力',
        reference_md: '5 N',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
        image_refs: ['fig-1'],
      },
      physicsProfile,
    );
    expect(route).toBe('unit_dimension');
  });

  // Regression: a step-rubric reference_solution belongs to steps@1, never the
  // multimodal_direct gate — even on a profile that prefers multimodal_direct.
  it('question with reference_solution does NOT gate to multimodal_direct', () => {
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-ref-sol',
        kind: 'short_answer',
        prompt_md: '看图作答',
        reference_md: 'ref',
        rubric_json: {
          criteria: [],
          reference_solution: {
            expected_signals: ['s1'],
            final_answer: 'x',
            answer_equivalents: [],
          },
        },
        choices_md: null,
        judge_kind_override: null,
        image_refs: ['fig-1'],
      },
      physicsProfile,
    );
    // physics short_answer with semantic preferred → semantic (NOT multimodal_direct)
    expect(route).toBe('semantic');
  });

  // Regression: math does NOT prefer multimodal_direct → a math short_answer with
  // a figure routes exactly as before (semantic), no auto-route change.
  it('math short_answer WITH figure routes unchanged (semantic, no auto-route)', () => {
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-math-fig',
        kind: 'short_answer',
        prompt_md: '看图解释',
        reference_md: 'ref',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
        image_refs: ['fig-1'],
      },
      mathProfile,
    );
    expect(route).toBe('semantic');
  });

  // Regression suite: the established routes are UNCHANGED by this feature.
  it('wenyan choice → exact (unchanged)', () => {
    expect(
      resolveQuestionJudgeRoute(
        {
          id: 'q-c',
          kind: 'choice',
          prompt_md: 'pick',
          reference_md: 'A',
          rubric_json: null,
          choices_md: ['A', 'B'],
          judge_kind_override: null,
          image_refs: ['fig-1'], // figure present but choices short-circuit to exact
        },
        wenyanProfile,
      ),
    ).toBe('exact');
  });

  it('math derivation with rubric reference_solution → steps (unchanged)', () => {
    expect(
      resolveQuestionJudgeRoute(
        {
          id: 'q-deriv',
          kind: 'derivation',
          prompt_md: '化简',
          reference_md: 'a+b',
          rubric_json: {
            criteria: [],
            reference_solution: {
              expected_signals: ['平方差'],
              final_answer: 'a+b',
              answer_equivalents: [],
            },
          },
          choices_md: null,
          judge_kind_override: null,
          image_refs: ['fig-1'],
        },
        mathProfile,
      ),
    ).toBe('steps');
  });

  it('wenyan short_answer → semantic (unchanged)', () => {
    expect(
      resolveQuestionJudgeRoute(
        {
          id: 'q-sa',
          kind: 'short_answer',
          prompt_md: '解释',
          reference_md: 'ref',
          rubric_json: null,
          choices_md: null,
          judge_kind_override: null,
        },
        wenyanProfile,
      ),
    ).toBe('semantic');
  });

  it('physics calculation (unit_dimension, no figure) → unit_dimension (unchanged)', () => {
    expect(
      resolveQuestionJudgeRoute(
        {
          id: 'q-calc',
          kind: 'calculation',
          prompt_md: '求速度',
          reference_md: '30 m/s',
          rubric_json: null,
          choices_md: null,
          judge_kind_override: null,
        },
        physicsProfile,
      ),
    ).toBe('unit_dimension');
  });
});

describe('YUK-260: exact route forwards choices_md so letter↔text resolve', () => {
  const optionTextRef: JudgeQuestionRow = {
    id: 'q-choice',
    kind: 'choice',
    prompt_md: '下列哪项是宾语前置？',
    // reference stored as OPTION TEXT (the owner-observed broken case)
    reference_md: '宾语前置',
    rubric_json: null,
    choices_md: ['宾语前置', '主谓倒装', '定语后置', '状语后置'],
    judge_kind_override: null,
  };

  it('letter answer "A" against option-text reference → correct', async () => {
    const r = await judgeAnswer({
      db: mockDb,
      question: optionTextRef,
      answer_md: 'A',
      subjectProfile: wenyanProfile,
    });
    expect(r.route).toBe('exact');
    expect(r.result.coarse_outcome).toBe('correct');
    expect(r.result.score).toBe(1);
  });

  it('wrong letter "B" against option-text reference → incorrect', async () => {
    const r = await judgeAnswer({
      db: mockDb,
      question: optionTextRef,
      answer_md: 'B',
      subjectProfile: wenyanProfile,
    });
    expect(r.route).toBe('exact');
    expect(r.result.coarse_outcome).toBe('incorrect');
    expect(r.result.score).toBe(0);
  });

  it('multi-select reference "BC" matches out-of-order "C、B"', async () => {
    const multi: JudgeQuestionRow = {
      ...optionTextRef,
      reference_md: 'BC',
      choices_md: ['甲', '乙', '丙', '丁'],
    };
    const r = await judgeAnswer({
      db: mockDb,
      question: multi,
      answer_md: 'C、B',
      subjectProfile: wenyanProfile,
    });
    expect(r.route).toBe('exact');
    expect(r.result.coarse_outcome).toBe('correct');
  });
});
