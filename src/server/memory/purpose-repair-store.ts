import { and, eq, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  eventBelongsToDocumentSql,
  readEventDerivationPolicy,
} from '@/kernel/events/derivation-policy';
import {
  PURPOSE_CHANGE_ACTION,
  PURPOSE_REPAIR_ACTION,
  PurposeChangeReceipt,
  PurposeRepairRecord,
  type PurposeRepairRecordT,
} from '@/kernel/read-models/purpose-change';

export async function recordPurposeRepair(
  tx: Db | Tx,
  input: Omit<PurposeRepairRecordT, 'version' | 'derivation_policy'>,
) {
  const payload = PurposeRepairRecord.parse({
    ...input,
    version: 1,
    derivation_policy: 'answer_only',
  });
  await writeEvent(tx, {
    id: newId(),
    actor_kind: 'system',
    actor_ref: 'memory-purpose-repair',
    action: PURPOSE_REPAIR_ACTION,
    subject_kind: 'event',
    subject_id: input.operation_id,
    payload,
    affected_scopes: [],
    ingest_at: new Date(),
  });
}

/** Late provider completion invalidates earlier absence observations before return. */
export async function noteRestrictedMemoryCompletion(tx: Tx, sourceId: string) {
  if ((await readEventDerivationPolicy(tx, sourceId)) === 'allow') return false;
  const commands = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, PURPOSE_CHANGE_ACTION),
        sql`${event.payload}->>'cleanup_required' = 'true'`,
        sql`EXISTS (SELECT 1 FROM event source WHERE source.id = ${sourceId}
      AND ${eventBelongsToDocumentSql(sql`${event.payload}->'input'->>'source_document_id'`, sql`source.id`)})`,
      ),
    );
  for (const row of commands) {
    const receipt = PurposeChangeReceipt.parse(row.payload);
    await recordPurposeRepair(tx, {
      operation_id: receipt.operation_id,
      sink: 'mem0',
      source_id: sourceId,
      state: 'pending',
      detail: 'restricted source returned from Mem0; exact deletion required',
    });
  }
  return true;
}
