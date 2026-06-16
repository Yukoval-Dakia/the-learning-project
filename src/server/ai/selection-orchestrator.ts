// YUK-361 Phase 3 Step B (Task 8 L2) — SelectionOrchestratorTask 解析 barrier +
// 分桶输入格式化器。
//
// 权威 spec：
//   - docs/superpowers/plans/2026-06-16-phase3-randomized-mfi-impl.md（Step B）
//   - ADR-0042 编排档2 amendment（docs/adr/0042-...md:46-68）
//
// 两个出口：
//   - buildSelectionOrchestratorInput(candidates)：把 Step A 的 CollectedSignal[] 投影成
//     **分桶**的紧凑文字（high/mid/low 而非原始浮点）。ADR-0042:68 诚实天花板——LLM 对
//     prompt 原始浮点不敏感（「被携带未被使用」），故 prompt 只喂分桶；真实数值由 sampler
//     （Step C）兜 π_i。
//   - parseSelectionOrchestratorOutput(text, inputRefIds)：brace-slice + Zod parse（照
//     item-prior.ts:9-28 / question-author 同款），再做选题专属后置校验：
//       · emitted refId ⊆ inputRefIds（丢未知/幻觉 id，不 throw——LLM 偶发幻觉 id 是
//         可恢复的，丢掉即可；只有结构性失败才 throw）；
//       · dedup（同 refId 多次出现取**首次**，后续丢弃）；
//       · weight ≥ 0（Zod 已 min(0) 硬拒负权——越界 throw 当本轮失败，走 fallback）；
//       · 去重/过滤后若 candidates 空 → throw（无可用编排 = 本轮失败）。

import type { CollectedSignal } from '@/capabilities/practice/server/candidate-signals';
import {
  type SelectionOrchestratorCandidateT,
  SelectionOrchestratorDraft,
} from '@/core/schema/selection-orchestrator';

// ───────────────────────────────────────────────────────────────────────────
// 分桶（bucketing）——signal-fidelity mitigation（ADR-0042:68）。
// ───────────────────────────────────────────────────────────────────────────

export type SignalBand = 'high' | 'mid' | 'low' | 'n/a';

/**
 * 把一个 [0, ~0.25] 的 MFI/诊断分数分到 high/mid/low 三档。
 * MFI = p(1−p) ∈ [0, 0.25]（θ̂=b 时取最大 0.25）。三等分边界 = 0.25/3 与 2·0.25/3，
 * 即 ≈0.083 / ≈0.167。undefined（recall-locked / 缺 θ̂或b）→ 'n/a'。
 *
 * 固定边界（非数据驱动分位）保证测试可断言**稳定**的 band——同一输入永远同一 band，
 * 不随候选集分布漂移。
 */
export function bucketMfi(score: number | undefined): SignalBand {
  if (score === undefined) return 'n/a';
  const third = 0.25 / 3;
  if (score >= 2 * third) return 'high';
  if (score >= third) return 'mid';
  return 'low';
}

/**
 * 把一个 0-1 的归一化信号（examRelevance / misconceptionRecurrence / transferGap）
 * 分到 high/mid/low 三档（边界 1/3、2/3）。undefined（无 cheap reader，Step A 一律
 * undefined）→ 'n/a'。
 */
export function bucketUnit(value: number | undefined): SignalBand {
  if (value === undefined) return 'n/a';
  if (value >= 2 / 3) return 'high';
  if (value >= 1 / 3) return 'mid';
  return 'low';
}

/**
 * b 锚来源 → 给 LLM 的可信度标签。'difficulty_proxy' 是序数当 interval 的弱锚（VERIFY
 * REFUTED，candidate-signals.ts:49），告诉 LLM 「这个难度信号是粗估，别太当真」。
 */
function bSourceLabel(bSource: CollectedSignal['bSource']): string {
  switch (bSource) {
    case 'item_calibration':
      return 'calibrated';
    case 'difficulty_proxy':
      return 'rough_estimate';
    default:
      return 'unknown';
  }
}

