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
//
// YUK-1570 — the read/query/calculation engine moved VERBATIM to kernel read
// models: row reads + ability_global resolution live in
// @/kernel/read-models/mastery-state; the p(L) projection, A5/A6 KG soft layer
// and representative-β resolution live in
// @/kernel/read-models/mastery-projection. The explicit compat re-exports at the
// bottom keep the `@/server/mastery/state` import surface stable for tests and
// the consumers that still import from here; the writer path itself is
// byte-identical (this module remains the sole writer).

import { and, eq, inArray, sql } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { ThetaRowSnapshotT } from '@/core/schema/event/state-snapshot';
import {
  DIFFICULTY_PROXY_WEIGHT,
  ELO_K_GLOBAL,
  HIERARCHICAL_ELO_ENABLED,
  type RtCorrectBuffer,
  SRT_ENABLED,
  SRT_FISHER_WEIGHT_ENABLED,
  conjunctiveCredits,
  conjunctiveCreditsContinuous,
  difficultyToLogitB,
  eloK,
  expectedScore,
  pushRtCorrectSample,
  resolveSrtTimeLimit,
  srtOutcome,
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
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import {
  ABILITY_GLOBAL_SUBJECT_KIND,
  type AbilityGlobalByKnowledgeId,
  getMasteryState,
} from '@/kernel/read-models/mastery-state';
import {
  acquireLearningStateWriteLock,
  acquireSortedAdvisoryLocks,
  withLearningStateLock,
} from '@/server/advisory-locks';
import { resolveFamilyKeyForQuestion } from './family-key';
import { effectiveFamilyB, getFamilyCalibration } from './personalized-difficulty';
import { effectiveB } from './recalibration';

type DbLike = Db | Tx;

// A2 (YUK-434) — the per-domain global-ability θ_global partition reused inside
// mastery_state; the canonical literal now lives with the read model in
// @/kernel/read-models/mastery-state (ABILITY_GLOBAL_SUBJECT_KIND). The writer
// keeps the historical private name so the write path stays byte-identical.
const ABILITY_GLOBAL_KIND = ABILITY_GLOBAL_SUBJECT_KIND;

export interface UpsertMasteryStateInput {
  subject_kind?: string; // default 'knowledge'
  subject_id: string;
  theta_hat: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  // YUK-561 S1 — `Date | null`: verbatim revert must be able to restore a row whose
  // pre-attempt `last_outcome_at` was NULL (the column is nullable). Live attempt
  // writers always pass a real Date; only the restore primitive passes null.
  last_outcome_at: Date | null;
  // YUK-361 Phase 2 — 默认让 upsert 维持既有 precision/delta 语义（不传则不更新）。
  theta_precision?: number;
  last_theta_delta?: number | null;
  // A4 (YUK-436) — 离散网格贝叶斯 θ_KC offset 后验的 SHADOW 持久化。可选（同 precision/delta
  // 语义）：只有 caller 显式传值时才写。INSERT 缺省 → DB default NULL；UPDATE 缺省 → 不动此列。
  // inc-1 PURE-ADDITIVE SHADOW：写路径存在但**无 inc-1 下游读者**（不喂 p(L)/effectiveB/选题）。
  theta_grid_json?: ThetaGridPosterior | null;
  // Per-KC correct-RT collection and snapshot restore; never changes the SRT scale.
  // Only written when the caller passes it (an SRT-eligible correct attempt).
  rt_correct_ms?: RtCorrectBuffer | null;
}

/**
 * Upsert the p(L) state projection for a knowledge node. ON CONFLICT
 * (subject_kind, subject_id) — concurrent attempts on the same KC race on the
 * `mastery_state_unique` index; the loser falls back to UPDATE in one statement.
 * Pure persistence — the θ̂ math lives in updateThetaForAttempt.
 *
 * LOCKING (F6/TdZQz): self-acquires the global learning-state write lock G via
 * `withLearningStateLock` — it opens its own tx + `acquireLearningStateWriteLock` when passed a Db,
 * or runs inside the caller's tx when passed a Tx. G is a `pg_advisory_xact_lock`, which is
 * RE-ENTRANT within a transaction, so a caller that already holds G (e.g. the grading path, or
 * cascade-revert) can call this safely — the re-acquire is a no-op, no deadlock.
 */
export async function upsertMasteryState(
  db: DbLike,
  input: UpsertMasteryStateInput,
): Promise<void> {
  await withLearningStateLock(db, async (tx) => {
    const now = new Date();
    const subjectKind = input.subject_kind ?? 'knowledge';
    // OPTIONAL-maintenance columns (YUK-361 precision/delta, YUK-436 A4 grid, YUK-449 A1 rt): written
    // only when the caller passes them — INSERT falls back to the DB default (theta_precision=1,
    // last_theta_delta/grid/rt NULL); UPDATE leaves them untouched (a plain seed upsert must not reset
    // precision). Inlined IDENTICALLY into both the INSERT values and the UPDATE set — the column-name
    // literals must stay textually visible at each write site so audit:schema's write-path scanner
    // (scripts/audit-schema-writes.ts keys on `field:` text inside .values()/onConflict set{}) can see
    // them; a shared `...optionalFields` spread hid rt_correct_ms and broke the audit (YUK-497 wave-4).
    // The two blocks MUST stay in sync by hand.
    await tx
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
        ...(input.last_theta_delta !== undefined
          ? { last_theta_delta: input.last_theta_delta }
          : {}),
        ...(input.theta_grid_json !== undefined ? { theta_grid_json: input.theta_grid_json } : {}),
        ...(input.rt_correct_ms !== undefined ? { rt_correct_ms: input.rt_correct_ms } : {}),
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [mastery_state.subject_kind, mastery_state.subject_id],
        set: {
          theta_hat: input.theta_hat,
          evidence_count: input.evidence_count,
          success_count: input.success_count,
          fail_count: input.fail_count,
          last_outcome_at: input.last_outcome_at,
          ...(input.theta_precision !== undefined
            ? { theta_precision: input.theta_precision }
            : {}),
          ...(input.last_theta_delta !== undefined
            ? { last_theta_delta: input.last_theta_delta }
            : {}),
          ...(input.theta_grid_json !== undefined
            ? { theta_grid_json: input.theta_grid_json }
            : {}),
          ...(input.rt_correct_ms !== undefined ? { rt_correct_ms: input.rt_correct_ms } : {}),
          updated_at: now,
        },
      });
  });
}

