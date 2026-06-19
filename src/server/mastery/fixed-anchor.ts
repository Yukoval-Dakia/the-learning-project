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
// ─── 单写者契约（tests/integration/step9-invariant-audit.test.ts）────────────────────
// item_calibration 的 db.insert/update **只允许出现在 src/server/mastery/**。本模块落在
// 这里，故 API route handler 只 CALL setFixedAnchor，绝不直接 db.insert(item_calibration)
// （镜像 submit.ts 只 CALL updateThetaForAttempt 的纪律）。
//
// ─── upsert 而非 write-once（与 applyItemPrior 的对照）─────────────────────────────────
// applyItemPrior（llm_prior 冷启锚）是 write-once（onConflictDoNothing）——LLM 先验写一次，
// firm-up 走 b_calib 慢路径。fixed_anchor **是 owner 钦定的权威外部真值**，owner 可修订
// （改档），故用 onConflictDoUpdate（按 question_id 幂等 upsert）：同题重设 = 覆盖 b /
// b_anchor / source / updated_at，不留重复行。b_calib 不动（去偏列由批量重标定独占写）。
//
// ─── 软轨列 NULL（同 applyItemPrior）──────────────────────────────────────────────────
// irt_a/irt_c/cdm_json/kt_json 不产出，留 NULL（n=1 结构性不可估，ADR-0035）。

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
 * (owner may revise the bucket), never a duplicate row. b_calib is left untouched
 * (the de-biased column is written ONLY by the batch recalibrateQuestion — 不变量①).
 *
 * Read path is unchanged: effectiveB = b_calib ?? b_anchor ?? b already prefers the
 * non-NULL anchor (recalibration.ts:90), so the θ̂ update path auto-reads this anchor
 * with no read-path edit.
 */
export async function setFixedAnchor(db: DbLike, input: FixedAnchorInput): Promise<FixedAnchorRow> {
  const now = new Date();
  const b = bucketToLogit(input.bucket);
  await db
    .insert(item_calibration)
    .values({
      id: newId(),
      question_id: input.questionId,
      // b 与 b_anchor 同源写入（同 applyItemPrior 的纪律）——effectiveB 读 b_anchor。
      b,
      b_anchor: b,
      // owner 钦定锚是高置信先验（不是 LLM 低置信猜测）。
      confidence: 1,
      track: 'hard',
      source: 'fixed_anchor',
      created_at: now,
      updated_at: now,
    })
    // 幂等 upsert：同题重设 → 覆盖 b/b_anchor/source/confidence/updated_at（owner 可改档）。
    // **不动 b_calib**（去偏列由批量 recalibrateQuestion 独占写，不变量①）；created_at 保留首写值。
    .onConflictDoUpdate({
      target: item_calibration.question_id,
      set: {
        b,
        b_anchor: b,
        confidence: 1,
        track: 'hard',
        source: 'fixed_anchor',
        updated_at: now,
      },
    });
  return { questionId: input.questionId, bucket: input.bucket, b };
}

/**
 * Batch convenience — set fixed anchors for several questions in one call.
 * Each is an independent idempotent upsert. Returns the written rows in input order.
 */
export async function setFixedAnchors(
  db: DbLike,
  inputs: ReadonlyArray<FixedAnchorInput>,
): Promise<FixedAnchorRow[]> {
  const out: FixedAnchorRow[] = [];
  for (const input of inputs) {
    out.push(await setFixedAnchor(db, input));
  }
  return out;
}
