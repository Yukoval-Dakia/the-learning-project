// Intervention review/audit protocol — shared check vocabulary plus the
// current (V3) audit binding.
//
// Internal module of the intervention schema family. The public surface is
// re-exported through ./intervention.ts; because that file must stay acyclic,
// this module also owns the shared protocol anchors (contract versions, the
// diagnostic-kind enum, the reference reverse-causation claim shape) that the
// review readers and the public contract both bind to.
import { z } from 'zod';
import { QuizVerificationResult } from '@/core/schema/quiz_gen';
import { SolutionGenerateOutput } from '@/core/schema/solution';
import { sha256CanonicalJson } from '@/kernel/canonical-json';

export const INTERVENTION_CONTRACT_VERSION = 1 as const;
export const INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION = 3 as const;

export const MAX_INTERVENTION_REVIEW_ATTEMPTS = 2 as const;
export const MAX_INTERVENTION_REVERSE_CAUSATION_CLAIMS = 24 as const;

export const InterventionDiagnosticKind = z.enum(['immediate', 'delayed', 'transfer']);
export type InterventionDiagnosticKindT = z.infer<typeof InterventionDiagnosticKind>;

export const InterventionReferenceReverseCausationClaim = z
  .object({
    claim_index: z
      .number()
      .int()
      .min(0)
      .max(MAX_INTERVENTION_REVERSE_CAUSATION_CLAIMS - 1),
    source_path: z.string().trim().min(1).max(240),
    excerpt_start_utf16: z.number().int().min(0).max(20_000),
    excerpt_end_utf16: z.number().int().min(1).max(20_000),
    marker_start_utf16: z.number().int().min(0).max(20_000),
    marker_end_utf16: z.number().int().min(1).max(20_000),
    claim_md: z.string().trim().min(1).max(2000),
    claim_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type InterventionReferenceReverseCausationClaimT = z.infer<
  typeof InterventionReferenceReverseCausationClaim
>;

export const InterventionPackageReviewFailureCode = z.enum([
  'claim_scope_expansion',
  'reference_incorrect',
  'material_not_grounded',
  'method_not_followed',
  'tested_claim_mismatch',
  'target_error_mismatch',
  'answer_not_unique',
  'answer_not_gradable',
  'answer_leak',
  'diagnostics_not_same_construct',
  'transfer_context_not_changed',
  'target_error_not_identifiable',
  'serious_factual_error',
  'unsafe_material',
  'review_output_invalid',
]);
export type InterventionPackageReviewFailureCodeT = z.infer<
  typeof InterventionPackageReviewFailureCode
>;

const InterventionPackageReviewReverseCauseRelation = z.enum([
  'none',
  'same_outcome_construct_y',
  'baseline_or_prior_different_construct',
  'common_cause_or_other_or_unclear',
]);

const InterventionPackageComparatorReverseCauseRelation =
  InterventionPackageReviewReverseCauseRelation.exclude(['none']);

const InterventionPackageComparatorReverseCauseClaimRelation = z
  .object({
    claim_index: z
      .number()
      .int()
      .min(0)
      .max(MAX_INTERVENTION_REVERSE_CAUSATION_CLAIMS - 1),
    relation: InterventionPackageComparatorReverseCauseRelation,
    decision_basis_md: z.string().trim().min(1).max(320),
  })
  .strict();

const InterventionPackageComparatorCausalDirectionCheckFields = {
  applies: z.boolean(),
  exposure_x_md: z.string().trim().max(160),
  observed_outcome_y_md: z.string().trim().max(160),
  reference_reverse_causation_claim_relations: z
    .array(InterventionPackageComparatorReverseCauseClaimRelation)
    .max(MAX_INTERVENTION_REVERSE_CAUSATION_CLAIMS),
} as const;

type InterventionPackageComparatorCausalDirectionCheckT = {
  applies: boolean;
  exposure_x_md: string;
  observed_outcome_y_md: string;
  reference_reverse_causation_claim_relations: Array<{
    claim_index: number;
    relation: z.infer<typeof InterventionPackageComparatorReverseCauseRelation>;
    decision_basis_md: string;
  }>;
};

function refineComparatorCausalDirectionCheck(
  value: InterventionPackageComparatorCausalDirectionCheckT,
  context: z.RefinementCtx,
): void {
  const hasX = value.exposure_x_md.length > 0;
  const hasY = value.observed_outcome_y_md.length > 0;
  if (value.applies !== hasX || value.applies !== hasY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'causal X and observed Y must both be present exactly when applies=true',
    });
  }
  if (!value.applies && value.reference_reverse_causation_claim_relations.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a non-causal diagnostic cannot classify reverse-causation claims',
    });
  }
}

