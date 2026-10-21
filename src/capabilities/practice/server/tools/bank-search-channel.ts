import type { Db, Tx } from '@/db/client';
import { readBankServableParts } from './bank-ref';

/** Physical scan bound, separate from the eligible channel pool bound. */
export const BANK_SEARCH_SCAN_BUDGET = 2000;
const SCAN_BATCH = 200;

/** Keep stable SQL order while refilling past unavailable groups. The serving
 * predicate stays owned by issuance; this module never recreates its labels. */
export async function collectBankSearchChannel<Row extends { id: string }>(
  db: Db | Tx,
  queryBatch: (offset: number, count: number) => Promise<Row[]>,
  options: { admitted: boolean; cap: number },
): Promise<{ rows: Row[]; scanned: number; truncated: boolean; stop: string }> {
  const accepted: Row[] = [];
  let scanned = 0;
  while (scanned < BANK_SEARCH_SCAN_BUDGET) {
    const size = Math.min(SCAN_BATCH, BANK_SEARCH_SCAN_BUDGET - scanned);
    const batch = await queryBatch(scanned, size);
    scanned += batch.length;
    const parts = options.admitted
      ? await readBankServableParts(
          db,
          batch.map((row) => row.id),
        )
      : null;
    for (const row of batch) {
      if (parts === null || (parts.get(row.id)?.length ?? 0) > 0) accepted.push(row);
      if (accepted.length > options.cap) {
        return {
          rows: accepted.slice(0, options.cap),
          scanned,
          truncated: true,
          stop: 'eligible_pool_cap',
        };
      }
    }
    if (batch.length < size) {
      return { rows: accepted, scanned, truncated: false, stop: 'channel_exhausted' };
    }
  }
  return { rows: accepted, scanned, truncated: true, stop: 'scan_budget' };
}
