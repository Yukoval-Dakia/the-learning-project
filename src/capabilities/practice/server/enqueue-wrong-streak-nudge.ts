import { getStartedBoss } from '@/server/boss/client';
import { COPILOT_NUDGE_EVALUATE_QUEUE } from '@/server/boss/queue-names';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';

export async function enqueueWrongStreakNudge(
  outcome: 'success' | 'failure' | 'partial',
  attemptEventId: string,
): Promise<void> {
  if (outcome !== 'failure' || !shouldEnqueueBackgroundJobs()) return;

  try {
    const boss = await getStartedBoss();
    await boss.send(COPILOT_NUDGE_EVALUATE_QUEUE, {
      kind: 'attempt_failure',
      attempt_event_id: attemptEventId,
    });
  } catch (error) {
    console.warn('[copilot_nudge] failed to enqueue wrong-streak evaluation', {
      attemptEventId,
      error,
    });
  }
}
