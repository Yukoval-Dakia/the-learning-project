// YUK-453 cold-start inc-A — owner FIXED-ANCHOR write path (item_calibration
// source='fixed_anchor').
//
// docs/design/2026-06-20-cold-start-day-one-design.md §5 inc-A + §4.1.
//
// ─── 为什么这条写路径是 n=1 唯一合法的「校 LLM 难度系统性 offset」杠杆 ──────────────
// LLM 难度估计至多中等且**系统性低估**难度（§4.1：Spearman ρ~0.43-0.50，BEA 2024
// RMSE≈0.29 打平常数 baseline）。修这个 offset 的标准做法是「对总体校准」——但那正是
// §3 红线 3/5 禁止的 forbidden 总体标定（n=1 无总体可积）。**唯一不违红线的 offset 杠杆**
// 是 owner 钦定 ~5-10 道锚题的 b：给难度尺度一个**共同原点 + 单位**（§4.1 缓解 1）。
//
// ─── 这是 WRITE-ONLY，绝不碰读路径（§3 红线 3，item-半边锁死 G4）─────────────────────
// 本模块**只写** item_calibration.{b, b_anchor}（source='fixed_anchor', track='hard'）。
// θ̂ 读路径（state.ts updateThetaForAttempt）已经读 effectiveB = b_calib ?? b_anchor ?? b
// （recalibration.ts:90）——非 NULL 锚自动被优先读，**无需任何读路径改动**。在线 θ̂ Elo
// **永不回写 b**（G4），本写路径也绝不在 attempt 路径上跑（owner 录入面专用）。
//
// ─── 固定锚写入归属（scripts/audit-fold-writes.ts sanctioned writer）────────────────
// 本模块拥有 Practice 固定锚登记/修订，是 fold 政策中的 sanctioned off-path writer。
// API route handler 只 CALL setFixedAnchors，绝不直接 db.insert(item_calibration)
// （镜像 submit.ts 只 CALL updateThetaForAttempt 的纪律）。
//
// ─── upsert 而非 write-once（与 applyItemPrior 的对照）─────────────────────────────────
// applyItemPrior（llm_prior 冷启锚）是 write-once（onConflictDoNothing）——LLM 先验写一次，
// 后验演化走标定批慢路径。fixed_anchor **是 owner 钦定的权威外部真值**，owner 可修订
// （改档），故用 onConflictDoUpdate（按 question_id 幂等 upsert）：同题重设 = 覆盖 b /
// b_anchor / source / updated_at + 重置后验为新先验（YUK-439：改档 = 修订先验；证据
// 账本不清，下一批以新先验重算），不留重复行。
//
// ─── 软轨列 NULL（同 applyItemPrior）──────────────────────────────────────────────────
// irt_a/irt_c/cdm_json/kt_json 不产出，留 NULL（n=1 结构性不可估，ADR-0035）。

import { priorTau } from '@/core/difficulty-posterior';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { item_calibration } from '@/db/schema';

type DbLike = Db | Tx;

// ─────────────────────────────────────────────────────────────────────────────
// bucket → logit b 映射（owner-fixed module const，§5 Q2 决策：owner 给**粗分桶**，
// 不是 raw logit）。这是 owner 固定先验（§0.2 试金石第 1 类「已知常数 / owner 固定先验」），
// **不是估计出来的** —— 五档对称跨 logit [-2, +2]，与 difficultyToLogitB 的 1-5 档同量级
// （theta.ts:132，每档 ~0.85 logit）但用整 logit 步长（owner 心智更稳的粗刻度）。
//
// 为什么粗桶而非 raw logit（§6 开放问题 2 的落点）：owner 不需要、也不可靠地直接给
// logit 数值；给「这题大概很简单/简单/中等/难/很难」这种序数判断，由本表映成共同尺度
// 的 logit。这守住「信相对排序」（§4.1 缓解 4）——五档的**相对序**是 owner 的真信号，
// 绝对 logit 只是把序数钉到 1PL ICC 同度量的固定刻度。
// ─────────────────────────────────────────────────────────────────────────────
export const ANCHOR_BUCKET_LOGITS = {
  very_easy: -2,
  easy: -1,
  medium: 0,
  hard: 1,
  very_hard: 2,
} as const;

export type AnchorBucket = keyof typeof ANCHOR_BUCKET_LOGITS;

/** 五档桶名（运行时校验 / Zod enum 来源）。 */
export const ANCHOR_BUCKETS = Object.keys(ANCHOR_BUCKET_LOGITS) as AnchorBucket[];

