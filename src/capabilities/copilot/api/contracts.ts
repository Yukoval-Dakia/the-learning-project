import { NudgeKind, SuggestionKind } from '@/kernel/capability-contract-schemas';
import { ApiIdParamsSchema } from '@/kernel/http-contracts';
import { z } from 'zod';
import { CopilotChatRequest } from '../server/chat-contracts';

export { CopilotChatRequest };

export const CopilotRouteIdParamsSchema = ApiIdParamsSchema;
export const CopilotCheckpointParamsSchema = z.object({ eventId: z.string().min(1) });

export const CopilotCheckpointRevertResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: z.enum(['reverted', 'already_reverted']),
    checkpoint_event_id: z.string(),
    compensation_event_ids: z.array(z.string()),
    reverted: z
      .object({
        snapshotsRestored: z.number().int().nonnegative(),
        structuralRowsArchived: z.number().int().nonnegative(),
        eventLayerCompensated: z.number().int().nonnegative(),
        totalNodes: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.object({
    ok: z.literal(false),
    refusal: z.enum(['truncated', 'no_checkpoint', 'irreversible', 'legacy_snapshot', 'conflict']),
    reason: z.string(),
    irreversibleEventIds: z.array(z.string()).optional(),
    ref: z.object({ kind: z.literal('theta'), kcId: z.string() }).optional(),
    conflictRef: z
      .object({
        kind: z.enum(['theta', 'fsrs']),
        subjectKind: z.string(),
        subjectId: z.string(),
      })
      .optional(),
  }),
]);

export const CopilotChatStreamResponseSchema = z.string();

export const CopilotDurableRunResponseSchema = z.object({
  run_id: z.string(),
  session_id: z.string(),
  checkpoint_event_id: z.string(),
});

export const CopilotTurnsQuerySchema = z.object({
  // Preserve the existing wire behavior: the route applies Number.parseInt and
  // the reader clamps invalid/out-of-range values to its established bounds.
  limit: z.string().optional(),
});

const CopilotStructuredQuestionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  prompt_md: z.string(),
  choices_md: z.array(z.string()).nullable(),
});

const CopilotTurnSkillSchema = z.object({
  kind: z.enum(['explain', 'ask_check', 'end']),
  structured_question: CopilotStructuredQuestionSchema.optional(),
  suggested_next: z.enum(['continue', 'end']).optional(),
});

const CopilotPrimaryViewSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.enum(['tool_result', 'artifact']),
    ref: z.object({ kind: z.string(), id: z.string() }),
  }),
  z.object({ source: z.literal('ephemeral_html'), ref: z.string() }),
]);

export const CopilotTurnSchema = z.object({
  role: z.enum(['user', 'ai', 'tombstone']),
  text: z.string(),
  at: z.string().datetime(),
  event_id: z.string(),
  session_id: z.string().optional(),
  reply_event_id: z.string().optional(),
  checkpoint_event_id: z.string().optional(),
  skill_turn: CopilotTurnSkillSchema.optional(),
  skill_context: z
    .object({
      skill: z.string(),
      ref: z.object({ kind: z.string(), id: z.string() }),
    })
    .optional(),
  primary_view: CopilotPrimaryViewSchema.optional(),
});

export const CopilotTurnsResponseSchema = z.object({ turns: z.array(CopilotTurnSchema) });

export const CopilotSummaryResponseSchema = z.object({
  daily_focus: z.string(),
  plan_adjustments_count: z.number().int().nonnegative().nullable(),
  review_due_count: z.number().int().nonnegative(),
  brief_global_md: z.string().nullable(),
  dreaming_preview: z.array(
    z.object({
      proposal_id: z.string(),
      kind: z.string(),
      brief: z.string(),
      proposed_at: z.string().datetime(),
    }),
  ),
  pending_proposals_total: z.number().int().nonnegative(),
  coach_last_run_at: z.string().datetime().nullable(),
  dreaming_last_run_at: z.string().datetime().nullable(),
});

export const AcceptTeachingChipBodySchema = z.object({
  suggestion_kind: SuggestionKind,
  chip_label: z.string().min(1).max(200),
  source_event_id: z.string().optional(),
  target_tool: z.string().optional(),
  target_args: z.record(z.string(), z.unknown()).optional(),
  proposal_id: z.string().optional(),
});

export const AcceptTeachingChipResponseSchema = z.object({
  ok: z.literal(true),
  event_id: z.string(),
});

export const CopilotNudgeSchema = z.object({
  id: z.string(),
  kind: NudgeKind,
  headline: z.string(),
  subject_kind: z.string(),
  subject_id: z.string(),
  created_at: z.string().datetime(),
});

export const CopilotNudgesResponseSchema = z.object({ nudges: z.array(CopilotNudgeSchema) });

export const CopilotNudgeCompanionResponseSchema = z.union([
  z.object({ ok: z.literal(true), event_id: z.string() }),
  z.object({ ok: z.literal(true), deduped: z.literal(true) }),
]);
