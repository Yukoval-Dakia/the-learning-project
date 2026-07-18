import { ActivityRef } from '@/core/schema/activity';
import { RelationTypeSchema } from '@/core/schema/event/blocks';
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
