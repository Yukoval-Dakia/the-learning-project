// Ingestion usage policy. Consent lives in source_document.provenance.usage_policy
// (no new column). Events inherit the document's derivation policy at write time, so
// the existing derivation filter withholds them when consent is withdrawn.
//
// A document without a policy resolves to 'allow' (legacy behavior).

import { type SQL, type SQLWrapper, eq, sql } from 'drizzle-orm';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { learning_session, source_document } from '@/db/schema';
import { ingestionQuestionSourceListSql } from './admission-source';

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

// `document`/`session` are first-class node kinds in the purpose lineage (and
// the generated `tlp_source_allows_derivation` predicate) even though most
// callers only bind the three item kinds; the shared predicates handle all
// five and fail closed on anything else.
export type PurposeSource = {
  kind: 'question' | 'record' | 'event' | 'document' | 'session';
  id: string | SQLWrapper;
};

const PURPOSE_EDGES_SQL = sql`
      SELECT v.kind, v.id FROM question q
      CROSS JOIN LATERAL (VALUES
        ('document', q.metadata->>'source_document_id'),
        ('document', q.metadata->'quiz_gen'->>'material_source_document_id'),
        ('session', q.metadata->>'ingestion_session_id'),
        ('record', q.metadata->>'source_record_id'),
        ('question', q.parent_question_id), ('question', q.parent_variant_id),
        ('question', NULLIF(q.root_question_id, q.id)),
        ('event', q.metadata->>'source_attempt_event_id'),
        ('event', CASE WHEN q.source = 'dreaming' THEN q.source_ref END)
      ) v(kind, id) WHERE n.kind = 'question' AND q.id = n.id
      UNION ALL
      SELECT v.kind, v.id FROM learning_record r
      CROSS JOIN LATERAL (VALUES
        ('document', r.source_document_id), ('question', r.question_id),
        ('event', r.origin_event_id), ('event', r.attempt_event_id)
      ) v(kind, id) WHERE n.kind = 'record' AND r.id = n.id
      UNION ALL
      SELECT v.kind, v.id FROM event e
      LEFT JOIN event b ON b.id = 'ingestion-usage:' || e.id
        AND b.action = 'experimental:ingestion_usage_binding'
        AND b.actor_kind = 'system' AND b.actor_ref = 'ingestion-usage'
      CROSS JOIN LATERAL (VALUES
        ('event', e.caused_by_event_id), ('session', e.session_id),
        ('question', CASE WHEN e.subject_kind = 'question' THEN e.subject_id END),
        ('question', CASE WHEN e.action = 'experimental:copilot_user_ask' THEN e.payload->'draft_focus'->>'question_id' END),
        ('record', CASE WHEN e.subject_kind = 'record' THEN e.subject_id END),
        ('document', CASE WHEN e.subject_kind = 'source_document' THEN e.subject_id END),
        ('event', CASE WHEN e.subject_kind = 'event' THEN e.subject_id END),
        ('record', CASE WHEN COALESCE(e.payload->'ai_proposal'->>'kind', CASE WHEN e.action = 'experimental:proposal' THEN e.payload->>'kind' END) = 'record_promotion'
          THEN COALESCE(e.payload->'ai_proposal', e.payload)->'proposed_change'->>'record_id' END),
        ('question', CASE WHEN COALESCE(e.payload->'ai_proposal'->>'kind', CASE WHEN e.action = 'experimental:proposal' THEN e.payload->>'kind' END) = 'variant_question'
          THEN COALESCE(e.payload->'ai_proposal', e.payload)->'proposed_change'->>'source_question_id' END),
        ('document', b.payload->>'document_id')
      ) v(kind, id) WHERE n.kind = 'event' AND e.id = n.id
      UNION ALL
      SELECT 'event', ref #>> '{}' FROM event reply
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(reply.payload->'history_read_set'->'event_ids') = 'array'
        THEN reply.payload->'history_read_set'->'event_ids' ELSE '[]'::jsonb END) ref
      WHERE n.kind = 'event' AND reply.id = n.id AND reply.action = 'experimental:copilot_reply'
      UNION ALL
      SELECT 'document', epoch.key FROM event ask
      CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(ask.payload->'draft_focus'->'source_usage_epochs') = 'object'
        THEN ask.payload->'draft_focus'->'source_usage_epochs' ELSE '{}'::jsonb END) epoch
      WHERE n.kind = 'event' AND ask.id = n.id AND ask.action = 'experimental:copilot_user_ask'
      UNION ALL
      SELECT CASE ref->>'kind' WHEN 'source_document' THEN 'document' ELSE ref->>'kind' END,
        ref->>'id' FROM event note
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(note.payload->'refs') = 'array'
        THEN note.payload->'refs' ELSE '[]'::jsonb END) ref
      WHERE n.kind = 'event' AND note.id = n.id AND note.action = 'experimental:agent_note'
        AND ref->>'kind' IN ('source_document', 'question', 'record', 'event')
      UNION ALL
      SELECT 'document', s.source_document_id FROM learning_session s
      WHERE n.kind = 'session' AND s.id = n.id
`;

