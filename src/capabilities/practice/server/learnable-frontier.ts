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
//   ③ CYCLE / DEPTH FAIL-SAFE-TO-EMPTY. The recursive closure is a SET walk —
//      `UNION` (not `UNION ALL`) dedupes each (frontier_kc, prereq_kc, depth) tuple, so a
//      multi-parent DAG (a diamond A→B, A→C, B→D, C→D) COLLAPSES its convergent paths
//      instead of enumerating every simple path (the path-explosion this module hardens
//      against — YUK-512: the old per-path ARRAY guard was tree-correct but
//      diamond-EXPONENTIAL, and the outer LIMIT/node-cap did NOT bound the recursive
//      materialisation). Cycles are cut by the frontier-anchor guard (`from <> frontier_kc`
//      — a KC is never its own transitive prerequisite). A depth bound + a node-cap
//      overflow probe (mirroring src/server/events/cascade.ts) remain. On ANY overflow
//      (MAX depth > FRONTIER_DEPTH_LIMIT OR distinct-pair rowcount > FRONTIER_NODE_CAP) we
//      return [] — we NEVER surface a partial/garbage frontier (fail-safe to NO-OP, never
//      to a half-walked graph).
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
/**
 * Runaway backstop on the closure ROWCOUNT (one row per distinct (frontier_kc, prereq_kc)
 * pair after the outer GROUP BY — the UNION set-walk + MAX(depth) collapse multi-path
 * duplicates, so this counts PAIRS, not paths) — overflow → fail-safe to []. This is NOT a
 * functional frontier-size limit (that is FRONTIER_MAX_ITEMS, applied by the caller): the
 * total pair count grows ≈ Σ_dependents(transitive-prereq count), so a low cap would
 * silently blank a legitimate frontier as the graph densifies (breaking defer-flip's
 * "activates cleanly as edges land" story). Set generously (matching the cascade.ts 10k node
 * precedent) so only a genuinely pathological closure (huge fan-out / a cycle escaping the
 * anchor guard) trips it.
 */
export const FRONTIER_NODE_CAP = 10_000;
/** p(L) at/above which a KC counts as MASTERED (self-not-mastered + prereq-mastered gate). */
export const MASTERED_PL_THRESHOLD = 0.7;

/**
 * Minimum evidence_count required, ALONGSIDE p(L) ≥ MASTERED_PL_THRESHOLD, before a KC
 * counts as "mastered enough" to leave the frontier pool / satisfy a downstream prereq.
 *
 * p(L) alone crosses 0.7 after very few consecutive corrects at β=0 (with γ=0.5,
 * σ(0.5·3)=0.8176 on THREE corrects) — a real bug: a KC could be declared mastered on
 * three lucky answers. Gating on evidence_count (NOT the existing low_confidence/theta_se
 * flag, which is already false after just ONE answer at β=0 — see pfa.ts
 * LOW_CONFIDENCE_SE_THRESHOLD) directly closes the gap without touching γ/ρ. 4 matches the
 * codebase's existing cold-start-window convention (theta.ts coldStartN).
 *
 * BORROW-BRANCH INTERACTION (kg-borrowing register unit): getMasteryProjection's borrow
 * branch (src/server/mastery/state.ts:519) synthesizes entries with evidence_count:0. That
 * branch is DARK today (both GRAPH_LAPLACIAN_ENABLED and PREREQ_THETA_PROPAGATION_ENABLED
 * default false), so it never reaches this gate now. Once either flag flips, a borrowed
 * prereq (evidence_count:0) can NEVER pass this floor — it would previously have satisfied
 * an easy-anchor prereq gate on p(L) alone. That is conservative by intent (a borrowed
 * estimate is explicitly low-confidence and should not vacuously unlock a dependent), but
 * is a deliberate coupling to flag when the borrow branch is activated.
 */
export const FRONTIER_MASTERY_MIN_EVIDENCE = 4;

/** A KC counts as "mastered enough" for frontier purposes iff BOTH the p(L) point
 *  estimate clears the threshold AND enough evidence has accumulated to trust it. */
