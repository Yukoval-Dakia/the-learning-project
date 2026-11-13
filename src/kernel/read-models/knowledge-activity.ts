// the learner-event knowledge activity clock, derived from the event
// spine (max created_at over events touching the node). Single owner of that
// formula. Read-time derivation only: no view, no new table.

import { and, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { filterActiveRows } from '@/kernel/events';
import {
  nativeAttemptOutcome,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import { loadMergedKnowledgeClosure } from '@/kernel/read-models/merged-knowledge';

type DbLike = Db | Tx;

export interface KnowledgeAttemptHit {
  event_id: string;
  action: string;
  subject_kind: string;
  actor_kind: string;
  outcome: 'success' | 'failure' | 'partial' | null;
  created_at: Date;
}

// Bounds the unnest parameter list per statement; the tree snapshot can carry
// up to LOAD_TREE_SNAPSHOT_LIMIT (5000) ids.
const ACTIVITY_QUERY_CHUNK = 500;

/**
 * Latest learner event time per knowledge node. System and agent rows do not
 * move the clock. A native attempt is attached through its revision and the
 * frozen learning scope (`resolveVerdictsForNativeAttempts`), not the attempt
 * payload. Legacy rows still match a subject node or a payload reference.
 * The UNION ALL arms are set-based index scans instead of a per-node correlated
 * aggregate (which seq-scanned event once per node):
 *   - `subject_kind/subject_id` rides event_subject_idx;
 *   - `payload->'referenced_knowledge_ids' @>` keeps its original spelling and
 *     rides event_referenced_knowledge_gin;
 *   - `payload->'knowledge_ids' @>` has no expression index, so it is rewritten
 *     as the exact-equivalent top-level pair — `"kc"` (value IS the needle) OR
 *     `["kc"]` (array containing the needle); jsonb containment is position-
 *     sensitive, so the pair reproduces the sub-value `@>` semantics precisely,
 *     and both forms ride the event_payload_idx jsonb_path_ops GIN.
 * Nodes with no touching event are absent from the map — callers own any
 * fallback (e.g. knowledge.created_at). A requested id also takes the later
 * event on any knowledge id merged into it.
 */
export async function lastKnowledgeActivityAt(
  db: DbLike,
  knowledgeIds: string[],
): Promise<Map<string, Date>> {
  const requested = Array.from(
    new Set(knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  const out = new Map<string, Date>();
  if (requested.length === 0) return out;
  const closure = await loadMergedKnowledgeClosure(db);
  const ids = Array.from(new Set(requested.flatMap((id) => [...closure.closure(id)])));
  const raw = new Map<string, Date>();
  for (let start = 0; start < ids.length; start += ACTIVITY_QUERY_CHUNK) {
    const chunk = ids.slice(start, start + ACTIVITY_QUERY_CHUNK);
    // The chunk is bound once per arm (the id list repeats in the parameter
    // list); sql.join keeps every binding a real parameter.
    const idArray = () =>
      sql`ARRAY[${sql.join(
        chunk.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[]`;
    const rows = await db.execute<{ kc: string; last_event_at: string | Date | null }>(sql`
      SELECT kc, max(created_at) AS last_event_at
      FROM (
        SELECT e.subject_id AS kc, e.created_at
        FROM event e
        WHERE e.actor_kind = 'user'
          AND e.subject_kind = 'knowledge' AND e.subject_id = ANY(${idArray()})
        UNION ALL
        SELECT j.kc, e.created_at
        FROM unnest(${idArray()}) AS j(kc)
        JOIN event e ON e.actor_kind = 'user'
          AND e.payload->'referenced_knowledge_ids' @> to_jsonb(j.kc)
        UNION ALL
        SELECT j.kc, e.created_at
        FROM unnest(${idArray()}) AS j(kc)
        JOIN event e ON e.actor_kind = 'user'
          AND (e.payload @> jsonb_build_object('knowledge_ids', to_jsonb(j.kc))
            OR e.payload @> jsonb_build_object('knowledge_ids', jsonb_build_array(to_jsonb(j.kc))))
      ) hits
      GROUP BY kc
    `);
    // Raw sql timestamps arrive without a Drizzle decoder; Date and string are
    // both accepted here.
    for (const row of rows) {
      if (row.last_event_at !== null && row.last_event_at !== undefined) {
        raw.set(row.kc, new Date(row.last_event_at));
      }
    }
  }
  const queried = new Set(ids);
  for (const hit of await userNativeAttemptTouches(db)) {
    for (const knowledgeId of hit.knowledge_ids) {
      if (!queried.has(knowledgeId)) continue;
      const prev = raw.get(knowledgeId);
      if (!prev || hit.created_at > prev) raw.set(knowledgeId, hit.created_at);
    }
  }
  for (const id of requested) {
    let best: Date | null = null;
    for (const member of closure.closure(id)) {
      const at = raw.get(member);
      if (at && (!best || at > best)) best = at;
    }
    if (best) out.set(id, best);
  }
  return out;
}

/** Newest learner attempts whose frozen scope includes this node or one merged into it. */
export async function recentNativeAttemptsForKnowledge(
  db: DbLike,
  knowledgeId: string,
  limit: number,
): Promise<KnowledgeAttemptHit[]> {
  if (limit <= 0) return [];
  const history = (await loadMergedKnowledgeClosure(db)).closure(knowledgeId);
  const hits = (await userNativeAttemptTouches(db))
    .filter((hit) => hit.knowledge_ids.some((id) => history.has(id)))
    .sort(
      (a, b) =>
        b.created_at.getTime() - a.created_at.getTime() || b.event_id.localeCompare(a.event_id),
    )
    .slice(0, limit);
  return hits.map((hit) => ({
    event_id: hit.event_id,
    action: hit.action,
    subject_kind: hit.subject_kind,
    actor_kind: hit.actor_kind,
    outcome: hit.outcome,
    created_at: hit.created_at,
  }));
}

async function userNativeAttemptTouches(
  db: DbLike,
): Promise<Array<KnowledgeAttemptHit & { knowledge_ids: string[] }>> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        eq(event.action, 'experimental:assessment_attempt'),
        eq(event.subject_kind, 'question'),
      ),
    );
  const active = await filterActiveRows(db, rows);
  if (active.length === 0) return [];
  const verdicts = await resolveVerdictsForNativeAttempts(db, active);
  const hits: Array<KnowledgeAttemptHit & { knowledge_ids: string[] }> = [];
  for (const row of active) {
    const verdict = verdicts.get(row.id);
    if (!verdict || verdict.knowledge_ids.length === 0) continue;
    const outcome = nativeAttemptOutcome(verdict);
    hits.push({
      event_id: row.id,
      action: row.action,
      subject_kind: row.subject_kind,
      actor_kind: row.actor_kind,
      outcome:
        outcome === 'success' || outcome === 'failure' || outcome === 'partial' ? outcome : null,
      created_at: row.created_at,
      knowledge_ids: verdict.knowledge_ids,
    });
  }
  return hits;
}
