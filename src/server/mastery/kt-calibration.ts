// B1 four-engine soft-track inc-1 (YUK-348, ADR-0035 决定 #3 + 决定 #4 红线) —
// item_calibration **软轨** KT 写者（kt_json sink）。
//
// 单写者契约（step9-invariant-audit / single-writer discipline）：item_calibration 的
// db.insert/update 只允许出现在 src/server/mastery/。本模块与硬轨写者 item-calibration.ts
// （写 b/b_anchor/confidence）并列——但只触 **kt_json 一列**，绝不碰任何硬轨 / 其它软轨列。
//
// ─── 红线（ADR-0035 决定 #4）：kt_json 是纯持久化 sink ──────────────────────────
// kt_json 钉**软轨低置信**，**零下游消费者**——不喂 p(L)/调度/显示/硬轨自校验（PFA 是唯一
// 可信决策信号）。本写者只把 estimateBkt 的 prior-echo 输出落库（管线先就位 + 扩多用户期权
// + 诊断丰富度，决定 #3 四条理由），写不写、写什么都**不改变任何决策/显示路径**（红线合规
// 单测：kt_json null vs populated 下 getMasteryProjection/effectiveB bit-identical）。
//
// ─── UPDATE-only（绝不 INSERT 新行）─────────────────────────────────────────────
// 本写者**只 UPDATE 已存在的硬轨行**（track='hard'），绝不 insert。理由：item_calibration 的
// 行由硬轨写者 applyItemPrior 经冷启锚 backfill 创建（item_calibration_question_unique，每题
// 一行）；软轨 KT 只是给那行**补上 kt_json 列**。无硬轨行的题（还没跑过 item_prior backfill）
// → no-op（不创建半截的纯软轨行——那会污染锚池 + 破坏「硬轨行先于软轨列」的时序）。
// 幂等：同输入重复 UPDATE 同结果（kt_json 整列覆盖，无累积副作用）。

import type { Db, Tx } from '@/db/client';
import { item_calibration } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

type DbLike = Db | Tx;

// item_calibration.kt_json 是 jsonb $type<JsonObject> = Record<string, unknown>。BktEstimate
// 是扁平 number 对象，结构上即 JsonObject（无需运行时转换）。用 Record<string, unknown> 形
// 接受任意 KT 画像（未来扩参数时不破坏列契约）。
export type KtJson = Record<string, unknown>;

export interface ApplyKtEstimateInput {
  /** question.id（被标定题）。 */
  questionId: string;
  /** 要落库的 KT 软轨画像（estimateBkt 输出，整列覆盖写入 kt_json）。 */
  ktJson: KtJson;
}

/**
 * Persist a soft-track KT profile into `item_calibration.kt_json` for a question.
 *
 * UPDATE-only on the question's HARD-track row (`track='hard'`). Never inserts a
 * row — when no hard-track row exists yet (item_prior backfill hasn't run), this
 * is a no-op (the row is created by the hard-track writer first). Idempotent: the
 * whole `kt_json` column is overwritten, no accumulation. Touches ONLY `kt_json`
 * (+ `updated_at` provenance) — never b / b_anchor / b_calib / confidence / any
 * other soft column (irt_a / irt_c / cdm_json). kt_json is a PURE PERSISTENCE
 * SINK with ZERO downstream consumer (ADR-0035 决定 #4 红线).
 */
export async function applyKtEstimate(db: DbLike, input: ApplyKtEstimateInput): Promise<void> {
  await db
    .update(item_calibration)
    .set({
      kt_json: input.ktJson,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(item_calibration.question_id, input.questionId),
        // UPDATE-only on the hard-track row — never the (currently unused) soft
        // track placeholder; never insert. No hard-track row → 0 rows matched → no-op.
        eq(item_calibration.track, 'hard'),
      ),
    );
}
