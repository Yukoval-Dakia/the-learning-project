import { sha256CanonicalJson } from '@/kernel/canonical-json';
import regressionFixture from '@/server/grounding-gate/fixtures/intervention-review-regressions.v1.json' with {
  type: 'json',
};
import { InterventionReviewRegressionPacket } from '@/server/grounding-gate/intervention-review-eval';
import { describe, expect, it } from 'vitest';

describe('intervention reviewer actual-output regression fixture', () => {
  it('pins the credential-free area, yuwen, and causal false-pass set', () => {
    const packet = InterventionReviewRegressionPacket.parse(regressionFixture);
    expect(sha256CanonicalJson(packet)).toBe(
      '53cc01c3effc1e0f81ffefe7ee481a648dda96fb2273aef9a09e20bb4d341841',
    );
    expect(
      packet.cases.map((fixture) => ({
        case_id: fixture.case_id,
        expected_failure_codes: fixture.expected_failure_codes,
      })),
    ).toEqual([
      {
        case_id: 'area-vs-length-and-scope',
        expected_failure_codes: ['reference_incorrect', 'claim_scope_expansion'],
      },
      {
        case_id: 'yuwen-fabricated-counterexamples',
        expected_failure_codes: ['reference_incorrect'],
      },
      {
        case_id: 'causal-baseline-selection-not-reverse-causation',
        expected_failure_codes: ['reference_incorrect'],
      },
    ]);

    const [area, yuwen, causal] = packet.cases;
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
  });
});
