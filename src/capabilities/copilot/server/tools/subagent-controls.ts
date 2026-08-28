import { z } from 'zod';
import type { DomainTool } from '@/kernel/tools/types';
import { enqueueCopilotMailboxJob } from '../../jobs/copilot_run';
import {
  SUBAGENT_RUN_QUEUE,
  attachSubagentJobId,
  cancelSubagentRun,
  getOwnedSubagentRun,
  launchSubagentRun,
  waitSubagentRun,
} from '../subagent-mailbox';

const RunSchema = z.object({
  run_id: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'lost']),
  result_md: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

function toOutput(record: Awaited<ReturnType<typeof getOwnedSubagentRun>>) {
  return {
    run_id: record.id,
    status: record.status,
    result_md: record.result,
    error: record.error,
  };
}

export const launchResearcherTool: DomainTool<
  { launch_key: string; objective: string },
  z.infer<typeof RunSchema>
> = {
  name: 'launch_researcher',
  description:
    'Launch one durable read-only researcher for a bounded objective. Reuse the same launch_key only for identical input. The researcher replies only through Copilot.',
  effect: 'read',
  inputSchema: z.object({
    launch_key: z.string().min(1).max(120),
    objective: z.string().min(1).max(12_000),
  }),
  outputSchema: RunSchema,
  costClass: 'local',
  async execute(ctx, input) {
    if (!ctx.sessionId || !ctx.causedByEventId) {
      throw new Error('launch_researcher requires a session and parent turn event');
    }
    const launched = await launchSubagentRun(ctx.db, {
      sessionId: ctx.sessionId,
      parentTurnEventId: ctx.causedByEventId,
      parentTaskRunId: ctx.taskRunId,
      launchKey: input.launch_key,
      objective: input.objective,
    });
    if (launched.record.status === 'queued' && !launched.record.pgBossJobId) {
      const jobId = await enqueueCopilotMailboxJob(SUBAGENT_RUN_QUEUE, launched.record.id, {
        run_id: launched.record.id,
      });
      if (!jobId) throw new Error('subagent queue did not return a job id');
      await attachSubagentJobId(ctx.db, launched.record.id, jobId);
    }
    return toOutput(await getOwnedSubagentRun(ctx.db, launched.record.id, ctx.sessionId));
  },
  summarize(_input, output) {
    return `researcher · ${output.status} · ${output.run_id}`;
  },
  mirrorEvent: 'never',
};

export const getSubagentTool: DomainTool<{ run_id: string }, z.infer<typeof RunSchema>> = {
  name: 'get_subagent',
  description: 'Read the durable state of one researcher launched in this Copilot session.',
  effect: 'read',
  inputSchema: z.object({ run_id: z.string().min(1).max(256) }),
  outputSchema: RunSchema,
  costClass: 'local',
  async execute(ctx, input) {
    if (!ctx.sessionId) throw new Error('get_subagent requires a session');
    return toOutput(await getOwnedSubagentRun(ctx.db, input.run_id, ctx.sessionId));
  },
  summarize(_input, output) {
    return `researcher · ${output.status} · ${output.run_id}`;
  },
  mirrorEvent: 'never',
};

export const waitSubagentTool: DomainTool<
  { run_id: string; timeout_ms: number },
  z.infer<typeof RunSchema>
> = {
  name: 'wait_subagent',
  description: 'Wait up to 5000 ms for one researcher, then return its current durable state.',
  effect: 'read',
  inputSchema: z.object({
    run_id: z.string().min(1).max(256),
    timeout_ms: z.number().int().min(0).max(5_000),
  }),
  outputSchema: RunSchema,
  costClass: 'local',
  async execute(ctx, input) {
    if (!ctx.sessionId) throw new Error('wait_subagent requires a session');
    return toOutput(await waitSubagentRun(ctx.db, input.run_id, ctx.sessionId, input.timeout_ms));
  },
  summarize(_input, output) {
    return `researcher · ${output.status} · ${output.run_id}`;
  },
  mirrorEvent: 'never',
};

export const cancelSubagentTool: DomainTool<{ run_id: string }, z.infer<typeof RunSchema>> = {
  name: 'cancel_subagent',
  description: 'Request cooperative cancellation of one researcher in this Copilot session.',
  effect: 'write',
  inputSchema: z.object({ run_id: z.string().min(1).max(256) }),
  outputSchema: RunSchema,
  costClass: 'local',
  async execute(ctx, input) {
    if (!ctx.sessionId) throw new Error('cancel_subagent requires a session');
    return toOutput(await cancelSubagentRun(ctx.db, input.run_id, ctx.sessionId, 'model'));
  },
  summarize(_input, output) {
    return `researcher · ${output.status} · ${output.run_id}`;
  },
  mirrorEvent: 'never',
};
