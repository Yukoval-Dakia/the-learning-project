// Historical intervention review decoding — read-only readers for every
// persisted review-output/audit era (legacy, early V2, pre-operation-binding),
// plus the version-tolerant union readers. The current binding rules live in
// ./intervention-review.ts; this module decodes what was already written.
import { z } from 'zod';
import {
  INTERVENTION_CONTRACT_VERSION,
  InterventionDiagnosticKind,
  InterventionPackageReviewAuditV2,
  InterventionPackageReviewAuditV2Fields,
  InterventionPackageReviewAuditV3,
  InterventionPackageReviewFailureCode,
  InterventionPackageReviewModelOutputV2,
  InterventionPackageReviewPackageChecks,
  InterventionPackageReviewRequiredOperationChecks,
  refineInterventionPackageReviewAuditBindings,
} from './intervention-review';

const LegacyInterventionPackageReviewModelOutput = z.discriminatedUnion('verdict', [
  z
    .object({
      verdict: z.literal('pass'),
      failure_codes: z.array(InterventionPackageReviewFailureCode).length(0),
      summary_md: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      verdict: z.literal('fail'),
      failure_codes: z.array(InterventionPackageReviewFailureCode).min(1),
      summary_md: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

/**
 * Read-only shape used by V2 rows written before the server-owned relation
 * classification was introduced. Keep this separate from the current writer:
 * making the new field optional would let fresh FULL results bypass it.
 */
const HistoricalInterventionPackageReviewCausalDirectionCheck = z
  .object({
    applies: z.boolean(),
    exposure_x_md: z.string().trim().max(160),
    observed_outcome_y_md: z.string().trim().max(160),
    reference_claims_reverse_causation: z.boolean(),
    reference_claimed_reverse_cause_md: z.string().trim().max(240),
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
        message: 'a reference reverse-causation claim must include the claimed cause text',
      });
    }
    if (
      (!value.applies &&
        (value.reference_claims_reverse_causation ||
          value.claimed_cause_is_observed_y_causing_x)) ||
      (!value.reference_claims_reverse_causation && value.claimed_cause_is_observed_y_causing_x)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Y-causes-X can only be true for an applicable, claimed reverse cause',
      });
    }
  });

const HistoricalInterventionPackageReviewDiagnosticCheck = z
  .object({
    kind: InterventionDiagnosticKind,
    independent_solution_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    independently_derived_answer_md: z.string().trim().min(1).max(480),
    required_operations_md: z.string().trim().min(1).max(320),
    required_operation_checks: InterventionPackageReviewRequiredOperationChecks.optional(),
    reference_correct: z.boolean(),
    within_frozen_scope: z.boolean(),
    discipline_grounded: z.boolean(),
    decision_basis_md: z.string().trim().min(1).max(480),
    causal_direction_check: HistoricalInterventionPackageReviewCausalDirectionCheck,
  })
  .strict();

const HistoricalInterventionPackageReviewDiagnosticChecks = z
  .array(HistoricalInterventionPackageReviewDiagnosticCheck)
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

const HistoricalInterventionPackageReviewFullDiagnosticCheck =
  HistoricalInterventionPackageReviewDiagnosticCheck.extend({
    independent_solution_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    required_operation_checks: InterventionPackageReviewRequiredOperationChecks,
  }).strict();

const HistoricalInterventionPackageReviewFullDiagnosticChecks = z
  .array(HistoricalInterventionPackageReviewFullDiagnosticCheck)
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

