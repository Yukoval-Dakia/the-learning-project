import { z } from 'zod';

export const FailedTurnPracticeTargetQuery = z.object({ session_id: z.string().min(1) }).strict();

export const FailedTurnPracticeTarget = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      question_id: z.string().min(1),
      issuance_id: z.string().min(1),
      revision_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.enum(['not_failed', 'outcome_unknown', 'no_saved_practice_target', 'revoked']),
    })
    .strict(),
]);

export type FailedTurnPracticeTargetT = z.infer<typeof FailedTurnPracticeTarget>;
