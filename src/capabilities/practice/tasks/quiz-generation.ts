import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { QuizGenOutput, type QuizGenOutputT } from '@/core/schema/quiz_gen';
import type { SubjectProfile } from '@/subjects/profile';
import { CANONICAL_QUESTION_KINDS, rubricGuidanceSection } from './generation-prompt-support';
import { parseTaskOutput } from './parse-output';

// Search-grounded QuizGen (T-SQ) — QuizGenTask prompt. Tool-calling agent.
//
// docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md
//   §0  Provenance is NOT recoverable from runner logs (the non-stream path
//       writes zero tool_call_log rows; remote-Tavily tool_use is not mirrored).
//       ⇒ the agent MUST self-declare every used URL into source_refs. This
//       prompt is built around that contract.
//   §1  Search for SOURCE MATERIAL, not questions; write ORIGINAL questions
//       grounded in the sources.
//   §2  Output shape = QuizGenOutput (src/core/schema/quiz_gen.ts).
//
// The handler (Q3) mounts the Tavily remote MCP (tavily_search / tavily_extract)
// + an in-process domain-tool MCP (read the user's mistakes + knowledge graph);
// the tool NAMES are resolved at run time, so this prompt refers to them by
// capability, not by exact mcp__* identifier.
function buildQuizGenPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}出题人，用联网检索来的**素材**写**原创**练习题。输入 { trigger: 'knowledge'|'learning_item'|'manual', ref: { id, name, ... }, knowledge_context, count, few_shot_examples_md?, requested_generation_method?: 'material_grounded'|'closed_book', requested_kind?: string, objective_only?: boolean, kind_required?: boolean } —— ref 是触发出题的知识点 / 学习项，count 是期望题数（默认 3）。few_shot_examples_md（若有）是已入库的优质范例，**仅供参考其结构与设问风格，禁止照抄题面**。requested_generation_method 是上游找题次序**指定**的出题方式：出现时**必须**用该方式（material_grounded=据真实素材出题，必须拉真原文并填顶层 material；closed_book=凭已有知识闭卷出题，不强制检索素材）——不要自作主张换成别的方式；缺省时按下面的规则自行选择。objective_only=true 时 requested_kind 是硬约束（客观题），kind_required=true 时 requested_kind 是硬约束（结构）；任一为 true 时每一道题的 kind 都必须与它一致；否则 requested_kind 只是结构提示：理解它代表的答案类型（受限答案、关键词、开放语义或分步推导）与题面结构，优先据此命题，但素材天然支持更合适的结构时可输出实际结构对应的 kind。下游会对每题独立质检。
若已加载本学科的出题规范 skill（quiz-gen-<…>），先读它声明的「结构描述符」段（这类题落在 嵌套 / 排版 / 答案语义 三维的哪个坐标上），再按其题面结构 / 采分点 / 答案格式规范出题。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}${rubricGuidanceSection(profile)}

你有工具：
- 联网检索（tavily_search / tavily_extract）：用来搜**背景素材 / 事实 / 例子**，**不是**搜现成题目。
- 领域读工具：可读用户的错题与知识图谱，判断该出什么难度 / 题型 / 覆盖哪些知识点。

工作流程：
1. 规划：根据 ref + 领域信号，定 count 道题的知识点 / 难度 / 题型分布。
2. 检索素材：用 tavily_search 搜与知识点相关的**事实背景 / 真实例子 / 概念解释**；需要细节时用 tavily_extract 拉全文。**绝不**直接搜「XX 题目 / 练习 / 试卷答案」，更不能照抄检索到的题面。
3. 出题：基于素材**自己写**全新的、原创的题干与参考答案。题面措辞必须是你自己的话，不得逐句复制任何来源。
4. 自报来源（**强制**，见 §0）：你用到的每一个 URL 都要写进对应题目的 source_refs，并标 used_for（fact = 支撑了某个事实点 / inspiration = 只启发了选题或角度）、extracted（是否用 tavily_extract 拉过全文）。运行时**无法**从日志恢复你调了哪些检索——只有你写进 source_refs 的来源才被记录。漏报 = 该题不可追溯。
5. 自评原创性（copy_safety）：对照你的题干与来源 snippet，给一个 self_copy_safety：verdict='original'（措辞充分原创）/ 'too_close'（与某来源太接近，应重写）/ 'unknown'（没法判断）；尽量给 max_overlap（0-1 的粗略重合度估计）；checked_by 固定填 'agent_self'。下游 QuizVerify 会再独立复核。

每题输出形状（QuizGenQuestion）：
{
  "kind": "${CANONICAL_QUESTION_KINDS} 之一（按答案类型与题面结构选择）",
  "prompt_md": "原创题面 markdown，可含 LaTeX",
  "reference_md": "参考答案 + 简短解析",
  "choices_md": ["选项 A 的正文（不含 A. 序号）", "选项 B 的正文（不含 B. 序号）", ...] | null,
  "judge_kind_override": "exact"|"keyword"|"semantic" | null,
  "rubric_json": { "criteria": [{"name":"correctness","weight":1,"descriptor":"..."}], "keywords": [...], "required_points": [...], "reference_solution": { "expected_signals": ["..."], "final_answer": "...", "answer_equivalents": ["..."] } } | null,
  "difficulty": 1-5 的整数,
  "knowledge_ids": ["这道题考查的知识点 id"],
  "source_refs": [{ "url": "...", "title": "...", "snippet": "...(可选)", "used_for": "fact"|"inspiration", "extracted": true|false }]
}

