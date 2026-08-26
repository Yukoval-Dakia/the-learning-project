// ADR-0038 决定#2 — plan-then-generate: QuizPlanTask (Phase 1).
//
// docs/adr/0038-unified-verify-contract-plan-then-generate.md 决定#2 first bullet:
// 出题分两段——先产出题计划（要考哪个知识点、什么题型、客观题的标准答案锚点），
// 再据计划生成题面。The plan is a machine-checkable artifact, NOT prompt-internal
// prose: this task emits the strict QuizGenPlan JSON, the Q3 handler validates it
// deterministically (src/capabilities/practice/jobs/quiz_gen_plan.ts — schema +
// real knowledge-point existence read + kind/anchor sanity), and only an ACCEPTED
// plan proceeds to the existing QuizGenTask generation call.
//
// The handler mounts the same in-process domain-tool MCP as QuizGenTask (read the
// knowledge graph / user mistakes) but NO Tavily — planning picks what to test,
// not what material to fetch (that stays in the generation phase).

import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { QuizGenPlan, type QuizGenPlanT } from '@/core/schema/quiz_gen';
import type { SubjectProfile } from '@/subjects/profile';
import { CANONICAL_QUESTION_KINDS } from './generation-prompt-support';
import { parseTaskOutput } from './parse-output';

function buildQuizPlanPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}出题规划人。输入 { trigger: 'knowledge'|'learning_item'|'manual', ref: { id, name, ... }, knowledge_context, count, requested_generation_method?: 'material_grounded'|'closed_book', requested_kind?: string, objective_only?: boolean, kind_required?: boolean, previous_rejection?: string[] } —— ref 是触发出题的知识点 / 学习项，count 是计划题数（默认 3）。你的任务**只做规划，不写题面**：为 count 道题各定一个计划项（考哪个知识点、什么题型、多难、客观题给标准答案锚点）。下游会逐项机检本计划，通过后才据它生成题面。
科目上下文：${profile.displayName}。${profile.languageStyle}

你有领域读工具（可读用户错题与知识图谱），用来：
- 确认每个计划项的 knowledge_id 是知识图谱里**真实存在且未归档**的节点（优先用输入 knowledge_context 里给出的 id；manual 自由触发时先用工具检索真实节点再引用，**绝不发明 id**——计划里的 id 会被机检回查，查无此点整份计划被拒）。
- 读用户的错题 / 掌握信号，决定难度与题型分布。

硬约束（违反任一即整份计划被机检拒绝）：
- 输出**恰好 count 个**计划项，顺序即生成顺序。
- 每项 kind 只能取 ${CANONICAL_QUESTION_KINDS} 之一（按答案类型与题面结构选择）。
- 客观题（choice / true_false / fill_blank）每项**必须**给 answer_anchor：这道题的标准答案锚点（choice=正确选项的完整正文；true_false=「对」或「错」；fill_blank=标准填空答案）。锚点是后续校验的确定性靶子，必须是最终判分认可的准确表述，不能是解释性描述。
- 非客观题不给 answer_anchor（开放 / 语义判分题的答案在生成阶段写 rubric）。
- requested_generation_method 出现时是硬约束：计划顶层 generation_method 必须等于它；缺省时自行选择（material_grounded=需要真实原文锚的阅读类，closed_book=闭卷，search_grounded=常规检索背景素材）。
- objective_only=true 或 kind_required=true 时，requested_kind 是硬约束：每项 kind 都必须与它一致；否则 requested_kind 只是偏好，优先遵从但素材明显更支持别的结构时可改选实际结构。
- previous_rejection（若有）是上一轮机检的拒绝原因列表：逐条修正后重新输出完整计划，不要输出解释。

整体严格 JSON 输出（不带 markdown 代码块包裹），shape 名 QuizGenPlan：
{"items":[{"knowledge_id":"知识点 id","kind":"${CANONICAL_QUESTION_KINDS} 之一","difficulty":1-5 的整数,"answer_anchor":"客观题标准答案锚点"}],"generation_method":"search_grounded"|"closed_book"|"material_grounded"}
answer_anchor 仅客观题（choice / true_false / fill_blank）必填，其余题型省略该字段。禁止 emoji、禁止 JSON 之外的文字。`;
}

export const quizPlanTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'QuizPlanTask',
    description:
      'Plan-then-generate Phase 1 (ADR-0038 决定#2): produces the machine-checkable question PLAN — which knowledge point, what kind, difficulty, and the standard-answer anchor for objective kinds — as strict QuizGenPlan JSON. The Q3 handler deterministically gates it (schema + real knowledge-point existence + kind/anchor sanity; bounded regeneration, fail-closed) before the QuizGenTask generation call consumes the accepted plan. Read-only domain MCP mounted by the handler; no Tavily.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 4, timeout: 90_000 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildQuizPlanPrompt },
  },
  outputSchema: QuizGenPlan,
  parseText: (text) => parseTaskOutput(text, 'QuizPlanTask', QuizGenPlan),
} satisfies TaskSpec<unknown, QuizGenPlanT>;
