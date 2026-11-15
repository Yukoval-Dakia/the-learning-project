import { z } from 'zod';
import {
  PaperContinuationSchema,
  PaperDetailResponseSchema,
  PaperTaskRefSchema,
} from '../../api/paper-contracts';

export const PaperContinuationStateSchema = z
  .object({
    format: z.literal(1),
    occurrence_ref: z.string().min(1),
    step_issuance_id: z.string().min(1).nullable(),
    revision: z.number().int().nonnegative(),
    last_command: z.object({ id: z.string().min(1), digest: z.string().min(1) }).nullable(),
  })
  .strict();

export const ReadPaperContinuationQuerySchema = z
  .object({ occurrence_ref: z.string().min(1) })
  .strict();
export const ResumePaperTaskBodySchema = z
  .object({
    action: z.enum(['resume', 'pause']).default('resume'),
    task_ref: PaperTaskRefSchema,
    expected_revision: z.number().int().nonnegative(),
    command_id: z.string().min(1).max(200),
  })
  .strict();
export const RecordPaperStepBodySchema = ResumePaperTaskBodySchema.omit({ action: true })
  .extend({
    step_issuance_id: z.string().min(1),
  })
  .strict();
export const PaperTaskContinuationResponseSchema = PaperDetailResponseSchema.extend({
  continuation: PaperContinuationSchema,
});
