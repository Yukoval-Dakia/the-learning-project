// B1-W1 — single-owner of `mastery_state` (ADR-0035 决定#2，对称 fsrs/state.ts).
//
// Per ADR-0035: `mastery_state` is the p(L) diagnostic projection (θ̂ + PFA
// success/fail counts) per knowledge node. It is the SECOND review axis,
// orthogonal to the FSRS R-axis (material_fsrs_state) — three-axis orthogonality
// red line (ADR-0035). This module is the ONLY allowed writer of this table in
// src/server/ + app/ (step9-invariant-audit.test.ts enforces it).
//
// 写路径：submit.ts / paper-submit.ts 的 attempt tx 内调 updateThetaForAttempt
// （同 tx，不新开事务，守 hermetic）。

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import { newId } from '@/core/ids';
import { PFA_GAMMA, PFA_RHO, pLearnedBand, pfaLogit } from '@/core/pfa';
import {
  DIFFICULTY_PROXY_WEIGHT,
  ELO_K_GLOBAL,
  HIERARCHICAL_ELO_ENABLED,
  SRT_ENABLED,
  conjunctiveCredits,
  conjunctiveCreditsContinuous,
  difficultyToLogitB,
  eloK,
  resolveSrtTimeLimit,
  srtOutcome,
  thetaSe,
  updateThetaPrecision,
} from '@/core/theta';
import {
  THETA_GRID_ENABLED,
  type ThetaGridPosterior,
  gridUpdate,
  uniformPrior,
} from '@/core/theta-grid';
import type { Db, Tx } from '@/db/client';
import { item_calibration, mastery_state } from '@/db/schema';
import { resolveFamilyKeyForQuestion } from './family-key';
import { effectiveFamilyB, getFamilyCalibration } from './personalized-difficulty';
import { effectiveB } from './recalibration';

type DbLike = Db | Tx;

// A2 (YUK-434) — per-domain global ability θ_global storage. We REUSE mastery_state
// (zero new tables/columns): a θ_global row has subject_kind = ABILITY_GLOBAL_KIND
// and subject_id = the KC's effective_domain id. One row per domain the learner has
// touched. subject_id is a DOMAIN id here (not a KC id) — the (subject_kind,
// subject_id) unique index keeps the per-(kind,id) keying clean and orthogonal to
// the 'knowledge' per-KC rows (no collision: a KC id and a domain id live in
// different subject_kind partitions). When HIERARCHICAL_ELO_ENABLED=false NO global
// row is ever read or written, so this kind never appears in the table (dark-ship).
const ABILITY_GLOBAL_KIND = 'ability_global';

export interface MasteryStateRow {
  subject_kind: string;
  subject_id: string;
  theta_hat: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  last_outcome_at: Date | null;
  // YUK-361 Phase 2 — 累积 Fisher information（SE 从此派生，见 thetaSe）+ 上次 Δθ̂。
  theta_precision: number;
  last_theta_delta: number | null;
}

export interface UpsertMasteryStateInput {
  subject_kind?: string; // default 'knowledge'
  subject_id: string;
  theta_hat: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  last_outcome_at: Date;
  // YUK-361 Phase 2 — 默认让 upsert 维持既有 precision/delta 语义（不传则不更新）。
  theta_precision?: number;
  last_theta_delta?: number | null;
  // A4 (YUK-436) — 离散网格贝叶斯 θ_KC offset 后验的 SHADOW 持久化。可选（同 precision/delta
  // 语义）：只有 caller 显式传值时才写。INSERT 缺省 → DB default NULL；UPDATE 缺省 → 不动此列。
  // inc-1 PURE-ADDITIVE SHADOW：写路径存在但**无 inc-1 下游读者**（不喂 p(L)/effectiveB/选题）。
  theta_grid_json?: ThetaGridPosterior | null;
}

/**
 * Upsert the p(L) state projection for a knowledge node. ON CONFLICT
 * (subject_kind, subject_id) — concurrent attempts on the same KC race on the
 * `mastery_state_unique` index; the loser falls back to UPDATE in one statement.
 * Pure persistence — the θ̂ math lives in updateThetaForAttempt.
 */
export async function upsertMasteryState(
  db: DbLike,
  input: UpsertMasteryStateInput,
): Promise<void> {
  const now = new Date();
  const subjectKind = input.subject_kind ?? 'knowledge';
  // YUK-361 Phase 2 — precision/delta 是可选维护：只有 caller 显式传值时才写。
  //   INSERT 缺省走 DB default（theta_precision=1, last_theta_delta=NULL）。
  //   UPDATE 缺省不动这两列（既有 upsert caller 如直接 seed 不该重置 precision）。
  // biome-ignore lint/suspicious/noExplicitAny: drizzle set 列子集动态拼装，类型在分支内已保真。
  const updateSet: Record<string, any> = {
    theta_hat: input.theta_hat,
    evidence_count: input.evidence_count,
    success_count: input.success_count,
    fail_count: input.fail_count,
    last_outcome_at: input.last_outcome_at,
    updated_at: now,
  };
  if (input.theta_precision !== undefined) {
    updateSet.theta_precision = input.theta_precision;
  }
  if (input.last_theta_delta !== undefined) {
    updateSet.last_theta_delta = input.last_theta_delta;
  }
  // A4 (YUK-436) — same optional-maintenance semantics: only write the shadow grid
  // posterior when the caller explicitly passes it (THETA_GRID_ENABLED single-KC path).
  if (input.theta_grid_json !== undefined) {
    updateSet.theta_grid_json = input.theta_grid_json;
  }
  await db
    .insert(mastery_state)
    .values({
      id: newId(),
      subject_kind: subjectKind,
      subject_id: input.subject_id,
      theta_hat: input.theta_hat,
      evidence_count: input.evidence_count,
      success_count: input.success_count,
      fail_count: input.fail_count,
      last_outcome_at: input.last_outcome_at,
      ...(input.theta_precision !== undefined ? { theta_precision: input.theta_precision } : {}),
      ...(input.last_theta_delta !== undefined ? { last_theta_delta: input.last_theta_delta } : {}),
      ...(input.theta_grid_json !== undefined ? { theta_grid_json: input.theta_grid_json } : {}),
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [mastery_state.subject_kind, mastery_state.subject_id],
      set: updateSet,
    });
}

