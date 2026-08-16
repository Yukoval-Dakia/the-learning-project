// YUK-81 / Foundation D M1 Lane C; YUK-832 evidence-reader hardening.
//
// `get_attempt_context` is the exact-id activity reader for answer events. It
// preserves the historical tool/input name, but now distinguishes lookup
// failure modes and supports both attempt and review events. Same-question
// history is explicitly non-causal; causal evidence comes from getEventChain.

import { PedagogyMethodId } from '@/core/pedagogy/method-library';
import {
  PREDICTION_SCORE_ACTION,
  PROBE_NON_EVIDENCE_RESOLUTION,
  PROBE_RESOLUTIONS,
  PROBE_RESULT_ACTION,
  isCanonicalEvidenceProbeOutcomeResolution,
  isCanonicalProbeOutcomeResolution,
} from '@/core/schema/conjecture';
import {
  ConjectureProbeResponseJudgement,
  isCanonicalProbeOutcomeJudgement,
} from '@/core/schema/conjecture-probe-response';
import { GradingCheckpointExperimental, StateSnapshotExperimental } from '@/core/schema/event';
import {
  INTERVENTION_ACTIVATED_ACTION,
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  INTERVENTION_PREPARATION_FAILED_ACTION,
} from '@/core/schema/intervention';
import { AiProposalPayload } from '@/core/schema/proposal';
import { event, question } from '@/db/schema';
import { type EnvelopedEvent, getEventById, getEventChain } from '@/kernel/events';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getFailureAttemptById } from '@/kernel/read-models/failure-attempts';
import { getQuestionTimeline } from '@/kernel/read-models/question-activity';
import { listLearningRecords } from '@/kernel/records/queries';
import { TOOL_COURTESY_DEFAULTS } from '@/kernel/tools/budgets';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

const InputSchema = z.object({
  attemptEventId: z.string().min(1),
  timelineLimit: z.number().int().positive().max(50).optional(),
  causalLimit: z.number().int().positive().max(50).optional(),
});

const FsrsStateEvidenceSchema = z.object({
  due: z.string().datetime(),
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number().optional(),
  scheduled_days: z.number(),
  learning_steps: z.number(),
  reps: z.number().int(),
  lapses: z.number().int(),
  state: z.enum(['new', 'learning', 'review', 'relearning']),
  last_review: z.string().datetime().nullable(),
});

const FsrsEvidenceSchema = z.object({
  rating: z.enum(['again', 'hard', 'good']),
  subject_kind: z.enum(['question', 'knowledge']).nullable(),
  subject_ids: z.array(z.string()),
  state_after: FsrsStateEvidenceSchema,
  state_after_by_subject: z.array(
    z.object({
      subject_kind: z.enum(['question', 'knowledge']),
      subject_id: z.string(),
      state: FsrsStateEvidenceSchema,
      due_at: z.string().datetime(),
    }),
  ),
});

const AnswerActivitySchema = z.object({
  event_id: z.string(),
  dispatch_seq: z.number().int().positive(),
  action: z.enum(['attempt', 'review']),
  outcome: z.enum(['success', 'failure', 'partial']),
  question_id: z.string(),
  answer_md: z.string().nullable(),
  answer_image_refs: z.array(z.string()),
  referenced_knowledge_ids: z.array(z.string()),
  created_at: z.string().datetime(),
  fsrs: FsrsEvidenceSchema.nullable(),
});

const QuestionInfoSchema = z.object({
  id: z.string(),
  kind: z.string(),
  prompt_md: z.string(),
  reference_md: z.string().nullable(),
  knowledge_ids: z.array(z.string()),
});

const CauseSchema = z.object({
  source: z.enum(['user', 'agent']),
  event_id: z.string(),
  primary_category: z.string(),
  secondary_categories: z.array(z.string()),
  analysis_md: z.string().nullable(),
  user_notes: z.string().nullable(),
  confidence: z.number().nullable(),
});

const TimelineEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attempt'),
    event_id: z.string(),
    dispatch_seq: z.number().int().positive(),
    created_at: z.string(),
    outcome: z.string(),
    duration_ms: z.number().nullable(),
    cause: z
      .object({
        primary: z.string(),
        confidence: z.number().nullable(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal('review'),
    event_id: z.string(),
    dispatch_seq: z.number().int().positive(),
    created_at: z.string(),
    fsrs_rating: z.string(),
    outcome: z.string(),
    duration_ms: z.number().nullable(),
  }),
]);

const LinkedRecordSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string().nullable(),
  content_md: z.string(),
  created_at: z.string(),
});

const ProbeResolutionSchema = z.enum([...PROBE_RESOLUTIONS, PROBE_NON_EVIDENCE_RESOLUTION]);

const SafeProposalEvidenceRefSchema = z.object({
  kind: z.enum(['event', 'question', 'knowledge', 'artifact', 'record']),
  id: z.string(),
});

const SafeProbeQualitySchema = z.object({
  schema_version: z.number().int().positive(),
  passed: z.literal(true),
  attempt_count: z.number().int().positive(),
});

