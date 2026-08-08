import type { Db } from '@/db/client';
import {
  writePermanentAiFailureLedger,
  writeRetryableAiFailureLedger,
} from '@/server/ai/failure-ledger';

export function recordAttributionRetryable(db: Db): Promise<void> {
  return writeRetryableAiFailureLedger(db, 'AttributionTask');
}

export function recordAttributionPermanent(
  db: Db,
  taskRunId: string | null | undefined,
): Promise<void> {
  return writePermanentAiFailureLedger(db, 'AttributionTask', taskRunId);
}

export function recordVariantPermanent(
  db: Db,
  taskRunId: string | null | undefined,
): Promise<void> {
  return writePermanentAiFailureLedger(db, 'VariantGenTask', taskRunId);
}
