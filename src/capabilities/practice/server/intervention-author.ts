import { tasks } from '@/ai/registry';
import {
  type InterventionAuthoringContextT,
  guardInterventionPreparationStage,
} from '@/capabilities/agency/public';
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/public';
import { evaluateConjectureProbeResponseStructure } from '@/core/schema/business';
import {
  INTERVENTION_CONTRACT_VERSION,
  InterventionIndependentSolutionAudit,
  type InterventionIndependentSolutionAuditT,
  InterventionPackage,
  InterventionPackageModelOutput,
  type InterventionPackageModelOutputT,
  InterventionPackageReviewAudit,
  type InterventionPackageReviewAuditT,
  InterventionPackageReviewModelOutputFull,
  type InterventionPackageReviewModelOutputFullT,
  InterventionPackageReviewModelOutputV2,
  type InterventionPackageReviewModelOutputV2T,
  InterventionPackageReviewStructuredOutput,
  type InterventionPackageReviewStructuredOutputT,
  type InterventionPackageT,
  InterventionPreparationAttempt,
  type InterventionPreparationAttemptT,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { parseJsonObjectLoose } from '@/server/ai/json-extract';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import type { TaskTextResult, TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { runIndependentSolution } from '@/server/quiz/verify-framework';

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

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function answerLeaks(prompt: string, answer: string): boolean {
  const normalizedAnswer = normalizeIdentity(answer);
  // Very short tokens occur frequently in prose, so substring matching would
  // produce excessive false positives. Their leakage remains a reviewer check.
  if (normalizedAnswer.length < 3) return false;
  return normalizeIdentity(prompt).includes(normalizedAnswer);
}

export function validateInterventionPackageDeterministically(
  context: InterventionAuthoringContextT,
  packageValue: InterventionPackageT,
): string[] {
  const failures: string[] = [];
  if (
    packageValue.intervention_id !== context.snapshot.intervention_id ||
    packageValue.intervention_version !== context.snapshot.intervention_version
  ) {
    failures.push('lineage_mismatch');
  }
  if (
    packageValue.method_id !== context.recommendation.method_id ||
    packageValue.method_definition_version !== context.recommendation.method_definition_version
  ) {
    failures.push('method_mismatch');
  }

  const diagnostics = [
    packageValue.diagnostics.immediate,
    packageValue.diagnostics.delayed,
    packageValue.diagnostics.transfer,
  ];
  const promptIdentities = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.tested_claim_md !== context.snapshot.conjecture.claim_md) {
      failures.push(`${diagnostic.kind}:tested_claim_mismatch`);
    }
    if (diagnostic.target_error_rule_md !== context.snapshot.conjecture.target_error_rule_md) {
      failures.push(`${diagnostic.kind}:target_error_mismatch`);
    }
    const probeSpec = diagnostic.probe_spec;
    const promptIdentity = normalizeIdentity(probeSpec.prompt_md);
    if (promptIdentities.has(promptIdentity)) failures.push(`${diagnostic.kind}:duplicate_prompt`);
    promptIdentities.add(promptIdentity);
    for (const code of evaluateConjectureProbeResponseStructure(probeSpec)) {
      failures.push(`${diagnostic.kind}:${code}`);
    }
    if (
      answerLeaks(probeSpec.prompt_md, probeSpec.reference_md) ||
      answerLeaks(probeSpec.prompt_md, probeSpec.expected_target_error_answer_md)
    ) {
      failures.push(`${diagnostic.kind}:answer_leak`);
    }
  }
  if (!packageValue.diagnostics.transfer.context_change_md.trim()) {
    failures.push('transfer:context_change_missing');
  }
  return [...new Set(failures)].sort();
}

/**
 * Bind the reviewer's auditable per-diagnostic findings to the closed verdict.
 * This never repairs package content. It only prevents a contradictory bare
 * `pass` from overriding the reviewer's own reference/scope/grounding checks.
 */
