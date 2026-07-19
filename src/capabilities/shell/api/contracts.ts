import type { TeachingBrief } from '@/capabilities/shell/server/teaching-brief';
import { ActivityRef } from '@/core/schema/activity';
import { CauseCategory } from '@/core/schema/cause';
import { BRIEF_STATES, PRIMARY_ACTION_KINDS } from '@/core/schema/conjecture';
import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { ProposalEvidenceRef } from '@/core/schema/proposal';
import { z } from 'zod';

export const SubjectListResponseSchema = z.object({
  subjects: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      aliases: z.array(z.string()),
      renderConfig: z.object({
        font_family: z.string(),
        notation: z.string().nullable(),
        code_highlight: z.string().nullable(),
      }),
      causeCategories: z.array(z.object({ id: z.string(), label: z.string() })),
      isGeneralFallback: z.boolean().nullable(),
      configurationStatus: z.enum(['configured', 'general-fallback', 'unconfigured']),
    }),
  ),
});

export const AutoAppliedProposalDigestSchema = z.object({
  rows: z.array(
    z.object({
      proposal_id: z.string(),
      learning_item_id: z.string(),
      title: z.string(),
      applied_at: z.string(),
      level: z.string(),
      reverted: z.boolean(),
    }),
  ),
  breaker: z.object({
    tripped: z.boolean(),
    level: z.string(),
    applied: z.number().int().nonnegative(),
    cap: z.number().int().nonnegative(),
    window: z.number().int().nonnegative(),
  }),
});

export const LegacyProposalDecisionBodySchema = z
  .object({
    decision: z.enum(['accept', 'reverse', 'change_type', 'dismiss']),
    new_relation_type: RelationTypeSchema.optional(),
    user_note: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.decision === 'change_type' && !data.new_relation_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'change_type requires new_relation_type',
        path: ['new_relation_type'],
      });
    }
  });

export const LegacyProposalRetractBodySchema = z.object({
  reason_md: z.string().trim().min(1).max(2000).optional(),
  affected_refs: z.array(ActivityRef).min(1).optional(),
});

export const LegacyProposalDecisionResponseSchema = z.object({ kind: z.string() }).passthrough();
export const LegacyProposalRetractResponseSchema = z.object({
  kind: z.literal('retracted'),
  correction_event_id: z.string(),
});

export const WorkbenchSummaryResponseSchema = z.object({
  proposals: z.object({
    total: z.number().int().nonnegative(),
    decision_total: z.number().int().nonnegative(),
    by_kind: z.record(z.number().int().nonnegative()),
    has_more: z.boolean(),
    limit: z.number().int().positive(),
    status: z.string(),
  }),
  kpi: z.object({
    due_count: z.number().int().nonnegative(),
    pending_attribution_count: z.number().int().nonnegative(),
    knowledge_count: z.number().int().nonnegative(),
    goal_count: z.number().int().nonnegative(),
  }),
  cold_start: z.record(z.unknown()),
  active_goal: z.object({ id: z.string(), title: z.string() }).nullable(),
  active_sessions: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      summary_md: z.string().nullable(),
      started_at: z.number().int(),
      ended_at: z.number().int().nullable(),
      duration_ms: z.number().int().nonnegative().nullable(),
      reviewed_count: z.number().int().nonnegative(),
    }),
  ),
  week_heat: z.array(z.object({ day: z.string(), count: z.number().int().nonnegative() })),
});

const OvernightRunSchema = z.object({
  task_kind: z.string(),
  count: z.number().int().nonnegative(),
  status_breakdown: z.record(z.number().int().nonnegative()),
});

export const OvernightDigestResponseSchema = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  has_overnight_activity: z.boolean(),
  runs: z.array(OvernightRunSchema),
  note_changes_count: z.number().int().nonnegative(),
  new_proposals_count: z.number().int().nonnegative(),
  new_conjectures_count: z.number().int().nonnegative(),
  agent_notes_count: z.number().int().nonnegative(),
  degraded_kinds: z.array(
    z.object({
      task_kind: z.string(),
      error_count: z.number().int().nonnegative(),
      recent_error_messages: z.array(z.string()),
    }),
  ),
});