/**
 * YUK-543 — repair `mastery_state` when a KC (`fromId`) is merged into another (`intoId`).
 *
 * NEVER merges θ̂ / recomputes any statistic (the n=0/n=1 "no invented merge math" red line,
 * spec §6 check 2). 3-case identity-rename/freeze-and-log:
 *   - neither row exists → 'noop';
 *   - only `fromId`'s row exists → RENAME (`UPDATE subject_id = intoId`) → 'renamed';
 *   - both rows exist → FREEZE (leave both untouched; the `fromId` row goes INERT because every
 *     live reader keys off the rewritten question tags / `into_id`) + log → 'frozen'.
 *
 * Serializes against the ONLY live concurrent writer (`updateThetaForAttempt`, background grading)
 * by taking the SHARED `fsrs:knowledge:<id>` advisory lock for BOTH ids in sorted string order
 * (mirrors state.ts's own deadlock-safe acquisition) — so a grading upsert of either id blocks
 * until the merge tx commits, then resolves against the post-rename state. Released at tx commit.
 */
export async function retireMasteryStateOnMerge(
  tx: Tx,
  fromId: string,
  intoId: string,
): Promise<'noop' | 'renamed' | 'frozen'> {
  // YUK-497 — global learning-state write lock before the per-key locks (shared tx-entry order).
  await acquireLearningStateWriteLock(tx);
  // Sorted acquire of BOTH ids' locks (SAME namespace as updateThetaForAttempt) → no deadlock.
  await acquireSortedAdvisoryLocks(tx, 'fsrs:knowledge', [fromId, intoId]);
  const rows = await tx
    .select({ subject_id: mastery_state.subject_id })
    .from(mastery_state)
    .where(
      and(
        eq(mastery_state.subject_kind, 'knowledge'),
        inArray(mastery_state.subject_id, [fromId, intoId]),
      ),
    );
  const present = new Set(rows.map((r) => r.subject_id));
  if (!present.has(fromId)) return 'noop';
  if (!present.has(intoId)) {
    await tx
      .update(mastery_state)
      .set({ subject_id: intoId, updated_at: new Date() })
      .where(
        and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, fromId)),
      );
    return 'renamed';
  }
  // Both sides carry evidence — FREEZE: no blind θ̂ combine (would fabricate a statistic). The
  // from-row is retained for forensics but is inert (no reader scans an unrewritten subject_id).
  console.warn(
    '[retireMasteryStateOnMerge] both from+into have mastery_state — freezing from-row (no θ̂ merge)',
    { fromId, intoId },
  );
  return 'frozen';
}

