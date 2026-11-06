import { z } from 'zod';
import { ChangeResult, Topic } from './topic-contract';
export const ContextEditRequest = z.object({
  instruction: z.string().min(1).max(1000),
  topic_key: z.string().optional(),
  expected_version: z.number().int().nonnegative(),
  derivation_policy: z.enum(['allow', 'answer_only', 'crisis']).default('allow'),
});
export const ContextActionRequest = z.object({
  op: z.enum(['withdraw_topic', 'undo']),
  topic_key: z.string().optional(),
  change_id: z.string().optional(),
  expected_version: z.number().int().nonnegative(),
});
export const ContextBoardResponse = z.object({
  version: z.number().int(),
  topics: z.array(
    Topic.extend({
      evidence_at: z.string().nullable(),
      memory_weight: z.number().nullable(),
      freshness: z.number().nullable(),
      stale: z.boolean(),
    }),
  ),
  changes: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      // Source evidence restricted: before/after are withheld and the row reads
      // as removed. Undo is not offered and the write side refuses it anyway.
      removed: z.boolean(),
      before: z.array(Topic),
      after: z.array(Topic),
      undo_of: z.string().nullable(),
    }),
  ),
});
export const ContextEditResponse = z.object({
  status: z.enum(['changed', 'partial', 'unchanged']),
  reply: z.string(),
  changes: z.array(ChangeResult),
  remaining_changes: z.array(z.string()),
});
