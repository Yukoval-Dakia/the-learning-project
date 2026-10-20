// YUK-791 — cross-capability vocabulary for the intervention preparation wave.
//
// Agency owns every lifecycle write. Practice owns package authoring. Keeping the
// immutable JSON contracts in core lets both capabilities validate the same data
// without importing one another's server implementation or database tables.
//
// Internal layout: review-audit protocol vocabulary + the current binding live
// in ./intervention-review.ts; persisted-era decoding readers live in
// ./intervention-review-history.ts. Both are internal modules — the public
// surface stays exported from this file unchanged.

import { z } from 'zod';
import { PedagogyMethodId, PrecisionBand, ThetaBand } from '@/core/pedagogy/method-library';
import {
  ConjectureDiagnosticSpec,
  ConjectureProbeSpecV2,
  ConjectureProbeSpecV2Base,
  evaluateConjectureProbeResponseStructure,
} from '@/core/schema/business';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import {
  INTERVENTION_CONTRACT_VERSION,
  InterventionDiagnosticKind,
  type InterventionDiagnosticKindT,
  type InterventionIndependentSolutionAuditT,
  type InterventionQuestionContentValidationAuditT,
  InterventionReferenceReverseCausationClaim,
  type InterventionReferenceReverseCausationClaimT,
  MAX_INTERVENTION_REVERSE_CAUSATION_CLAIMS,
  MAX_INTERVENTION_REVIEW_ATTEMPTS,
} from './intervention-review';
import { InterventionPackageReviewAudit } from './intervention-review-history';

export const MAX_INTERVENTION_PACKAGE_ATTEMPTS = 2 as const;
export const MAX_INTERVENTION_SOLVER_ATTEMPTS_PER_DIAGNOSTIC = 2 as const;
export const MAX_INTERVENTION_CONTENT_VALIDATION_ATTEMPTS_PER_DIAGNOSTIC = 1 as const;

export const MAX_INTERVENTION_VALIDATOR_CALLS_PER_PACKAGE =
  3 *
    (MAX_INTERVENTION_SOLVER_ATTEMPTS_PER_DIAGNOSTIC +
      MAX_INTERVENTION_CONTENT_VALIDATION_ATTEMPTS_PER_DIAGNOSTIC) +
  MAX_INTERVENTION_REVIEW_ATTEMPTS;
export const MAX_INTERVENTION_PREPARATION_CALLS_PER_DELIVERY =
  1 + MAX_INTERVENTION_PACKAGE_ATTEMPTS * (1 + MAX_INTERVENTION_VALIDATOR_CALLS_PER_PACKAGE);
export const MAX_INTERVENTION_REVIEW_EVAL_CALLS_PER_CASE =
  MAX_INTERVENTION_VALIDATOR_CALLS_PER_PACKAGE;

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
  // produce excessive false positives. Their leakage remains a comparator check.
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

export const InterventionPackageReviewRequirements = z
  .object({
    audit_entire_solution_path: z.literal(true),
    causal_direction_required: z.boolean(),
  })
  .strict();
export type InterventionPackageReviewRequirementsT = z.infer<
  typeof InterventionPackageReviewRequirements
>;

/**
 * Find explicit reverse-causation assertions on the authoritative answer surface.
 *
 * Discovery is deliberately server-owned: a comparator may classify a claim,
 * but it cannot make an inconvenient claim disappear. Only reference_md and the
 * gold response signature are authoritative here. Target-error examples,
 * teaching material, the frozen conjecture and blind-solver output are excluded
 * because each can mention the misconception without asserting that it is true.
 */