const SafeResponseJudgementSchema = ConjectureProbeResponseJudgement.omit({
  signature_match_explanation_md: true,
  evidence_refs: true,
});

const EventEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('self_authored_gate_input'),
    ordinal: z.number().int().positive(),
    input_kind: z.string(),
    knowledge_id: z.string(),
    observed_error_present: z.boolean(),
  }),
  z.object({
    kind: z.literal('proposal'),
    proposal_kind: z.string(),
    evidence_ref_semantics: z.literal('supporting_references_noncausal'),
    target: z.object({
      subject_kind: z.string(),
      subject_id: z.string().nullable(),
    }),
    evidence_refs: z.array(SafeProposalEvidenceRefSchema),
    conjecture: z
      .object({
        knowledge_id: z.string(),
        cause_category: z.string(),
        recurrence_gate_satisfied: z.boolean(),
        discriminating: z.boolean(),
        corrected_by_owner: z.boolean(),
        claim_present: z.boolean(),
        diagnostic_contract_present: z.boolean(),
        primary_probe_contract_present: z.boolean(),
        followup_probe_contract_present: z.boolean(),
        probe_quality: SafeProbeQualitySchema.optional(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal('rate'),
    rating: z.enum(['accept', 'dismiss', 'reverse', 'change_type', 'rollback']),
    conjecture_id: z.string().optional(),
    calibration_anchor: z.enum(['accept', 'edit']).optional(),
    corrected_by_owner: z.boolean().optional(),
    referenced_knowledge_ids: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('probe_result'),
    conjecture_event_id: z.string(),
    outcome: z.union([z.literal(0), z.literal(1)]).nullable(),
    resolution: ProbeResolutionSchema,
    resolution_rule_version: z.string().optional(),
    response_judgement: SafeResponseJudgementSchema.nullable().optional(),
    independent_probe_question_ids: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('prediction_score'),
    conjecture_event_id: z.string(),
    probe_result_event_id: z.string(),
    probe_question_id: z.string(),
    knowledge_id: z.string(),
    outcome: z.union([z.literal(0), z.literal(1)]),
    resolution: z.enum(PROBE_RESOLUTIONS),
    discriminating: z.boolean(),
    score_basis: z.literal('single_point'),
    independent_probe_question_ids: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('intervention_preparation_failed'),
    intervention_id: z.string(),
    intervention_version: z.number().int().positive(),
    conjecture_event_id: z.string(),
    knowledge_id: z.string(),
    failure_code: z.string(),
  }),
  z.object({
    kind: z.literal('intervention_activated'),
    intervention_id: z.string(),
    intervention_version: z.number().int().positive(),
    conjecture_event_id: z.string(),
    knowledge_id: z.string(),
    method_id: PedagogyMethodId,
    delivery_mode: z.enum(['shadow', 'eligible']),
    package_version: z.number().int().positive(),
    diagnostics: z.array(
      z.object({
        kind: z.enum(['immediate', 'delayed', 'transfer']),
        question_id: z.string(),
        due_at: z.string().datetime(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('judge'),
    score: z.number().nullable().optional(),
    coarse_outcome: z.string().nullable().optional(),
    referenced_knowledge_ids: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('grading_checkpoint'),
    attempt_event_id: z.string(),
    segment: z.enum(['theta', 'fsrs']),
  }),
  z.object({
    kind: z.literal('state_snapshot'),
    attempt_event_id: z.string(),
    theta_snapshots: z.array(
      z.object({
        knowledge_id: z.string(),
        before_present: z.boolean(),
        before_theta_hat: z.number().nullable(),
        after_theta_hat: z.number(),
      }),
    ),
    fsrs_snapshots: z.array(
      z.object({
        subject_kind: z.enum(['question', 'knowledge']),
        subject_id: z.string(),
        before: FsrsStateEvidenceSchema.nullable(),
        after: FsrsStateEvidenceSchema,
      }),
    ),
  }),
]);

const CausalEventRefSchema = z.object({
  event_id: z.string(),
  dispatch_seq: z.number().int().positive(),
  action: z.string(),
  subject_kind: z.string(),
  subject_id: z.string(),
  outcome: z.string().nullable(),
  caused_by_event_id: z.string().nullable(),
  created_at: z.string().datetime(),
  correction_state: z.enum(['active', 'retracted', 'marked_wrong', 'superseded']),
  correction_event_id: z.string().nullable(),
  replacement_event_id: z.string().nullable(),
  payload_present: z.boolean(),
  payload_projection_status: z.enum([
    'typed_safe',
    'typed_elsewhere',
    'unsupported_action',
    'invalid_payload',
  ]),
  payload_projection_exhaustive: z.literal(false),
  redacted_payload_groups: z.array(
    z.enum([
      'anti_guilt_metrics',
      'execution_metadata',
      'free_text',
      'future_diagnostics',
      'image_refs',
      'learner_answer',
      'private_metadata',
      'raw_payload',
      'review_prose',
    ]),
  ),
  evidence: EventEvidenceSchema.nullable(),
});

const ExactEventIdentitySchema = CausalEventRefSchema;

const OutputSchema = z.object({
  lookup: z.object({
    requested_event_id: z.string(),
    status: z.enum(['found', 'not_found', 'unsupported_event', 'inactive']),
    observed: ExactEventIdentitySchema.nullable(),
  }),
  // Compatibility: successful lookups retain the historical `attempt` key.
  // It is nullable instead of fabricating an epoch sentinel when lookup fails.
  attempt: AnswerActivitySchema.nullable(),
  question: QuestionInfoSchema.nullable(),
  question_availability: z.enum([
    'found',
    'not_found',
    'redacted_intervention_diagnostic',
    'not_resolved',
  ]),
  cause: CauseSchema.nullable(),
  timeline: z.array(TimelineEntrySchema),
  timeline_scope: z.literal('same_question_context_noncausal'),
  timeline_coverage: z.object({
    returned_count: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    has_more: z.boolean().nullable(),
    complete: z.boolean().nullable(),
  }),
  claim_support: z.object({
    causal_edges: z.literal('caused_by_event_id_only'),
    temporal_order: z.literal('noncausal'),
    activation_policy: z.literal('not_observed'),
    necessary_conditions: z.literal('not_supported'),
    sufficient_conditions: z.literal('not_supported'),
  }),
  causal_neighborhood: z.object({
    parent: CausalEventRefSchema.nullable(),
    direct_children: z.array(CausalEventRefSchema),
    relation_semantics: z.literal('direct_children_only'),
    coverage: z.object({
      returned_count: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      total_direct_children: z.number().int().nonnegative().nullable(),
      has_more: z.boolean().nullable(),
      complete: z.boolean().nullable(),
    }),
  }),
  linked_records: z.array(LinkedRecordSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION = [
  'Fetch exact evidence for one answer event id. Supports action=attempt and action=review,',
  'including successful reviews; never infers an action from id text and never fabricates a row.',
  '',
  '- lookup.status distinguishes found, not_found, unsupported_event, and inactive.',
  '- attempt is the compatible answer-activity field and includes exact action/outcome/dispatch_seq.',
  '- causal_neighborhood contains the exact parent and direct children only. It does not call',
  '  same-question history causal. Check coverage and each event correction_state before treating',
  '  any parent/child evidence as current.',
  '- payload_present reports whether persisted JSON exists. evidence is only a typed safe projection:',
  '  evidence=null never means the stored payload was null. payload_projection_exhaustive=false is',
  '  explicit for every event. Inspect payload_projection_status and redacted_payload_groups;',
  '  groups are coarse and non-exhaustive, so never claim an unprojected',
  '  field was absent from storage. Unknown keys are denied by default and never reflected.',
  '- Inside evidence, an omitted optional key means the validated payload did not carry that known',
  '  safe key. null is emitted only when that canonical key was explicitly persisted as null; [] is',
  '  emitted only for an explicitly persisted empty array. None describes redacted/unknown keys.',
  '- sequential roots or siblings are not a caused_by chain. Only explicit caused_by_event_id edges',
  '  establish parent/child causality.',
  '- proposal evidence_refs are supporting provenance only, never caused_by edges. The reader does',
  '  not expose the complete activation policy, so observed fields cannot be promoted to necessary',
  '  conditions, a minimum sufficient set, or proof that every trigger condition was satisfied.',
  '- intervention_activated diagnostics carry canonical question ids. To prove downstream learner',
  '  response/review, query exact action=review + subjectKind=question + that subjectId.',
  '- timeline is same-question context only, explicitly non-causal, with bounded coverage.',
  '- review evidence includes FSRS rating, subject provenance, and per-subject schedule states.',
  '- question_availability distinguishes missing data from protected diagnostic redaction.',
].join('\n');

function causedByEventId(value: EnvelopedEvent): string | null {
  return 'caused_by_event_id' in value && typeof value.caused_by_event_id === 'string'
    ? value.caused_by_event_id
    : null;
}

type EventEvidence = z.infer<typeof EventEvidenceSchema>;
type PayloadProjectionStatus = z.infer<typeof CausalEventRefSchema.shape.payload_projection_status>;
type PayloadProjection = {
  status: PayloadProjectionStatus;
  evidence: EventEvidence | null;
  redactedGroups: z.infer<typeof CausalEventRefSchema>['redacted_payload_groups'];
};

const SelfAuthoredGateInputPayloadSchema = z.object({
  ordinal: z.number().int().positive(),
  input_kind: z.string().min(1),
  knowledge_id: z.string().min(1),
  observed_error: z.string().min(1),
});

const RatePayloadSchema = z.object({
  rating: z.enum(['accept', 'dismiss', 'reverse', 'change_type', 'rollback']),
  conjecture_id: z.string().min(1).optional(),
  calibration_anchor: z.enum(['accept', 'edit']).optional(),
  corrected_by_owner: z.boolean().optional(),
  referenced_knowledge_ids: z.array(z.string().min(1)).optional(),
});

const ProbeResultPayloadSchema = z
  .object({
    conjecture_event_id: z.string().min(1),
    outcome: z.union([z.literal(0), z.literal(1)]).nullable(),
    resolution: ProbeResolutionSchema,
    resolution_rule_version: z.string().min(1).optional(),
    answer_md: z.string().nullable().optional(),
    answer_image_refs: z.array(z.string()).optional(),
    response_judgement: ConjectureProbeResponseJudgement.nullable().optional(),
    retrievability_at_judge: z.number().min(0).max(1).nullable().optional(),
    independent_probe_question_ids: z.array(z.string().min(1)).optional(),
  })
  .superRefine((payload, ctx) => {
    if (
      !isCanonicalProbeOutcomeResolution({
        outcome: payload.outcome,
        resolution: payload.resolution,
      })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'outcome/resolution pair is not canonical',
        path: ['resolution'],
      });
      return;
    }
    if (
      payload.resolution === PROBE_NON_EVIDENCE_RESOLUTION &&
      !isCanonicalProbeOutcomeJudgement({
        outcome: payload.outcome,
        judgement: payload.response_judgement,
      })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'inconclusive results require the canonical non-evidence judgement',
        path: ['response_judgement'],
      });
      return;
    }
    if (
      payload.response_judgement &&
      !isCanonicalProbeOutcomeJudgement({
        outcome: payload.outcome,
        judgement: payload.response_judgement,
      })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'response judgement contradicts the persisted probe outcome',
        path: ['response_judgement'],
      });
    }
  });

const PredictionScorePayloadSchema = z.object({
  conjecture_event_id: z.string().min(1),
  probe_result_event_id: z.string().min(1),
  probe_question_id: z.string().min(1),
  knowledge_id: z.string().min(1),
  outcome: z.union([z.literal(0), z.literal(1)]),
  resolution: z.enum(PROBE_RESOLUTIONS),
  discriminating: z.boolean(),
  predicted_p: z.number().min(0).max(1),
  baseline_p: z.number().min(0).max(1),
  brier_model: z.number().finite(),
  brier_baseline: z.number().finite(),
  log_loss_model: z.number().finite(),
  skill_score_point: z.number().finite(),
  retrievability_at_judge: z.number().min(0).max(1).nullable().optional(),
  independent_probe_question_ids: z.array(z.string().min(1)).optional(),
});

const InterventionPreparationFailedPayloadSchema = z.object({
  intervention_id: z.string().min(1),
  intervention_version: z.number().int().positive(),
  conjecture_event_id: z.string().min(1),
  knowledge_id: z.string().min(1),
  failure_code: z.string().min(1),
});

const InterventionActivatedPayloadSchema = z
  .object({
    intervention_id: z.string().min(1),
    intervention_version: z.number().int().positive(),
    conjecture_event_id: z.string().min(1),
    knowledge_id: z.string().min(1),
    method_id: PedagogyMethodId,
    delivery_mode: z.enum(['shadow', 'eligible']),
    package_version: z.number().int().positive(),
    diagnostics: z
      .array(
        z.object({
          kind: z.enum(['immediate', 'delayed', 'transfer']),
          question_id: z.string().min(1),
          due_at: z.string().datetime(),
        }),
      )
      .length(3),
  })
  .superRefine((payload, ctx) => {
    for (const kind of ['immediate', 'delayed', 'transfer'] as const) {
      if (payload.diagnostics.filter((diagnostic) => diagnostic.kind === kind).length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `diagnostics must contain exactly one ${kind}`,
          path: ['diagnostics'],
        });
      }
    }
  });

