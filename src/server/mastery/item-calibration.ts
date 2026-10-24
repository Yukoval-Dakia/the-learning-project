// item_calibration 单写者（ADR-0035 决定#3）：insert/update 只允许出现在
// src/server/mastery/。本模块是 ItemPriorTask 的硬轨 applier（锚 + 后验初始化），
// 并负责结算 revert 清空证据后把后验修回先验；θ̂ 在线路径只读 b，写 b 的是
// joint-calibration.ts。
//
// 软轨列不产出，留 NULL；kt_json 保留历史值，BKT 夜写已退役（YUK-1576）。

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
  /** provenance；默认 'llm_prior'。LLaSA 模拟锚用 'llm_prior_llasa'，fixed_anchor 走别的 source。 */
  source?: string;
}

/**
 * Persist a cold-start difficulty anchor. Idempotent per question
 * (onConflictDoNothing); hard track only, soft columns stay NULL.
 *
 * The anchor also initializes the posterior (b_post = μ_j, τ_j²). Write-once:
 * a rerun never overwrites an initialized row; later evolution belongs to
 * joint-calibration.ts.
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
      // b_anchor 与 b 同源：冷启锚兼任联合标定的先验均值 μ_j。
      b_anchor: input.draft.b_logit,
      confidence: input.draft.confidence,
      track: 'hard',
      source,
      // 后验初始化 = 先验；τ 由 priorTau 的 source 映射给出。
      b_post: input.draft.b_logit,
      posterior_variance: tau * tau,
      calibration_source: 'prior',
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing({ target: item_calibration.question_id });
}

/**
 * 证据账本清空后把后验修回先验（与 {@link applyItemPrior} 初值同语义），返回是否写入。
 *
 * 标定批只从仍有证据的题里选；只删证据不修 b_post，effectiveB 会永久保留含已撤销
 * 作答的后验（幽灵校准）。settle revert/withdraw 在同一事务调用；这里复核证据已空才写，
 * 非空则留给下一批从账本全量重算。
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
