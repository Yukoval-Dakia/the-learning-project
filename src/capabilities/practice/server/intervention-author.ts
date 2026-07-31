import { tasks } from '@/ai/registry';
import {
  type InterventionAuthoringContextT,
  guardInterventionPreparationStage,
} from '@/capabilities/agency/public';
import { resolveSubjectProfileForKnowledgeIdsStrict } from '@/capabilities/knowledge/public';
import {
  CurrentInterventionPackageReviewAudit,
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION,
  InterventionIndependentSolutionAudit,
  type InterventionIndependentSolutionAuditT,
  InterventionPackage,
  InterventionPackageModelOutput,
  type InterventionPackageModelOutputT,
  type InterventionPackageReviewAuditT,
  InterventionPackageReviewModelOutputFull,
  type InterventionPackageReviewModelOutputFullT,
  InterventionPackageReviewModelOutputV2,
  type InterventionPackageReviewModelOutputV2T,
  type InterventionPackageReviewRequirementsT,
  InterventionPackageReviewStructuredOutput,
  type InterventionPackageReviewStructuredOutputT,
  type InterventionPackageT,
  InterventionPreparationAttempt,
  type InterventionPreparationAttemptT,
  InterventionQuestionContentValidationAudit,
  type InterventionQuestionContentValidationAuditT,
  MAX_INTERVENTION_REVIEW_ATTEMPTS,
  MAX_INTERVENTION_SOLVER_ATTEMPTS_PER_DIAGNOSTIC,
  buildInterventionPackageReviewTaskInput,
  buildInterventionQuestionContentValidationTaskInput,
  extractInterventionReferenceReverseCausationClaims,
  interventionRequiredOperationDigest,
  validateInterventionPackageDeterministically,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { AgentRunError } from '@/server/ai/agent-run-error';
import { parseJsonObjectLoose } from '@/server/ai/json-extract';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import {
  type TaskTextResult,
  type TaskTextRunFn,
  taskPromptFingerprint,
} from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import {
  type IndependentSolutionResult,
  runIndependentSolution,
  runQuestionContentValidation,
} from '@/server/quiz/verify-framework';
import type { SubjectProfile } from '@/subjects/profile';
import { and, eq } from 'drizzle-orm';

export interface InterventionAuthorDeps {
  runTaskFn?: TaskTextRunFn;
  attempt?: 1 | 2;
  preparationJobId: string;
}

const authorOutputSchema = tasks.InterventionPackageAuthorTask.structuredOutputSchema;
const AUTHOR_OUTPUT_FORMAT = authorOutputSchema
  ? zodToJsonSchemaOutputFormat(authorOutputSchema)
  : undefined;
const reviewOutputSchema = tasks.InterventionPackageReviewTask.structuredOutputSchema;
const REVIEW_OUTPUT_FORMAT = reviewOutputSchema
  ? zodToJsonSchemaOutputFormat(reviewOutputSchema)
  : undefined;

async function persistValidatorRunBinding(
  db: Db,
  input: {
    taskRunId: string;
    taskKind: 'SolutionGenerateTask' | 'QuizVerifyTask' | 'InterventionPackageReviewTask';
    taskInputSha256: string;
    promptFingerprint: string;
    resultDigest?: string | null;
  },
): Promise<void> {
  await db
    .update(ai_task_runs)
    .set({
      prompt_fingerprint: input.promptFingerprint,
      ...(input.resultDigest !== undefined ? { result_digest: input.resultDigest } : {}),
    })
    .where(
      and(
        eq(ai_task_runs.id, input.taskRunId),
        eq(ai_task_runs.task_kind, input.taskKind),
        eq(ai_task_runs.input_hash, input.taskInputSha256),
        eq(ai_task_runs.status, 'success'),
      ),
    );
}

function parseTaskOutput<T>(
  result: TaskTextResult,
  label: string,
  parse: (value: unknown) => T,
): T {
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return parse(result.structured_output);
  }
  const extracted = parseJsonObjectLoose(result.text, label, {
    riskyRepair: 'reject',
    // Both author/review outputs are immediately validated by closed strict
    // schemas below, so an exactly-boundary partial batch cannot be admitted.
    containerClosure: 'schema_validated',
    latexEscapes: 'markdown_math',
  });
  if (!extracted) throw new Error(`${label} did not contain a JSON object`);
  return parse(extracted.json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Freeze server-owned diagnostic identity fields and repair the one unambiguous
 * nesting slip observed from the Mimo text fallback. Generated question/material
 * content is untouched and still passes the strict package schema below.
 */
export function normalizeInterventionPackageModelOutput(
  value: unknown,
  identity: { testedClaimMd: string; targetErrorRuleMd: string },
): InterventionPackageModelOutputT {
  if (!isRecord(value) || !isRecord(value.diagnostics)) {
    return InterventionPackageModelOutput.parse(value);
  }

  const diagnostics = { ...value.diagnostics };
  for (const kind of ['immediate', 'delayed', 'transfer'] as const) {
    const rawDiagnostic = diagnostics[kind];
    if (!isRecord(rawDiagnostic)) continue;
    const normalizedIdentityFields = [
      rawDiagnostic.tested_claim_md !== identity.testedClaimMd ? 'tested_claim_md' : null,
      rawDiagnostic.target_error_rule_md !== identity.targetErrorRuleMd
        ? 'target_error_rule_md'
        : null,
    ].filter((field): field is string => field !== null);
    if (normalizedIdentityFields.length > 0) {
      console.warn('[intervention-author] normalized server-owned diagnostic identities', {
        diagnostic_kind: kind,
        fields: normalizedIdentityFields,
      });
    }
    const diagnostic: Record<string, unknown> = {
      ...rawDiagnostic,
      tested_claim_md: identity.testedClaimMd,
      target_error_rule_md: identity.targetErrorRuleMd,
    };
    if (kind === 'transfer' && isRecord(rawDiagnostic.probe_spec)) {
      const { context_change_md: misplacedContextChangeMd, ...probeSpec } =
        rawDiagnostic.probe_spec;
      if (
        typeof diagnostic.context_change_md !== 'string' &&
        typeof misplacedContextChangeMd === 'string'
      ) {
        diagnostic.context_change_md = misplacedContextChangeMd;
      }
      diagnostic.probe_spec = probeSpec;
    }
    diagnostics[kind] = diagnostic;
  }

  return InterventionPackageModelOutput.parse({ ...value, diagnostics });
}

/**
 * Bind the reviewer's auditable per-diagnostic findings to the closed verdict.
 * This never repairs package content. It only prevents a contradictory bare
 * `pass` from overriding the reviewer's own reference/scope/grounding checks.
 */
export function enforceInterventionPackageReviewDecision(
  review: InterventionPackageReviewModelOutputV2T,
): InterventionPackageReviewModelOutputV2T {
  // Provider verdict/failure labels are not authority. Recompute the complete
  // closed decision from granular observations every time so an invented code,
  // omitted code or contradictory bare `pass` cannot affect activation.
  const failureCodes = new Set<InterventionPackageReviewModelOutputV2T['failure_codes'][number]>();
  for (const check of review.diagnostic_checks) {
    const rejectedReverseCausationClaim =
      check.causal_direction_check.applies &&
      check.causal_direction_check.reference_claims_reverse_causation &&
      ((check.causal_direction_check.reference_reverse_causation_claim_checks?.some(
        (claim) => !claim.claimed_cause_is_observed_y_causing_x,
      ) ??
        false) ||
        check.causal_direction_check.claimed_cause_is_observed_y_causing_x === false);
    if (!check.reference_correct || !check.discipline_grounded || rejectedReverseCausationClaim) {
      failureCodes.add('reference_incorrect');
    }
    if (!check.within_frozen_scope) {
      failureCodes.add('claim_scope_expansion');
    }
    for (const operation of check.required_operation_checks ?? []) {
      if (!operation.reference_covers_operation) failureCodes.add('reference_incorrect');
      if (!operation.within_frozen_scope) failureCodes.add('claim_scope_expansion');
    }
  }
  const packageChecks = review.package_checks;
  if (packageChecks) {
    if (!packageChecks.material_grounded) failureCodes.add('material_not_grounded');
    if (!packageChecks.method_followed) failureCodes.add('method_not_followed');
    if (!packageChecks.tested_claims_match) failureCodes.add('tested_claim_mismatch');
    if (!packageChecks.target_errors_match) failureCodes.add('target_error_mismatch');
    if (!packageChecks.answers_unique) failureCodes.add('answer_not_unique');
    if (!packageChecks.answers_gradable) failureCodes.add('answer_not_gradable');
    if (!packageChecks.no_answer_leak) failureCodes.add('answer_leak');
    if (!packageChecks.diagnostics_same_construct) {
      failureCodes.add('diagnostics_not_same_construct');
    }
    if (!packageChecks.transfer_context_changed) {
      failureCodes.add('transfer_context_not_changed');
    }
    if (!packageChecks.target_error_identifiable) {
      failureCodes.add('target_error_not_identifiable');
    }
    if (!packageChecks.serious_factual_error_absent) {
      failureCodes.add('serious_factual_error');
    }
    if (!packageChecks.safe_material) failureCodes.add('unsafe_material');
  }
  return InterventionPackageReviewModelOutputV2.parse({
    ...review,
    verdict: failureCodes.size === 0 ? 'pass' : 'fail',
    failure_codes: [...failureCodes].sort(),
  });
}

const INTERVENTION_DIAGNOSTIC_KINDS = ['immediate', 'delayed', 'transfer'] as const;

type ResolvedSubjectProfile = SubjectProfile;

function boundedAuditText(value: string, maxLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

async function runInterventionIndependentSolutions(input: {
  db: Db;
  runTaskFn: TaskTextRunFn;
  packageValue: InterventionPackageT;
  subjectProfile: ResolvedSubjectProfile;
  beforeEachPaidCall: () => Promise<string | null>;
}): Promise<
  | {
      status: 'ok';
      audit: InterventionIndependentSolutionAuditT;
    }
  | { status: 'invalid'; failureCode: string; taskRunIds: string[]; failureDetail?: string }
> {
  const taskRunIds: string[] = [];
  const auditDiagnostics: InterventionIndependentSolutionAuditT['diagnostics'] = [];
  const packageDigest = sha256CanonicalJson(input.packageValue);
  const solverPromptFingerprint = taskPromptFingerprint(
    'SolutionGenerateTask',
    input.subjectProfile,
  );

  for (const kind of INTERVENTION_DIAGNOSTIC_KINDS) {
    const diagnostic = input.packageValue.diagnostics[kind];
    const blindQuestion = {
      id: `${input.packageValue.intervention_id}:v${input.packageValue.intervention_version}:${kind}`,
      kind: diagnostic.probe_spec.response_mode,
      prompt_md: diagnostic.probe_spec.prompt_md,
      choices_md: null,
      image_refs: null,
      figures: null,
    } as const;
    const blindTaskInput = {
      prompt_md: blindQuestion.prompt_md,
      kind: blindQuestion.kind,
      subject_id: input.subjectProfile.id,
      choices_md: [],
      existing_answers_hint: null,
      existing_analysis_hint: null,
      figures_hint: null,
      prompt_image_refs: [],
    };
    const blindTaskInputSha256 = sha256CanonicalJson(blindTaskInput);
    const solverAttemptTaskRunIds: string[] = [];
    let solved: Extract<IndependentSolutionResult, { status: 'solved' }> | null = null;
    let failureDetail = '';
    // MiMo emits text JSON rather than SDK-native structured output. A paid
    // response can therefore be syntactically repairable yet still miss the
    // complete SolutionGenerateOutput contract. Retry that exact blind input at
    // most once; never accept a partial result, and audit every attempted run.
    for (
      let solverAttempt = 1;
      solverAttempt <= MAX_INTERVENTION_SOLVER_ATTEMPTS_PER_DIAGNOSTIC;
      solverAttempt += 1
    ) {
      const guardFailure = await input.beforeEachPaidCall();
      if (guardFailure) {
        return { status: 'invalid', failureCode: guardFailure, taskRunIds };
      }
      const attempt = await runIndependentSolution(blindQuestion, {
        db: input.db,
        runTaskFn: input.runTaskFn,
        profile: { id: input.subjectProfile.id, full: input.subjectProfile },
      });
      const attemptTaskRunIds =
        attempt.status === 'solved' ? [attempt.task_run_id] : (attempt.task_run_ids ?? []);
      for (const taskRunId of attemptTaskRunIds) {
        await persistValidatorRunBinding(input.db, {
          taskRunId,
          taskKind: 'SolutionGenerateTask',
          taskInputSha256: blindTaskInputSha256,
          promptFingerprint: solverPromptFingerprint,
          ...(attempt.status === 'solved' && taskRunId === attempt.task_run_id
            ? { resultDigest: attempt.solver_output_sha256 }
            : {}),
        });
      }
      if (attempt.status === 'solved') {
        if (attempt.task_input_sha256 !== blindTaskInputSha256) {
          return {
            status: 'invalid',
            failureCode: `independent_solution_input_mismatch:${kind}`,
            taskRunIds: [...taskRunIds, attempt.task_run_id],
          };
        }
        solved = attempt;
        taskRunIds.push(attempt.task_run_id);
        solverAttemptTaskRunIds.push(attempt.task_run_id);
        break;
      }
      taskRunIds.push(...attemptTaskRunIds);
      solverAttemptTaskRunIds.push(...attemptTaskRunIds);
      failureDetail = attempt.reason;
      if (!attempt.retryable || solverAttempt === MAX_INTERVENTION_SOLVER_ATTEMPTS_PER_DIAGNOSTIC) {
        break;
      }
    }
    if (!solved) {
      return {
        status: 'invalid',
        failureCode: `independent_solution_unavailable:${kind}`,
        taskRunIds,
        ...(failureDetail ? { failureDetail } : {}),
      };
    }
    const solution = solved.solution;

    const questionInputSha256 = solved.task_input_sha256;
    const solverOutputSha256 = solved.solver_output_sha256;
    const independentlyDerivedAnswer = boundedAuditText(
      solution.reference_solution.final_answer,
      480,
    );
    const requiredOperations = boundedAuditText(
      solution.reference_solution.expected_signals.join('；'),
      320,
    );
    const solverTaskRunId = solved.task_run_id;
    if (!solverTaskRunId || !independentlyDerivedAnswer || !requiredOperations) {
      return {
        status: 'invalid',
        failureCode: `independent_solution_unavailable:${kind}`,
        taskRunIds,
      };
    }
    auditDiagnostics.push({
      kind,
      task_input:
        solved.task_input as InterventionIndependentSolutionAuditT['diagnostics'][number]['task_input'],
      question_input_sha256: questionInputSha256,
      solver_output: solution,
      solver_output_sha256: solverOutputSha256,
      solver_output_repair_level: solved.solver_output_repair_level,
      solver_task_run_id: solverTaskRunId,
      solver_attempt_task_run_ids: solverAttemptTaskRunIds,
      independently_derived_answer_md: independentlyDerivedAnswer,
      required_operations_md: requiredOperations,
      required_operations: solution.reference_solution.expected_signals.map(
        (operationMd, operationIndex) => ({
          operation_index: operationIndex,
          operation_sha256: interventionRequiredOperationDigest(operationMd),
          operation_md: operationMd,
        }),
      ),
    });
  }

  return {
    status: 'ok',
    audit: InterventionIndependentSolutionAudit.parse({
      validation_protocol_version: 1,
      package_digest_sha256: packageDigest,
      diagnostics: auditDiagnostics,
    }),
  };
}

async function runInterventionQuestionContentValidations(input: {
  db: Db;
  runTaskFn: TaskTextRunFn;
  context: InterventionAuthoringContextT;
  packageValue: InterventionPackageT;
  subjectProfile: ResolvedSubjectProfile;
  beforeEachPaidCall: () => Promise<string | null>;
}): Promise<
  | { status: 'ok'; audit: InterventionQuestionContentValidationAuditT }
  | { status: 'invalid'; failureCode: string; taskRunIds: string[]; failureDetail?: string }
> {
  const taskRunIds: string[] = [];
  const diagnostics: InterventionQuestionContentValidationAuditT['diagnostics'] = [];
  const packageDigest = sha256CanonicalJson(input.packageValue);
  const promptFingerprint = taskPromptFingerprint('QuizVerifyTask', input.subjectProfile);

  for (const kind of INTERVENTION_DIAGNOSTIC_KINDS) {
    const guardFailure = await input.beforeEachPaidCall();
    if (guardFailure) return { status: 'invalid', failureCode: guardFailure, taskRunIds };
    const taskInput = buildInterventionQuestionContentValidationTaskInput({
      context: input.context,
      packageValue: input.packageValue,
      kind,
      subjectId: input.subjectProfile.id,
    });
    const taskInputSha256 = sha256CanonicalJson(taskInput);

    let validation: Awaited<ReturnType<typeof runQuestionContentValidation>>;
    try {
      validation = await runQuestionContentValidation(taskInput, {
        runTaskFn: input.runTaskFn,
        db: input.db,
        subjectProfile: input.subjectProfile,
        afterTaskRun: async (taskResult) => {
          if (!taskResult.task_run_id) return;
          taskRunIds.push(taskResult.task_run_id);
          // The paid run exists even if strict parsing fails. Seal its canonical
          // input/prompt immediately with a null result digest, then replace the
          // digest only after the complete QuizVerificationResult parses.
          await persistValidatorRunBinding(input.db, {
            taskRunId: taskResult.task_run_id,
            taskKind: 'QuizVerifyTask',
            taskInputSha256,
            promptFingerprint,
            resultDigest: null,
          });
        },
      });
    } catch (error) {
      if (error instanceof AgentRunError && !taskRunIds.includes(error.taskRunId)) {
        taskRunIds.push(error.taskRunId);
      }
      return {
        status: 'invalid',
        failureCode: `question_content_validation_unavailable:${kind}`,
        taskRunIds,
        failureDetail: error instanceof Error ? error.message : String(error),
      };
    }
    const taskRunId = validation.task_result.task_run_id;
    if (!taskRunId) {
      return {
        status: 'invalid',
        failureCode: `question_content_validation_task_run_id_missing:${kind}`,
        taskRunIds,
      };
    }
    if (validation.output_repair_level === 'jsonrepair') {
      return {
        status: 'invalid',
        failureCode: `question_content_validation_unavailable:${kind}`,
        taskRunIds,
        failureDetail: 'release-strict content validation cannot seal heuristic JSON repair',
      };
    }
    if (!taskRunIds.includes(taskRunId)) taskRunIds.push(taskRunId);
    await persistValidatorRunBinding(input.db, {
      taskRunId,
      taskKind: 'QuizVerifyTask',
      taskInputSha256: validation.task_input_sha256,
      promptFingerprint,
      resultDigest: validation.output_sha256,
    });
    diagnostics.push({
      kind,
      task_input: validation.task_input,
      task_input_sha256: validation.task_input_sha256,
      result: validation.output,
      result_sha256: validation.output_sha256,
      output_repair_level: validation.output_repair_level,
      task_run_id: taskRunId,
    });
  }

  return {
    status: 'ok',
    audit: InterventionQuestionContentValidationAudit.parse({
      validation_protocol_version: 1,
      package_digest_sha256: packageDigest,
      diagnostics,
    }),
  };
}

/** Join comparator judgments with the immutable blind-solve evidence. */
export function bindInterventionPackageReviewDecision(
  value: unknown,
  independentAudit: InterventionIndependentSolutionAuditT,
  questionContentValidationAudit: InterventionQuestionContentValidationAuditT,
  requirements: InterventionPackageReviewRequirementsT,
  packageValue: InterventionPackageT,
): InterventionPackageReviewModelOutputFullT {
  const modelValue: InterventionPackageReviewStructuredOutputT =
    InterventionPackageReviewStructuredOutput.parse(value);
  const auditByKind = new Map(
    independentAudit.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic]),
  );
  if (
    questionContentValidationAudit.package_digest_sha256 !== independentAudit.package_digest_sha256
  ) {
    throw new Error('question-content validation package digest does not match blind solve');
  }
  const contentValidationByKind = new Map(
    questionContentValidationAudit.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic]),
  );
  const claimsByKind = new Map(
    INTERVENTION_DIAGNOSTIC_KINDS.map((kind) => [
      kind,
      extractInterventionReferenceReverseCausationClaims(packageValue, kind),
    ]),
  );
  const {
    verdict: _providerVerdict,
    failure_codes: _providerFailureCodes,
    ...providerObservations
  } = modelValue;
  const bound = InterventionPackageReviewModelOutputV2.parse({
    ...providerObservations,
    verdict: 'pass',
    failure_codes: [],
    diagnostic_checks: modelValue.diagnostic_checks.map((check) => {
      const sealed = auditByKind.get(check.kind);
      if (!sealed) throw new Error(`missing sealed independent solution for ${check.kind}`);
      const contentValidation = contentValidationByKind.get(check.kind);
      if (!contentValidation) {
        throw new Error(`missing sealed question-content validation for ${check.kind}`);
      }
      const claims = claimsByKind.get(check.kind) ?? [];
      if (
        (requirements.causal_direction_required || claims.length > 0) &&
        !check.causal_direction_check.applies
      ) {
        throw new Error(`comparator omitted required causal-direction review for ${check.kind}`);
      }
      const claimRelations =
        check.causal_direction_check.reference_reverse_causation_claim_relations;
      if (claimRelations.length !== claims.length) {
        throw new Error(
          `comparator omitted server-owned reverse-causation claims for ${check.kind}`,
        );
      }
      for (const [index, relation] of claimRelations.entries()) {
        if (relation.claim_index !== claims[index]?.claim_index) {
          throw new Error(
            `comparator referenced the wrong reverse-causation claim ${index} for ${check.kind}`,
          );
        }
      }
      if (check.required_operation_checks.length !== sealed.required_operations.length) {
        throw new Error(`comparator omitted required solution operations for ${check.kind}`);
      }
      const requiredOperationChecks = check.required_operation_checks.map(
        (operationCheck, index) => {
          const sealedOperation = sealed.required_operations[index];
          if (
            !sealedOperation ||
            operationCheck.operation_index !== sealedOperation.operation_index
          ) {
            throw new Error(
              `comparator referenced the wrong sealed operation ${index} for ${check.kind}`,
            );
          }
          return {
            ...operationCheck,
            operation_sha256: sealedOperation.operation_sha256,
            operation_md: sealedOperation.operation_md,
          };
        },
      );
      const aggregateRelation =
        claimRelations.length === 0
          ? ('none' as const)
          : claimRelations.every((claim) => claim.relation === 'same_outcome_construct_y')
            ? ('same_outcome_construct_y' as const)
            : claimRelations.some(
                  (claim) => claim.relation === 'baseline_or_prior_different_construct',
                )
              ? ('baseline_or_prior_different_construct' as const)
              : ('common_cause_or_other_or_unclear' as const);
      const referenceClaimText = boundedAuditText(
        claims.map((claim) => `${claim.source_path}: ${claim.claim_md}`).join('\n'),
        2000,
      );
      return {
        ...check,
        // release_strict grounding is an independent, server-sealed hard gate.
        // Comparator agreement can only make this stricter, never override an
        // unclear/fail factuality result from the shared question validator.
        discipline_grounded:
          check.discipline_grounded && contentValidation.result.grounding.verdict === 'pass',
        independent_solution_sha256: sealed.solver_output_sha256,
        independently_derived_answer_md: sealed.independently_derived_answer_md,
        required_operations_md: sealed.required_operations_md,
        required_operation_checks: requiredOperationChecks,
        causal_direction_check: {
          applies: check.causal_direction_check.applies,
          exposure_x_md: check.causal_direction_check.exposure_x_md,
          observed_outcome_y_md: check.causal_direction_check.observed_outcome_y_md,
          reference_claims_reverse_causation: claims.length > 0,
          reference_claimed_reverse_cause_md: referenceClaimText,
          reference_claimed_reverse_cause_relation: aggregateRelation,
          reference_reverse_causation_claim_checks: claims.map((claim, index) => {
            const providerRelation = claimRelations[index];
            if (!providerRelation) {
              throw new Error(`missing bound reverse-causation claim ${index} for ${check.kind}`);
            }
            return {
              ...claim,
              relation: providerRelation.relation,
              decision_basis_md: providerRelation.decision_basis_md,
              claimed_cause_is_observed_y_causing_x:
                providerRelation.relation === 'same_outcome_construct_y',
            };
          }),
          claimed_cause_is_observed_y_causing_x:
            claims.length > 0 && aggregateRelation === 'same_outcome_construct_y',
        },
      };
    }),
  });
  const enforced = enforceInterventionPackageReviewDecision(bound);
  const providerRaisedUnboundFailure =
    enforced.verdict === 'pass' &&
    ((_providerVerdict !== undefined && _providerVerdict !== 'pass') ||
      (_providerFailureCodes?.length ?? 0) > 0);
  return InterventionPackageReviewModelOutputFull.parse(
    providerRaisedUnboundFailure
      ? {
          ...enforced,
          verdict: 'fail',
          failure_codes: ['review_output_invalid'],
        }
      : enforced,
  );
}

