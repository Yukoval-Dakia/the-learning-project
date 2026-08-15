import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { QuestionAuthorDraft, type QuestionAuthorDraftT } from '@/core/schema/question_author';
import type { SubjectProfile } from '@/subjects/profile';
import { CANONICAL_QUESTION_KINDS, rubricGuidanceSection } from './generation-prompt-support';
import { parseTaskOutput } from './parse-output';

// ADR-0031 / YUK-304 (quiz C→A lane B) — QuestionAuthorTask prompt. Single-shot
// structured output, NOT multimodal, NO tools (决定6: this is deliberately NOT
// the QuizGenTask agent loop — the copilot orchestrates, one call = one
// question). knowledge_context is the closed set of legal knowledge ids; the
// seed core (src/server/ai/question-author.ts) ALSO intersects the echoed ids
// against the live table and REGENERATES every structured node id, so a
// hallucinated id can never persist (belt-and-suspenders, GoalScope/Tagging
// 同款). seed_mode='material' carries the pasted material verbatim — the task
// cannot fetch URLs (no Tavily), so material_url is provenance-only metadata
// handled outside this prompt.
function buildQuestionAuthorPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}出题作者，一次只写**恰好一道**原创题。输入 { seed_mode: 'knowledge'|'material', knowledge_context: [{ id, name }], requested_kind?, objective_only?: boolean, kind_required?: boolean, requested_difficulty?, material?: { body_md, title? } } —— knowledge_context 是这道题要考查的知识点（id 是你**唯一**能写进 knowledge_ids 的 id）；seed_mode='material' 时 material.body_md 是用户给的命题素材原文，题目必须**据这份素材**出。requested_kind 一旦出现就**是硬约束**：kind 在 plan 阶段已定死，你输出的 kind 必须与 requested_kind 完全一致，不得因素材更适合别的结构而偏离（objective_only=true 时同时要求客观题型，kind_required=true 时同时锁定结构）。requested_kind 缺省时才自行判断答案类型与题面结构。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}${rubricGuidanceSection(profile)}

structured 树形（StructuredQuestion，二选一）：
- 材料/阅读类（kind=reading 等成篇考查，或输入带 material）：role='stem' 的根节点，prompt_text 放材料/语段**原文**，sub_questions[] 每个小题 role='sub'，各带自己的 prompt_text + answers + analysis（与 OCR 录入的大题/小题同构）。
- 其它题型：单个 role='standalone' 节点（prompt_text + options? + answers + analysis），无 sub_questions。
节点 id 随便填占位字符串即可——运行时会**重新生成**全部节点 id，不要依赖你给的 id。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 QuestionAuthorDraft：
{"kind":"${CANONICAL_QUESTION_KINDS} 之一（按答案类型与题面结构选择）","difficulty":1-5 的整数,"knowledge_ids":["<knowledge_context 里的 id>"],"structured":{"id":"占位","role":"stem"|"standalone","prompt_text":"...","options":[{"label":"A","text":"..."}]|省略,"answers":["..."],"analysis":"...","sub_questions":[{"id":"占位","role":"sub","question_no":"1","prompt_text":"...","answers":["..."],"analysis":"..."}]|省略},"choices_md":["选项 A 原文", ...]|null,"judge_kind_override":"exact"|"keyword"|"semantic"|null,"rubric_json":{"criteria":[{"name":"correctness","weight":1,"descriptor":"..."}],"keywords":[...],"required_points":[...]}|null}

题目要求：
- 恰好一道题；requested_kind 若出现，输出的 kind **必须**等于它（plan 阶段已定，不得偏离）；requested_kind 缺省时才从 ${CANONICAL_QUESTION_KINDS} 中选择与实际题面结构一致的 kind。无论如何都要遵循输出的 kind 对应的格式规则。
- requested_difficulty 出现时 difficulty 必须等于它；缺省自定。
- 每个叶节点（standalone 根 / 每个 sub）**必须**有非空 answers 和/或 analysis——缺答案的题会被整道拒收。
- choice / true_false：judge_kind_override="exact"，options 给 3–4 个选项，choices_md 同步给选项原文，answers 第一条是正确选项原文。
- short_answer / reading / translation / essay：judge_kind_override="semantic"，rubric_json.required_points 给 1–5 个可核查要点。
- derivation：judge_kind_override="semantic"，rubric_json.required_points 给 1–5 个可核查推导步骤。
- computation：只验最终答案可 "exact"；验方法要点用 "semantic" + required_points。
- knowledge_ids 只能用 knowledge_context 里真实存在的 id，**禁止发明**（编造的 id 会被运行时丢弃）。
- seed_mode='material' 时题面必须明确指向素材（如「阅读上面的文段」），答案要能在素材里找到依据；禁止脱离素材自由发挥。
- 题干原创：不要照抄题库套话，不要出与素材无关的题。
- 禁止：emoji、套话、JSON 之外的任何文字、用 markdown 代码块包裹整段 JSON。`;
}

export function parseQuestionAuthorOutput(text: string): QuestionAuthorDraftT {
  return parseTaskOutput(text, 'parseQuestionAuthorOutput', QuestionAuthorDraft);
}

export const questionAuthorTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'QuestionAuthorTask',
    description:
      'ADR-0031 / YUK-304 (quiz C→A lane B) — author ONE original draft question seeded by knowledge nodes and/or pasted material. Input = { seed_mode, knowledge_context:[{id,name}], requested_kind?, requested_difficulty?, material:{body_md,title?}? }. Output = strict JSON QuestionAuthorDraft: kind + difficulty + knowledge_ids (echo of seed, re-validated code-side) + a StructuredQuestion tree (材料/阅读 kinds emit stem+sub_questions[]; others a standalone node) + optional choices/judge/rubric. prompt_md/reference_md are DERIVED from the tree at persist time. Single structured-output call (no tool loop, no Tavily — 决定6), mimo-v2.5-pro text. Writes land as draft_status=draft + a question_draft proposal (决定5 proposal-only).',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildQuestionAuthorPrompt },
  },
  outputSchema: QuestionAuthorDraft,
  parseText: parseQuestionAuthorOutput,
} satisfies TaskSpec<unknown, QuestionAuthorDraftT>;
