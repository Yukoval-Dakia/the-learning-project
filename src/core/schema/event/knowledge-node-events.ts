import { z } from 'zod';

// YUK-728 — subject control-plane rename/reset mirrors display_name onto the subject's
// knowledge root. This is structural fold truth, so the event is reserved and typed rather than
// falling through the loose ExperimentalEvent escape hatch.
const SubjectRootNameUpdatePayload = z
  .object({
    control_action: z.enum(['rename', 'reset']),
    subject_id: z.string().min(1),
    previous_name: z.string(),
    next_name: z.string().min(1),
    previous_version: z.number().int().nonnegative(),
    next_version: z.number().int().positive(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.next_version !== payload.previous_version + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'next_version must equal previous_version + 1',
        path: ['next_version'],
      });
    }
  });

export const SubjectRootNameUpdateExperimental = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: z.literal('owner'),
    action: z.literal('experimental:subject_root_name_update'),
    subject_kind: z.literal('knowledge'),
    subject_id: z.string().min(1),
    outcome: z.literal('success'),
    payload: SubjectRootNameUpdatePayload,
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((event, ctx) => {
    if (event.subject_id !== `seed:${event.payload.subject_id}:root`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'subject_id must be the canonical root id for payload.subject_id',
        path: ['subject_id'],
      });
    }
  });
export type SubjectRootNameUpdateExperimentalT = z.infer<typeof SubjectRootNameUpdateExperimental>;
