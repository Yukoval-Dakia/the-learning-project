// A5 S2 (YUK-354) — FrontierRail read model. Assembles the「下一步，你学得动这些」
// learnable-frontier banner shape from TWO halves:
//
//   - DENSE half (live edges): learnableFrontierResolved(db) `kind==='dense'` ids — KCs
//     whose live (non-archived) prerequisite closure is fully mastered. `propose=false,
//     lowConf=false` (a live edge confidently unlocks them). The "前置已掌握" reason is
//     assembled from the closure surfaced on FrontierResolution.prereqsByFrontier.
//   - PROPOSE half (cold-start, proposed/non-live edges): on a sparse graph the dense
//     frontier is empty; the only "next steps" come from frontier_fill_nightly's
//     PROPOSE-ONLY (low-confidence) prerequisite edges (pending propose events, NOT live
//     knowledge_edge rows). Each pending proposed prereq edge `from→to` suggests `to` as a
//     low-confidence next step. `propose=true, lowConf=true`.
//
// RED LINES (ADR-0035 / ⑥治理):
//   - Three-axis orthogonality: PURE READ. This module never writes any axis.
//   - Proposed edges stay PROPOSE-ONLY: the dense half reads ONLY live edges (via the
//     untouched learnableFrontierResolved), so a proposed edge can never pollute the live
//     frontier. The propose half reads proposed edges SEPARATELY and tags them
//     propose+lowConf — they are surfaced as suggestions, never folded into the live set.
//   - ⑥ governance: reasons + bands are QUALITATIVE (prereq COUNTS / proposed-prereq
//     NAMES + the discrete BandChip), never bare mastery probabilities.
//
// YUK-1571 — this module also OWNS the complete learnable-frontier graph decision
// (the bounded prerequisite closure + the canonical mastery gate + the
// sparse/dense/overflow discrimination + the single-point overflow warn), moved
// verbatim from src/capabilities/practice/server/learnable-frontier.ts so the graph
// decision and its rail interpretation share one owner (and one canonical
// getMasteryProjection dependency). Practice keeps the per-day candidate cap
// (FRONTIER_MAX_ITEMS) and a compatibility shim on the old module path.

