import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import {
  type JudgeQuestionRow,
  judgeAnswer,
  resolveQuestionJudgeRoute,
  runSemanticJudge,
} from './question-contract';

// judgeAnswer for exact / keyword routes is pure (no DB / no LLM), so a
// throwaway cast suffices for the Db param — none of the runnable routes
// touch it.
const mockDb = {} as Db;

const yuwenProfile = resolveSubjectProfile('yuwen');

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
      subjectProfile: yuwenProfile,
    });
    const r2 = await judgeAnswer({
      db: mockDb,
      question: { ...baseChoice, image_refs: ['asset_1', 'asset_2'] },
      answer_md: 'A',
      subjectProfile: yuwenProfile,
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
      subjectProfile: yuwenProfile,
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
      subjectProfile: yuwenProfile,
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
      subjectProfile: yuwenProfile,
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
      subjectProfile: yuwenProfile,
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

describe('YUK-759: SemanticJudgeTask structured-output migration', () => {
  const complexQuestion: JudgeQuestionRow = {
    id: 'q-yw-baorenanshu-argument',
    kind: 'short_answer',
    prompt_md:
      '结合《报任安书》中“人固有一死，或重于泰山，或轻于鸿毛”及作者受宫刑后的选择，说明司马迁为何把完成《史记》置于个人荣辱之上。答案必须区分价值判断、行动选择与作品目的。',
    reference_md:
      '司马迁以死亡价值取决于所为何事为判断前提；他选择忍辱存活以完成《史记》；其目的在于究天人之际、通古今之变、成一家之言，使个人苦难转化为具有公共意义的历史书写。',
    rubric_json: {
      criteria: [
        { name: '价值判断', weight: 0.3, descriptor: '说明死有轻重，价值取决于所为何事' },
        { name: '行动选择', weight: 0.3, descriptor: '说明忍辱存活是完成著述的主动选择' },
        { name: '作品目的', weight: 0.4, descriptor: '说明《史记》的历史认识与公共意义' },
      ],
      required_points: [
        '死亡价值取决于所为何事，而非死亡本身',
        '忍辱存活是为了完成《史记》的主动选择',
        '著述追求究天人之际、通古今之变、成一家之言',
      ],
      acceptable_answers: ['以著述的公共意义超越个人受辱'],
    },
    choices_md: null,
    judge_kind_override: 'semantic',
  };

  const structuredPartial = {
    score: 0.64,
    coarse_outcome: 'partial' as const,
    confidence: 0.91,
    feedback_md: '已说明忍辱著书与公共意义，但没有交代“死有轻重”的价值判断前提。',
    evidence_json: {
      matched_points: [
        '忍辱存活是为了完成《史记》的主动选择',
        '著述追求究天人之际、通古今之变、成一家之言',
      ],
      missing_points: ['死亡价值取决于所为何事，而非死亡本身'],
      notes: '没有把引文中的比较标准落实到论证起点。',
    },
  };

  const invalidStructured = {
    ...structuredPartial,
    score: 1.4,
    coarse_outcome: 'mostly-correct',
    confidence: 4,
  };

  it('threads json_schema and prefers a schema-valid structured value over conflicting text', async () => {
    let capturedCtx: unknown;
    const result = await runSemanticJudge({
      db: mockDb,
      question: complexQuestion,
      answer_md:
        '司马迁忍受屈辱，是为了把《史记》写完。他希望这部书能贯通古今、形成自己的历史解释，因此个人荣辱不能压倒著述的公共价值。',
      subjectProfile: yuwenProfile,
      runTaskFn: async (_kind, _input, ctx) => {
        capturedCtx = ctx;
        return {
          text: JSON.stringify({
            score: 0,
            coarse_outcome: 'incorrect',
            confidence: 0.2,
            feedback_md: 'conflicting raw text must not win',
            evidence_json: { matched_points: [], missing_points: ['all'] },
          }),
          structured_output: structuredPartial,
        };
      },
    });

    const outputFormat = (
      capturedCtx as { outputFormat?: { type?: string; schema?: Record<string, unknown> } }
    ).outputFormat;
    expect(outputFormat?.type).toBe('json_schema');
    expect(outputFormat?.schema).toMatchObject({
      type: 'object',
      properties: { score: expect.any(Object), coarse_outcome: expect.any(Object) },
    });
    expect(result).toMatchObject({
      coarse_outcome: 'partial',
      score: 0.64,
      confidence: 0.91,
      feedback_md: structuredPartial.feedback_md,
      evidence_json: structuredPartial.evidence_json,
    });
  });

  it('does not fall back to valid raw text when a present structured value violates schema', async () => {
    const validRaw = {
      ...structuredPartial,
      score: 0.96,
      coarse_outcome: 'correct' as const,
      feedback_md: 'raw text would incorrectly hide a structured protocol failure',
      evidence_json: { matched_points: ['all'], missing_points: [] },
    };
    const result = await runSemanticJudge({
      db: mockDb,
      question: complexQuestion,
      answer_md: '完整作答',
      subjectProfile: yuwenProfile,
      runTaskFn: async () => ({
        text: JSON.stringify(validRaw),
        structured_output: invalidStructured,
      }),
    });

    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.feedback_md).toContain('semantic judge output unsupported');
    expect(result.evidence_json).toMatchObject({
      validation_error: expect.any(Array),
      raw_text: JSON.stringify(invalidStructured),
    });
  });

  it('keeps the null/absent Mimo text fallback byte-equivalent to structured dispatch', async () => {
    const complete = {
      score: 0.96,
      coarse_outcome: 'correct' as const,
      confidence: 0.87,
      feedback_md: '三层论证完整，且把引文作为价值判断前提。',
      evidence_json: {
        matched_points: [
          '死亡价值取决于所为何事，而非死亡本身',
          '忍辱存活是为了完成《史记》的主动选择',
          '著述追求究天人之际、通古今之变、成一家之言',
        ],
        missing_points: [],
      },
    };
    const base = {
      db: mockDb,
      question: complexQuestion,
      answer_md:
        '“重于泰山”先提出死亡应由所为何事衡量。司马迁因此没有为一时荣辱赴死，而是主动忍辱完成《史记》，以究天人、通古今、成一家之言，让个人苦难服务于公共历史书写。',
      subjectProfile: yuwenProfile,
    };
    const structured = await runSemanticJudge({
      ...base,
      runTaskFn: async () => ({ text: 'ignored', structured_output: complete }),
    });
    const textFallback = await runSemanticJudge({
      ...base,
      runTaskFn: async () => ({
        text: `mimo preface\n${JSON.stringify(complete)}\nend`,
        structured_output: null,
      }),
    });

    expect(textFallback).toEqual(structured);
  });
});

describe('YUK-36 regression: unit_dimension LLM fallback uses registered task with runtime ctx', () => {
  it('passes UnitDimensionFallback through judgeAnswer with subjectProfile and no public db', async () => {
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
      subjectProfile: { id: 'physics' },
      outputFormat: { type: 'json_schema', schema: expect.any(Object) },
    });
    expect(captured[0].ctx).not.toHaveProperty('db');
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

  it('routes derivation to semantic for yuwen profile (no steps in preferredRoutes)', async () => {
    const { resolveQuestionJudgeRoute } = await import('./question-contract');
    const route = resolveQuestionJudgeRoute(
      {
        id: 'q-d2',
        kind: 'derivation',
        prompt_md: 'derivation in yuwen context',
        reference_md: 'ref',
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
      },
      yuwenProfile,
    );
    // yuwen profile preferredRoutes does NOT include 'steps' — falls back to semantic
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
      // even yuwen (which does NOT prefer it) honors an explicit override
      yuwenProfile,
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
  it('yuwen choice → exact (unchanged)', () => {
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
        yuwenProfile,
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

  it('yuwen short_answer → semantic (unchanged)', () => {
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
        yuwenProfile,
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
      subjectProfile: yuwenProfile,
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
      subjectProfile: yuwenProfile,
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
      subjectProfile: yuwenProfile,
    });
    expect(r.route).toBe('exact');
    expect(r.result.coarse_outcome).toBe('correct');
  });
});
