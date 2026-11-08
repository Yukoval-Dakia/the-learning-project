// Sandbox-usage evidence projected from a judging attempt's tool_call_log rows.
// The receipt keeps per-call digests + runtime (enough to see two same-input
// runs diverge); the full script text and raw output stay in tool_call_log
// behind the referenced tool_call_ids.

import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { SandboxToolCallEvidence } from '@/core/schema/event/known';
import type { Db, Tx } from '@/db/client';
import { tool_call_log } from '@/db/schema';
import { AGENT_WORKSPACE_DOMAIN_TOOLS } from '@/kernel/tools/allowlists';

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export const JudgeSandboxEvidenceSchema = z.object({
  tool_call_ids: z.array(z.string().min(1)).min(1),
  calls: z.array(SandboxToolCallEvidence),
});

export type JudgeSandboxEvidence = z.infer<typeof JudgeSandboxEvidenceSchema>;

/**
 * Every workspace tool call the attempt made, oldest first. Returns null when
 * the judging run never touched the sandbox so receipts distinguish
 * "sandbox unused" from "evidence missing".
 */
export async function collectJudgeSandboxEvidence(
  db: Db | Tx,
  taskRunId: string,
): Promise<JudgeSandboxEvidence | null> {
  const rows = await db
    .select({
      id: tool_call_log.id,
      tool_name: tool_call_log.tool_name,
      input_json: tool_call_log.input_json,
      output_json: tool_call_log.output_json,
    })
    .from(tool_call_log)
    .where(
      and(
        eq(tool_call_log.task_run_id, taskRunId),
        inArray(tool_call_log.tool_name, AGENT_WORKSPACE_DOMAIN_TOOLS),
      ),
    )
    .orderBy(asc(tool_call_log.occurred_at));
  if (rows.length === 0) return null;
  const calls = rows.map((row) => {
    const out = (row.output_json ?? {}) as Record<string, unknown>;
    const input = (row.input_json ?? {}) as Record<string, unknown>;
    const runtime = out.runtime_version as { python?: unknown; bash?: unknown } | undefined;
    // exec rows carry both digests directly; a files write's payload digest is
    // computed here from input_json.content (its "script"), its file digest
    // arrives as output_json.sha256.
    const codeSha =
      typeof out.code_sha256 === 'string'
        ? out.code_sha256
        : typeof input.content === 'string' && input.content.length > 0
          ? sha256Hex(input.content)
          : undefined;
    const outputSha =
      typeof out.output_sha256 === 'string'
        ? out.output_sha256
        : typeof out.sha256 === 'string'
          ? out.sha256
          : undefined;
    return {
      tool_call_id: row.id,
      tool_name: row.tool_name,
      ...(typeof out.workspace === 'string' ? { workspace: out.workspace } : {}),
      ...(codeSha ? { code_sha256: codeSha } : {}),
      ...(outputSha ? { output_sha256: outputSha } : {}),
      ...(runtime && typeof runtime.python === 'string' && typeof runtime.bash === 'string'
        ? { runtime_version: { python: runtime.python, bash: runtime.bash } }
        : {}),
    };
  });
  return { tool_call_ids: rows.map((row) => row.id), calls };
}