import { and, desc, eq, inArray, isNull, notLike, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';

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
/**
 * ═══ 阈值/常量联合记录（YUK-551, spec Q3；docs/design/2026-07-03-frontier-gate-spec.md §M3）═══
 * 本模块与相邻模块共有多组独立、各自服务不同消费者的阈值/常量,此前无单一 artifact 交叉引用。
 * 数值本身是各自 owner-fixed 决策,不在此改（本 docblock 是纯文档动作,零行为变更）。
 *
 *   ① masteryTone 0.67/0.45（src/capabilities/knowledge/ui/mastery-tone.ts masteryTone(),
 *      :22-27）——展示层 3-tone（good/hard/again）,驱动 MasteryRing 环色。⚠️ 这对数值**不是**
 *      孤立常量,而是 S5/YUK-335 跨三个展示面的**统一点**:ring disc(masteryTone) + decay pill
 *      (NodeDrawer.tsx decayCue(), :36) + legend,专门修一个「~43% 节点环上读 good/黄、衰减
 *      pill 读 again/红」的分裂（audit §3.8）。任何对齐动作须三面同步,否则重开该分裂。
 *   ② MASTERED_PL_THRESHOLD=0.7 AND FRONTIER_MASTERY_MIN_EVIDENCE=4（本文件）——gate 层复合判据
 *      （YUK-539）,决定 KC 是否离开 frontier 池/满足下游 prereq。注:0.67/0.45（①）与 0.7（②）
 *      在 YUK-335 是「三面统一点」的语境,②的 0.7 与①的 0.67 相差 ~0.03 是 owner-fixed 分工。
 *   ③ FRONTIER_DEPTH_LIMIT=16 / FRONTIER_NODE_CAP=10_000（本文件）——闭包 fail-safe,与①②语义
 *      无关,纯 SQL 递归防爆界（overflow→[] + Q1 单点 warn）。
 *
 * ①②读同一个 getMasteryProjection() 标量但独立评估——一个 KC 可能在 MasteryRing 上显示「好」
 * （①）同时未过 frontier 门（②,evidence 不够）。是否对齐①②是 owner 决策,且对齐 = 三面回改
 * （①统一点）,本文件默认保留独立分工。
 *
 * p(L) 的构念（防 BKT 名字撞车,spec Q3b）:本项目 p(L) = σ(PFA logit),是**recall 概率的点
 * 估计**,NOT BKT 的 P(learned) 后验（对二值掌握潜变量）,尽管共用「p(L)」记号。故 BKT/
 * Cognitive-Tutor 惯例 0.95（及老 Khan 0.94）**off-scale、不迁移**到本门。置信度在本项目住在
 * band(lo/hi) + FRONTIER_MASTERY_MIN_EVIDENCE,不在抬高 p(L) 阈值上——这正是「提高置信要求」的
 * 正确落点是 evidence floor 而非更高 p(L) 的原因。故「0.7 是否向 0.95 靠拢」在构念上 malformed。
 *
 * evidence-floor × 单题出题的交互（spec Q5/⑤）:frontier 尾对每 KC 取恰一道题
 * （stream-store.ts collectComposerInputs, orderBy(question.id).limit(1)）。对 ≤floor 题的薄
 * 编排/冷启 KC,同一题跨日反复出现,evidence_count 靠**重复暴露同一 item** 爬满——它数尝试量非
 * 证据独立性。故在冷启薄编排场景,floor 大多只买到「同一题多做一次」,而非多题印证。这是
 * authoring-supply/refill 路径（单独 owner）的输入,非本门可修——记此以免被误读为「floor 已
 * 保证 diverse 证据」。
 */

/** p(L) at/above which a KC counts as MASTERED (self-not-mastered + prereq-mastered gate).
 *  ⚠️ Never compare raw p(L) against this alone for a mastered/frontier decision — use
 *  `isMasteredForFrontier` below, which ANDs the FRONTIER_MASTERY_MIN_EVIDENCE floor
 *  (YUK-539: p(L)-only comparison re-opens the "3 lucky corrects = mastered" defect). */
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

type FrontierClosureRow = {
  frontier_kc: string;
  prereq_kc: string;
  depth: number | string;
};

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
 * learn now: self NOT masteredEnough (p(L) < MASTERED_PL_THRESHOLD OR evidence_count <
 * FRONTIER_MASTERY_MIN_EVIDENCE) AND every transitive prerequisite IS masteredEnough
 * (YUK-539). `sparse` / `overflow` carry `ids: []` (see the INVARIANT BLOCK).
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
  if (depthOverflow || nodeOverflow) {
    // YUK-551 (spec Q1) — 闭包撞 depth/node-cap fail-safe,frontier 整体坍缩为空;与
    // 「稀疏图无 prereq 边」的 sparse 态语义完全不同(前者图过密/病态,后者冷启预期态)。
    // 在此**单点** emit,让全部三个消费点(composer 经 learnableFrontier 薄壳、FrontierRail
    // 经 frontier-read.ts loadFrontierRail、nightly 经 kind 分支)一次继承可观测性——不往各
    // caller 手抄(此前 stream-store 与 frontier-read 两处各自把 overflow 无差别坍缩成空、零日志)。
    // console.warn 不是 DB 写,不破坏本模块 PURE-READ 不变量(INVARIANT BLOCK「no writes」指
    // DB 写)。不 dedup:overflow 是持久图病态非瞬态,跨消费点(含 per-answer reRankAfterAnswer)的
    // 重复 warn 即为告警音量,「首次发生即可观测」。今天从未真实触发(n=1 稀疏图);若生产观测到,
    // 升级为结构化 meta 传播 + UI 暴露(见 docs/design/2026-07-03-frontier-gate-spec.md §Q1)。
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

const RELATION_PREREQUISITE = 'prerequisite' as const;

/** Cap on rail items (dense first, then propose). A UI banner, not the full set. */
export const FRONTIER_RAIL_MAX_ITEMS = 8;

/**
 * Scan cap on the pending-propose-edge query (OCR). This feeds a ≤8-item UI banner — unlike
 * loadPendingEdgeProposalKeys it does NOT need the full cross-batch dedup set. frontier_fill
 * caps proposals/run and dedups pending pairs, so a mature graph stays well under this; the
 * LIMIT is degenerate-defense against unbounded accumulation, not a business cap.
 */
const FRONTIER_PROPOSE_SCAN_CAP = 100;

/** Proposed-prereq NAMES shown verbatim in a propose reason before collapsing to "等 N 项". */
const PROPOSE_REASON_NAME_CAP = 2;

/** Char cap for the LLM-`reasoning` fallback shown when no prereq names survive. */
const PROPOSE_LLM_REASON_CAP = 40;

/**
 * One FrontierRail card. The mastery-band fields ({@link MasteryBandInput} shape:
 * `mastery` / `mastery_lo` / `mastery_hi` / `low_confidence` / `evidence_count`) are
 * spread FLAT so the UI can pass the whole item straight to `<BandChip input={item} />`
 * (structural subtyping — same wiring KnowledgePage uses for tree rows).
 */
export interface FrontierRailItem {
  kid: string;
  name: string;
  /** Qualitative "why you can learn this" string (counts / names — never a probability). */
  reason: string;
  /** true → a cold-start PROPOSED (non-live) prerequisite suggestion ("建议·低置信"). */
  propose: boolean;
  /** Suggestion-level low-confidence flag (set with `propose`); distinct from the band's. */
  lowConf: boolean;
  // ── mastery-band fields (MasteryBandInput) — consumed by BandChip ──
  mastery: number | null;
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
}

/** A pending (unrated, non-folded) proposed prerequisite edge `from→to` + its reasoning. */
interface PendingPrereqProposal {
  from: string;
  to: string;
  reason: string | null;
}

// 措辞红线（YUK-551 spec §Q6；Cosyn et al. 2021 JMP 实证 outer-fringe 首答正确率仅 ~27%）:
// frontier 是「结构可达」信号,不是「容易/该会/正确率高」信号——不要在这段 reason 文案引入
// 后者措辞。详见 docs/design/2026-07-03-frontier-gate-spec.md §Q6。
/** Dense-half reason: every prereq is mastered by the gate, so it is a deterministic count. */
function denseReason(prereqCount: number): string {
  return prereqCount > 0 ? `已掌握全部 ${prereqCount} 个前置` : '前置条件为空';
}

/** Propose-half reason: the proposed (unconfirmed) prerequisite NAMES that suggest this KC. */
function proposeReason(prereqNames: string[], llmReason: string | null): string {
  if (prereqNames.length === 0) {
    // 前置名全缺席（归档/未知）→ 回落 frontier_fill 写的 LLM reasoning（更有信息量，消死字段，
    // reviewer minor），它也缺才用泛化串。clamp 防过长撑卡。
    if (!llmReason) return 'AI 提议的下一步 · 待确认';
    const clamped =
      llmReason.length > PROPOSE_LLM_REASON_CAP
        ? `${llmReason.slice(0, PROPOSE_LLM_REASON_CAP)}…`
        : llmReason;
    return `AI 提议：${clamped} · 待确认`;
  }
  const shown = prereqNames.slice(0, PROPOSE_REASON_NAME_CAP).join('、');
  const extra = prereqNames.length > PROPOSE_REASON_NAME_CAP ? ` 等 ${prereqNames.length} 项` : '';
  return `AI 提议前置：${shown}${extra} · 待确认`;
}

/** A KC counts as mastered iff it has a projection row clearing BOTH the p(L) threshold AND
 *  the evidence-count floor (YUK-539) — a KC on 3 lucky corrects (raw p(L) ≥ 0.7 but
 *  evidence_count < 4) is NOT mastered and stays a suggestible next step. */
function isMastered(
  entry: { mastery: number | null; evidence_count: number } | undefined,
): boolean {
  return (
    typeof entry?.mastery === 'number' && isMasteredForFrontier(entry.mastery, entry.evidence_count)
  );
}

/**
 * Pending PROPOSED prerequisite edges — propose events for knowledge_edge with no chained
 * `rate` (accept/dismiss) and not folded (rubric/topology rejected). Mirrors
 * loadPendingEdgeProposalKeys' filters (propose_edge.ts) but returns full payloads (from /
 * to / reasoning) and narrows to `relation_type='prerequisite'`. Pure READ.
 */
async function loadPendingPrereqProposals(db: Db): Promise<PendingPrereqProposal[]> {
  const proposeRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'propose'),
        eq(event.subject_kind, 'knowledge_edge'),
        // SQL-filter to prerequisite up front (relation_type is flattened to the top-level
        // event payload by eventShapeForProposal's knowledge_edge case) → load ONLY prereq
        // proposals, not ALL knowledge_edge proposals then JS-filter (OCR perf).
        sql`(${event.payload}->>'relation_type') = ${RELATION_PREREQUISITE}`,
        // Exclude rubric-rejected / topology-rejected FOLDS (terminal, not live-pending).
        // These mirror loadPendingEdgeProposalKeys (propose_edge.ts, RB-7 / ADR-0034 §2) —
        // KEEP IN SYNC. follow-up (OCR): extract a shared predicate helper to prevent drift.
        sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
        sql`(${event.payload}->'topology_verdict'->>'status') IS DISTINCT FROM 'reject'`,
      ),
    )
    // 次级 tiebreaker desc(event.id)：frontier_fill 紧循环多个 writeAiProposal 可撞 ms
    // （本仓库刚为 ms-collision flake 加固过 qb 测），无 tiebreaker 则 >8-cap 时「哪 8 个显示」
    // 非确定（reviewer nit）。
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(FRONTIER_PROPOSE_SCAN_CAP);

  if (proposeRows.length === 0) return [];

  // Drop proposals already decided (an accept/dismiss writes a `rate` event chained via
  // caused_by_event_id) — an accepted edge becomes LIVE (excluded again downstream).
  const proposeIds = proposeRows.map((r) => r.id);
  const rateRows = await db
    .select({ caused_by_event_id: event.caused_by_event_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'knowledge_edge'),
        inArray(event.caused_by_event_id, proposeIds),
      ),
    );
  const rated = new Set(
    rateRows.map((r) => r.caused_by_event_id).filter((id): id is string => id !== null),
  );

  const out: PendingPrereqProposal[] = [];
  for (const row of proposeRows) {
    if (rated.has(row.id)) continue;
    const p = row.payload as {
      from_knowledge_id?: unknown;
      to_knowledge_id?: unknown;
      relation_type?: unknown;
      reasoning?: unknown;
    };
    // relation_type already SQL-filtered to prerequisite above; just guard from/to presence.
    if (typeof p.from_knowledge_id !== 'string' || typeof p.to_knowledge_id !== 'string') continue;
    out.push({
      from: p.from_knowledge_id,
      to: p.to_knowledge_id,
      reason: typeof p.reasoning === 'string' ? p.reasoning : null,
    });
  }
  return out;
}

