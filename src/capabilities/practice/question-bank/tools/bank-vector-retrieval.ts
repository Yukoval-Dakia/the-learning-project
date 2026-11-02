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
//
// Rule version 2 can also count rank-1 when rank-2 is the same topic and the lead over
// the first hit outside that cluster is large enough. The branch stays closed until a
// frozen sample selects an arm and bounds: false_enough = 0 is a hard constraint, not a
// measured rate. A small q↔q distance is not evidence of the same topic.

import { type SQL, sql } from 'drizzle-orm';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import { embedCurrencyPredicate } from '@/db/embed-currency';
import { question, question_group_lifecycle } from '@/db/schema';

export const BANK_VECTOR_RETRIEVAL_RULE_VERSION = 2;

/** 检索召回的绝对天花板（cosine 距离；pgvector `<=>`，越小越近）。PROVISIONAL。 */
export const BANK_VECTOR_RETRIEVAL_MAX_DISTANCE = 0.55;

/** top-1 计入所需的领先幅度：rank2.distance − rank1.distance ≥ 此值。PROVISIONAL。 */
export const BANK_VECTOR_RETRIEVAL_TOP1_MARGIN = 0.15;

export interface BankVectorRetrievalParams {
  readonly maxDistance: number;
  readonly top1Margin: number;
}

export interface BaselineVectorHit {
  readonly id: string;
  readonly distance: number;
}

/** Leaf annotation plus the authoritative identity columns. No ancestor fold, no near-dup hold. */
export interface TopicIdentity {
  readonly id: string;
  readonly rootQuestionId: string | null;
  readonly parentVariantId: string | null;
  readonly parentQuestionId: string | null;
  readonly canonicalContentHash: string | null;
  /** Empty means the leaf-KC arm is unavailable. That is not a disproof. */
  readonly leafKnowledgeIds: readonly string[];
}

/**
 * q↔q distance enters only as a disproof. `not_above_bound` is not a
 * confirmation — there is no variant that means "near, therefore same topic".
 */
export type PairDistanceDisproof =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'above_bound' }
  | { readonly kind: 'not_above_bound' };

export type OpenTopicArm =
  | { readonly kind: 'A1' }
  | { readonly kind: 'A2' }
  | { readonly kind: 'A3'; readonly pairDistanceDisproofBound: number };

export type TopicEvidenceArm = { readonly kind: 'closed' } | OpenTopicArm;

export type ClusterCountBranch =
  | { readonly status: 'closed' }
  | {
      readonly status: 'open';
      readonly clusterMargin: number;
      readonly clusterTopK: number;
      readonly arm: OpenTopicArm;
    };

export interface BankVectorRetrievalParamsV2 extends BankVectorRetrievalParams {
  readonly cluster: ClusterCountBranch;
}

/**
 * Decisive 锚点仍是 0.55 / 0.15。簇分支关闭：没有选定臂，也没有 clusterMargin、
 * 窗口 K、q↔q 否证上界。样本仍是 pending_external_fill，打开分支就是未测量的
 * false_enough。false_enough 必须保持 0。
 */
export const BANK_VECTOR_RETRIEVAL_PARAMS: BankVectorRetrievalParamsV2 = {
  maxDistance: BANK_VECTOR_RETRIEVAL_MAX_DISTANCE,
  top1Margin: BANK_VECTOR_RETRIEVAL_TOP1_MARGIN,
  cluster: { status: 'closed' },
};

const COUNTED_RANK = 0;

type DecisiveVerdict =
  | { readonly kind: 'no_competitor' }
  | { readonly kind: 'above_ceiling' }
  | { readonly kind: 'decisive' }
  | { readonly kind: 'margin_short' };

type ClusterVerdict =
  | { readonly kind: 'window_incomplete' }
  | { readonly kind: 'rank2_outside' }
  | { readonly kind: 'surface_is_cluster' }
  | { readonly kind: 'outside_lead' }
  | { readonly kind: 'outside_short' };

function presentEqual(left: string | null, right: string | null): boolean {
  return left !== null && left.length > 0 && left === right;
}