/** Exact provenance closure, including legacy promotion proposals. UNION bounds cycles;
 * every referenced row participates, so a second restricted source cannot be hidden.
 * The seed is parameterised so the scoped global veto walks the IDENTICAL edge
 * closure and node checks — a dangling reference becomes a node and fails its
 * own existence check exactly the way a bound-source traversal fails it.
 */
function purposeLineageSeeded(seed: SQL) {
  return sql`WITH RECURSIVE purpose_lineage(kind, id) AS (
    ${seed}
    UNION
    SELECT edge.kind, edge.id FROM purpose_lineage n
    CROSS JOIN LATERAL (${PURPOSE_EDGES_SQL}) edge WHERE edge.id IS NOT NULL
  )`;
}

function purposeLineage(source: {
  kind: PurposeSource['kind'] | SQLWrapper;
  id: string | SQLWrapper;
}) {
  return purposeLineageSeeded(sql`SELECT ${source.kind}::text, ${source.id}::text`);
}

function purposeLineageSources(sources: readonly PurposeSource[]) {
  return purposeLineageSeeded(sql`
    SELECT v.kind, v.id FROM (VALUES ${sql.join(
      sources.map((s) => sql`(${s.kind}::text, ${s.id}::text)`),
      sql`, `,
    )}) AS v(kind, id)`);
}

/** Per-node authorization check shared by the bound predicate and the global
 * scoped veto. A node fails when its row is absent (dangling reference) or its
 * own row violates — identical semantics in both callers. */