const PreOperationHistoricalInterventionPackageReviewFullDiagnosticCheck =
  HistoricalInterventionPackageReviewDiagnosticCheck.omit({
    required_operation_checks: true,
  })
    .extend({
      independent_solution_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();

const PreOperationHistoricalInterventionPackageReviewFullDiagnosticChecks = z
  .array(PreOperationHistoricalInterventionPackageReviewFullDiagnosticCheck)
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

const HistoricalInterventionPackageReviewProtocolV2Fields = {
  review_protocol_version: z.literal(2),
  diagnostic_checks: HistoricalInterventionPackageReviewDiagnosticChecks,
  package_checks: InterventionPackageReviewPackageChecks.optional(),
  summary_md: z.string().trim().min(1).max(2000),
} as const;

const HistoricalInterventionPackageReviewModelOutputV2 = z.discriminatedUnion('verdict', [
  z
    .object({
      ...HistoricalInterventionPackageReviewProtocolV2Fields,
      verdict: z.literal('pass'),
      failure_codes: z.array(InterventionPackageReviewFailureCode).length(0),
    })
    .strict(),
  z
    .object({
      ...HistoricalInterventionPackageReviewProtocolV2Fields,
      verdict: z.literal('fail'),
      failure_codes: z.array(InterventionPackageReviewFailureCode).min(1),
    })
    .strict(),
]);

const HistoricalInterventionPackageReviewFullProtocolFields = {
  review_protocol_version: z.literal(2),
  diagnostic_checks: HistoricalInterventionPackageReviewFullDiagnosticChecks,
  package_checks: InterventionPackageReviewPackageChecks,
  summary_md: z.string().trim().min(1).max(2000),
} as const;

const HistoricalInterventionPackageReviewModelOutputFull = z
  .discriminatedUnion('verdict', [
    z
      .object({
        ...HistoricalInterventionPackageReviewFullProtocolFields,
        verdict: z.literal('pass'),
        failure_codes: z.array(InterventionPackageReviewFailureCode).length(0),
      })
      .strict(),
    z
      .object({
        ...HistoricalInterventionPackageReviewFullProtocolFields,
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
        message: 'historical FULL review pass requires every diagnostic and package check to pass',
      });
    }
  });

const PreOperationHistoricalInterventionPackageReviewModelOutputFull = z
  .discriminatedUnion('verdict', [
    z
      .object({
        review_protocol_version: z.literal(2),
        diagnostic_checks: PreOperationHistoricalInterventionPackageReviewFullDiagnosticChecks,
        package_checks: InterventionPackageReviewPackageChecks,
        summary_md: z.string().trim().min(1).max(2000),
        verdict: z.literal('pass'),
        failure_codes: z.array(InterventionPackageReviewFailureCode).length(0),
      })
      .strict(),
    z
      .object({
        review_protocol_version: z.literal(2),
        diagnostic_checks: PreOperationHistoricalInterventionPackageReviewFullDiagnosticChecks,
        package_checks: InterventionPackageReviewPackageChecks,
        summary_md: z.string().trim().min(1).max(2000),
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
        !rejectedReverseCausation
      );
    });
    const packagePass = Object.values(review.package_checks).every((value) => value === true);
    if (!diagnosticsPass || !packagePass) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'pre-operation historical FULL review pass requires every diagnostic and package check to pass',
      });
    }
  });

export const InterventionPackageReviewModelOutput = z.union([
  InterventionPackageReviewModelOutputV2,
  HistoricalInterventionPackageReviewModelOutputV2,
  LegacyInterventionPackageReviewModelOutput,
]);
export type InterventionPackageReviewModelOutputT = z.infer<
  typeof InterventionPackageReviewModelOutput
>;

/** Read-only blind-solve audit emitted before atomized required_operations. */
const PreOperationHistoricalSolutionGenerateOutput = z.object({
  // Freeze the bff7b3a9/4a23c50b solver contract here. The current shared
  // writer caps signals by count and size, but already-persisted rows were
  // valid with any non-empty list of non-empty signals.
  reference_solution: z.object({
    expected_signals: z.array(z.string().min(1)).min(1),
    final_answer: z.string().min(1),
    answer_equivalents: z.array(z.string().min(1)).default([]),
  }),
  worked_solution_md: z.string().min(1).max(12_000),
  confidence: z.number().min(0).max(1),
});

const PreOperationHistoricalInterventionIndependentSolutionDiagnosticAudit = z
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
    solver_output: PreOperationHistoricalSolutionGenerateOutput,
    solver_output_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    solver_output_repair_level: z.union([z.literal(false), z.literal('deterministic')]).optional(),
    solver_task_run_id: z.string().trim().min(1).max(240),
    solver_attempt_task_run_ids: z
      .array(z.string().trim().min(1).max(240))
      .min(1)
      .max(2)
      .optional(),
    independently_derived_answer_md: z.string().trim().min(1).max(480),
    required_operations_md: z.string().trim().min(1).max(320),
  })
  .strict()
  .superRefine((diagnostic, context) => {
    if (!diagnostic.solver_attempt_task_run_ids) return;
    const successfulRunIds = diagnostic.solver_attempt_task_run_ids.filter(
      (taskRunId) => taskRunId === diagnostic.solver_task_run_id,
    );
    if (
      successfulRunIds.length !== 1 ||
      diagnostic.solver_attempt_task_run_ids.at(-1) !== diagnostic.solver_task_run_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'selected historical solver task_run_id must be the unique final attempt',
      });
    }
  });

