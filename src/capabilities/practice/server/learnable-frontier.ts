// B3 frontier (YUK-349 scope #3, ADR-0037 #4 / ADR-0042) — the `learnable_frontier`
// read: KCs ready to learn NOW = self NOT mastered AND all (transitive,
// prerequisite-gated) prerequisites mastered. Feeds composeDailyStream as an
// ADDITIVE 5th candidate source (after due / variant / new_check / paper).
//
// ════════════════════════════════════════════════════════════════════════════
// INVARIANT BLOCK — the load-bearing guarantees this module preserves:
//
//   ① NO-OP-SAFETY (the defer-flip, with NO flag). A KC is emitted as a
//      `frontier_kc` ONLY if it is the `to_` endpoint of a LIVE prerequisite edge
//      (i.e. it HAS ≥1 prerequisite). A KC with ZERO prerequisites NEVER appears as
//      a `to_` → is NEVER a frontier candidate → "all prereqs mastered" is NEVER
//      satisfied VACUOUSLY. On today's sparse graph (few/no
//      relation_type='prerequisite' rows) the base case is empty → the CTE is empty
//      → learnableFrontier returns [] → composeDailyStream is BYTE-IDENTICAL. This
//      structural ≥1-prereq gate + the vacuous-truth exclusion ARE the defer-flip:
//      the frontier activates with ZERO code change as prerequisite edges land.
//
//   ② ARCHIVED EXCLUSION. Only `archived_at IS NULL` prerequisite edges count —
//      an archived (soft-deleted) edge must not gate or surface anything.
//
//   ③ CYCLE / DEPTH FAIL-SAFE-TO-EMPTY. The recursive closure carries a path-array
//      cycle guard, a depth bound, and a node-cap overflow probe (mirroring
//      src/server/events/cascade.ts). On ANY overflow (depth > FRONTIER_DEPTH_LIMIT
//      OR rowcount > FRONTIER_NODE_CAP) we return [] — we NEVER surface a
//      partial/garbage frontier (fail-safe to NO-OP, never to a half-walked graph).
//
//   ④ MASTERY-PREDICATE-IN-TS. Topology (the prereq closure) lives in SQL; the
//      mastery predicate (p(L) ≥ threshold) lives in TS, reusing the canonical
//      getMasteryProjection (B1, src/server/mastery/state.ts). We do NOT re-encode
//      the PFA/β formula in SQL.
// ════════════════════════════════════════════════════════════════════════════

import type { Db, Tx } from '@/db/client';
import { getMasteryProjection } from '@/server/mastery/state';
import { sql } from 'drizzle-orm';

type DbLike = Db | Tx;

/** Hard depth bound on the transitive prereq closure walk (cycle/run-away guard). */
export const FRONTIER_DEPTH_LIMIT = 16;
/** Hard node-cap on the closure rowcount — overflow → fail-safe to []. */
export const FRONTIER_NODE_CAP = 256;
/** p(L) at/above which a KC counts as MASTERED (self-not-mastered + prereq-mastered gate). */
export const MASTERED_PL_THRESHOLD = 0.7;
/** Cap on how many frontier questions the composer pulls in per day (applied by the caller). */
export const FRONTIER_MAX_ITEMS = 5;

/**
 * Cold-start p(L) for a KC with no `mastery_state` row (never attempted). Matches
 * the canonical PFA cold-start midpoint (src/core/pfa.ts: success=0, fail=0, β=0 →
 * logit=0 → σ(0)=0.5). 0.5 < MASTERED_PL_THRESHOLD (0.7), so:
 *   - self with no mastery row → self-not-mastered SATISFIED (it can be a frontier);
 *   - an UNATTEMPTED prerequisite (p(L)=0.5 < 0.7) correctly GATES OUT its dependent
 *     (conservative: we never declare a KC learnable while one of its prereqs is
 *     still unproven).
 */
const COLD_START_PL = 0.5;

interface FrontierClosureRow {
  frontier_kc: string;
  prereq_kc: string;
  depth: number | string;
}

/**
 * learnableFrontier — the prerequisite-gated learnable frontier (pure READ).
 *
 * Returns the (sorted, deterministic) list of KC ids that are ready to learn now:
 * self p(L) < MASTERED_PL_THRESHOLD AND every transitive prerequisite p(L) ≥
 * MASTERED_PL_THRESHOLD. Returns [] on the sparse graph / on any overflow (see the
 * INVARIANT BLOCK above) — the structural defer-flip.
 *
 * @param db Db or Tx — read-only (only `.execute`/`.select` reads; no writes).
 */
