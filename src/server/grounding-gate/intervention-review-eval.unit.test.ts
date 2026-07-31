import { reviewInterventionPackageCandidate } from '@/capabilities/practice/server/intervention-author';
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
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/capabilities/practice/server/intervention-author', () => ({
  reviewInterventionPackageCandidate: vi.fn(),
}));

describe('intervention reviewer actual-output regression fixture', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins complex false-pass regressions and true-pass controls', () => {
    const packet = InterventionReviewRegressionPacket.parse(regressionFixture);
    expect(sha256CanonicalJson(packet)).toBe(
      '039d7a688c2e5fe9139bb9f31a8738faecb21ed1c47e27afc72dc8d3d2c0735b',
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
    ]);

    const [area, yuwen, causal, validMath, validYuwen] = packet.cases;
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
    const reviewInput = {
      snapshot: fixture.context.snapshot,
      package_digest: sha256CanonicalJson(fixture.package),
      sealed_run_ids: independentDiagnostics.map((entry) => entry.solver_task_run_id),
    };
    const audit = {
      review_version: 1 as const,
      package_digest_sha256: sha256CanonicalJson(fixture.package),
      review_task_run_id: 'fresh-review-1',
      review_attempt_task_run_ids: ['fresh-review-1'],
      review_task_input_sha256: sha256CanonicalJson(reviewInput),
      independent_solution_audit: {
        validation_protocol_version: 1 as const,
        package_digest_sha256: sha256CanonicalJson(fixture.package),
        diagnostics: independentDiagnostics,
      },
      result: reviewResult,
    };

    vi.mocked(reviewInterventionPackageCandidate).mockImplementationOnce(async ({ runTaskFn }) => {
      for (const solverInput of solverInputs) {
        await runTaskFn('SolutionGenerateTask', solverInput, { subjectProfile: profile });
      }
      await runTaskFn('InterventionPackageReviewTask', reviewInput, {
        subjectProfile: profile,
      });
      return { status: 'ok', review: audit as never };
    });

    const runIds = ['fresh-solver-1', 'fresh-solver-2', 'fresh-solver-3', 'fresh-review-1'];
    let callIndex = 0;
    const taskRunFn = vi.fn(async () => ({ text: '', task_run_id: runIds[callIndex++] }));
    const expectedRuns = [
      ...independentDiagnostics.map((diagnostic) => ({
        task_kind: 'SolutionGenerateTask',
        input_hash: diagnostic.question_input_sha256,
        prompt_fingerprint: taskPromptFingerprint('SolutionGenerateTask', profile),
        result_digest: diagnostic.solver_output_sha256,
      })),
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
          review_task_run_id: 'fresh-review-1',
        },
      ],
    });
  });

  it('rejects an otherwise matching FULL audit whose run ids were not observed in this case', async () => {
    const packet = InterventionReviewRegressionPacket.parse({
      ...regressionFixture,
      cases: [regressionFixture.cases[3]],
    });
    vi.mocked(reviewInterventionPackageCandidate).mockResolvedValueOnce({
      status: 'ok',
      review: {
        review_version: 1,
        package_digest_sha256: 'a'.repeat(64),
        review_task_run_id: 'replayed-review',
        review_attempt_task_run_ids: ['replayed-review'],
        review_task_input_sha256: 'b'.repeat(64),
        independent_solution_audit: {
          validation_protocol_version: 1,
          package_digest_sha256: 'a'.repeat(64),
          diagnostics: (['immediate', 'delayed', 'transfer'] as const).map((kind, index) => ({
            kind,
            solver_task_run_id: `replayed-solver-${index + 1}`,
            solver_attempt_task_run_ids: [`replayed-solver-${index + 1}`],
            question_input_sha256: `${index + 1}`.repeat(64),
            solver_output_sha256: `${index + 4}`.repeat(64),
          })),
        },
        result: { verdict: 'pass', failure_codes: [] },
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
          'task_run_not_observed:replayed-review',
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