export function enforceInterventionPackageReviewDecision(
  review: InterventionPackageReviewModelOutputV2T,
): InterventionPackageReviewModelOutputV2T {
  const failureCodes = new Set(review.failure_codes);
  for (const check of review.diagnostic_checks) {
    const rejectedReverseCausationClaim =
      check.causal_direction_check.applies &&
      check.causal_direction_check.reference_claims_reverse_causation &&
      check.causal_direction_check.claimed_cause_is_observed_y_causing_x === false;
    if (!check.reference_correct || !check.discipline_grounded || rejectedReverseCausationClaim) {
      failureCodes.add('reference_incorrect');
    }
    if (!check.within_frozen_scope) {
      failureCodes.add('claim_scope_expansion');
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
  if (failureCodes.size === 0) return review;
  return InterventionPackageReviewModelOutputV2.parse({
    ...review,
    verdict: 'fail',
    failure_codes: [...failureCodes].sort(),
  });
}

const INTERVENTION_DIAGNOSTIC_KINDS = ['immediate', 'delayed', 'transfer'] as const;

type ResolvedSubjectProfile = Awaited<ReturnType<typeof resolveSubjectProfileForKnowledgeIds>>;

interface SealedIndependentSolutionForReview {
  kind: (typeof INTERVENTION_DIAGNOSTIC_KINDS)[number];
  question_input_sha256: string;
  solver_output_sha256: string;
  final_answer_md: string;
  answer_equivalents_md: string[];
  expected_signals_md: string[];
  worked_solution_md: string;
  confidence: number;
}

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
      sealedSolutions: SealedIndependentSolutionForReview[];
    }
  | { status: 'invalid'; failureCode: string; taskRunIds: string[] }
> {
  const taskRunIds: string[] = [];
  const auditDiagnostics: InterventionIndependentSolutionAuditT['diagnostics'] = [];
  const sealedSolutions: SealedIndependentSolutionForReview[] = [];
  const packageDigest = sha256CanonicalJson(input.packageValue);

  for (const kind of INTERVENTION_DIAGNOSTIC_KINDS) {
    const guardFailure = await input.beforeEachPaidCall();
    if (guardFailure) {
      return { status: 'invalid', failureCode: guardFailure, taskRunIds };
    }
    const diagnostic = input.packageValue.diagnostics[kind];
    const blindQuestion = {
      id: `${input.packageValue.intervention_id}:v${input.packageValue.intervention_version}:${kind}`,
      kind: diagnostic.probe_spec.response_mode,
      prompt_md: diagnostic.probe_spec.prompt_md,
      choices_md: null,
      image_refs: null,
      figures: null,
    } as const;
    const solved = await runIndependentSolution(blindQuestion, {
      db: input.db,
      runTaskFn: input.runTaskFn,
      profile: { id: input.subjectProfile.id, full: input.subjectProfile },
    });
    if (solved.status !== 'solved') {
      if (solved.task_run_ids) taskRunIds.push(...solved.task_run_ids);
      return {
        status: 'invalid',
        failureCode: `independent_solution_unavailable:${kind}`,
        taskRunIds,
      };
    }
    taskRunIds.push(solved.task_run_id);
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
      solver_task_run_id: solverTaskRunId,
      independently_derived_answer_md: independentlyDerivedAnswer,
      required_operations_md: requiredOperations,
    });
    sealedSolutions.push({
      kind,
      question_input_sha256: questionInputSha256,
      solver_output_sha256: solverOutputSha256,
      final_answer_md: solution.reference_solution.final_answer,
      answer_equivalents_md: solution.reference_solution.answer_equivalents,
      expected_signals_md: solution.reference_solution.expected_signals,
      worked_solution_md: solution.worked_solution_md,
      confidence: solution.confidence,
    });
  }

  return {
    status: 'ok',
    audit: InterventionIndependentSolutionAudit.parse({
      validation_protocol_version: 1,
      package_digest_sha256: packageDigest,
      diagnostics: auditDiagnostics,
    }),
    sealedSolutions,
  };
}

/** Join comparator judgments with the immutable blind-solve evidence. */
export function bindInterventionPackageReviewDecision(
  value: unknown,
  independentAudit: InterventionIndependentSolutionAuditT,
): InterventionPackageReviewModelOutputFullT {
  const modelValue: InterventionPackageReviewStructuredOutputT =
    InterventionPackageReviewStructuredOutput.parse(value);
  const auditByKind = new Map(
    independentAudit.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic]),
  );
  const bound = InterventionPackageReviewModelOutputV2.parse({
    ...modelValue,
    diagnostic_checks: modelValue.diagnostic_checks.map((check) => {
      const sealed = auditByKind.get(check.kind);
      if (!sealed) throw new Error(`missing sealed independent solution for ${check.kind}`);
      if (check.independent_solution_sha256 !== sealed.solver_output_sha256) {
        throw new Error(`comparator referenced the wrong sealed solution for ${check.kind}`);
      }
      return {
        ...check,
        independent_solution_sha256: sealed.solver_output_sha256,
        independently_derived_answer_md: sealed.independently_derived_answer_md,
        required_operations_md: sealed.required_operations_md,
      };
    }),
  });
  return InterventionPackageReviewModelOutputFull.parse(
    enforceInterventionPackageReviewDecision(bound),
  );
}