export async function learnableFrontier(db: DbLike): Promise<string[]> {
  // Recurse ONE level past the depth limit so an over-deep chain is detectable (any
  // returned row with depth > FRONTIER_DEPTH_LIMIT signals truncation), and fetch ONE
  // row past the node cap so cap-overflow is detectable without a second COUNT query.
  // Both overflow probes are dropped on the JS side (mirror cascade.ts:101-106).
  const depthProbe = FRONTIER_DEPTH_LIMIT + 1;
  const fetchLimit = FRONTIER_NODE_CAP + 1;

  // WITH RECURSIVE prereq-closure over knowledge_edge(relation_type='prerequisite'):
  //   `from_knowledge_id → to_knowledge_id` means "from is a prerequisite of to". So a
  //   KC's prereqs are the `from_` of edges where IT is the `to_`. The frontier_kc
  //   (the dependent we are gating) is anchored at the base `to_` and carried
  //   UNCHANGED up the chain; prereq_kc is each ancestor prerequisite discovered.
  //   - base case (depth 1): the direct prereqs of every dependent KC. Seeding
  //     `path = ARRAY[to, from]` puts the dependent itself in the visited set so a
  //     cycle can never re-enter it.
  //   - recursive case: walk UP the prereq chain via `e.to_knowledge_id = c.prereq_kc`,
  //     with the path-array cycle guard `NOT (e.from_knowledge_id = ANY(c.path))` and
  //     the depth bound `c.depth < depthProbe`.
  //   Self-loops (`from = to`) are dropped at every level. archived edges excluded.
  const rows = (await db.execute(sql`
    WITH RECURSIVE closure AS (
      SELECT
        e.to_knowledge_id   AS frontier_kc,
        e.from_knowledge_id AS prereq_kc,
        1 AS depth,
        ARRAY[e.to_knowledge_id, e.from_knowledge_id] AS path
      FROM knowledge_edge e
      WHERE e.relation_type = 'prerequisite'
        AND e.archived_at IS NULL
        AND e.from_knowledge_id <> e.to_knowledge_id

      UNION ALL

      SELECT
        c.frontier_kc,
        e.from_knowledge_id AS prereq_kc,
        c.depth + 1 AS depth,
        c.path || e.from_knowledge_id AS path
      FROM knowledge_edge e
      JOIN closure c ON e.to_knowledge_id = c.prereq_kc
      WHERE e.relation_type = 'prerequisite'
        AND e.archived_at IS NULL
        AND e.from_knowledge_id <> e.to_knowledge_id
        AND NOT (e.from_knowledge_id = ANY(c.path))
        AND c.depth < ${depthProbe}
    )
    SELECT DISTINCT frontier_kc, prereq_kc, depth
    FROM closure
    LIMIT ${fetchLimit}
  `)) as unknown as FrontierClosureRow[];

  // ③ Fail-safe-to-empty on any overflow (mirror cascade.ts:155-164). Depth overflow:
  //    any row deeper than the cap means the chain exceeded the hard limit → refuse the
  //    whole set. Node-cap overflow: we asked for nodeCap+1; > nodeCap rows means the
  //    closure is wider than allowed → refuse. NEVER surface a partial frontier.
  const normalised = rows.map((r) => ({
    frontier_kc: r.frontier_kc,
    prereq_kc: r.prereq_kc,
    depth: typeof r.depth === 'string' ? Number(r.depth) : r.depth,
  }));
  const depthOverflow = normalised.some((r) => r.depth > FRONTIER_DEPTH_LIMIT);
  const nodeOverflow = normalised.length > FRONTIER_NODE_CAP;
  if (depthOverflow || nodeOverflow) return [];

  // ① Empty CTE (sparse graph) → empty frontier (the NO-OP anchor).
  if (normalised.length === 0) return [];

  // Group into Map<frontier_kc, prereq_kc[]>.
  const prereqsByFrontier = new Map<string, string[]>();
  for (const r of normalised) {
    const list = prereqsByFrontier.get(r.frontier_kc) ?? [];
    list.push(r.prereq_kc);
    prereqsByFrontier.set(r.frontier_kc, list);
  }

  // ④ Mastery predicate in TS. Read p(L) for every frontier KC AND every prereq KC via
  //    the canonical projection (do NOT re-encode PFA in SQL). getMasteryProjection is a
  //    pure read (select/execute only) → running it on a Tx is identical to a Db, so the
  //    DbLike→Db cast is safe here (this read can run inside the compose attempt tx).
  const allKcs = new Set<string>();
  for (const [frontierKc, prereqKcs] of prereqsByFrontier) {
    allKcs.add(frontierKc);
    for (const p of prereqKcs) allKcs.add(p);
  }
  const projection = await getMasteryProjection(db as Db, [...allKcs]);
  const pL = (kc: string): number => projection.get(kc)?.mastery ?? COLD_START_PL;

  // Frontier = { kc : pL(kc) < threshold AND every prereq pL ≥ threshold }. Sorted for
  // a deterministic order (the caller caps to FRONTIER_MAX_ITEMS).
  const frontier: string[] = [];
  for (const [frontierKc, prereqKcs] of prereqsByFrontier) {
    if (pL(frontierKc) >= MASTERED_PL_THRESHOLD) continue; // self already mastered → skip.
    const allPrereqsMastered = prereqKcs.every((p) => pL(p) >= MASTERED_PL_THRESHOLD);
    if (allPrereqsMastered) frontier.push(frontierKc);
  }
  frontier.sort();
  return frontier;
}
