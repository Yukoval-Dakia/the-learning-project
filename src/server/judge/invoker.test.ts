import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import type { JudgeQuestionRow } from '@/server/ai/judges/question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it, vi } from 'vitest';
import { type JudgeInvocationTelemetry, JudgeInvoker, JudgeInvokerOutputSchema } from './invoker';

const mockDb = {} as Db;
const wenyanProfile = resolveSubjectProfile('wenyan');
const mathProfile = resolveSubjectProfile('math');
const physicsProfile = resolveSubjectProfile('physics');

const baseQuestion: JudgeQuestionRow = {
  id: 'q-base',
  kind: 'short_answer',
  prompt_md: '题目',
  reference_md: '答案',
  rubric_json: null,
  choices_md: null,
  judge_kind_override: null,
};

describe('JudgeInvoker', () => {
  it('dispatches exact route through the registry and emits telemetry', async () => {
    const telemetry: JudgeInvocationTelemetry[] = [];
    const invoker = new JudgeInvoker({
      onTelemetry: (event) => {
        telemetry.push(event);
      },
    });

    const result = await invoker.invoke({
      db: mockDb,
      question: {
        ...baseQuestion,
        id: 'q-exact',
        kind: 'choice',
        choices_md: ['答案', '错'],
      },
      answer_md: '答案',
      subjectProfile: wenyanProfile,
    });

    expect(result.route).toBe('exact');
    expect(result.result.coarse_outcome).toBe('correct');
    expect(result.telemetry).toMatchObject({
      route: 'exact',
      coarse_outcome: 'correct',
      confidence: 1,
      question_id: 'q-exact',
      subject_id: 'wenyan',
    });
    expect(result.telemetry.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(telemetry).toEqual([result.telemetry]);
    expect(JudgeInvokerOutputSchema.safeParse(result).success).toBe(true);
  });

  // D6 (U4 L-stamp, critic-R2 HIGH) — capability_ref.version must be pinned from
  // SubjectProfile.version, NOT the judge runner's module-level '1.0.0' constant.
  // The real wenyan/math/physics profiles are all on '1.0.0', so a same-value
  // assertion would pass silently even on the OLD path. Force a '2.0.0' profile
  // to prove the read path actually switched — and assert BOTH sides: the
  // result.capability_ref (embedded into the review event payload at
  // submit/route.ts:306) AND the telemetry (attribution / analytics path).
  it('pins capability_ref.version + telemetry.profile_version from SubjectProfile.version (both sides)', async () => {
    const v2Profile = { ...wenyanProfile, version: '2.0.0' };
    const telemetry: JudgeInvocationTelemetry[] = [];
    const invoker = new JudgeInvoker({
      onTelemetry: (event) => {
        telemetry.push(event);
      },
    });

    const result = await invoker.invoke({
      db: mockDb,
      question: {
        ...baseQuestion,
        id: 'q-exact-v2',
        kind: 'choice',
        choices_md: ['答案', '错'],
      },
      answer_md: '答案',
      subjectProfile: v2Profile,
    });

    // capability id still comes from the runner (exact), version re-sourced.
    expect(result.result.capability_ref).toEqual({ id: 'exact', version: '2.0.0' });
    expect(result.telemetry.capability_ref).toEqual({ id: 'exact', version: '2.0.0' });
    expect(result.telemetry.profile_version).toBe('2.0.0');
    expect(telemetry[0]?.profile_version).toBe('2.0.0');
  });

  it('dispatches semantic route with the injected task runner', async () => {
    const runTaskFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        score: 0.92,
        coarse_outcome: 'correct',
        confidence: 0.81,
        feedback_md: '要点完整。',
        evidence_json: { matched_points: ['p1'], missing_points: [] },
      }),
    });
    const invoker = new JudgeInvoker({ runTaskFn });

    const result = await invoker.invoke({
      db: mockDb,
      question: {
        ...baseQuestion,
        id: 'q-semantic',
        judge_kind_override: 'semantic',
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: 'core' }],
          required_points: ['p1'],
        },
      },
      answer_md: '覆盖 p1',
      subjectProfile: wenyanProfile,
    });

    expect(result.route).toBe('semantic');
    expect(result.result.coarse_outcome).toBe('correct');
    expect(result.telemetry).toMatchObject({
      route: 'semantic',
      capability_ref: { id: 'semantic', version: '1.0.0' },
      coarse_outcome: 'correct',
      confidence: 0.81,
    });
    expect(runTaskFn).toHaveBeenCalledWith(
      'SemanticJudgeTask',
      expect.objectContaining({ answer: { content: '覆盖 p1' } }),
      expect.objectContaining({ db: mockDb, subjectProfile: wenyanProfile }),
    );
  });

  // YUK-212 + YUK-484(B) critic §6b — the C1 leak proof at the INVOKER layer.
  // part_ref must narrow `question.structured` (NOT only prompt_md) before the
  // semantic judge sees it: semanticInput() ships question.structured into the
  // task input verbatim, so a whole-row structured leaks every sibling sub. The
  // captured runTaskFn input's `structured` field is asserted to be the narrowed
  // subtree (p1 present, p2 ABSENT).
  it('part_ref narrows question.structured before the semantic judge (C1 proof)', async () => {
    const runTaskFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        score: 0.9,
        coarse_outcome: 'correct',
        confidence: 0.8,
        feedback_md: 'ok',
        evidence_json: { matched_points: [], missing_points: [] },
      }),
    });
    const invoker = new JudgeInvoker({ runTaskFn });

    const composite: JudgeQuestionRow = {
      ...baseQuestion,
      id: 'q-composite',
      judge_kind_override: 'semantic',
      prompt_md: '阅读下文。\n\n1. 第一问\n\n2. 第二问',
      reference_md: 'A\n\nB',
      structured: {
        id: 'stem',
        role: 'stem',
        prompt_text: '阅读下文。',
        sub_questions: [
          { id: 'p1', role: 'sub', prompt_text: '第一问', answers: ['A'] },
          { id: 'p2', role: 'sub', prompt_text: '第二问', answers: ['B'] },
        ],
      },
    };

    await invoker.invoke({
      db: mockDb,
      question: composite,
      answer_md: '我的答案',
      subjectProfile: wenyanProfile,
      part_ref: 'p1',
    });

    // The semantic task input carries question.structured verbatim — assert the
    // STRUCTURED subtree (not just prompt_md) is narrowed to p1 with p2 dropped.
    const [, taskInput] = runTaskFn.mock.calls[0];
    const passedQuestion = (taskInput as { question: { structured: StructuredQuestionT } })
      .question;
    const passedSubIds = (passedQuestion.structured.sub_questions ?? []).map((s) => s.id);
    expect(passedSubIds).toContain('p1');
    expect(passedSubIds).not.toContain('p2');
    // prompt_md is narrowed too (passage + p1, not p2).
    expect((taskInput as { question: { prompt_md: string } }).question.prompt_md).not.toContain(
      '第二问',
    );
  });

  it('part_ref absent → whole-row structured reaches the semantic judge (back-compat)', async () => {
    const runTaskFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        score: 0.9,
        coarse_outcome: 'correct',
        confidence: 0.8,
        feedback_md: 'ok',
        evidence_json: { matched_points: [], missing_points: [] },
      }),
    });
    const invoker = new JudgeInvoker({ runTaskFn });

    const composite: JudgeQuestionRow = {
      ...baseQuestion,
      id: 'q-composite-whole',
      judge_kind_override: 'semantic',
      structured: {
        id: 'stem',
        role: 'stem',
        prompt_text: '阅读下文。',
        sub_questions: [
          { id: 'p1', role: 'sub', prompt_text: '第一问', answers: ['A'] },
          { id: 'p2', role: 'sub', prompt_text: '第二问', answers: ['B'] },
        ],
      },
    };

    await invoker.invoke({
      db: mockDb,
      question: composite,
      answer_md: '我的答案',
      subjectProfile: wenyanProfile,
      // no part_ref → whole-row.
    });

    const [, taskInput] = runTaskFn.mock.calls[0];
    const passedQuestion = (taskInput as { question: { structured: StructuredQuestionT } })
      .question;
    const passedSubIds = (passedQuestion.structured.sub_questions ?? []).map((s) => s.id);
    // Whole-row: BOTH subs reach the judge.
    expect(passedSubIds).toContain('p1');
    expect(passedSubIds).toContain('p2');
  });

  it('reports semantic provider failures as unsupported telemetry', async () => {
    const result = await new JudgeInvoker({
      runTaskFn: vi.fn().mockRejectedValue(new Error('provider down')),
    }).invoke({
      db: mockDb,
      question: { ...baseQuestion, id: 'q-semantic-fail', judge_kind_override: 'semantic' },
      answer_md: '答案',
      subjectProfile: wenyanProfile,
    });

    expect(result.route).toBe('semantic');
    expect(result.result.coarse_outcome).toBe('unsupported');
    expect(result.result.score).toBeNull();
    expect(result.telemetry).toMatchObject({
      route: 'semantic',
      coarse_outcome: 'unsupported',
      confidence: 0,
      question_id: 'q-semantic-fail',
    });
  });

  it('dispatches steps route through the server runner', async () => {
    const runTaskFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        extracted_steps: [{ idx: 0, content: 'x=1', verdict: 'correct', comment: 'ok' }],
        extracted_final_answer: '1',
        signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: 'ok' }],
        final_answer_match: true,
        final_answer_comment: '推导正确。',
        confidence: 0.88,
      }),
    });

    const result = await new JudgeInvoker({ runTaskFn }).invoke({
      db: mockDb,
      question: {
        ...baseQuestion,
        id: 'q-steps',
        kind: 'derivation',
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: 'steps' }],
          reference_solution: {
            expected_signals: ['列出 x=1'],
            final_answer: '1',
            answer_equivalents: [],
          },
        },
      },
      answer_md: 'x=1，所以答案是 1',
      subjectProfile: mathProfile,
    });

    expect(result.route).toBe('steps');
    expect(result.result.coarse_outcome).toBe('correct');
    expect(result.telemetry).toMatchObject({
      route: 'steps',
      capability_ref: { id: 'steps', version: '1.0.0' },
      confidence: 0.88,
    });
    expect(runTaskFn).toHaveBeenCalledWith(
      'StepsJudgeTask',
      expect.objectContaining({ images: [] }),
      expect.objectContaining({ db: mockDb, subjectProfile: mathProfile }),
    );
  });

  it('dispatches unit_dimension with db and subject profile context', async () => {
    const runTaskFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        student_value_si: 30,
        student_unit_si: 'm/s',
        equivalent_to_reference: true,
        parser_confidence: 0.95,
      }),
    });

    const result = await new JudgeInvoker({ runTaskFn }).invoke({
      db: mockDb,
      question: {
        ...baseQuestion,
        id: 'q-unit',
        kind: 'calculation',
        prompt_md: '速度是多少？',
        reference_md: '30 m/s',
        metadata: { reference_value: 30, reference_unit: 'm/s' },
      },
      answer_md: '三十米每秒',
      subjectProfile: physicsProfile,
    });

    expect(result.route).toBe('unit_dimension');
    expect(result.result.coarse_outcome).toBe('correct');
    expect(result.telemetry).toMatchObject({
      route: 'unit_dimension',
      capability_ref: { id: 'unit_dimension', version: '1.0.0' },
      coarse_outcome: 'correct',
    });
    expect(runTaskFn).toHaveBeenCalledWith(
      'UnitDimensionFallback',
      expect.objectContaining({ text: expect.stringContaining('三十米每秒') }),
      expect.objectContaining({ db: mockDb, subjectProfile: physicsProfile }),
    );
  });

  it('dispatches multimodal_direct route through the server runner', async () => {
    const runTaskFn = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        coarse_outcome: 'correct',
        score: 0.9,
        feedback_md: '看图作答正确。',
        evidence: {
          observed_md: '图中受力分析完整。',
          matched_points: ['受力图', '合力方向'],
          missing_points: [],
        },
        confidence: 0.86,
      }),
    });

    // judge_kind_override forces the multimodal_direct route (mirrors the
    // semantic/steps override pattern). No image_refs ⇒ the runner never calls
    // defaultImageFetch (R2/DB); a non-empty answer_md keeps it past the
    // no-input guard so the route truly dispatches into runMultimodalDirectJudge.
    const result = await new JudgeInvoker({ runTaskFn }).invoke({
      db: mockDb,
      question: {
        ...baseQuestion,
        id: 'q-mm-direct',
        kind: 'short_answer',
        prompt_md: '看图描述受力',
        reference_md: null,
        judge_kind_override: 'multimodal_direct',
      },
      answer_md: '受力如图所示，合力向右。',
      subjectProfile: physicsProfile,
    });

    expect(result.route).toBe('multimodal_direct');
    // Proves the dispatch reached runMultimodalDirectJudge (NOT the
    // RUNNABLE_ROUTES/registry unsupported fallback): a real verdict, not unsupported.
    expect(result.result.coarse_outcome).toBe('correct');
    expect(result.telemetry).toMatchObject({
      route: 'multimodal_direct',
      capability_ref: { id: 'multimodal_direct', version: '1.0.0' },
      coarse_outcome: 'correct',
      confidence: 0.86,
    });
    expect(runTaskFn).toHaveBeenCalledWith(
      'MultimodalDirectJudgeTask',
      expect.objectContaining({ images: [] }),
      expect.objectContaining({ db: mockDb, subjectProfile: physicsProfile }),
    );
  });
});