const InterventionPackageComparatorCausalDirectionCheck = z
  .object(InterventionPackageComparatorCausalDirectionCheckFields)
  .strict()
  .superRefine(refineComparatorCausalDirectionCheck);

const InterventionPackageReviewReverseCausationClaimCheck =
  InterventionReferenceReverseCausationClaim.extend({
    relation: InterventionPackageComparatorReverseCauseRelation,
    decision_basis_md: z.string().trim().min(1).max(320),
    claimed_cause_is_observed_y_causing_x: z.boolean(),
  })
    .strict()
    .superRefine((claim, context) => {
      if (
        claim.claimed_cause_is_observed_y_causing_x !==
        (claim.relation === 'same_outcome_construct_y')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'per-claim Y-causes-X compatibility must be server-derived from relation',
        });
      }
    });

const InterventionPackageReviewCausalDirectionCheck = z
  .object({
    applies: z.boolean(),
    exposure_x_md: z.string().trim().max(160),
    observed_outcome_y_md: z.string().trim().max(160),
    reference_claims_reverse_causation: z.boolean(),
    reference_claimed_reverse_cause_md: z.string().trim().max(2000),
    reference_claimed_reverse_cause_relation: InterventionPackageReviewReverseCauseRelation,
    // Optional only for V2 rows written before occurrence-level binding. Every
    // V3/current writer supplies the complete server-owned ordered claim list.
    reference_reverse_causation_claim_checks: z
      .array(InterventionPackageReviewReverseCausationClaimCheck)
      .max(MAX_INTERVENTION_REVERSE_CAUSATION_CLAIMS)
      .optional(),
    // Derived by the server from the outcome-relation classification; providers
    // never self-certify this compatibility bit.
    claimed_cause_is_observed_y_causing_x: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasX = value.exposure_x_md.length > 0;
    const hasY = value.observed_outcome_y_md.length > 0;
    const hasClaim = value.reference_claimed_reverse_cause_md.length > 0;
    if (value.applies !== hasX || value.applies !== hasY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'causal X and observed Y must both be present exactly when applies=true',
      });
    }
    if (value.reference_claims_reverse_causation !== hasClaim) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a reference reverse-causation claim must include the server-owned claim text',
      });
    }
    const hasRelation = value.reference_claimed_reverse_cause_relation !== 'none';
    if (value.reference_claims_reverse_causation !== hasRelation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a reference reverse-causation claim must have a bound aggregate relation',
      });
    }
    if (!value.applies && value.reference_claims_reverse_causation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a non-causal diagnostic cannot claim reverse causation',
      });
    }
    if (value.reference_reverse_causation_claim_checks) {
      const claimChecks = value.reference_reverse_causation_claim_checks;
      if (
        claimChecks.length > 0 !== value.reference_claims_reverse_causation ||
        claimChecks.some((claim, index) => claim.claim_index !== index)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'bound reverse-causation claim checks must be dense and match claim presence',
        });
      }
    }
    const derived =
      value.reference_claims_reverse_causation &&
      value.reference_claimed_reverse_cause_relation === 'same_outcome_construct_y';
    if (value.claimed_cause_is_observed_y_causing_x !== derived) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Y-causes-X must be derived from the claimed cause relation to outcome Y',
      });
    }
  });

