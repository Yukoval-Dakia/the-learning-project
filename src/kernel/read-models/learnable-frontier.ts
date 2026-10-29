// Complete frontier eligibility decision shared by graph display and practice.
// Closure bounds, mastery evidence, empty states and overflow diagnostics stay together.

import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';

// The learnable frontier: KCs whose transitive prerequisites are all mastered and
// which are not mastered themselves.
//
// - A KC is a candidate only when it has at least one live prerequisite, so empty
//   graphs stay empty instead of vacuously qualifying every KC.
// - Archived edges never gate or surface anything.
// - The closure is a set walk (UNION), so diamonds collapse instead of exploding;
//   depth and rowcount overflows fail safe to an empty frontier, never a partial one.
// - Topology stays in SQL; the mastery predicate stays in TS on getMasteryProjection.

type DbLike = Db | Tx;

/** Hard depth bound on the transitive prereq closure walk (cycle/run-away guard). */
const FRONTIER_DEPTH_LIMIT = 16;
/**
 * Runaway backstop on distinct (frontier, prereq) pairs, not on path count: the
 * closure's rowcount grows with graph density, so a tight cap would blank a real
 * frontier. Only a pathological fan-out or an escaping cycle should trip it.
 */
const FRONTIER_NODE_CAP = 10_000;

/** p(L) at which a KC counts as mastered; always pair it with the evidence floor. */
const MASTERED_PL_THRESHOLD = 0.7;

/**
 * Evidence floor for mastery. p(L) alone crosses 0.7 after three lucky corrects, so
 * the floor blocks that without changing the model. A borrowed estimate has no
 * evidence and therefore never unlocks a dependent.
 */
const FRONTIER_MASTERY_MIN_EVIDENCE = 4;

/** Mastered enough for frontier purposes: clears both the p(L) gate and the evidence floor. */
export function isMasteredForFrontier(mastery: number, evidenceCount: number): boolean {
  return mastery >= MASTERED_PL_THRESHOLD && evidenceCount >= FRONTIER_MASTERY_MIN_EVIDENCE;
}

/**
 * Cold-start p(L) for a KC with no mastery row, matching the PFA midpoint. Below the
 * mastery threshold, so an unattempted prerequisite keeps its dependents gated.
 */
const COLD_START_PL = 0.5;

type FrontierClosureRow = {
  frontier_kc: string;
  prereq_kc: string;
  depth: number | string;
};

/** Sparse and overflow both produce no ids; only sparse means the graph is still cold. */
type FrontierKind = 'sparse' | 'dense' | 'overflow';

/** Frontier ids plus the closure that produced them, so callers need not recompute it. */
export interface FrontierResolution {
  kind: FrontierKind;
  ids: string[];
  /** Only populated for `dense`. */
  prereqsByFrontier?: Map<string, string[]>;
}

/**
 * The learnable frontier and why it is empty. `ids` is sorted; sparse and overflow
 * both carry `[]`, so callers that care must read `kind`.
 */
