import { type SQLWrapper, and, eq, inArray, sql } from 'drizzle-orm';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  lockDerivationSources,
  sourceAllowsDerivationSql,
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
      crisis: sql<boolean>`EXISTS (
      WITH RECURSIVE lineage AS (
        SELECT e.id, e.payload, e.session_id, e.caused_by_event_id FROM event e WHERE e.id = ${eventId}
        UNION SELECT p.id, p.payload, p.session_id, p.caused_by_event_id FROM event p
          JOIN lineage c ON c.caused_by_event_id = p.id
      ) SELECT 1 FROM lineage l LEFT JOIN learning_session s ON s.id = l.session_id
      LEFT JOIN source_document d ON d.id = s.source_document_id
      WHERE l.payload->>'derivation_policy' = 'crisis'
        OR d.provenance->'usage_policy'->>'derivation_policy' = 'crisis'
    )`,
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
  return sql`EXISTS (
    WITH RECURSIVE lineage AS (
      SELECT e.id, e.payload, e.session_id, e.caused_by_event_id FROM event e WHERE e.id = ${id}
      UNION
      SELECT p.id, p.payload, p.session_id, p.caused_by_event_id FROM event p
      JOIN lineage c ON c.caused_by_event_id = p.id
    ) SELECT 1 FROM lineage l LEFT JOIN learning_session s ON s.id = l.session_id
    LEFT JOIN event binding ON binding.id = 'ingestion-usage:' || l.id
      AND binding.action = 'experimental:ingestion_usage_binding'
      AND binding.actor_kind = 'system' AND binding.actor_ref = 'ingestion-usage'
    WHERE coalesce(binding.payload->>'document_id', s.source_document_id) = ${documentId}
  )`;
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