function invalidComparatorReview(
  independentAudit: InterventionIndependentSolutionAuditT,
): InterventionPackageReviewModelOutputFullT {
  return InterventionPackageReviewModelOutputFull.parse({
    review_protocol_version: 2,
    verdict: 'fail',
    failure_codes: ['review_output_invalid'],
    diagnostic_checks: independentAudit.diagnostics.map((diagnostic) => ({
      kind: diagnostic.kind,
      independent_solution_sha256: diagnostic.solver_output_sha256,
      independently_derived_answer_md: diagnostic.independently_derived_answer_md,
      required_operations_md: diagnostic.required_operations_md,
      reference_correct: false,
      within_frozen_scope: false,
      discipline_grounded: false,
      decision_basis_md: 'Comparator output failed structured validation; activation is closed.',
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
      material_grounded: false,
      method_followed: false,
      tested_claims_match: false,
      target_errors_match: false,
      answers_unique: false,
      answers_gradable: false,
      no_answer_leak: false,
      diagnostics_same_construct: false,
      transfer_context_changed: false,
      target_error_identifiable: false,
      serious_factual_error_absent: false,
      safe_material: false,
    },
    summary_md: 'Review comparator output failed structured-output validation.',
  });
}

async function runPackageAuthor(
  runTaskFn: TaskTextRunFn,
  context: InterventionAuthoringContextT,
  subjectProfile: Awaited<ReturnType<typeof resolveSubjectProfileForKnowledgeIds>>,
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
  runTaskFn: TaskTextRunFn,
  context: InterventionAuthoringContextT,
  packageValue: InterventionPackageT,
  subjectProfile: ResolvedSubjectProfile,
  independentSolutions: {
    audit: InterventionIndependentSolutionAuditT;
    sealedSolutions: SealedIndependentSolutionForReview[];
  },
): Promise<
  | { status: 'ok'; review: InterventionPackageReviewAuditT }
  | { status: 'invalid'; failureCode: string }
> {
  const result = await runTaskFn(
    'InterventionPackageReviewTask',
    {
      snapshot: context.snapshot,
      recommendation: context.recommendation,
      package: packageValue,
      sealed_independent_solutions: independentSolutions.sealedSolutions,
    },
    {
      subjectProfile,
      ...(REVIEW_OUTPUT_FORMAT ? { outputFormat: REVIEW_OUTPUT_FORMAT } : {}),
    },
  );
  if (!result.task_run_id) {
    return { status: 'invalid', failureCode: 'review_task_run_id_missing' };
  }

  let review: InterventionPackageReviewModelOutputFullT;
  try {
    review = parseTaskOutput(result, 'intervention package review', (value) =>
      bindInterventionPackageReviewDecision(value, independentSolutions.audit),
    );
  } catch {
    review = invalidComparatorReview(independentSolutions.audit);
  }
  const packageDigest = sha256CanonicalJson(packageValue);
  if (independentSolutions.audit.package_digest_sha256 !== packageDigest) {
    return { status: 'invalid', failureCode: 'independent_solution_package_digest_mismatch' };
  }
  return {
    status: 'ok',
    review: InterventionPackageReviewAudit.parse({
      review_version: INTERVENTION_CONTRACT_VERSION,
      package_digest_sha256: packageDigest,
      review_task_run_id: result.task_run_id,
      independent_solution_audit: independentSolutions.audit,
      result: review,
    }),
  };
}

/**
 * FULL validator for an already-authored package: three strict blind solves via
 * the shared question validator, followed by one sealed-output comparator.
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
  | { status: 'invalid'; failureCode: string; taskRunIds: string[] }
> {
  const beforeEachPaidCall = input.beforeEachPaidCall ?? (async () => null);
  const independentlySolved = await runInterventionIndependentSolutions({
    db: input.db,
    runTaskFn: input.runTaskFn,
    packageValue: input.packageValue,
    subjectProfile: input.subjectProfile,
    beforeEachPaidCall,
  });
  if (independentlySolved.status === 'invalid') return independentlySolved;

  const comparatorGuardFailure = await beforeEachPaidCall();
  if (comparatorGuardFailure) {
    return {
      status: 'invalid',
      failureCode: comparatorGuardFailure,
      taskRunIds: independentlySolved.audit.diagnostics.map(
        (diagnostic) => diagnostic.solver_task_run_id,
      ),
    };
  }
  const reviewed = await runPackageReview(
    input.runTaskFn,
    input.context,
    input.packageValue,
    input.subjectProfile,
    independentlySolved,
  );
  if (reviewed.status === 'invalid') {
    return {
      ...reviewed,
      taskRunIds: independentlySolved.audit.diagnostics.map(
        (diagnostic) => diagnostic.solver_task_run_id,
      ),
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
  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, [
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
