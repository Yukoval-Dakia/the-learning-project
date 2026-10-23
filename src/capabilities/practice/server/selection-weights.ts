import type { SelectionOrchestratorCandidateT } from '@/core/schema/selection-orchestrator';
import { DIFFICULTY_PROXY_WEIGHT } from '@/core/theta';
import type { CollectedSignal } from './candidate-signals';
import type { WeightedCandidate } from './selection-sampler';

/** Reconcile partial LLM advice with the full samplable pool and its arrangement. */
export function reconcileSelectionAdvice(
  samplable: CollectedSignal[],
  parsed: SelectionOrchestratorCandidateT[],
): { weighted: WeightedCandidate[]; arrangementByRef: Map<string, number> } {
  // （positivity / silent candidate loss）：LLM 可能只编排 samplable 的**子集**
  // （漏排 / 重复被 dedup / 幻觉 id 被 ⊆filter 丢）。parse barrier 只在结果**全空**时才
  // throw；部分子集会让被漏掉的 samplable 候选拿不到权重 → 不进 sampleByWeight → π_i=0
  // → 违反 positivity（每个 samplable 候选都需 π_i>0，否则它永不被选中、也
  // 永不被记进 IPW 资产 → active-PPI 估计偏置）。
  // 修复：FLOOR-FILL——保留 LLM 给出的权重（它的编排信号），对 LLM 漏掉的每个 samplable
  // 候选补一个**统计**权重（diagnosticScore → 退 mfiScore → 退 STAT_FLOOR_EPSILON；弱锚降权），
  // 使其留在加权池里、π_i>0。这样既不丢候选，又不抹掉 LLM 对它排过的那些的偏好。
  const llmWeightByRef = new Map<string, number>(parsed.map((c) => [c.refId, c.weight]));
  const weighted: WeightedCandidate[] = samplable.map((s) => ({
    refId: s.refId,
    weight: llmWeightByRef.get(s.refId) ?? statisticalFloorWeight(s),
  }));
  const arrangementByRef = new Map<string, number>();
  for (const c of parsed) {
    if (c.arrangement !== undefined) arrangementByRef.set(c.refId, c.arrangement);
  }
  return { weighted, arrangementByRef };
}

// ───────────────────────────────────────────────────────────────────────────
// L1 fallback：纯统计 sampler。用 diagnosticScore（退 mfiScore，再退小正权；弱锚降权）当权重。
// ───────────────────────────────────────────────────────────────────────────

/** 无任何 MFI/诊断信号时的小正权——保 π_i>0（positivity）、softmax 退化为近均匀。 */
const STAT_FLOOR_EPSILON = 0.01;

/**
 * 一条 samplable 候选的统计权重：diagnosticScore 优先；缺则 mfiScore；都缺（无 θ̂/b）
 * 给 STAT_FLOOR_EPSILON 小正权（仍可被抽中，π_i>0 保 positivity——符合「无信号 → 不偏好」
 * 语义）。L1 统计 fallback 与 的 floor-fill 共用此函数（单一真相，权重语义一致）。
 */
function statisticalFloorWeight(s: CollectedSignal): number {
  const signalWeight = s.diagnosticScore ?? s.mfiScore;
  if (signalWeight === undefined) return STAT_FLOOR_EPSILON;
  return Math.max(
    STAT_FLOOR_EPSILON,
    signalWeight * (s.bSource === 'difficulty_proxy' ? DIFFICULTY_PROXY_WEIGHT : 1),
  );
}

/**
 * 把 samplable 信号映射成 WeightedCandidate[]（统计权重）。L1 fallback 用，且
 * 的作答后增量重排**复用**它（hybrid 运行时：增量重排走纯统计 sampler——用更新后 θ̂ 重算
 * mfiScore 权重，不重跑 LLM， amendment）。导出以单一真相共享权重语义。
 */
export function statisticalWeights(samplable: CollectedSignal[]): WeightedCandidate[] {
  return samplable.map((s) => ({ refId: s.refId, weight: statisticalFloorWeight(s) }));
}
