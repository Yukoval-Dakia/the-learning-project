import { z } from 'zod';

export const MemoryIngestReplayRequestSchema = z
  .object({
    sourceEventId: z.string().trim().min(1).max(256),
    requestId: z.uuid(),
    expectedFenceId: z.string().min(1).max(256),
    operator: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(2000),
    allowPaidReplay: z.literal(true),
  })
  .strict();
export type MemoryIngestReplayRequest = z.infer<typeof MemoryIngestReplayRequestSchema>;

export const MemoryIngestReplayGrantSchema = z
  .object({
    version: z.literal(1),
    handoff_kind: z.literal('operator_replay_authorized'),
    source_event_id: z.string().min(1),
    request_id: z.uuid(),
    expected_fence_id: z.string().min(1),
    operator: z.string().min(1).max(160),
    reason: z.string().min(1).max(2000),
    allow_paid_replay: z.literal(true),
  })
  .strict();
export type MemoryIngestReplayGrant = z.infer<typeof MemoryIngestReplayGrantSchema>;
