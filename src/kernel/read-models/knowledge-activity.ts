// the any-event knowledge activity clock, derived from the event
// spine (max created_at over events touching the node). Single owner of that
// formula. Read-time derivation only: no view, no new table.

import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';

type DbLike = Db | Tx;

// Bounds the unnest parameter list per statement; the tree snapshot can carry
// up to LOAD_TREE_SNAPSHOT_LIMIT (5000) ids.
const ACTIVITY_QUERY_CHUNK = 500;

/**
 * Latest event time per knowledge node over the same predicates the retired
 * view used: events whose subject is the node, or whose payload references it.
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
 * fallback (e.g. knowledge.created_at).
 */
export async function lastKnowledgeActivityAt(
  db: DbLike,
  knowledgeIds: string[],
): Promise<Map<string, Date>> {
  const ids = Array.from(
    new Set(knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  const out = new Map<string, Date>();
  if (ids.length === 0) return out;
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
        WHERE e.subject_kind = 'knowledge' AND e.subject_id = ANY(${idArray()})
        UNION ALL
        SELECT j.kc, e.created_at
        FROM unnest(${idArray()}) AS j(kc)
        JOIN event e ON e.payload->'referenced_knowledge_ids' @> to_jsonb(j.kc)
        UNION ALL
        SELECT j.kc, e.created_at
        FROM unnest(${idArray()}) AS j(kc)
        JOIN event e ON e.payload @> jsonb_build_object('knowledge_ids', to_jsonb(j.kc))
                     OR e.payload @> jsonb_build_object('knowledge_ids', jsonb_build_array(to_jsonb(j.kc)))
      ) hits
      GROUP BY kc
    `);
    // Raw sql timestamps arrive without a Drizzle decoder; Date and string are
    // both accepted here.
    for (const row of rows) {
      if (row.last_event_at !== null && row.last_event_at !== undefined) {
        out.set(row.kc, new Date(row.last_event_at));
      }
    }
  }
  return out;
}
