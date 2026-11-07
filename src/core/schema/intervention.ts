// Cross-capability vocabulary for the intervention preparation contracts.
//
// Agency owns every lifecycle write. Practice owns package authoring. Keeping the
// immutable JSON contracts in core lets both capabilities validate the same data
// without importing one another's server implementation or database tables.
//
// Internal layout: the admission-audit vocabulary (independent solutions,
// content validation) plus the retired comparator-era review protocol live in
// ./intervention-review.ts; persisted-era decoding readers live in
// ./intervention-review-history.ts. Both are internal modules — the public
// surface is exported from this file.

import { z } from 'zod';
import { PedagogyMethodId, PrecisionBand, ThetaBand } from '@/core/pedagogy/method-library';
import {
  type AnswerKeyT,
  CURRENT_BLANK_NORMALIZATION,
  type FrozenKeyAgreementUnit,
  compareAnswerKeys,
} from '@/core/schema/assessment/answer-compare';
import {
  ConjectureDiagnosticSpec,
  ConjectureProbeSpecV2,
  ConjectureProbeSpecV2Base,
  evaluateConjectureProbeResponseStructure,
} from '@/core/schema/business';
import {
  INTERVENTION_CONTRACT_VERSION,
  InterventionDiagnosticKind,
  type InterventionDiagnosticKindT,
  InterventionIndependentSolutionAudit,
  InterventionQuestionContentValidationAudit,
} from './intervention-review';
import { InterventionPackageReviewAudit } from './intervention-review-history';

export const MAX_INTERVENTION_PACKAGE_ATTEMPTS = 2 as const;
export const MAX_INTERVENTION_SOLVER_ATTEMPTS_PER_DIAGNOSTIC = 2 as const;
export const MAX_INTERVENTION_CONTENT_VALIDATION_ATTEMPTS_PER_DIAGNOSTIC = 1 as const;

// The same-model package comparator is gone; a package attempt spends at most
// three blind solves (bounded retry each) plus three release-strict content
// validations. Historical author_failed rows may still list up to eleven
// validator run ids (the retired comparator ceiling), so the persisted schema
// keeps that wider bound for old rows.
export const MAX_INTERVENTION_VALIDATOR_CALLS_PER_PACKAGE =
  3 *
  (MAX_INTERVENTION_SOLVER_ATTEMPTS_PER_DIAGNOSTIC +
    MAX_INTERVENTION_CONTENT_VALIDATION_ATTEMPTS_PER_DIAGNOSTIC);
export const MAX_INTERVENTION_VALIDATOR_CALL_IDS_PER_PACKAGE_HISTORICAL =
  MAX_INTERVENTION_VALIDATOR_CALLS_PER_PACKAGE + 2;
export const MAX_INTERVENTION_PREPARATION_CALLS_PER_DELIVERY =
  1 + MAX_INTERVENTION_PACKAGE_ATTEMPTS * (1 + MAX_INTERVENTION_VALIDATOR_CALLS_PER_PACKAGE);

export const PEDAGOGY_METHOD_DEFINITION_VERSION = 'pedagogy_method_library_v1' as const;
export const INTERVENTION_ACTIVATED_ACTION = 'experimental:intervention_activated' as const;
export const INTERVENTION_PREPARATION_FAILED_ACTION =
  'experimental:intervention_preparation_failed' as const;
export const INTERVENTION_SETTLED_ACTION = 'experimental:intervention_settled' as const;

export const INTERVENTION_DELAYED_DIAGNOSTIC_DAYS = 7 as const;
export const INTERVENTION_TRANSFER_DIAGNOSTIC_DAYS = 21 as const;
export const INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE = 'intervention_diagnostic' as const;

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

/** Canonical lineage contract stored on each materialized diagnostic question. */
export const InterventionDiagnosticQuestionMetadata = z
  .object({
    schema_version: z.literal(INTERVENTION_CONTRACT_VERSION),
    intervention_id: z.string().trim().min(1).max(240),
    intervention_version: z.number().int().positive(),
    diagnostic_kind: InterventionDiagnosticKind,
    knowledge_id: z.string().trim().min(1).max(240),
    due_at: z.string().datetime(),
  })
  .strict();
export type InterventionDiagnosticQuestionMetadataT = z.infer<
  typeof InterventionDiagnosticQuestionMetadata
>;

export const InterventionDiagnosticStatus = z.enum(['scheduled', 'passed', 'failed', 'held']);
export type InterventionDiagnosticStatusT = z.infer<typeof InterventionDiagnosticStatus>;