export function interventionRequiredOperationDigest(operationMd: string): string {
  return sha256CanonicalJson({ operation_md: operationMd });
}

const InterventionPackageReviewRequiredOperationCheck = z
  .object({
    operation_index: z.number().int().min(0).max(11),
    operation_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    // Server-owned in bound FULL output; provider-facing output omits it.
    operation_md: z.string().trim().min(1).max(1000),
    reference_covers_operation: z.boolean(),
    within_frozen_scope: z.boolean(),
    decision_basis_md: z.string().trim().min(1).max(320),
  })
  .strict();

const InterventionPackageComparatorRequiredOperationCheck =
  InterventionPackageReviewRequiredOperationCheck.omit({
    operation_md: true,
    operation_sha256: true,
  }).strict();

export const InterventionPackageReviewRequiredOperationChecks = z
  .array(InterventionPackageReviewRequiredOperationCheck)
  .min(1)
  .max(12);

const InterventionPackageComparatorRequiredOperationChecks = z
  .array(InterventionPackageComparatorRequiredOperationCheck)
  .min(1)
  .max(12);

export const InterventionPackageReviewDiagnosticCheck = z
  .object({
    kind: InterventionDiagnosticKind,
    // New comparator outputs reference the sealed solver artifact by digest.
    // Optional only so earlier persisted V2 self-review rows remain readable.
    independent_solution_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    // This is a concise independently derived result, not hidden chain of thought.
    // Persisting it makes the reviewer protocol auditable instead of trusting a
    // bare self-certified pass bit.
    independently_derived_answer_md: z.string().trim().min(1).max(480),
    required_operations_md: z.string().trim().min(1).max(320),
    // Optional only for historical V2 rows. Every new FULL comparator result
    // carries one bound check per sealed expected_signal.
    required_operation_checks: InterventionPackageReviewRequiredOperationChecks.optional(),
    reference_correct: z.boolean(),
    within_frozen_scope: z.boolean(),
    discipline_grounded: z.boolean(),
    decision_basis_md: z.string().trim().min(1).max(480),
    causal_direction_check: InterventionPackageReviewCausalDirectionCheck,
  })
  .strict();
export type InterventionPackageReviewDiagnosticCheckT = z.infer<
  typeof InterventionPackageReviewDiagnosticCheck
>;

const InterventionPackageReviewDiagnosticChecks = z
  .array(InterventionPackageReviewDiagnosticCheck)
  .length(InterventionDiagnosticKind.options.length)
  .superRefine((checks, context) => {
    const kinds = checks.map((check) => check.kind);
    for (const kind of InterventionDiagnosticKind.options) {
      if (kinds.filter((value) => value === kind).length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `diagnostic_checks must contain exactly one ${kind} check`,
        });
      }
    }
  });

const InterventionPackageReviewFullDiagnosticCheck =
  InterventionPackageReviewDiagnosticCheck.extend({
    independent_solution_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    required_operation_checks: InterventionPackageReviewRequiredOperationChecks,
  }).strict();

const InterventionPackageReviewFullDiagnosticChecks = z
  .array(InterventionPackageReviewFullDiagnosticCheck)
  .length(InterventionDiagnosticKind.options.length)
  .superRefine((checks, context) => {
    const kinds = checks.map((check) => check.kind);
    for (const kind of InterventionDiagnosticKind.options) {
      if (kinds.filter((value) => value === kind).length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `diagnostic_checks must contain exactly one ${kind} check`,
        });
      }
    }
  });

const InterventionPackageComparatorDiagnosticCheck = InterventionPackageReviewDiagnosticCheck.omit({
  independent_solution_sha256: true,
  independently_derived_answer_md: true,
  required_operations_md: true,
  required_operation_checks: true,
})
  .extend({
    required_operation_checks: InterventionPackageComparatorRequiredOperationChecks,
    causal_direction_check: InterventionPackageComparatorCausalDirectionCheck,
  })
  .strict();

