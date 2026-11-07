import { AgentRunError } from '@/ai/agent-run-error';
import type { TaskTextResult } from '@/ai/task-result';
import { getLearnerLocale } from '@/capabilities/task-registry';
import { parseJsonObjectLoose } from '@/core/json-extract';
import {
  INTERVENTION_CONTRACT_VERSION,
  type InterventionAuthoringContextT,
  InterventionIndependentSolutionAudit,
  type InterventionIndependentSolutionAuditT,
  InterventionPackage,
  InterventionPackageModelOutput,
  type InterventionPackageModelOutputT,
  type InterventionPackageT,
  type InterventionPreparationAttemptT,
  InterventionQuestionContentValidationAudit,
  type InterventionQuestionContentValidationAuditT,
  MAX_INTERVENTION_SOLVER_ATTEMPTS_PER_DIAGNOSTIC,
  buildInterventionQuestionContentValidationTaskInput,
  interventionRequiredOperationDigest,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { authorInterventionPackage as runInterventionAuthorSequence } from '@/kernel/records/intervention-package-author';
import { type TaskTextRunFn, taskPromptFingerprint } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { persistValidatorRunBinding } from '@/server/ai/sealed-validation';
import type { SubjectProfile } from '@/subjects/profile';
import {
  type IndependentSolutionResult,
  runIndependentSolution,
  runQuestionContentValidation,
} from './quiz/verify-framework';

export interface InterventionAuthorDeps {
  runTaskFn?: TaskTextRunFn;
  attempt?: 1 | 2;
  preparationJobId: string;
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
    // Task outputs are immediately validated by closed strict schemas below, so
    // an exactly-boundary partial batch cannot be admitted.
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
  learnerLocale: 'zh-CN' | 'en';
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
    input.learnerLocale,
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
      let attemptBindingFailure = '';
      for (const taskRunId of attemptTaskRunIds) {
        try {
          await persistValidatorRunBinding(input.db, {
            taskRunId,
            taskKind: 'SolutionGenerateTask',
            taskInputSha256: blindTaskInputSha256,
            promptFingerprint: solverPromptFingerprint,
            ...(attempt.status === 'solved' && taskRunId === attempt.task_run_id
              ? { resultDigest: attempt.solver_output_sha256 }
              : {}),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          // An unusable solver output is already terminally fail-closed. Keep
          // that primary domain reason (and its bounded retry behavior) even
          // when a custom/test runner also failed to persist the reported run.
          // A structurally solved output still requires an exact durable bind.
          if (attempt.status === 'solved') {
            return {
              status: 'invalid',
              failureCode: `independent_solution_binding_failed:${kind}`,
              taskRunIds: [...taskRunIds, ...attemptTaskRunIds],
              failureDetail: detail,
            };
          }
          attemptBindingFailure = `reported solver run could not be bound (${detail})`;
        }
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
      failureDetail = [attempt.reason, attemptBindingFailure].filter(Boolean).join('; ');
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
  learnerLocale: 'zh-CN' | 'en';
}): Promise<
  | { status: 'ok'; audit: InterventionQuestionContentValidationAuditT }
  | { status: 'invalid'; failureCode: string; taskRunIds: string[]; failureDetail?: string }
> {
  const taskRunIds: string[] = [];
  const diagnostics: InterventionQuestionContentValidationAuditT['diagnostics'] = [];
  const packageDigest = sha256CanonicalJson(input.packageValue);
  const promptFingerprint = taskPromptFingerprint(
    'QuizVerifyTask',
    input.subjectProfile,
    input.learnerLocale,
  );

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
    try {
      await persistValidatorRunBinding(input.db, {
        taskRunId,
        taskKind: 'QuizVerifyTask',
        taskInputSha256: validation.task_input_sha256,
        promptFingerprint,
        resultDigest: validation.output_sha256,
      });
    } catch (error) {
      return {
        status: 'invalid',
        failureCode: `question_content_validation_binding_failed:${kind}`,
        taskRunIds,
        failureDetail: error instanceof Error ? error.message : String(error),
      };
    }
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

interface InterventionPackageAdmissionInput {
  db: Db;
  runTaskFn: TaskTextRunFn;
  context: InterventionAuthoringContextT;
  packageValue: InterventionPackageT;
  subjectProfile: ResolvedSubjectProfile;
  beforeEachPaidCall: () => Promise<string | null>;
}

type InterventionPackageAdmissionResult =
  | {
      status: 'ok';
      independentSolutionAudit: InterventionIndependentSolutionAuditT;
      questionContentValidationAudit: InterventionQuestionContentValidationAuditT;
    }
  | { status: 'invalid'; failureCode: string; taskRunIds: string[]; failureDetail?: string };

/**
 * Shared admission validators for an already-authored package: three strict
 * blind solves plus three release-strict grounding checks via the shared
 * question validators. The same-model package comparator that used to consume
 * their sealed output is retired; activation reads the audits directly.
 */
async function validateInterventionPackageAdmission(
  input: InterventionPackageAdmissionInput,
): Promise<InterventionPackageAdmissionResult> {
  const learnerLocale = getLearnerLocale();
  const runTaskFn: TaskTextRunFn = (kind, taskInput, ctx) =>
    input.runTaskFn(kind, taskInput, { ...ctx, learnerLocale });
  const independentlySolved = await runInterventionIndependentSolutions({
    db: input.db,
    runTaskFn,
    packageValue: input.packageValue,
    subjectProfile: input.subjectProfile,
    learnerLocale,
    beforeEachPaidCall: input.beforeEachPaidCall,
  });
  if (independentlySolved.status === 'invalid') return independentlySolved;

  const contentValidated = await runInterventionQuestionContentValidations({
    db: input.db,
    runTaskFn,
    context: input.context,
    packageValue: input.packageValue,
    subjectProfile: input.subjectProfile,
    learnerLocale,
    beforeEachPaidCall: input.beforeEachPaidCall,
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
  return {
    status: 'ok',
    independentSolutionAudit: independentlySolved.audit,
    questionContentValidationAudit: contentValidated.audit,
  };
}

export const interventionAuthorStages = {
  authorPackage: runPackageAuthor,
  validatePackage: validateInterventionPackageAdmission,
};

/**
 * Intervention-scoped QuestionAuthor public entry.
 *
 * The only domain identifier supplied by the caller is `interventionId`.
 * The attempt sequence (guards, subject profile, deterministic check) lives in
 * the kernel. This module supplies the paid author and admission-validator
 * stages.
 */
export async function authorInterventionPackage(
  db: Db,
  interventionId: string,
  deps: InterventionAuthorDeps,
): Promise<InterventionPreparationAttemptT> {
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  return runInterventionAuthorSequence(
    db,
    interventionId,
    {
      attempt: deps.attempt ?? 1,
      preparationJobId: deps.preparationJobId,
      runTaskFn,
    },
    interventionAuthorStages,
  );
}
