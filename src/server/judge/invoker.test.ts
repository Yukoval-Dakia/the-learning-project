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
