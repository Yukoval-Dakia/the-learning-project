import { z } from 'zod';
import { ChangeResult, Topic } from './topics';
export const ContextEditRequest = z.object({
  instruction: z.string().min(1).max(1000), topic_key: z.string().optional(),
  expected_version: z.number().int().nonnegative(),
  derivation_policy: z.enum(['allow', 'answer_only', 'crisis']).default('allow'),
});
export const ContextActionRequest = z.object({
  op: z.enum(['withdraw_topic', 'undo']), topic_key: z.string().optional(),
  change_id: z.string().optional(), expected_version: z.number().int().nonnegative(),
});
export const ContextBoardResponse = z.object({
  version: z.number().int(), topics: z.array(Topic.extend({
    evidence_at: z.string().nullable(), freshness: z.number().nullable(), stale: z.boolean(),
  })), changes: z.array(z.object({ id: z.string(), at: z.string(), before: z.array(Topic), after: z.array(Topic) })),
});
export const ContextEditResponse = z.object({ reply: z.string(), changes: z.array(ChangeResult) });
export { ChangeResult };