const InterventionScheduledDiagnostic = z
  .object({
    kind: InterventionDiagnosticKind,
    question_id: z.string().trim().min(1).max(500),
    due_at: z.string().datetime(),
    status: InterventionDiagnosticStatus,
    review_event_id: z.string().trim().min(1).max(240).nullable(),
    verdict_event_id: z.string().trim().min(1).max(240).nullable(),
    completed_at: z.string().datetime().nullable(),
  })
  .strict();
export type InterventionScheduledDiagnosticT = z.infer<typeof InterventionScheduledDiagnostic>;

export const InterventionSettlement = z
  .object({
    schema_version: z.literal(INTERVENTION_CONTRACT_VERSION),
    diagnostics: z
      .object({
        immediate: InterventionScheduledDiagnostic.extend({ kind: z.literal('immediate') }),
        delayed: InterventionScheduledDiagnostic.extend({ kind: z.literal('delayed') }),
        transfer: InterventionScheduledDiagnostic.extend({ kind: z.literal('transfer') }),
      })
      .strict(),
    scheduled_at: z.string().datetime(),
    completed_at: z.string().datetime().nullable(),
  })
  .strict();
export type InterventionSettlementT = z.infer<typeof InterventionSettlement>;

function addUtcDays(value: Date, days: number): string {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function interventionDiagnosticQuestionId(
  interventionId: string,
  version: number,
  kind: InterventionDiagnosticKindT,
): string {
  return `intervention:${interventionId}:v${version}:${kind}`;
}

/**
 * Fixed first-pass schedule for the atomic intervention package.
 *
 * The immediate check is due at activation. The durable windows initially carry
 * deterministic provisional dates but are not exposed to the learner until the
 * immediate review proves delivery; {@link reanchorInterventionFollowupDiagnostics}
 * then moves them to exactly +7/+21 days from that immutable review timestamp.
 */
export function buildInterventionSettlement(input: {
  interventionId: string;
  version: number;
  activatedAt: Date;
}): InterventionSettlementT {
  const diagnostic = (kind: InterventionDiagnosticKindT, dueAt: string) => ({
    kind,
    question_id: interventionDiagnosticQuestionId(input.interventionId, input.version, kind),
    due_at: dueAt,
    status: 'scheduled' as const,
    review_event_id: null,
    verdict_event_id: null,
    completed_at: null,
  });
  return InterventionSettlement.parse({
    schema_version: INTERVENTION_CONTRACT_VERSION,
    diagnostics: {
      immediate: diagnostic('immediate', input.activatedAt.toISOString()),
      delayed: diagnostic(
        'delayed',
        addUtcDays(input.activatedAt, INTERVENTION_DELAYED_DIAGNOSTIC_DAYS),
      ),
      transfer: diagnostic(
        'transfer',
        addUtcDays(input.activatedAt, INTERVENTION_TRANSFER_DIAGNOSTIC_DAYS),
      ),
    },
    scheduled_at: input.activatedAt.toISOString(),
    completed_at: null,
  });
}

/**
 * Anchor retention/transfer to confirmed learner exposure.
 *
 * The immediate review is the first immutable fact proving the combined
 * material + immediate-check surface was opened and completed. Preserve that
 * first completion timestamp across rejudges and deterministically derive every
 * still-scheduled follow-up from it.
 */
export function reanchorInterventionFollowupDiagnostics(
  settlement: InterventionSettlementT,
): InterventionSettlementT {
  const exposedAt = settlement.diagnostics.immediate.completed_at;
  if (!exposedAt) return settlement;
  const anchor = new Date(exposedAt);
  return InterventionSettlement.parse({
    ...settlement,
    diagnostics: {
      ...settlement.diagnostics,
      delayed:
        settlement.diagnostics.delayed.status === 'scheduled'
          ? {
              ...settlement.diagnostics.delayed,
              due_at: addUtcDays(anchor, INTERVENTION_DELAYED_DIAGNOSTIC_DAYS),
            }
          : settlement.diagnostics.delayed,
      transfer:
        settlement.diagnostics.transfer.status === 'scheduled'
          ? {
              ...settlement.diagnostics.transfer,
              due_at: addUtcDays(anchor, INTERVENTION_TRANSFER_DIAGNOSTIC_DAYS),
            }
          : settlement.diagnostics.transfer,
    },
  });
}

/**
 * A durable effect requires both retention and transfer. Mixed results are
 * intentionally inconclusive rather than being averaged into a false win.
 */
export function interventionOutcomeFromSettlement(
  settlement: InterventionSettlementT,
): InterventionOutcomeT | null {
  const diagnostics = Object.values(settlement.diagnostics);
  if (diagnostics.some((entry) => entry.status === 'scheduled' || entry.status === 'held'))
    return null;
  if (
    settlement.diagnostics.immediate.status === 'passed' &&
    settlement.diagnostics.delayed.status === 'passed' &&
    settlement.diagnostics.transfer.status === 'passed'
  ) {
    return 'effective';
  }
  if (
    settlement.diagnostics.delayed.status === 'failed' &&
    settlement.diagnostics.transfer.status === 'failed'
  ) {
    return 'ineffective';
  }
  return 'inconclusive';
}

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

const InterventionResponseSignatureStructuredOutput = z
  .object({
    kind: z.enum(['choice', 'text', 'answer_with_reason', 'rubric']),
    option_ids: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
    response_md: z.string().trim().min(1).max(2000).optional(),
    answer_md: z.string().trim().min(1).max(2000).optional(),
    required_reason_features_md: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(10)
      .optional(),
    required_features_md: z.array(z.string().trim().min(1).max(500)).min(1).max(10).optional(),
  })
  .strict();

const InterventionProbeStructuredOutput = ConjectureProbeSpecV2Base.extend({
  gold_response_signature: InterventionResponseSignatureStructuredOutput,
  target_error_response_signature: InterventionResponseSignatureStructuredOutput,
}).strict();

const InterventionDiagnosticStructuredOutput = InterventionDiagnosticDraft.extend({
  probe_spec: InterventionProbeStructuredOutput,
});

/** Flat provider schema; canonical Probe V2 readers enforce signature branches afterwards. */
export const InterventionPackageStructuredOutput = z
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
        immediate: InterventionDiagnosticStructuredOutput.extend({
          kind: z.literal('immediate'),
        }),
        delayed: InterventionDiagnosticStructuredOutput.extend({
          kind: z.literal('delayed'),
        }),
        transfer: InterventionDiagnosticStructuredOutput.extend({
          kind: z.literal('transfer'),
          context_change_md: z.string().trim().min(1).max(1000),
        }),
      })
      .strict(),
  })
  .strict();