const PreOperationHistoricalInterventionIndependentSolutionDiagnosticAudits = z
  .array(PreOperationHistoricalInterventionIndependentSolutionDiagnosticAudit)
  .length(InterventionDiagnosticKind.options.length)
  .superRefine((diagnostics, context) => {
    const kinds = diagnostics.map((diagnostic) => diagnostic.kind);
    for (const kind of InterventionDiagnosticKind.options) {
      if (kinds.filter((value) => value === kind).length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `historical independent solution audit must contain exactly one ${kind} result`,
        });
      }
    }
    const taskRunIds = diagnostics.flatMap(
      (diagnostic) => diagnostic.solver_attempt_task_run_ids ?? [diagnostic.solver_task_run_id],
    );
    if (new Set(taskRunIds).size !== taskRunIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'historical independent solution task_run_ids must be unique',
      });
    }
  });

const PreOperationHistoricalInterventionIndependentSolutionAudit = z
  .object({
    validation_protocol_version: z.literal(1),
    package_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    diagnostics: PreOperationHistoricalInterventionIndependentSolutionDiagnosticAudits,
  })
  .strict();

const LegacyInterventionPackageReviewAudit = z
  .object({
    review_version: z.literal(INTERVENTION_CONTRACT_VERSION),
    package_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    review_task_run_id: z.string().trim().min(1).max(240),
    // Historical rows may contain either the original bare result or the branch's
    // earlier V2 self-review result without a sealed independent-solution audit.
    // Keep both readable; activation code separately requires the FULL audit.
    result: InterventionPackageReviewModelOutput,
  })
  .strict();

const HistoricalInterventionPackageReviewAuditV2 = z
  .object({
    ...InterventionPackageReviewAuditV2Fields,
    result: HistoricalInterventionPackageReviewModelOutputFull,
  })
  .strict()
  .superRefine(refineInterventionPackageReviewAuditBindings);

const PreOperationHistoricalInterventionPackageReviewAuditV2 = z
  .object({
    review_version: z.literal(INTERVENTION_CONTRACT_VERSION),
    package_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    review_task_run_id: z.string().trim().min(1).max(240),
    review_task_input_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    independent_solution_audit: PreOperationHistoricalInterventionIndependentSolutionAudit,
    result: PreOperationHistoricalInterventionPackageReviewModelOutputFull,
  })
  .strict()
  .superRefine((audit, context) => {
    if (audit.package_digest_sha256 !== audit.independent_solution_audit.package_digest_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'historical review and independent solution package digests must match',
      });
    }
    if (
      audit.independent_solution_audit.diagnostics.some((diagnostic) =>
        (diagnostic.solver_attempt_task_run_ids ?? [diagnostic.solver_task_run_id]).includes(
          audit.review_task_run_id,
        ),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'historical review task_run_id must differ from every solver task_run_id',
      });
    }
    const solutionByKind = new Map(
      audit.independent_solution_audit.diagnostics.map((diagnostic) => [
        diagnostic.kind,
        diagnostic,
      ]),
    );
    for (const check of audit.result.diagnostic_checks) {
      if (
        check.independent_solution_sha256 !== solutionByKind.get(check.kind)?.solver_output_sha256
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `historical review check ${check.kind} must reference its sealed solver output digest`,
        });
      }
    }
  });

export const InterventionPackageReviewAudit = z.union([
  InterventionPackageReviewAuditV3,
  InterventionPackageReviewAuditV2,
  HistoricalInterventionPackageReviewAuditV2,
  PreOperationHistoricalInterventionPackageReviewAuditV2,
  LegacyInterventionPackageReviewAudit,
]);
export type InterventionPackageReviewAuditT = z.infer<typeof InterventionPackageReviewAudit>;
