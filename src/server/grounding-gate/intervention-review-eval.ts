import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { reviewInterventionPackageCandidate } from '@/capabilities/practice/public';
import {
  CurrentInterventionPackageReviewAudit,
  InterventionAuthoringContext,
  InterventionPackage,
  InterventionPackageReviewFailureCode,
  buildInterventionPackageReviewTaskInput,
  buildInterventionQuestionContentValidationTaskInput,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { ai_task_runs, cost_ledger } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { AgentRunError } from '@/server/ai/agent-run-error';
import { type TaskTextRunFn, taskPromptFingerprint } from '@/server/ai/provenance';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';

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

export interface ExpectedValidatorTaskRun {
  id: string;
  taskKind?: 'SolutionGenerateTask' | 'QuizVerifyTask' | 'InterventionPackageReviewTask';
  inputHash?: string;
  promptFingerprint?: string;
  resultDigest?: string | null;
}

type TaskRunProvenance = Awaited<ReturnType<typeof collectTaskRunProvenance>>;

function appendProvenanceIssues(
  provenance: TaskRunProvenance,
  extraIssues: string[],
): TaskRunProvenance {
  const issues = [...new Set([...provenance.issues, ...extraIssues])];
  return { ...provenance, complete: issues.length === 0, issues };
}

function uniqueTaskRunIds(values: string[]): string[] {
  return [...new Set(values)];
}

export async function collectTaskRunProvenance(
  db: Db,
  expectedRuns: ExpectedValidatorTaskRun[],
): Promise<{
  complete: boolean;
  issues: string[];
  runs: Array<Record<string, unknown>>;
  costs: Array<Record<string, unknown>>;
}> {
  const runs: Array<Record<string, unknown>> = [];
  const costs: Array<Record<string, unknown>> = [];
  const issues: string[] = [];
  if (expectedRuns.length === 0) issues.push('task_runs_empty');
  for (const expected of expectedRuns) {
    const taskRunId = expected.id;
    if (!expected.taskKind || !expected.inputHash || !expected.promptFingerprint) {
      issues.push(`task_run_not_observed:${taskRunId}`);
    }
    try {
      const [run] = await db
        .select({
          task_kind: ai_task_runs.task_kind,
          provider: ai_task_runs.provider,
          model: ai_task_runs.model,
          input_hash: ai_task_runs.input_hash,
          prompt_fingerprint: ai_task_runs.prompt_fingerprint,
          result_digest: ai_task_runs.result_digest,
          status: ai_task_runs.status,
          usage: ai_task_runs.usage_json,
          cost_usd: ai_task_runs.cost_usd,
          cost_basis: ai_task_runs.cost_basis,
          cost_ref: ai_task_runs.cost_ref,
        })
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, taskRunId))
        .limit(1);
      if (!run) {
        issues.push(`task_run_missing:${taskRunId}`);
        continue;
      }
      const runCosts = await db
        .select({
          task_kind: cost_ledger.task_kind,
          provider: cost_ledger.provider,
          model: cost_ledger.model,
          cost: cost_ledger.cost,
          currency: cost_ledger.currency,
          entry_kind: cost_ledger.entry_kind,
          cost_basis: cost_ledger.cost_basis,
          cost_ref: cost_ledger.cost_ref,
          tokens_in: cost_ledger.tokens_in,
          tokens_out: cost_ledger.tokens_out,
          outcome: cost_ledger.outcome,
        })
        .from(cost_ledger)
        // YUK-841: provenance is about the authoritative model attempt, not
        // loose-coupled legacy correlation rows that may legally share this ID.
        .where(and(eq(cost_ledger.task_run_id, taskRunId), eq(cost_ledger.entry_kind, 'attempt')));
      if (run.status !== 'success') issues.push(`task_run_not_success:${taskRunId}`);
      if (run.provider !== 'xiaomi' || run.model !== 'mimo-v2.5-pro') {
        issues.push(`task_run_wrong_route:${taskRunId}`);
      }
      if (expected.taskKind && run.task_kind !== expected.taskKind) {
        issues.push(`task_run_wrong_kind:${taskRunId}`);
      }
      if (expected.inputHash && run.input_hash !== expected.inputHash) {
        issues.push(`task_run_wrong_input:${taskRunId}`);
      }
      if (expected.promptFingerprint && run.prompt_fingerprint !== expected.promptFingerprint) {
        issues.push(`task_run_wrong_prompt:${taskRunId}`);
      }
      if (expected.resultDigest !== undefined && run.result_digest !== expected.resultDigest) {
        issues.push(`task_run_wrong_result:${taskRunId}`);
      }
      if (typeof run.cost_usd !== 'number' || !Number.isFinite(run.cost_usd) || run.cost_usd < 0) {
        issues.push(`task_run_cost_invalid:${taskRunId}`);
      }
      if (
        !run.usage ||
        typeof run.usage !== 'object' ||
        !Number.isInteger((run.usage as { inputTokens?: unknown }).inputTokens) ||
        Number((run.usage as { inputTokens?: unknown }).inputTokens) < 0 ||
        !Number.isInteger((run.usage as { outputTokens?: unknown }).outputTokens) ||
        Number((run.usage as { outputTokens?: unknown }).outputTokens) < 0
      ) {
        issues.push(`task_run_usage_invalid:${taskRunId}`);
      }
      if (runCosts.length === 0) issues.push(`task_run_cost_missing:${taskRunId}`);
      if (runCosts.length > 1) issues.push(`task_run_cost_duplicate:${taskRunId}`);
      const authoritativeCost = runCosts[0];
      if (
        authoritativeCost &&
        (run.cost_usd !== authoritativeCost.cost ||
          run.cost_basis !== authoritativeCost.cost_basis ||
          run.cost_ref !== authoritativeCost.cost_ref)
      ) {
        issues.push(`task_run_cost_projection_mismatch:${taskRunId}`);
      }
      for (const cost of runCosts) {
        if (
          cost.task_kind !== expected.taskKind ||
          cost.provider !== 'xiaomi' ||
          cost.model !== 'mimo-v2.5-pro' ||
          cost.outcome !== 'success' ||
          cost.currency !== 'USD'
        ) {
          issues.push(`task_run_cost_wrong_route_or_outcome:${taskRunId}`);
        }
        if (
          typeof cost.cost !== 'number' ||
          !Number.isFinite(cost.cost) ||
          cost.cost < 0 ||
          !Number.isInteger(cost.tokens_in) ||
          cost.tokens_in < 0 ||
          !Number.isInteger(cost.tokens_out) ||
          cost.tokens_out < 0
        ) {
          issues.push(`task_run_cost_invalid:${taskRunId}`);
        }
      }
      runs.push({ task_run_id: taskRunId, ...run });
      costs.push(...runCosts.map((cost) => ({ task_run_id: taskRunId, ...cost })));
    } catch {
      issues.push(`task_run_provenance_query_failed:${taskRunId}`);
    }
  }
  return { complete: issues.length === 0, issues, runs, costs };
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
    const subjectProfile = resolveSubjectProfile(fixture.subject_id);
    const observedRuns: ExpectedValidatorTaskRun[] = [];
    const observationIssues: string[] = [];
    const observeTaskRun = (
      taskRunId: string,
      kind: string,
      taskInput: unknown,
      actualProfile: SubjectProfile | undefined,
    ): void => {
      if (observedRuns.some((run) => run.id === taskRunId)) {
        observationIssues.push(`task_run_observed_twice:${taskRunId}`);
        return;
      }
      if (
        kind !== 'SolutionGenerateTask' &&
        kind !== 'QuizVerifyTask' &&
        kind !== 'InterventionPackageReviewTask'
      ) {
        observedRuns.push({ id: taskRunId });
        observationIssues.push(`task_run_unexpected_kind:${taskRunId}:${kind}`);
        return;
      }
      if (!actualProfile) {
        observedRuns.push({
          id: taskRunId,
          taskKind: kind,
          inputHash: sha256CanonicalJson(taskInput),
        });
        observationIssues.push(`task_run_subject_profile_missing:${taskRunId}`);
        return;
      }
      const actualPromptFingerprint = taskPromptFingerprint(kind, actualProfile);
      const expectedPromptFingerprint = taskPromptFingerprint(kind, subjectProfile);
      if (
        actualProfile.id !== subjectProfile.id ||
        actualPromptFingerprint !== expectedPromptFingerprint
      ) {
        observationIssues.push(`task_run_wrong_subject_profile:${taskRunId}`);
      }
      observedRuns.push({
        id: taskRunId,
        taskKind: kind,
        inputHash: sha256CanonicalJson(taskInput),
        promptFingerprint: actualPromptFingerprint,
      });
    };
    const observedRunTaskFn: TaskTextRunFn = async (kind, taskInput, ctx) => {
      try {
        const result = await input.runTaskFn(kind, taskInput, ctx);
        if (result.task_run_id) {
          observeTaskRun(result.task_run_id, kind, taskInput, ctx?.subjectProfile);
        }
        return result;
      } catch (error) {
        if (error instanceof AgentRunError) {
          observeTaskRun(error.taskRunId, kind, taskInput, ctx?.subjectProfile);
        }
        throw error;
      }
    };
    const observedExpectations = (taskRunIds: string[]): ExpectedValidatorTaskRun[] => {
      const byId = new Map(observedRuns.map((run) => [run.id, run]));
      return uniqueTaskRunIds([...taskRunIds, ...observedRuns.map((run) => run.id)]).map(
        (taskRunId) => byId.get(taskRunId) ?? { id: taskRunId },
      );
    };
    let validation: Awaited<ReturnType<typeof reviewInterventionPackageCandidate>>;
    try {
      validation = await reviewInterventionPackageCandidate({
        db: input.db,
        runTaskFn: observedRunTaskFn,
        context: fixture.context,
        packageValue: fixture.package,
        subjectProfile,
      });
    } catch (error) {
      const expectedRuns = observedExpectations([]);
      const provenance = appendProvenanceIssues(
        await collectTaskRunProvenance(input.db, expectedRuns),
        observationIssues,
      );
      results.push({
        case_id: fixture.case_id,
        subject_id: fixture.subject_id,
        package_digest_sha256: packageDigest,
        expected_verdict: fixture.expected_verdict,
        expected_failure_codes: fixture.expected_failure_codes,
        expectation_met: false,
        operational_failure: {
          code: 'validator_exception',
          detail: error instanceof Error ? error.message : String(error),
          provenance_complete: provenance.complete,
          provenance_issues: provenance.issues,
        },
        validator_task_run_ids: expectedRuns.map((run) => run.id),
        independent_solution_task_run_ids: expectedRuns
          .filter((run) => run.taskKind === 'SolutionGenerateTask')
          .map((run) => run.id),
        runs: provenance.runs,
        costs: provenance.costs,
      });
      continue;
    }
    if (validation.status === 'invalid') {
      const expectedRuns = observedExpectations(validation.taskRunIds);
      const provenance = appendProvenanceIssues(
        await collectTaskRunProvenance(input.db, expectedRuns),
        observationIssues,
      );
      results.push({
        case_id: fixture.case_id,
        subject_id: fixture.subject_id,
        package_digest_sha256: packageDigest,
        expected_verdict: fixture.expected_verdict,
        expected_failure_codes: fixture.expected_failure_codes,
        expectation_met: false,
        operational_failure: {
          code: validation.failureCode,
          ...(validation.failureDetail ? { detail: validation.failureDetail } : {}),
          provenance_complete: provenance.complete,
          provenance_issues: provenance.issues,
        },
        validator_task_run_ids: expectedRuns.map((run) => run.id),
        independent_solution_task_run_ids: expectedRuns
          .filter((run) => run.taskKind === 'SolutionGenerateTask')
          .map((run) => run.id),
        runs: provenance.runs,
        costs: provenance.costs,
      });
      continue;
    }
    const currentAudit = CurrentInterventionPackageReviewAudit.safeParse(validation.review);
    if (!currentAudit.success) {
      const expectedRuns = observedExpectations([validation.review.review_task_run_id]);
      const provenance = appendProvenanceIssues(
        await collectTaskRunProvenance(input.db, expectedRuns),
        observationIssues,
      );
      results.push({
        case_id: fixture.case_id,
        subject_id: fixture.subject_id,
        package_digest_sha256: packageDigest,
        expected_verdict: fixture.expected_verdict,
        expected_failure_codes: fixture.expected_failure_codes,
        expectation_met: false,
        operational_failure: {
          code: 'legacy_validation_audit',
          provenance_complete: provenance.complete,
          provenance_issues: provenance.issues,
        },
        validator_task_run_ids: expectedRuns.map((run) => run.id),
        runs: provenance.runs,
        costs: provenance.costs,
      });
      continue;
    }
    const audit = currentAudit.data;
    const review = audit.result;
    if (audit.package_digest_sha256 !== packageDigest) {
      observationIssues.push('audit_package_digest_mismatch');
    }
    for (const diagnostic of audit.independent_solution_audit.diagnostics) {
      const packageDiagnostic = fixture.package.diagnostics[diagnostic.kind];
      if (
        diagnostic.task_input.prompt_md !== packageDiagnostic.probe_spec.prompt_md ||
        diagnostic.task_input.kind !== packageDiagnostic.probe_spec.response_mode ||
        diagnostic.task_input.subject_id !== subjectProfile.id
      ) {
        observationIssues.push(`audit_solver_input_mismatch:${diagnostic.kind}`);
      }
      if (diagnostic.question_input_sha256 !== sha256CanonicalJson(diagnostic.task_input)) {
        observationIssues.push(`audit_solver_input_digest_mismatch:${diagnostic.kind}`);
      }
      if (diagnostic.solver_output_sha256 !== sha256CanonicalJson(diagnostic.solver_output)) {
        observationIssues.push(`audit_solver_output_digest_mismatch:${diagnostic.kind}`);
      }
    }
    const expectedContentInputHashes = new Map(
      audit.question_content_validation_audit.diagnostics.map((diagnostic) => {
        const expectedInput = buildInterventionQuestionContentValidationTaskInput({
          context: fixture.context,
          packageValue: fixture.package,
          kind: diagnostic.kind,
          subjectId: subjectProfile.id,
        });
        const expectedInputHash = sha256CanonicalJson(expectedInput);
        if (
          sha256CanonicalJson(diagnostic.task_input) !== expectedInputHash ||
          diagnostic.task_input_sha256 !== expectedInputHash
        ) {
          observationIssues.push(`audit_content_input_mismatch:${diagnostic.kind}`);
        }
        if (diagnostic.result_sha256 !== sha256CanonicalJson(diagnostic.result)) {
          observationIssues.push(`audit_content_output_digest_mismatch:${diagnostic.kind}`);
        }
        return [diagnostic.kind, expectedInputHash] as const;
      }),
    );
    const expectedReviewTaskInputSha256 = sha256CanonicalJson(
      buildInterventionPackageReviewTaskInput({
        context: fixture.context,
        packageValue: fixture.package,
        independentAudit: audit.independent_solution_audit,
        questionContentValidationAudit: audit.question_content_validation_audit,
      }),
    );
    if (audit.review_task_input_sha256 !== expectedReviewTaskInputSha256) {
      observationIssues.push('audit_review_input_mismatch');
    }
    const independentSolutionTaskRunIds = audit.independent_solution_audit.diagnostics.flatMap(
      (diagnostic) => diagnostic.solver_attempt_task_run_ids,
    );
    const questionContentValidationTaskRunIds =
      audit.question_content_validation_audit.diagnostics.map(
        (diagnostic) => diagnostic.task_run_id,
      );
    const solverPromptFingerprint = taskPromptFingerprint('SolutionGenerateTask', subjectProfile);
    const contentPromptFingerprint = taskPromptFingerprint('QuizVerifyTask', subjectProfile);
    const reviewPromptFingerprint = taskPromptFingerprint(
      'InterventionPackageReviewTask',
      subjectProfile,
    );
    const expectedRuns: ExpectedValidatorTaskRun[] = [
      ...audit.independent_solution_audit.diagnostics.flatMap((diagnostic) =>
        diagnostic.solver_attempt_task_run_ids.map((taskRunId) => ({
          id: taskRunId,
          taskKind: 'SolutionGenerateTask' as const,
          inputHash: diagnostic.question_input_sha256,
          promptFingerprint: solverPromptFingerprint,
          ...(taskRunId === diagnostic.solver_task_run_id
            ? { resultDigest: diagnostic.solver_output_sha256 }
            : {}),
        })),
      ),
      ...audit.question_content_validation_audit.diagnostics.map((diagnostic) => ({
        id: diagnostic.task_run_id,
        taskKind: 'QuizVerifyTask' as const,
        inputHash: expectedContentInputHashes.get(diagnostic.kind),
        promptFingerprint: contentPromptFingerprint,
        resultDigest: sha256CanonicalJson(diagnostic.result),
      })),
      ...audit.review_attempts.map((reviewAttempt) => ({
        id: reviewAttempt.task_run_id,
        taskKind: 'InterventionPackageReviewTask' as const,
        inputHash: expectedReviewTaskInputSha256,
        promptFingerprint: reviewPromptFingerprint,
        resultDigest:
          reviewAttempt.outcome === 'valid' ? sha256CanonicalJson(reviewAttempt.result) : null,
      })),
    ];
    const observedById = new Map(observedRuns.map((run) => [run.id, run]));
    for (const expected of expectedRuns) {
      const observed = observedById.get(expected.id);
      if (!observed) {
        observationIssues.push(`task_run_not_observed:${expected.id}`);
        continue;
      }
      if (observed.taskKind !== expected.taskKind) {
        observationIssues.push(`task_run_observed_wrong_kind:${expected.id}`);
      }
      if (observed.inputHash !== expected.inputHash) {
        observationIssues.push(`task_run_observed_wrong_input:${expected.id}`);
      }
      if (observed.promptFingerprint !== expected.promptFingerprint) {
        observationIssues.push(`task_run_observed_wrong_prompt:${expected.id}`);
      }
    }
    const expectedIds = new Set(expectedRuns.map((run) => run.id));
    for (const observed of observedRuns) {
      if (!expectedIds.has(observed.id)) {
        expectedRuns.push(observed);
        observationIssues.push(`task_run_not_audited:${observed.id}`);
      }
    }
    const provenance = appendProvenanceIssues(
      await collectTaskRunProvenance(input.db, expectedRuns),
      observationIssues,
    );
    const actualFailureCodes = new Set(review.failure_codes);
    const expectationMet =
      provenance.complete &&
      review.verdict === fixture.expected_verdict &&
      fixture.expected_failure_codes.every((code) => actualFailureCodes.has(code));
    results.push({
      case_id: fixture.case_id,
      subject_id: fixture.subject_id,
      package_digest_sha256: packageDigest,
      expected_verdict: fixture.expected_verdict,
      expected_failure_codes: fixture.expected_failure_codes,
      expectation_met: expectationMet,
      validator_task_run_ids: expectedRuns.map((run) => run.id),
      independent_solution_task_run_ids: independentSolutionTaskRunIds,
      question_content_validation_task_run_ids: questionContentValidationTaskRunIds,
      review_task_run_id: audit.review_task_run_id,
      review_attempt_task_run_ids: audit.review_attempt_task_run_ids,
      full_validation_audit_sha256: sha256CanonicalJson(audit),
      full_validation_audit: audit,
      review,
      ...(provenance.complete
        ? {}
        : {
            operational_failure: {
              code: 'task_run_provenance_incomplete',
              provenance_issues: provenance.issues,
            },
          }),
      runs: provenance.runs,
      costs: provenance.costs,
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
