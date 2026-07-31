import { reviewInterventionPackageCandidate } from '@/capabilities/practice/server/intervention-author';
import {
  InterventionAuthoringContext,
  InterventionPackage,
  InterventionPackageReviewFailureCode,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { ai_task_runs, cost_ledger } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const InterventionReviewRegressionCase = z
  .object({
    case_id: z.string().trim().min(1).max(160),
    subject_id: z.enum(['general', 'math', 'physics', 'yuwen']),
    context: InterventionAuthoringContext,
    package: InterventionPackage,
    expected_verdict: z.enum(['pass', 'fail']),
    expected_failure_codes: z.array(InterventionPackageReviewFailureCode),
  })
  .strict()
  .superRefine((fixture, context) => {
    if (
      (fixture.expected_verdict === 'pass' && fixture.expected_failure_codes.length > 0) ||
      (fixture.expected_verdict === 'fail' && fixture.expected_failure_codes.length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pass fixtures require zero failure codes; fail fixtures require at least one',
      });
    }
  });

export const InterventionReviewRegressionPacket = z
  .object({
    schema_version: z.literal(1),
    source_kind: z.literal('sanitized_regression_fixture'),
    cases: z.array(InterventionReviewRegressionCase).min(1).max(20),
  })
  .strict();
export type InterventionReviewRegressionPacketT = z.infer<
  typeof InterventionReviewRegressionPacket
>;

export async function runInterventionReviewActualOutputEval(input: {
  db: Db;
  packet: InterventionReviewRegressionPacketT;
  runTaskFn: TaskTextRunFn;
  codeRevision: string;
}): Promise<{
  schema_version: 1;
  artifact_kind: 'intervention_review_actual_output_regression';
  satisfies_yuk_814_canary: false;
  code_revision: string;
  input_sha256: string;
  generated_at: string;
  passed: boolean;
  cases: Array<Record<string, unknown>>;
}> {
  const packet = InterventionReviewRegressionPacket.parse(input.packet);
  const results: Array<Record<string, unknown>> = [];
  for (const fixture of packet.cases) {
    const packageDigest = sha256CanonicalJson(fixture.package);
    const validation = await reviewInterventionPackageCandidate({
      db: input.db,
      runTaskFn: input.runTaskFn,
      context: fixture.context,
      packageValue: fixture.package,
      subjectProfile: resolveSubjectProfile(fixture.subject_id),
    });
    if (validation.status === 'invalid') {
      throw new Error(
        `review regression ${fixture.case_id} failed before a durable FULL audit: ${validation.failureCode}`,
      );
    }
    const audit = validation.review;
    if (!('independent_solution_audit' in audit)) {
      throw new Error(`review regression ${fixture.case_id} returned a legacy audit`);
    }
    const review = audit.result;
    const taskRunIds = [
      ...audit.independent_solution_audit.diagnostics.map(
        (diagnostic) => diagnostic.solver_task_run_id,
      ),
      audit.review_task_run_id,
    ];
    const runs: Array<Record<string, unknown>> = [];
    const costs: Array<Record<string, unknown>> = [];
    for (const taskRunId of taskRunIds) {
      const [run] = await input.db
        .select({
          task_kind: ai_task_runs.task_kind,
          provider: ai_task_runs.provider,
          model: ai_task_runs.model,
          status: ai_task_runs.status,
          usage: ai_task_runs.usage_json,
          cost_usd: ai_task_runs.cost_usd,
        })
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, taskRunId))
        .limit(1);
      if (!run) {
        throw new Error(
          `review regression ${fixture.case_id} task_run_id ${taskRunId} was not persisted`,
        );
      }
      const runCosts = await input.db
        .select({
          provider: cost_ledger.provider,
          model: cost_ledger.model,
          cost: cost_ledger.cost,
          currency: cost_ledger.currency,
          tokens_in: cost_ledger.tokens_in,
          tokens_out: cost_ledger.tokens_out,
          outcome: cost_ledger.outcome,
        })
        .from(cost_ledger)
        .where(eq(cost_ledger.task_run_id, taskRunId));
      if (run.status !== 'success' || runCosts.length === 0) {
        throw new Error(
          `review regression ${fixture.case_id} task_run_id ${taskRunId} lacks successful cost provenance`,
        );
      }
      runs.push({ task_run_id: taskRunId, ...run });
      costs.push(...runCosts.map((cost) => ({ task_run_id: taskRunId, ...cost })));
    }
    const actualFailureCodes = new Set(review.failure_codes);
    const expectationMet =
      review.verdict === fixture.expected_verdict &&
      fixture.expected_failure_codes.every((code) => actualFailureCodes.has(code));
    results.push({
      case_id: fixture.case_id,
      subject_id: fixture.subject_id,
      package_digest_sha256: packageDigest,
      expected_verdict: fixture.expected_verdict,
      expected_failure_codes: fixture.expected_failure_codes,
      expectation_met: expectationMet,
      independent_solution_task_run_ids: audit.independent_solution_audit.diagnostics.map(
        (diagnostic) => diagnostic.solver_task_run_id,
      ),
      review_task_run_id: audit.review_task_run_id,
      full_validation_audit_sha256: sha256CanonicalJson(audit),
      full_validation_audit: audit,
      review,
      runs,
      costs,
    });
  }
  return {
    schema_version: 1,
    artifact_kind: 'intervention_review_actual_output_regression',
    satisfies_yuk_814_canary: false,
    code_revision: input.codeRevision,
    input_sha256: sha256CanonicalJson(packet),
    generated_at: new Date().toISOString(),
    passed: results.every((result) => result.expectation_met === true),
    cases: results,
  };
}
