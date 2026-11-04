// Ingestion usage policy. Consent lives in source_document.provenance.usage_policy
// (no new column). Events inherit the document's derivation policy at write time, so
// the existing derivation filter withholds them when consent is withdrawn.
//
// A document without a policy resolves to 'allow' (legacy behavior).

import { type SQLWrapper, eq, sql } from 'drizzle-orm';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { learning_session, source_document } from '@/db/schema';

/** `source_document.provenance` key holding the learner's consented usage. */
export const USAGE_POLICY_PROVENANCE_KEY = 'usage_policy';

/** Immutable source binding on newly written events. Legacy is a real generation. */
export function documentUsageEpoch(provenance: unknown): string {
  const value = (provenance as Record<string, unknown> | null)?.usage_epoch;
  if (value === undefined) return 'legacy';
  if (typeof value !== 'string' || !value) throw new Error('invalid document usage epoch');
  return value;
}

/** Read the consented usage off a source_document provenance blob. */
export function readDocumentDerivationPolicy(provenance: unknown): DerivationPolicyT {
  const record =
    typeof provenance === 'object' && provenance !== null
      ? (provenance as Record<string, unknown>)[USAGE_POLICY_PROVENANCE_KEY]
      : undefined;
  return readDerivationPolicy(record);
}

/** Resolve the usage policy for an ingestion session's source document. */
export async function resolveSessionDerivationPolicy(
  db: Db | Tx,
  sessionId: string,
): Promise<DerivationPolicyT> {
  const [row] = await db
    .select({ provenance: source_document.provenance })
    .from(learning_session)
    .innerJoin(source_document, eq(source_document.id, learning_session.source_document_id))
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  return row ? readDocumentDerivationPolicy(row.provenance) : 'allow';
}

/** Resolve the usage policy directly off a source_document id. */
export async function resolveDocumentDerivationPolicy(
  db: Db | Tx,
  sourceDocumentId: string,
): Promise<DerivationPolicyT> {
  const [row] = await db
    .select({ provenance: source_document.provenance })
    .from(source_document)
    .where(eq(source_document.id, sourceDocumentId))
    .limit(1);
  return row ? readDocumentDerivationPolicy(row.provenance) : 'allow';
}

export interface DocumentUsage {
  policy: DerivationPolicyT;
  /**
   * Bound ingestion session. Events carrying it inherit the live document policy,
   * so consent withdrawal reaches them without payload mutation.
   */
  sessionId: string | null;
}

/** Resolve both the policy and the bound ingestion session for a document. */
export async function resolveDocumentUsage(
  db: Db | Tx,
  sourceDocumentId: string,
): Promise<DocumentUsage> {
  const [row] = await db
    .select({
      provenance: source_document.provenance,
      sessionId: learning_session.id,
    })
    .from(source_document)
    .leftJoin(learning_session, eq(learning_session.source_document_id, source_document.id))
    .where(eq(source_document.id, sourceDocumentId))
    .limit(1);
  return {
    policy: row ? readDocumentDerivationPolicy(row.provenance) : 'allow',
    sessionId: row?.sessionId ?? null,
  };
}

export type PurposeSource = { kind: 'question' | 'record' | 'event'; id: string | SQLWrapper };

/** Exact provenance closure, including legacy promotion proposals. UNION bounds cycles;
 * every referenced row participates, so a second restricted source cannot be hidden.
 */
