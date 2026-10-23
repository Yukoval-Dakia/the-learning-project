import { AgentRunError, isProviderSessionWallClockBudgetError } from '@/ai/agent-run-error';
import type { TaskTextResult } from '@/ai/task-result';
import { type AiTaskKind, getTaskSystemPrompt } from '@/capabilities/task-registry';
import { sha256CanonicalJson } from '@/kernel/canonical-json';

export { costUsdToMicroUsd, sumAllKnownCostUsd } from '@/kernel/cost';

import type { RunTaskCallCtx } from '@/server/ai/runner-fn';
import type { SubjectProfile } from '@/subjects/profile';

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