const JudgePayloadSchema = z.object({
  score: z.number().finite().nullable().optional(),
  coarse_outcome: z.string().min(1).nullable().optional(),
  referenced_knowledge_ids: z.array(z.string().min(1)).optional(),
});

function invalidPayload(): PayloadProjection {
  return { status: 'invalid_payload', evidence: null, redactedGroups: ['raw_payload'] };
}

function projectEventPayload(value: EnvelopedEvent, rawPayload: unknown): PayloadProjection {
  if (value.action === 'experimental:self_authored_gate_input') {
    const parsed = SelfAuthoredGateInputPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return invalidPayload();
    return {
      status: 'typed_safe',
      evidence: {
        kind: 'self_authored_gate_input',
        ordinal: parsed.data.ordinal,
        input_kind: parsed.data.input_kind,
        knowledge_id: parsed.data.knowledge_id,
        observed_error_present: parsed.data.observed_error.length > 0,
      },
      redactedGroups: ['learner_answer'],
    };
  }
  if (value.action === 'experimental:proposal') {
    const wrapper = z.object({ ai_proposal: z.unknown().optional() }).safeParse(rawPayload);
    if (!wrapper.success) return invalidPayload();
    const parsed = AiProposalPayload.safeParse(wrapper.data.ai_proposal);
    if (!parsed.success) return invalidPayload();
    const proposal = parsed.data;
    const conjecture = proposal.kind === 'conjecture' ? proposal.proposed_change : null;
    return {
      status: 'typed_safe',
      evidence: {
        kind: 'proposal',
        proposal_kind: proposal.kind,
        evidence_ref_semantics: 'supporting_references_noncausal',
        target: proposal.target,
        evidence_refs: proposal.evidence_refs,
        conjecture: conjecture
          ? {
              knowledge_id: conjecture.knowledge_id,
              cause_category: conjecture.cause_category,
              recurrence_gate_satisfied: conjecture.recurrence_count >= 2,
              discriminating: conjecture.discriminating,
              corrected_by_owner: conjecture.corrected_by_owner,
              claim_present: conjecture.claim_md.length > 0,
              diagnostic_contract_present: conjecture.diagnostic_spec !== undefined,
              primary_probe_contract_present: conjecture.probe_spec !== undefined,
              followup_probe_contract_present: conjecture.followup_probe_spec !== undefined,
              ...(conjecture.probe_quality
                ? {
                    probe_quality: {
                      schema_version: conjecture.probe_quality.schema_version,
                      passed: conjecture.probe_quality.passed,
                      attempt_count: conjecture.probe_quality.attempts.length,
                    },
                  }
                : {}),
            }
          : null,
      },
      // Fixed coarse groups are deliberately non-exhaustive. Unknown future
      // keys remain denied rather than being reflected as names or values.
      redactedGroups: [
        'anti_guilt_metrics',
        'execution_metadata',
        'free_text',
        'future_diagnostics',
        'private_metadata',
        'review_prose',
      ],
    };
  }
  if (value.action === 'rate') {
    const parsed = RatePayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return invalidPayload();
    return {
      status: 'typed_safe',
      evidence: {
        kind: 'rate',
        rating: parsed.data.rating,
        ...(parsed.data.conjecture_id !== undefined
          ? { conjecture_id: parsed.data.conjecture_id }
          : {}),
        ...(parsed.data.calibration_anchor !== undefined
          ? { calibration_anchor: parsed.data.calibration_anchor }
          : {}),
        ...(parsed.data.corrected_by_owner !== undefined
          ? { corrected_by_owner: parsed.data.corrected_by_owner }
          : {}),
        ...(parsed.data.referenced_knowledge_ids !== undefined
          ? { referenced_knowledge_ids: parsed.data.referenced_knowledge_ids }
          : {}),
      },
      redactedGroups: ['free_text', 'private_metadata'],
    };
  }
  if (value.action === PROBE_RESULT_ACTION) {
    const parsed = ProbeResultPayloadSchema.safeParse(rawPayload);
    if (
      !parsed.success ||
      value.subject_kind !== 'question' ||
      causedByEventId(value) !== parsed.data.conjecture_event_id
    ) {
      return invalidPayload();
    }
    return {
      status: 'typed_safe',
      evidence: {
        kind: 'probe_result',
        conjecture_event_id: parsed.data.conjecture_event_id,
        outcome: parsed.data.outcome,
        resolution: parsed.data.resolution,
        ...(parsed.data.resolution_rule_version !== undefined
          ? { resolution_rule_version: parsed.data.resolution_rule_version }
          : {}),
        ...(parsed.data.response_judgement !== undefined
          ? {
              response_judgement: parsed.data.response_judgement
                ? {
                    rule_version: parsed.data.response_judgement.rule_version,
                    answer_result: parsed.data.response_judgement.answer_result,
                    target_error_match: parsed.data.response_judgement.target_error_match,
                    gradable: parsed.data.response_judgement.gradable,
                    reason_code: parsed.data.response_judgement.reason_code,
                  }
                : null,
            }
          : {}),
        ...(parsed.data.independent_probe_question_ids !== undefined
          ? { independent_probe_question_ids: parsed.data.independent_probe_question_ids }
          : {}),
      },
      redactedGroups: ['anti_guilt_metrics', 'image_refs', 'learner_answer', 'review_prose'],
    };
  }
  if (value.action === PREDICTION_SCORE_ACTION) {
    const parsed = PredictionScorePayloadSchema.safeParse(rawPayload);
    if (
      !parsed.success ||
      !isCanonicalEvidenceProbeOutcomeResolution({
        outcome: parsed.data.outcome,
        resolution: parsed.data.resolution,
      }) ||
      value.subject_kind !== 'event' ||
      value.subject_id !== parsed.data.probe_result_event_id ||
      causedByEventId(value) !== parsed.data.probe_result_event_id
    ) {
      return invalidPayload();
    }
    return {
      status: 'typed_safe',
      evidence: {
        kind: 'prediction_score',
        conjecture_event_id: parsed.data.conjecture_event_id,
        probe_result_event_id: parsed.data.probe_result_event_id,
        probe_question_id: parsed.data.probe_question_id,
        knowledge_id: parsed.data.knowledge_id,
        outcome: parsed.data.outcome,
        resolution: parsed.data.resolution,
        discriminating: parsed.data.discriminating,
        score_basis: 'single_point',
        ...(parsed.data.independent_probe_question_ids !== undefined
          ? { independent_probe_question_ids: parsed.data.independent_probe_question_ids }
          : {}),
      },
      redactedGroups: ['anti_guilt_metrics', 'execution_metadata'],
    };
  }
  if (value.action === INTERVENTION_PREPARATION_FAILED_ACTION) {
    const parsed = InterventionPreparationFailedPayloadSchema.safeParse(rawPayload);
    if (
      !parsed.success ||
      value.subject_kind !== 'event' ||
      causedByEventId(value) !== value.subject_id
    ) {
      return invalidPayload();
    }
    return {
      status: 'typed_safe',
      evidence: { kind: 'intervention_preparation_failed', ...parsed.data },
      redactedGroups: [],
    };
  }
  if (value.action === INTERVENTION_ACTIVATED_ACTION) {
    const parsed = InterventionActivatedPayloadSchema.safeParse(rawPayload);
    if (
      !parsed.success ||
      value.subject_kind !== 'event' ||
      causedByEventId(value) !== value.subject_id
    ) {
      return invalidPayload();
    }
    return {
      status: 'typed_safe',
      evidence: { kind: 'intervention_activated', ...parsed.data },
      redactedGroups: ['future_diagnostics', 'private_metadata'],
    };
  }
  if (value.action === 'judge') {
    const parsed = JudgePayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return invalidPayload();
    return {
      status: 'typed_safe',
      evidence: {
        kind: 'judge',
        ...(parsed.data.score !== undefined ? { score: parsed.data.score } : {}),
        ...(parsed.data.coarse_outcome !== undefined
          ? { coarse_outcome: parsed.data.coarse_outcome }
          : {}),
        ...(parsed.data.referenced_knowledge_ids !== undefined
          ? { referenced_knowledge_ids: parsed.data.referenced_knowledge_ids }
          : {}),
      },
      redactedGroups: ['free_text'],
    };
  }
  if (value.action === 'experimental:grading_checkpoint') {
    const parsed = GradingCheckpointExperimental.safeParse({ ...value, payload: rawPayload });
    if (
      !parsed.success ||
      parsed.data.subject_id !== parsed.data.payload.attempt_event_id ||
      causedByEventId(value) !== parsed.data.payload.attempt_event_id
    ) {
      return invalidPayload();
    }
    const payload = parsed.data.payload;
    return {
      status: 'typed_safe',
      evidence: {
        kind: 'grading_checkpoint',
        attempt_event_id: payload.attempt_event_id,
        segment: payload.segment,
      },
      redactedGroups: [],
    };
  }
  if (value.action === 'experimental:state_snapshot') {
    const parsed = StateSnapshotExperimental.safeParse({ ...value, payload: rawPayload });
    if (!parsed.success || parsed.data.subject_id !== parsed.data.payload.attempt_event_id) {
      return invalidPayload();
    }
    const payload = parsed.data.payload;
    return {
      status: 'typed_safe',
      evidence: {
        kind: 'state_snapshot',
        attempt_event_id: payload.attempt_event_id,
        theta_snapshots: payload.theta_snapshots.map((snapshot) => ({
          knowledge_id: snapshot.kc_id,
          before_present: snapshot.before !== null,
          before_theta_hat:
            typeof snapshot.before === 'number'
              ? snapshot.before
              : (snapshot.before?.theta_hat ?? null),
          after_theta_hat: snapshot.after,
        })),
        fsrs_snapshots: payload.fsrs_snapshots.map((snapshot) => ({
          subject_kind: snapshot.subject_kind,
          subject_id: snapshot.subject_id,
          before: snapshot.before ? fsrsStateEvidence(snapshot.before) : null,
          after: fsrsStateEvidence(snapshot.after),
        })),
      },
      redactedGroups: [],
    };
  }
  if (value.action === 'attempt' || value.action === 'review') {
    return { status: 'typed_elsewhere', evidence: null, redactedGroups: ['raw_payload'] };
  }
  return { status: 'unsupported_action', evidence: null, redactedGroups: ['raw_payload'] };
}

