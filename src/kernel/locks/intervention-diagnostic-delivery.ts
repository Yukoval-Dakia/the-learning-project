import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';

/**
 * Serializes the immediate diagnostic's live-stream append: delivery for this card
 * first, then the shared daily compose key the lazy/nightly/recompose writers take.
 */
export async function lockInterventionDiagnosticDelivery(
  tx: Tx,
  questionId: string,
  streamDate: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`intervention:deliver:${questionId}`}))`,
  );
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${streamDate}`}))`);
}