/**
 * Read the current p(L) state row for a knowledge node, or null (cold start).
 */
export async function getMasteryState(
  db: DbLike,
  knowledgeId: string,
  subjectKind = 'knowledge',
): Promise<MasteryStateRow | null> {
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, subjectKind), eq(mastery_state.subject_id, knowledgeId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    theta_hat: row.theta_hat,
    evidence_count: row.evidence_count,
    success_count: row.success_count,
    fail_count: row.fail_count,
    last_outcome_at: row.last_outcome_at ?? null,
    theta_precision: row.theta_precision,
    last_theta_delta: row.last_theta_delta ?? null,
  };
}

/**
 * A2 (YUK-434) — read the per-domain θ_global for an ALREADY-RESOLVED domain id.
 *
 * FLAG OFF (DEFAULT): returns 0 WITHOUT touching the DB (dark-ship — no global row
 *   exists, callers add 0 → effective == θ_KC, bit-identical to today).
 * FLAG ON: reads the domain's 'ability_global' mastery_state row (null → 0).
 *
 * Use this when the caller has ALREADY resolved the raw domain string (e.g.
 * target-discovery resolves getEffectiveDomain for subjectId anyway) — it avoids a
 * second domain walk. KC-keyed callers that have NOT resolved a domain should use
 * {@link effectiveThetaForKc}, which resolves the domain for them.
 */
export async function globalThetaForDomain(db: DbLike, domain: string | null): Promise<number> {
  if (!HIERARCHICAL_ELO_ENABLED || domain === null) return 0;
  const row = await getMasteryState(db, domain, ABILITY_GLOBAL_KIND);
  return row?.theta_hat ?? 0;
}

/**
 * A2 (YUK-434) — read-side effective ability for a KC = θ_global(domain-of-KC) +
 * θ_KC, mirroring the write-path's effective-theta input.
 *
 * FLAG OFF (DEFAULT): θ_global ≡ 0 → returns `thetaKc` UNCHANGED. No domain is
 *   resolved, no global row is read — so the selection read paths are
 *   BYTE-IDENTICAL to single-layer Elo (they pass today's theta_hat straight
 *   through). This is the guarantee the regression tests pin.
 * FLAG ON: resolve the KC's effective_domain (getEffectiveDomain — the same
 *   resolver the write path uses; orphan/null-root → degrade to θ_global=0), read
 *   that domain's θ_global row (null → 0), return θ_global + thetaKc.
 *
 * `thetaKc` is the per-KC `theta_hat` (the offset) the caller already read from a
 * 'knowledge' mastery_state row (or the cold-start default). Keeping the caller's
 * already-fetched value avoids a redundant per-KC SELECT — this helper only adds the
 * (memoizable-by-caller) domain + global-row reads, and ONLY when the flag is on.
 */
export async function effectiveThetaForKc(
  db: DbLike,
  knowledgeId: string,
  thetaKc: number,
): Promise<number> {
  if (!HIERARCHICAL_ELO_ENABLED) return thetaKc; // dark-ship: bit-identical to today.
  let domain: string | null;
  try {
    domain = await getEffectiveDomain(db, knowledgeId);
  } catch {
    return thetaKc; // orphan / null-root-domain → no domain anchor → θ_global=0.
  }
  return (await globalThetaForDomain(db, domain)) + thetaKc;
}

/**
 * B1 double-truth fix — the SINGLE display/AI-facing read of mastery, derived
 * from the real `mastery_state` source of truth (NOT the deprecated
 * `knowledge_mastery` view's faked recency-weighted-success-rate +
 * `evidence_count < 3 → 0.5` placeholder).
 *
 * Batch read of the p(L) state for many knowledge nodes, projecting each row to
 * a 0..1 `mastery` via the **difficulty-aware PFA p(L)** ({@link pLearnedBand} /
 * {@link pfaLogit}: logit = γ·success + ρ·fail − β, where β is the KC's
 * representative HARD-track item difficulty), and exposing `theta_se` (from
 * `theta_precision`, default precision=1 → SE=1) for uncertainty. Returns a Map
 * keyed by knowledge id. Nodes with no `mastery_state` row (never attempted) are
 * simply ABSENT from the map — callers treat absence as cold start /
 * `mastery=null`, matching the old view's NULL (no-evidence) semantics.
 * `last_outcome_at` is the real last-attempt time (replaces the view's
 * `last_evidence_at`).
 *
 * B1 FULL path (YUK-420) — this is the LIVE difficulty-aware p(L) projection,
 *   completing the path that previously shipped only the interim σ(θ̂)@b=0
 *   point estimate:
 *     - `mastery` = p(L) point estimate = σ(γ·success + ρ·fail − β). Cold start
 *       (success=0, fail=0, β=0) → 0.5. Harder KC (larger β) lowers p(L) at fixed
 *       counts; more successes raise it; more failures lower it.
 *     - `mastery_lo` / `mastery_hi` = the ADR-0035 confidence-interval band
 *       (point logit ± theta_se, each through σ). Widens as θ̂ uncertainty grows.
 *     - `low_confidence` = true when θ̂ is still too uncertain to trust the point
 *       (theta_se ≥ the precision threshold) — presentation should show the band.
 *   `theta_hat` / `theta_precision` / `theta_se` are surfaced raw so callers keep
 *   the underlying ability state. The PFA γ/ρ coefficients are PHASE-DEFERRED
 *   hardcoded defaults pending nightly-refit statistical verification (YUK-361,
 *   see src/core/pfa.ts).
 *
 *   The CI fields are ADDITIVE — the 5 point-estimate consumers (tree / node-page
 *   / review-plan-tools / knowledge-readers / detail) read only `mastery` and are
 *   transparent to the swap; the new fields are opt-in for CI-aware surfaces.
 */