async function runPackageAuthor(
  runTaskFn: TaskTextRunFn,
  context: InterventionAuthoringContextT,
  subjectProfile: ResolvedSubjectProfile,
): Promise<
  | { status: 'ok'; package: InterventionPackageT }
  | { status: 'invalid'; taskRunId?: string; failureCode: string }
> {
  const result = await runTaskFn(
    'InterventionPackageAuthorTask',
    {
      snapshot: context.snapshot,
      recommendation: context.recommendation,
      output_contract: {
        material_count: 1,
        diagnostic_kinds: ['immediate', 'delayed', 'transfer'],
        tested_claim_md: context.snapshot.conjecture.claim_md,
        target_error_rule_md: context.snapshot.conjecture.target_error_rule_md,
      },
    },
    {
      subjectProfile,
      ...(AUTHOR_OUTPUT_FORMAT ? { outputFormat: AUTHOR_OUTPUT_FORMAT } : {}),
    },
  );
  if (!result.task_run_id) {
    return { status: 'invalid', failureCode: 'author_task_run_id_missing' };
  }

  let draft: InterventionPackageModelOutputT;
  try {
    draft = parseTaskOutput(result, 'intervention package author', (value) =>
      normalizeInterventionPackageModelOutput(value, {
        testedClaimMd: context.snapshot.conjecture.claim_md,
        targetErrorRuleMd: context.snapshot.conjecture.target_error_rule_md,
      }),
    );
  } catch {
    return {
      status: 'invalid',
      taskRunId: result.task_run_id,
      failureCode: 'author_output_invalid',
    };
  }
  return {
    status: 'ok',
    package: InterventionPackage.parse({
      ...draft,
      intervention_id: context.snapshot.intervention_id,
      intervention_version: context.snapshot.intervention_version,
      package_version: INTERVENTION_CONTRACT_VERSION,
      method_id: context.recommendation.method_id,
      method_definition_version: context.recommendation.method_definition_version,
      author_task_run_id: result.task_run_id,
    }),
  };
}

