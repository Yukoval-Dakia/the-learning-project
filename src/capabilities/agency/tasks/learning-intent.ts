// YUK-879 — LearningIntentOutlineTask contract, owned by the agency capability.
// The output schema, strict parser, domain error, and profile prompt live here;
// the orchestrator (../server/learning-intent) consumes them and keeps the
// proposal/accept flow. Prompt text is byte-identical to the former central
// quarry entry (prompt-hash oracle pins it).
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

// Legacy quarry alias preserved verbatim inside the moved definitions.
const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

import { z } from 'zod';
import type { SubjectProfile } from '@/subjects/profile';

export class LearningIntentError extends Error {
  constructor(
    public code:
      | 'topic_not_found'
      | 'topic_no_children'
      | 'llm_parse_failed'
      | 'invalid_atomic_knowledge_id'
      | 'proposal_not_found'
      | 'proposal_already_rated',
    message: string,
  ) {
    super(message);
    this.name = 'LearningIntentError';
  }
}

const HubProposalSchema = z.object({
  title: z.string().min(1).max(80),
  summary_md: z.string().min(1).max(500),
});

const AtomicProposalSchema = z.object({
  knowledge_id: z.string().min(1),
  title: z.string().min(1).max(80),
  one_line_intent: z.string().min(1).max(200),
});

const LongProposalSchema = z.object({
  knowledge_ids: z.array(z.string().min(1)).min(1).max(12),
  title: z.string().min(1).max(80),
  one_line_intent: z.string().min(1).max(200),
});

const ProposedKnowledgeNodeSchema = z.object({
  temp_id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  domain: z.string().min(1).nullable().optional(),
});

export const OutlineSchema = z.object({
  knowledge: z
    .object({
      root: ProposedKnowledgeNodeSchema.optional(),
      children: z.array(ProposedKnowledgeNodeSchema).optional(),
    })
    .optional(),
  hub: HubProposalSchema,
  atomics: z.array(AtomicProposalSchema).min(1),
  longs: z.array(LongProposalSchema).default([]),
});

export type LearningIntentOutline = z.infer<typeof OutlineSchema>;

export function parseLearningIntentOutline(text: string): LearningIntentOutline {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new LearningIntentError('llm_parse_failed', 'no JSON object found in outline output');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new LearningIntentError('llm_parse_failed', `JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = OutlineSchema.safeParse(json);
  if (!parsed.success) {
    throw new LearningIntentError(
      'llm_parse_failed',
      `outline schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

function buildLearningIntentOutlinePrompt(profile: SubjectProfile): string {
  return `你是学习规划助手。用户声明「我想学 X」，输入 { topic, plan_case, knowledge_node, child_nodes, existing_descendants_count, output_contract }。
plan_case 有三种：
- 3a_topic_missing：knowledge_node=null，图里还没有 topic。你必须提议 knowledge.root + starter children。
- 3b_children_missing：knowledge_node 存在但 child_nodes=[]。你必须提议 starter children。
- 3c_existing_graph：knowledge_node 和 child_nodes 已存在。只能使用 child_nodes 里的 id。
科目上下文：${profile.displayName}。${profile.promptFragments.learningIntentPolicy}
生成一个 1 hub + N atomic + 0-M long 的学习路径拆分。3c 的 N = child_nodes.length；3a/3b 的 N = 你提议的 knowledge.children.length。longs 是可选综合笔记，用于跨多个 knowledge_ids 串联解题路径；没有必要时输出空数组。
严格 JSON 输出（不带 markdown 代码块包裹）：
3c: {"hub":{"title":"...","summary_md":"... 1-2 句话概括整个主题 ..."},"atomics":[{"knowledge_id":"<child_nodes id>","title":"...","one_line_intent":"... 学完这条 atomic 你能 ... ..."}],"longs":[{"knowledge_ids":["<child_nodes id>", "..."],"title":"...","one_line_intent":"... 综合后你能 ..."}]}
3a: {"knowledge":{"root":{"temp_id":"root","name":"topic name","domain":"${profile.id}"},"children":[{"temp_id":"short_stable_key","name":"...","domain":"${profile.id}"}]},"hub":{"title":"...","summary_md":"..."},"atomics":[{"knowledge_id":"<knowledge.children temp_id>","title":"...","one_line_intent":"..."}],"longs":[{"knowledge_ids":["<knowledge.root temp_id 或 knowledge.children temp_id>", "..."],"title":"...","one_line_intent":"..."}]}
3b: {"knowledge":{"children":[{"temp_id":"short_stable_key","name":"...","domain":"${profile.id}"}]},"hub":{"title":"...","summary_md":"..."},"atomics":[{"knowledge_id":"<knowledge.children temp_id>","title":"...","one_line_intent":"..."}],"longs":[{"knowledge_ids":["<knowledge_node.id 或 knowledge.children temp_id>", "..."],"title":"...","one_line_intent":"..."}]}
要点：
- title 短（≤15 字）
- summary_md 1-2 句话，纯文本
- one_line_intent 每条 1 句话，说"学完能做什么"，不抽象
- 3c: atomics 数量必须等于 child_nodes.length，knowledge_id 必须是 child_nodes 里给的 id 之一
- 3c: longs[].knowledge_ids 只能使用 knowledge_node.id 或 child_nodes[].id
- 3a: knowledge.root 必填，root.domain 必填；3b 不要输出 root，只输出 children
- 3a/3b: atomics 数量必须等于 knowledge.children.length，knowledge_id 必须是 children 的 temp_id
- 3a: longs[].knowledge_ids 只能使用 knowledge.root.temp_id 或 knowledge.children[].temp_id
- 3b: longs[].knowledge_ids 只能使用 knowledge_node.id 或 knowledge.children[].temp_id
- 禁止套话（「加油」「重要主题」）；3c 禁止编造没有的子节点；3a/3b 禁止只给 root 不给 children`;
}

export const learningIntentOutlineTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'LearningIntentOutlineTask',
    description: 'Phase 2B — 看 topic + 已有知识图谱节点 + 子节点摘要，提议 1 hub + N atomic 拆分',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildLearningIntentOutlinePrompt },
  },
  outputSchema: OutlineSchema,
  parseText: parseLearningIntentOutline,
} satisfies TaskSpec<unknown, LearningIntentOutline>;
