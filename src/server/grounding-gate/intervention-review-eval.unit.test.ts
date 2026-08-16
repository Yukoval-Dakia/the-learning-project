import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewInterventionPackageCandidate } from '@/capabilities/practice/server/intervention-author';
import {
  INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION,
  buildInterventionPackageReviewTaskInput,
  buildInterventionQuestionContentValidationTaskInput,
} from '@/core/schema/intervention';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { AgentRunError } from '@/server/ai/agent-run-error';
import { taskPromptFingerprint } from '@/server/ai/provenance';
import regressionFixture from '@/server/grounding-gate/fixtures/intervention-review-regressions.v1.json' with {
  type: 'json',
};
import {
  InterventionReviewRegressionPacket,
  collectTaskRunProvenance,
  runInterventionReviewActualOutputEval,
} from '@/server/grounding-gate/intervention-review-eval';
import { resolveSubjectProfile } from '@/subjects/profile';

vi.mock('@/capabilities/practice/server/intervention-author', () => ({
  reviewInterventionPackageCandidate: vi.fn(),
}));

describe('intervention reviewer actual-output regression fixture', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins complex false-pass regressions and true-pass controls', () => {
    const packet = InterventionReviewRegressionPacket.parse(regressionFixture);
    expect(sha256CanonicalJson(packet)).toBe(
      'e6ec4d84a37a3756f23b785ea6da03d0c49d5752769a91d5de4d98afaaadc508',
    );
    expect(
      packet.cases.map((fixture) => ({
        case_id: fixture.case_id,
        expected_verdict: fixture.expected_verdict,
        expected_failure_codes: fixture.expected_failure_codes,
      })),
    ).toEqual([
      {
        case_id: 'area-vs-length-and-scope',
        expected_verdict: 'fail',
        expected_failure_codes: ['reference_incorrect', 'claim_scope_expansion'],
      },
      {
        case_id: 'yuwen-fabricated-counterexamples',
        expected_verdict: 'fail',
        expected_failure_codes: ['reference_incorrect'],
      },
      {
        case_id: 'causal-baseline-selection-not-reverse-causation',
        expected_verdict: 'fail',
        expected_failure_codes: ['reference_incorrect'],
      },
      {
        case_id: 'math-valid-negative-distribution-transfer',
        expected_verdict: 'pass',
        expected_failure_codes: [],
      },
      {
        case_id: 'yuwen-valid-direction-counterexamples',
        expected_verdict: 'pass',
        expected_failure_codes: [],
      },
      {
        case_id: 'causal-valid-same-outcome-reverse-causation',
        expected_verdict: 'pass',
        expected_failure_codes: [],
      },
    ]);

    const [area, yuwen, causal, validMath, validYuwen, validCausal] = packet.cases;
    expect(area?.context.snapshot.conjecture.diagnostic_spec.scope_boundary_md).toContain(
      '多项式相乘',
    );
    expect(area?.package.diagnostics.transfer.probe_spec.prompt_md).toContain('面积');
    expect(area?.package.diagnostics.transfer.probe_spec.reference_md).toContain('-5w + 20');

    expect(yuwen?.package.diagnostics.immediate.probe_spec.prompt_md).toContain('卜算子·咏梅');
    expect(yuwen?.package.diagnostics.delayed.probe_spec.prompt_md).toContain('送元二使安西');

    expect(causal?.package.diagnostics.delayed.probe_spec.prompt_md).toContain('成绩提高幅度');
    expect(causal?.package.diagnostics.delayed.probe_spec.reference_md).toContain(
      '成绩较差的学生可能被家长送去补习',
    );

    expect(validMath?.package.diagnostics.transfer.probe_spec.prompt_md).toContain(
      '温度相对初始值的变化量',
    );
    expect(validMath?.package.diagnostics.transfer.probe_spec.reference_md).toContain(
      '(-5)×(-4)=+20',
    );
    expect(validMath?.package.diagnostics.transfer.context_change_md).toContain(
      '没有引入面积、多项式相乘',
    );
    expect(validMath?.package.diagnostics.immediate.probe_spec).toMatchObject({
      prompt_md: expect.stringContaining('-4(z - 7)'),
      reference_md: '-4z + 28',
      expected_target_error_answer_md: '-4z - 28',
    });
    expect(validMath?.package.material.body_md).not.toContain('-4(z - 7)');

    expect(validYuwen?.package.material.body_md).toContain('盲评');
    expect(validYuwen?.package.diagnostics.immediate.probe_spec.prompt_md).toContain(
      '校园辩论训练',
    );
    expect(validYuwen?.package.diagnostics.delayed.probe_spec.prompt_md).toContain(
      '每周课外阅读时间',
    );
    expect(validYuwen?.package.diagnostics.transfer.probe_spec.prompt_md).toContain('短视频');

    expect(validCausal?.package.material.body_md).toContain('火情 Y 会促使指挥中心增派消防车 X');
    for (const leakedDiagnosticTerm of [
      '一对一辅导',
      '数学掌握度',
      '抑郁症状',
      '运动频率',
      '职业倦怠',
      '支持会谈',
      '工作负荷',
    ]) {
      expect(validCausal?.package.material.body_md).not.toContain(leakedDiagnosticTerm);
    }
    expect(validCausal?.package.diagnostics.delayed.probe_spec).toMatchObject({
      prompt_md: expect.stringContaining('当前抑郁症状严重度'),
      reference_md: expect.stringContaining('同一抑郁症状严重度 Y 使人缺乏精力或动机'),
    });
    expect(validCausal?.package.diagnostics.transfer.probe_spec.reference_md).toContain(
      '同一 Y 构念促使员工主动参加更多会谈',
    );
    expect(validCausal?.package.diagnostics.transfer.context_change_md).toContain(
      '从材料的应急调度示例',
    );
  });

  it('retains a per-case strict-solver operational failure instead of discarding the artifact', async () => {
    const packet = InterventionReviewRegressionPacket.parse({
      ...regressionFixture,
      cases: [regressionFixture.cases[0]],
    });
    vi.mocked(reviewInterventionPackageCandidate).mockResolvedValueOnce({
      status: 'invalid',
      failureCode: 'independent_solution_unavailable:immediate',
      failureDetail:
        'solver output did not satisfy the complete SolutionGenerateOutput contract (confidence:invalid_type)',
      taskRunIds: [],
    });

    const result = await runInterventionReviewActualOutputEval({
      db: {} as never,
      packet,
      runTaskFn: vi.fn(),
      codeRevision: 'test-revision',
    });

    expect(result).toMatchObject({
      passed: false,
      cases: [
        {
          case_id: 'area-vs-length-and-scope',
          expectation_met: false,
          independent_solution_task_run_ids: [],
          operational_failure: {
            code: 'independent_solution_unavailable:immediate',
            detail: expect.stringContaining('confidence:invalid_type'),
            provenance_complete: false,
            provenance_issues: ['task_runs_empty'],
          },
        },
      ],
    });
  });

  it('retains paid run and cost provenance when final validation throws, then continues', async () => {
    const packet = InterventionReviewRegressionPacket.parse({
      ...regressionFixture,
      cases: [regressionFixture.cases[0], regressionFixture.cases[1]],
    });
    const taskInput = {
      prompt_md: '复杂真实形态的独立解题输入',
      kind: 'short_answer',
      subject_id: packet.cases[0]?.subject_id,
      choices_md: [],
      existing_answers_hint: null,
      existing_analysis_hint: null,
      figures_hint: null,
      prompt_image_refs: [],
    };
    const profile = resolveSubjectProfile(packet.cases[0]?.subject_id);
    const expectedRun = {
      task_kind: 'SolutionGenerateTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      input_hash: sha256CanonicalJson(taskInput),
      prompt_fingerprint: taskPromptFingerprint('SolutionGenerateTask', profile),
      result_digest: null,
      status: 'success',
      usage: { inputTokens: 321, outputTokens: 654 },
      cost_usd: 0.037,
    };
    const expectedCost = {
      task_kind: 'SolutionGenerateTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      cost: 0.037,
      currency: 'USD',
      tokens_in: 321,
      tokens_out: 654,
      outcome: 'success',
    };
    const db = {
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            Object.hasOwn(selection, 'status')
              ? { limit: async () => [expectedRun] }
              : Promise.resolve([expectedCost]),
        }),
      }),
    } as never;
    vi.mocked(reviewInterventionPackageCandidate)
      .mockImplementationOnce(async ({ runTaskFn }) => {
        await runTaskFn('SolutionGenerateTask', taskInput, { subjectProfile: profile });
        throw new Error('final audit assembly failed after paid solve');
      })
      .mockResolvedValueOnce({
        status: 'invalid',
        failureCode: 'independent_solution_unavailable:immediate',
        taskRunIds: [],
      });

    const result = await runInterventionReviewActualOutputEval({
      db,
      packet,
      runTaskFn: async () => ({ text: '', task_run_id: 'paid-before-throw' }),
      codeRevision: 'test-revision',
    });

    expect(result.passed).toBe(false);
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]).toMatchObject({
      operational_failure: {
        code: 'validator_exception',
        provenance_complete: true,
      },
      validator_task_run_ids: ['paid-before-throw'],
      runs: [expect.objectContaining({ task_run_id: 'paid-before-throw' })],
      costs: [expect.objectContaining({ task_run_id: 'paid-before-throw', cost: 0.037 })],
    });
    expect(result.cases[1]).toMatchObject({
      case_id: 'yuwen-fabricated-counterexamples',
      expectation_met: false,
    });
  });

  it('retains the persisted task id when the runner itself throws AgentRunError', async () => {
    const packet = InterventionReviewRegressionPacket.parse({
      ...regressionFixture,
      cases: [regressionFixture.cases[0]],
    });
    const profile = resolveSubjectProfile('math');
    const taskInput = {
      prompt_md: '某矩形长为 -5(w-4)，宽为 w-4，求面积并完整展开。',
      kind: 'short_answer',
      subject_id: 'math',
      choices_md: [],
      existing_answers_hint: null,
      existing_analysis_hint: null,
      figures_hint: null,
      prompt_image_refs: [],
    };
    vi.mocked(reviewInterventionPackageCandidate).mockImplementationOnce(async ({ runTaskFn }) => {
      await runTaskFn('SolutionGenerateTask', taskInput, { subjectProfile: profile });
      throw new Error('unreachable');
    });
    const failedRun = {
      task_kind: 'SolutionGenerateTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      input_hash: sha256CanonicalJson(taskInput),
      prompt_fingerprint: null,
      result_digest: null,
      status: 'failure',
      usage: { inputTokens: 211, outputTokens: 17 },
      cost_usd: 0,
    };
    const db = {
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            Object.hasOwn(selection, 'status')
              ? { limit: async () => [failedRun] }
              : Promise.resolve([]),
        }),
      }),
    } as never;

    const result = await runInterventionReviewActualOutputEval({
      db,
      packet,
      runTaskFn: async () => {
        throw new AgentRunError({
          kind: 'SolutionGenerateTask',
          taskRunId: 'paid-runner-failure',
          subtype: 'api_error_result',
          apiErrorStatus: 503,
          errors: ['provider unavailable after request acceptance'],
        });
      },
      codeRevision: 'test-revision',
    });

    expect(result).toMatchObject({
      passed: false,
      cases: [
        {
          validator_task_run_ids: ['paid-runner-failure'],
          independent_solution_task_run_ids: ['paid-runner-failure'],
          operational_failure: {
            code: 'validator_exception',
            provenance_complete: false,
            provenance_issues: expect.arrayContaining([
              'task_run_not_success:paid-runner-failure',
              'task_run_cost_missing:paid-runner-failure',
            ]),
          },
          runs: [expect.objectContaining({ task_run_id: 'paid-runner-failure' })],
        },
      ],
    });
  });

  it('fails provenance when an observed run renders the wrong subject profile', async () => {
    const packet = InterventionReviewRegressionPacket.parse({
      ...regressionFixture,
      cases: [regressionFixture.cases[0]],
    });
    const wrongProfile = resolveSubjectProfile('yuwen');
    const taskInput = {
      prompt_md: '某矩形长为 -5(w-4)，宽为 w-4，求面积并完整展开。',
      kind: 'short_answer',
      subject_id: 'math',
      choices_md: [],
      existing_answers_hint: null,
      existing_analysis_hint: null,
      figures_hint: null,
      prompt_image_refs: [],
    };
    const persistedRun = {
      task_kind: 'SolutionGenerateTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      input_hash: sha256CanonicalJson(taskInput),
      prompt_fingerprint: taskPromptFingerprint('SolutionGenerateTask', wrongProfile),
      result_digest: null,
      status: 'success',
      usage: { inputTokens: 144, outputTokens: 89 },
      cost_usd: 0.012,
    };
    const persistedCost = {
      task_kind: 'SolutionGenerateTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      cost: 0.012,
      currency: 'USD',
      tokens_in: 144,
      tokens_out: 89,
      outcome: 'success',
    };
    const db = {
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            Object.hasOwn(selection, 'status')
              ? { limit: async () => [persistedRun] }
              : Promise.resolve([persistedCost]),
        }),
      }),
    } as never;
    vi.mocked(reviewInterventionPackageCandidate).mockImplementationOnce(async ({ runTaskFn }) => {
      await runTaskFn('SolutionGenerateTask', taskInput, { subjectProfile: wrongProfile });
      return {
        status: 'invalid',
        failureCode: 'independent_solution_unavailable:delayed',
        taskRunIds: ['wrong-subject-run'],
      };
    });

    const result = await runInterventionReviewActualOutputEval({
      db,
      packet,
      runTaskFn: async () => ({ text: '', task_run_id: 'wrong-subject-run' }),
      codeRevision: 'test-revision',
    });

    expect(result.cases[0]).toMatchObject({
      expectation_met: false,
      operational_failure: {
        provenance_complete: false,
        provenance_issues: expect.arrayContaining([
          'task_run_wrong_subject_profile:wrong-subject-run',
        ]),
      },
    });
  });

  it('passes a FULL success only when every audited run was observed in this case', async () => {
    const packet = InterventionReviewRegressionPacket.parse({
      ...regressionFixture,
      cases: [regressionFixture.cases[3]],
    });
    const fixture = packet.cases[0];
    if (!fixture) throw new Error('missing positive math control');
    const profile = resolveSubjectProfile(fixture.subject_id);
    const kinds = ['immediate', 'delayed', 'transfer'] as const;
    const solverInputs = kinds.map((kind) => ({
      prompt_md: fixture.package.diagnostics[kind].probe_spec.prompt_md,
      kind: fixture.package.diagnostics[kind].probe_spec.response_mode,
      subject_id: fixture.subject_id,
      choices_md: [],
      existing_answers_hint: null,
      existing_analysis_hint: null,
      figures_hint: null,
      prompt_image_refs: [],
    }));
    const solverOutputs = kinds.map((kind, index) => ({
      reference_solution: {
        expected_signals: [
          `识别 ${kind} 题的负因子与括号内被减项`,
          '把负因子分别乘到两项，并把负负乘积写成正项',
          '复核最终表达式与题目要求的量一致',
        ],
        final_answer: fixture.package.diagnostics[kind].probe_spec.reference_md,
        answer_equivalents: [`等价答案-${index + 1}`],
      },
      worked_solution_md: `第 ${index + 1} 题逐项分配负因子，显式检查第二项符号和最终量。`,
      confidence: 0.96,
    }));
    const operation = (operationMd: string, operationIndex: number) => ({
      operation_index: operationIndex,
      operation_sha256: sha256CanonicalJson({ operation_md: operationMd }),
      operation_md: operationMd,
    });
    const independentDiagnostics = kinds.map((kind, index) => ({
      kind,
      task_input: solverInputs[index],
      question_input_sha256: sha256CanonicalJson(solverInputs[index]),
      solver_output: solverOutputs[index],
      solver_output_sha256: sha256CanonicalJson(solverOutputs[index]),
      solver_output_repair_level: false as const,
      solver_task_run_id: `fresh-solver-${index + 1}`,
      solver_attempt_task_run_ids: [`fresh-solver-${index + 1}`],
      independently_derived_answer_md: solverOutputs[index]?.reference_solution.final_answer,
      required_operations_md: solverOutputs[index]?.reference_solution.expected_signals.join('；'),
      required_operations: (solverOutputs[index]?.reference_solution.expected_signals ?? []).map(
        operation,
      ),
    }));
    const reviewResult = {
      review_protocol_version: 2 as const,
      verdict: 'pass' as const,
      failure_codes: [],
      diagnostic_checks: independentDiagnostics.map((diagnostic) => ({
        kind: diagnostic.kind,
        independent_solution_sha256: diagnostic.solver_output_sha256,
        independently_derived_answer_md: diagnostic.independently_derived_answer_md,
        required_operations_md: diagnostic.required_operations_md,
        required_operation_checks: diagnostic.required_operations.map((required) => ({
          ...required,
          reference_covers_operation: true,
          within_frozen_scope: true,
          decision_basis_md: '该原子步骤在 reference 中出现，且没有引入冻结边界外的构念。',
        })),
        reference_correct: true,
        within_frozen_scope: true,
        discipline_grounded: true,
        decision_basis_md: '完整必要路径、最终答案和学科事实均与密封盲解一致。',
        causal_direction_check: {
          applies: false,
          exposure_x_md: '',
          observed_outcome_y_md: '',
          reference_claims_reverse_causation: false,
          reference_claimed_reverse_cause_md: '',
          reference_claimed_reverse_cause_relation: 'none' as const,
          reference_reverse_causation_claim_checks: [],
          claimed_cause_is_observed_y_causing_x: false,
        },
      })),
      package_checks: {
        material_grounded: true,
        method_followed: true,
        tested_claims_match: true,
        target_errors_match: true,
        answers_unique: true,
        answers_gradable: true,
        no_answer_leak: true,
        diagnostics_same_construct: true,
        transfer_context_changed: true,
        target_error_identifiable: true,
        serious_factual_error_absent: true,
        safe_material: true,
      },
      summary_md: '三题完整路径和包级检查均通过。',
    };
    const firstReviewResult = structuredClone(reviewResult);
    firstReviewResult.summary_md =
      '第一轮独立复核通过：三道诊断题的原子步骤、答案与冻结构念均一致。';
    const firstImmediateCheck = firstReviewResult.diagnostic_checks[0];
    if (!firstImmediateCheck) throw new Error('missing first-pass immediate check');
    firstImmediateCheck.decision_basis_md =
      '第一轮逐步重算后，immediate 题的每个必要操作和最终答案都与密封盲解一致。';
    const contentResults = kinds.map((kind) => ({
      grounding: { verdict: 'pass' as const, note: `${kind} factual grounding verified.` },
      copy_safety: { verdict: 'original' as const, max_overlap: 0.04 },
      knowledge_hit: { verdict: 'pass' as const, note: `${kind} targets the frozen construct.` },
      overall: 'pass' as const,
      summary_md: `${kind} release-strict content validation passed.`,
      confidence: 0.95,
    }));
    const contentDiagnostics = kinds.map((kind, index) => {
      const taskInput = buildInterventionQuestionContentValidationTaskInput({
        context: fixture.context,
        packageValue: fixture.package,
        kind,
        subjectId: fixture.subject_id,
      });
      return {
        kind,
        task_input: taskInput,
        task_input_sha256: sha256CanonicalJson(taskInput),
        result: contentResults[index],
        result_sha256: sha256CanonicalJson(contentResults[index]),
        output_repair_level: false as const,
        task_run_id: `fresh-content-${index + 1}`,
      };
    });
    const independentSolutionAudit = {
      validation_protocol_version: 1 as const,
      package_digest_sha256: sha256CanonicalJson(fixture.package),
      diagnostics: independentDiagnostics,
    };
    const questionContentValidationAudit = {
      validation_protocol_version: 1 as const,
      package_digest_sha256: sha256CanonicalJson(fixture.package),
      diagnostics: contentDiagnostics,
    };
    const reviewInput = buildInterventionPackageReviewTaskInput({
      context: fixture.context,
      packageValue: fixture.package,
      independentAudit: independentSolutionAudit,
      questionContentValidationAudit,
    });
    const audit = {
      audit_protocol_version: INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION,
      review_version: 1 as const,
      package_digest_sha256: sha256CanonicalJson(fixture.package),
      review_task_run_id: 'fresh-review-2',
      review_attempt_task_run_ids: ['fresh-review-1', 'fresh-review-2'],
      review_task_input_sha256: sha256CanonicalJson(reviewInput),
      independent_solution_audit: independentSolutionAudit,
      question_content_validation_audit: questionContentValidationAudit,
      review_attempts: [
        { task_run_id: 'fresh-review-1', outcome: 'valid' as const, result: firstReviewResult },
        { task_run_id: 'fresh-review-2', outcome: 'valid' as const, result: reviewResult },
      ],
      result: reviewResult,
    };

    vi.mocked(reviewInterventionPackageCandidate).mockImplementationOnce(async ({ runTaskFn }) => {
      for (const solverInput of solverInputs) {
        await runTaskFn('SolutionGenerateTask', solverInput, { subjectProfile: profile });
      }
      for (const diagnostic of contentDiagnostics) {
        await runTaskFn('QuizVerifyTask', diagnostic.task_input, { subjectProfile: profile });
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await runTaskFn('InterventionPackageReviewTask', reviewInput, {
          subjectProfile: profile,
        });
      }
      return { status: 'ok', review: audit as never };
    });

    const runIds = [
      'fresh-solver-1',
      'fresh-solver-2',
      'fresh-solver-3',
      'fresh-content-1',
      'fresh-content-2',
      'fresh-content-3',
      'fresh-review-1',
      'fresh-review-2',
    ];
    let callIndex = 0;
    const taskRunFn = vi.fn(async () => ({ text: '', task_run_id: runIds[callIndex++] }));
    const expectedRuns = [
      ...independentDiagnostics.map((diagnostic) => ({
        task_kind: 'SolutionGenerateTask',
        input_hash: diagnostic.question_input_sha256,
        prompt_fingerprint: taskPromptFingerprint('SolutionGenerateTask', profile),
        result_digest: diagnostic.solver_output_sha256,
      })),
      ...contentDiagnostics.map((diagnostic) => ({
        task_kind: 'QuizVerifyTask',
        input_hash: diagnostic.task_input_sha256,
        prompt_fingerprint: taskPromptFingerprint('QuizVerifyTask', profile),
        result_digest: diagnostic.result_sha256,
      })),
      {
        task_kind: 'InterventionPackageReviewTask',
        input_hash: audit.review_task_input_sha256,
        prompt_fingerprint: taskPromptFingerprint('InterventionPackageReviewTask', profile),
        result_digest: sha256CanonicalJson(firstReviewResult),
      },
      {
        task_kind: 'InterventionPackageReviewTask',
        input_hash: audit.review_task_input_sha256,
        prompt_fingerprint: taskPromptFingerprint('InterventionPackageReviewTask', profile),
        result_digest: sha256CanonicalJson(reviewResult),
      },
    ].map((run) => ({
      ...run,
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      status: 'success',
      usage: { inputTokens: 800, outputTokens: 420 },
      cost_usd: 0.025,
    }));
    const expectedCosts = expectedRuns.map((run) => ({
      task_kind: run.task_kind,
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      cost: 0.025,
      currency: 'USD',
      tokens_in: 800,
      tokens_out: 420,
      outcome: 'success',
    }));
    let runRead = 0;
    let costRead = 0;
    const db = {
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            Object.hasOwn(selection, 'status')
              ? { limit: async () => [expectedRuns[runRead++]] }
              : Promise.resolve([expectedCosts[costRead++]]),
        }),
      }),
    } as never;

    const result = await runInterventionReviewActualOutputEval({
      db,
      packet,
      runTaskFn: taskRunFn,
      codeRevision: 'exact-test-revision',
    });

    expect(result).toMatchObject({
      passed: true,
      cases: [
        {
          expectation_met: true,
          validator_task_run_ids: runIds,
          review_task_run_id: 'fresh-review-2',
        },
      ],
    });

    // Each valid comparator attempt owns its own result digest. Two pass
    // attempts may legitimately differ in explanatory text, so checking only
    // the selected/final result would lose first-attempt provenance.
    vi.mocked(reviewInterventionPackageCandidate).mockImplementationOnce(async ({ runTaskFn }) => {
      for (const solverInput of solverInputs) {
        await runTaskFn('SolutionGenerateTask', solverInput, { subjectProfile: profile });
      }
      for (const diagnostic of contentDiagnostics) {
        await runTaskFn('QuizVerifyTask', diagnostic.task_input, { subjectProfile: profile });
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await runTaskFn('InterventionPackageReviewTask', reviewInput, {
          subjectProfile: profile,
        });
      }
      return { status: 'ok', review: audit as never };
    });
    let wrongFirstDigestCallIndex = 0;
    const wrongFirstDigestTaskRunFn = vi.fn(async () => ({
      text: '',
      task_run_id: runIds[wrongFirstDigestCallIndex++],
    }));
    const wrongFirstDigestRuns = structuredClone(expectedRuns);
    const firstReviewRun = wrongFirstDigestRuns[6];
    if (!firstReviewRun) throw new Error('missing first review provenance row');
    firstReviewRun.result_digest = sha256CanonicalJson(reviewResult);
    let wrongFirstDigestRunRead = 0;
    let wrongFirstDigestCostRead = 0;
    const wrongFirstDigestDb = {
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            Object.hasOwn(selection, 'status')
              ? { limit: async () => [wrongFirstDigestRuns[wrongFirstDigestRunRead++]] }
              : Promise.resolve([expectedCosts[wrongFirstDigestCostRead++]]),
        }),
      }),
    } as never;
    const wrongFirstDigestResult = await runInterventionReviewActualOutputEval({
      db: wrongFirstDigestDb,
      packet,
      runTaskFn: wrongFirstDigestTaskRunFn,
      codeRevision: 'exact-test-revision',
    });
    expect(wrongFirstDigestResult).toMatchObject({
      passed: false,
      cases: [
        {
          expectation_met: false,
          operational_failure: {
            code: 'task_run_provenance_incomplete',
            provenance_issues: expect.arrayContaining(['task_run_wrong_result:fresh-review-1']),
          },
        },
      ],
    });

    // A self-consistent audit + DB row is not sufficient: the eval must rebuild
    // the canonical content-validator and comparator inputs from the fixture.
    const tamperedContentDiagnostics = structuredClone(contentDiagnostics);
    const tamperedImmediate = tamperedContentDiagnostics[0];
    if (!tamperedImmediate) throw new Error('missing content diagnostic to tamper');
    const tamperedTaskInput = structuredClone(tamperedImmediate.task_input);
    tamperedTaskInput.question.prompt_md += '\n[non-canonical replay substitution]';
    tamperedImmediate.task_input = tamperedTaskInput;
    tamperedImmediate.task_input_sha256 = sha256CanonicalJson(tamperedTaskInput);
    const tamperedContentAudit = {
      ...questionContentValidationAudit,
      diagnostics: tamperedContentDiagnostics,
    };
    const tamperedReviewInput = buildInterventionPackageReviewTaskInput({
      context: fixture.context,
      packageValue: fixture.package,
      independentAudit: independentSolutionAudit,
      questionContentValidationAudit: tamperedContentAudit,
    });
    const tamperedAudit = {
      ...audit,
      question_content_validation_audit: tamperedContentAudit,
      review_task_input_sha256: sha256CanonicalJson(tamperedReviewInput),
    };
    vi.mocked(reviewInterventionPackageCandidate).mockImplementationOnce(async ({ runTaskFn }) => {
      for (const solverInput of solverInputs) {
        await runTaskFn('SolutionGenerateTask', solverInput, { subjectProfile: profile });
      }
      for (const diagnostic of tamperedContentDiagnostics) {
        await runTaskFn('QuizVerifyTask', diagnostic.task_input, { subjectProfile: profile });
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await runTaskFn('InterventionPackageReviewTask', tamperedReviewInput, {
          subjectProfile: profile,
        });
      }
      return { status: 'ok', review: tamperedAudit as never };
    });
    let tamperedCallIndex = 0;
    const tamperedTaskRunFn = vi.fn(async () => ({
      text: '',
      task_run_id: runIds[tamperedCallIndex++],
    }));
    const tamperedExpectedRuns = [
      ...independentDiagnostics.map((diagnostic) => ({
        task_kind: 'SolutionGenerateTask',
        input_hash: diagnostic.question_input_sha256,
        prompt_fingerprint: taskPromptFingerprint('SolutionGenerateTask', profile),
        result_digest: diagnostic.solver_output_sha256,
      })),
      ...tamperedContentDiagnostics.map((diagnostic) => ({
        task_kind: 'QuizVerifyTask',
        input_hash: diagnostic.task_input_sha256,
        prompt_fingerprint: taskPromptFingerprint('QuizVerifyTask', profile),
        result_digest: diagnostic.result_sha256,
      })),
      ...Array.from({ length: 2 }, () => ({
        task_kind: 'InterventionPackageReviewTask' as const,
        input_hash: tamperedAudit.review_task_input_sha256,
        prompt_fingerprint: taskPromptFingerprint('InterventionPackageReviewTask', profile),
        result_digest: '',
      })).map((run, index) => ({
        ...run,
        result_digest: sha256CanonicalJson(index === 0 ? firstReviewResult : reviewResult),
      })),
    ].map((run) => ({
      ...run,
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      status: 'success',
      usage: { inputTokens: 800, outputTokens: 420 },
      cost_usd: 0.025,
    }));
    let tamperedRunRead = 0;
    let tamperedCostRead = 0;
    const tamperedDb = {
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            Object.hasOwn(selection, 'status')
              ? { limit: async () => [tamperedExpectedRuns[tamperedRunRead++]] }
              : Promise.resolve([expectedCosts[tamperedCostRead++]]),
        }),
      }),
    } as never;
    const tamperedResult = await runInterventionReviewActualOutputEval({
      db: tamperedDb,
      packet,
      runTaskFn: tamperedTaskRunFn,
      codeRevision: 'exact-test-revision',
    });
    expect(tamperedResult).toMatchObject({
      passed: false,
      cases: [
        {
          expectation_met: false,
          operational_failure: {
            code: 'task_run_provenance_incomplete',
            provenance_issues: expect.arrayContaining([
              'audit_content_input_mismatch:immediate',
              'task_run_observed_wrong_input:fresh-content-1',
            ]),
          },
        },
      ],
    });
  });

  it('rejects an otherwise matching FULL audit whose run ids were not observed in this case', async () => {
    const packet = InterventionReviewRegressionPacket.parse({
      ...regressionFixture,
      cases: [regressionFixture.cases[3]],
    });
    const fixture = packet.cases[0];
    if (!fixture) throw new Error('missing replay fixture');
    const packageDigest = sha256CanonicalJson(fixture.package);
    const diagnostics = (['immediate', 'delayed', 'transfer'] as const).map((kind, index) => {
      const operationMd = `独立完成 ${kind} 题并核对最终答案`;
      const solverOutput = {
        reference_solution: {
          expected_signals: [operationMd],
          final_answer: fixture.package.diagnostics[kind].probe_spec.reference_md,
          answer_equivalents: [],
        },
        worked_solution_md: `${kind} 题按题面独立求解。`,
        confidence: 0.95,
      };
      return {
        kind,
        task_input: {
          prompt_md: fixture.package.diagnostics[kind].probe_spec.prompt_md,
          kind: fixture.package.diagnostics[kind].probe_spec.response_mode,
          subject_id: fixture.subject_id,
          choices_md: [],
          existing_answers_hint: null,
          existing_analysis_hint: null,
          figures_hint: null,
          prompt_image_refs: [],
        },
        question_input_sha256: sha256CanonicalJson({
          prompt_md: fixture.package.diagnostics[kind].probe_spec.prompt_md,
          kind: fixture.package.diagnostics[kind].probe_spec.response_mode,
          subject_id: fixture.subject_id,
          choices_md: [],
          existing_answers_hint: null,
          existing_analysis_hint: null,
          figures_hint: null,
          prompt_image_refs: [],
        }),
        solver_output: solverOutput,
        solver_output_sha256: sha256CanonicalJson(solverOutput),
        solver_output_repair_level: false as const,
        solver_task_run_id: `replayed-solver-${index + 1}`,
        solver_attempt_task_run_ids: [`replayed-solver-${index + 1}`],
        independently_derived_answer_md: solverOutput.reference_solution.final_answer,
        required_operations_md: operationMd,
        required_operations: [
          {
            operation_index: 0,
            operation_sha256: sha256CanonicalJson({ operation_md: operationMd }),
            operation_md: operationMd,
          },
        ],
      };
    });
    const passingPackageChecks = {
      material_grounded: true,
      method_followed: true,
      tested_claims_match: true,
      target_errors_match: true,
      answers_unique: true,
      answers_gradable: true,
      no_answer_leak: true,
      diagnostics_same_construct: true,
      transfer_context_changed: true,
      target_error_identifiable: true,
      serious_factual_error_absent: true,
      safe_material: true,
    };
    const contentDiagnostics = (['immediate', 'delayed', 'transfer'] as const).map(
      (kind, index) => {
        const taskInput = buildInterventionQuestionContentValidationTaskInput({
          context: fixture.context,
          packageValue: fixture.package,
          kind,
          subjectId: fixture.subject_id,
        });
        const validationResult = {
          grounding: {
            verdict: 'pass' as const,
            note: `${kind} 的公式、量纲、答案和题面在 release-strict 模式下均已核对。`,
          },
          copy_safety: { verdict: 'original' as const, max_overlap: 0.03 },
          knowledge_hit: {
            verdict: 'pass' as const,
            note: `${kind} 仍只检验负因子分配及负负得正。`,
          },
          overall: 'pass' as const,
          summary_md: `${kind} 复杂题面通过内容 grounding 与构念命中检查。`,
          confidence: 0.96,
        };
        return {
          kind,
          task_input: taskInput,
          task_input_sha256: sha256CanonicalJson(taskInput),
          result: validationResult,
          result_sha256: sha256CanonicalJson(validationResult),
          output_repair_level: false as const,
          task_run_id: `replayed-content-${index + 1}`,
        };
      },
    );
    const reviewResult = {
      review_protocol_version: 2 as const,
      verdict: 'pass' as const,
      failure_codes: [],
      diagnostic_checks: diagnostics.map((diagnostic) => ({
        kind: diagnostic.kind,
        independent_solution_sha256: diagnostic.solver_output_sha256,
        independently_derived_answer_md: diagnostic.independently_derived_answer_md,
        required_operations_md: diagnostic.required_operations_md,
        required_operation_checks: diagnostic.required_operations.map((operation) => ({
          ...operation,
          reference_covers_operation: true,
          within_frozen_scope: true,
          decision_basis_md: 'reference 覆盖该必要步骤，且没有越过冻结范围。',
        })),
        reference_correct: true,
        within_frozen_scope: true,
        discipline_grounded: true,
        decision_basis_md: '密封盲解、内容 grounding、reference 与冻结范围一致。',
        causal_direction_check: {
          applies: false,
          exposure_x_md: '',
          observed_outcome_y_md: '',
          reference_claims_reverse_causation: false,
          reference_claimed_reverse_cause_md: '',
          reference_claimed_reverse_cause_relation: 'none' as const,
          reference_reverse_causation_claim_checks: [],
          claimed_cause_is_observed_y_causing_x: false,
        },
      })),
      package_checks: passingPackageChecks,
      summary_md: '完整 FULL 审计通过，但这些运行并未在本 case 中观察到。',
    };
    const independentSolutionAudit = {
      validation_protocol_version: 1 as const,
      package_digest_sha256: packageDigest,
      diagnostics,
    };
    const questionContentValidationAudit = {
      validation_protocol_version: 1 as const,
      package_digest_sha256: packageDigest,
      diagnostics: contentDiagnostics,
    };
    const reviewTaskInput = buildInterventionPackageReviewTaskInput({
      context: fixture.context,
      packageValue: fixture.package,
      independentAudit: independentSolutionAudit,
      questionContentValidationAudit,
    });
    vi.mocked(reviewInterventionPackageCandidate).mockResolvedValueOnce({
      status: 'ok',
      review: {
        audit_protocol_version: INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION,
        review_version: 1,
        package_digest_sha256: packageDigest,
        review_task_run_id: 'replayed-review-2',
        review_attempt_task_run_ids: ['replayed-review-1', 'replayed-review-2'],
        review_task_input_sha256: sha256CanonicalJson(reviewTaskInput),
        independent_solution_audit: independentSolutionAudit,
        question_content_validation_audit: questionContentValidationAudit,
        review_attempts: [
          { task_run_id: 'replayed-review-1', outcome: 'valid', result: reviewResult },
          { task_run_id: 'replayed-review-2', outcome: 'valid', result: reviewResult },
        ],
        result: reviewResult,
      } as never,
    });
    const db = {
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            Object.hasOwn(selection, 'status') ? { limit: async () => [] } : Promise.resolve([]),
        }),
      }),
    } as never;

    const result = await runInterventionReviewActualOutputEval({
      db,
      packet,
      runTaskFn: vi.fn(),
      codeRevision: 'test-revision',
    });

    expect(result.passed).toBe(false);
    expect(result.cases[0]).toMatchObject({
      expectation_met: false,
      operational_failure: {
        code: 'task_run_provenance_incomplete',
        provenance_issues: expect.arrayContaining([
          'task_run_not_observed:replayed-solver-1',
          'task_run_not_observed:replayed-content-1',
          'task_run_not_observed:replayed-review-1',
        ]),
      },
    });
  });

  it('marks a wrong provider/model route or cost outcome as incomplete provenance', async () => {
    const db = {
      select: (selection: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            Object.hasOwn(selection, 'status')
              ? {
                  limit: async () => [
                    {
                      task_kind: 'SolutionGenerateTask',
                      provider: 'anthropic-sub',
                      model: 'claude-opus',
                      input_hash: 'a'.repeat(64),
                      prompt_fingerprint: 'b'.repeat(64),
                      result_digest: null,
                      status: 'success',
                      usage: { inputTokens: 10, outputTokens: 20 },
                      cost_usd: 0.1,
                    },
                  ],
                }
              : Promise.resolve([
                  {
                    task_kind: 'SolutionGenerateTask',
                    provider: 'anthropic-sub',
                    model: 'claude-opus',
                    cost: 0.1,
                    currency: 'USD',
                    tokens_in: 10,
                    tokens_out: 20,
                    outcome: 'failure',
                  },
                ]),
        }),
      }),
    } as never;

    const provenance = await collectTaskRunProvenance(db, [
      {
        id: 'wrong-route-run',
        taskKind: 'SolutionGenerateTask',
        inputHash: 'a'.repeat(64),
        promptFingerprint: 'b'.repeat(64),
      },
    ]);

    expect(provenance.complete).toBe(false);
    expect(provenance.issues).toEqual(
      expect.arrayContaining([
        'task_run_wrong_route:wrong-route-run',
        'task_run_cost_wrong_route_or_outcome:wrong-route-run',
      ]),
    );
  });
});