const InterventionPackageComparatorDiagnosticChecks = z
  .array(InterventionPackageComparatorDiagnosticCheck)
  .length(InterventionDiagnosticKind.options.length)
  .superRefine((checks, context) => {
    const kinds = checks.map((check) => check.kind);
    for (const kind of InterventionDiagnosticKind.options) {
      if (kinds.filter((value) => value === kind).length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `diagnostic_checks must contain exactly one ${kind} check`,
        });
      }
    }
  });

export const InterventionPackageReviewPackageChecks = z
  .object({
    material_grounded: z.boolean(),
    method_followed: z.boolean(),
    tested_claims_match: z.boolean(),
    target_errors_match: z.boolean(),
    answers_unique: z.boolean(),
    answers_gradable: z.boolean(),
    no_answer_leak: z.boolean(),
    diagnostics_same_construct: z.boolean(),
    transfer_context_changed: z.boolean(),
    target_error_identifiable: z.boolean(),
    serious_factual_error_absent: z.boolean(),
    safe_material: z.boolean(),
  })
  .strict();
export type InterventionPackageReviewPackageChecksT = z.infer<
  typeof InterventionPackageReviewPackageChecks
>;

/**
 * Provider-facing package checks: the comparator no longer judges
 * `tested_claims_match` / `target_errors_match`. Those two bits are a plain
 * string equality between the frozen snapshot claim identity and the
 * server-normalized diagnostic fields, so the server derives them at bind time.
 * Strip-mode on purpose: outputs that still carry the retired keys (older
 * persisted fixtures, text-fallback completions) parse instead of failing —
 * the provider's value for a server-owned bit was never authority anyway.
 */
export const InterventionPackageComparatorPackageChecks = z.object({
  material_grounded: z.boolean(),
  method_followed: z.boolean(),
  answers_unique: z.boolean(),
  answers_gradable: z.boolean(),
  no_answer_leak: z.boolean(),
  diagnostics_same_construct: z.boolean(),
  transfer_context_changed: z.boolean(),
  target_error_identifiable: z.boolean(),
  serious_factual_error_absent: z.boolean(),
  safe_material: z.boolean(),
});
export type InterventionPackageComparatorPackageChecksT = z.infer<
  typeof InterventionPackageComparatorPackageChecks
>;

const InterventionPackageReviewProtocolV2Fields = {
  review_protocol_version: z.literal(2),
  diagnostic_checks: InterventionPackageReviewDiagnosticChecks,
  // Optional only for reading V2 rows written before the comparator split.
  // Every new provider output and FULL activation requires this object.
  package_checks: InterventionPackageReviewPackageChecks.optional(),
  summary_md: z.string().trim().min(1).max(2000),
} as const;

/**
 * New reviewer outputs must expose one independent solution/scope audit for
 * every diagnostic. The legacy shape remains readable below solely so already
 * persisted intervention attempts do not become unparsable after rollout.
 */
export const InterventionPackageReviewModelOutputV2 = z.discriminatedUnion('verdict', [
  z
    .object({
      ...InterventionPackageReviewProtocolV2Fields,
      verdict: z.literal('pass'),
      failure_codes: z.array(InterventionPackageReviewFailureCode).length(0),
    })
    .strict(),
  z
    .object({
      ...InterventionPackageReviewProtocolV2Fields,
      verdict: z.literal('fail'),
      failure_codes: z.array(InterventionPackageReviewFailureCode).min(1),
    })
    .strict(),
]);
export type InterventionPackageReviewModelOutputV2T = z.infer<
  typeof InterventionPackageReviewModelOutputV2
>;

const InterventionPackageReviewFullProtocolFields = {
  review_protocol_version: z.literal(2),
  diagnostic_checks: InterventionPackageReviewFullDiagnosticChecks,
  package_checks: InterventionPackageReviewPackageChecks,
  summary_md: z.string().trim().min(1).max(2000),
} as const;

