import { reviewInterventionPackageCandidate } from '@/capabilities/practice/server/intervention-author';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import regressionFixture from '@/server/grounding-gate/fixtures/intervention-review-regressions.v1.json' with {
  type: 'json',
};
import {
  InterventionReviewRegressionPacket,
  runInterventionReviewActualOutputEval,
} from '@/server/grounding-gate/intervention-review-eval';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/capabilities/practice/server/intervention-author', () => ({
  reviewInterventionPackageCandidate: vi.fn(),
}));

describe('intervention reviewer actual-output regression fixture', () => {
  it('pins complex false-pass regressions and true-pass controls', () => {
    const packet = InterventionReviewRegressionPacket.parse(regressionFixture);
    expect(sha256CanonicalJson(packet)).toBe(
      '6b5d5e2f3ade5e6941c0800ac81a2cd44ec751c448ab76729d86d65278a78ad9',
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
          },
        },
      ],
    });
  });
});
