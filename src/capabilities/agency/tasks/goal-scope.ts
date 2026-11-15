// GoalScopeTask contract: output schema + strict parser + profile prompt.
// ../server/goals/scope owns the knowledge-grid snapshot, id-subset filter and
// goal_scope proposal write.
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

import { z } from 'zod';
import type { SubjectProfile } from '@/subjects/profile';

const OrderedScopePoint = z.object({
  knowledge_id: z.string().min(1),
  // 1-based position in the recommended learn order. AI-inferred, NOT a progress
  // metric; the value only ranks members of this scope list against each other.
  order: z.number().int().min(1),
});
export type OrderedScopePointT = z.infer<typeof OrderedScopePoint>;

export const GoalScopeOutputSchema = z.object({
  scope_knowledge_ids: z.array(z.string().min(1)).default([]),
  // Ordered knowledge-point path. When present, this is the canonical ordered
  // representation; `scope_knowledge_ids` stays as the unordered coverage set so
  // historical readers keep working. Every entry must reference a grid node id.
  ordered_scope: z.array(OrderedScopePoint).default([]),
  sequence_hint: z.number().int().min(0).default(0),
  reasoning: z.string().min(1).max(4000),
});
export type GoalScopeOutput = z.infer<typeof GoalScopeOutputSchema>;

export function parseGoalScopeOutput(text: string): GoalScopeOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseGoalScopeOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseGoalScopeOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return GoalScopeOutputSchema.parse(json);
}

function buildGoalScopePrompt(profile: SubjectProfile): string {
  return `你是学习目标规划助手。用户给一个模糊的学习目标标题（如「能流畅读《史记》」），输入 { goal_title, subject_id, grid: { nodes: [{ id, name, effective_domain, mastery, evidence_count }], edges: [{ from_knowledge_id, to_knowledge_id, relation_type }] } }。
科目上下文：${profile.displayName}。${profile.languageStyle}
任务：从 grid.nodes 里推断这个目标**覆盖**哪些知识节点，并**必须**给出逐知识点的学习顺序。输入的 grid 已经限定在所选科目的子树内；不要引用子树外的节点。
利用 edges 的 prerequisite / related_to 关系判断先后；mastery 低的薄弱节点更值得纳入 scope，并尽量排在被它卡住的其他节点之前。
严格 JSON 输出（不带 markdown 代码块包裹）：
{"scope_knowledge_ids":["<grid.nodes 里的 id>","..."],"ordered_scope":[{"knowledge_id":"<grid.nodes 里的 id>","order":1},{"knowledge_id":"<grid.nodes 里的 id>","order":2}],"sequence_hint":0,"reasoning":"... 为什么这些节点构成这个目标的覆盖范围 + 顺序依据 ..."}
要点：
- scope_knowledge_ids 里的每个 id 必须是 grid.nodes 里真实存在的 id；禁止发明节点
- ordered_scope 是**必填**：给出目标覆盖节点的**学习顺序**，order 从 1 开始连续编号，knowledge_id 与 scope_knowledge_ids 集合一一对应，缺一个或错序都不合格
- sequence_hint 是一个全局整数排序提示（向后兼容字段），**不是**进度 / 完成度（不要输出百分比 / 完成率）
- reasoning 具体：引用节点名 + prerequisite 关系或 mastery 证据，别空泛
- 覆盖范围宁缺毋滥：只纳入真正服务于该目标的节点，不凑数
- 禁止套话（「加油」「这是个好目标」）`;
}

export const goalScopeTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'GoalScopeTask',
    description:
      'YUK-143 / ADR-0024 — North-Star goal→scope translation (ND-2). Input = goal title + knowledge-grid snapshot (nodes + mastery + mesh edges). Output = inferred scope_knowledge_ids[] + rough sequence_hint + reasoning, written as a `goal_scope` AiProposal (confirm/edit/dismiss). Single structured-output call (no tool loop), registry-default text model.',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    context: {
      view: 'none',
      reason: '目标范围提议按目标与知识图谱读数装配，不读学习者画像 view。',
    },

    prompt: { kind: 'profile', build: buildGoalScopePrompt },
  },
  outputSchema: GoalScopeOutputSchema,
  parseText: parseGoalScopeOutput,
} satisfies TaskSpec<unknown, GoalScopeOutput>;
