import { type AiTaskKind, getTaskSystemPrompt } from '@/ai/task-prompts';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type { RunTaskCallCtx } from '@/server/ai/runner-fn';
import type { SubjectProfile } from '@/subjects/profile';

export interface TaskTextResult {
  text: string;
  task_run_id?: string;
  cost_usd?: number;
  cost_basis?: 'reported' | 'estimated' | 'unknown';
  cost_ref?: string;
  /**
   * YUK-299 seam: Agent SDK structured-output passthrough. runTask's full
   * RunTaskResult (runner.ts) is a structural superset of this interface, so a
   * handler-injected TaskTextRunFn can read `result.structured_output` and do
   * three-state dispatch (structured value present / undefined / fallback).
   * undefined ⇒ outputFormat not set, endpoint unsupported, or model fell back
   * to text — caller must run the text-fallback parse.
   */
  structured_output?: unknown;
}

export type TaskTextRunFn = (
  kind: string,
  input: unknown,
  ctx?: RunTaskCallCtx,
) => Promise<TaskTextResult>;

/**
 * Fingerprint the exact profile-rendered system prompt separately from the
 * user-input hash persisted by runTask. Together they bind both task inputs.
 */
export function taskPromptFingerprint(task: AiTaskKind, profile?: SubjectProfile): string {
  return sha256CanonicalJson({
    task_kind: task,
    system_prompt: getTaskSystemPrompt(task, profile),
  });
}

export function costUsdToMicroUsd(costUsd: number | null | undefined): number | null {
  return costUsd == null || !Number.isFinite(costUsd) ? null : Math.round(costUsd * 1_000_000);
}

export function sumAllKnownCostUsd(costs: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  for (const cost of costs) {
    if (cost == null || !Number.isFinite(cost)) return null;
    total += cost;
    if (!Number.isFinite(total)) return null;
  }
  return total;
}

export function aiAgentRef(
  kind: string,
  result: TaskTextResult,
): {
  by: 'ai';
  task_kind: string;
  task_run_id?: string;
} {
  return {
    by: 'ai',
    task_kind: kind,
    ...(result.task_run_id ? { task_run_id: result.task_run_id } : {}),
  };
}
