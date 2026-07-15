import { z } from 'zod';

import { ActivityRef } from '@/kernel/capability-contract-schemas';

export const EventParamsSchema = z.object({
  id: z.string().trim().min(1),
});

export const EventCorrectionBodySchema = z
  .object({
    correction_kind: z.enum(['supersede', 'retract', 'mark_wrong', 'restore']),
    replacement_event_id: z.string().min(1).optional(),
    reason_md: z.string().trim().min(1).max(2000),
    affected_refs: z.array(ActivityRef).min(1),
  })
  .superRefine((data, ctx) => {
    if (data.correction_kind === 'supersede' && !data.replacement_event_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replacement_event_id is required when correction_kind='supersede'",
        path: ['replacement_event_id'],
      });
    }
    if (data.correction_kind !== 'supersede' && data.replacement_event_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replacement_event_id is only allowed when correction_kind='supersede'",
        path: ['replacement_event_id'],
      });
    }
  });

export const EventCorrectionResponseSchema = z.object({
  correction_event_id: z.string(),
});

const EventCorrectionStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('active'),
    correction_event_id: z.null(),
    replacement_event_id: z.null(),
  }),
  z.object({
    state: z.literal('retracted'),
    correction_event_id: z.string(),
    replacement_event_id: z.null(),
  }),
  z.object({
    state: z.literal('marked_wrong'),
    correction_event_id: z.string(),
    replacement_event_id: z.null(),
  }),
  z.object({
    state: z.literal('superseded'),
    correction_event_id: z.string(),
    replacement_event_id: z.string(),
  }),
]);

const EventEnvelopeSchema = z
  .object({
    id: z.string(),
    created_at: z.string().datetime(),
    actor_kind: z.string(),
    actor_ref: z.string(),
    action: z.string(),
    subject_kind: z.string(),
    subject_id: z.string(),
    outcome: z.string().nullable().optional(),
    payload: z.unknown(),
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
    correction_status: EventCorrectionStatusSchema,
  })
  .passthrough();

export const EventDetailResponseSchema = z.object({
  event: EventEnvelopeSchema,
  correction_status: EventCorrectionStatusSchema,
  chain: z.object({
    caused_by: EventEnvelopeSchema.nullable(),
    caused_events: z.array(EventEnvelopeSchema),
    corrections: z.array(EventEnvelopeSchema),
  }),
});

export const JOB_EVENT_KINDS = [
  'ingestion_session',
  'copilot_run',
  'echo_jobs',
  'question_block',
  'learning_session',
  'ingestion_operation',
] as const;

export const JOB_EVENT_KIND_SET = new Set<string>(JOB_EVENT_KINDS);

export const JobEventParamsSchema = z.object({
  kind: z.enum(JOB_EVENT_KINDS),
  id: z.string().trim().min(1),
});

export const JobEventHeadersSchema = z.object({
  'Last-Event-ID': z.string().optional(),
});

export const JobEventStreamResponseSchema = z.string();