export function isMasteredForFrontier(mastery: number, evidenceCount: number): boolean {
  return mastery >= MASTERED_PL_THRESHOLD && evidenceCount >= FRONTIER_MASTERY_MIN_EVIDENCE;
}
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

/** The three DISTINCT closure states a bare `[]` used to collapse (YUK-514 Finding 1). */
export type FrontierKind = 'sparse' | 'dense' | 'overflow';

/**
 * Discriminated frontier result (YUK-514 Finding 1). The historical `learnableFrontier`
 * returns `[]` for THREE different states, which a downstream cold-start gate cannot tell
 * apart:
 *   - `sparse`   — empty closure (no live prerequisite edges yet): the true cold-start a
 *                  bootstrap job SHOULD act on.
 *   - `overflow` — the closure tripped the depth / node-cap fail-safe (the graph is actually
 *                  DENSE / pathological): a bootstrap job must NOT treat this as cold-start.
 *   - `dense`    — a real closure; `ids` is the computed learnable frontier (possibly `[]`
 *                  when every dependent is gated out by the mastery predicate).
 * Consumers that only need the id list use the thin {@link learnableFrontier} wrapper
 * (byte-identical to the historical contract that composeDailyStream / the stream store
 * depend on); consumers that must distinguish overflow from cold-start read `kind`.
 */
export interface FrontierResolution {
  kind: FrontierKind;
  ids: string[];
  /**
   * A5 S2 (YUK-354) — the transitive prereq closure that produced `ids`, surfaced so
   * the FrontierRail read model can assemble each frontier KC's "前置已掌握" reason
   * WITHOUT recomputing the closure. Map<frontier_kc, prereq_kc[]>. Populated ONLY on
   * the `dense` branch (sparse/overflow carry no closure → omitted). Additive +
   * optional: the thin {@link learnableFrontier} wrapper and frontier_fill_nightly read
   * only `.ids`/`.kind`, so they are byte-identical to before.
   */
  prereqsByFrontier?: Map<string, string[]>;
}

/**
 * learnableFrontierResolved — the prerequisite-gated learnable frontier with its closure
 * state surfaced (pure READ). See {@link FrontierResolution}.
 *
 * `ids` (when `kind === 'dense'`) is the (sorted, deterministic) list of KC ids ready to
 * learn now: self p(L) < MASTERED_PL_THRESHOLD AND every transitive prerequisite p(L) ≥
 * MASTERED_PL_THRESHOLD. `sparse` / `overflow` carry `ids: []` (see the INVARIANT BLOCK).
 *
 * @param db Db or Tx — read-only (only `.execute`/`.select` reads; no writes).
 */