function eventRef(
  value: EnvelopedEvent,
  rawPayload: unknown,
): z.infer<typeof CausalEventRefSchema> {
  const projection = projectEventPayload(value, rawPayload);
  return {
    event_id: value.id,
    dispatch_seq: value.dispatch_seq,
    action: value.action,
    subject_kind: value.subject_kind,
    subject_id: value.subject_id,
    outcome: value.outcome ?? null,
    caused_by_event_id: causedByEventId(value),
    created_at: value.created_at.toISOString(),
    correction_state: value.correction_status.state,
    correction_event_id: value.correction_status.correction_event_id,
    replacement_event_id: value.correction_status.replacement_event_id,
    payload_present: rawPayload !== null && rawPayload !== undefined,
    payload_projection_status: projection.status,
    payload_projection_exhaustive: false,
    redacted_payload_groups: projection.redactedGroups,
    evidence: projection.evidence,
  };
}

function fsrsStateEvidence(value: {
  due: Date;
  stability: number;
  difficulty: number;
  elapsed_days?: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: 'new' | 'learning' | 'review' | 'relearning';
  last_review: Date | null;
}): z.infer<typeof FsrsStateEvidenceSchema> {
  return {
    ...value,
    due: value.due.toISOString(),
    last_review: value.last_review?.toISOString() ?? null,
  };
}

