// YUK-1516 — search_bank 向量通道的「检索计入」规则（与查重阈值分离）。
//
// 背景（实测，见 docs/planning/2026-10-17-yuk1516-bank-vector-retrieval-threshold.md）：
// 通道 B 原先复用查重常量 MATCHER_COSINE_MAX_DISTANCE=0.35（matcher §4，question↔question
// 查重轴）。那是「同一道题」的判重档位，不是「同主题检索」档位：真实题库副本上
// 「文言断句 划分句子朗读停顿」的正确目标题距查询向量 0.422，被 0.35 挡掉；而库中并无
// 离子方程式题，「离子方程式的书写与正误判断」的最近命中是一道无关数学题（0.436）。
// 绝对距离分不开这两类（收 0.422 必收 0.436），能分开的是 top-1 领先幅度：
// 正确目标领先第二名 0.253（0.422 → 0.675），无关命中只领先 0.110（0.436 → 0.546）。
//
// 规则 v1（保守方向：拿不准时宁可 none + gap_request，不造 false enough）：
//   ① 召回进候选池（scope 内）：distance ≤ MAX_DISTANCE（绝对天花板，取代查重 0.35
//      的池门角色）；
//   ② 计入 coverage.verdict：仅「合格库面（baseline，无 scope 过滤）」的 rank-1，且需
//      top-1 领先 decisive——合格库面上存在 rank-2 且 (rank2 − rank1) ≥ TOP1_MARGIN
//      （R1 review P1：margin 基线绝不能算在 scoped pool 上——scope 过滤掉全局
//      rank-2 竞争者会凭空制造 decisive margin，把缺题科目顶成 sparse/enough 并吞掉
//      gap_request。标定脚本与引擎共用 bankVectorBaselinePredicates()，两边不可能漂移）。
//      drop-off 之后（≥δ 落后于 rank-1）的命中按规则自身的逻辑不是已证实的主题匹配；
//      rank-1/rank-2 贴成簇（margin < δ）时没有任何 decisive 证据——两者都只在候选列表
//      展示（match_evidence.counted=false，语义同 fts weak），不抬 verdict。
//   ③ 合格库面内不足两题时无竞争者证据 ⇒ 不计入（保守）。
//
// 参数为 PROVISIONAL：以本规则落地时的两组实测为锚（0.253 vs 0.110 取中带），待 lead 在
// 真实题库副本上跑 scripts/calibrate-bank-vector-threshold.ts 标定后由代码 PR 修订；
// 版本号随规则形状（不是参数值）改动递增。
import { type SQL, sql } from 'drizzle-orm';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
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
  ];
}
