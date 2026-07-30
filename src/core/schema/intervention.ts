// YUK-791 — cross-capability vocabulary for the intervention preparation wave.
//
// Agency owns every lifecycle write. Practice owns package authoring. Keeping the
// immutable JSON contracts in core lets both capabilities validate the same data
// without importing one another's server implementation or database tables.

import { PedagogyMethodId, PrecisionBand, ThetaBand } from '@/core/pedagogy/method-library';
import { ConjectureDiagnosticSpec, ConjectureProbeSpecV2 } from '@/core/schema/business';
import { z } from 'zod';

export const INTERVENTION_CONTRACT_VERSION = 1 as const;
export const MAX_INTERVENTION_PACKAGE_ATTEMPTS = 2 as const;
export const PEDAGOGY_METHOD_DEFINITION_VERSION = 'pedagogy_method_library_v1' as const;
export const INTERVENTION_ACTIVATED_ACTION = 'experimental:intervention_activated' as const;
export const INTERVENTION_PREPARATION_FAILED_ACTION =
  'experimental:intervention_preparation_failed' as const;

export const InterventionStatus = z.enum([
  'preparing',
  'preparation_failed',
  'active',
  'needs_revision',
  'settled',
  'canceled',
]);
export type InterventionStatusT = z.infer<typeof InterventionStatus>;

export const InterventionDeliveryMode = z.enum(['shadow', 'eligible']);
export type InterventionDeliveryModeT = z.infer<typeof InterventionDeliveryMode>;

export const InterventionOutcome = z.enum(['effective', 'ineffective', 'inconclusive']);
export type InterventionOutcomeT = z.infer<typeof InterventionOutcome>;

const InterventionEvidenceRef = z
  .object({
    kind: z.string().trim().min(1).max(80),
    id: z.string().trim().min(1).max(240),
  })
  .strict();

const PriorIntervention = z
  .object({
    intervention_id: z.string().trim().min(1).max(240),
    version: z.number().int().positive(),
    method_id: PedagogyMethodId,
    method_definition_version: z.string().trim().min(1).max(120),
    outcome: InterventionOutcome,
  })
  .strict();

export const InterventionSnapshot = z
  .object({
    schema_version: z.literal(INTERVENTION_CONTRACT_VERSION),
    intervention_id: z.string().trim().min(1).max(240),
    intervention_version: z.number().int().positive(),
    conjecture: z
      .object({
        conjecture_id: z.string().trim().min(1).max(240),
        claim_md: z.string().trim().min(1).max(280),
        knowledge_id: z.string().trim().min(1).max(240),
        knowledge_name: z.string().trim().min(1).max(500),
        cause_category: z.string().trim().min(1).max(120),
        target_error_rule_md: z.string().trim().min(1).max(1000),
        diagnostic_spec: ConjectureDiagnosticSpec,
        evidence_refs: z.array(InterventionEvidenceRef).min(1).max(100),
      })
      .strict(),
    learner_context: z
      .object({
        theta_band: ThetaBand,
        precision_band: PrecisionBand,
        misconception_present: z.boolean(),
        // No canonical rule/concept trait exists yet. The snapshot must record the
        // deterministic conservative value used by the palette instead of letting
        // the recommendation model infer this hidden personalization axis.
        kc_is_rule_based: z.boolean(),
      })
      .strict(),
    prior_interventions: z.array(PriorIntervention).max(20),
    disabled_method_ids: z.array(PedagogyMethodId).max(PedagogyMethodId.options.length),
    source_probe_result_event_id: z.string().trim().min(1).max(240),
    created_at: z.string().datetime(),
  })
  .strict();
export type InterventionSnapshotT = z.infer<typeof InterventionSnapshot>;

export const PedagogyRecommendationAbstainReason = z.enum([
  'no_safe_method',
  'insufficient_grounding',
  'conflicting_history',
  'model_output_invalid',
]);
export type PedagogyRecommendationAbstainReasonT = z.infer<
  typeof PedagogyRecommendationAbstainReason
>;