function answerActivity(value: EnvelopedEvent): z.infer<typeof AnswerActivitySchema> | null {
  if (value.subject_kind !== 'question') return null;
  const outcome = value.outcome;
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'partial') return null;
  if (value.action === 'attempt') {
    const payload = value.payload as {
      answer_md: string | null;
      answer_image_refs: string[];
      referenced_knowledge_ids: string[];
    };
    return {
      event_id: value.id,
      dispatch_seq: value.dispatch_seq,
      action: 'attempt',
      outcome,
      question_id: value.subject_id,
      answer_md: payload.answer_md,
      answer_image_refs: payload.answer_image_refs,
      referenced_knowledge_ids: payload.referenced_knowledge_ids,
      created_at: value.created_at.toISOString(),
      fsrs: null,
    };
  }
  if (value.action !== 'review') return null;
  const payload = value.payload as {
    fsrs_rating: 'again' | 'hard' | 'good';
    fsrs_subject_kind?: 'question' | 'knowledge';
    fsrs_subject_ids?: string[];
    fsrs_state_after: Parameters<typeof fsrsStateEvidence>[0];
    fsrs_state_after_by_subject?: Array<{
      subject_kind: 'question' | 'knowledge';
      subject_id: string;
      state: Parameters<typeof fsrsStateEvidence>[0];
      due_at: Date;
    }>;
    user_response_md: string | null;
    answer_image_refs?: string[];
    referenced_knowledge_ids: string[];
  };
  return {
    event_id: value.id,
    dispatch_seq: value.dispatch_seq,
    action: 'review',
    outcome,
    question_id: value.subject_id,
    answer_md: payload.user_response_md,
    answer_image_refs: payload.answer_image_refs ?? [],
    referenced_knowledge_ids: payload.referenced_knowledge_ids,
    created_at: value.created_at.toISOString(),
    fsrs: {
      rating: payload.fsrs_rating,
      subject_kind: payload.fsrs_subject_kind ?? null,
      subject_ids: payload.fsrs_subject_ids ?? [],
      state_after: fsrsStateEvidence(payload.fsrs_state_after),
      state_after_by_subject: (payload.fsrs_state_after_by_subject ?? []).map((row) => ({
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        state: fsrsStateEvidence(row.state),
        due_at: row.due_at.toISOString(),
      })),
    },
  };
}

