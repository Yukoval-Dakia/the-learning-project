// YUK-361 Phase 3 Step B (Task 8 L2) — SelectionOrchestratorTask LLM 输出形状。
//
// 档2（ADR-0042 编排档2 amendment, docs/adr/0042-...md:46-68）：LLM 是**主脑**。
// 它对每个**非到期**候选输出 { weight≥0, role, arrangement?, reason }——选哪些、怎么排、
// 为什么。一个薄 tempered-softmax sampler（Step C）把 weight → π_i（inclusion prob）。
// 只要 T>0，每个正权重候选 π_i>0（满足 positivity）。
//
// 范围铁律（ADR-0042:58）：LLM **不碰到期项**（due 项相对序 + presence 是 L1 确定性
// 契约）。本 task 只给**非到期候选**加权/排序。到期项不在 candidates 输入里、也不该
// 出现在输出里——parse barrier 用 inputRefIds 做 ⊆ 校验兜底。
//
// 解析 barrier + 分桶输入格式化器在 src/server/ai/selection-orchestrator.ts。
// schema 名（StructuredOutput / brace-slice 两路都用）= SelectionOrchestratorDraft。

import { z } from 'zod';

/**
 * 候选角色。与 core/selection-signals.ts 的 `SelectionCandidateSignal['role']` 同枚举去掉
 * 'due'（LLM 不碰到期项——见文件头铁律）。LLM 可据信号把候选归到 frontier（前沿新知）/
 * diagnostic（诊断/MFI 近 θ̂）/ new_check（新知巩固确认）/ paper（卷）四类之一。
 */
export const SelectionOrchestratorRole = z.enum(['frontier', 'diagnostic', 'new_check', 'paper']);
export type SelectionOrchestratorRoleT = z.infer<typeof SelectionOrchestratorRole>;

/**
 * 单候选编排决策。
 *   - refId：必须是输入候选之一（parse barrier 用 inputRefIds 做 ⊆ 校验，丢未知 id）。
 *   - weight：≥0 **且有限**的教学价值权重（越高 = 越值得现在练）。sampler 据此 softmax
 *     抽样。负权会反转排序（抽到最差候选），故 schema 硬拒 `min(0)`；非有限（Infinity/NaN，
 *     如 LLM 吐 `1e309` → JSON.parse → Infinity）会让 softmaxProbabilities 的非有限守卫抛错
 *     → 整批塌到 fallback，故 schema 用 `.finite()` 在 parse 期就拒掉。两类越界都由 parse
 *     barrier 当本轮失败（走 fallback），符合现有失败语义。
 *   - arrangement：非到期候选间的建议排序（整数，越小越靠前）。可选——LLM 不给则
 *     sampler 用纯权重序。
 *   - reason：简短教学理由（为什么这个权重/排序）。
 */
export const SelectionOrchestratorCandidate = z.object({
  refId: z.string().min(1),
  weight: z.number().finite().min(0),
  role: SelectionOrchestratorRole,
  arrangement: z.number().int().optional(),
  reason: z.string().min(1),
});
export type SelectionOrchestratorCandidateT = z.infer<typeof SelectionOrchestratorCandidate>;

/**
 * LLM 输出（一次调用，全部非到期候选的编排）。candidates 必须非空（空流不该调 LLM——
 * 上游无非到期候选时根本不进 L2）。
 */
export const SelectionOrchestratorDraft = z.object({
  candidates: z.array(SelectionOrchestratorCandidate).min(1),
});
export type SelectionOrchestratorDraftT = z.infer<typeof SelectionOrchestratorDraft>;