export const InterventionPackageReviewModelOutputFull = z
  .discriminatedUnion('verdict', [
    z
      .object({
        ...InterventionPackageReviewFullProtocolFields,
        verdict: z.literal('pass'),
        failure_codes: z.array(InterventionPackageReviewFailureCode).length(0),
      })
      .strict(),
    z
      .object({
        ...InterventionPackageReviewFullProtocolFields,
        verdict: z.literal('fail'),
        failure_codes: z.array(InterventionPackageReviewFailureCode).min(1),
      })
      .strict(),
  ])
  .superRefine((review, context) => {
    if (review.verdict !== 'pass') return;
    const diagnosticsPass = review.diagnostic_checks.every((check) => {
      const rejectedReverseCausation =
        check.causal_direction_check.applies &&
        check.causal_direction_check.reference_claims_reverse_causation &&
        !check.causal_direction_check.claimed_cause_is_observed_y_causing_x;
      return (
        check.reference_correct &&
        check.within_frozen_scope &&
        check.discipline_grounded &&
        check.required_operation_checks.every(
          (operation) => operation.reference_covers_operation && operation.within_frozen_scope,
        ) &&
        !rejectedReverseCausation
      );
    });
    const packagePass = Object.values(review.package_checks).every((value) => value === true);
    if (!diagnosticsPass || !packagePass) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'FULL review pass requires every diagnostic and package check to pass',
      });
    }
  });
export type InterventionPackageReviewModelOutputFullT = z.infer<
  typeof InterventionPackageReviewModelOutputFull
>;

/** Flat provider schema; the V2 canonical reader enforces pass/fail branch rules. */
export const InterventionPackageReviewStructuredOutput = z
  .object({
    review_protocol_version: z.literal(2),
    // Advisory only. The server derives the canonical decision from granular
    // checks; accepting a bounded unknown string prevents a correct comparison
    // from being discarded solely because the provider invented a label.
    verdict: z.string().trim().min(1).max(40).optional(),
    failure_codes: z
      .array(z.string().trim().min(1).max(160))
      .max(InterventionPackageReviewFailureCode.options.length)
      .optional(),
    // The comparator does not author blind-solve evidence. Those two fields are
    // server-owned and joined from the sealed independent-solution audit after
    // this provider response parses.
    diagnostic_checks: InterventionPackageComparatorDiagnosticChecks,
    package_checks: InterventionPackageComparatorPackageChecks,
    summary_md: z.string().trim().min(1).max(2000),
  })
  .strict();

export type InterventionPackageReviewStructuredOutputT = z.infer<
  typeof InterventionPackageReviewStructuredOutput
>;

const InterventionIndependentRequiredOperation = z
  .object({
    operation_index: z.number().int().min(0).max(11),
    operation_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    operation_md: z.string().min(1).max(1000),
  })
  .strict();

export const InterventionIndependentSolutionDiagnosticAudit = z
  .object({
    kind: InterventionDiagnosticKind,
    task_input: z
      .object({
        prompt_md: z.string().trim().min(1).max(12_000),
        kind: z.string().trim().min(1).max(120),
        subject_id: z.string().trim().min(1).max(240),
        choices_md: z.array(z.string().max(4000)).length(0),
        existing_answers_hint: z.null(),
        existing_analysis_hint: z.null(),
        figures_hint: z.null(),
        prompt_image_refs: z.array(z.string().trim().min(1).max(240)).length(0),
      })
      .strict(),
    question_input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    solver_output: SolutionGenerateOutput.extend({
      // Preserve byte-for-byte canonical SolutionGenerateOutput for digest
      // replay; trimming here would mutate the object after its hash was made.
      worked_solution_md: z.string().min(1).max(12_000),
    }),
    solver_output_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    solver_output_repair_level: z.union([z.literal(false), z.literal('deterministic')]),
    solver_task_run_id: z.string().trim().min(1).max(240),
    // A strict solver may retry once after a paid response is persisted but its
    // JSON cannot satisfy the complete SolutionGenerateOutput contract. Keep
    // every attempted run id; solver_task_run_id is the selected successful run.
    solver_attempt_task_run_ids: z.array(z.string().trim().min(1).max(240)).min(1).max(2),
    independently_derived_answer_md: z.string().trim().min(1).max(480),
    required_operations_md: z.string().trim().min(1).max(320),
    required_operations: z.array(InterventionIndependentRequiredOperation).min(1).max(12),
  })
  .strict()
  .superRefine((diagnostic, context) => {
    const successfulRunIds = diagnostic.solver_attempt_task_run_ids.filter(
      (taskRunId) => taskRunId === diagnostic.solver_task_run_id,
    );
    if (
      successfulRunIds.length !== 1 ||
      diagnostic.solver_attempt_task_run_ids.at(-1) !== diagnostic.solver_task_run_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'selected solver task_run_id must appear exactly once as the final attempt',
      });
    }
    const expectedSignals = diagnostic.solver_output.reference_solution.expected_signals;
    if (diagnostic.required_operations.length !== expectedSignals.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'required_operations must cover every sealed expected_signal exactly once',
      });
      return;
    }
    for (const [index, operation] of diagnostic.required_operations.entries()) {
      const expectedOperation = expectedSignals[index];
      if (
        operation.operation_index !== index ||
        operation.operation_md !== expectedOperation ||
        operation.operation_sha256 !== interventionRequiredOperationDigest(expectedOperation ?? '')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `required operation ${index} must bind the matching sealed expected_signal`,
        });
      }
    }
  });