export interface MasteryProjection {
  mastery: number;
  // B1 FULL (YUK-420) — ADR-0035 confidence-interval band around the p(L) point.
  // Additive: existing consumers ignore these; CI-aware surfaces show the band.
  mastery_lo: number;
  mastery_hi: number;
  low_confidence: boolean;
  theta_hat: number;
  theta_precision: number;
  theta_se: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  last_outcome_at: Date | null;
}

export async function getMasteryProjection(
  // PR #468 finding E — display/AI read-side projection: every caller passes a
  // full Db (node-page / tree / detail / knowledge-readers / review-plan-tools all
  // hold a Db, never a Tx). Unlike getMasteryState / upsertMasteryState (which run
  // inside updateThetaForAttempt's attempt Tx and so keep DbLike), this never runs
  // in a transaction, so the param is the concrete Db — no Db|Tx ambiguity.
  db: Db,
  knowledgeIds: string[],
  subjectKind = 'knowledge',
): Promise<Map<string, MasteryProjection>> {
  const ids = Array.from(
    new Set(knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, subjectKind), inArray(mastery_state.subject_id, ids)),
    );
  // B1 FULL (YUK-420) — per-KC representative β = the KC's HARD-track item
  // difficulty (logit). β feeds the difficulty-aware p(L) (harder KC ⇒ lower p(L)
  // at fixed counts). KCs with no anchored hard-track item → β=0 (neutral
  // difficulty origin), so cold-start / unanchored KCs project exactly as before
  // (σ at b=0). Only KCs that HAVE a mastery_state row need a β (others are absent
  // from the map), so we resolve β only for the rows we actually project.
  const betaByKc = await getRepresentativeKcBeta(
    db,
    rows.map((r) => r.subject_id),
  );
  return new Map(
    rows.map((row) => {
      const beta = betaByKc.get(row.subject_id) ?? 0;
      const se = thetaSe(row.theta_precision);
      // logit(p(L)) = γ·success + ρ·fail − β (ADR-0035 sign convention; β enters
      // negatively so harder items lower p(L) — see src/core/pfa.ts).
      const pointLogit = pfaLogit(beta, PFA_GAMMA, PFA_RHO, row.success_count, row.fail_count);
      // CI band on the logit scale ± theta_se, each through σ (ADR-0035
      // confidence-interval / low-confidence presentation).
      const band = pLearnedBand(pointLogit, se);
      return [
        row.subject_id,
        {
          mastery: band.point,
          mastery_lo: band.lo,
          mastery_hi: band.hi,
          low_confidence: band.lowConfidence,
          theta_hat: row.theta_hat,
          theta_precision: row.theta_precision,
          theta_se: se,
          evidence_count: row.evidence_count,
          success_count: row.success_count,
          fail_count: row.fail_count,
          last_outcome_at: row.last_outcome_at ?? null,
        },
      ];
    }),
  );
}

/**
 * B1 FULL (YUK-420) — resolve a representative HARD-track item difficulty (β, on
 * the logit b-scale) per knowledge node, for the difficulty-aware p(L).
 *
 * Representative-b choice (documented): a KC is carried by MANY questions, each
 * possibly anchored by a HARD-track `item_calibration` row. There is no single
 * "the KC's b"; we summarise across the KC's hard-track items using the **MEDIAN**
 * of each item's effective b = COALESCE(b_calib, b_anchor, b) — the same read
 * order as {@link effectiveB} (de-biased b_calib first, then cold-start anchor
 * b_anchor, then the legacy b column). Median (not mean) is robust to a single
 * mis-anchored outlier item skewing the KC difficulty. SOFT-track rows are
 * EXCLUDED (ADR-0035: soft track never reaches p(L)/scheduling). Items with no
 * effective b at all are skipped; a KC with no anchored hard-track item gets NO
 * entry → caller defaults β=0 (neutral difficulty origin, identical to the old
 * σ(θ̂)@b=0 projection for unanchored KCs).
 *
 * READ-ONLY — pure SELECT against question.knowledge_ids (GIN @>) ⋈ item_calibration;
 * never writes any b column (item-half locked, G4).
 */
