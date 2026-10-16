import { type SQLWrapper, and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { event, learning_session, source_document } from '@/db/schema';

/** Copilot replies and mirrors inherit their accepted causal root, even without a session. */
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
    // YUK-1408 — an ingestion-derived event also inherits the LIVE usage policy
    // on its session's source_document (provenance.usage_policy, written by the
    // ingestion owner — see kernel/read-models/usage-policy.ts). The join keeps
    // consent withdrawal retroactive: flipping the document's policy after
    // events were written still excludes them, no event-payload mutation needed.
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
  // YUK-1398 + YUK-1408 — strictest wins, value-agnostic. An event-level
  // 'crisis' is never overridden by a document-level allow; a document-level
  // 'answer_only' applies when own and parent are allow. Order: own > parent >
  // doc — an event's own restricted mark propagates over its causal root's.
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
    // YUK-1408 — session-bound events additionally honor the LIVE usage policy
    // on their session's source_document so a consent withdrawal (flipping
    // provenance.usage_policy) stops later derivation reads without mutating
    // already-written event payloads. 'usage_policy' is the provenance key the
    // ingestion owner writes (src/kernel/read-models/usage-policy.ts).
    sql`NOT EXISTS (SELECT 1 FROM learning_session usage_session
      JOIN source_document usage_doc ON usage_doc.id = usage_session.source_document_id
      WHERE usage_session.id = ${row.session_id}
        AND coalesce(usage_doc.provenance->'usage_policy'->>'derivation_policy', 'allow') <> 'allow')`,
  );
}
