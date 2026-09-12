// YUK-987 (985/E2) — SupplyPlanTask：供给需求层的 planner agent。
//
// 照 ADR-0038 quiz_gen_plan 范式（plan-then-gate）：LLM 只产出需求计划
// （补哪个知识点、什么题型、多少道、偏好哪条获取路线、为什么），产出的
// SupplyPlanV1 JSON 由确定性机器门验证（supply-plan-gate.ts：schema +
// 活 knowledge_id + 词表 + 去重 + 预算声明），通过后计划才生效；拒绝则
// ≤2 轮有界重生成，仍不过 fail closed（当晚零需求事件，扫描器安全网照常
// 派发缺口）。执行面（E3 executor）未落地前，需求逐项 emit manual 留痕。
//
// 读面原则：handler 预装**原始信号**（知识树 + 每 KC 可用题数 + 掌握信号 +
// 待处理 placement claim + jyeoo 预算余量），不喂扫描器的目标结论——
// planner 的需求必须独立形成，shadow 对比才有信号价值。agent 另挂只读
// 知识图谱 DomainTool 用于下钻核实节点（绝不发明 id，机检回查）。

import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { SupplyPlanV1, type SupplyPlanV1T } from '@/core/schema/supply_plan';
import type { SubjectProfile } from '@/subjects/profile';
import { CANONICAL_QUESTION_KINDS } from './generation-prompt-support';
import { parseTaskOutput } from './parse-output';

function buildSupplyPlanPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}科目的供给规划人（supply planner）。每晚你读取题池的原始信号，决定**要补什么题**——产出一份需求计划 SupplyPlanV1（JSON），下游确定性机器门会逐项机检，通过后才生效。你只规划需求，不取题、不写题、不决定执行。

输入 shape：
{
  date: 今晚日期,
  subjects: [{ id, display_name, knowledge_nodes: 节点数, frontier: [{ id, name, theta, evidence_count, available_questions, draft_questions }] }],
  pending_placement_claims: [{ claim_id, subject_id, knowledge_id }],  // 诊断放置等已声明的供给需求
  jyeoo_budget_remaining: 今日 jyeoo 付费题剩余预算,
  previous_rejection?: 上一轮机检拒绝原因（若有则逐条修正后重出完整计划）
}

规划原则：
- 只为**真实存在的知识点**规划：knowledge_id 必须从输入 frontier 列表里选，或用只读知识图谱工具核实后引用；发明 id 会被机检查无此点整份拒绝。
- 优先补：available_questions = 0 的前缘节点（零覆盖冷启动）、evidence_count 低但有掌握信号的节点、pending_placement_claims 指向的节点（诊断放置需要题）。
- available/draft 充足的节点不要补（题池已够）。
- 难度档按该节点的 theta 与 evidence_count 判断：无信号给 'near'，theta 低给 'below'/'near'，theta 高且需要拉开给 'above'/'stretch'。
- route_preference 是偏好不是承诺：'sourcing_web'（web 既存题）优先于 'quiz_gen'（生成）；'jyeoo_fetch' 仅在你判断需要真题风格且预算够时放入（付费，40/日硬顶）。执行侧有权降级。

硬约束（违反任一即整份被拒）：
- items 至多 25 项；每项 count 1-10；同一 (knowledge_id, kind, difficulty_band) 格子只能出现一次（要更多就合并 count）。
- kind 只能取 ${CANONICAL_QUESTION_KINDS} 之一，或 'any'（该格子任意题型可填）。
- difficulty_band 只能取 below | near | above | stretch。
- route_preference 每项至少一路，值只能取 sourcing_web | quiz_gen | author_question | ingest_existing | image_candidate | jyeoo_fetch。
- 每项必须给 rationale（≤500 字，说清为什么这个格子值得补——留痕与 shadow 分析用）。
- 顶层 budget.jyeoo_questions 是你声明本计划预计消耗的 jyeoo 题数：不得超过 jyeoo_budget_remaining；路线仅含 jyeoo_fetch 的项的 count 总和不得超过声明值。
- 空 items 合法：若题池确无值得补的格子，输出空计划（这是有效结论，不是失败）。
- previous_rejection 出现时逐条修正，重新输出完整计划，不要解释。

整体严格 JSON 输出（不带 markdown 代码块包裹），shape 名 SupplyPlanV1：
{"version":1,"items":[{"knowledge_id":"知识点 id","kind":"题型或 any","difficulty_band":"near","count":3,"route_preference":["sourcing_web","quiz_gen"],"rationale":"为什么补"}],"budget":{"jyeoo_questions":0}}
禁止 emoji、禁止 JSON 之外的文字。`;
}

export const supplyPlanTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'SupplyPlanTask',
    description:
      'YUK-987 supply planner (985/E2): the demand-layer agent. Nightly reads raw pool signals (knowledge frontier + per-KC availability + mastery + pending placement claims + jyeoo budget) and emits a SupplyPlanV1 demand plan — which knowledge cells need how many questions of what kind/band via which route preference. The deterministic machine gate (supply-plan-gate.ts: schema + live knowledge ids + vocabulary + dedupe + budget declaration) accepts or rejects; bounded regeneration (≤2), fail-closed. Accepted items emit manual demand events until the E3 executor lands; scanner stays the safety net.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 4, timeout: 90_000 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildSupplyPlanPrompt },
  },
  outputSchema: SupplyPlanV1,
  parseText: (text) => parseTaskOutput(text, 'SupplyPlanTask', SupplyPlanV1),
} satisfies TaskSpec<unknown, SupplyPlanV1T>;
