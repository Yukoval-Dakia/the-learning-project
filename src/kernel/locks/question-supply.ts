// Exact transaction lock arguments for the existing question-supply operations.
// Callers retain transaction scope and request-before-ingestion/source/root order.
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';

export function webSupplyDemandKey(demandId: string): string {
  return `web_supply_${createHash('sha256').update(demandId).digest('hex')}`;
}

export async function lockWebSupplyDemand(tx: Tx, demandId: string): Promise<void> {
  const key = webSupplyDemandKey(demandId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

export async function lockQuestionSubmitRequest(tx: Tx, requestId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
}