export async function learnableFrontierResolved(db: DbLike): Promise<FrontierResolution> {
  // Recurse ONE level past the depth limit so an over-deep chain is detectable (the MAX
  // depth of any returned pair > FRONTIER_DEPTH_LIMIT signals truncation), and fetch ONE
  // row past the node cap so cap-overflow is detectable without a second COUNT query.
  // Both overflow probes are dropped on the JS side (mirror cascade.ts:101-106).
  const depthProbe = FRONTIER_DEPTH_LIMIT + 1;
  const fetchLimit = FRONTIER_NODE_CAP + 1;

  // WITH RECURSIVE prereq-closure over knowledge_edge(relation_type='prerequisite'):
  //   `from_knowledge_id → to_knowledge_id` means "from is a prerequisite of to". So a
  //   KC's prereqs are the `from_` of edges where IT is the `to_`. The frontier_kc
  //   (the dependent we are gating) is anchored at the base `to_` and carried
  //   UNCHANGED up the chain; prereq_kc is each ancestor prerequisite discovered.
  //   - base case (depth 1): the direct prereqs of every dependent KC.
  //   - recursive case: walk UP the prereq chain via `e.to_knowledge_id = c.prereq_kc`.
  //   SET WALK (YUK-512): `UNION` (not `UNION ALL`) dedupes each (frontier_kc, prereq_kc,
  //   depth) tuple against ALL prior results, so a multi-parent DAG (diamond) collapses
  //   convergent paths instead of enumerating every simple path → the closure stays
  //   POLYNOMIAL, not exponential. Cycles are cut by the frontier-anchor guard
  //   `e.from_knowledge_id <> c.frontier_kc` (a KC is never its own transitive
  //   prerequisite) — this replaces the old per-path ARRAY guard, which was tree-correct
  //   but diamond-exponential. The depth bound `c.depth < depthProbe` still terminates any
  //   prereq-only cycle (it increments depth and trips the overflow probe). Self-loops
  //   (`from = to`) and archived edges excluded at every level. The outer GROUP BY collapses
  //   each pair to ONE row (MAX(depth) for the overflow probe), so the depth-duplicated rows
  //   the old `SELECT DISTINCT … depth` projection emitted no longer inflate the rowcount.
  const rows = (await db.execute(sql`
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
  `)) as unknown as FrontierClosureRow[];

  // ③ Fail-safe-to-empty on any overflow (mirror cascade.ts:155-164). Depth overflow:
  //    any pair whose MAX depth exceeds the cap means the chain exceeded the hard limit →
  //    refuse the whole set. Node-cap overflow: we asked for nodeCap+1 distinct pairs;
  //    > nodeCap rows means the closure is wider than allowed → refuse. NEVER a partial set.
  const normalised = rows.map((r) => ({
    frontier_kc: r.frontier_kc,
    prereq_kc: r.prereq_kc,
    depth: typeof r.depth === 'string' ? Number(r.depth) : r.depth,
  }));
  const depthOverflow = normalised.some((r) => r.depth > FRONTIER_DEPTH_LIMIT);
  const nodeOverflow = normalised.length > FRONTIER_NODE_CAP;
  if (depthOverflow || nodeOverflow) return { kind: 'overflow', ids: [] };

  // ① Empty CTE (sparse graph) → empty frontier (the NO-OP anchor).
  if (normalised.length === 0) return { kind: 'sparse', ids: [] };

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
  const evidenceOf = (kc: string): number => projection.get(kc)?.evidence_count ?? 0;
  // "Mastered enough" = p(L) clears threshold AND evidence_count clears the floor (YUK-539):
  // a KC on 3 lucky corrects (raw p(L) ≥ 0.7 but evidence_count < 4) must NOT drop from the
  // pool nor vacuously satisfy a dependent's prereq. Applied UNIFORMLY to both self + prereq
  // sides — a prereq "mastered" on 3 lucky answers is exactly as unreliable a gate-satisfier
  // as a self-KC dropped on 3 lucky answers.
  const masteredEnough = (kc: string): boolean => isMasteredForFrontier(pL(kc), evidenceOf(kc));

  // Frontier = { kc : NOT masteredEnough(self) AND every prereq masteredEnough }. Sorted for
  // a deterministic order (the caller caps to FRONTIER_MAX_ITEMS).
  const frontier: string[] = [];
  for (const [frontierKc, prereqKcs] of prereqsByFrontier) {
    if (masteredEnough(frontierKc)) continue; // self already mastered → skip.
    const allPrereqsMastered = prereqKcs.every((p) => masteredEnough(p));
    if (allPrereqsMastered) frontier.push(frontierKc);
  }
  frontier.sort();
  return { kind: 'dense', ids: frontier, prereqsByFrontier };
}

/**
 * learnableFrontier — thin id-list wrapper over {@link learnableFrontierResolved}.
 *
 * Returns [] on the sparse graph / on any overflow (BYTE-IDENTICAL to the historical
 * contract that composeDailyStream + the stream store depend on — the structural
 * defer-flip). Consumers that must tell overflow from cold-start (frontier_fill_nightly)
 * call learnableFrontierResolved directly and branch on `kind`.
 *
 * @param db Db or Tx — read-only (only `.execute`/`.select` reads; no writes).
 */
export async function learnableFrontier(db: DbLike): Promise<string[]> {
  return (await learnableFrontierResolved(db)).ids;
}
