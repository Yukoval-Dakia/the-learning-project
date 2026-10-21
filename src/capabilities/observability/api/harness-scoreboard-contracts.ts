import { z } from 'zod';
import { HarnessScoreboardV1 } from '@/core/schema/harness-scoreboard';

export const HarnessScoreboardResponseSchema = z.object({
  /** Latest deterministic daily projection; null until the first job run. */
  scoreboard: HarnessScoreboardV1.nullable(),
  age_hours: z.number().nullable(),
  /** True when no projection exists or the latest is older than 36h. */
  stale: z.boolean(),
  note: z.string(),
});
