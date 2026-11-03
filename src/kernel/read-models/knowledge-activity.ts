// YUK-1778 — the any-event knowledge activity clock, derived from the event
// spine. Single owner of the semantics the deprecated knowledge_mastery view's
// `activity` CTE computed (max created_at over events touching the node), so
// migrating view readers do not fork the formula. Read-time derivation only:
// no view, no new table.

import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';

type DbLike = Db | Tx;

// Bounds the unnest parameter list per statement; the tree snapshot can carry
// up to LOAD_TREE_SNAPSHOT_LIMIT (5000) ids.
const ACTIVITY_QUERY_CHUNK = 500;

/**
 * Latest event time per knowledge node over the same predicates the retired
 * view used: events whose subject is the node, or whose payload references it.
 * The payload containment probes ride the event_payload_idx GIN index
 * (jsonb_path_ops). Nodes with no touching event are absent from the map —
 * callers own any fallback (e.g. knowledge.created_at).
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
    const idParams = sql.join(
      chunk.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await db.execute<{ kc: string; last_event_at: string | Date | null }>(sql`
      SELECT kc, (
        SELECT max(e.created_at) AS last_event_at
        FROM event e
        WHERE (e.subject_kind = 'knowledge' AND e.subject_id = kc)
           OR (e.payload->'referenced_knowledge_ids' @> to_jsonb(kc))
           OR (e.payload->'knowledge_ids' @> to_jsonb(kc))
      ) AS last_event_at
      FROM unnest(ARRAY[${idParams}]::text[]) AS kc
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
