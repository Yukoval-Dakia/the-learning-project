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

import { newId } from '@/core/ids';
import {
  DIFFICULTY_PROXY_WEIGHT,
  conjunctiveCredits,
  difficultyToLogitB,
  eloK,
  updateThetaPrecision,
} from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { item_calibration, mastery_state } from '@/db/schema';
import { resolveFamilyKeyForQuestion } from './family-key';
import { effectiveFamilyB, getFamilyCalibration } from './personalized-difficulty';
import { effectiveB } from './recalibration';

type DbLike = Db | Tx;

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

export interface UpdateThetaForAttemptInput {
  /** q.knowledge_ids — every KC this question probes gets updated (PFA per-KC). */
  knowledgeIds: string[];
  /** read item_calibration.b for the anchor. */
  questionId: string;
  /** success=1, failure=0. */
  outcome: 0 | 1;
  /** fallback anchor source (1-5) when no item_calibration.b. */
  difficulty: number;
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
    const familyKey = await resolveFamilyKeyForQuestion(tx, {
      primaryKnowledgeId: knowledgeIds[0],
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
    };
  });

  // 3. 多 KC 合取 credit（owner 拍板 MLE，review SF-1）。conjunctiveCredits 直接
  //    返回每 KC 的 log 似然梯度项（题目级 surprise × (1−p_k) 灵敏度），取代旧的
  //    per-KC 残差权重（两端抵消、弱 KC 答错不降的反向 bug）。单 KC 退化为标准 Elo。
  const credits = conjunctiveCredits(
    states.map((s) => s.theta),
    b,
    input.outcome,
  );

  // 4 + 5. Per-KC update + upsert. θ̂ += k · bWeight · credit_k（弱锚 bWeight 降权）。
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    const k = eloK(s.evidence);
    const newTheta = s.theta + k * bWeight * credits[i];
    // YUK-361 Phase 2 — 累积 θ precision，用与 θ̂ 更新**同一个 b 锚 + 同一 bWeight**
    //   喂 Fisher information（弱锚 bWeight=0.3 → weight² 降权，信息增量小）。
    //   thetaBefore=s.theta（信息在 θ̂ 移动前的位置评估，与梯度同步）。
    const newPrecision = updateThetaPrecision(s.precision, s.theta, b, bWeight);
    const delta = newTheta - s.theta;
    await upsertMasteryState(tx, {
      subject_id: s.id,
      theta_hat: newTheta,
      evidence_count: s.evidence + 1,
      success_count: s.success + (input.outcome === 1 ? 1 : 0),
      fail_count: s.fail + (input.outcome === 0 ? 1 : 0),
      last_outcome_at: input.now,
      theta_precision: newPrecision,
      last_theta_delta: delta,
    });
  }
}
