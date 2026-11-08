import { z } from 'zod';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  executeWorkspace,
  invokeWorkspace,
  invokeWorkspaceFiles,
  sha256Hex,
  workspaceRuntimeVersion,
} from './executor';
import { type WorkspaceOwner, withWorkspace } from './lifecycle';

/**
 * Server-bound owner derivation. The model never names an owner, directory,
 * uid, environment, interpreter, or timeout — the runner supplies context and
 * precedence is: per-spawn child scope > bound conversation > logical run key.
 * Liveness is proven separately on the claiming attempt's run row.
 */
function workspaceOwner(ctx: ToolContext): WorkspaceOwner | null {
  if (ctx.workspaceOwnerId) return { kind: 'task', id: ctx.workspaceOwnerId };
  if (ctx.sessionId) return { kind: 'conversation', id: ctx.sessionId };
  if (ctx.taskRunId) return { kind: 'task', id: ctx.taskRunId };
  // Attempt id stamped by the runner — a real durable row, safe to own a
  // workspace for the attempt's lifetime when no caller-anchored id exists.
  if (ctx.logTaskRunId) return { kind: 'task', id: ctx.logTaskRunId };
  return null;
}

const isAcceptance = (ctx: ToolContext) =>
  ctx.callerActor.kind === 'system' && ctx.callerActor.ref === 'workspace-acceptance';

const execInput = z.object({
  runtime: z.enum(['bash', 'python']),
  code: z.string().max(100 * 1024),
});
const execOutput = z.object({
  exitCode: z.number().nullable(),
  output: z.string(),
  stopped: z.boolean(),
  stopReason: z.enum(['timeout', 'cancelled', 'output_limit', 'quota_exceeded']).nullable(),
  // Durable workspace identity plus run provenance: the script, its result,
  // and the interpreter that produced them are all digestable from the log row.
  workspace: z.string().optional(),
  code_sha256: z.string(),
  output_sha256: z.string(),
  runtime_version: z.object({ python: z.string(), bash: z.string() }).optional(),
});

export const workspaceExec: DomainTool<z.infer<typeof execInput>, z.infer<typeof execOutput>> = {
  name: 'workspace_exec',
  description:
    "Run a bash or Python script in this session's private scratch directory (fixed interpreter, 30 min ceiling, output truncated at 100 KiB). Files persist only while the owning run or conversation is alive.",
  effect: 'write',
  costClass: 'local',
  inputSchema: execInput,
  outputSchema: execOutput,
  mirrorEvent: 'never',
  async execute(ctx, args) {
    const parsed = execInput.parse(args);
    const owner = workspaceOwner(ctx);
    const digests = (output: string) => ({
      code_sha256: sha256Hex(parsed.code),
      output_sha256: sha256Hex(output),
    });
    // Legacy acceptance lane: no server-bound owner in the harness context —
    // run create→execute→delete under the controlled actor only.
    if (isAcceptance(ctx) && !ctx.sessionId && !ctx.logTaskRunId) {
      const result = await executeWorkspace(parsed.runtime, parsed.code, ctx.signal);
      return {
        ...result,
        stopReason:
          result.stopReason ??
          (result.output.includes('workspace_quota_exceeded') ? 'quota_exceeded' : null),
        ...digests(result.output),
      };
    }
    if (!owner) throw new Error('workspace_owner_unbindable');
    return withWorkspace(
      ctx.db,
      owner,
      'write',
      async (id, signal) => {
        const result = await invokeWorkspace(parsed.runtime, id, parsed.code, signal);
        const stopReason =
          result.stopReason ??
          (result.output.includes('workspace_quota_exceeded') ? 'quota_exceeded' : null);
        return {
          ...result,
          stopReason,
          workspace: id,
          ...digests(result.output),
          runtime_version: await workspaceRuntimeVersion(id),
        };
      },
      ctx.signal,
      0,
      ctx.logTaskRunId,
    );
  },
  summarize: (_args, result) => `workspace · exit ${result.exitCode}`,
};

const fileInput = z.object({
  action: z.enum(['read', 'write', 'list', 'delete']),
  path: z.string().min(1).max(1024),
  content: z
    .string()
    .max(100 * 1024)
    .optional(),
});
const fileOutput = z.object({
  action: z.enum(['read', 'write', 'list', 'delete']),
  path: z.string(),
  content: z.string().optional(),
  bytes: z.number().optional(),
  sha256: z.string().optional(),
  entries: z.array(z.object({ name: z.string(), kind: z.string(), size: z.number() })).optional(),
  removed: z.string().optional(),
  truncated: z.boolean(),
  workspace: z.string().optional(),
});

export const workspaceFiles: DomainTool<z.infer<typeof fileInput>, z.infer<typeof fileOutput>> = {
  name: 'workspace_files',
  description:
    'Read, write, list, or delete files inside the same private scratch directory by relative path only — no absolute paths, no .., no symlinks. Writes are serialized; one call carries at most 100 KiB.',
  effect: 'write',
  costClass: 'local',
  inputSchema: fileInput,
  outputSchema: fileOutput,
  mirrorEvent: 'never',
  async execute(ctx, args) {
    const parsed = fileInput.parse(args);
    const owner = workspaceOwner(ctx);
    if (!owner) throw new Error('workspace_owner_unbindable');
    return withWorkspace(
      ctx.db,
      owner,
      'write',
      async (id, signal) => {
        const result = await invokeWorkspaceFiles(
          id,
          parsed.action,
          parsed.path,
          parsed.content,
          signal,
        );
        if (result.exitCode !== 0) throw new Error(`workspace_files_failed: ${result.output}`);
        if (parsed.action === 'read') {
          // files.py emits one JSON header line then the raw body; a truncated
          // capture still proves the file's true length and digest.
          const nl = result.output.indexOf('\n');
          if (nl < 0) throw new Error('workspace_files_failed: malformed_read');
          const header = JSON.parse(result.output.slice(0, nl)) as {
            bytes: number;
            sha256: string;
          };
          const content = result.output.slice(nl + 1);
          return {
            action: parsed.action,
            path: parsed.path,
            content,
            bytes: header.bytes,
            sha256: header.sha256,
            truncated: result.stopReason === 'output_limit',
            workspace: id,
          };
        }
        const body = JSON.parse(result.output) as {
          bytes?: number;
          sha256?: string;
          entries?: { name: string; kind: string; size: number }[];
          removed?: string;
          truncated?: boolean;
        };
        return {
          action: parsed.action,
          path: parsed.path,
          bytes: body.bytes,
          sha256: body.sha256,
          entries: body.entries,
          removed: body.removed,
          truncated: body.truncated ?? result.stopReason === 'output_limit',
          workspace: id,
        };
      },
      ctx.signal,
      0,
      ctx.logTaskRunId,
    );
  },
  summarize: (args, _result) => `workspace ${args.action} ${args.path}`,
};