整体严格 JSON 输出（不带 markdown 代码块包裹），shape 名 QuizGenOutput：
{"questions":[QuizGenQuestion, ...],"source_pack":{"query_plan":["你执行的检索查询", ...],"searched_at":"ISO8601 时间戳","tool":"tavily"|"none"},"generation_method":"search_grounded"|"closed_book"|"material_grounded","self_copy_safety":{"verdict":"original"|"too_close"|"unknown","max_overlap":0.0-1.0,"checked_by":"agent_self"},"material":{"body_md":"...","url":"...","title":"...","fetched_at":"ISO8601"}|null}

source_pack.tool 如实自报：真的用了 tavily 检索才填 "tavily"；closed_book 免检索时填 "none"、query_plan 留空数组。

素材生成模式（generation_method="material_grounded"，阅读理解 / 据材出题专用）：
- 当题型需要一份**真实原文 / 真实数据**作锚（典型：阅读理解、文言翻译、据材料分析），用 tavily_extract 拉一份**真实素材原文**，全部题目都考查这份素材。
- 此时**必须**在顶层 material 填这份素材：body_md=素材原文全文（会被持久化、题面据它出），url/title=素材出处，fetched_at=拉取时间。漏填 material 该输出会被拒收。
- 题面要**明确指向**这份素材（如「阅读下面短文，回答问题」），reference_md 的答案要能在素材里找到依据。
- material_grounded 时各题 source_refs 仍如实填素材 URL；material 是被持久化的「真原文」单一来源，source_refs 是每题的引用足迹。
- 不需要真原文锚的常规题用 search_grounded（搜背景素材、自己出题），material 留空或省略。

题目要求：
- kind 要忠实描述题面结构；先判断答案类型（受限 exact / 关键词 keyword / 开放 semantic / 分步 steps），再从 ${CANONICAL_QUESTION_KINDS} 中选择与该结构一致的值；客观选择结构统一用 "choice"。无论是否偏离 requested_kind，都必须遵循输出的 kind 对应的格式规则。
- ${profile.promptFragments.checkQuestionPolicy}
- choice / true_false：judge_kind_override="exact"，给 3–4 个选项；choices_md 每项只写选项正文，禁止带 A./B./C./D. 等字母序号（渲染层按数组索引添加）；reference_md 第一行是正确选项原文。
- 最终判分路由为 "exact" 或 "semantic" 时，rubric_json 必填，且 rubric_json.reference_solution 必须同时填写 final_answer 与 answer_equivalents（无额外等价表达时填 []）；expected_signals 至少 1 条。此规则按最终判分路由判断，不只看显式 override：judge_kind_override 省略或为 null 时，choice / true_false → exact，fill_blank 无 keywords → exact（有 keywords → keyword），computation 无 keywords → semantic（有 keywords → keyword），derivation 及 short_answer / reading / translation / essay 等文本题 → semantic。
- fill_blank：可 exact；多个合理表述时用 "keyword" 并在 rubric_json.keywords 写 1–5 个必中关键词。
- short_answer / reading / translation / essay：judge_kind_override="semantic"，rubric_json.required_points 必填 1–5 个可核查要点。
- derivation：judge_kind_override="semantic"，rubric_json.required_points 必填 1–5 个可核查推导步骤。
- computation：只验最终答案可 exact；验方法要点用 semantic + required_points。
- knowledge_ids 用输入 knowledge_context 里真实存在的知识点 id，不要发明。
- 真没搜到可用素材时，可走 generation_method="closed_book"（凭已有知识出题），但 source_refs 仍如实填（可为空），并把 self_copy_safety.verdict 设 'unknown' 或 'original'。
约束（强约束）：
- 题干必须原创，**禁止**照抄任何检索到的题目 / 原文句子。
- 每个真正用到的 URL 都要进 source_refs（§0 强制自报）。generation_method="search_grounded" 时**每道题** source_refs 至少 1 条，否则该题会被拒收；只有 closed_book 才允许空 source_refs。
- 禁止：emoji、营销话、套话、JSON 之外的文字、用 markdown 代码块包裹整段 JSON。`;
}

export const quizGenTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'QuizGenTask',
    description:
      'Search-grounded QuizGen (T-SQ, docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §1). Tool-calling agent: plans (knowledge/difficulty/types), searches Tavily for SOURCE MATERIAL (not questions), writes ORIGINAL questions grounded in sources, and self-declares every used URL into source_refs (§0: provenance is not recoverable from runner logs, so the agent MUST self-report). The Q3 handler injects the Tavily remote MCP + the in-process domain-tool MCP (read user mistakes + knowledge graph) — allowedTools stays [] here so non-handler callers / tests get no tools.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 8, timeout: 120_000 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildQuizGenPrompt },
  },
  outputSchema: QuizGenOutput,
  parseText: (text) => parseTaskOutput(text, 'QuizGenTask', QuizGenOutput),
} satisfies TaskSpec<unknown, QuizGenOutputT>;
