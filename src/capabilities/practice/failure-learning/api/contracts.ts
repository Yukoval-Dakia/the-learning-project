import { z } from 'zod';

export const AttemptCauseParamsSchema = z.object({
  attemptEventId: z.string().trim().min(1),
});

export const SetAttemptCauseBodySchema = z.object({
  primary_category: z.string().trim().min(1),
  user_notes: z.string().nullable().optional(),
});

const UserCauseSchema = z.object({
  source: z.literal('user'),
  primary_category: z.string(),
  label: z.string(),
  user_notes: z.string().nullable(),
});

export const SetAttemptCauseResponseSchema = z.object({
  cause: UserCauseSchema,
});

export const AttemptCauseOptionsResponseSchema = z.object({
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    }),
  ),
  current: z
    .object({
      source: z.enum(['user', 'agent']),
      primary_category: z.string(),
      label: z.string(),
    })
    .nullable(),
});

export type AttemptCauseParams = z.infer<typeof AttemptCauseParamsSchema>;
export type SetAttemptCauseBody = z.infer<typeof SetAttemptCauseBodySchema>;
