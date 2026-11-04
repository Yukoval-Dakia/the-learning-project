import { z } from 'zod';

export const CreateAppealBodySchema = z.union([
  z
    .object({
      evaluation_id: z.string().min(1),
      reason_md: z.string().max(2000).optional(),
      idempotency_key: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      judge_event_id: z.string().min(1),
      reason_md: z.string().max(2000).optional(),
    })
    .strict(),
]);

export const AppealResponseSchema = z.object({ appeal_event_id: z.string() });
