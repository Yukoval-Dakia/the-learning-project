import { z } from 'zod';
import type { DomainTool } from '@/kernel/tools/types';
import { executeWorkspace, invokeWorkspace } from './executor';
import { withWorkspace } from './lifecycle';

const owner = z.object({
  kind: z.enum(['conversation', 'task']),
  id: z.string().min(1),
});
const input = z.object({
  runtime: z.enum(['bash', 'python']),
  code: z.string().max(100 * 1024),
  // Durable owner: the directory persists across turns while the owner lives.
  // Absent = legacy ephemeral acceptance run (create→execute→delete).
  owner: owner.optional(),
});
const output = z.object({
  exitCode: z.number().nullable(),
  output: z.string(),
  stopped: z.boolean(),
  stopReason: z.enum(['timeout', 'cancelled', 'output_limit']).nullable(),
});
export const workspaceExec: DomainTool<z.infer<typeof input>, z.infer<typeof output>> = {
  name: 'workspace_exec',
  description: 'Run bash or Python in an owner-bound workspace. Controlled system acceptance only.',
  effect: 'write',
  costClass: 'local',
  inputSchema: input,
  outputSchema: output,
  mirrorEvent: 'never',
  async execute(ctx, args) {
    if (ctx.callerActor.kind !== 'system' || ctx.callerActor.ref !== 'workspace-acceptance') {
      throw new Error('workspace_not_authorized');
    }
    const parsed = input.parse(args);
    if (!parsed.owner) return executeWorkspace(parsed.runtime, parsed.code, ctx.signal);
    return withWorkspace(
      ctx.db,
      parsed.owner,
      'write',
      (id, signal) => invokeWorkspace(parsed.runtime, id, parsed.code, signal),
      ctx.signal,
    );
  },
  summarize: (_args, result) => `workspace · exit ${result.exitCode}`,
};