async function getRepresentativeKcBeta(
  db: Db,
  knowledgeIds: string[],
): Promise<Map<string, number>> {
  const ids = Array.from(new Set(knowledgeIds.filter((id) => id.length > 0)));
  if (ids.length === 0) return new Map();
  // For each requested KC, find questions carrying it (knowledge_ids @> '["<kc>"]',
  // hitting the question_knowledge_ids_gin index), join their HARD-track
  // item_calibration, and take the median effective b. unnest(<ids>) drives the
  // per-KC grouping; jsonb_build_array(kc) keeps the GIN containment predicate
  // index-friendly per KC. The id list is parameter-bound (sql.join), not string-
  // interpolated — no injection surface.
  const idParams = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT
      kc,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY COALESCE(ic.b_calib, ic.b_anchor, ic.b)
      ) AS beta
    FROM unnest(ARRAY[${idParams}]::text[]) AS kc
    JOIN question q ON q.knowledge_ids @> jsonb_build_array(kc)
    JOIN item_calibration ic ON ic.question_id = q.id
      AND ic.track = 'hard'
      AND COALESCE(ic.b_calib, ic.b_anchor, ic.b) IS NOT NULL
    GROUP BY kc
  `)) as unknown as Array<{ kc: string; beta: number | null }>;
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.beta !== null && r.beta !== undefined) {
      map.set(r.kc, Number(r.beta));
    }
  }
  return map;
}

export interface UpdateThetaForAttemptInput {
  /** q.knowledge_ids — every KC this question probes gets updated (PFA per-KC). */
  knowledgeIds: string[];
  /** read item_calibration.b for the anchor. */
  questionId: string;
  /** success=1, failure=0. When continuousCredit is set to a non-endpoint, PFA counts use
   *  continuousCredit >= 0.5 as success (partial 0.5 counts as success evidence). */
  outcome: 0 | 1;
  /**
   * A9 (YUK-438) — optional per-step FIXED partial-binarize credit ∈ [0,1]. When set to a
   * non-endpoint (e.g. 0.5), drives conjunctiveCreditsContinuous on the credit path while
   * leaving eloK / bWeight / Fisher math untouched. Endpoints 0/1 delegate to binary path
   * (bit-identical). Omit on the legacy single-binary attempt path.
   */
  continuousCredit?: number;
  /** fallback anchor source (1-5) when no item_calibration.b. */
  difficulty: number;
  /**
   * A1 (YUK-433) — optional response time IN MILLISECONDS (latency_ms from the
   * solo review submit). When present AND SRT_ENABLED AND d resolves, the BINARY
   * `outcome` is replaced on the credit path by a CONTINUOUS time-aware srtOutcome
   * (fast-correct moves θ̂ more than slow-correct; fast-wrong penalised harder than
   * slow-wrong). When undefined/null (paper path, or any missing-RT solo attempt)
   * the SRT path is SKIPPED → binary credit, bit-identical to today. Converted to
   * seconds at the seam to match resolveSrtTimeLimit's units.
   */
  responseTimeMs?: number | null;
  /** provenance — the attempt event id that produced this update. */
  attemptEventId: string;
  now: Date;
  /**
   * YUK-372 L3 — question.kind / question.source（family_key 解析所需）。可选：caller-less /
   * 直测不传 → 跳过家族查询 → 纯 effectiveB（NO-OP，向后兼容）。submit.ts / paper-submit.ts
   * 热路径传 q.kind / q.source 启用家族 delta 组合。
   */
  kind?: string;
  source?: string;
  /**
   * Codex review F2 — family_key 解析必须用 **question 规范 primary KC**（q.knowledge_ids[0]），
   * 而非 knowledgeIds[0]。paper submit 传 knowledgeIds=referencedKnowledgeIds（slot 的
   * primary+secondary，无 primary 回落 q.knowledge_ids），其 [0] 是 **paper slot 指派的 primary
   * KC**，可能 ≠ 题的 knowledge_ids[0]。但 family calibration 的写侧（recordFamilyObservation
   * ForAttempt）与选题读侧（candidate-signals）都按 q.knowledge_ids[0] 成键（canonical 家族基，
   * 见 personalized-difficulty.ts finding #3b 文档）。若此处用 knowledgeIds[0]，paper slot
   * primary ≠ question primary 时，family delta 的 READ 会 miss 或读到**别的** family 行 → 错配。
   * 故 caller 单独透传 question 规范 primary。
   *
   * 可选 + 回落 knowledgeIds[0]：未传（直测 / review 路径 knowledgeIds 本就是 q.knowledge_ids）
   * → 退回 knowledgeIds[0]，行为与修复前等同（review 路径 [0] 本就等于 q.knowledge_ids[0]）。
   */
  familyPrimaryKnowledgeId?: string | null;
}

/**
 * 接线层 — 一次 attempt 更新该题挂的全部 KC 的 θ̂（多 KC 加权语义）。这是热路径
 * 唯一入口。同 tx 内调用（submit.ts / paper-submit.ts）。
 *
 * 多 KC 归因语义（VERIFY:multi-kc holds_with_caveat 吸收）:
 *   - 更新全部 KC（PFA per-KC 累积，非「只更最弱」）。
 *   - 答对（outcome=1）：每 KC 等量小幅上调（答对是全 KC 弱证据，补偿型）。
 *   - 答错（outcome=0）：按 (1 - p(L_k)) 归一化分摊步长——越可能没掌握的 KC 担
 *     越多责任，已掌握 KC 受冲击小（Conjunctive-BKT 式 credit-assignment，
 *     避免「答错冤枉已掌握 KC」）。
 *
 * b 锚来源（item-半边锁死，只读不写，G4）：item_calibration.b（有 → bWeight=1）→
 *   兜底 difficultyToLogitB（弱锚 → bWeight=DIFFICULTY_PROXY_WEIGHT 降权，
 *   VERIFY:difficulty-logit-map 吸收）。
 *
 * θ̂_min 是选题聚合（ex-ante），本 wave 不实现，仅此注释留口。
 */
export async function updateThetaForAttempt(
  tx: Tx,
  input: UpdateThetaForAttemptInput,
): Promise<void> {
  const knowledgeIds = Array.from(
    new Set(input.knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  if (knowledgeIds.length === 0) return;

  // 0. Serialize the read-modify-write per KC (review SF-2). The caller's FSRS
  //    advisory lock only covers fsrsSubjectIds (a possible SUBSET of these KCs —
  //    submit.ts locks requested∩labels, paper-submit locks the slot primary
  //    only), so KCs outside that subset would do an unlocked SELECT→compute→
  //    upsert and lose a concurrent increment (onConflict overwrites with a value
  //    derived from a stale read). Take our own lock on EVERY KC we update, in the
  //    SAME `fsrs:knowledge:<id>` namespace the FSRS path uses, so same-KC attempts
  //    serialize regardless of which path holds the lock. Sorted → stable acquire
  //    order, no deadlock. Released at tx commit (we're inside the attempt tx).
  for (const id of [...knowledgeIds].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:knowledge:${id}`}))`);
  }

  // 1. Read the b anchor (item-half locked: READ-ONLY — 不变量①, G4). track='hard'
  //    only — soft track never reaches p(L)/scheduling (ADR-0035). YUK-361 Phase 6
  //    (Task 11 step 5): 读 effectiveB = b_calib ?? b_anchor ?? b（去偏 b 优先）。
  //    在线 θ̂ 路径**只 READS** effectiveB，**绝不 WRITES** b_calib（b_calib 只由批量
  //    recalibrateQuestion 写）——不变量① intact。NO-OP today：b_calib 攒够标签前 NULL，
  //    b_anchor 由 migration 0038 从既有 b 回填，故 effectiveB 当前等于原 b。
  const calRows = await tx
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
    })
    .from(item_calibration)
    .where(
      and(eq(item_calibration.question_id, input.questionId), eq(item_calibration.track, 'hard')),
    )
    .limit(1);
  const calB = effectiveB(calRows[0]);
  // Resolve the columnar b first (incl. the weak difficulty-proxy fallback), matching
  // recalibration.ts:77-81's order.
  const columnarB = calB ?? difficultyToLogitB(input.difficulty);
  // Weak difficulty-proxy anchor → down-weight the update (D2 / VERIFY). bWeight stays keyed on
  // the COLUMNAR anchor source — the family delta does NOT change the weak-anchor down-weight
  // (G4: no double down-weight; family delta is an additive shift on b, not an anchor-quality
  // change).
  const bWeight = calB !== null ? 1 : DIFFICULTY_PROXY_WEIGHT;

  // YUK-361 Phase 5 (effectiveFamilyB) — YUK-372 L3: 把家族 b_delta 叠在去偏/弱锚 b 之上
  //   b = effectiveFamilyB(columnarB, familyRow) = columnarB + shrunk_family_delta
  // G4 NO-OP-safe：家族门未过 → b_delta=0 → effectiveFamilyB 原样返回 columnarB → θ̂ bit-identical。
  // 缺 kind/source（caller-less / 直测）→ 跳过家族查询 → b = columnarB（纯 effectiveB，NO-OP）。
  // G1：家族查询是主 tx 内的纯 SELECT（无写）。subject 派生的 **orphan-domain 应用级 throw**
  //   （node-not-found / root-null-domain，SELECT 成功返回后由 new Error 抛出）被
  //   resolveFamilyKeyForQuestion 内 try/catch 兜成 'unknown'，绝不冒泡 abort θ̂。
  //   注意：若该 SELECT 本身发生**真 PG-error**（statement timeout / 序列化失败 / 连接断），tx
  //   会进 25P02 aborted 态、后续 θ̂ 写连带失败——这是**正确行为**（与本 tx 内其它裸 SELECT 同
  //   语义：连接已注定失败时整个 attempt 本就该 rollback，θ̂/FSRS/event 全 commit 或全 rollback，
  //   不存在「读失败但主写应保留」的语义）。这不是新的 tx-abort 漏洞，红线 #1 只针对 best-effort
  //   **写**毒化 tx，而非读。
  // G3：只读，绝不写任何 b。
  let b = columnarB;
  if (input.kind && input.source) {
    // Codex review F2 — family_key 用 **question 规范 primary KC**（caller 透传的
    // familyPrimaryKnowledgeId = q.knowledge_ids[0]），回落 knowledgeIds[0]。paper submit 的
    // knowledgeIds[0] 是 slot 指派的 primary，可能 ≠ 题 primary；family 写/读两侧都按
    // q.knowledge_ids[0] 成键，用 slot primary 会让 family delta READ 错配别的 family（或 miss）。
    const familyPrimaryKnowledgeId = input.familyPrimaryKnowledgeId ?? knowledgeIds[0];
    const familyKey = await resolveFamilyKeyForQuestion(tx, {
      primaryKnowledgeId: familyPrimaryKnowledgeId,
      kind: input.kind,
      source: input.source,
    });
    if (familyKey !== null) {
      const familyRow = await getFamilyCalibration(tx, familyKey);
      b = effectiveFamilyB(columnarB, familyRow);
    }
  }

  // 2. Read every KC's current state (null → cold start: θ=0, counts=0).
  const existing = await tx
    .select()
    .from(mastery_state)
    .where(
      and(
        eq(mastery_state.subject_kind, 'knowledge'),
        inArray(mastery_state.subject_id, knowledgeIds),
      ),
    );
  const byId = new Map(existing.map((r) => [r.subject_id, r]));
  const states = knowledgeIds.map((id) => {
    const row = byId.get(id);
    return {
      id,
      theta: row?.theta_hat ?? 0,
      evidence: row?.evidence_count ?? 0,
      success: row?.success_count ?? 0,
      fail: row?.fail_count ?? 0,
      // YUK-361 Phase 2 — 冷启 precision = 1（弱先验 1 单位信息，SE=1），同 DB default。
      precision: row?.theta_precision ?? 1,
      // A4 (YUK-436) — PRE-attempt shadow grid posterior over the θ_KC offset (null →
      // never folded → cold-start uniform prior). Captured here from the SAME pre-attempt
      // read used for the Elo update, so the sequential-Bayes fold below continues the
      // running posterior rather than re-starting it. Shadow-only — never read by any
      // inc-1 decision/display path.
      gridPrior: (row?.theta_grid_json as ThetaGridPosterior | null | undefined) ?? null,
    };
  });

  // ── A2 (YUK-434) — hierarchical Elo: resolve each KC's per-domain θ_global ───
  //
  // FLAG OFF (DEFAULT, dark-ship): θ_global ≡ 0 for every KC. No domain is resolved,
  //   no global row is read or written. domainOfKc / globalThetaOfDomain stay empty.
  //   The per-KC `theta` below IS the effective theta (offset == ability), so credits
  //   + the per-KC update path are BYTE-IDENTICAL to single-layer Elo.
  // FLAG ON: resolve each touched KC's effective_domain (memoized — each unique KC
  //   domain resolved at most once via getEffectiveDomain, the SAME domain resolver
  //   the family-key write path above already uses inside this attempt tx, ≤32-hop
  //   parent-chain point lookups). Read that domain's θ_global row (null → cold-start
  //   θ_global = 0). effectiveTheta_k = θ_global(domain_k) + θ_KC_k.
  //
  // domainResolveFailed (orphan / null-root-domain id — getEffectiveDomain throws):
  //   we degrade that KC to θ_global = 0 (treat the KC as its own anchor, identical
  //   to the single-layer path) rather than aborting the whole attempt — matches the
  //   family-key path's orphan→'unknown' graceful-degrade philosophy. The KC still
  //   updates its θ_KC; it simply does not inherit/contribute to any domain anchor.
  const domainOfKc = new Map<string, string | null>(); // KC id → resolved domain id (null = unresolved)
  const globalThetaOfDomain = new Map<string, number>(); // domain id → current θ_global (0 if no row)
  if (HIERARCHICAL_ELO_ENABLED) {
    // Memoized per-KC domain resolution (unique domains read their global row once).
    for (const id of knowledgeIds) {
      let domain: string | null = null;
      try {
        domain = await getEffectiveDomain(tx, id);
      } catch {
        domain = null; // orphan / null-root-domain → no domain anchor for this KC.
      }
      domainOfKc.set(id, domain);
      if (domain !== null && !globalThetaOfDomain.has(domain)) {
        const grow = await getMasteryState(tx, domain, ABILITY_GLOBAL_KIND);
        globalThetaOfDomain.set(domain, grow?.theta_hat ?? 0); // null → cold-start θ_global=0
      }
    }
  }
  // effectiveTheta_k = θ_global(domain_k) + θ_KC_k. Flag off (or unresolved domain)
  // → θ_global = 0 → effectiveTheta == θ_KC == today's theta (bit-identical input).
  const globalOf = (kcId: string): number => {
    const domain = domainOfKc.get(kcId) ?? null;
    return domain !== null ? (globalThetaOfDomain.get(domain) ?? 0) : 0;
  };
  const effectiveThetas = states.map((s) => s.theta + globalOf(s.id));

  // 3. 多 KC 合取 credit（owner 拍板 MLE，review SF-1）。conjunctiveCredits 直接
  //    返回每 KC 的 log 似然梯度项（题目级 surprise × (1−p_k) 灵敏度），取代旧的
  //    per-KC 残差权重（两端抵消、弱 KC 答错不降的反向 bug）。单 KC 退化为标准 Elo。
  //
  // A1 (YUK-433) — SRT gate. ALL THREE must hold to take the continuous path,
  // else we use the BINARY outcome bit-identically (NO-OP regression):
  //   (a) SRT_ENABLED (module const, default false this PR → dark-ship);
  //   (b) responseTimeMs is a finite number (paper path passes nothing → binary;
  //       any missing/NaN/negative-or-not RT → binary);
  //   (c) d resolves > 0 (resolveSrtTimeLimit always does for the difficulty map).
  // The continuous srtOutcome ∈ [0,1] then drives conjunctiveCreditsContinuous,
  // which is BIT-IDENTICAL to conjunctiveCredits at the binary endpoints. The eloK
  // step, bWeight, the b anchor, and the precision/Fisher math below are ALL
  // untouched — SRT modulates ONLY the per-KC credit value.
  // Units: latency arrives in MILLISECONDS; convert to SECONDS to match d.
  //
  // A2 (YUK-434) — the credit formula is UNCHANGED; only the θ INPUT becomes the
  //   EFFECTIVE theta (θ_global(domain) + θ_KC). Flag off → effectiveThetas ===
  //   states.map(s=>s.theta) elementwise (θ_global≡0), so this is bit-identical to
  //   single-layer Elo. conjunctiveCredits / conjunctiveCreditsContinuous, eloK,
  //   bWeight, srtOutcome, and the precision/Fisher math are all untouched.
  const rtMs = input.responseTimeMs;
  const useSrt = SRT_ENABLED && typeof rtMs === 'number' && Number.isFinite(rtMs);
  const rawContinuous = input.continuousCredit;
  const hasContinuous =
    typeof rawContinuous === 'number' &&
    Number.isFinite(rawContinuous) &&
    rawContinuous >= 0 &&
    rawContinuous <= 1;
  const continuousCredit = hasContinuous ? rawContinuous : null;
  /** PFA success/fail tallies — partial 0.5 counts as success (>= 0.5 threshold). */
  const countOutcome: 0 | 1 =
    continuousCredit !== null && continuousCredit !== 0 && continuousCredit !== 1
      ? continuousCredit >= 0.5
        ? 1
        : 0
      : input.outcome;
  let credits: number[];
  if (useSrt) {
    const d = resolveSrtTimeLimit(input.difficulty); // seconds (module const)
    const tSeconds = (rtMs as number) / 1000; // ms → s
    const srt = srtOutcome(input.outcome === 1, d, tSeconds); // ∈ [0,1]
    credits = conjunctiveCreditsContinuous(effectiveThetas, b, srt);
  } else if (continuousCredit !== null && continuousCredit !== 0 && continuousCredit !== 1) {
    credits = conjunctiveCreditsContinuous(effectiveThetas, b, continuousCredit);
  } else {
    credits = conjunctiveCredits(effectiveThetas, b, input.outcome);
  }

  // 4 + 5. Per-KC update + upsert. θ_KC += k · bWeight · credit_k（弱锚 bWeight 降权）。
  //
  // A2 (YUK-434) — this is now the per-KC OFFSET update (θ_KC), not the whole ability:
  //   the global-layer drift is applied SEPARATELY below (once per domain). The step
  //   itself is UNCHANGED — same eloK(s.evidence), same bWeight, same credits[i]. Flag
  //   off → θ_global≡0 → θ_KC IS the ability → byte-identical to single-layer Elo.
  //   Precision/Fisher stays on the KC layer at thetaBefore = s.theta (the KC offset,
  //   layer-independent — constraint iii: precision UNCHANGED, RT/layer-independent).
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    const k = eloK(s.evidence);
    const newTheta = s.theta + k * bWeight * credits[i];
    // YUK-361 Phase 2 — 累积 θ precision，用与 θ̂ 更新**同一个 b 锚 + 同一 bWeight**
    //   喂 Fisher information（弱锚 bWeight=0.3 → weight² 降权，信息增量小）。
    //   thetaBefore=s.theta（信息在 θ̂ 移动前的位置评估，与梯度同步）。A2: stays on the
    //   KC layer at s.theta (the offset) — NOT the effective theta — so it is
    //   bit-identical with the flag off and layer-independent with it on.
    const newPrecision = updateThetaPrecision(s.precision, s.theta, b, bWeight);
    const delta = newTheta - s.theta;
    await upsertMasteryState(tx, {
      subject_id: s.id,
      theta_hat: newTheta,
      evidence_count: s.evidence + 1,
      success_count: s.success + (countOutcome === 1 ? 1 : 0),
      fail_count: s.fail + (countOutcome === 0 ? 1 : 0),
      last_outcome_at: input.now,
      theta_precision: newPrecision,
      last_theta_delta: delta,
    });
  }

  // ── A2 (YUK-434) — per-domain θ_global drift (ONCE per touched domain) ──────────
  //
  // FLAG OFF: nothing here runs (HIERARCHICAL_ELO_ENABLED gate) → no global row is
  //   ever written → table never gains an 'ability_global' row (dark-ship, the read
  //   paths see no rows → effective == θ_KC everywhere). BYTE-IDENTICAL to today.
  // FLAG ON: each touched domain's θ_global drifts SLOWLY (ELO_K_GLOBAL ≪ eloK floor)
  //   by the AGGREGATED credit of THAT domain's KCs (mean of the per-KC credits in the
  //   domain — a multi-KC item in one domain still moves that domain's global ONCE,
  //   not N times; a multi-DOMAIN item moves EACH touched domain's global ONCE). The
  //   credit signal is the SAME credits[] vector used for the per-KC update (binary or
  //   SRT-continuous, composing with A1). bWeight is applied identically to the per-KC
  //   step so a weak-anchor attempt drifts the global slower too.
  if (HIERARCHICAL_ELO_ENABLED) {
    // Group the per-KC credits by resolved domain (unresolved-domain KCs contribute to
    // no global row — see domainResolveFailed degrade above).
    const creditsByDomain = new Map<string, number[]>();
    for (let i = 0; i < states.length; i++) {
      const domain = domainOfKc.get(states[i].id) ?? null;
      if (domain === null) continue;
      const list = creditsByDomain.get(domain) ?? [];
      list.push(credits[i]);
      creditsByDomain.set(domain, list);
    }
    // Sorted domain order → stable advisory-lock acquire order across concurrent
    // multi-domain attempts (no deadlock cycle), mirroring the per-KC sorted-lock above.
    for (const domain of [...creditsByDomain.keys()].sort()) {
      const domainCredits = creditsByDomain.get(domain) as number[];
      // Aggregate = MEAN of that domain's KC credits → the domain global is updated
      // exactly ONCE per attempt regardless of how many of its KCs the item touched.
      const aggregateCredit = domainCredits.reduce((acc, c) => acc + c, 0) / domainCredits.length;
      // Serialize the θ_global row under the SAME advisory-lock scheme as the per-KC
      // rows, in a stable per-domain-global namespace, so concurrent attempts on
      // different KCs of the same domain do not lose a global increment (n=1 single-
      // user contention is ~nil, but the lock keeps the invariant honest). Released at
      // tx commit (we are inside the attempt tx). Acquired here (after the per-KC locks
      // above, which are sorted) — domain-global keys are a DISJOINT namespace from
      // the per-KC `fsrs:knowledge:<id>` keys, so no new deadlock cycle is introduced.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`mastery:ability_global:${domain}`}))`,
      );
      // Re-read under the lock so a concurrent same-domain attempt's increment is not
      // lost (the pre-lock read used for effective theta may be stale). NULL → 0.
      const lockedRow = await getMasteryState(tx, domain, ABILITY_GLOBAL_KIND);
      const lockedGlobal = lockedRow?.theta_hat ?? 0;
      const lockedNewGlobal = lockedGlobal + ELO_K_GLOBAL * bWeight * aggregateCredit;
      // θ_global rows REUSE mastery_state with subject_kind=ABILITY_GLOBAL_KIND and
      // subject_id=domain. evidence/success/fail counts are NOT meaningful at the
      // global layer (the p(L)/PFA projection only reads 'knowledge' rows), so we keep
      // them as a plain attempt tally (evidence_count) and leave success/fail at the
      // binary integers they would carry — NOT used by any reader, but kept binary per
      // constraint (v). precision is left at default (global layer has no Fisher
      // consumer today). last_theta_delta records the global drift for observability.
      const globalEvidence = (lockedRow?.evidence_count ?? 0) + 1;
      await upsertMasteryState(tx, {
        subject_kind: ABILITY_GLOBAL_KIND,
        subject_id: domain,
        theta_hat: lockedNewGlobal,
        evidence_count: globalEvidence,
        // Binary integer tallies (constraint v): success on a correct attempt, fail on
        // a wrong one — one increment per attempt per domain, never fractional.
        success_count: (lockedRow?.success_count ?? 0) + (input.outcome === 1 ? 1 : 0),
        fail_count: (lockedRow?.fail_count ?? 0) + (input.outcome === 0 ? 1 : 0),
        last_outcome_at: input.now,
        last_theta_delta: lockedNewGlobal - lockedGlobal,
      });
    }
  }

  // ── A4 (YUK-436) — discrete grid-Bayes θ_KC offset posterior, SHADOW write ────────
  //
  // PURE-ADDITIVE SHADOW (inc-1): maintain a discrete posterior over the per-KC θ_KC
  //   OFFSET and PERSIST it shadow-only. The Elo theta_hat written in the per-KC loop
  //   above stays the SOURCE OF TRUTH — this block does NOT read back or alter it; it
  //   only appends theta_grid_json. NOTHING downstream reads theta_grid_json in inc-1
  //   (it does not feed p(L)/effectiveB/selection — the audit-schema allowlist entry
  //   records the write-path-without-live-reader honestly). The calibrated posterior SE
  //   is the eventual payoff; the invasive grid→SoT cut-over is inc-2 (deferred, must
  //   serialize AFTER A3).
  //
  // GATES (ALL must hold, else this block is a complete NO-OP → theta_grid_json stays
  //   NULL and the θ̂ path is BYTE-IDENTICAL to today — the regression anchor):
  //   (a) THETA_GRID_ENABLED (module const, default false this PR → dark-ship);
  //   (b) SINGLE-KC item only (states.length === 1). The multi-KC conjunctive posterior
  //       factorisation is deferred — one Bernoulli outcome shared across KCs does not
  //       factor into independent per-KC posteriors trivially, and single-KC suffices to
  //       validate calibration. Multi-KC items skip the grid entirely (both KCs' Elo
  //       still updates above; only the shadow grid is gated off).
  //
  // LIKELIHOOD: inc-1 is BINARY Bernoulli ONLY (gridUpdate uses binaryLikelihood). The
  //   continuous-CB likelihood (continuousCbLikelihood) is written but GATED — it would
  //   be wired only when SRT_ENABLED && THETA_GRID_ENABLED, which is NOT inc-1; we do not
  //   wire it here so the binary shadow stays the single validated path.
  //
  // θ_global TRANSLATION ANCHOR (orthogonal to A2, builds ON it): the grid is over the
  //   θ_KC OFFSET; the likelihood evaluates the 1PL ICC at the EFFECTIVE ability
  //   (θ_global + offset) by shifting the difficulty anchor: b' = b − θ_global. θ_global
  //   is `globalOf(s.id)` — 0 when A2 is off / domain unresolved (b' = b, grid over the
  //   raw offset), the A2 per-domain global when A2 is on. The grid does NOT model/subsume
  //   θ_global; it reads it as a fixed translation.
  //
  // n=1-LEGAL: single-learner sequential Bayes with the item difficulty b LOCKED (G4 —
  //   we never fit b). The pre-attempt posterior (states[0].gridPrior) is folded with one
  //   binary likelihood; cold start (null prior) → uniform prior. A targeted UPDATE patches
  //   ONLY theta_grid_json on the row the per-KC loop already wrote (theta_hat/counts left
  //   untouched), so the SoT path is structurally unreachable from the shadow write.
  if (THETA_GRID_ENABLED && states.length === 1) {
    const s = states[0];
    const bPrime = b - globalOf(s.id); // b' = b − θ_global (A2 anchor; 0 if A2 off/unresolved)
    const prior = s.gridPrior ?? uniformPrior(); // null → cold-start uniform over the offset grid
    const posterior = gridUpdate(prior, bPrime, input.outcome); // one binary sequential-Bayes fold
    // Targeted UPDATE of ONLY the shadow column on the row the per-KC loop already wrote
    // (the KC's 'knowledge' mastery_state row exists by now). We deliberately do NOT touch
    // theta_hat / precision / counts here — the per-KC loop is their single writer, so the
    // SoT path cannot be perturbed by the shadow write (this is what keeps the flag-off and
    // flag-on Elo theta_hat bit-identical). updated_at is refreshed to mark the shadow write.
    await tx
      .update(mastery_state)
      .set({ theta_grid_json: posterior, updated_at: input.now })
      .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, s.id)));
  }
}
