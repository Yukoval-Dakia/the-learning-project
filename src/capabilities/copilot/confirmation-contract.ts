import { z } from 'zod';
import { GroupEvidence, ResponseSet } from '@/core/schema/assessment';

const identity = {
  version: z.literal(1),
  occurrence_id: z.string().min(1).max(200),
  command_id: z.string().min(1).max(200),
};
export const ConfirmationCommand = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('accept') }).strict(),
  z.object({ ...identity, kind: z.literal('decline') }).strict(),
  z.object({ ...identity, kind: z.literal('defer') }).strict(),
  z.object({ ...identity, kind: z.literal('request_again') }).strict(),
  z
    .object({
      ...identity,
      kind: z.literal('submit'),
      // Match the native CreateSubmissionBodySchema web restriction before the
      // accepted-input boundary; capture-only unknown is never a chat original.
      response_set: ResponseSet.refine(
        (set) =>
          set.entries.every(
            (entry) =>
              (entry.kind !== 'select' && entry.kind !== 'blank') || entry.state !== 'unknown',
          ),
        { message: "state 'unknown' is reserved for worksheet/photo capture" },
      ),
      group_evidence: z.array(GroupEvidence).default([]),
    })
    .strict(),
]);
export type ConfirmationCommandT = z.infer<typeof ConfirmationCommand>;

export const ConfirmationOccurrence = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().nonnegative(),
    occurrence_id: z.string().min(1),
    session_id: z.string().min(1),
    learning_item_id: z.string().min(1),
    trigger_ask_id: z.string().min(1),
    offer_reply_id: z.string().min(1),
    state: z.enum(['offered', 'declined', 'deferred', 'blocked', 'issued']),
    accept_ask_id: z.string().nullable(),
    issuance_id: z.string().nullable(),
    blocked_reason: z.string().nullable(),
  })
  .strict();
export type ConfirmationOccurrenceT = z.infer<typeof ConfirmationOccurrence>;