/** bucket → 固定 logit b。owner-fixed，非估计。未知桶名 throw（上游 Zod 应已挡住）。 */
export function bucketToLogit(bucket: AnchorBucket): number {
  const b = ANCHOR_BUCKET_LOGITS[bucket];
  if (b === undefined) {
    throw new Error(`bucketToLogit: unknown anchor bucket '${bucket}'`);
  }
  return b;
}

export interface FixedAnchorInput {
  questionId: string;
  bucket: AnchorBucket;
}

export interface FixedAnchorRow {
  questionId: string;
  bucket: AnchorBucket;
  b: number;
}

/**
 * Persist (upsert) an owner-declared fixed difficulty anchor for one question.
 *
 * Writes item_calibration { b: bucketToLogit(bucket), b_anchor: same, track:'hard',
 * source:'fixed_anchor' }. Idempotent per (question_id) — the unique index
 * `item_calibration_question_unique` makes re-setting the same question an UPDATE
 * (owner may revise the bucket), never a duplicate row.
 *
 * YUK-439 (ADR-0043 Amendment A1)：owner 修订锚 = **修订先验**——后验随之重置为新先验
 * （b_post = 新 μ、posterior_variance = τ²、calibration_source = 'prior'）。证据账本
 * 不清（分数不因改档失效）；下一批标定会以新先验 + 原证据重算，b_post 连续收敛到
 * 修订后的位置。重置只影响批前的读值（读新锚，语义正确）。
 *
 * Read path: effectiveB = b_post ?? b_anchor ?? b (recalibration.ts) reads the
 * initialized posterior automatically — no read-path edit.
 */
export async function setFixedAnchor(db: DbLike, input: FixedAnchorInput): Promise<FixedAnchorRow> {
  const now = new Date();
  const b = bucketToLogit(input.bucket);
  const tau = priorTau('fixed_anchor');
  await db
    .insert(item_calibration)
    .values({
      id: newId(),
      question_id: input.questionId,
      // b 与 b_anchor 同源写入（同 applyItemPrior 的纪律）——effectiveB 读链经 b_post。
      b,
      b_anchor: b,
      // owner 钦定锚是高置信先验（不是 LLM 低置信猜测）。
      confidence: 1,
      track: 'hard',
      source: 'fixed_anchor',
      // YUK-439 — 后验初始化 = 先验（fixed_anchor 是登记映射里最小的 τ：强 leash）。
      b_post: b,
      posterior_variance: tau * tau,
      calibration_source: 'prior',
      created_at: now,
      updated_at: now,
    })
    // 幂等 upsert：同题重设 → 覆盖 b/b_anchor/source/confidence/updated_at（owner 可
    // 改档）+ 重置后验为新先验（YUK-439：改档 = 修订先验）。created_at 保留首写值。
    .onConflictDoUpdate({
      target: item_calibration.question_id,
      set: {
        b,
        b_anchor: b,
        confidence: 1,
        track: 'hard',
        source: 'fixed_anchor',
        b_post: b,
        posterior_variance: tau * tau,
        calibration_source: 'prior',
        updated_at: now,
      },
    });
  return { questionId: input.questionId, bucket: input.bucket, b };
}

/**
 * Batch convenience — set fixed anchors for several questions in one call.
 *
 * ── ATOMIC（YUK-453，单写者契约 + PR #512 OCR major）──────────────────────────────
 * 整批跑在**单个 db.transaction** 里：任一锚写失败（DB 约束 / 桶名非法 / 连接断）→ PG
 * 整体 rollback，**全批回退**（不留「前 k 道已提交、后面没写」的部分写）。这守住 owner
 * 一次提交「这 5-10 道锚题」的**语义原子性**——锚题集合是给难度尺度定共同原点+单位的整体
 * （§4.1 缓解 1），半套锚比无锚更坏（尺度被一半 owner 真值 + 一半 LLM offset 污染）。
 *
 * 接收 `Db`（非 DbLike）因为只有 `Db` 暴露 `.transaction`；唯一生产调用方（calibration-anchors
 * route）传 db 单例。单道 `setFixedAnchor` 仍收 `DbLike`，故 standalone + 在本 tx 内（收 tx）
 * 两种调用都成立（镜像 verify-and-promote.ts:180 的 db.transaction(tx => fn(tx)) 纪律）。
 * Returns the written rows in input order.
 */
export async function setFixedAnchors(
  db: Db,
  inputs: ReadonlyArray<FixedAnchorInput>,
): Promise<FixedAnchorRow[]> {
  return db.transaction(async (tx) => {
    const out: FixedAnchorRow[] = [];
    for (const input of inputs) {
      // setFixedAnchor 收 DbLike，传 tx → 每道锚写进同一事务；任一抛错则整事务 rollback。
      out.push(await setFixedAnchor(tx, input));
    }
    return out;
  });
}
