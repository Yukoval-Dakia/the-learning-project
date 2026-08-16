import { z } from 'zod';
import { causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { RelationTypeSchema } from '@/core/schema/event/blocks';
import type { SubjectProfile } from '@/subjects/profile';

export const EdgeProposalSchema = z.object({
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: RelationTypeSchema,
  weight: z.number().min(0).max(1).default(0.5),
  reasoning: z.string().min(1).max(500),
});

export type EdgeProposalSchemaT = z.infer<typeof EdgeProposalSchema>;

export const KnowledgeEdgeProposeOutputSchema = z.object({
  proposals: z.array(EdgeProposalSchema).max(5),
});

export type EdgeProposeOutput = z.infer<typeof KnowledgeEdgeProposeOutputSchema>;

export function parseEdgeProposeOutput(text: string): EdgeProposeOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseEdgeProposeOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`parseEdgeProposeOutput: JSON.parse failed: ${message}`);
  }
  return KnowledgeEdgeProposeOutputSchema.parse(json);
}

function buildKnowledgeEdgeProposePrompt(profile: SubjectProfile): string {
  return `你是知识图谱 mesh 编辑助手。输入 { tree_snapshot, existing_edges, recent_failures } —— recent_failures 是过去 24h 的 attempt event (outcome='failure')，每条含 referenced_knowledge_ids + cause（来自 chained judge / user_cause）。
科目上下文：${profile.displayName}。${profile.languageStyle}
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
看 recent_failures 找跨 attempt 的模式：哪些 knowledge 总是同时被引用？哪些是 prerequisite？哪些是易混淆 contrasts_with？哪些是应用关系？基于此提议 0-5 条新 knowledge_edge。
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
每条返回 { from_knowledge_id, to_knowledge_id, relation_type, weight, reasoning }。
relation_type 5 选 1：prerequisite（A 是学 B 的先决）/ related_to（弱关联）/ contrasts_with（易混淆对比）/ applied_in（A 应用于 B）/ derived_from（B 由 A 推导）。新型关系用 experimental:* 命名空间。
weight 0-1：模式有几次 attempt 支持就给多高（1 次→0.3 / 2-3 次→0.6 / 4+ 次→0.9）。
reasoning 必须具体：引用 attempt event id 或指出 cause pattern。
禁止：from === to；relation_type 不在合法集合；已存在于 existing_edges 的同向同型 (from, to, relation_type) 三元组。
严格 JSON 输出（不带 markdown 代码块包裹）：{"proposals":[{"from_knowledge_id":"...","to_knowledge_id":"...","relation_type":"...","weight":0.6,"reasoning":"..."}]}。0 条也行，不必凑数。`;
}

export const knowledgeEdgeProposeTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'KnowledgeEdgeProposeTask',
    description: '看 tree + 最近 failure attempts + 已有 edge，提议 0-5 条新 knowledge_edge',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 2 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildKnowledgeEdgeProposePrompt },
  },
  outputSchema: KnowledgeEdgeProposeOutputSchema,
  parseText: parseEdgeProposeOutput,
} satisfies TaskSpec<unknown, EdgeProposeOutput>;

export const FrontierPrerequisiteOutputSchema = z.object({
  proposals: z.array(EdgeProposalSchema),
});

export type FrontierPrerequisiteOutput = z.infer<typeof FrontierPrerequisiteOutputSchema>;

export function parseFrontierProposals(text: string): FrontierPrerequisiteOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseFrontierProposals: no JSON object found in text');
  }
  return FrontierPrerequisiteOutputSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