const NODE_VIOLATION_SQL = sql`CASE n.kind
      WHEN 'document' THEN NOT EXISTS (
        SELECT 1 FROM source_document d WHERE d.id = n.id AND NOT coalesce((
          (d.provenance ? 'usage_policy' AND jsonb_typeof(d.provenance->'usage_policy') IS DISTINCT FROM 'object')
          OR (d.provenance->'usage_policy' ? 'derivation_policy'
            AND d.provenance->'usage_policy'->>'derivation_policy' IS DISTINCT FROM 'allow')
          OR (d.provenance ? 'usage_epoch' AND (jsonb_typeof(d.provenance->'usage_epoch') IS DISTINCT FROM 'string'
            OR d.provenance->>'usage_epoch' = ''))
        ), false) OFFSET 0)
      WHEN 'session' THEN NOT EXISTS (
        SELECT 1 FROM learning_session s WHERE s.id = n.id
          AND NOT (s.type = 'ingestion' AND s.source_document_id IS NULL) OFFSET 0)
      WHEN 'question' THEN NOT EXISTS (
        SELECT 1 FROM question q WHERE q.id = n.id AND NOT coalesce((
          (q.metadata ? 'source_usage_epochs' AND (
            jsonb_typeof(q.metadata->'source_usage_epochs') IS DISTINCT FROM 'object'
            OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(q.metadata->'source_usage_epochs') = 'object'
              THEN q.metadata->'source_usage_epochs' ELSE '{}'::jsonb END) epoch
              LEFT JOIN source_document bound_doc ON bound_doc.id = epoch.key
              WHERE bound_doc.id IS NULL OR epoch.value IS DISTINCT FROM coalesce(bound_doc.provenance->>'usage_epoch', 'legacy'))))
          OR (q.metadata ? 'derivation_policy' AND q.metadata->>'derivation_policy' IS DISTINCT FROM 'allow')
          OR (q.metadata ? 'source_document_id' AND q.metadata->>'source_document_id' IS NULL)
          OR (q.metadata->'quiz_gen' ? 'material_source_document_id' AND (
            jsonb_typeof(q.metadata->'quiz_gen'->'material_source_document_id') IS DISTINCT FROM 'string'
            OR length(q.metadata->'quiz_gen'->>'material_source_document_id') = 0))
          OR (q.metadata ? 'source_record_id' AND q.metadata->>'source_record_id' IS NULL)
          OR (q.source IN ${ingestionQuestionSourceListSql()}
            AND COALESCE(q.metadata->>'source_document_id', q.metadata->>'ingestion_session_id') IS NULL)
          OR (q.source = 'dreaming' AND q.metadata->>'source_record_id' IS NULL AND NOT EXISTS (
            SELECT 1 FROM event promotion WHERE promotion.id = q.source_ref
              AND promotion.action = 'experimental:proposal' AND COALESCE(promotion.payload->'ai_proposal', promotion.payload)->>'kind' = 'record_promotion'
              AND COALESCE(promotion.payload->'ai_proposal', promotion.payload)->'proposed_change'->>'record_id' IS NOT NULL))
          OR (q.source = 'mistake_variant' AND COALESCE(q.parent_variant_id, q.root_question_id) IS NULL)
        ), false) OFFSET 0)
      WHEN 'record' THEN NOT EXISTS (
        SELECT 1 FROM learning_record r WHERE r.id = n.id AND NOT coalesce((
          (r.payload ? 'derivation_policy' AND r.payload->>'derivation_policy' IS DISTINCT FROM 'allow')
          OR COALESCE(r.source_document_id, r.question_id, r.origin_event_id, r.attempt_event_id) IS NULL
        ), false) OFFSET 0)
      WHEN 'event' THEN NOT EXISTS (
        SELECT 1 FROM event e
        LEFT JOIN event b ON b.id = 'ingestion-usage:' || e.id
          AND b.action = 'experimental:ingestion_usage_binding'
          AND b.actor_kind = 'system' AND b.actor_ref = 'ingestion-usage'
        LEFT JOIN learning_session es ON es.id = e.session_id
        LEFT JOIN source_document ed ON ed.id = COALESCE(b.payload->>'document_id', es.source_document_id)
        WHERE e.id = n.id AND NOT coalesce((
          (e.action = 'experimental:agent_note' AND (
            (e.caused_by_event_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'refs') = 'array'
                THEN e.payload->'refs' ELSE '[]'::jsonb END) ref
              WHERE ref->>'kind' IN ('source_document', 'question', 'record', 'event') AND length(ref->>'id') > 0))
            OR (e.payload ? 'refs' AND jsonb_typeof(e.payload->'refs') IS DISTINCT FROM 'array')
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'refs') = 'array'
                THEN e.payload->'refs' ELSE '[]'::jsonb END) ref
              WHERE NOT coalesce(ref->>'kind' IN ('source_document', 'question', 'record', 'event', 'knowledge'), false)
                OR jsonb_typeof(ref->'id') IS DISTINCT FROM 'string' OR length(ref->>'id') = 0)))
          OR (e.payload ? 'derivation_policy' AND e.payload->>'derivation_policy' IS DISTINCT FROM 'allow')
          OR (e.action = 'experimental:copilot_reply' AND (
            ((e.payload ? 'history_read_set' OR e.task_run_id IS NOT NULL OR EXISTS (
              SELECT 1 FROM job_events j WHERE j.business_table = 'copilot_run' AND j.business_id = e.caused_by_event_id
                AND j.event_type IN ('copilot_run.execution_started', 'copilot_run.step', 'copilot_run.delta')))
              AND (jsonb_typeof(e.payload->'history_read_set') IS DISTINCT FROM 'object'
                OR e.payload->'history_read_set'->'version' IS DISTINCT FROM '1'::jsonb
                OR jsonb_typeof(e.payload->'history_read_set'->'event_ids') IS DISTINCT FROM 'array'))
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'history_read_set'->'event_ids') = 'array'
              THEN e.payload->'history_read_set'->'event_ids' ELSE '[]'::jsonb END) ref
              WHERE jsonb_typeof(ref) IS DISTINCT FROM 'string' OR length(btrim(ref #>> '{}')) = 0
                OR ref #>> '{}' IN (e.id, e.caused_by_event_id))
            OR EXISTS (WITH RECURSIVE history_ancestors(id) AS (
              SELECT ref #>> '{}' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'history_read_set'->'event_ids') = 'array'
                THEN e.payload->'history_read_set'->'event_ids' ELSE '[]'::jsonb END) ref
              UNION
              SELECT ref #>> '{}' FROM history_ancestors h JOIN event parent ON parent.id = h.id
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(parent.payload->'history_read_set'->'event_ids') = 'array'
                THEN parent.payload->'history_read_set'->'event_ids' ELSE '[]'::jsonb END) ref
            ) SELECT 1 FROM history_ancestors h WHERE h.id = e.id)))
          OR (e.action = 'experimental:copilot_user_ask' AND e.payload ? 'draft_focus' AND (
            jsonb_typeof(e.payload->'draft_focus'->'source_usage_epochs') IS DISTINCT FROM 'object'
            OR e.payload->'draft_focus'->'source_usage_epochs' = '{}'::jsonb
            OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(e.payload->'draft_focus'->'source_usage_epochs') = 'object'
              THEN e.payload->'draft_focus'->'source_usage_epochs' ELSE '{}'::jsonb END) epoch
              LEFT JOIN source_document bound_doc ON bound_doc.id = epoch.key
              WHERE bound_doc.id IS NULL OR epoch.value IS DISTINCT FROM coalesce(bound_doc.provenance->>'usage_epoch', 'legacy'))))
          OR (b.id IS NOT NULL AND (b.payload->>'source_policy' IS DISTINCT FROM 'allow'
            OR NOT (b.payload ?& ARRAY['document_id', 'epoch', 'source_policy'])))
          OR (ed.id IS NOT NULL AND coalesce(b.payload->>'epoch', 'legacy') <> coalesce(ed.provenance->>'usage_epoch', 'legacy'))
          OR (COALESCE(e.payload->'ai_proposal'->>'kind', CASE WHEN e.action = 'experimental:proposal' THEN e.payload->>'kind' END) = 'record_promotion' AND COALESCE(e.payload->'ai_proposal', e.payload)->'proposed_change'->>'record_id' IS NULL)
        ), false) OFFSET 0)
      ELSE true END`;