export const InterventionPackage = InterventionPackageModelOutput.extend({
  intervention_id: z.string().trim().min(1).max(240),
  intervention_version: z.number().int().positive(),
  package_version: z.literal(INTERVENTION_CONTRACT_VERSION),
  method_id: PedagogyMethodId,
  method_definition_version: z.literal(PEDAGOGY_METHOD_DEFINITION_VERSION),
  author_task_run_id: z.string().trim().min(1).max(240),
}).strict();
export type InterventionPackageT = z.infer<typeof InterventionPackage>;

function normalizeInterventionIdentity(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function interventionAnswerLeaks(prompt: string, answer: string): boolean {
  const normalizedAnswer = normalizeInterventionIdentity(answer);
  // Very short tokens occur frequently in prose, so substring matching would
  // produce excessive false positives. Sub-3-char leakage used to fall to the
  // same-model review; release-strict grounding validation is now the only guard.
  if (normalizedAnswer.length < 3) return false;
  return normalizeInterventionIdentity(prompt).includes(normalizedAnswer);
}

/** Pure, authoritative package checks shared by authoring and activation. */
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
    const promptIdentity = normalizeInterventionIdentity(probeSpec.prompt_md);
    if (promptIdentities.has(promptIdentity)) failures.push(`${diagnostic.kind}:duplicate_prompt`);
    promptIdentities.add(promptIdentity);
    for (const code of evaluateConjectureProbeResponseStructure(probeSpec)) {
      failures.push(`${diagnostic.kind}:${code}`);
    }
    if (
      interventionAnswerLeaks(probeSpec.prompt_md, probeSpec.reference_md) ||
      interventionAnswerLeaks(probeSpec.prompt_md, probeSpec.expected_target_error_answer_md)
    ) {
      failures.push(`${diagnostic.kind}:answer_leak`);
    }
  }
  if (!packageValue.diagnostics.transfer.context_change_md.trim()) {
    failures.push('transfer:context_change_missing');
  }
  return [...new Set(failures)].sort();
}

export type InterventionIndependentSolutionAgreement =
  | { status: 'agree'; detail?: string }
  | { status: 'disagree'; detail: string }
  | { status: 'uncomparable'; detail: string };

/**
 * Deterministic blind-solve vs gold comparison — the half of the retired
 * same-model review that has no model replacement. A 'text' gold mints a
 * single-alias blank_text key; the solver is consistent when any of its
 * declared forms (final answer plus equivalents) agrees with that key under
 * the current blank-key normalization (no declared answer shape exists on a
 * probe spec, so none is passed). Signatures with no deterministic key form
 * (choice option ids the blind solver never sees, reason features, rubric
 * criteria) are 'uncomparable'; the caller decides the fail policy.
 */