/** `to_knowledge_id`s that already have a LIVE (non-archived) prerequisite edge. */
async function loadLivePrereqCoveredIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ to: knowledge_edge.to_knowledge_id })
    .from(knowledge_edge)
    .where(
      and(
        eq(knowledge_edge.relation_type, RELATION_PREREQUISITE),
        isNull(knowledge_edge.archived_at),
      ),
    );
  return new Set(rows.map((r) => r.to));
}

/** Names for non-archived KC ids (archived/unknown ids are absent → caller drops them). */
async function loadKcNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(
      and(
        inArray(knowledge.id, ids),
        isNull(knowledge.archived_at),
        notLike(knowledge.id, 'synthetic:%'),
        notLike(knowledge.id, 'seed:%:root'),
      ),
    );
  return new Map(
    rows.filter((row) => isLearnerVisibleKnowledgeId(row.id)).map((r) => [r.id, r.name]),
  );
}

/**
 * loadFrontierRail — the FrontierRail read model. Pure READ; see the RED LINES header.
 *
 * Dense items take priority; propose items fill remaining slots up to
 * {@link FRONTIER_RAIL_MAX_ITEMS}. Returns [] on a fully cold-start graph with no pending
 * proposals (the UI renders an honest empty state, not a fabricated next step).
 */
