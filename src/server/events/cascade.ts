// Reverse-traverse `caused_by_event_id` from a checkpoint to collect every
// downstream event. `correct` events are excluded at the seed and in the
// recursive join: they already undid a node, so reverting them again would
// double-apply. A path-array guard cuts bad-data cycles. The checkpoint itself is
// not returned; the orchestrator handles the root separately.
//
// A truncated traversal returns no partial set: a chain deeper than
// CASCADE_DEPTH_LIMIT or wider than the node cap yields { truncated: true,
// nodes: [] }. Rows otherwise come back deepest first so callers revert leaves
// before their parents. The reverse lookup rides event_caused_by_idx.

import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';

type DbLike = Db | Tx;

/** Recursion cap; deeper chains are refused as truncated. */
export const CASCADE_DEPTH_LIMIT = 64;

/** Default node ceiling; wider cascades are refused rather than partially returned. */
export const CASCADE_DEFAULT_NODE_CAP = 10_000;

export interface CollectCascadeOptions {
  /** Refuse with `{ truncated: true, nodes: [] }` above this width. */
  nodeCap?: number;
}

export interface CascadeNode {
  id: string;
  action: string;
  caused_by_event_id: string | null;
  /** Distance from the checkpoint root (root's direct children = depth 1). */
  depth: number;
}

export interface CascadeResult {
  /** Downstream events, deepest first. The root is excluded. */
  nodes: CascadeNode[];
  /** The depth limit or node cap was hit; `nodes` is then empty. */
  truncated: boolean;
}

type CascadeRow = {
  id: string;
  action: string;
  caused_by_event_id: string | null;
  depth: number | string;
};

/**
 * Collect the events transitively caused by `checkpointEventId`, excluding the
 * checkpoint and any `correct` compensation events. Refuses with
 * `{ truncated: true, nodes: [] }` past the depth limit or node cap.
 */
export async function collectCascadeFromCheckpoint(
  db: DbLike,
  checkpointEventId: string,
  opts?: CollectCascadeOptions,
): Promise<CascadeResult> {
  const nodeCap = opts?.nodeCap ?? CASCADE_DEFAULT_NODE_CAP;

  // Reject bad caller input before it reaches the SQL LIMIT; the depth limit is
  // a constant, so it needs no guard.
  if (!Number.isInteger(nodeCap) || nodeCap < 1) {
    throw new Error(
      `collectCascadeFromCheckpoint: opts.nodeCap must be a positive integer (got ${nodeCap})`,
    );
  }

  // Over-fetch one row past each cap so overflow is detectable without a second
  // COUNT query; both probes are dropped on the JS side.
  const depthProbe = CASCADE_DEPTH_LIMIT + 1;
  const fetchLimit = nodeCap + 1;

  // Base case: direct children, excluding `correct`. Recursive case: children of
  // collected nodes, dropping compensation nodes and their bridges, cutting
  // cycles by path, and bounding depth. The seed puts the checkpoint in `path`
  // so a cycle can never re-enter the root.
  const rows = await db.execute<CascadeRow>(sql`
    WITH RECURSIVE cascade AS (
      SELECT
        e.id,
        e.action,
        e.caused_by_event_id,
        1 AS depth,
        ARRAY[${checkpointEventId}::text, e.id] AS path
      FROM event e
      WHERE e.caused_by_event_id = ${checkpointEventId}
        AND e.action <> 'correct'

      UNION ALL

      SELECT
        e.id,
        e.action,
        e.caused_by_event_id,
        c.depth + 1 AS depth,
        c.path || e.id AS path
      FROM event e
      JOIN cascade c ON e.caused_by_event_id = c.id
      WHERE e.action <> 'correct'
        AND NOT (e.id = ANY(c.path))
        AND c.depth < ${depthProbe}
    )
    SELECT DISTINCT id, action, caused_by_event_id, depth
    FROM cascade
    ORDER BY depth DESC, id
    LIMIT ${fetchLimit}
  `);

  const normalised: CascadeNode[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    caused_by_event_id: r.caused_by_event_id,
    depth: typeof r.depth === 'string' ? Number(r.depth) : r.depth,
  }));

  // Either overflow refuses the whole set; a partial closure is never returned.
  const depthOverflow = normalised.some((n) => n.depth > CASCADE_DEPTH_LIMIT);
  const nodeOverflow = normalised.length > nodeCap;

  if (depthOverflow || nodeOverflow) {
    return { nodes: [], truncated: true };
  }

  return { nodes: normalised, truncated: false };
}