export interface UpdateThetaForAttemptInput {
  /** q.knowledge_ids — every KC this question probes gets updated (PFA per-KC). */
  knowledgeIds: string[];
  /** read item_calibration.b for the anchor. */
  questionId: string;
  /** success=1, failure=0. */
  outcome: 0 | 1;
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
  /**
   * Durable-lane-only frozen KC → ability_global domain mapping. `undefined` preserves the
   * synchronous/paper behavior of resolving the current knowledge tree inside this tx.
   */
  abilityGlobalByKnowledgeId?: AbilityGlobalByKnowledgeId;
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
 *
 * YUK-471 Wave 0 (ADR-0044 §3) — returns the per-KC θ̂ `before`/`after` snapshot so
 * the attempt-tx snapshot append (submit.ts / paper-submit.ts) can bracket the EXACT
 * mastery_state transition this fn performed (A-class snapshot reversibility). `before`
 * is captured from the RAW pre-attempt row presence (`row === undefined ? null :
 * row.theta_hat`) — null≠0 is PRESERVED (0 is a real prior θ̂; cold-start has no row →
 * null → revert deletes the row instead of writing θ̂=0). `after` is the `newTheta`
 * written via upsertMasteryState.
 *
 * SCOPE (§6.6 → YUK-1093): `theta_snapshots` carries BOTH the per-KC 'knowledge'
 * rows AND the A2 hierarchical-Elo 'ability_global' rows (flag ON — the
 * per-domain global drift block below). Each entry is subject_kind-tagged so the
 * parse barrier / cascade-revert / restore primitive can restore the global layer
 * too — settlement replay (YUK-1053) depends on every row this fn wrote being
 * verbatim-bracketed, otherwise a regrade leaves θ_global double-counted.
 */
// YUK-561 S1 — `before` is now the FULL pre-attempt row (verbatim restore), not just
// θ̂. null = cold-start (no pre-attempt row → revert DELETEs the row). Shape mirrors
// ThetaRowSnapshot (core/schema/event/state-snapshot.ts), the parse-barrier schema.
export interface ThetaSnapshotEntry {
  /** Row id: knowledge id, or DOMAIN id when subject_kind='ability_global'. */
  kc_id: string;
  /** mastery_state partition — absent means 'knowledge' (payload-compatible). */
  subject_kind?: 'knowledge' | 'ability_global';
  before: ThetaRowSnapshotT | null;
  after: number;
}
export interface UpdateThetaForAttemptResult {
  theta_snapshots: ThetaSnapshotEntry[];
}

export async function updateThetaForAttempt(
  tx: Tx,
  input: UpdateThetaForAttemptInput,
): Promise<UpdateThetaForAttemptResult> {
  await acquireLearningStateWriteLock(tx);
  const knowledgeIds = Array.from(
    new Set(input.knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  if (knowledgeIds.length === 0) return { theta_snapshots: [] };

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

  // 1. Read the b anchor (READ-ONLY — b 的写者是标定批/锚写者，在线路径只读). track='hard'
  //    only — soft track never reaches p(L)/scheduling (ADR-0035). YUK-439 (ADR-0043
  //    Amendment A2): 读 effectiveB = b_post ?? b_anchor ?? b（后验优先）。在线 θ̂ 路径
  //    **只 READS** effectiveB，**绝不**写 b——b 单写者由标定批保（G4 改写后红线）。
  //    无证据时 b_post = b_anchor（锚写者初始化/migration 回填），读侧零跳变。
  const calRows = await tx
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
      b_post: item_calibration.b_post,
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
      // YUK-561 S1 — the RAW pre-attempt row for the VERBATIM snapshot `before`.
      // null = cold-start (no row → revert DELETEs the row). Retained whole so the
      // snapshot push below can capture EVERY attempt-written column (counts /
      // precision / delta / last_outcome_at / rt buffer / grid), not just θ̂ — a
      // θ̂-only snapshot leaves counts=0 + stale precision on revert (the pre-S1 bug).
      raw: row ?? null,
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
      // The post-attempt push (correct + RT) appends to this pre-attempt buffer.
      rtBuffer: (row?.rt_correct_ms as RtCorrectBuffer | null | undefined)?.samples ?? null,
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
    // Durable jobs carry the mapping frozen at answer time. Legacy/synchronous callers omit it
    // and retain the current-tree resolution behavior.
    for (const id of knowledgeIds) {
      let domain: string | null = null;
      if (input.abilityGlobalByKnowledgeId !== undefined) {
        domain = input.abilityGlobalByKnowledgeId[id] ?? null;
      } else {
        try {
          domain = await getEffectiveDomain(tx, id);
        } catch {
          domain = null; // orphan / null-root-domain → no domain anchor for this KC.
        }
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
  let credits: number[];
  if (useSrt) {
    const d = resolveSrtTimeLimit(input.difficulty); // seconds (module const)
    const tSeconds = (rtMs as number) / 1000; // ms → s
    // A1 (YUK-450) — Fisher-conditioned TIME WEIGHT. Flag ON → w = 4·pItem·(1−pItem): peak 1
    //   at pItem=0.5 (RT most informative when difficulty ≈ ability), → 0 at extreme p (RT
    //   near-uninformative + noisiest; also tames the over-harsh "easy item answered slow"
    //   negative credit). pItem = whole-item p(correct) = Π expectedScore(effectiveθ_k, b) —
    //   built from the learner's OWN θ̂ + the locked b anchor (self-state, n=1; NO per-item
    //   time-discrimination φ). Flag OFF (DEFAULT) → w = 1 → srtOutcome byte-identical to today.
    const pItem = effectiveThetas.reduce((acc, th) => acc * expectedScore(th, b), 1);
    const timeWeight = SRT_FISHER_WEIGHT_ENABLED ? 4 * pItem * (1 - pItem) : 1;
    const srt = srtOutcome(input.outcome === 1, d, tSeconds, timeWeight); // ∈ [0,1]
    credits = conjunctiveCreditsContinuous(effectiveThetas, b, srt);
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
  // YUK-471 Wave 0 (ADR-0044 §3) — accumulate the per-KC θ̂ before/after snapshot as
  // we perform the in-place overwrite, so the caller's snapshot append brackets the
  // EXACT transition (before = raw pre-attempt presence, after = newTheta written).
  const thetaSnapshots: ThetaSnapshotEntry[] = [];
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
    // Retain correct-RT collection without feeding it into θ̂. Wrong / no-RT /
    // SRT-off attempts leave the buffer untouched.
    const rtBuffer =
      useSrt && input.outcome === 1
        ? { samples: pushRtCorrectSample(s.rtBuffer, rtMs as number) }
        : undefined;
    await upsertMasteryState(tx, {
      subject_id: s.id,
      theta_hat: newTheta,
      evidence_count: s.evidence + 1,
      success_count: s.success + (input.outcome === 1 ? 1 : 0),
      fail_count: s.fail + (input.outcome === 0 ? 1 : 0),
      last_outcome_at: input.now,
      theta_precision: newPrecision,
      rt_correct_ms: rtBuffer,
      last_theta_delta: delta,
    });
    // YUK-561 S1 — bracket THIS KC's transition VERBATIM. before = the FULL raw
    // pre-attempt row (null = cold-start, distinct from a 0 θ̂ row); after = the
    // newTheta just written. Capturing all columns makes revert a byte-for-byte row
    // restore (counts/precision/delta/rt/grid), not the pre-S1 θ̂-only-with-zeroed-
    // counts restore. `rt_correct_ms`/`theta_grid_json` are the whole jsonb objects
    // (not `.samples`/scalar) so restore rewrites the column identically.
    const before: ThetaRowSnapshotT | null =
      s.raw === null
        ? null
        : {
            theta_hat: s.raw.theta_hat,
            evidence_count: s.raw.evidence_count,
            success_count: s.raw.success_count,
            fail_count: s.raw.fail_count,
            theta_precision: s.raw.theta_precision,
            last_theta_delta: s.raw.last_theta_delta ?? null,
            last_outcome_at: s.raw.last_outcome_at ?? null,
            rt_correct_ms: (s.raw.rt_correct_ms as RtCorrectBuffer | null) ?? null,
            theta_grid_json: (s.raw.theta_grid_json as ThetaGridPosterior | null) ?? null,
          };
    thetaSnapshots.push({ kc_id: s.id, before, after: newTheta });
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
      // YUK-1093 — read the RAW row (incl. rt_correct_ms/theta_grid_json) so the
      // snapshot `before` is a VERBATIM whole-row restore point, identical to the
      // per-KC capture discipline (projected MasteryStateRow drops rt_correct_ms).
      const lockedRows = await tx
        .select()
        .from(mastery_state)
        .where(
          and(
            eq(mastery_state.subject_kind, ABILITY_GLOBAL_KIND),
            eq(mastery_state.subject_id, domain),
          ),
        )
        .limit(1);
      const lockedRow = lockedRows[0] ?? null;
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
      // YUK-1093 — bracket the global transition VERBATIM (same discipline as the
      // per-KC captures): before = raw locked row (null = cold-start → revert
      // DELETEs), after = lockedNewGlobal. Without this a settle/rejudge revert
      // restores the KC layer but leaves θ_global + evidence_count double-counted.
      const globalBefore: ThetaRowSnapshotT | null =
        lockedRow === null
          ? null
          : {
              theta_hat: lockedRow.theta_hat,
              evidence_count: lockedRow.evidence_count,
              success_count: lockedRow.success_count,
              fail_count: lockedRow.fail_count,
              theta_precision: lockedRow.theta_precision,
              last_theta_delta: lockedRow.last_theta_delta ?? null,
              last_outcome_at: lockedRow.last_outcome_at ?? null,
              rt_correct_ms: (lockedRow.rt_correct_ms as RtCorrectBuffer | null) ?? null,
              theta_grid_json: (lockedRow.theta_grid_json as ThetaGridPosterior | null) ?? null,
            };
      thetaSnapshots.push({
        kc_id: domain,
        subject_kind: 'ability_global',
        before: globalBefore,
        after: lockedNewGlobal,
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

  // YUK-471 Wave 0 (ADR-0044 §3) + YUK-1093 — return the θ̂ before/after snapshot
  // for the attempt-tx snapshot append: per-KC 'knowledge' rows AND the A2
  // 'ability_global' rows (subject_kind-tagged), so every row this fn wrote is
  // verbatim-bracketed for cascade-revert / settlement replay.
  return { theta_snapshots: thetaSnapshots };
}
export type {
  MasteryProjection,
  MasteryProvenance,
  ProjectionEdgeRow,
} from '@/kernel/read-models/mastery-projection';
export {
  BORROW_EPS,
  PROJECTION_EDGE_RELATION_TYPES,
  getMasteryProjection,
  getRepresentativeKcBeta,
  isObserved,
  splitProjectionEdgeRows,
} from '@/kernel/read-models/mastery-projection';
// ── YUK-1570 compat re-exports ────────────────────────────────────────────────
// The read engine moved VERBATIM to the kernel read models below; this block
// keeps the historical `@/server/mastery/state` import surface stable for the
// consumers that still import from here (tests + files owned by other lanes).
// No implementation remains here — these are explicit compatibility residuals,
// not a second source. New readers should import the kernel modules directly.
export type {
  AbilityGlobalByKnowledgeId,
  MasteryStateRow,
} from '@/kernel/read-models/mastery-state';
export {
  ABILITY_GLOBAL_SUBJECT_KIND,
  effectiveThetaForKc,
  effectiveThetaForKcBatch,
  getMasteryState,
  getMasteryStates,
  globalThetaForDomain,
  resolveAbilityGlobalByKnowledgeId,
  resolveAbilityGlobalSubjectIds,
} from '@/kernel/read-models/mastery-state';