export const PrepDeskConjecturesResponseSchema = z.object({
  conjectures: z.array(
    z.object({
      id: z.string(),
      claim: z.string(),
      knowledge_id: z.string(),
      cause_category: z.string(),
      probe_md: z.string(),
      recurrence_count: z.number().int().nonnegative(),
      discriminating: z.boolean(),
      corrected_by_owner: z.boolean(),
      evidence: z.array(z.object({ kind: z.string(), id: z.string() })),
      proposed_at: z.string(),
    }),
  ),
});

export const PrepDeskProbesResponseSchema = z.object({
  probes: z.array(
    z.object({
      probe_question_id: z.string(),
      prompt_md: z.string(),
      knowledge_id: z.string().nullable(),
    }),
  ),
});

const TeachingBriefEvidenceRefSchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('induction'),
      kind: ProposalEvidenceRef.shape.kind,
      id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      role: z.literal('probe'),
      kind: z.literal('question'),
      id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      role: z.literal('outcome'),
      kind: z.literal('event'),
      id: z.string().min(1),
    })
    .strict(),
]);

const TeachingBriefFindingSectionSchema = z
  .object({
    claim_md: z.string().min(1),
    knowledge_id: z.string().min(1),
    cause_category: CauseCategory,
  })
  .strict();

const TeachingBriefBasisSectionSchema = z
  .object({
    summary_md: z.string().min(1),
    evidence_trace: z.array(TeachingBriefEvidenceRefSchema).min(1),
  })
  .strict()
  .refine((basis) => basis.evidence_trace.some((ref) => ref.role === 'induction'), {
    message: 'evidence_trace requires induction evidence',
    path: ['evidence_trace'],
  });

// YUK-708 (P0F/4) — the retired outcome's executable next step: acknowledge (dismiss)
// the delivered result. Contract §2.1 requires the strict schema to be upgraded (not
// left at `{kind:'none'}`) before the UI may render an ack action. `probe_result_event_id`
// is the ack target — the same id carried in `current_outcome` — keeping the action
// self-describing.
const OutcomeAcknowledgeActionSchema = z
  .object({
    kind: z.literal('acknowledge_outcome'),
    probe_result_event_id: z.string().min(1),
  })
  .strict();

// YUK-709 (P0F/5) — a confirmed outcome's executable next step: KC-scoped practice
// (contract §9). Contract §2.1 requires the discriminated union + strict schema to be
// upgraded in lockstep before the UI may render this action. `knowledge_id` mirrors
// `finding.knowledge_id` (the /practice?kc target); `probe_result_event_id` mirrors
// `current_outcome` so the same ack still retires the brief. Both invariants are enforced
// by the cross-field superRefine below.
const OutcomePracticeActionSchema = z
  .object({
    kind: z.literal('practice_scoped'),
    knowledge_id: z.string().min(1),
    probe_result_event_id: z.string().min(1),
  })
  .strict();

const teachingBriefCommon = {
  brief_id: z.string().min(1),
  updated_at: z.string().datetime(),
  finding: TeachingBriefFindingSectionSchema,
  basis: TeachingBriefBasisSectionSchema,
};