/** Shared non-null value, or one row's id is the other's link target. */
function linkedBy(
  field: (row: TopicIdentity) => string | null,
  left: TopicIdentity,
  right: TopicIdentity,
): boolean {
  const leftValue = field(left);
  const rightValue = field(right);
  if (presentEqual(leftValue, rightValue)) return true;
  if (leftValue !== null && leftValue.length > 0 && leftValue === right.id) return true;
  return rightValue !== null && rightValue.length > 0 && rightValue === left.id;
}

/**
 * Authoritative dedup only: exact hash, variant root, variant parent, or the
 * same part group. A vector-near hold is not an input; it is not a decision.
 */
function authoritativeSameTopic(left: TopicIdentity, right: TopicIdentity): boolean {
  if (presentEqual(left.canonicalContentHash, right.canonicalContentHash)) return true;
  if (linkedBy((row) => row.rootQuestionId, left, right)) return true;
  if (linkedBy((row) => row.parentVariantId, left, right)) return true;
  return presentEqual(left.parentQuestionId, right.parentQuestionId);
}

function sharedLeafKnowledge(left: TopicIdentity, right: TopicIdentity): boolean {
  const a = left.leafKnowledgeIds;
  const b = right.leafKnowledgeIds;
  if (a.length === 0 || b.length === 0) return false;
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  const largeSet = new Set(large);
  for (const id of small) {
    if (largeSet.has(id)) return true;
  }
  return false;
}

export function pairDistanceDisproof(distance: number | null, bound: number): PairDistanceDisproof {
  if (distance === null || !Number.isFinite(distance) || !Number.isFinite(bound)) {
    return { kind: 'unavailable' };
  }
  return distance > bound ? { kind: 'above_bound' } : { kind: 'not_above_bound' };
}

export function sameTopic(
  left: TopicIdentity,
  right: TopicIdentity,
  arm: OpenTopicArm,
  pairDistance: ((leftId: string, rightId: string) => number | null) | undefined,
): boolean {
  if (authoritativeSameTopic(left, right)) return true;
  if (arm.kind === 'A1') return false;
  if (arm.kind === 'A3') {
    // An unevaluable guard must not promote leaf-KC overlap into a cluster.
    if (pairDistance === undefined) return false;
    const verdict = pairDistanceDisproof(
      pairDistance(left.id, right.id),
      arm.pairDistanceDisproofBound,
    );
    if (verdict.kind !== 'not_above_bound') return false;
    // A small distance is not itself evidence. Leaf KC may still confirm.
  }
  return sharedLeafKnowledge(left, right);
}

/** A1 is authoritative only. A2 adds shared leaf KC. A3 adds the disproof guard. */
export function compileSameTopic(
  facts: readonly TopicIdentity[],
  arm: TopicEvidenceArm,
  pairDistance?: (leftId: string, rightId: string) => number | null,
): (leftId: string, rightId: string) => boolean {
  if (arm.kind === 'closed') return () => false;
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const openArm = arm;
  return (leftId, rightId) => {
    if (leftId === rightId) return true;
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    if (left === undefined || right === undefined) return false;
    return sameTopic(left, right, openArm, pairDistance);
  };
}

function decisiveVerdict(
  distancesAscending: readonly number[],
  params: BankVectorRetrievalParams,
): DecisiveVerdict {
  if (distancesAscending.length < 2) return { kind: 'no_competitor' };
  const rank1 = distancesAscending[0];
  const rank2 = distancesAscending[1];
  if (
    rank1 === undefined ||
    rank2 === undefined ||
    !Number.isFinite(rank1) ||
    !Number.isFinite(rank2) ||
    rank2 < rank1
  ) {
    return { kind: 'no_competitor' };
  }
  if (rank1 > params.maxDistance) return { kind: 'above_ceiling' };
  if (rank2 - rank1 >= params.top1Margin) return { kind: 'decisive' };
  return { kind: 'margin_short' };
}

function closeCluster(
  window: readonly BaselineVectorHit[],
  originId: string,
  sameTopic: (leftId: string, rightId: string) => boolean,
): Set<string> {
  const members = new Set<string>([originId]);
  const pending = [originId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const hit of window) {
      if (members.has(hit.id)) continue;
      if (!sameTopic(current, hit.id)) continue;
      members.add(hit.id);
      pending.push(hit.id);
    }
  }
  return members;
}