export async function loadFrontierRail(db: Db): Promise<FrontierRailItem[]> {
  // ── DENSE half — live prereq-gated frontier (untouched live-only computation) ──
  const resolved = await learnableFrontierResolved(db);
  const denseIds = resolved.kind === 'dense' ? resolved.ids : [];
  const prereqsByFrontier = resolved.prereqsByFrontier ?? new Map<string, string[]>();
  const denseSet = new Set(denseIds);

  // ── PROPOSE half — cold-start proposed (non-live) prereq edges → suggested next steps ──
  const proposals = await loadPendingPrereqProposals(db);
  const proposeByTo = new Map<string, { froms: Set<string>; reason: string | null }>();
  for (const p of proposals) {
    const entry = proposeByTo.get(p.to) ?? { froms: new Set<string>(), reason: null };
    entry.froms.add(p.from);
    if (entry.reason === null && p.reason !== null) entry.reason = p.reason;
    proposeByTo.set(p.to, entry);
  }
  // Keep the propose half to TRUE cold-start KCs: drop any `to` already covered by a live
  // prereq edge (it is either in the dense frontier or gated out of it — not a cold-start
  // suggestion). This reconstructs frontier_fill_nightly's candidate set (KCs lacking live
  // prereq coverage) and keeps proposed/live halves disjoint.
  const liveCovered = await loadLivePrereqCoveredIds(db);
  for (const to of [...proposeByTo.keys()]) {
    if (liveCovered.has(to) || denseSet.has(to)) proposeByTo.delete(to);
  }
  const proposeIds = [...proposeByTo.keys()];

  // ── bands (BandChip) + names, batched once over both halves ──
  const surfacedIds = [...denseIds, ...proposeIds];
  const fromIds = new Set<string>();
  for (const entry of proposeByTo.values()) for (const f of entry.froms) fromIds.add(f);
  const nameIds = [...new Set([...surfacedIds, ...fromIds])];

  const [projection, nameById] = await Promise.all([
    getMasteryProjection(db, surfacedIds),
    loadKcNames(db, nameIds),
  ]);

  // self-not-mastered gate for propose candidates (never suggest an already-mastered KC).
  const proposeFinal = proposeIds.filter((id) => !isMastered(projection.get(id)));

  const bandFields = (
    kid: string,
  ): Omit<FrontierRailItem, 'kid' | 'name' | 'reason' | 'propose' | 'lowConf'> => {
    const proj = projection.get(kid);
    return {
      mastery: proj?.mastery ?? null,
      mastery_lo: proj?.mastery_lo ?? null,
      mastery_hi: proj?.mastery_hi ?? null,
      low_confidence: proj?.low_confidence ?? false,
      evidence_count: proj?.evidence_count ?? 0,
    };
  };

  const items: FrontierRailItem[] = [];

  for (const kid of denseIds) {
    const name = nameById.get(kid);
    if (name === undefined) continue; // archived / unknown KC → drop silently.
    items.push({
      kid,
      name,
      reason: denseReason(prereqsByFrontier.get(kid)?.length ?? 0),
      propose: false,
      lowConf: false,
      ...bandFields(kid),
    });
  }

  for (const kid of proposeFinal) {
    const name = nameById.get(kid);
    if (name === undefined) continue;
    const froms = [...(proposeByTo.get(kid)?.froms ?? [])];
    const fromNames = froms.map((f) => nameById.get(f)).filter((n): n is string => n !== undefined);
    items.push({
      kid,
      name,
      reason: proposeReason(fromNames, proposeByTo.get(kid)?.reason ?? null),
      propose: true,
      lowConf: true,
      ...bandFields(kid),
    });
  }

  return items.slice(0, FRONTIER_RAIL_MAX_ITEMS);
}