const InterventionIndependentSolutionDiagnosticAudits = z
  .array(InterventionIndependentSolutionDiagnosticAudit)
  .length(InterventionDiagnosticKind.options.length)
  .superRefine((diagnostics, context) => {
    const kinds = diagnostics.map((diagnostic) => diagnostic.kind);
    for (const kind of InterventionDiagnosticKind.options) {
      if (kinds.filter((value) => value === kind).length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `independent solution audit must contain exactly one ${kind} result`,
        });
      }
    }
    const taskRunIds = diagnostics.flatMap((diagnostic) => diagnostic.solver_attempt_task_run_ids);
    if (new Set(taskRunIds).size !== taskRunIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'independent solution task_run_ids must be unique',
      });
    }
  });

export const InterventionIndependentSolutionAudit = z
  .object({
    validation_protocol_version: z.literal(1),
    package_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    diagnostics: InterventionIndependentSolutionDiagnosticAudits,
  })
  .strict();
export type InterventionIndependentSolutionAuditT = z.infer<
  typeof InterventionIndependentSolutionAudit
>;

export const InterventionQuestionContentValidationDiagnosticAudit = z
  .object({
    kind: InterventionDiagnosticKind,
    task_input: z.unknown().optional(),
    task_input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    result: QuizVerificationResult,
    result_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    output_repair_level: z.union([z.literal(false), z.literal('deterministic')]),
    task_run_id: z.string().trim().min(1).max(240),
  })
  .strict()
  .superRefine((diagnostic, context) => {
    if (sha256CanonicalJson(diagnostic.task_input) !== diagnostic.task_input_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'question-content validation input digest must match the sealed input',
      });
    }
    if (sha256CanonicalJson(diagnostic.result) !== diagnostic.result_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'question-content validation result digest must match the sealed result',
      });
    }
  });

const InterventionQuestionContentValidationDiagnosticAudits = z
  .array(InterventionQuestionContentValidationDiagnosticAudit)
  .length(InterventionDiagnosticKind.options.length)
  .superRefine((diagnostics, context) => {
    const kinds = diagnostics.map((diagnostic) => diagnostic.kind);
    for (const kind of InterventionDiagnosticKind.options) {
      if (kinds.filter((value) => value === kind).length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `question-content validation audit must contain exactly one ${kind} result`,
        });
      }
    }
    const taskRunIds = diagnostics.map((diagnostic) => diagnostic.task_run_id);
    if (new Set(taskRunIds).size !== taskRunIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'question-content validation task_run_ids must be unique',
      });
    }
  });

export const InterventionQuestionContentValidationAudit = z
  .object({
    validation_protocol_version: z.literal(1),
    package_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    diagnostics: InterventionQuestionContentValidationDiagnosticAudits,
  })
  .strict();