export async function learnableFrontierResolved(db: DbLike): Promise<FrontierResolution> {
  // Recurse one level past the limit and fetch one row past the cap so overflow is
  // detectable without a second query.
  const depthProbe = FRONTIER_DEPTH_LIMIT + 1;
  const fetchLimit = FRONTIER_NODE_CAP + 1;

  // Transitive prerequisite closure. `from -> to` means "from is a prereq of to", so
  // walk upward from each dependent's `to` endpoint. UNION collapses diamond paths;
  // the anchor guard cuts cycles. Self-loops and archived edges never count.
  const rows = await db.execute<FrontierClosureRow>(sql`
    WITH RECURSIVE closure AS (
      SELECT
        e.to_knowledge_id   AS frontier_kc,
        e.from_knowledge_id AS prereq_kc,
        1 AS depth
      FROM knowledge_edge e
      WHERE e.relation_type = 'prerequisite'
        AND e.archived_at IS NULL
        AND e.from_knowledge_id <> e.to_knowledge_id

      UNION

      SELECT
        c.frontier_kc,
        e.from_knowledge_id AS prereq_kc,
        c.depth + 1 AS depth
      FROM knowledge_edge e
      JOIN closure c ON e.to_knowledge_id = c.prereq_kc
      WHERE e.relation_type = 'prerequisite'
        AND e.archived_at IS NULL
        AND e.from_knowledge_id <> e.to_knowledge_id
        AND e.from_knowledge_id <> c.frontier_kc
        AND c.depth < ${depthProbe}
    )
    SELECT frontier_kc, prereq_kc, MAX(depth) AS depth
    FROM closure
    GROUP BY frontier_kc, prereq_kc
    LIMIT ${fetchLimit}
  `);

  // Any overflow blanks the frontier; never return a partially walked graph.
  const normalised = rows.map((r) => ({
    frontier_kc: r.frontier_kc,
    prereq_kc: r.prereq_kc,
    depth: typeof r.depth === 'string' ? Number(r.depth) : r.depth,
  }));
  const depthOverflow = normalised.some((r) => r.depth > FRONTIER_DEPTH_LIMIT);
  const nodeOverflow = normalised.length > FRONTIER_NODE_CAP;
  if (depthOverflow || nodeOverflow) {
    // Warn here so every consumer inherits overflow visibility. No dedup: overflow is
    // a persistent graph condition, so repeated warns are the intended signal.
    console.warn(
      '[frontier] closure overflow — depth/node-cap fail-safe tripped, frontier blanked',
      {
        depthOverflow,
        nodeOverflow,
        depthLimit: FRONTIER_DEPTH_LIMIT,
        nodeCap: FRONTIER_NODE_CAP,
        rows: normalised.length,
        hint: '检查 prerequisite 边:depth 溢出→过深链/上游环(depth>limit);node-cap 溢出→异常扇出。overflow 期间 frontier 全面为空(composer/FrontierRail/nightly 三面)。',
        see: 'docs/design/2026-07-03-frontier-gate-spec.md §Q1',
      },
    );
    return { kind: 'overflow', ids: [] };
  }

  if (normalised.length === 0) return { kind: 'sparse', ids: [] };

  const prereqsByFrontier = new Map<string, string[]>();
  for (const r of normalised) {
    const list = prereqsByFrontier.get(r.frontier_kc) ?? [];
    list.push(r.prereq_kc);
    prereqsByFrontier.set(r.frontier_kc, list);
  }

  // Mastery stays in TS via the canonical projection; the cast is safe because it is a
  // pure read and may run inside the compose transaction.
  const allKcs = new Set<string>();
  for (const [frontierKc, prereqKcs] of prereqsByFrontier) {
    allKcs.add(frontierKc);
    for (const p of prereqKcs) allKcs.add(p);
  }
  const projection = await getMasteryProjection(db as Db, [...allKcs]);
  const pL = (kc: string): number => projection.get(kc)?.mastery ?? COLD_START_PL;
  const evidenceOf = (kc: string): number => projection.get(kc)?.evidence_count ?? 0;
  // Applied to both sides: a prereq that is only "mastered" on lucky answers is as
  // unreliable as a self KC dropped on them.
  const masteredEnough = (kc: string): boolean => isMasteredForFrontier(pL(kc), evidenceOf(kc));

  // Sorted for deterministic output; the caller applies the item cap.
  const frontier: string[] = [];
  for (const [frontierKc, prereqKcs] of prereqsByFrontier) {
    if (masteredEnough(frontierKc)) continue;
    const allPrereqsMastered = prereqKcs.every((p) => masteredEnough(p));
    if (allPrereqsMastered) frontier.push(frontierKc);
  }
  frontier.sort();
  return { kind: 'dense', ids: frontier, prereqsByFrontier };
}
