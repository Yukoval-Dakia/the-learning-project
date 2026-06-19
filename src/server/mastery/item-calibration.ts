// B1-W1 (ADR-0035 决定#3) — item_calibration 写者（硬轨 b/confidence applier）。
//
// 单写者契约（step9-invariant-audit.test.ts）：item_calibration 的 db.insert/update
// 只允许出现在 src/server/mastery/。本模块是 ItemPriorTask backfill 的 applier；
// θ̂ 更新路径（mastery/state.ts）只**读** item_calibration.b（item-半边锁死 G4）。
//
// 软轨列：本 applier 不产出，留 NULL。irt_a/irt_c/cdm_json 仍 NULL（audit allowlist）；
// kt_json 由独立软轨写者 kt-calibration.ts applyKtEstimate 经夜扫 UPDATE 落库（YUK-348，
// BKT forward sink，纯持久化零下游消费者，ADR-0035 决定 #4）——硬轨 applier 不碰它。

import { newId } from '@/core/ids';
import type { ItemPriorDraftT } from '@/core/schema/item_prior';
import type { Db, Tx } from '@/db/client';
import { item_calibration } from '@/db/schema';

type DbLike = Db | Tx;

export interface ApplyItemPriorInput {
  questionId: string;
  draft: ItemPriorDraftT;
  /** provenance — 默认 'llm_prior'（ItemPriorTask）。fixed_anchor 慢热校准走别的 source。 */
  source?: string;
}

/**
 * Persist a cold-start difficulty anchor for a question. Idempotent by
 * `item_calibration_question_unique` (onConflictDoNothing) — re-running the
 * backfill never double-writes. Hard track only; soft columns stay NULL.
 */
export async function applyItemPrior(db: DbLike, input: ApplyItemPriorInput): Promise<void> {
  const now = new Date();
  await db
    .insert(item_calibration)
    .values({
      id: newId(),
      question_id: input.questionId,
      b: input.draft.b_logit,
      // YUK-361 Phase 6 (Task 11) — b_anchor 与 b 列**同源**写入（冷启锚 = ItemPriorTask
      // 的 feature→b 先验）。effectiveB 读 b_calib ?? b_anchor ?? b：新行 b_calib 仍 NULL
      // （重标定攒够标签才 firm-up），故 effectiveB 退回 b_anchor。给 b_anchor 一条 INSERT
      // write path（audit:schema）+ 让 active-PPI 的 b_anchor 池预测有非空锚可读。
      b_anchor: input.draft.b_logit,
      confidence: input.draft.confidence,
      track: 'hard',
      source: input.source ?? 'llm_prior',
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing({ target: item_calibration.question_id });
}
