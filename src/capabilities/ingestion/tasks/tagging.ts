import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { TaggingOutput, type TaggingOutputT } from '@/core/schema/tagging';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskJsonObject } from './parse-json';

export class TaggingTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TaggingTaskError';
  }
}

export function parseTaggingOutput(text: string): TaggingOutputT {
  return TaggingOutput.parse(
    parseTaskJsonObject(
      text,
      'TaggingTask',
      (message, cause) =>
        new TaggingTaskError(message, cause === undefined ? undefined : { cause }),
    ),
  );
}

function buildTaggingPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}知识点打标助手。输入 { question_md, knowledge_hint, grid: { nodes: [{ id, name, path }], edges: [{ from_knowledge_id, to_knowledge_id, relation_type }] } } —— question_md 是抽取出的题面文字，knowledge_hint 是录入时的软提示（可能为 null），grid 是候选知识网格（nodes 是你**唯一**能选的知识点，path 是从根到该节点的层级名便于消歧；edges 是 prerequisite / related_to / contrasts_with / applied_in / derived_from 等 mesh 关系）。
科目上下文：${profile.displayName}。${profile.languageStyle}
任务：判断这道题**考查**哪些 grid.nodes 里的知识点，给每条一个 confidence（0-1），再给一个整体 overall_confidence。
严格 JSON 输出（不带 markdown 代码块包裹），shape 名 TaggingOutput：
{"suggestions":[{"knowledge_id":"<grid.nodes 里真实存在的 id>","confidence":0.0-1.0,"reasoning":"..."}],"overall_confidence":0.0-1.0,"reasoning":"..."}
要点：
- knowledge_id 必须是 grid.nodes 里真实存在的 id；**禁止发明**网格里没有的节点（编造的 id 会被运行时丢弃，等于浪费）。
- 用 knowledge_hint + 题面语义 + edges 关系判断；hint 只是参考，不要盲从。
- 宁缺毋滥：只列真正考查到的知识点，不凑数。整道题确实没有合适匹配时给空 suggestions + 低 overall_confidence。
- confidence 反映你对该挂载的把握；overall_confidence 反映整道题打标的整体可信度（它会被下游用作高置信自动入库的闸门，吃不准就给低分让它走人工 review）。
- reasoning 具体：引用节点名 + 题面证据，别空泛。
- 禁止套话、禁止输出 JSON 之外的文字。`;
}

export const taggingTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'TaggingTask',
    description:
      'T-OC slice 3 (YUK-145, OC-4) — 给一道抽取出的题（题面文字 + 可选 knowledge_hint）+ 一份知识网格快照（节点 + mesh 边），建议它覆盖哪些 knowledge_id（每条带 confidence + reasoning）+ 一个 overall_confidence。单次结构化输出，非多模态（题面已是文字）。下游 WorkflowJudge 用它的 confidence 做高置信自动入库 / 低置信 review 裁决。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildTaggingPrompt },
  },
  outputSchema: TaggingOutput,
  parseText: parseTaggingOutput,
} satisfies TaskSpec<unknown, TaggingOutputT>;