function buildFrontierPrerequisitePrompt(profile: SubjectProfile): string {
  return `你是课程先修关系规划助手。输入 { tree_snapshot, kcs_lacking_prereq, domain } —— tree_snapshot 是知识图谱节点（id / name / parent_id / effective_domain），kcs_lacking_prereq 是当前没有任何入边 prerequisite 覆盖的 KC id 列表，domain 是科目域。
科目上下文：${profile.displayName}。${profile.languageStyle}
背景：系统的「可学前沿」（learnable frontier）现在是空的——还没有任何 prerequisite 边，所以系统不知道该按什么顺序教。你的任务是从课程本身的依赖结构，为 kcs_lacking_prereq 里的 KC 补一批**临时的、低置信**先修边来 bootstrap 这个前沿。
为缺先修覆盖的 KC 提议至多 5 条 prerequisite 边。每条 { from_knowledge_id, to_knowledge_id, relation_type, weight, reasoning }：
- relation_type 固定为 "prerequisite"（from 是学 to 的先决）。
- from / to 必须是 tree_snapshot 里真实存在的 id；**to 必须 ∈ kcs_lacking_prereq**（写库侧硬校验：to 不在此列表的提议会被直接丢弃、白白浪费 ≤5 条名额，务必只给缺先修覆盖的 KC 补边）。
- weight 用低值（0.4 左右）：这是临时占位边，等用户在收件箱确认或真实边落库后替换。
- reasoning 说明课程依赖理由：为什么学 to 之前要先掌握 from（概念前提 / 技能前提 / 公式推导前提）。
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
禁止：from === to；编造不在 tree_snapshot 的 id；非课程依赖的牵强关联（宁可少提，不要凑数）。
严格 JSON 输出（不带 markdown 代码块包裹）：{"proposals":[{"from_knowledge_id":"...","to_knowledge_id":"...","relation_type":"prerequisite","weight":0.4,"reasoning":"..."}]}。0 条也行，不必凑数。`;
}

export const frontierPrerequisiteTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'FrontierPrerequisiteTask',
    description:
      '看 tree + 缺先决覆盖的 KC 列表，提议 0-5 条临时 prerequisite knowledge_edge（empty-frontier 冷启 bootstrap，propose-only 低置信）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 2 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildFrontierPrerequisitePrompt },
  },
  outputSchema: FrontierPrerequisiteOutputSchema,
  parseText: parseFrontierProposals,
} satisfies TaskSpec<unknown, FrontierPrerequisiteOutput>;

export const KnowledgeReviewOutputSchema = z.string();

export function parseKnowledgeReviewOutput(text: string): string {
  return KnowledgeReviewOutputSchema.parse(text);
}

function buildKnowledgeReviewPrompt(profile: SubjectProfile): string {
  return `你是知识图谱维护助手。看完整 tree（含层级 / archived / merged_from）+ 最近 attempt events (action='attempt', outcome='failure' 的事件，含 effective cause：active user_cause 优先，否则 latest active judge)，propose 让知识图谱更合理的 mutation。
科目上下文：${profile.displayName}。${profile.languageStyle}
关注本学科的知识粒度：数学定义、条件、方法或易错模式；非数学 profile 则按对应 SubjectProfile 的概念边界和练习粒度判断。
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
可选 mutation 分两类:
- Tree-shape: propose_new（加新子节点）/ reparent（移到别 parent 下）/ merge（合并冗余）/ split（拆解过粗）/ archive（archive 没用的）。
- Mesh-shape (ADR-0010): propose_knowledge_edge —— payload = { from_knowledge_id, to_knowledge_id, relation_type }。relation_type 是 5 个核心 enum 之一: prerequisite / related_to / contrasts_with / applied_in / derived_from；新型关系用 experimental:* 命名空间逃逸阀。
每 propose 一条，调一次 mcp__loom__write_proposal（工具名 write_proposal；payload.mutation 区分 tree / mesh）。Mesh edge 必须把支撑它的 recent_mistakes[].id 放进工具顶层 evidence_event_ids；不要把 id 只写进 reasoning。reasoning 必须具体：引用 attempt event id、知识点 id、cause pattern，或指出 tree 结构问题。
不必凑数；如果 tree 已经合理，0 条也行。
禁止：把节点挂成 root；编造 tree 不存在的 node id；没有 event evidence 时做破坏性 mutation；跨 subject 混图时强行套单一学科判断。`;
}

export const knowledgeReviewTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'KnowledgeReviewTask',
    description:
      '看完整 tree + 最近 mistakes，提议任意 mutation（reparent/merge/split/archive/propose_new）让 tree 更合理',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 12, timeout: 120_000 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: ['mcp__loom__write_proposal'],
    prompt: { kind: 'profile', build: buildKnowledgeReviewPrompt },
  },
  outputSchema: KnowledgeReviewOutputSchema,
  parseText: parseKnowledgeReviewOutput,
} satisfies TaskSpec<unknown, string>;
