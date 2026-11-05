import { type SQLWrapper, and, eq, inArray } from 'drizzle-orm';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  lockDerivationSources,
  sourceAllowsDerivationSql,
  sourceBelongsToDocumentSql,
  sourceHasCrisisSql,
} from '@/kernel/read-models/usage-policy';

/** Every causal ancestor participates. UNION terminates malformed cycles.
 * Epoch mismatches freeze old sources after withdrawal, including after relax.
 */
export function eventAllowsDerivationSql(
  row: {
    id: SQLWrapper;
    payload: SQLWrapper;
    caused_by_event_id: SQLWrapper;
    session_id: SQLWrapper;
  } = event,
) {
  return sourceAllowsDerivationSql({ kind: 'event', id: row.id });
}

export async function readEventDerivationPolicy(
  db: Db | Tx,
  eventId: string,
): Promise<DerivationPolicyT> {
  const [row] = await db
    .select({
      allowed: eventAllowsDerivationSql(),
      crisis: sourceHasCrisisSql({ kind: 'event', id: eventId }),
    })
    .from(event)
    .where(eq(event.id, eventId))
    .limit(1);
  return row?.crisis ? 'crisis' : row?.allowed ? 'allow' : 'answer_only';
}

/** Exact session/causal closure for cleanup, without similarity or timestamps. */
export function eventBelongsToDocumentSql(
  documentId: string | SQLWrapper,
  id: SQLWrapper = event.id,
) {
  return sourceBelongsToDocumentSql({ kind: 'event', id }, documentId);
}

export async function allowedEventIds(db: Db | Tx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(and(inArray(event.id, ids), eventAllowsDerivationSql()));
  return new Set(rows.map((row) => row.id));
}

/** Memory holds its existing source lock first; purpose mutation never takes it. */
export async function lockEventDerivationSources(tx: Tx, sourceId: string) {
  await lockDerivationSources(tx, { kind: 'event', id: sourceId });
}
