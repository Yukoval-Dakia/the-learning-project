import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';

/**
 * Serializes writes against one misconception identity. The key text is
 * `misc:<misconceptionId>` — the SAME hashtext identity the promotion / archive
 * writers already issue inline, so recurrence recording is linearizable with
 * accepts and archives of the same node. xact-scoped, released at commit.
 * Callers holding more than one `misc:<id>` lock must acquire them in a
 * deterministic order (the attribution call site sorts the id set first).
 */
export async function lockMisconceptionIdentity(tx: Tx, misconceptionId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`misc:${misconceptionId}`}))`);
}
