// YUK-471 Wave 0 — cascade collection via the repo's FIRST `WITH RECURSIVE`.
//
// `collectCascadeFromCheckpoint` reverse-traverses the `caused_by_event_id` edge
// from a checkpoint event to gather every DOWNSTREAM event transitively caused by
// it. This is the set a later cascade-revert orchestrator (NOT this wave — ADR-0044
// §4, plan §1 OUT) must compensate, in reverse-dependency order (deepest first).
//
// Blueprint: `getEventChain` (queries.ts:943-977) does ONE reverse hop with the
// `ne(action,'correct')` trap (queries.ts:963) — compensation (`correct`) events
// must NOT be swept back into the cascade, because reverting a node and then also
// reverting the compensation that already undid it would double-apply. This
// collector generalises that single hop to N levels, adding:
//   - cycle guard      : a path array + `id = ANY(path)` cutoff (bad-data loops).
//   - depth limit 64   : hard recursion cap; deeper chains → honest-reject.
//   - node cap         : exceeding the cap → refuse with `{ truncated: true }`,
//                        returning NO half set (the orchestrator must revert an
//                        all-or-nothing closure, never a partial one).
//   - root exclusion   : the checkpoint itself is NOT returned (plan §6.4); the
//                        orchestrator handles the root separately.
//   - ORDER BY depth DESC : reverse-dependency order (Codex fix ④) — deepest
//                        descendants first so the orchestrator reverts leaves
//                        before the branches they hang off.
//
// The `action <> 'correct'` predicate sits in BOTH the recursive join and is
// already excluded at the seed (the root is excluded entirely), so a `correct`
// node is never visited AND never acts as a bridge to its own descendants.
//
// Rides `event_caused_by_idx` (schema.ts:743) for the reverse lookup.

import type { Db, Tx } from '@/db/client';
import { sql } from 'drizzle-orm';

type DbLike = Db | Tx;

/** Hard recursion cap. Chains deeper than this → honest-reject (truncated). */
export const CASCADE_DEPTH_LIMIT = 64;

/** Default ceiling on collected nodes. Exceeding it → refuse (no half set). */
export const CASCADE_DEFAULT_NODE_CAP = 10_000;

export interface CollectCascadeOptions {
  /**
   * Maximum number of downstream nodes to collect. When the cascade exceeds this,
   * the collector refuses: it returns `{ truncated: true, nodes: [] }` rather than
   * a partial closure (the revert must be all-or-nothing).
   */
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
  /** Downstream events, ordered by depth DESC (deepest first). Root excluded. */
  nodes: CascadeNode[];
  /**
   * `true` when the traversal hit the depth limit OR the node cap. On truncation
   * `nodes` is EMPTY — an honest-reject contract, never a partial set.
   */
  truncated: boolean;
}

interface CascadeRow {
  id: string;
  action: string;
  caused_by_event_id: string | null;
  depth: number | string;
}

/**
 * Collect the downstream cascade of `checkpointEventId` (the events transitively
 * caused by it via `caused_by_event_id`), EXCLUDING the checkpoint itself and any
 * `action='correct'` compensation events.
 *
 * Returns `{ truncated: true, nodes: [] }` if the cascade is deeper than
 * {@link CASCADE_DEPTH_LIMIT} or wider than `opts.nodeCap`
 * (default {@link CASCADE_DEFAULT_NODE_CAP}).
 */
export async function collectCascadeFromCheckpoint(
  db: DbLike,
  checkpointEventId: string,
  opts?: CollectCascadeOptions,
): Promise<CascadeResult> {
  const nodeCap = opts?.nodeCap ?? CASCADE_DEFAULT_NODE_CAP;

  // Fast-fail on an invalid caller-supplied nodeCap before it reaches the SQL
  // LIMIT (a negative or non-integer would surface as a confusing runtime SQL
  // error rather than a clear contract violation). The depth limit is a const,
  // not caller input, so it needs no such guard.
  if (!Number.isInteger(nodeCap) || nodeCap < 1) {
    throw new Error(
      `collectCascadeFromCheckpoint: opts.nodeCap must be a positive integer (got ${nodeCap})`,
    );
  }

  // Recurse ONE level past the depth limit so an over-deep chain is detectable
  // (any returned row with depth > CASCADE_DEPTH_LIMIT signals truncation), and
  // fetch ONE row past the node cap so cap-overflow is detectable without a
  // second COUNT query. Both overflow probes are dropped on the JS side.
  const depthProbe = CASCADE_DEPTH_LIMIT + 1;
  const fetchLimit = nodeCap + 1;

  // The recursive CTE:
  //  - base case: direct children of the checkpoint (depth 1), excluding `correct`.
  //  - recursive case: children of already-collected nodes, with
  //      * `action <> 'correct'`           — drop compensation nodes + bridges
  //      * `NOT (e.id = ANY(c.path))`       — cycle cutoff via the path array
  //      * `c.depth < depthProbe`           — bounded recursion (depth + overflow)
  //  The base seed seeds `path = ARRAY[checkpoint, child.id]` so the checkpoint
  //  itself is in the visited set and can never be re-entered through a cycle.
  const rows = (await db.execute(sql`
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
  `)) as unknown as CascadeRow[];

  const normalised: CascadeNode[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    caused_by_event_id: r.caused_by_event_id,
    depth: typeof r.depth === 'string' ? Number(r.depth) : r.depth,
  }));

  // Depth overflow: any node deeper than the cap means the chain exceeded the
  // hard limit → refuse the whole set.
  const depthOverflow = normalised.some((n) => n.depth > CASCADE_DEPTH_LIMIT);
  // Node-cap overflow: we asked for nodeCap+1; getting more than nodeCap means
  // the cascade is wider than allowed → refuse.
  const nodeOverflow = normalised.length > nodeCap;

  if (depthOverflow || nodeOverflow) {
    return { nodes: [], truncated: true };
  }

  return { nodes: normalised, truncated: false };
}
