import { z } from 'zod';

import { tasks } from '@/ai/registry';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import type { DomainTool } from '@/server/ai/tools/types';

export const RunTaskInputSchema = z
  .object({ task_kind: z.string().min(1), intent: z.record(z.unknown()) })
  .strict();

export const RunTaskOutputSchema = z.object({
  task_kind: z.string(),
  text: z.string(),
  task_run_id: z.string().nullable(),
  cost_usd: z.number(),
  finish_reason: z.string().nullable(),
});

type RunTaskInput = z.infer<typeof RunTaskInputSchema>;
type RunTaskOutput = z.infer<typeof RunTaskOutputSchema>;

export const runTaskTool: DomainTool<RunTaskInput, RunTaskOutput> = {
  name: 'run_task',
  description:
    'Run one registry-approved generation task and return audited generation output only. This never persists drafts or proposals; use author_question when the user wants a retained question draft/proposal.',
  effect: 'read',
  inputSchema: RunTaskInputSchema,
  outputSchema: RunTaskOutputSchema,
  costClass: 'expensive_llm',
  async execute(ctx, input) {
    const task = tasks[input.task_kind as keyof typeof tasks];
    if (!task) throw new Error(`run_task: unknown task kind '${input.task_kind}'`);
    const copilot = 'copilot' in task ? task.copilot : undefined;
    if (!copilot || copilot.invocable !== true) {
      throw new Error(`run_task: task '${input.task_kind}' is not invocable`);
    }
    const intent = copilot.intentSchema.parse(input.intent);
    const prepare = await copilot.prepare();
    const prepared = await prepare(ctx, intent);
    const result = await makeRunTaskFn(ctx.db)(input.task_kind, prepared.input, prepared.ctx);
    return {
      task_kind: input.task_kind,
      text: result.text,
      task_run_id: result.task_run_id ?? null,
      cost_usd: result.cost_usd ?? 0,
      finish_reason: result.finishReason ?? null,
    };
  },
  summarize(input) {
    return `run_task · ${input.task_kind}`;
  },
  mirrorEvent: 'when_user_visible',
};
