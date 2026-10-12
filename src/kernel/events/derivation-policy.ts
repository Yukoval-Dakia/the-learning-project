import { type SQLWrapper, and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

/** Copilot replies and mirrors inherit their accepted causal root, even without a session. */
export async function readEventDerivationPolicy(
  db: Db | Tx,
  eventId: string,
): Promise<DerivationPolicyT> {
  const root = alias(event, 'derivation_root');
  const [row] = await db
    .select({ payload: event.payload, rootPayload: root.payload })
    .from(event)
    .leftJoin(root, eq(root.id, event.caused_by_event_id))
    .where(eq(event.id, eventId))
    .limit(1);
  if (!row) return 'allow';
  const own = readDerivationPolicy(row.payload);
  const parent = readDerivationPolicy(row.rootPayload);
  return own === 'answer_only' || parent === 'answer_only' ? 'answer_only' : 'allow';
}

/** Apply before LIMIT. Raw user chat readers deliberately do not use this predicate. */
export function eventAllowsDerivationSql(
  row: { payload: SQLWrapper; caused_by_event_id: SQLWrapper } = event,
) {
  return and(
    sql`coalesce(${row.payload}->>'derivation_policy', 'allow') = 'allow'`,
    sql`NOT EXISTS (SELECT 1 FROM event derivation_root
      WHERE derivation_root.id = ${row.caused_by_event_id}
        AND coalesce(derivation_root.payload->>'derivation_policy', 'allow') <> 'allow')`,
  );
}