/** Restriction and malformed policies veto before provenance can authorize use.
 * Standalone authored questions remain valid; ingestion/derived rows need evidence.
 * OFFSET 0 keeps node checks correlated: hashed EXISTS plans scan every source
 * table once per authorization call instead of looking up the referenced ids.
 */
function sourceDerivationPredicateSql(source: {
  kind: PurposeSource['kind'] | SQLWrapper;
  id: string | SQLWrapper;
}) {
  return sql`NOT EXISTS (${purposeLineage(source)}
    SELECT 1 FROM purpose_lineage n WHERE ${NODE_VIOLATION_SQL})`;
}

/**
 * Scoped-scope verdict (the whole-learner projection, e.g. the Copilot state
 * header): any row in the four non-event source tables whose own check fails,
 * OR that references a row which does not exist (a dangling edge is a
 * provenance hole regardless of target kind — bound traversals fail the same
 * node). Event rows are deliberately NOT inspected: normal system writers
 * stamp `derivation_policy='answer_only'` on hundreds of routine events, and
 * event sources the header could have touched are already filtered at read
 * time (allowedEventIds et al) — an event-table veto would refuse every turn
 * for rows the projection never read.
 */
export async function anyRestrictedLearnerSource(db: Db | Tx): Promise<boolean> {
  const rows = await db.execute<{ restricted: boolean }>(sql`SELECT (
    EXISTS (SELECT 1 FROM source_document d WHERE coalesce((
      (d.provenance ? 'usage_policy' AND jsonb_typeof(d.provenance->'usage_policy') IS DISTINCT FROM 'object')
      OR (d.provenance->'usage_policy' ? 'derivation_policy'
        AND d.provenance->'usage_policy'->>'derivation_policy' IS DISTINCT FROM 'allow')
      OR (d.provenance ? 'usage_epoch' AND (jsonb_typeof(d.provenance->'usage_epoch') IS DISTINCT FROM 'string'
        OR d.provenance->>'usage_epoch' = ''))
    ), false))
    OR EXISTS (SELECT 1 FROM learning_session s WHERE coalesce((
      (s.type = 'ingestion' AND s.source_document_id IS NULL)
      OR (s.source_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM source_document sd WHERE sd.id = s.source_document_id))
    ), false))
    OR EXISTS (SELECT 1 FROM question q WHERE coalesce((
      (q.metadata ? 'source_usage_epochs' AND (
        jsonb_typeof(q.metadata->'source_usage_epochs') IS DISTINCT FROM 'object'
        OR EXISTS (SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(q.metadata->'source_usage_epochs') = 'object'
          THEN q.metadata->'source_usage_epochs' ELSE '{}'::jsonb END) epoch
          LEFT JOIN source_document bound_doc ON bound_doc.id = epoch.key
          WHERE bound_doc.id IS NULL OR epoch.value IS DISTINCT FROM coalesce(bound_doc.provenance->>'usage_epoch', 'legacy'))))
      OR (q.metadata ? 'derivation_policy' AND q.metadata->>'derivation_policy' IS DISTINCT FROM 'allow')
      OR (q.metadata ? 'source_document_id' AND q.metadata->>'source_document_id' IS NULL)
      OR (q.metadata->'quiz_gen' ? 'material_source_document_id' AND (
        jsonb_typeof(q.metadata->'quiz_gen'->'material_source_document_id') IS DISTINCT FROM 'string'
        OR length(q.metadata->'quiz_gen'->>'material_source_document_id') = 0))
      OR (q.metadata ? 'source_record_id' AND q.metadata->>'source_record_id' IS NULL)
      OR (q.source IN ${ingestionQuestionSourceListSql()}
        AND COALESCE(q.metadata->>'source_document_id', q.metadata->>'ingestion_session_id') IS NULL)
      OR (q.source = 'dreaming' AND q.metadata->>'source_record_id' IS NULL AND NOT EXISTS (
        SELECT 1 FROM event promotion WHERE promotion.id = q.source_ref
          AND promotion.action = 'experimental:proposal' AND COALESCE(promotion.payload->'ai_proposal', promotion.payload)->>'kind' = 'record_promotion'
          AND COALESCE(promotion.payload->'ai_proposal', promotion.payload)->'proposed_change'->>'record_id' IS NOT NULL))
      OR (q.source = 'mistake_variant' AND COALESCE(q.parent_variant_id, q.root_question_id) IS NULL)
      OR (q.metadata->>'source_document_id' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM source_document sd WHERE sd.id = q.metadata->>'source_document_id'))
      OR (q.metadata->'quiz_gen'->>'material_source_document_id' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM source_document md WHERE md.id = q.metadata->'quiz_gen'->>'material_source_document_id'))
      OR (q.metadata->>'ingestion_session_id' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM learning_session isess WHERE isess.id = q.metadata->>'ingestion_session_id'))
      OR (q.metadata->>'source_record_id' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM learning_record sr WHERE sr.id = q.metadata->>'source_record_id'))
      OR (q.parent_question_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM question pq WHERE pq.id = q.parent_question_id))
      OR (q.parent_variant_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM question pv WHERE pv.id = q.parent_variant_id))
      OR (NULLIF(q.root_question_id, q.id) IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM question rq WHERE rq.id = q.root_question_id))
      OR (q.metadata->>'source_attempt_event_id' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM event ae WHERE ae.id = q.metadata->>'source_attempt_event_id'))
      OR (q.source = 'dreaming' AND q.source_ref IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM event de WHERE de.id = q.source_ref))
    ), false) OFFSET 0)
    OR EXISTS (SELECT 1 FROM learning_record r WHERE coalesce((
      (r.payload ? 'derivation_policy' AND r.payload->>'derivation_policy' IS DISTINCT FROM 'allow')
      OR COALESCE(r.source_document_id, r.question_id, r.origin_event_id, r.attempt_event_id) IS NULL
      OR (r.source_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM source_document rd WHERE rd.id = r.source_document_id))
      OR (r.question_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM question rq2 WHERE rq2.id = r.question_id))
      OR (r.origin_event_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM event oe WHERE oe.id = r.origin_event_id))
      OR (r.attempt_event_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM event ae2 WHERE ae2.id = r.attempt_event_id))
    ), false) OFFSET 0)
  ) AS restricted`);
  return rows[0]?.restricted === true;
}