export function extractInterventionReferenceReverseCausationClaims(
  packageValue: InterventionPackageT,
  kind: InterventionDiagnosticKindT,
): InterventionReferenceReverseCausationClaimT[] {
  const probe = packageValue.diagnostics[kind].probe_spec;
  const surfaces: Array<{ source_path: string; claim_md: string }> = [
    {
      source_path: `package.diagnostics.${kind}.probe_spec.reference_md`,
      claim_md: probe.reference_md,
    },
  ];
  const signature = probe.gold_response_signature;
  const signaturePath = `package.diagnostics.${kind}.probe_spec.gold_response_signature`;
  if (signature.kind === 'text') {
    surfaces.push({ source_path: `${signaturePath}.response_md`, claim_md: signature.response_md });
  } else if (signature.kind === 'answer_with_reason') {
    surfaces.push({ source_path: `${signaturePath}.answer_md`, claim_md: signature.answer_md });
    for (const [index, claimMd] of signature.required_reason_features_md.entries()) {
      surfaces.push({
        source_path: `${signaturePath}.required_reason_features_md[${index}]`,
        claim_md: claimMd,
      });
    }
  } else if (signature.kind === 'rubric') {
    for (const [index, claimMd] of signature.required_features_md.entries()) {
      surfaces.push({
        source_path: `${signaturePath}.required_features_md[${index}]`,
        claim_md: claimMd,
      });
    }
  }

  const marker =
    /反向因果(?:关系|偏倚)?|逆向因果(?:关系|偏倚)?|因果倒置|reverse[\s-]+caus(?:ation|ality)|(?<![不非])(?:属于|构成)\s*同一\s*(?:outcome\s*construct|结果构念|结局构念)[^。！？!?]{0,80}\bY\s*→\s*X\b/giu;
  const excerptBounds = (text: string, markerStart: number, markerEnd: number) => {
    const left = text.slice(0, markerStart);
    const leftBoundary = Math.max(
      left.lastIndexOf('。'),
      left.lastIndexOf('！'),
      left.lastIndexOf('？'),
      left.lastIndexOf('!'),
      left.lastIndexOf('?'),
      left.lastIndexOf('\n'),
    );
    const right = text.slice(markerEnd);
    const candidateEnds = ['。', '！', '？', '!', '?', '\n']
      .map((boundary) => right.indexOf(boundary))
      .filter((index) => index >= 0);
    const rightBoundary =
      candidateEnds.length > 0 ? markerEnd + Math.min(...candidateEnds) + 1 : text.length;
    let start = leftBoundary + 1;
    let end = rightBoundary;
    while (start < end && /\s/u.test(text[start] ?? '')) start += 1;
    while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1;
    return { start, end };
  };
  const assertionPolarity = (
    rawExcerpt: string,
    markerStartInExcerpt: number,
    markerEndInExcerpt: number,
  ): 'positive' | 'negative_or_meta' | 'unknown' => {
    const excerpt = rawExcerpt.replace(/[*_`]/gu, ' ');
    const prefix = excerpt.slice(0, markerStartInExcerpt);
    const suffix = excerpt.slice(markerEndInExcerpt);
    const matchedMarker = excerpt.slice(markerStartInExcerpt, markerEndInExcerpt);
    const matchedSemanticMarker =
      /(?:属于|构成)\s*同一\s*(?:outcome\s*construct|结果构念|结局构念)[^。！？!?]{0,80}\bY\s*→\s*X\b/iu.test(
        matchedMarker,
      );
    const semanticArrowStart = matchedMarker.search(/\bY\s*→\s*X\b/iu);
    const semanticArrowPrefix =
      semanticArrowStart >= 0 ? matchedMarker.slice(0, semanticArrowStart) : matchedMarker;
    let semanticClauseStart = 0;
    for (const match of semanticArrowPrefix.matchAll(
      /(?:但(?:是)?|然而|不过|而是|反而|\bbut\b|\bhowever\b|\brather\b|\binstead\b)/giu,
    )) {
      semanticClauseStart = match.index ?? semanticClauseStart;
    }
    semanticClauseStart = Math.max(
      semanticClauseStart,
      semanticArrowPrefix.lastIndexOf('；') + 1,
      semanticArrowPrefix.lastIndexOf(';') + 1,
    );
    const semanticAssertionClause = matchedMarker.slice(semanticClauseStart);
    const semanticMarkerNegated =
      matchedSemanticMarker &&
      /(?:而非|并非|不是|否认|反对|不能推出|无法推出|不(?:再|予以|能|应|该|宜)?支持|\bnot\b|\bno\b|\bdoes\s+not\b|\bdid\s+not\b|\bcannot\b|\bcan't\b)/iu.test(
        semanticAssertionClause,
      );

    // Polarity cues apply to the local contrast clause, not to every statement
    // in the surrounding sentence. Without this boundary, a negation about
    // X→Y before "但/而是" can hide a positive Y→X assertion, while a later
    // rejection of a common cause can incorrectly negate the Y→X assertion.
    const contrast =
      /(?:但(?:是)?|然而|不过|而是|反而|\bbut\b|\bhowever\b|\brather\b|\binstead\b)/giu;
    let prefixClauseStart = 0;
    for (const match of prefix.matchAll(contrast)) {
      prefixClauseStart = match.index ?? prefixClauseStart;
    }
    prefixClauseStart = Math.max(
      prefixClauseStart,
      prefix.lastIndexOf('；') + 1,
      prefix.lastIndexOf(';') + 1,
    );
    contrast.lastIndex = 0;
    const suffixContrast = contrast.exec(suffix);
    const suffixClauseEnds = [
      suffixContrast?.index,
      suffix.indexOf('；'),
      suffix.indexOf(';'),
    ].filter((index): index is number => index !== undefined && index >= 0);
    const prefixClause = prefix.slice(prefixClauseStart);
    const suffixClause = suffix.slice(
      0,
      suffixClauseEnds.length > 0 ? Math.min(...suffixClauseEnds) : suffix.length,
    );
    const postContrastSuffix = suffixContrast ? suffix.slice(suffixContrast.index) : '';

    // "不能排除" is affirmative uncertainty, and must win over the embedded
    // negative token before generic negative patterns are evaluated.
    if (
      /(?:不|不能|无法)排除\s*$/u.test(prefixClause) ||
      /无法排除/u.test(suffixClause) ||
      /\b(?:cannot|can't|could not)\s+(?:rule out|exclude)\s*$/iu.test(prefixClause)
    ) {
      return 'positive';
    }
    if (
      /(?:学生误以为|错误答案(?:认为|声称)|目标错误(?:写成|认为)|误判为|错误地(?:称为|认为))/u.test(
        prefixClause,
      ) ||
      /(?:什么是|何为|如何(?:定义|识别)|术语|定义|是否(?:存在|属于|构成)|讨论是否)[^。！？!?]{0,28}$/u.test(
        prefixClause,
      ) ||
      /\b(?:what is|define|definition of|whether there is|whether .* (?:is|constitutes))\b[^.!?]{0,36}$/iu.test(
        prefixClause,
      ) ||
      /^(?:\s*[：:]?\s*(?:(?:该|此|这(?:一|种)?|上述)(?:解释|说法|可能性|因果关系?)?|(?:本题(?:中)?|这里|此处)?\s*(?:反向|逆向)?因果(?:关系|偏倚)?|本题)\s*)?(?:是\s*)?(?:并)?(?:错误(?:的)?|不成立|不存在|不适用|错误标签|并非如此|不能据此成立)/u.test(
        suffixClause,
      ) ||
      /^\s*(?:is|was|are|were)\s+(?:wrong|false|incorrect|invalid|unsupported|inapplicable)\b/iu.test(
        suffixClause,
      ) ||
      /^\s*(?:is|was|are|were)\s+not\s+(?:valid|supported|applicable|present|possible|plausible)\b/iu.test(
        suffixClause,
      ) ||
      /(?:没有|无|未发现|未见|不存在|并非|不是|非|不属于|不构成|不能称为|不可视为)(?:[^。！？!?]{0,28})(?:证据(?:支持|表明)?|支持|表明|存在|发生|属于|构成)?\s*$/u.test(
        prefixClause,
      ) ||
      /(?:不\s*应|不\s*该|不\s*宜|不能|不可|并非|不是|不|非)\s*$/u.test(prefixClause) ||
      /不(?:认为|承认|同意|支持)[^。！？!?；;]{0,16}$/u.test(prefixClause) ||
      /\b(?:does?|did)\s+not\s+(?:consider|believe|accept|support)\b[^.!?;]{0,20}$/iu.test(
        prefixClause,
      ) ||
      semanticMarkerNegated ||
      /(?:但(?:是)?|然而|不过|but|however)[^。！？!?]{0,18}(?:(?:该|此|这(?:一|种)?|上述)(?:解释|说法|可能性|因果关系?)?|(?:反向|逆向)因果(?:关系|偏倚)?)[^。！？!?]{0,8}(?:不成立|错误|并非如此|不适用)/iu.test(
        postContrastSuffix,
      ) ||
      /\b(?:student|incorrect answer)\b[^.!?]{0,40}\b(?:mistakenly|incorrectly)\b/iu.test(
        prefixClause,
      ) ||
      /\b(?:no|not|without|no evidence|does not support|does not constitute|cannot be called|unclear whether)\b[^.!?]{0,40}$/iu.test(
        prefixClause,
      )
    ) {
      return 'negative_or_meta';
    }
    if (
      /(?:并非|不是|非|不属于|不构成|不能称为|不可视为|不存在|没有|无|未发现|未见|没有证据(?:支持|表明)|无证据(?:支持|表明)|不足以证明|不一定是|未必是|不能断定|无法判断是否|是否存在)\s*(?:真正(?:的)?\s*)?$/u.test(
        prefixClause,
      ) ||
      /^(?:并不成立|不存在|不适用|是错误标签)/u.test(suffixClause) ||
      /\b(?:no|not|without|no evidence of|does not support|does not constitute|cannot be called|unclear whether)\b[^.!?]{0,28}$/iu.test(
        prefixClause,
      )
    ) {
      return 'negative_or_meta';
    }
    if (
      /(?:可能存在|存在|可能有|属于|构成|而是|是|可解释为|提示|应考虑|需警惕|包括|真正(?:的)?)[^，,；;]{0,24}$/u.test(
        prefixClause,
      ) ||
      /^(?:\s*[”"'）)]?\s*[：:]|\s*[（(“"']|\s*(?:是|指|成立|发生|存在|可能存在|可能发生|可能是|可以是|可以解释|会|的可能))/u.test(
        suffixClause,
      ) ||
      /\b(?:there (?:may|could) be|possible|potential|likely|may reflect|may indicate|is present|is possible)\b[^.!?]{0,36}$/iu.test(
        prefixClause,
      ) ||
      /\b(?:there|this|it)\s+(?:is|was)\s*$/iu.test(prefixClause) ||
      /\b(?:demonstrates?|shows?|indicates?|supports?|constitutes?)\s*$/iu.test(prefixClause) ||
      /\b(?:but|rather|instead)\s*$/iu.test(prefixClause) ||
      /^\s*(?:may|might|could|can|is|was|occurs?|explains?|may explain)\b/iu.test(suffixClause) ||
      (matchedSemanticMarker && !semanticMarkerNegated)
    ) {
      return 'positive';
    }
    return 'unknown';
  };

  const claims: Array<
    Omit<InterventionReferenceReverseCausationClaimT, 'claim_index' | 'claim_sha256'>
  > = [];
  for (const surface of surfaces) {
    marker.lastIndex = 0;
    for (const match of surface.claim_md.matchAll(marker)) {
      const markerStart = match.index ?? 0;
      const markerEnd = markerStart + match[0].length;
      const bounds = excerptBounds(surface.claim_md, markerStart, markerEnd);
      const claimMd = surface.claim_md.slice(bounds.start, bounds.end);
      if (
        assertionPolarity(claimMd, markerStart - bounds.start, markerEnd - bounds.start) !==
        'positive'
      ) {
        continue;
      }
      claims.push({
        source_path: surface.source_path,
        excerpt_start_utf16: bounds.start,
        excerpt_end_utf16: bounds.end,
        marker_start_utf16: markerStart,
        marker_end_utf16: markerEnd,
        claim_md: claimMd,
      });
    }
  }
  if (claims.length > MAX_INTERVENTION_REVERSE_CAUSATION_CLAIMS) {
    throw new Error('reverse-causation claim extraction exceeded the bounded claim budget');
  }
  return claims.map((claim, claimIndex) => {
    const digestInput = { ...claim, claim_index: claimIndex };
    return InterventionReferenceReverseCausationClaim.parse({
      ...digestInput,
      claim_sha256: sha256CanonicalJson(digestInput),
    });
  });
}

/**
 * Server-owned semantic routing from the frozen conjecture contract.
 *
 * V2 carries an explicit semantic bit. Historical V1 has no trustworthy way to
 * prove a claim is non-causal, so release-critical FULL review conservatively
 * requires the causal check. The marker scan is defense in depth for a wrongly
 * classified V2 proposal; it is never the sole positive authority.
 */
export function interventionPackageReviewRequirements(
  context: InterventionAuthoringContextT,
): InterventionPackageReviewRequirementsT {
  const conjecture = context.snapshot.conjecture;
  const diagnosticSpec = conjecture.diagnostic_spec;
  const frozenText = [
    conjecture.claim_md,
    conjecture.target_error_rule_md,
    diagnosticSpec.target_error_rule_md,
    diagnosticSpec.trigger_conditions_md,
    diagnosticSpec.scope_boundary_md,
    diagnosticSpec.expected_wrong_answer_signature_md,
  ].join('\n');
  const hasExplicitCausalMarker =
    /(?:因果|反向(?:因果|原因)|共同(?:的)?(?:第三方)?原因|(?:导致|引起|造成|致使|使得|促使|归因于|源于|结果是|原因是)|caus(?:e|al|ation)|confound|lead(?:s|ing)?\s+to|result(?:s|ing)?\s+in|because\s+of)/iu.test(
      frozenText,
    );
  return InterventionPackageReviewRequirements.parse({
    audit_entire_solution_path: true,
    causal_direction_required:
      diagnosticSpec.schema_version === 1 ||
      diagnosticSpec.causal_direction_required ||
      hasExplicitCausalMarker,
  });
}

export const InterventionPreparationAttempt = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('author_failed'),
      attempt: z.number().int().min(1).max(MAX_INTERVENTION_PACKAGE_ATTEMPTS),
      author_task_run_id: z.string().trim().min(1).max(240).optional(),
      validator_task_run_ids: z
        .array(z.string().trim().min(1).max(240))
        .max(MAX_INTERVENTION_VALIDATOR_CALLS_PER_PACKAGE)
        .optional(),
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

/** Canonical comparator input, reconstructed again before activation for run binding. */
export type InterventionPackageReviewTaskInputT = ReturnType<
  typeof buildInterventionPackageReviewTaskInput
>;
export function buildInterventionPackageReviewTaskInput(input: {
  context: InterventionAuthoringContextT;
  packageValue: InterventionPackageT;
  independentAudit: InterventionIndependentSolutionAuditT;
  questionContentValidationAudit: InterventionQuestionContentValidationAuditT;
}) {
  return {
    snapshot: input.context.snapshot,
    recommendation: input.context.recommendation,
    package: input.packageValue,
    review_requirements: interventionPackageReviewRequirements(input.context),
    reference_reverse_causation_claims: InterventionDiagnosticKind.options.map((kind) => ({
      kind,
      claims: extractInterventionReferenceReverseCausationClaims(input.packageValue, kind),
    })),
    sealed_question_content_validations: input.questionContentValidationAudit.diagnostics.map(
      (diagnostic) => ({
        kind: diagnostic.kind,
        task_input_sha256: diagnostic.task_input_sha256,
        result_sha256: diagnostic.result_sha256,
        grounding: diagnostic.result.grounding,
        knowledge_hit: diagnostic.result.knowledge_hit,
        material_grounding: diagnostic.result.material_grounding ?? null,
        overall: diagnostic.result.overall,
        confidence: diagnostic.result.confidence,
      }),
    ),
    sealed_independent_solutions: input.independentAudit.diagnostics.map((diagnostic) => ({
      kind: diagnostic.kind,
      question_input_sha256: diagnostic.question_input_sha256,
      solver_output_sha256: diagnostic.solver_output_sha256,
      final_answer_md: diagnostic.solver_output.reference_solution.final_answer,
      answer_equivalents_md: diagnostic.solver_output.reference_solution.answer_equivalents,
      expected_signals_md: diagnostic.solver_output.reference_solution.expected_signals,
      required_operations: diagnostic.required_operations,
      worked_solution_md: diagnostic.solver_output.worked_solution_md,
      confidence: diagnostic.solver_output.confidence,
    })),
  };
}

// Public re-exports — the review-audit cluster lives in the sibling internal
// modules; the '@/core/schema/intervention' import surface is unchanged.
export type {
  CurrentInterventionPackageReviewAuditT,
  InterventionDiagnosticKindT,
  InterventionIndependentSolutionAuditT,
  InterventionPackageComparatorPackageChecksT,
  InterventionPackageReviewDiagnosticCheckT,
  InterventionPackageReviewFailureCodeT,
  InterventionPackageReviewModelOutputFullT,
  InterventionPackageReviewModelOutputV2T,
  InterventionPackageReviewPackageChecksT,
  InterventionPackageReviewStructuredOutputT,
  InterventionQuestionContentValidationAuditT,
  InterventionReferenceReverseCausationClaimT,
} from './intervention-review';
export {
  CurrentInterventionPackageReviewAudit,
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION,
  InterventionDiagnosticKind,
  InterventionIndependentSolutionAudit,
  InterventionIndependentSolutionDiagnosticAudit,
  InterventionPackageComparatorPackageChecks,
  InterventionPackageReviewAttemptAudit,
  InterventionPackageReviewAuditV2,
  InterventionPackageReviewAuditV3,
  InterventionPackageReviewDiagnosticCheck,
  InterventionPackageReviewFailureCode,
  InterventionPackageReviewModelOutputFull,
  InterventionPackageReviewModelOutputV2,
  InterventionPackageReviewPackageChecks,
  InterventionPackageReviewStructuredOutput,
  InterventionQuestionContentValidationAudit,
  InterventionQuestionContentValidationDiagnosticAudit,
  InterventionReferenceReverseCausationClaim,
  MAX_INTERVENTION_REVERSE_CAUSATION_CLAIMS,
  MAX_INTERVENTION_REVIEW_ATTEMPTS,
  interventionRequiredOperationDigest,
} from './intervention-review';
export type {
  InterventionPackageReviewAuditT,
  InterventionPackageReviewModelOutputT,
} from './intervention-review-history';
export {
  InterventionPackageReviewAudit,
  InterventionPackageReviewModelOutput,
} from './intervention-review-history';
