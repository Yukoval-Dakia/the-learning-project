import type { Db } from '@/db/client';
import { writeCostLedger } from '@/server/ai/log';

export async function writeRetryableAiFailureLedger(db: Db, taskKind: string): Promise<void> {
  try {
    await writeCostLedger(db, {
      task_kind: taskKind,
      provider: 'unknown',
      model: 'unknown',
      cost: 0,
      tokens_in: 0,
      tokens_out: 0,
      outcome: 'failed_retryable',
    });
  } catch (err) {
    console.error(`[${taskKind}] writeCostLedger failed for retryable AI failure`, err);
  }
}
