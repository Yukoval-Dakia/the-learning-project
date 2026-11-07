// Send-gate for the dedicated Sol lane. Resolving the binding proves the pair
// is complete/legal; the assertion then proves it is THE dedicated route —
// provider/model/auth file/reasoning/selection rule all frozen — so a
// misconfigured lane fails before any provider request, never mid-flight.

import { TaskConfigError, resolveTaskProvider } from '@/server/ai/providers';
import {
  DRAWING_TASK_KIND,
  SOL_MODEL,
  SOL_PROVIDER,
  SOL_REASONING_LEVEL,
} from '../tasks/drawing-task';

export function assertSolRoute(): void {
  const resolved = resolveTaskProvider(DRAWING_TASK_KIND);
  const facts = {
    provider: resolved.provider,
    model: resolved.model,
    authMode: resolved.authMode,
    selectionRule: resolved.selectionRule ?? null,
    reasoning: resolved.reasoning?.applied ?? null,
  };
  const ok =
    facts.provider === SOL_PROVIDER &&
    facts.model === SOL_MODEL &&
    facts.authMode === 'oauth-file' &&
    facts.selectionRule === 'task_pair_priority' &&
    facts.reasoning === SOL_REASONING_LEVEL;
  if (!ok) {
    throw new TaskConfigError(
      `DrawingTask resolved route ${JSON.stringify(facts)} is not the dedicated Sol lane ` +
        `(openai/gpt-6.1-sol via ChatGPT-login auth file, reasoning '${SOL_REASONING_LEVEL}', ` +
        `selectionRule 'task_pair_priority'). Fix the four task.${DRAWING_TASK_KIND} keys; ` +
        `refusing to send.`,
    );
  }
}
