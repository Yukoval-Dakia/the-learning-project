import { z } from 'zod';

export const AgentNotesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const AgentNotesResponseSchema = z.object({
  rows: z.array(
    z
      .object({
        id: z.string(),
        created_at: z.string(),
        target_agents: z.array(z.string()),
        source_task_kind: z.string(),
        refs: z.array(
          z
            .object({
              kind: z.string(),
              id: z.string(),
              label: z.string(),
              resolution_state: z.enum(['open', 'resolved', 'unknown']),
            })
            .passthrough(),
        ),
        summary_md: z.string(),
        signal_kind: z.string(),
      })
      .passthrough(),
  ),
});

export const ProbeAnswerParamsSchema = z.object({ id: z.string().trim().min(1) });

export const ProbeAnswerBodySchema = z
  .object({
    answer_md: z.string().trim().max(10_000).default(''),
    answer_image_refs: z.array(z.string()).max(20).default([]),
  })
  .refine((body) => body.answer_md.length > 0 || body.answer_image_refs.length > 0, {
    message: 'answer_md or answer_image_refs is required — an empty answer carries no signal',
  });

export const ProbeAnswerResponseSchema = z.object({
  status: z.enum(['confirmed', 'retired']),
  resolution: z.enum(['confirmed', 'retired']),
  outcome: z.union([z.literal(0), z.literal(1)]),
  probe_result_event_id: z.string(),
  coarse_outcome: z.enum(['correct', 'incorrect']).nullable(),
  idempotent: z.boolean(),
});
