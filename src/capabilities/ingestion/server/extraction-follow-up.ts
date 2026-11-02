import { COPILOT_NUDGE_EVALUATE_QUEUE } from '@/server/boss/queue-names';
import { AUTO_ENROLL_SINGLETON_SECONDS, autoEnrollJobEnabled } from './workflow-judge-config';

/** Dispatch after extraction commits so workers can see the rows. */
export async function dispatchExtractionFollowUps(
  sessionId: string,
  source: 'tencent_ocr_extract' | 'docx_text',
): Promise<void> {
  // Paid modes are opt-in. Enqueue failures are logged, never fatal to a
  // committed extraction; the dedicated auto_enroll queue isolates its failures.
  if (autoEnrollJobEnabled(process.env)) {
    try {
      const { getStartedBoss } = await import('@/server/boss/client');
      const boss = await getStartedBoss();
      // singletonSeconds is required: a bare singletonKey is a no-op on a
      // standard-policy queue. This only reduces duplicates; the per-block FOR
      // UPDATE claim in the worker is the structural guard against double-INSERT.
      await boss.send(
        'auto_enroll',
        { sessionId },
        { singletonKey: sessionId, singletonSeconds: AUTO_ENROLL_SINGLETON_SECONDS },
      );
    } catch (err) {
      console.error(`[${source}] failed to enqueue auto_enroll`, err);
    }
  }

  // Post-commit, observe-only nudge evaluation. Isolated from auto_enroll so
  // neither enqueue failure masks the other or fails the extraction.
  try {
    const { getStartedBoss } = await import('@/server/boss/client');
    const boss = await getStartedBoss();
    await boss.send(COPILOT_NUDGE_EVALUATE_QUEUE, {
      kind: 'ingestion_complete',
      session_id: sessionId,
    });
  } catch (err) {
    console.error(`[${source}] failed to enqueue copilot_nudge_evaluate`, err);
  }
}
