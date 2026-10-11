import { z } from 'zod';
import { MemoryStateSchema } from '@/core/forgetting/types';
import { FsrsStateSchema } from './event/blocks';

// Historical cards remain accepted verbatim. New FSRS writes carry a discriminator.
export const TaggedFsrsStateSchema = FsrsStateSchema.extend({
  engine: z.literal('fsrs'),
  schemaVersion: z.literal('scheduling-state-v1'),
});
export const CandidateStateSchema = z.object({
  engine: z.literal('forgetting_candidate'),
  schemaVersion: z.literal('scheduling-state-v1'),
  global: MemoryStateSchema,
  contexts: z.record(z.string(), MemoryStateSchema),
  conversion: z.enum(['initial', 'native', 'legacy_history', 'legacy_cold', 'invalid_rebuilt']),
  provenance: z.literal('engineering'),
  calibration: z.literal('uncalibrated'),
  due: z.coerce.date(),
  last_review: z.coerce.date().nullable(),
  dueKind: z.enum([
    'due_now',
    'scheduled',
    'beyond_horizon',
    'unknown',
    'invalid_input',
    'initial',
  ]),
  fallbackReason: z.string().nullable(),
});
export const SchedulingStateSchema = z.union([
  CandidateStateSchema,
  TaggedFsrsStateSchema,
  FsrsStateSchema,
]);
export type SchedulingState = z.infer<typeof SchedulingStateSchema>;
export type CandidateState = z.infer<typeof CandidateStateSchema>;
export function isCandidateState(state: SchedulingState): state is CandidateState {
  return 'engine' in state && state.engine === 'forgetting_candidate';
}