/**
 * Every question id in the provenance closure of the bound sources — the
 * answer-leak gate must consider questions the model could have reached
 * through a bound event/record/session, not only the top-level question nodes.
 */
export async function lineageQuestionIds(
  db: Db | Tx,
  sources: readonly PurposeSource[],
): Promise<string[]> {
  if (sources.length === 0) return [];
  const rows = await db.execute<{ id: string }>(sql`${purposeLineageSources(sources)}
    SELECT DISTINCT n.id FROM purpose_lineage n
    JOIN question q ON q.id = n.id WHERE n.kind = 'question'`);
  return rows.map((row) => row.id);
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

export function sourceHasCrisisSql(source: PurposeSource) {
  return sql`EXISTS (${purposeLineage(source)} SELECT 1 FROM purpose_lineage n
    LEFT JOIN source_document d ON n.kind = 'document' AND d.id = n.id
    LEFT JOIN event e ON n.kind = 'event' AND e.id = n.id
    LEFT JOIN question q ON n.kind = 'question' AND q.id = n.id
    LEFT JOIN learning_record r ON n.kind = 'record' AND r.id = n.id
    WHERE d.provenance->'usage_policy'->>'derivation_policy' = 'crisis'
      OR e.payload->>'derivation_policy' = 'crisis'
      OR q.metadata->>'derivation_policy' = 'crisis'
      OR r.payload->>'derivation_policy' = 'crisis')`;
}

export function sourceBelongsToDocumentSql(source: PurposeSource, documentId: string | SQLWrapper) {
  return sql`EXISTS (${purposeLineage(source)} SELECT 1 FROM purpose_lineage
    WHERE kind = 'document' AND id = ${documentId})`;
}

/** Bank callers receive only an authorization bit, never private source rows. */
export async function allowedQuestionIds(
  db: Db | Tx,
  ids: readonly string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.execute<{ id: string }>(sql`
    SELECT question_id AS id FROM public.tlp_allowed_question_ids(ARRAY[${sql.join(
      [...new Set(ids)].map((id) => sql`${id}`),
      sql`, `,
    )}]::text[])
  `);
  return new Set(rows.map((row) => row.id));
}

export function sourceAllowsDerivationSql(source: PurposeSource): SQL {
  return source.kind === 'question'
    ? sql<boolean>`public.tlp_question_allows_derivation(${source.id}::text)`
    : sql<boolean>`public.tlp_source_allows_derivation(${source.kind}::text, ${source.id}::text)`;
}

/** Migration generator and runtime predicates share this sole policy definition. */
export function sourceDerivationFunctionDefinitionsSql() {
  return sql`CREATE OR REPLACE FUNCTION public.tlp_source_allows_derivation(purpose_kind text, purpose_id text)
RETURNS boolean LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp SET jit = off AS $purpose$
SELECT ${sourceDerivationPredicateSql({ kind: sql.raw('purpose_kind'), id: sql.raw('purpose_id') })};
$purpose$;
REVOKE ALL ON FUNCTION public.tlp_source_allows_derivation(text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.tlp_question_allows_derivation(question_id text)
RETURNS boolean LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp SET jit = off AS $purpose$
SELECT public.tlp_source_allows_derivation('question', question_id);
$purpose$;
REVOKE ALL ON FUNCTION public.tlp_question_allows_derivation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tlp_question_allows_derivation(text) TO PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.tlp_allowed_question_ids(question_ids text[])
RETURNS TABLE(question_id text) LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp SET jit = off AS $purpose$
WITH RECURSIVE purpose_lineage(root_id, kind, id) AS (
  SELECT DISTINCT id, 'question'::text, id FROM unnest(question_ids) seed(id) WHERE id IS NOT NULL
  UNION
  SELECT n.root_id, edge.kind, edge.id FROM purpose_lineage n
  CROSS JOIN LATERAL (${PURPOSE_EDGES_SQL}) edge WHERE edge.id IS NOT NULL
), node_verdicts AS MATERIALIZED (
  SELECT n.kind, n.id, ${NODE_VIOLATION_SQL} AS denied
  FROM (SELECT DISTINCT kind, id FROM purpose_lineage) n
)
SELECT DISTINCT seed.id FROM unnest(question_ids) seed(id)
WHERE seed.id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM purpose_lineage l JOIN node_verdicts v USING(kind, id)
  WHERE l.root_id = seed.id AND v.denied
);
$purpose$;
REVOKE ALL ON FUNCTION public.tlp_allowed_question_ids(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tlp_allowed_question_ids(text[]) TO PUBLIC;`;
}