function purposeLineage(source: PurposeSource) {
  return sql`WITH RECURSIVE purpose_lineage(kind, id) AS (
    SELECT ${source.kind}::text, ${source.id}::text
    UNION
    SELECT edge.kind, edge.id FROM purpose_lineage n
    LEFT JOIN question q ON n.kind = 'question' AND q.id = n.id
    LEFT JOIN learning_record r ON n.kind = 'record' AND r.id = n.id
    LEFT JOIN event e ON n.kind = 'event' AND e.id = n.id
    LEFT JOIN learning_session s ON n.kind = 'session' AND s.id = n.id
    LEFT JOIN event b ON b.id = 'ingestion-usage:' || e.id
      AND b.action = 'experimental:ingestion_usage_binding'
      AND b.actor_kind = 'system' AND b.actor_ref = 'ingestion-usage'
    CROSS JOIN LATERAL (VALUES
      ('document', q.metadata->>'source_document_id'),
      ('session', q.metadata->>'ingestion_session_id'),
      ('record', q.metadata->>'source_record_id'),
      ('question', q.parent_question_id),
      ('question', q.parent_variant_id),
      ('question', NULLIF(q.root_question_id, q.id)),
      ('event', q.metadata->>'source_attempt_event_id'),
      ('event', CASE WHEN q.source = 'dreaming' THEN q.source_ref END),
      ('document', r.source_document_id), ('question', r.question_id),
      ('event', r.origin_event_id), ('event', r.attempt_event_id),
      ('event', e.caused_by_event_id), ('session', e.session_id),
      ('question', CASE WHEN e.subject_kind = 'question' THEN e.subject_id END),
      ('record', CASE WHEN e.subject_kind = 'record' THEN e.subject_id END),
      ('document', CASE WHEN e.subject_kind = 'source_document' THEN e.subject_id END),
      ('event', CASE WHEN e.subject_kind = 'event' THEN e.subject_id END),
      ('record', CASE WHEN e.payload->>'kind' = 'record_promotion'
        THEN e.payload->'proposed_change'->>'record_id' END),
      ('question', CASE WHEN e.payload->>'kind' = 'variant_question'
        THEN e.payload->'proposed_change'->>'source_question_id' END),
      ('document', b.payload->>'document_id'),
      ('document', s.source_document_id)
    ) edge(kind, id) WHERE edge.id IS NOT NULL
  )`;
}

/** Restriction and malformed policies veto before provenance can authorize use.
 * Standalone authored questions remain valid; ingestion/derived rows need evidence.
 */
