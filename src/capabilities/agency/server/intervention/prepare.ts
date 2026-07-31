import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/server/conjecture/probe-evidence';
import { resolveSubjectProfileForKnowledgeIdsStrict } from '@/capabilities/knowledge/public';
import type {
  InterventionPackageT,
  InterventionPreparationAttemptT,
} from '@/core/schema/intervention';
import {
  CurrentInterventionPackageReviewAudit,
  InterventionPreparationAttempt,
  MAX_INTERVENTION_PACKAGE_ATTEMPTS,
  buildInterventionPackageReviewTaskInput,
  buildInterventionQuestionContentValidationTaskInput,
  validateInterventionPackageDeterministically,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { type TaskTextRunFn, taskPromptFingerprint } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { inArray } from 'drizzle-orm';
import { recommendPedagogy } from './recommend';
import {
  type InterventionRecord,
  activateIntervention,
  appendPreparationAttempt,
  failInterventionPreparation,
  loadInterventionVersion,
  saveRecommendation,
} from './store';

export type AuthorInterventionPackageFn = (
  db: Db,
  interventionId: string,
  deps: { attempt: 1 | 2; runTaskFn?: TaskTextRunFn; preparationJobId: string },
) => Promise<InterventionPreparationAttemptT>;

export interface PrepareInterventionWaveDeps {
  runTaskFn?: TaskTextRunFn;
  authorPackageFn: AuthorInterventionPackageFn;
  now?: () => Date;
}

export type PrepareInterventionWaveResult =
  | {
      status: 'active';
      intervention_id: string;
      version: number;
      idempotent: boolean;
      delivery_mode: 'shadow' | 'eligible';
    }
  | {
      status: 'preparation_failed';
      intervention_id: string;
      version: number;
      reason_code: string;
      idempotent: boolean;
    }
  | {
      status: 'skipped';
      intervention_id: string;
      version: number;
      terminal_status: string;
    };

async function revalidateForPaidPreparationStage(
  db: Db,
  input: {
    interventionId: string;
    version: number;
    idempotencyKey: string;
    preparationJobId: string;
  },
  now: Date,
): Promise<
  | { status: 'ready'; record: InterventionRecord }
  | { status: 'terminal'; result: PrepareInterventionWaveResult }
> {
  const record = await loadInterventionVersion(db, input.interventionId, input.version);
  if (!record) {
    throw new Error(`intervention ${input.interventionId}@${input.version} was not found`);
  }
  if (record.idempotency_key !== input.idempotencyKey) {
    throw new Error(`intervention ${input.interventionId}@${input.version} idempotency mismatch`);
  }
  if (record.status === 'active') {
    return {
      status: 'terminal',
      result: {
        status: 'active',
        intervention_id: record.id,
        version: record.version,
        idempotent: true,
        delivery_mode: record.delivery_mode,
      },
    };
  }
  if (record.status === 'preparation_failed') {
    return {
      status: 'terminal',
      result: {
        status: 'preparation_failed',
        intervention_id: record.id,
        version: record.version,
        reason_code: record.failure_code ?? 'preparation_failed',
        idempotent: true,
      },
    };
  }
  if (record.status !== 'preparing') {
    return {
      status: 'terminal',
      result: {
        status: 'skipped',
        intervention_id: record.id,
        version: record.version,
        terminal_status: record.status,
      },
    };
  }
  if (record.preparation_job_id !== input.preparationJobId) {
    return {
      status: 'terminal',
      result: {
        status: 'skipped',
        intervention_id: record.id,
        version: record.version,
        terminal_status: 'preparation_job_superseded',
      },
    };
  }

  const effective = await getEffectiveProbeResultStatuses(
    db,
    [record.source_probe_result_event_id],
    { validateDirectChain: true },
  );
  if (effective.get(record.source_probe_result_event_id) === 'active') {
    return { status: 'ready', record };
  }

  const failed = await failInterventionPreparation(db, {
    interventionId: record.id,
    version: record.version,
    expectedPreparationJobId: input.preparationJobId,
    failureCode: 'source_evidence_inactive',
    now,
  });
  if (failed.status === 'preparation_failed') {
    return {
      status: 'terminal',
      result: {
        status: 'preparation_failed',
        intervention_id: failed.id,
        version: failed.version,
        reason_code: failed.failure_code ?? 'source_evidence_inactive',
        idempotent: false,
      },
    };
  }
  // Restore/recovery may have replaced the operational job between the read
  // and the serialized failure write. The old worker must become a no-op.
  return {
    status: 'terminal',
    result: {
      status: 'skipped',
      intervention_id: failed.id,
      version: failed.version,
      terminal_status:
        failed.preparation_job_id === input.preparationJobId
          ? failed.status
          : 'preparation_job_superseded',
    },
  };
}

async function bindAttemptToRecord(
  db: Db,
  record: InterventionRecord,
  attempt: InterventionPreparationAttemptT,
): Promise<InterventionPreparationAttemptT> {
  if (attempt.kind === 'author_failed') return attempt;
  const failures =
    record.recommendation?.kind === 'recommendation'
      ? validateInterventionPackageDeterministically(
          { snapshot: record.snapshot, recommendation: record.recommendation },
          attempt.package,
        )
      : [];
  const expectedRuns: Array<{
    id: string;
    taskKind: 'SolutionGenerateTask' | 'QuizVerifyTask' | 'InterventionPackageReviewTask';
    inputHash: string;
    promptFingerprint: string;
    resultDigest?: string | null;
    failureCode: string;
  }> = [];
  if (
    attempt.package.intervention_id !== record.id ||
    attempt.package.intervention_version !== record.version
  ) {
    failures.push('agency:lineage_mismatch');
  }
  if (
    !record.recommendation ||
    record.recommendation.kind !== 'recommendation' ||
    attempt.package.method_id !== record.recommendation.method_id ||
    attempt.package.method_definition_version !== record.recommendation.method_definition_version
  ) {
    failures.push('agency:method_mismatch');
  }
  if (attempt.review.package_digest_sha256 !== sha256CanonicalJson(attempt.package)) {
    failures.push('agency:review_package_digest_mismatch');
  }
  const currentReviewAudit = CurrentInterventionPackageReviewAudit.safeParse(attempt.review);
  if (!currentReviewAudit.success) {
    failures.push('agency:current_full_review_required');
  }
  if (!('independent_solution_audit' in attempt.review)) {
    failures.push('agency:independent_solution_audit_missing');
  } else if (currentReviewAudit.success) {
    const currentReview = currentReviewAudit.data;
    const independentAudit = currentReview.independent_solution_audit;
    const subjectProfile = await resolveSubjectProfileForKnowledgeIdsStrict(db, [
      record.snapshot.conjecture.knowledge_id,
    ]);
    const solverPromptFingerprint = taskPromptFingerprint('SolutionGenerateTask', subjectProfile);
    const reviewPromptFingerprint = taskPromptFingerprint(
      'InterventionPackageReviewTask',
      subjectProfile,
    );
    const contentPromptFingerprint = taskPromptFingerprint('QuizVerifyTask', subjectProfile);
    if (independentAudit.package_digest_sha256 !== sha256CanonicalJson(attempt.package)) {
      failures.push('agency:independent_solution_package_digest_mismatch');
    }
    for (const diagnostic of independentAudit.diagnostics) {
      const packageDiagnostic = attempt.package.diagnostics[diagnostic.kind];
      if (
        diagnostic.task_input.prompt_md !== packageDiagnostic.probe_spec.prompt_md ||
        diagnostic.task_input.kind !== packageDiagnostic.probe_spec.response_mode
      ) {
        failures.push(`agency:${diagnostic.kind}:independent_solution_input_mismatch`);
      }
      if (diagnostic.question_input_sha256 !== sha256CanonicalJson(diagnostic.task_input)) {
        failures.push(`agency:${diagnostic.kind}:independent_solution_input_digest_mismatch`);
      }
      if (diagnostic.solver_output_sha256 !== sha256CanonicalJson(diagnostic.solver_output)) {
        failures.push(`agency:${diagnostic.kind}:independent_solution_output_digest_mismatch`);
      }
      if (diagnostic.task_input.subject_id !== subjectProfile.id) {
        failures.push(`agency:${diagnostic.kind}:independent_solution_subject_mismatch`);
      }
      for (const taskRunId of diagnostic.solver_attempt_task_run_ids) {
        expectedRuns.push({
          id: taskRunId,
          taskKind: 'SolutionGenerateTask',
          inputHash: diagnostic.question_input_sha256,
          promptFingerprint: solverPromptFingerprint,
          ...(taskRunId === diagnostic.solver_task_run_id
            ? { resultDigest: diagnostic.solver_output_sha256 }
            : {}),
          failureCode: `agency:${diagnostic.kind}:solver_task_run_invalid`,
        });
      }
    }
    if (record.recommendation?.kind === 'recommendation') {
      const questionContentValidationAudit = currentReview.question_content_validation_audit;
      if (
        questionContentValidationAudit.package_digest_sha256 !==
        sha256CanonicalJson(attempt.package)
      ) {
        failures.push('agency:question_content_validation_package_digest_mismatch');
      }
      for (const diagnostic of questionContentValidationAudit.diagnostics) {
        const expectedInput = buildInterventionQuestionContentValidationTaskInput({
          context: { snapshot: record.snapshot, recommendation: record.recommendation },
          packageValue: attempt.package,
          kind: diagnostic.kind,
          subjectId: subjectProfile.id,
        });
        const expectedInputHash = sha256CanonicalJson(expectedInput);
        if (
          sha256CanonicalJson(diagnostic.task_input) !== expectedInputHash ||
          diagnostic.task_input_sha256 !== expectedInputHash
        ) {
          failures.push(`agency:${diagnostic.kind}:question_content_validation_input_mismatch`);
        }
        if (diagnostic.result_sha256 !== sha256CanonicalJson(diagnostic.result)) {
          failures.push(`agency:${diagnostic.kind}:question_content_validation_output_mismatch`);
        }
        expectedRuns.push({
          id: diagnostic.task_run_id,
          taskKind: 'QuizVerifyTask',
          inputHash: expectedInputHash,
          promptFingerprint: contentPromptFingerprint,
          resultDigest: diagnostic.result_sha256,
          failureCode: `agency:${diagnostic.kind}:question_content_validation_task_run_invalid`,
        });
      }
      const reviewTaskInputSha256 = sha256CanonicalJson(
        buildInterventionPackageReviewTaskInput({
          context: { snapshot: record.snapshot, recommendation: record.recommendation },
          packageValue: attempt.package,
          independentAudit,
          questionContentValidationAudit,
        }),
      );
      if (currentReview.review_task_input_sha256 !== reviewTaskInputSha256) {
        failures.push('agency:review_task_input_digest_mismatch');
      }
      for (const reviewAttempt of currentReview.review_attempts) {
        expectedRuns.push({
          id: reviewAttempt.task_run_id,
          taskKind: 'InterventionPackageReviewTask',
          inputHash: reviewTaskInputSha256,
          promptFingerprint: reviewPromptFingerprint,
          resultDigest:
            reviewAttempt.outcome === 'valid' ? sha256CanonicalJson(reviewAttempt.result) : null,
          failureCode: 'agency:review_task_run_invalid',
        });
      }
    }
  }
  if (expectedRuns.length > 0) {
    const rows = await db
      .select({
        id: ai_task_runs.id,
        task_kind: ai_task_runs.task_kind,
        input_hash: ai_task_runs.input_hash,
        prompt_fingerprint: ai_task_runs.prompt_fingerprint,
        result_digest: ai_task_runs.result_digest,
        status: ai_task_runs.status,
      })
      .from(ai_task_runs)
      .where(
        inArray(
          ai_task_runs.id,
          expectedRuns.map((run) => run.id),
        ),
      );
    const rowById = new Map(rows.map((row) => [row.id, row]));
    for (const expected of expectedRuns) {
      const row = rowById.get(expected.id);
      if (
        !row ||
        row.status !== 'success' ||
        row.task_kind !== expected.taskKind ||
        row.input_hash !== expected.inputHash ||
        row.prompt_fingerprint !== expected.promptFingerprint ||
        (expected.resultDigest !== undefined && row.result_digest !== expected.resultDigest)
      ) {
        failures.push(expected.failureCode);
      }
    }
  }
  return InterventionPreparationAttempt.parse({
    ...attempt,
    deterministic_failure_codes: [...new Set(failures)].sort(),
  });
}

function passingAttempt(
  attempts: InterventionPreparationAttemptT[],
): Extract<InterventionPreparationAttemptT, { kind: 'reviewed_package' }> | null {
  for (const attempt of attempts) {
    const packageDigest =
      attempt.kind === 'reviewed_package' ? sha256CanonicalJson(attempt.package) : null;
    const currentReview =
      attempt.kind === 'reviewed_package'
        ? CurrentInterventionPackageReviewAudit.safeParse(attempt.review)
        : null;
    if (
      attempt.kind === 'reviewed_package' &&
      currentReview?.success &&
      currentReview.data.package_digest_sha256 === packageDigest &&
      currentReview.data.independent_solution_audit.package_digest_sha256 === packageDigest &&
      currentReview.data.result.verdict === 'pass' &&
      attempt.deterministic_failure_codes.length === 0
    ) {
      return attempt;
    }
  }
  return null;
}

function terminalAttemptFailure(attempt: InterventionPreparationAttemptT | undefined): string {
  if (!attempt) return 'package_attempt_missing';
  if (attempt.kind === 'author_failed') return attempt.failure_code;
  const codes = [...attempt.review.result.failure_codes, ...attempt.deterministic_failure_codes];
  return codes.length > 0
    ? `package_quality:${[...new Set(codes)].sort().join(',')}`
    : 'package_failed';
}

export async function prepareInterventionWave(
  db: Db,
  input: {
    interventionId: string;
    version: number;
    idempotencyKey: string;
    preparationJobId: string;
  },
  deps: PrepareInterventionWaveDeps,
): Promise<PrepareInterventionWaveResult> {
  const initialGuard = await revalidateForPaidPreparationStage(
    db,
    input,
    deps.now?.() ?? new Date(),
  );
  if (initialGuard.status === 'terminal') return initialGuard.result;
  let record = initialGuard.record;

  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  if (!record.recommendation) {
    const subjectProfile = await resolveSubjectProfileForKnowledgeIdsStrict(db, [
      record.snapshot.conjecture.knowledge_id,
    ]);
    const recommendation = await recommendPedagogy({
      snapshot: record.snapshot,
      runTaskFn,
      subjectProfile,
    });
    record = await saveRecommendation(db, record, recommendation, deps.now?.() ?? new Date());
  }

  const authorStageGuard = await revalidateForPaidPreparationStage(
    db,
    input,
    deps.now?.() ?? new Date(),
  );
  if (authorStageGuard.status === 'terminal') return authorStageGuard.result;
  record = authorStageGuard.record;

  if (!record.recommendation) {
    // A concurrent writer won the optimistic update but did not expose a valid
    // recommendation. Reload once; persistent absence is an invariant failure
    // that should be retried, not silently translated into a generic KC task.
    record = (await loadInterventionVersion(db, input.interventionId, input.version)) ?? record;
    if (!record.recommendation) throw new Error('intervention recommendation did not persist');
  }
  if (record.recommendation.kind === 'abstain') {
    const failed = await failInterventionPreparation(db, {
      interventionId: record.id,
      version: record.version,
      expectedPreparationJobId: input.preparationJobId,
      failureCode: `recommendation:${record.recommendation.reason_code}`,
      now: deps.now?.() ?? new Date(),
    });
    if (failed.status !== 'preparation_failed') {
      return {
        status: 'skipped',
        intervention_id: failed.id,
        version: failed.version,
        terminal_status:
          failed.preparation_job_id === input.preparationJobId
            ? failed.status
            : 'preparation_job_superseded',
      };
    }
    return {
      status: 'preparation_failed',
      intervention_id: failed.id,
      version: failed.version,
      reason_code: failed.failure_code ?? 'recommendation_abstained',
      idempotent: false,
    };
  }

  while (record.status === 'preparing') {
    const attemptStageGuard = await revalidateForPaidPreparationStage(
      db,
      input,
      deps.now?.() ?? new Date(),
    );
    if (attemptStageGuard.status === 'terminal') return attemptStageGuard.result;
    record = attemptStageGuard.record;

    // Crash/recovery can resume after an attempt was appended but before it was
    // activated. Re-bind every persisted attempt against current deterministic
    // checks, authoritative subject prompt, and live run ledger before using it.
    // Keep cardinality unchanged so an invalid old attempt still consumes its slot.
    const reboundAttempts = await Promise.all(
      record.preparation_attempts.map((attempt) => bindAttemptToRecord(db, record, attempt)),
    );
    const passed = passingAttempt(reboundAttempts);
    if (passed) {
      const active = await activateIntervention(db, {
        interventionId: record.id,
        version: record.version,
        preparationJobId: input.preparationJobId,
        package: passed.package,
        now: deps.now?.() ?? new Date(),
      });
      if (active.status === 'preparation_failed') {
        return {
          status: 'preparation_failed',
          intervention_id: active.id,
          version: active.version,
          reason_code: active.failure_code ?? 'source_evidence_inactive',
          idempotent: false,
        };
      }
      if (active.status !== 'active') {
        return {
          status: 'skipped',
          intervention_id: active.id,
          version: active.version,
          terminal_status:
            active.preparation_job_id === input.preparationJobId
              ? active.status
              : 'preparation_job_superseded',
        };
      }
      return {
        status: 'active',
        intervention_id: active.id,
        version: active.version,
        idempotent: false,
        delivery_mode: active.delivery_mode,
      };
    }

    if (record.preparation_attempts.length >= MAX_INTERVENTION_PACKAGE_ATTEMPTS) {
      const reason = terminalAttemptFailure(reboundAttempts.at(-1));
      const failed = await failInterventionPreparation(db, {
        interventionId: record.id,
        version: record.version,
        expectedPreparationJobId: input.preparationJobId,
        failureCode: reason,
        now: deps.now?.() ?? new Date(),
      });
      if (failed.status !== 'preparation_failed') {
        return {
          status: 'skipped',
          intervention_id: failed.id,
          version: failed.version,
          terminal_status:
            failed.preparation_job_id === input.preparationJobId
              ? failed.status
              : 'preparation_job_superseded',
        };
      }
      return {
        status: 'preparation_failed',
        intervention_id: failed.id,
        version: failed.version,
        reason_code: failed.failure_code ?? reason,
        idempotent: false,
      };
    }

    const attemptNumber = (record.preparation_attempts.length + 1) as 1 | 2;
    const authored = await deps.authorPackageFn(db, record.id, {
      attempt: attemptNumber,
      runTaskFn,
      preparationJobId: input.preparationJobId,
    });
    if (authored.attempt !== attemptNumber) {
      throw new Error(
        `QuestionAuthor returned attempt ${authored.attempt}; expected ${attemptNumber}`,
      );
    }
    const postAuthorGuard = await revalidateForPaidPreparationStage(
      db,
      input,
      deps.now?.() ?? new Date(),
    );
    if (postAuthorGuard.status === 'terminal') return postAuthorGuard.result;
    record = postAuthorGuard.record;
    const boundAttempt = await bindAttemptToRecord(db, record, authored);
    record = await appendPreparationAttempt(db, record, boundAttempt, deps.now?.() ?? new Date());
    if (record.status !== 'preparing') break;
  }

  if (record.status === 'active') {
    return {
      status: 'active',
      intervention_id: record.id,
      version: record.version,
      idempotent: true,
      delivery_mode: record.delivery_mode,
    };
  }
  if (record.status === 'preparation_failed') {
    return {
      status: 'preparation_failed',
      intervention_id: record.id,
      version: record.version,
      reason_code: record.failure_code ?? 'preparation_failed',
      idempotent: true,
    };
  }
  return {
    status: 'skipped',
    intervention_id: record.id,
    version: record.version,
    terminal_status: record.status,
  };
}