async function runPackageReview(
  db: Db,
  runTaskFn: TaskTextRunFn,
  context: InterventionAuthoringContextT,
  packageValue: InterventionPackageT,
  subjectProfile: ResolvedSubjectProfile,
  independentAudit: InterventionIndependentSolutionAuditT,
  questionContentValidationAudit: InterventionQuestionContentValidationAuditT,
  beforeEachPaidCall: () => Promise<string | null>,
): Promise<
  | { status: 'ok'; review: InterventionPackageReviewAuditT }
  | { status: 'invalid'; failureCode: string; taskRunIds: string[]; failureDetail?: string }
> {
  const packageDigest = sha256CanonicalJson(packageValue);
  if (independentAudit.package_digest_sha256 !== packageDigest) {
    return {
      status: 'invalid',
      failureCode: 'independent_solution_package_digest_mismatch',
      taskRunIds: [],
    };
  }
  if (questionContentValidationAudit.package_digest_sha256 !== packageDigest) {
    return {
      status: 'invalid',
      failureCode: 'question_content_validation_package_digest_mismatch',
      taskRunIds: [],
    };
  }
  const reviewTaskInput = buildInterventionPackageReviewTaskInput({
    context,
    packageValue,
    independentAudit,
    questionContentValidationAudit,
  });
  const reviewTaskInputSha256 = sha256CanonicalJson(reviewTaskInput);
  const promptFingerprint = taskPromptFingerprint('InterventionPackageReviewTask', subjectProfile);
  const reviewAttemptTaskRunIds: string[] = [];
  const reviewAttempts: Array<
    | { task_run_id: string; outcome: 'contract_invalid' }
    | { task_run_id: string; outcome: 'valid'; result: InterventionPackageReviewModelOutputFullT }
  > = [];
  let failureDetail = '';

  for (
    let reviewAttempt = 1;
    reviewAttempt <= MAX_INTERVENTION_REVIEW_ATTEMPTS;
    reviewAttempt += 1
  ) {
    const guardFailure = await beforeEachPaidCall();
    if (guardFailure) {
      return {
        status: 'invalid',
        failureCode: guardFailure,
        taskRunIds: reviewAttemptTaskRunIds,
        ...(failureDetail ? { failureDetail } : {}),
      };
    }
    let result: TaskTextResult;
    try {
      result = await runTaskFn('InterventionPackageReviewTask', reviewTaskInput, {
        subjectProfile,
        ...(REVIEW_OUTPUT_FORMAT ? { outputFormat: REVIEW_OUTPUT_FORMAT } : {}),
      });
    } catch (error) {
      // A lifecycle-started runner error already owns a durable paid-attempt id.
      // Return it as an invalid validator attempt so the enclosing package slot
      // is appended and consumed; do not let pg-boss redelivery reset the same
      // author/solver/comparator budget. Custom runners without an id still
      // consume the package slot rather than escaping into an unbounded retry.
      const failedTaskRunIds = [...reviewAttemptTaskRunIds];
      if (error instanceof AgentRunError && !failedTaskRunIds.includes(error.taskRunId)) {
        failedTaskRunIds.push(error.taskRunId);
      }
      return {
        status: 'invalid',
        failureCode: 'review_runner_failure',
        taskRunIds: failedTaskRunIds,
        failureDetail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.task_run_id) {
      return {
        status: 'invalid',
        failureCode: 'review_task_run_id_missing',
        taskRunIds: reviewAttemptTaskRunIds,
      };
    }
    reviewAttemptTaskRunIds.push(result.task_run_id);
    await persistValidatorRunBinding(db, {
      taskRunId: result.task_run_id,
      taskKind: 'InterventionPackageReviewTask',
      taskInputSha256: reviewTaskInputSha256,
      promptFingerprint,
    });

    let review: InterventionPackageReviewModelOutputFullT;
    try {
      review = parseTaskOutput(result, 'intervention package review', (value) =>
        bindInterventionPackageReviewDecision(
          value,
          independentAudit,
          questionContentValidationAudit,
          reviewTaskInput.review_requirements,
          packageValue,
        ),
      );
    } catch (error) {
      const issues =
        isRecord(error) && Array.isArray(error.issues)
          ? error.issues
              .slice(0, 4)
              .map((issue) =>
                isRecord(issue)
                  ? `${Array.isArray(issue.path) ? issue.path.join('.') : '<root>'}:${String(issue.code ?? 'invalid')}`
                  : 'invalid',
              )
              .join(', ')
          : error instanceof Error
            ? error.name
            : 'invalid';
      failureDetail = `comparator output did not satisfy the FULL review contract (${issues})`;
      console.warn('[intervention-author] comparator contract rejected', {
        attempt: reviewAttempt,
        issues,
      });
      reviewAttempts.push({ task_run_id: result.task_run_id, outcome: 'contract_invalid' });
      await persistValidatorRunBinding(db, {
        taskRunId: result.task_run_id,
        taskKind: 'InterventionPackageReviewTask',
        taskInputSha256: reviewTaskInputSha256,
        promptFingerprint,
        resultDigest: null,
      });
      if (reviewAttempt < MAX_INTERVENTION_REVIEW_ATTEMPTS) continue;
      return {
        status: 'invalid',
        failureCode: 'review_output_invalid',
        taskRunIds: reviewAttemptTaskRunIds,
        failureDetail,
      };
    }

    await persistValidatorRunBinding(db, {
      taskRunId: result.task_run_id,
      taskKind: 'InterventionPackageReviewTask',
      taskInputSha256: reviewTaskInputSha256,
      promptFingerprint,
      resultDigest: sha256CanonicalJson(review),
    });
    reviewAttempts.push({ task_run_id: result.task_run_id, outcome: 'valid', result: review });
    if (review.verdict === 'pass' && reviewAttempt < MAX_INTERVENTION_REVIEW_ATTEMPTS) {
      continue;
    }
    if (
      review.verdict === 'pass' &&
      reviewAttempts.some(
        (attempt) => attempt.outcome !== 'valid' || attempt.result.verdict !== 'pass',
      )
    ) {
      return {
        status: 'invalid',
        failureCode: 'review_output_invalid',
        taskRunIds: reviewAttemptTaskRunIds,
        failureDetail: 'a valid pass was not confirmed within the bounded comparator attempts',
      };
    }
    return {
      status: 'ok',
      review: CurrentInterventionPackageReviewAudit.parse({
        audit_protocol_version: INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION,
        review_version: INTERVENTION_CONTRACT_VERSION,
        package_digest_sha256: packageDigest,
        review_task_run_id: result.task_run_id,
        review_attempt_task_run_ids: reviewAttemptTaskRunIds,
        review_task_input_sha256: reviewTaskInputSha256,
        independent_solution_audit: independentAudit,
        question_content_validation_audit: questionContentValidationAudit,
        review_attempts: reviewAttempts,
        result: review,
      }),
    };
  }
  throw new Error('unreachable comparator retry state');
}

/**
 * FULL validator for an already-authored package: three strict blind solves and
 * three release-strict grounding checks via the shared question validators,
 * followed by a bounded sealed-output comparator/confirmation.
 */
export async function reviewInterventionPackageCandidate(input: {
  db: Db;
  runTaskFn: TaskTextRunFn;
  context: InterventionAuthoringContextT;
  packageValue: InterventionPackageT;
  subjectProfile: ResolvedSubjectProfile;
  beforeEachPaidCall?: () => Promise<string | null>;
}): Promise<
  | { status: 'ok'; review: InterventionPackageReviewAuditT }
  | { status: 'invalid'; failureCode: string; taskRunIds: string[]; failureDetail?: string }
> {
  const beforeEachPaidCall = input.beforeEachPaidCall ?? (async () => null);
  // Claim discovery is deterministic and bounded. Run it before any paid solve
  // so an adversarially repetitive answer surface cannot spend six calls and
  // then escape as an uncaught preparation-job retry.
  try {
    for (const kind of INTERVENTION_DIAGNOSTIC_KINDS) {
      extractInterventionReferenceReverseCausationClaims(input.packageValue, kind);
    }
  } catch (error) {
    return {
      status: 'invalid',
      failureCode: 'reverse_causation_claim_extraction_invalid',
      taskRunIds: [],
      failureDetail: error instanceof Error ? error.message : String(error),
    };
  }
  const independentlySolved = await runInterventionIndependentSolutions({
    db: input.db,
    runTaskFn: input.runTaskFn,
    packageValue: input.packageValue,
    subjectProfile: input.subjectProfile,
    beforeEachPaidCall,
  });
  if (independentlySolved.status === 'invalid') return independentlySolved;

  const contentValidated = await runInterventionQuestionContentValidations({
    db: input.db,
    runTaskFn: input.runTaskFn,
    context: input.context,
    packageValue: input.packageValue,
    subjectProfile: input.subjectProfile,
    beforeEachPaidCall,
  });
  if (contentValidated.status === 'invalid') {
    return {
      ...contentValidated,
      taskRunIds: [
        ...independentlySolved.audit.diagnostics.flatMap(
          (diagnostic) => diagnostic.solver_attempt_task_run_ids,
        ),
        ...contentValidated.taskRunIds,
      ],
    };
  }

  const reviewed = await runPackageReview(
    input.db,
    input.runTaskFn,
    input.context,
    input.packageValue,
    input.subjectProfile,
    independentlySolved.audit,
    contentValidated.audit,
    beforeEachPaidCall,
  );
  if (reviewed.status === 'invalid') {
    return {
      ...reviewed,
      taskRunIds: [
        ...independentlySolved.audit.diagnostics.flatMap(
          (diagnostic) => diagnostic.solver_attempt_task_run_ids,
        ),
        ...contentValidated.audit.diagnostics.map((diagnostic) => diagnostic.task_run_id),
        ...reviewed.taskRunIds,
      ],
    };
  }
  return reviewed;
}

/**
 * Intervention-scoped QuestionAuthor public entry.
 *
 * The only domain identifier supplied by the caller is `interventionId`.
 * Snapshot and recommendation are hydrated from Agency's public reader; raw
 * claim/evidence/method/package inputs cannot bypass authoritative lineage.
 */
export async function authorInterventionPackage(
  db: Db,
  interventionId: string,
  deps: InterventionAuthorDeps,
): Promise<InterventionPreparationAttemptT> {
  const attempt = deps.attempt ?? 1;
  const authorGuard = await guardInterventionPreparationStage(
    db,
    interventionId,
    deps.preparationJobId,
  );
  if (authorGuard.status !== 'ready') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      failure_code: authorGuard.status,
    });
  }
  const context = authorGuard.context;
  const subjectProfile = await resolveSubjectProfileForKnowledgeIdsStrict(db, [
    context.snapshot.conjecture.knowledge_id,
  ]);
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);

  const authored = await runPackageAuthor(runTaskFn, context, subjectProfile);
  if (authored.status === 'invalid') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      ...(authored.taskRunId ? { author_task_run_id: authored.taskRunId } : {}),
      failure_code: authored.failureCode,
    });
  }

  const reviewGuard = await guardInterventionPreparationStage(
    db,
    interventionId,
    deps.preparationJobId,
  );
  if (reviewGuard.status !== 'ready') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      author_task_run_id: authored.package.author_task_run_id,
      failure_code: reviewGuard.status,
    });
  }

  let nextGuard: Awaited<ReturnType<typeof guardInterventionPreparationStage>> | null = reviewGuard;
  // Comparator is a separate invocation, but it no longer self-certifies its
  // blind solve. The shared FULL validator performs three strict solves first.
  const reviewed = await reviewInterventionPackageCandidate({
    db,
    runTaskFn,
    context: reviewGuard.context,
    packageValue: authored.package,
    subjectProfile,
    beforeEachPaidCall: async () => {
      const guard =
        nextGuard ??
        (await guardInterventionPreparationStage(db, interventionId, deps.preparationJobId));
      nextGuard = null;
      return guard.status === 'ready' ? null : guard.status;
    },
  });
  if (reviewed.status === 'invalid') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      author_task_run_id: authored.package.author_task_run_id,
      ...(reviewed.taskRunIds.length > 0 ? { validator_task_run_ids: reviewed.taskRunIds } : {}),
      failure_code: reviewed.failureCode,
    });
  }
  const deterministicFailures = validateInterventionPackageDeterministically(
    context,
    authored.package,
  );
  return InterventionPreparationAttempt.parse({
    kind: 'reviewed_package',
    attempt,
    package: authored.package,
    review: reviewed.review,
    deterministic_failure_codes: deterministicFailures,
  });
}