function clusterVerdict(
  baselineTopK: readonly BaselineVectorHit[],
  sameTopic: (leftId: string, rightId: string) => boolean,
  cluster: Extract<ClusterCountBranch, { status: 'open' }>,
): ClusterVerdict {
  const windowSize = cluster.clusterTopK;
  if (!Number.isInteger(windowSize) || windowSize < 2) return { kind: 'window_incomplete' };
  if (!Number.isFinite(cluster.clusterMargin) || cluster.clusterMargin < 0) {
    return { kind: 'outside_short' };
  }
  const window = baselineTopK.slice(0, windowSize);
  const origin = window[0];
  const second = window[1];
  if (origin === undefined || second === undefined) return { kind: 'window_incomplete' };
  const members = closeCluster(window, origin.id, sameTopic);
  if (!members.has(second.id)) return { kind: 'rank2_outside' };
  const firstOutside = baselineTopK.find((hit) => !members.has(hit.id));
  if (firstOutside === undefined) {
    // Rows past K are outside the closure. If one was fetched it would be
    // firstOutside. length <= K means the qualified surface ended.
    if (baselineTopK.length > windowSize) return { kind: 'window_incomplete' };
    return { kind: 'surface_is_cluster' };
  }
  return firstOutside.distance - origin.distance >= cluster.clusterMargin
    ? { kind: 'outside_lead' }
    : { kind: 'outside_short' };
}

/**
 * Which baseline rank counts. v2 still returns only rank-1 or null.
 * `baselineTopK` is ascending distance. While the cluster branch is open the
 * caller must fetch clusterTopK + 1 rows so a saturated window is not mistaken
 * for an exhausted surface (that mistake counts a false enough).
 * A null `sameTopic` cannot open the cluster branch.
 */
export function countedRankV2(
  baselineTopK: readonly BaselineVectorHit[],
  sameTopic: ((leftId: string, rightId: string) => boolean) | null,
  params: BankVectorRetrievalParamsV2,
): number | null {
  const decisive = decisiveVerdict(
    baselineTopK.map((hit) => hit.distance),
    params,
  );
  if (decisive.kind === 'decisive') return COUNTED_RANK;
  if (decisive.kind !== 'margin_short') return null;
  if (params.cluster.status !== 'open' || sameTopic === null) return null;
  const verdict = clusterVerdict(baselineTopK, sameTopic, params.cluster);
  return verdict.kind === 'surface_is_cluster' || verdict.kind === 'outside_lead'
    ? COUNTED_RANK
    : null;
}

/** Decisive clause only. The engine counts through {@link countedRankV2}. */
export function bankVectorCountedRank(
  baselineDistancesAscending: readonly number[],
  params: BankVectorRetrievalParams = BANK_VECTOR_RETRIEVAL_PARAMS,
): number | null {
  return decisiveVerdict(baselineDistancesAscending, params).kind === 'decisive'
    ? COUNTED_RANK
    : null;
}

/** Closed branch matches the v1 pair. An open branch fetches one past K. */
export function bankVectorBaselineLimit(params: BankVectorRetrievalParamsV2): number {
  if (params.cluster.status !== 'open') return 2;
  const windowSize = params.cluster.clusterTopK;
  if (!Number.isInteger(windowSize) || windowSize < 2) return 2;
  return windowSize + 1;
}

/**
 * 「合格库面」谓词（单一真相，引擎的 margin 基线查询与标定脚本的取数共用，防漂移）：
 * 顶层、非固定窗口诊断题、无 dismissed/archived 墓碑、未撤回、带向量。**不含任何
 * scope 过滤**（subject/kind/source/knowledge/difficulty/within/exclude/draft/admission
 * 一概不施）——margin 必须在全球库面上量，否则 scope 滤掉全局 rank-2 会伪造 decisive。
 * 调用方必须 LEFT JOIN question_group_lifecycle（withdrawn 谓词引用它）。
 * 向量还须对行 revision 当前（embed-currency 谓词）：落后 revision 的向量不参与 margin 判定。
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
