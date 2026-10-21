// B1-W1 (ADR-0035 决定#3) — item_calibration 写者（硬轨 b/confidence applier）。
//
// 单写者契约：item_calibration 的 db.insert/update 只允许出现在 src/server/mastery/。
// 本模块是 ItemPriorTask backfill 的 applier（锚 + 后验初始化，YUK-439），并负责结算
// revert 清空证据后把后验**修回先验**（resetPosteriorToPriorIfNoEvidence）；θ̂ 更新路径
// （mastery/state.ts）只**读** b（在线路径不写 b，写者是标定批 joint-calibration.ts）。
//
// 软轨列：本 applier 不产出，留 NULL。irt_a/irt_c/cdm_json 仍 NULL（audit allowlist）；
// kt_json 保留历史值，BKT 夜写已退役（YUK-1576）；硬轨 applier 不碰它。

import { and, eq, sql } from 'drizzle-orm';
import { priorTau } from '@/core/difficulty-posterior';
import { newId } from '@/core/ids';
import type { ItemPriorDraftT } from '@/core/schema/item_prior';
import type { Db, Tx } from '@/db/client';
import { difficulty_calibration_evidence, item_calibration } from '@/db/schema';

type DbLike = Db | Tx;

export interface ApplyItemPriorInput {
  questionId: string;
  draft: ItemPriorDraftT;
  /** provenance — 默认 'llm_prior'（ItemPriorTask）。'llm_prior_llasa' = YUK-376
   *  LLaSA 学生模拟锚（ItemPriorLlasaTask opt-in）；fixed_anchor 慢热校准走别的 source。 */
  source?: string;
}

/**
 * Persist a cold-start difficulty anchor for a question. Idempotent by
 * `item_calibration_question_unique` (onConflictDoNothing) — re-running the
 * backfill never double-writes. Hard track only; soft columns stay NULL.
 *
 * YUK-439 (ADR-0043 Amendment A1)：锚写入**初始化**后验（b_post = μ_j、
 * posterior_variance = τ_j²、calibration_source = 'prior'）——0 条证据时后验数值
 * 就是锚（A3：无 NULL 哨兵）。write-once（onConflictDoNothing）：已初始化的行不被
 * 重跑覆盖，后续演化只归标定批（joint-calibration.ts）。
 */
export async function applyItemPrior(db: DbLike, input: ApplyItemPriorInput): Promise<void> {
  const now = new Date();
  const source = input.source ?? 'llm_prior';
  const tau = priorTau(source);
  await db
    .insert(item_calibration)
    .values({
      id: newId(),
      question_id: input.questionId,
      b: input.draft.b_logit,
      // YUK-361 Phase 6 (Task 11) — b_anchor 与 b 列**同源**写入（冷启锚 = ItemPriorTask
      // 的 feature→b 先验）。YUK-439 起它兼任联合标定的先验均值 μ_j。
      b_anchor: input.draft.b_logit,
      confidence: input.draft.confidence,
      track: 'hard',
      source,
      // YUK-439 — 后验初始化 = 先验（无证据 ⇒ b_post 数值 = 锚；τ 见 priorTau 登记
      // 映射；PRIOR_TAU_DEFAULT 兜底不可达，source 恒先过映射）。
      b_post: input.draft.b_logit,
      posterior_variance: tau * tau,
      calibration_source: 'prior',
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing({ target: item_calibration.question_id });
}

/**
 * YUK-439 (ADR-0043 Amendment A4「更正跟随有效判分」) — 某题证据账本被清空后，把后验
 * **修回先验**（与 {@link applyItemPrior} 的初值同语义）：b_post = μ_j（= b_anchor，缺锚
 * 时退回 b）、posterior_variance = τ_j²、calibration_n = 0、calibration_weight = NULL、
 * calibration_source = 'prior'、last_calibrated_at = NULL。
 *
 * 为什么要显式修：标定批的候选只从**仍有证据行**的题里选；一条证据都不剩的题永远不会
 * 再进批，若只删证据行而不修 b_post，effectiveB 会永久保留「含已撤销作答」的后验
 * （幽灵校准）。settle revert/withdraw 删证据后**同一事务**调用本函数；本函数自己复核
 * 证据是否已空，非空则不写（留给下一批从账本全量重算）。
 *
 * 返回 true = 确已修回先验。
 */
export async function resetPosteriorToPriorIfNoEvidence(
  db: DbLike,
  questionId: string,
): Promise<boolean> {
  const remaining = await db
    .select({ id: difficulty_calibration_evidence.id })
    .from(difficulty_calibration_evidence)
    .where(eq(difficulty_calibration_evidence.question_id, questionId))
    .limit(1);
  if (remaining.length > 0) return false;
  const rows = await db
    .select({ source: item_calibration.source })
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  const tau = priorTau(row.source);
  await db
    .update(item_calibration)
    .set({
      b_post: sql<number | null>`coalesce(${item_calibration.b_anchor}, ${item_calibration.b})`,
      posterior_variance: tau * tau,
      calibration_n: 0,
      calibration_weight: null,
      calibration_source: 'prior',
      last_calibrated_at: null,
      updated_at: new Date(),
    })
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')));
  return true;
}
