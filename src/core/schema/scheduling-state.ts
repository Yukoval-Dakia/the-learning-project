import { z } from 'zod';
import { EpochMsSchema, MemoryStateSchema, ScoreSchema } from '@/core/forgetting/types';
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
  historySubjectIds: z.array(z.string()).default([]),
  conversion: z.enum(['initial', 'native', 'legacy_history', 'legacy_cold', 'invalid_rebuilt']),
  provenance: z.literal('engineering'),
  calibration: z.literal('uncalibrated'),
  due: z.coerce.date(),
  // Optional for existing snapshots; new writes retain the model result before arrangement.
  modelDue: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('due_now'), at: EpochMsSchema, target: ScoreSchema }),
      z.object({
        kind: z.literal('scheduled'),
        at: EpochMsSchema,
        target: ScoreSchema,
        toleranceMs: z.number(),
      }),
      z.object({
        kind: z.literal('beyond_horizon'),
        checkedThrough: EpochMsSchema,
        scoreThere: ScoreSchema,
      }),
      z.object({ kind: z.literal('unknown'), reason: z.string() }),
      z.object({ kind: z.literal('invalid_input'), reason: z.string() }),
    ])
    .optional(),
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
  FsrsStateSchema.extend({
    engine: z.undefined().optional(),
    schemaVersion: z.undefined().optional(),
  }),
]);
export type SchedulingState = z.infer<typeof SchedulingStateSchema>;
export type CandidateState = z.infer<typeof CandidateStateSchema>;
export function isCandidateState(state: SchedulingState): state is CandidateState {
  return 'engine' in state && state.engine === 'forgetting_candidate';
}

export const RetentionReadingSchema = z.union([
  z.number().min(0).max(1),
  z.object({
    kind: z.literal('score'),
    value: z.number().min(0).max(1),
    calibration: z.literal('uncalibrated'),
    provenance: z.literal('engineering'),
    scope: z.string(),
    asOf: z.number().optional(),
    interval: z.literal('not_estimated').optional(),
  }),
  z.object({
    kind: z.literal('unknown'),
    reason: z.string(),
    calibration: z.literal('uncalibrated'),
    provenance: z.literal('engineering'),
    asOf: z.number().optional(),
  }),
]);
export type RetentionReading = z.infer<typeof RetentionReadingSchema>;