export const PedagogyRecommendationModelOutput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('recommendation'),
      method_id: PedagogyMethodId,
      rationale_md: z.string().trim().min(1).max(2000),
      safety_constraints: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
    })
    .strict(),
  z
    .object({
      kind: z.literal('abstain'),
      reason_code: z.enum(['insufficient_grounding', 'conflicting_history']),
      detail_md: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
export type PedagogyRecommendationModelOutputT = z.infer<typeof PedagogyRecommendationModelOutput>;

/**
 * Flat provider-facing schema for mimo structured output.
 *
 * The canonical reader above remains a discriminated union, but that converts
 * to JSON Schema `anyOf`, which the mimo-compatible endpoint does not reliably
 * support. The canonical reader still performs strict branch validation after
 * the provider returns this object.
 */
export const PedagogyRecommendationStructuredOutput = z
  .object({
    kind: z.enum(['recommendation', 'abstain']),
    method_id: PedagogyMethodId.optional(),
    rationale_md: z.string().trim().min(1).max(2000).optional(),
    safety_constraints: z.array(z.string().trim().min(1).max(500)).min(1).max(12).optional(),
    reason_code: z.enum(['insufficient_grounding', 'conflicting_history']).optional(),
    detail_md: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

const PedagogyPolicyExclusion = z
  .object({
    method_id: PedagogyMethodId,
    reason: z.enum(['contraindicated', 'not_indicated', 'disabled']),
  })
  .strict();

export const ConcretePedagogyRecommendation = z
  .object({
    kind: z.literal('recommendation'),
    recommendation_version: z.literal(INTERVENTION_CONTRACT_VERSION),
    method_id: PedagogyMethodId,
    method_definition_version: z.literal(PEDAGOGY_METHOD_DEFINITION_VERSION),
    rationale_md: z.string().trim().min(1).max(2000),
    safety_constraints: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
    candidate_ids: z.array(PedagogyMethodId).min(1),
    excluded: z.array(PedagogyPolicyExclusion),
    model_run_id: z.string().trim().min(1).max(240),
  })
  .strict();

export const PedagogyRecommendation = z.discriminatedUnion('kind', [
  ConcretePedagogyRecommendation,
  z
    .object({
      kind: z.literal('abstain'),
      recommendation_version: z.literal(INTERVENTION_CONTRACT_VERSION),
      reason_code: PedagogyRecommendationAbstainReason,
      detail_md: z.string().trim().min(1).max(2000).optional(),
      candidate_ids: z.array(PedagogyMethodId),
      excluded: z.array(PedagogyPolicyExclusion),
      model_run_id: z.string().trim().min(1).max(240).optional(),
    })
    .strict(),
]);
export type PedagogyRecommendationT = z.infer<typeof PedagogyRecommendation>;

export const InterventionDiagnosticKind = z.enum(['immediate', 'delayed', 'transfer']);
export type InterventionDiagnosticKindT = z.infer<typeof InterventionDiagnosticKind>;

const InterventionDiagnosticDraft = z
  .object({
    kind: InterventionDiagnosticKind,
    // Reuse the response-aware Probe V2 contract rather than inventing a second,
    // weaker question shape. The response mode and distinct gold/target signatures
    // are required for immediate, delayed, and transfer verification alike.
    probe_spec: ConjectureProbeSpecV2,
    tested_claim_md: z.string().trim().min(1).max(280),
    target_error_rule_md: z.string().trim().min(1).max(1000),
    // Required only to make the transfer claim auditable: this says what changed,
    // not whether transfer succeeded.
    context_change_md: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const InterventionPackageModelOutput = z
  .object({
    schema_version: z.literal(INTERVENTION_CONTRACT_VERSION),
    material: z
      .object({
        title_md: z.string().trim().min(1).max(500),
        body_md: z.string().trim().min(1).max(12_000),
      })
      .strict(),
    diagnostics: z
      .object({
        immediate: InterventionDiagnosticDraft.extend({ kind: z.literal('immediate') }),
        delayed: InterventionDiagnosticDraft.extend({ kind: z.literal('delayed') }),
        transfer: InterventionDiagnosticDraft.extend({
          kind: z.literal('transfer'),
          context_change_md: z.string().trim().min(1).max(1000),
        }),
      })
      .strict(),
  })
  .strict();
export type InterventionPackageModelOutputT = z.infer<typeof InterventionPackageModelOutput>;

export const InterventionPackage = InterventionPackageModelOutput.extend({
  intervention_id: z.string().trim().min(1).max(240),
  intervention_version: z.number().int().positive(),
  package_version: z.literal(INTERVENTION_CONTRACT_VERSION),
  method_id: PedagogyMethodId,
  method_definition_version: z.literal(PEDAGOGY_METHOD_DEFINITION_VERSION),
  author_task_run_id: z.string().trim().min(1).max(240),
}).strict();
export type InterventionPackageT = z.infer<typeof InterventionPackage>;

export const InterventionPackageReviewFailureCode = z.enum([
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

export const InterventionPackageReviewModelOutput = z.discriminatedUnion('verdict', [
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
export type InterventionPackageReviewModelOutputT = z.infer<
  typeof InterventionPackageReviewModelOutput
>;

/** Flat provider schema; the canonical reader above enforces pass/fail branch rules. */
export const InterventionPackageReviewStructuredOutput = z
  .object({
    verdict: z.enum(['pass', 'fail']),
    failure_codes: z.array(InterventionPackageReviewFailureCode).max(12),
    summary_md: z.string().trim().min(1).max(2000),
  })
  .strict();

export const InterventionPackageReviewAudit = z
  .object({
    review_version: z.literal(INTERVENTION_CONTRACT_VERSION),
    package_digest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    review_task_run_id: z.string().trim().min(1).max(240),
    result: InterventionPackageReviewModelOutput,
  })
  .strict();
export type InterventionPackageReviewAuditT = z.infer<typeof InterventionPackageReviewAudit>;

export const InterventionPreparationAttempt = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('author_failed'),
      attempt: z.number().int().min(1).max(MAX_INTERVENTION_PACKAGE_ATTEMPTS),
      author_task_run_id: z.string().trim().min(1).max(240).optional(),
      failure_code: z.string().trim().min(1).max(160),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reviewed_package'),
      attempt: z.number().int().min(1).max(MAX_INTERVENTION_PACKAGE_ATTEMPTS),
      package: InterventionPackage,
      review: InterventionPackageReviewAudit,
      deterministic_failure_codes: z.array(z.string().trim().min(1).max(160)).max(30),
    })
    .strict(),
]);
export type InterventionPreparationAttemptT = z.infer<typeof InterventionPreparationAttempt>;

export const InterventionAuthoringContext = z
  .object({
    snapshot: InterventionSnapshot,
    recommendation: ConcretePedagogyRecommendation,
  })
  .strict();
export type InterventionAuthoringContextT = z.infer<typeof InterventionAuthoringContext>;
