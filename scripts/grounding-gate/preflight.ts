import type { TaskKind } from '@/capabilities/task-registry';
import { resolveTaskProvider } from '@/server/ai/providers';

/**
 * The shadow/eval receipts compare resolved routes, so a global env pin that
 * silently repoints every task invalidates them — the same reason the check
 * existed under the old Opus/Mimo lane topology.
 */
function assertNoGlobalProviderPin(env: NodeJS.ProcessEnv, label: string): void {
  const conflicting = ['AI_PROVIDER_OVERRIDE', 'AI_PROVIDER_MODEL'].filter((name) =>
    env[name]?.trim(),
  );
  if (conflicting.length > 0) {
    throw new Error(
      `${label} preflight failed: unset ${conflicting.join(', ')} so every task keeps its configured lane and the receipt route matches production`,
    );
  }
}

/**
 * Credentials are whatever the resolved task lanes actually need — derived by
 * running the same resolution the runner runs, not pinned to one provider's
 * env name. TaskConfigError already names the missing credential/pair.
 */
function assertTaskLanesResolvable(kinds: readonly TaskKind[], label: string): void {
  const failures: string[] = [];
  for (const kind of kinds) {
    try {
      resolveTaskProvider(kind);
    } catch (error) {
      failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${label} preflight failed: task lanes are not runnable in this environment — ${failures.join(' | ')}`,
    );
  }
}

const SHADOW_TASK_KINDS: readonly TaskKind[] = ['MindModelInductionTask', 'ConjectureGroupingTask'];

export function validateShadowProviderEnv(env: NodeJS.ProcessEnv): void {
  assertNoGlobalProviderPin(env, 'shadow provider');
  assertTaskLanesResolvable(SHADOW_TASK_KINDS, 'shadow provider');
}