export type InterventionQuestionContentValidationAuditT = z.infer<
  typeof InterventionQuestionContentValidationAudit
>;

export const InterventionPackageReviewAuditV2Fields = {
  review_version: z.literal(INTERVENTION_CONTRACT_VERSION),
  package_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  review_task_run_id: z.string().trim().min(1).max(240),
  review_attempt_task_run_ids: z
    .array(z.string().trim().min(1).max(240))
    .min(1)
    .max(MAX_INTERVENTION_REVIEW_ATTEMPTS),
  review_task_input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  independent_solution_audit: InterventionIndependentSolutionAudit,
} as const;

type InterventionPackageReviewAuditBindingInput = {
  package_digest_sha256: string;
  review_task_run_id: string;
  review_attempt_task_run_ids: string[];
  independent_solution_audit: InterventionIndependentSolutionAuditT;
  result: {
    diagnostic_checks: Array<{
      kind: InterventionDiagnosticKindT;
      independent_solution_sha256: string;
      required_operation_checks: Array<{
        operation_index: number;
        operation_sha256: string;
        operation_md: string;
      }>;
    }>;
  };
};

function refineInterventionPackageReviewResultBindings(
  independentAudit: InterventionIndependentSolutionAuditT,
  result: InterventionPackageReviewAuditBindingInput['result'],
  context: z.RefinementCtx,
  label = 'review',
): void {
  const solutionByKind = new Map(
    independentAudit.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic]),
  );
  for (const check of result.diagnostic_checks) {
    const sealed = solutionByKind.get(check.kind);
    if (check.independent_solution_sha256 !== sealed?.solver_output_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} check ${check.kind} must reference its sealed solver output digest`,
      });
    }
    if (!sealed || check.required_operation_checks.length !== sealed.required_operations.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} check ${check.kind} must cover every sealed required operation`,
      });
      continue;
    }
    for (const [index, operationCheck] of check.required_operation_checks.entries()) {
      const requiredOperation = sealed.required_operations[index];
      if (
        operationCheck.operation_index !== requiredOperation?.operation_index ||
        operationCheck.operation_sha256 !== requiredOperation?.operation_sha256 ||
        operationCheck.operation_md !== requiredOperation?.operation_md
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} check ${check.kind} operation ${index} must bind the sealed operation`,
        });
      }
    }
  }
}

export function refineInterventionPackageReviewAuditBindings(
  audit: InterventionPackageReviewAuditBindingInput,
  context: z.RefinementCtx,
): void {
  if (audit.package_digest_sha256 !== audit.independent_solution_audit.package_digest_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'review and independent solution package digests must match',
    });
  }
  if (
    audit.independent_solution_audit.diagnostics.some((diagnostic) =>
      diagnostic.solver_attempt_task_run_ids.some((taskRunId) =>
        audit.review_attempt_task_run_ids.includes(taskRunId),
      ),
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'review task_run_id must differ from every independent solver task_run_id',
    });
  }
  if (
    new Set(audit.review_attempt_task_run_ids).size !== audit.review_attempt_task_run_ids.length ||
    audit.review_attempt_task_run_ids.filter((taskRunId) => taskRunId === audit.review_task_run_id)
      .length !== 1 ||
    audit.review_attempt_task_run_ids.at(-1) !== audit.review_task_run_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'selected review task_run_id must appear exactly once as the final attempt',
    });
  }
  refineInterventionPackageReviewResultBindings(
    audit.independent_solution_audit,
    audit.result,
    context,
  );
}

export const InterventionPackageReviewAuditV2 = z
  .object({
    ...InterventionPackageReviewAuditV2Fields,
    result: InterventionPackageReviewModelOutputFull,
  })
  .strict()
  .superRefine(refineInterventionPackageReviewAuditBindings);

export const InterventionPackageReviewAttemptAudit = z.discriminatedUnion('outcome', [
  z
    .object({
      task_run_id: z.string().trim().min(1).max(240),
      outcome: z.literal('contract_invalid'),
    })
    .strict(),
  z
    .object({
      task_run_id: z.string().trim().min(1).max(240),
      outcome: z.literal('valid'),
      result: InterventionPackageReviewModelOutputFull,
    })
    .strict(),
]);

export const InterventionPackageReviewAuditV3 = z
  .object({
    audit_protocol_version: z.literal(INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION),
    ...InterventionPackageReviewAuditV2Fields,
    question_content_validation_audit: InterventionQuestionContentValidationAudit,
    review_attempts: z
      .array(InterventionPackageReviewAttemptAudit)
      .min(1)
      .max(MAX_INTERVENTION_REVIEW_ATTEMPTS),
    result: InterventionPackageReviewModelOutputFull,
  })
  .strict()
  .superRefine((audit, context) => {
    refineInterventionPackageReviewAuditBindings(audit, context);
    if (
      audit.question_content_validation_audit.package_digest_sha256 !== audit.package_digest_sha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'review and question-content validation package digests must match',
      });
    }
    const allValidatorTaskRunIds = [
      ...audit.independent_solution_audit.diagnostics.flatMap(
        (diagnostic) => diagnostic.solver_attempt_task_run_ids,
      ),
      ...audit.question_content_validation_audit.diagnostics.map(
        (diagnostic) => diagnostic.task_run_id,
      ),
      ...audit.review_attempts.map((attempt) => attempt.task_run_id),
    ];
    if (new Set(allValidatorTaskRunIds).size !== allValidatorTaskRunIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'solver, content-validation and review task_run_ids must be globally unique',
      });
    }
    const attemptIds = audit.review_attempts.map((attempt) => attempt.task_run_id);
    if (
      attemptIds.length !== audit.review_attempt_task_run_ids.length ||
      attemptIds.some((taskRunId, index) => taskRunId !== audit.review_attempt_task_run_ids[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'review_attempts must exactly bind the ordered review task_run_ids',
      });
    }
    for (const [index, attempt] of audit.review_attempts.entries()) {
      if (attempt.outcome === 'valid') {
        refineInterventionPackageReviewResultBindings(
          audit.independent_solution_audit,
          attempt.result,
          context,
          `review attempt ${index + 1}`,
        );
        if (
          attempt.result.diagnostic_checks.some(
            (check) =>
              check.causal_direction_check.reference_reverse_causation_claim_checks === undefined,
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `review attempt ${index + 1} must preserve occurrence-level causal claim bindings`,
          });
        }
      }
    }
    const finalAttempt = audit.review_attempts.at(-1);
    if (
      !finalAttempt ||
      finalAttempt.outcome !== 'valid' ||
      finalAttempt.task_run_id !== audit.review_task_run_id ||
      sha256CanonicalJson(finalAttempt.result) !== sha256CanonicalJson(audit.result)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the final valid review attempt must be the selected canonical result',
      });
      return;
    }
    if (audit.result.verdict === 'pass') {
      if (
        audit.review_attempts.length !== MAX_INTERVENTION_REVIEW_ATTEMPTS ||
        audit.review_attempts.some(
          (attempt) => attempt.outcome !== 'valid' || attempt.result.verdict !== 'pass',
        ) ||
        audit.question_content_validation_audit.diagnostics.some(
          (diagnostic) => diagnostic.result.grounding.verdict !== 'pass',
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'current FULL pass requires two valid pass confirmations and grounded content checks',
        });
      }
    } else {
      if (
        finalAttempt.result.verdict !== 'fail' ||
        audit.review_attempts
          .slice(0, -1)
          .some((attempt) => attempt.outcome === 'valid' && attempt.result.verdict !== 'pass')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a failed current FULL audit must stop on its first valid fail result',
        });
      }
    }
  });

export const CurrentInterventionPackageReviewAudit = InterventionPackageReviewAuditV3;
export type CurrentInterventionPackageReviewAuditT = z.infer<
  typeof CurrentInterventionPackageReviewAudit
>;
