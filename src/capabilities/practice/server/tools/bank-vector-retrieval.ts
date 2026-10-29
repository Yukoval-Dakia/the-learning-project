// search_bank vector-channel counting rules, separate from duplicate detection.
//
// Reusing the duplicate threshold (0.35) for topic retrieval dropped valid targets and
// admitted unrelated ones; the separating signal is the top-1 lead over rank 2.
// 1. Recall into the scoped candidate pool at distance <= MAX_DISTANCE.
// 2. Count toward coverage.verdict only for rank 1 on the baseline (unscoped) pool when a
//    rank 2 exists and (rank2 - rank1) >= TOP1_MARGIN. Margin must never be measured on the
//    scoped pool, which would invent decisive margins.
// 3. Fewer than two baseline candidates means no competitor evidence, so nothing counts.
// Weak or clustered hits stay visible with counted=false and do not raise the verdict.
// Parameters are provisional until calibrated on a real bank copy.

import { type SQL, sql } from 'drizzle-orm';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import { embedCurrencyPredicate } from '@/db/embed-currency';
import { question, question_group_lifecycle } from '@/db/schema';

export const BANK_VECTOR_RETRIEVAL_RULE_VERSION = 1;

/** 检索召回的绝对天花板（cosine 距离；pgvector `<=>`，越小越近）。PROVISIONAL。 */
export const BANK_VECTOR_RETRIEVAL_MAX_DISTANCE = 0.55;

/** top-1 计入所需的领先幅度：rank2.distance − rank1.distance ≥ 此值。PROVISIONAL。 */
export const BANK_VECTOR_RETRIEVAL_TOP1_MARGIN = 0.15;

export interface BankVectorRetrievalParams {
  readonly maxDistance: number;
  readonly top1Margin: number;
}

/** 代码内现行参数（单一真相；标定脚本按同形状扫网格时复用本接口）。 */
export const BANK_VECTOR_RETRIEVAL_PARAMS: BankVectorRetrievalParams = {
  maxDistance: BANK_VECTOR_RETRIEVAL_MAX_DISTANCE,
  top1Margin: BANK_VECTOR_RETRIEVAL_TOP1_MARGIN,
};

/**
 * 判定向量通道哪个名次计入 coverage.verdict。
 *
 * 输入：**合格库面**（bankVectorBaselinePredicates 的基准面，无 scope 过滤）上按 cosine
 * 距离升序的截头——rank-1/rank-2 永远在前两行，截断只藏更靠后的名次。scoped pool 的
 * 距离序列绝不能传进来（见模块头 R1 说明）。
 * 输出：计入的名次（0-based），无则 null。v1 至多返回 0（仅 baseline rank-1 可计入）。
 */
export function bankVectorCountedRank(
  baselineDistancesAscending: readonly number[],
  params: BankVectorRetrievalParams = BANK_VECTOR_RETRIEVAL_PARAMS,
): number | null {
  if (baselineDistancesAscending.length < 2) return null; // 无 rank-2 竞争者证据 ⇒ 保守不计入
  const [rank1, rank2] = baselineDistancesAscending;
  if (rank1 > params.maxDistance) return null;
  return rank2 - rank1 >= params.top1Margin ? 0 : null;
}

/**
 * 「合格库面」谓词（单一真相，引擎的 margin 基线查询与标定脚本的取数共用，防漂移）：
 * 顶层、非固定窗口诊断题、无 dismissed/archived 墓碑、未撤回、带向量。**不含任何
 * scope 过滤**（subject/kind/source/knowledge/difficulty/within/exclude/draft/admission
 * 一概不施）——margin 必须在全球库面上量，否则 scope 滤掉全局 rank-2 会伪造 decisive。
 * 调用方必须 LEFT JOIN question_group_lifecycle（withdrawn 谓词引用它）。
 * YUK-1603 — 向量还须对行 revision 当前（embed-currency 谓词）：落后 revision 的
 * 向量不参与 margin 判定。
 */
export function bankVectorBaselinePredicates(): SQL[] {
  const lc = question_group_lifecycle;
  return [
    sql`(${question.parent_question_id} IS NULL)`,
    sql`(${question.source} <> ${INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE})`,
    sql`((${question.metadata} -> 'dismissed_at') IS NULL)`,
    sql`((${question.metadata} -> 'archived_at') IS NULL)`,
    sql`(${lc.withdrawn} IS NULL OR ${lc.withdrawn} = false)`,
    sql`(${question.embedding} IS NOT NULL)`,
    embedCurrencyPredicate(question),
  ];
}
