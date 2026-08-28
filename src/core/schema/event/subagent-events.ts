import { z } from 'zod';

export const SubagentRunStartedExperimental = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.literal('agent:copilot'),
  action: z.literal('experimental:subagent_run_started'),
  subject_kind: z.literal('subagent_run'),
  subject_id: z.string(),
  outcome: z.null().optional(),
  payload: z.object({
    run_id: z.string(),
    launch_key: z.string().min(1).max(120),
    objective: z.string().min(1).max(12_000),
  }),
  caused_by_event_id: z.string(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});

export const SubagentRunSettledExperimental = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.literal('agent:copilot-researcher'),
  action: z.literal('experimental:subagent_run_settled'),
  subject_kind: z.literal('subagent_run'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'failure']),
  payload: z
    .object({
      run_id: z.string(),
      status: z.enum(['succeeded', 'failed', 'cancelled', 'lost']),
      result_md: z.string().max(60_000).optional(),
      error: z.object({ code: z.string().max(100), message: z.string().max(4_000) }).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.status === 'succeeded' && value.result_md === undefined) {
        ctx.addIssue({ code: 'custom', message: 'succeeded subagent result is required' });
      }
      if (value.status !== 'succeeded' && value.error === undefined) {
        ctx.addIssue({ code: 'custom', message: 'terminal subagent error is required' });
      }
    }),
  caused_by_event_id: z.string(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