/**
 * 把一条 CollectedSignal 投影成一行**分桶**文字。原始浮点（mfiScore/θ̂/b/§9.2）全部
 * 转成 band 标签——LLM 看不到任何原始数值。
 */
function projectCandidate(sig: CollectedSignal): string {
  const parts: string[] = [`refId=${sig.refId}`, `refKind=${sig.refKind}`, `role=${sig.role}`];
  if (sig.recallLocked) {
    // recall-locked：原题重背，不进 MFI 评分（ADR-0030/ADR-0042:36）——明确告诉 LLM。
    parts.push('recall_locked=true (原题重背，不重排不换题)');
  } else {
    parts.push(`mfi=${bucketMfi(sig.mfiScore)}`);
    parts.push(`diagnostic=${bucketMfi(sig.diagnosticScore)}`);
    parts.push(`difficulty_anchor=${bSourceLabel(sig.bSource)}`);
  }
  // §9.2 first-class 信号（Step A 当前全 undefined → 全 'n/a'；future cheap reader 落地
  // 后自动有 band）。仍投影出来，保证 prompt 形态在数据到位时无需改格式。
  parts.push(`exam_relevance=${bucketUnit(sig.examRelevance)}`);
  parts.push(`misconception_recurrence=${bucketUnit(sig.misconceptionRecurrence)}`);
  parts.push(`transfer_gap=${bucketUnit(sig.transferGap)}`);
  return parts.join(' | ');
}

/**
 * buildSelectionOrchestratorInput — 把全部非到期候选投影成分桶文字块，喂 L2 LLM。
 *
 * 输出形态（每候选一行）：
 *   refId=… | refKind=question | role=diagnostic | mfi=high | diagnostic=mid |
 *   difficulty_anchor=calibrated | exam_relevance=n/a | …
 *
 * 调用方（Step C shell）把这块文字塞进 runTask input（连同 learner narrative 等上下文）。
 * 空输入 → 返回空字符串（上游不该在无候选时调 LLM；防御性返回空而非 throw）。
 */
export function buildSelectionOrchestratorInput(candidates: CollectedSignal[]): string {
  return candidates.map(projectCandidate).join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// 解析 barrier。
// ───────────────────────────────────────────────────────────────────────────

/**
 * parseSelectionOrchestratorOutput — brace-slice + Zod + 选题专属后置校验。
 *
 * @param text         LLM 原始文本（可能含 JSON 外的噪声/markdown 围栏）。
 * @param inputRefIds  本轮喂给 LLM 的合法候选 refId 全集（⊆ 校验锚）。
 * @returns            过滤/去重后的合法候选编排数组（每个 refId 至多一条）。
 *
 * throws（→ 调用方当本轮失败，走 Step C 的统计 sampler fallback）：
 *   - 文本里没有 JSON 对象 / JSON.parse 失败 / Zod schema 不匹配（含负权 weight<0）；
 *   - ⊆ 过滤 + dedup 后 candidates 为空（无任何合法编排可用）。
 * 不 throw（可恢复，静默丢弃）：未知 refId（幻觉 id）、重复 refId（取首次）。
 */
export function parseSelectionOrchestratorOutput(
  text: string,
  inputRefIds: readonly string[],
): SelectionOrchestratorCandidateT[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseSelectionOrchestratorOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseSelectionOrchestratorOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = SelectionOrchestratorDraft.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseSelectionOrchestratorOutput: schema invalid: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }

  const allowed = new Set(inputRefIds);
  const seen = new Set<string>();
  const out: SelectionOrchestratorCandidateT[] = [];
  for (const cand of parsed.data.candidates) {
    // 幻觉 id：丢（不 throw）——LLM 偶发凭空造 refId，过滤即可恢复。
    if (!allowed.has(cand.refId)) continue;
    // 重复 id：取首次出现，后续丢（dedup）。
    if (seen.has(cand.refId)) continue;
    seen.add(cand.refId);
    out.push(cand);
  }

  if (out.length === 0) {
    throw new Error(
      'parseSelectionOrchestratorOutput: no valid candidates after refId ⊆ filter + dedup',
    );
  }
  return out;
}