export function sourceAllowsDerivationSql(source: PurposeSource) {
  return sql`NOT EXISTS (${purposeLineage(source)}
    SELECT 1 FROM purpose_lineage n
    LEFT JOIN question q ON n.kind = 'question' AND q.id = n.id
    LEFT JOIN learning_record r ON n.kind = 'record' AND r.id = n.id
    LEFT JOIN event e ON n.kind = 'event' AND e.id = n.id
    LEFT JOIN learning_session s ON n.kind = 'session' AND s.id = n.id
    LEFT JOIN source_document d ON n.kind = 'document' AND d.id = n.id
    LEFT JOIN event b ON b.id = 'ingestion-usage:' || e.id
      AND b.action = 'experimental:ingestion_usage_binding'
      AND b.actor_kind = 'system' AND b.actor_ref = 'ingestion-usage'
    LEFT JOIN learning_session es ON es.id = e.session_id
    LEFT JOIN source_document ed ON ed.id = COALESCE(b.payload->>'document_id', es.source_document_id)
    WHERE
      (n.kind = 'document' AND (d.id IS NULL
        OR (d.provenance ? 'usage_policy' AND jsonb_typeof(d.provenance->'usage_policy') IS DISTINCT FROM 'object')
        OR (d.provenance->'usage_policy' ? 'derivation_policy'
          AND d.provenance->'usage_policy'->>'derivation_policy' IS DISTINCT FROM 'allow')
        OR (d.provenance ? 'usage_epoch' AND (jsonb_typeof(d.provenance->'usage_epoch') IS DISTINCT FROM 'string' OR d.provenance->>'usage_epoch' = ''))))
      OR (n.kind = 'session' AND (s.id IS NULL OR (s.type = 'ingestion' AND s.source_document_id IS NULL)))
      OR (n.kind = 'question' AND (q.id IS NULL
        OR (q.metadata ? 'source_usage_epochs' AND (
          jsonb_typeof(q.metadata->'source_usage_epochs') IS DISTINCT FROM 'object'
          OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(q.metadata->'source_usage_epochs') = 'object'
            THEN q.metadata->'source_usage_epochs' ELSE '{}'::jsonb END) epoch
            LEFT JOIN source_document bound_doc ON bound_doc.id = epoch.key
            WHERE bound_doc.id IS NULL OR epoch.value IS DISTINCT FROM coalesce(bound_doc.provenance->>'usage_epoch', 'legacy'))))
        OR (q.metadata ? 'derivation_policy' AND q.metadata->>'derivation_policy' IS DISTINCT FROM 'allow')
        OR ((q.metadata ? 'source_document_id' AND q.metadata->>'source_document_id' IS NULL)
          OR (q.metadata ? 'source_record_id' AND q.metadata->>'source_record_id' IS NULL))
        OR (q.source IN ('ingestion', 'photo', 'pdf', 'docx', 'camera', 'import', 'vision_single', 'vision_paper', 'reverse_mark')
          AND COALESCE(q.metadata->>'source_document_id', q.metadata->>'ingestion_session_id') IS NULL)
        OR (q.source = 'dreaming' AND q.metadata->>'source_record_id' IS NULL AND NOT EXISTS (
          SELECT 1 FROM event promotion WHERE promotion.id = q.source_ref
            AND promotion.action = 'propose' AND promotion.payload->>'kind' = 'record_promotion'
            AND promotion.payload->'proposed_change'->>'record_id' IS NOT NULL))
        OR (q.source = 'mistake_variant' AND COALESCE(q.parent_variant_id, q.root_question_id) IS NULL)))
      OR (n.kind = 'record' AND (r.id IS NULL
        OR (r.payload ? 'derivation_policy' AND r.payload->>'derivation_policy' IS DISTINCT FROM 'allow')
        OR COALESCE(r.source_document_id, r.question_id, r.origin_event_id, r.attempt_event_id) IS NULL))
      OR (n.kind = 'event' AND (e.id IS NULL
        OR (e.payload ? 'derivation_policy' AND e.payload->>'derivation_policy' IS DISTINCT FROM 'allow')
        OR (b.id IS NOT NULL AND (b.payload->>'source_policy' IS DISTINCT FROM 'allow'
          OR NOT (b.payload ?& ARRAY['document_id', 'epoch', 'source_policy'])))
        OR (ed.id IS NOT NULL AND coalesce(b.payload->>'epoch', 'legacy') <> coalesce(ed.provenance->>'usage_epoch', 'legacy'))
        OR (e.payload->>'kind' = 'record_promotion' AND e.payload->'proposed_change'->>'record_id' IS NULL)))
  )`;
}

export async function sourceAllowsDerivation(db: Db | Tx, source: PurposeSource): Promise<boolean> {
  const rows = await db.execute<{ allowed: boolean }>(
    sql`SELECT ${sourceAllowsDerivationSql(source)} AS allowed`,
  );
  return rows[0]?.allowed === true;
}

/** Accept/serve locks documents in stable order, then reads the live policy again.
 * The purpose writer updates these same rows; no provider IO belongs in this lock.
 */
export async function lockDerivationSources(tx: Tx, source: PurposeSource): Promise<void> {
  await tx.execute(sql`${purposeLineage(source)} SELECT d.id FROM source_document d
    WHERE d.id IN (SELECT id FROM purpose_lineage WHERE kind = 'document')
    ORDER BY d.id FOR SHARE`);
}

/** Frozen generations preserve withdrawal even when the live policy later relaxes. */
export async function readSourceUsageEpochs(
  db: Db | Tx,
  source: PurposeSource,
): Promise<Record<string, string>> {
  const rows = await db.execute<{ id: string; provenance: unknown }>(sql`${purposeLineage(source)}
    SELECT d.id, d.provenance FROM source_document d
    WHERE d.id IN (SELECT id FROM purpose_lineage WHERE kind = 'document')`);
  return Object.fromEntries(rows.map((row) => [row.id, documentUsageEpoch(row.provenance)]));
}
