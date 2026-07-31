import { createHash } from 'node:crypto';
import { tasks } from '@/ai/registry';
import { enforceInterventionPackageReviewDecision } from '@/capabilities/practice/server/intervention-author';
import {
  InterventionAuthoringContext,
  InterventionPackage,
  InterventionPackageReviewFailureCode,
  InterventionPackageReviewModelOutput,
  type InterventionPackageReviewModelOutputT,
  InterventionPackageReviewModelOutputV2,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { ai_task_runs, cost_ledger } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { parseJsonObjectLoose } from '@/server/ai/json-extract';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import type { TaskTextResult, TaskTextRunFn } from '@/server/ai/provenance';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const InterventionReviewRegressionCase = z
  .object({
    case_id: z.string().trim().min(1).max(160),
    subject_id: z.enum(['general', 'math', 'physics', 'yuwen']),
    context: InterventionAuthoringContext,
    package: InterventionPackage,
    expected_failure_codes: z.array(InterventionPackageReviewFailureCode).min(1),
  })
  .strict();

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

const reviewOutputSchema = tasks.InterventionPackageReviewTask.structuredOutputSchema;
if (!reviewOutputSchema) throw new Error('InterventionPackageReviewTask has no output schema');
const REVIEW_OUTPUT_FORMAT = zodToJsonSchemaOutputFormat(reviewOutputSchema);

function parseReviewResult(result: TaskTextResult): {
  review: InterventionPackageReviewModelOutputT;
  raw_output_sha256: string;
  parse_error: string | null;
} {
  const rawOutput =
    result.structured_output === undefined || result.structured_output === null
      ? result.text
      : JSON.stringify(result.structured_output);
  try {
    const value =
      result.structured_output ??
      parseJsonObjectLoose(result.text, 'intervention review actual-output eval', {
        riskyRepair: 'reject',
        containerClosure: 'schema_validated',
        latexEscapes: 'markdown_math',
      })?.json;
    return {
      review: enforceInterventionPackageReviewDecision(
        InterventionPackageReviewModelOutputV2.parse(value),
      ),
      raw_output_sha256: createHash('sha256').update(rawOutput).digest('hex'),
      parse_error: null,
    };
  } catch (error) {
    return {
      review: InterventionPackageReviewModelOutput.parse({
        verdict: 'fail',
        failure_codes: ['review_output_invalid'],
        summary_md: 'Review output failed structured-output validation.',
      }),
      raw_output_sha256: createHash('sha256').update(rawOutput).digest('hex'),
      parse_error: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
    };
  }
}

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
    const taskResult = await input.runTaskFn(
      'InterventionPackageReviewTask',
      {
        snapshot: fixture.context.snapshot,
        recommendation: fixture.context.recommendation,
        package: fixture.package,
      },
      {
        subjectProfile: resolveSubjectProfile(fixture.subject_id),
        outputFormat: REVIEW_OUTPUT_FORMAT,
      },
    );
    if (!taskResult.task_run_id) {
      throw new Error(`review regression ${fixture.case_id} returned no task_run_id`);
    }
    const parsedReview = parseReviewResult(taskResult);
    const review = parsedReview.review;
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
      .where(eq(ai_task_runs.id, taskResult.task_run_id))
      .limit(1);
    if (!run) {
      throw new Error(
        `review regression ${fixture.case_id} task_run_id ${taskResult.task_run_id} was not persisted`,
      );
    }
    const costs = await input.db
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
      .where(eq(cost_ledger.task_run_id, taskResult.task_run_id));
    if (run.status !== 'success' || costs.length === 0) {
      throw new Error(
        `review regression ${fixture.case_id} is missing successful provider/model/cost provenance`,
      );
    }
    const actualFailureCodes = new Set(review.failure_codes);
    const expectationMet =
      review.verdict === 'fail' &&
      fixture.expected_failure_codes.every((code) => actualFailureCodes.has(code));
    results.push({
      case_id: fixture.case_id,
      subject_id: fixture.subject_id,
      package_digest_sha256: packageDigest,
      expected_failure_codes: fixture.expected_failure_codes,
      expectation_met: expectationMet,
      review_task_run_id: taskResult.task_run_id,
      raw_output_sha256: parsedReview.raw_output_sha256,
      review_parse_error: parsedReview.parse_error,
      review,
      run,
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
