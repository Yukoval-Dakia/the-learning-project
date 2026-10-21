import { type SQLWrapper, and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { event, learning_session, source_document } from '@/db/schema';

/** Resolve the strictest policy from the event, its causal root, and its document. */
export async function readEventDerivationPolicy(
  db: Db | Tx,
  eventId: string,
): Promise<DerivationPolicyT> {
  const root = alias(event, 'derivation_root');
  const [row] = await db
    .select({
      payload: event.payload,
      rootPayload: root.payload,
      docProvenance: source_document.provenance,
    })
    .from(event)
    .leftJoin(root, eq(root.id, event.caused_by_event_id))
    // Join the live document policy so consent withdrawal applies retroactively
    // without rewriting already-written events.
    .leftJoin(learning_session, eq(learning_session.id, event.session_id))
    .leftJoin(source_document, eq(source_document.id, learning_session.source_document_id))
    .where(eq(event.id, eventId))
    .limit(1);
  if (!row) return 'allow';
  const own = readDerivationPolicy(row.payload);
  const parent = readDerivationPolicy(row.rootPayload);
  const doc = readDerivationPolicy(
    typeof row.docProvenance === 'object' && row.docProvenance !== null
      ? (row.docProvenance as Record<string, unknown>).usage_policy
      : undefined,
  );
  // Strictest wins: own > causal root > document. An event's own restricted
  // mark is never overridden by a permissive document.
  if (own !== 'allow') return own;
  if (parent !== 'allow') return parent;
  if (doc !== 'allow') return doc;
  return 'allow';
}

/** Apply before LIMIT. Raw user chat readers deliberately do not use this predicate. */
export function eventAllowsDerivationSql(
  row: { payload: SQLWrapper; caused_by_event_id: SQLWrapper; session_id: SQLWrapper } = event,
) {
  return and(
    sql`coalesce(${row.payload}->>'derivation_policy', 'allow') = 'allow'`,
    sql`NOT EXISTS (SELECT 1 FROM event derivation_root
      WHERE derivation_root.id = ${row.caused_by_event_id}
        AND coalesce(derivation_root.payload->>'derivation_policy', 'allow') <> 'allow')`,
    // Same live document policy as the row reader.
    sql`NOT EXISTS (SELECT 1 FROM learning_session usage_session
      JOIN source_document usage_doc ON usage_doc.id = usage_session.source_document_id
      WHERE usage_session.id = ${row.session_id}
        AND coalesce(usage_doc.provenance->'usage_policy'->>'derivation_policy', 'allow') <> 'allow')`,
  );
}
