import { type SQLWrapper, and, eq, sql } from 'drizzle-orm';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

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
  return sql`NOT EXISTS (
    WITH RECURSIVE lineage(id, payload, session_id, caused_by_event_id) AS (
      SELECT ${row.id}, ${row.payload}, ${row.session_id}, ${row.caused_by_event_id}
      UNION
      SELECT parent.id, parent.payload, parent.session_id, parent.caused_by_event_id
      FROM event parent JOIN lineage child ON parent.id = child.caused_by_event_id
    )
    SELECT 1 FROM lineage l
    LEFT JOIN event binding ON binding.id = 'ingestion-usage:' || l.id
      AND binding.action = 'experimental:ingestion_usage_binding'
      AND binding.actor_kind = 'system' AND binding.actor_ref = 'ingestion-usage'
    LEFT JOIN learning_session s ON s.id = l.session_id
    LEFT JOIN source_document d ON d.id = COALESCE(binding.payload->>'document_id', s.source_document_id)
    WHERE (l.payload ? 'derivation_policy' AND l.payload->>'derivation_policy' IS DISTINCT FROM 'allow')
      OR (l.session_id IS NOT NULL AND s.id IS NULL)
      OR (s.type = 'ingestion' AND s.source_document_id IS NULL AND binding.id IS NULL)
      OR (coalesce(binding.payload->>'document_id', s.source_document_id) IS NOT NULL AND d.id IS NULL)
      OR (d.id IS NOT NULL AND (
        coalesce(d.provenance->'usage_policy'->>'derivation_policy', 'allow') <> 'allow'
        OR (d.provenance ? 'usage_policy' AND jsonb_typeof(d.provenance->'usage_policy') <> 'object')
        OR (d.provenance->'usage_policy' ? 'derivation_policy' AND d.provenance->'usage_policy'->>'derivation_policy' IS DISTINCT FROM 'allow')
        OR (d.provenance ? 'usage_epoch' AND jsonb_typeof(d.provenance->'usage_epoch') <> 'string')
        OR coalesce(binding.payload->>'epoch', 'legacy')
          <> coalesce(d.provenance->>'usage_epoch', 'legacy')
      ))
      OR (binding.id IS NOT NULL AND (d.id IS NULL
        OR binding.payload->>'source_policy' IS DISTINCT FROM 'allow'
        OR NOT (binding.payload ?& ARRAY['document_id','epoch','source_policy'])))
      OR (l.caused_by_event_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM event known_parent WHERE known_parent.id = l.caused_by_event_id))
  )`;
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
    .where(and(sql`${event.id} = ANY(${ids}::text[])`, eventAllowsDerivationSql()));
  return new Set(rows.map((row) => row.id));
}

/** Memory holds its existing source lock first; purpose mutation never takes it. */
export async function lockEventDerivationSources(tx: Tx, sourceId: string) {
  await tx.execute(sql`WITH RECURSIVE lineage AS (
    SELECT e.id, e.session_id, e.caused_by_event_id FROM event e WHERE e.id = ${sourceId}
    UNION SELECT p.id, p.session_id, p.caused_by_event_id FROM event p
      JOIN lineage c ON c.caused_by_event_id = p.id
  ) SELECT d.id FROM source_document d WHERE d.id IN (
    SELECT coalesce(b.payload->>'document_id', s.source_document_id) FROM lineage l
    LEFT JOIN learning_session s ON s.id = l.session_id
    LEFT JOIN event b ON b.id = 'ingestion-usage:' || l.id
      AND b.action = 'experimental:ingestion_usage_binding'
      AND b.actor_kind = 'system' AND b.actor_ref = 'ingestion-usage'
  ) ORDER BY d.id FOR SHARE`);
}