export const TeachingBriefSchema: z.ZodType<TeachingBrief> = z
  .discriminatedUnion('state', [
    z
      .object({
        ...teachingBriefCommon,
        state: z.literal('finding'),
        expires_at: z.string().datetime(),
        prepared_action: z
          .object({
            kind: z.literal('review_finding'),
            proposal_id: z.string().min(1),
            probe_preview_md: z.string().min(1),
          })
          .strict(),
        current_outcome: z
          .object({
            status: z.literal('awaiting_decision'),
            summary_md: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...teachingBriefCommon,
        state: z.literal('probe_ready'),
        expires_at: z.null(),
        prepared_action: z
          .object({
            kind: z.literal('answer_probe'),
            probe_question_id: z.string().min(1),
            prompt_md: z.string().min(1),
          })
          .strict(),
        current_outcome: z
          .object({
            status: z.literal('awaiting_answer'),
            summary_md: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...teachingBriefCommon,
        state: z.literal('outcome_confirmed'),
        expires_at: z.string().datetime(),
        prepared_action: OutcomePracticeActionSchema,
        current_outcome: z
          .object({
            status: z.literal('confirmed'),
            summary_md: z.string().min(1),
            probe_question_id: z.string().min(1),
            probe_result_event_id: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...teachingBriefCommon,
        state: z.literal('outcome_retired'),
        expires_at: z.string().datetime(),
        prepared_action: OutcomeAcknowledgeActionSchema,
        current_outcome: z
          .object({
            status: z.literal('retired'),
            summary_md: z.string().min(1),
            probe_question_id: z.string().min(1),
            probe_result_event_id: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
  ])
  // Cross-field invariants (mirror TeachingBriefBasisSectionSchema's refine): on an outcome
  // brief the ack action must target the very result the outcome reports, and a confirmed
  // outcome's practice action must target the same KC the finding names. A discriminatedUnion
  // member cannot itself be refined (that yields a ZodEffects, which the union rejects), so the
  // checks live on the whole union — a future projection regression that lets these drift fails
  // the wire loudly instead of silently.
  .superRefine((brief, ctx) => {
    if (
      (brief.state === 'outcome_confirmed' || brief.state === 'outcome_retired') &&
      brief.prepared_action.probe_result_event_id !== brief.current_outcome.probe_result_event_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'prepared_action.probe_result_event_id must equal current_outcome.probe_result_event_id',
        path: ['prepared_action', 'probe_result_event_id'],
      });
    }
    // YUK-709 — the /practice?kc target must be the finding's canonical KC, never a drifted
    // one, so the CTA can only ever open practice for the point the brief is about.
    if (
      brief.state === 'outcome_confirmed' &&
      brief.prepared_action.knowledge_id !== brief.finding.knowledge_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'prepared_action.knowledge_id must equal finding.knowledge_id',
        path: ['prepared_action', 'knowledge_id'],
      });
    }
  });

export const TeachingBriefResponseSchema = z
  .object({ brief: TeachingBriefSchema.nullable() })
  .strict();

// YUK-708 (P0F/4) — acknowledge a delivered outcome. The target is the probe_result
// event id (the same one on `current_outcome.probe_result_event_id` /
// `prepared_action.probe_result_event_id`); the ack is keyed on it server-side.
export const TeachingBriefAckBodySchema = z
  .object({ probe_result_event_id: z.string().min(1) })
  .strict();

export const TeachingBriefAckResponseSchema = z
  .object({
    brief_acknowledgement_event_id: z.string().min(1),
    probe_result_event_id: z.string().min(1),
    brief_id: z.string().min(1),
    idempotent: z.boolean(),
  })
  .strict();

// YUK-710 (P0F/6) — the append-only teaching-brief interaction ledger body. A discriminated
// union on `type`: a `brief_seen` (opened a delivered brief, idempotent per brief × local day)
// or a `primary_action_started` (started the prepared action). `brief_id` is the stable brief
// id (= the conjecture proposal event id). No answer / claim text is ever accepted — only the
// action kind and the optional confirmed-outcome `result_event_id` (scoped_practice join key).
export const TeachingBriefInteractionBodySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('brief_seen'),
      brief_id: z.string().min(1),
      brief_state: z.enum(BRIEF_STATES),
    })
    .strict(),
  z
    .object({
      type: z.literal('primary_action_started'),
      brief_id: z.string().min(1),
      action_kind: z.enum(PRIMARY_ACTION_KINDS),
      // Present only for scoped_practice (the confirmed outcome's probe_result event id).
      result_event_id: z.string().min(1).optional(),
    })
    .strict(),
]);

export const TeachingBriefInteractionResponseSchema = z
  .object({
    interaction_event_id: z.string().min(1),
    local_day: z.string().min(1),
    idempotent: z.boolean(),
  })
  .strict();