function emptyOutput(
  input: Input,
  status: 'not_found' | 'unsupported_event' | 'inactive',
  observed: z.infer<typeof ExactEventIdentitySchema> | null,
  causal: Output['causal_neighborhood'],
): Output {
  const timelineLimit = input.timelineLimit ?? TOOL_COURTESY_DEFAULTS.get_attempt_context;
  return OutputSchema.parse({
    lookup: { requested_event_id: input.attemptEventId, status, observed },
    attempt: null,
    question: null,
    question_availability: 'not_resolved',
    cause: null,
    timeline: [],
    timeline_scope: 'same_question_context_noncausal',
    timeline_coverage: {
      returned_count: 0,
      limit: timelineLimit,
      // No supported question activity was resolved, so an empty timeline is
      // not evidence that no same-question context exists.
      has_more: null,
      complete: null,
    },
    claim_support: {
      causal_edges: 'caused_by_event_id_only',
      temporal_order: 'noncausal',
      activation_policy: 'not_observed',
      necessary_conditions: 'not_supported',
      sufficient_conditions: 'not_supported',
    },
    causal_neighborhood: causal,
    linked_records: [],
  });
}

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = InputSchema.parse(raw);
  const timelineLimit = input.timelineLimit ?? TOOL_COURTESY_DEFAULTS.get_attempt_context;
  const causalLimit = input.causalLimit ?? TOOL_COURTESY_DEFAULTS.get_attempt_context;
  const focal = await getEventById(ctx.db, input.attemptEventId);

  const noCausal: Output['causal_neighborhood'] = {
    parent: null,
    direct_children: [],
    relation_semantics: 'direct_children_only',
    coverage: {
      returned_count: 0,
      limit: causalLimit,
      // caused_by_event_id is intentionally not a foreign key. A missing focal
      // row therefore cannot prove that no dangling direct children exist.
      total_direct_children: null,
      has_more: null,
      complete: null,
    },
  };
  if (!focal) return emptyOutput(input, 'not_found', null, noCausal);

  const chain = await getEventChain(ctx.db, focal.id);
  const chainEvents = [
    focal,
    ...(chain.caused_by ? [chain.caused_by] : []),
    ...chain.caused_events,
  ];
  const rawPayloadRows = await ctx.db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, [...new Set(chainEvents.map((entry) => entry.id))]));
  const rawPayloadById = new Map(rawPayloadRows.map((row) => [row.id, row.payload]));
  const directChildren = chain.caused_events.slice(0, causalLimit);
  const causal: Output['causal_neighborhood'] = {
    parent: chain.caused_by
      ? eventRef(chain.caused_by, rawPayloadById.get(chain.caused_by.id))
      : null,
    direct_children: directChildren.map((entry) => eventRef(entry, rawPayloadById.get(entry.id))),
    relation_semantics: 'direct_children_only',
    coverage: {
      returned_count: directChildren.length,
      limit: causalLimit,
      total_direct_children: chain.caused_events.length,
      has_more: chain.caused_events.length > directChildren.length,
      complete: chain.caused_events.length <= directChildren.length,
    },
  };
  const observed: z.infer<typeof ExactEventIdentitySchema> = eventRef(
    focal,
    rawPayloadById.get(focal.id),
  );
  const activity = answerActivity(focal);
  if (!activity) return emptyOutput(input, 'unsupported_event', observed, causal);
  if (focal.correction_status.state !== 'active') {
    return emptyOutput(input, 'inactive', observed, causal);
  }

  const questionRows = await ctx.db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
      source: question.source,
    })
    .from(question)
    .where(eq(question.id, activity.question_id))
    .limit(1);
  const questionRow = questionRows[0] ?? null;
  const questionAvailability = !questionRow
    ? ('not_found' as const)
    : questionRow.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE
      ? ('redacted_intervention_diagnostic' as const)
      : ('found' as const);

  // Fetch one look-ahead row where the shared reader's 50-row cap permits it.
  // At exactly 50 returned rows the reader cannot prove whether more exist, so
  // coverage is explicitly unknown rather than a false exhaustive claim.
  const timelineFetchLimit = Math.min(timelineLimit + 1, 50);
  const timelineCandidates = await getQuestionTimeline(
    ctx.db,
    activity.question_id,
    timelineFetchLimit,
  );
  const timeline = timelineCandidates.slice(0, timelineLimit);
  const timelineAtReaderCap = timelineLimit === 50 && timelineCandidates.length === 50;
  const timelineHasMore = timelineAtReaderCap ? null : timelineCandidates.length > timelineLimit;
  const failure =
    activity.outcome === 'failure' ? await getFailureAttemptById(ctx.db, activity.event_id) : null;
  const cause = failure ? effectiveCauseForFailureAttempt(failure) : null;
  const records = await listLearningRecords(ctx.db, {
    attempt_event_id: activity.event_id,
    limit: 25,
  });

  return OutputSchema.parse({
    lookup: {
      requested_event_id: input.attemptEventId,
      status: 'found',
      observed,
    },
    attempt: activity,
    question:
      questionAvailability === 'found' && questionRow
        ? {
            id: questionRow.id,
            kind: questionRow.kind,
            prompt_md: questionRow.prompt_md,
            reference_md: questionRow.reference_md ?? null,
            knowledge_ids: questionRow.knowledge_ids ?? [],
          }
        : null,
    question_availability: questionAvailability,
    cause: cause
      ? {
          source: cause.source,
          event_id: cause.event_id,
          primary_category: cause.primary_category,
          secondary_categories: cause.secondary_categories,
          analysis_md: cause.analysis_md,
          user_notes: cause.user_notes,
          confidence: cause.confidence,
        }
      : null,
    timeline: timeline.map((entry) =>
      entry.kind === 'attempt'
        ? {
            kind: 'attempt' as const,
            event_id: entry.event_id,
            dispatch_seq: entry.dispatch_seq,
            created_at: entry.created_at.toISOString(),
            outcome: entry.outcome,
            duration_ms: entry.duration_ms,
            cause: entry.cause
              ? { primary: entry.cause.primary, confidence: entry.cause.confidence }
              : null,
          }
        : {
            kind: 'review' as const,
            event_id: entry.event_id,
            dispatch_seq: entry.dispatch_seq,
            created_at: entry.created_at.toISOString(),
            fsrs_rating: entry.fsrs_rating,
            outcome: entry.outcome,
            duration_ms: entry.duration_ms,
          },
    ),
    timeline_scope: 'same_question_context_noncausal',
    timeline_coverage: {
      returned_count: timeline.length,
      limit: timelineLimit,
      has_more: timelineHasMore,
      complete: timelineHasMore === null ? null : !timelineHasMore,
    },
    claim_support: {
      causal_edges: 'caused_by_event_id_only',
      temporal_order: 'noncausal',
      activation_policy: 'not_observed',
      necessary_conditions: 'not_supported',
      sufficient_conditions: 'not_supported',
    },
    causal_neighborhood: causal,
    linked_records: records.map((record) => ({
      id: record.id,
      kind: record.kind,
      title: record.title ?? null,
      content_md: record.content_md,
      created_at: record.created_at.toISOString(),
    })),
  });
}

function summarize(input: Input, output: Output): string {
  const qid = output.attempt?.question_id ?? '(missing)';
  const action = output.attempt?.action ?? output.lookup.status;
  const cause = output.cause?.primary_category ?? 'no-cause';
  const more = output.causal_neighborhood.coverage.has_more ? ' · causal-more' : '';
  return `${action} ${input.attemptEventId.slice(0, 8)} · q=${qid.slice(0, 8)} · cause=${cause} · timeline=${output.timeline.length} · records=${output.linked_records.length}${more}`;
}

export const getAttemptContextTool: DomainTool<Input, Output> = {
  name: 'get_attempt_context',
  description: DESCRIPTION,
  effect: 'read',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  costClass: 'local',
  execute,
  summarize,
  mirrorEvent: 'when_user_visible',
};
