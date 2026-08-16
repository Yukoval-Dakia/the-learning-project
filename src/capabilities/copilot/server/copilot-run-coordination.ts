import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';

/**
 * Acquire the per-run settlement lock inside a caller-owned transaction.
 *
 * The cancel endpoint takes the dispatch lock first and this lock second. Paid
 * execution owns only the short settlement section, so a committed cancel and
 * a committed outcome marker have one deterministic order without holding a
 * database lock across the model/tool loop.
 */
export async function acquireCopilotExecutionSettlementLock(tx: Tx, runId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${'copilot-execution-settlement'}), hashtext(${runId}))`,
  );
}
