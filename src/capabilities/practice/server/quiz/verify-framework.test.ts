import { describe, expect, it, vi } from 'vitest';

import { sha256CanonicalJson } from '@/kernel/canonical-json';
import interventionRegressionFixture from '@/server/grounding-gate/fixtures/intervention-review-regressions.v1.json' with {
  type: 'json',
};
import { resolveSubjectProfile } from '@/subjects/profile';
import { runIndependentSolution } from './verify-framework';

// ---------- solve-check helpers ----------
// solverOutput / semanticOutput now come from tests/helpers/solve-check-fixtures (YUK-554
// review R1/R2 — shared with quiz_verify.test.ts).

describe('runIndependentSolution — reusable blind validator seam', () => {
  it('solves every production-shaped intervention diagnostic without leaking its package answer or frozen claim', async () => {
    const diagnostics = interventionRegressionFixture.cases.flatMap((fixture) =>
      (['immediate', 'delayed', 'transfer'] as const).map((kind) => ({
        fixture,
        kind,
        diagnostic: fixture.package.diagnostics[kind],
      })),
    );
    expect(diagnostics).toHaveLength(18);

    for (const { fixture, kind, diagnostic } of diagnostics) {
      const runTaskFn = vi.fn(async (_taskKind: string, _taskInput: unknown, _ctx: unknown) => ({
        text: JSON.stringify({
          reference_solution: {
            expected_signals: [
              '先识别题目实际要求的量、文本方向或因果方向',
              '再按题面条件独立推导并检查量纲、文本证据或 X/Y 时序',
            ],
            final_answer: `blind answer for ${fixture.case_id}/${kind}`,
            answer_equivalents: [],
          },
          worked_solution_md:
            '这是独立于作者标答的完整求解摘要；它包含必要步骤，但不读取干预包里的参考答案。',
          confidence: 0.91,
        }),
        task_run_id: `solve-${fixture.case_id}-${kind}`,
        cost_usd: 0.012,
      }));

      const result = await runIndependentSolution(
        {
          id: `${fixture.case_id}:${kind}`,
          kind: diagnostic.probe_spec.response_mode,
          prompt_md: diagnostic.probe_spec.prompt_md,
          choices_md: null,
          image_refs: null,
          figures: null,
        },
        {
          runTaskFn,
          profile: {
            id: fixture.subject_id,
            full: resolveSubjectProfile(fixture.subject_id),
          },
        },
      );

      expect(result).toMatchObject({
        status: 'solved',
        task_run_id: `solve-${fixture.case_id}-${kind}`,
        solution: {
          reference_solution: {
            final_answer: `blind answer for ${fixture.case_id}/${kind}`,
            expected_signals: expect.arrayContaining([
              '先识别题目实际要求的量、文本方向或因果方向',
            ]),
          },
        },
        task_input_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        solver_output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        solver_output_repair_level: false,
        cost_usd: 0.012,
      });
      expect(runTaskFn).toHaveBeenCalledTimes(1);
      const blindInput = runTaskFn.mock.calls[0]?.[1] as Record<string, unknown>;
      // Post-P4: no SDK outputFormat threading — the blind validator relies on
      // prompt-level JSON instruction + schema parse of the text result.
      expect(
        (runTaskFn.mock.calls[0]?.[2] as { outputFormat?: unknown }).outputFormat,
      ).toBeUndefined();
      expect(blindInput.prompt_md).toBe(diagnostic.probe_spec.prompt_md);
      expect(Object.keys(blindInput).sort()).toEqual([
        'choices_md',
        'existing_analysis_hint',
        'existing_answers_hint',
        'figures_hint',
        'kind',
        'prompt_image_refs',
        'prompt_md',
        'subject_id',
      ]);
      if (result.status !== 'solved') throw new Error('expected a strict solved result');
      expect(result.task_input).toEqual(blindInput);
      expect(result.task_input_sha256).toBe(sha256CanonicalJson(blindInput));
      expect(result.solver_output_sha256).toBe(sha256CanonicalJson(result.solution));
      const serializedBlindInput = JSON.stringify(blindInput);
      expect(serializedBlindInput).not.toContain(diagnostic.probe_spec.reference_md);
      expect(serializedBlindInput).not.toContain(
        diagnostic.probe_spec.expected_target_error_answer_md,
      );
      expect(serializedBlindInput).not.toContain(fixture.context.snapshot.conjecture.claim_md);
      expect(serializedBlindInput).not.toContain(fixture.package.material.body_md);
      expect(serializedBlindInput).not.toContain('gold_response_signature');
      expect(serializedBlindInput).not.toContain('target_error_response_signature');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YUK-578 — teaching_quality VerifyCheck (入池前审题闸)
//
// MINI GOLDEN SET (校准纪律, aligns with YUK-573): these fixtures pin the parser +
// decision mapping for the three teaching-quality axes — 题干清晰度 / 唯一正解性 /
// 干扰项诊断力(仅选择题). Any change to the TeachingQualityTask prompt (registry.ts) or
// this output contract (tests/helpers/teaching-quality-fixtures.ts) MUST be re-validated
// against this set before shipping. mocked-LLM output drives parser + verdict + veto.
// ─────────────────────────────────────────────────────────────────────────────
