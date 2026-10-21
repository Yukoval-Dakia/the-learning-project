import { AgentRunError, isProviderSessionWallClockBudgetError } from '@/ai/agent-run-error';
import { type AiTaskKind, getTaskSystemPrompt } from '@/capabilities/task-registry';
import { sha256CanonicalJson } from '@/kernel/canonical-json';

export { costUsdToMicroUsd, sumAllKnownCostUsd } from '@/kernel/cost';

import type { NoteGeneratePhaseTimings } from '@/server/ai/log';

export type { NoteGeneratePhaseTimings };

import type { RunTaskCallCtx } from '@/server/ai/runner-fn';
import type { SubjectProfile } from '@/subjects/profile';

export interface TaskTextResult {
  text: string;
  task_run_id?: string;
  /** Provider stop reason. `max_tokens` / `length` means the text was cut off. */
  finishReason?: string;
  cost_usd?: number;
  cost_basis?: 'reported' | 'estimated' | 'unknown';
  cost_ref?: string;
  /**
   * YUK-299 seam: structured-output passthrough. `RunTaskResult` is a structural
   * superset, so a TaskTextRunFn can read it. undefined ⇒ fall back to text parsing.
   */
  structured_output?: unknown;
  /** NoteGenerateTask phase timings recorded on the task run. */
  phases?: NoteGeneratePhaseTimings;
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
export function taskPromptFingerprint(
  task: AiTaskKind,
  profile?: SubjectProfile,
  learnerLocale?: 'zh-CN' | 'en',
): string {
  return sha256CanonicalJson({
    task_kind: task,
    system_prompt: getTaskSystemPrompt(task, profile, learnerLocale),
  });
}

export function isGenerationBudgetTimeout(error: unknown): boolean {
  if (error instanceof AgentRunError && error.subtype === 'budget_timeout') return true;
  return isProviderSessionWallClockBudgetError(error);
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
