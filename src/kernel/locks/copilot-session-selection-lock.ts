import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextLockKey } from '@/kernel/locks/registry';

export const COPILOT_SESSION_SELECTION_LOCK = deriveHashtextLockKey(
  advisoryLockRegistry.copilotSessionSelection,
);

/** Serializes Copilot conversation selection, reuse and creation in one transaction. */
export async function lockCopilotSessionSelection(tx: Tx): Promise<void> {
  // Only this family uses the key, so the single-arg hashtext form does not need to
  // match the hashtextextended keys used by other lock sites.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${COPILOT_SESSION_SELECTION_LOCK}))`);
}