export function compareInterventionIndependentSolution(input: {
  goldResponseSignature: InterventionPackageT['diagnostics']['immediate']['probe_spec']['gold_response_signature'];
  solverFinalAnswer: string | null | undefined;
  solverAnswerEquivalents: readonly string[] | null | undefined;
}): InterventionIndependentSolutionAgreement {
  const gold = input.goldResponseSignature;
  if (gold.kind !== 'text') {
    return {
      status: 'uncomparable',
      detail: `gold signature kind '${gold.kind}' has no deterministic solver-key form`,
    };
  }
  const responseMd = gold.response_md;
  if (responseMd == null || responseMd.trim().length === 0) {
    return { status: 'uncomparable', detail: 'text gold signature carries no response_md' };
  }
  const solverForms = [input.solverFinalAnswer, ...(input.solverAnswerEquivalents ?? [])]
    .map((form) => (typeof form === 'string' ? form.trim() : ''))
    .filter((form) => form.length > 0);
  if (solverForms.length === 0) {
    return { status: 'uncomparable', detail: 'solver emitted no answer forms' };
  }
  const unit: FrozenKeyAgreementUnit = {
    blank_normalization: CURRENT_BLANK_NORMALIZATION,
    declared_shape: null,
  };
  const goldKey: AnswerKeyT = { kind: 'blank_text', accepted: [responseMd] };
  let detail = 'solver-derived forms disagree with the gold signature';
  for (const form of solverForms) {
    const agreement = compareAnswerKeys(goldKey, { kind: 'blank_text', accepted: [form] }, unit);
    if (agreement.agree) return { status: 'agree', detail: agreement.detail };
    if (agreement.detail) detail = agreement.detail;
  }
  return { status: 'disagree', detail };
}

export const InterventionPreparationAttempt = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('author_failed'),
      attempt: z.number().int().min(1).max(MAX_INTERVENTION_PACKAGE_ATTEMPTS),
      author_task_run_id: z.string().trim().min(1).max(240).optional(),
      validator_task_run_ids: z
        .array(z.string().trim().min(1).max(240))
        .max(MAX_INTERVENTION_VALIDATOR_CALL_IDS_PER_PACKAGE_HISTORICAL)
        .optional(),
      failure_code: z.string().trim().min(1).max(160),
    })
    .strict(),
  z
    .object({
      // Current admission evidence: the two sealed shared-validator audits plus
      // the deterministic package checks. The same-model package comparator that
      // used to wrap these in a `review` object is deleted; attempts persisted
      // before that deletion keep the `reviewed_package` branch below readable.
      kind: z.literal('validated_package'),
      attempt: z.number().int().min(1).max(MAX_INTERVENTION_PACKAGE_ATTEMPTS),
      package: InterventionPackage,
      independent_solution_audit: InterventionIndependentSolutionAudit,
      question_content_validation_audit: InterventionQuestionContentValidationAudit,
      deterministic_failure_codes: z.array(z.string().trim().min(1).max(160)).max(30),
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

/** Canonical release-strict input for the shared QuizVerifyTask grounding axis. */
export function buildInterventionQuestionContentValidationTaskInput(input: {
  context: InterventionAuthoringContextT;
  packageValue: InterventionPackageT;
  kind: InterventionDiagnosticKindT;
  subjectId: string;
}) {
  const diagnostic = input.packageValue.diagnostics[input.kind];
  return {
    question: {
      id: `${input.packageValue.intervention_id}:v${input.packageValue.intervention_version}:${input.kind}`,
      prompt_md: diagnostic.probe_spec.prompt_md,
      reference_md: diagnostic.probe_spec.reference_md,
      choices_md: null,
      kind: diagnostic.probe_spec.response_mode,
      difficulty: null,
      knowledge_ids: [input.context.snapshot.conjecture.knowledge_id],
    },
    knowledge_context: [
      {
        id: input.context.snapshot.conjecture.knowledge_id,
        name: input.context.snapshot.conjecture.knowledge_name,
        domain: input.subjectId,
      },
    ],
    source_pack: {
      query_plan: [],
      searched_at: input.context.snapshot.created_at,
      tool: 'none' as const,
    },
    source_refs: [],
    self_copy_safety: { verdict: 'unknown' as const, checked_by: 'agent_self' as const },
    generation_method: 'closed_book' as const,
    author_material: input.packageValue.material,
    validation_mode: 'release_strict' as const,
  };
}

// Public re-exports — the review-audit cluster lives in the sibling internal
// modules. The comparator-era shapes stay exported for reading persisted
// attempts; no current writer constructs them.
export type {
  InterventionDiagnosticKindT,
  InterventionIndependentSolutionAuditT,
  InterventionQuestionContentValidationAuditT,
} from './intervention-review';
export {
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION,
  InterventionIndependentSolutionAudit,
  InterventionQuestionContentValidationAudit,
  interventionRequiredOperationDigest,
} from './intervention-review';
export type {
  InterventionPackageReviewAuditT,
  InterventionPackageReviewModelOutputT,
} from './intervention-review-history';
