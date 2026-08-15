import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { SourcingTaskOutput, type SourcingTaskOutputT } from '@/core/schema/sourcing';
import type { SubjectProfile } from '@/subjects/profile';
import { CANONICAL_QUESTION_KINDS, rubricGuidanceSection } from './generation-prompt-support';
import { parseTaskOutput } from './parse-output';

// YUK-216 S2 slice 2 — SourcingTask prompt. Tool-calling agent that finds
// EXISTING practice questions on the web and restructures them.
//
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §3.
//   - Unlike QuizGen (which searches for SOURCE MATERIAL and writes ORIGINAL
//     questions), SourcingTask searches for REAL practice questions and lifts +
//     restructures them, recording each origin URL into per-question provenance.
//   - OF-1 回填 (YUK-223 / YUK-227 S3 Slice C): HTML/TEXT sources are extracted
//     inline as `questions`. Image-type sources — pages whose stem lives in an
//     image that tavily_extract cannot lift as text — are reported as
//     `image_candidates` (NOT auto-extracted: 守 ADR-0002, VLM 抽图是用户授权的
//     付费动作). The handler turns each into an `image_candidate` proposal, and a
//     VLM extraction runs ONLY on explicit user accept. The prompt MUST teach the
//     agent (a) when to report an image_candidate, (b) the output contract for it,
//     and (c) never to double-report a source as both a question and a candidate —
//     生产 agent only emits image_candidates if the prompt asks for them.
//   - This片 is the MINIMAL task-description skeleton (role / output contract /
//     whitelist note). Domain content (题型规范 etc.) migrates to an Agent Skill
//     in slice 4 — this builder stays thin per the owner's code-as-task-description
//     philosophy.
//
// The handler mounts the Tavily remote MCP (tavily_search / tavily_extract) + an
// in-process domain-tool MCP at run time, so this prompt refers to tools by
// capability, not by exact mcp__* identifier.
function buildSourcingPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}题源检索员。任务：根据输入的学科 + 考点/题型 + 数量，**联网检索现成的练习题**，把每道题抽取并结构化为 SourcedQuestion。输入 { subject, knowledge_context, kinds?, objective_only?: boolean, kind_required?: boolean, count, whitelist } —— count 是期望题数，whitelist 是可信题源域名列表（可能为空）。objective_only=true 时 kinds 中指定的 kind 是硬约束（客观题），kind_required=true 时它是硬约束（结构）；任一为 true 时每道文本题的 kind 都必须与它一致；否则 kinds 是检索时的答案类型与题面结构指导，不要求整批输出复刻同一个 kind 字符串，应忠实抽取每道题的实际结构。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}${rubricGuidanceSection(profile)}

你有工具：
- 联网检索（tavily_search / tavily_extract）：搜**现成的练习题 / 习题 / 真题**；需要题面与答案细节时用 tavily_extract 拉网页正文。
- 领域读工具：可读用户的知识图谱，确认题目考查的 knowledge_ids 真实存在。

工作流程：
1. 检索：用 tavily_search 找与考点/题型相关的现成练习题页面。
2. 抽取：用 tavily_extract 拉网页正文，从中**逐题**抽出题面、参考答案、选项（若有）。忠实抽取，不要自己改写题意或编造答案。
3. 结构化：把每道题映射成 SourcedQuestion，标注 kind / 难度 / 它考查的 knowledge_ids（用 knowledge_context 里真实存在的 id）。
4. 记录来源（**强制**）：每道题写它来自的 source_url（具体网页 URL）+ source_title（页面标题）。运行时无法从日志恢复你访问了哪些页面——只有写进 source_url 的来源才被记录。漏报 = 该题不可追溯、会被拒收。
5. 图片型题源（**不要自己抽图**）：当 tavily_extract **拿不到题干文本**（返回空/近空正文），但 tavily_search 的搜索结果表明该 URL 确实含真题（标题/摘要指向练习题/真题/试卷）——说明题干在**图片**里（扫描卷 PNG、图表题等）。这种源**不要**编造文本题、**不要**塞进 questions，改为报进 image_candidates。抽图是用户授权的付费动作，由用户在收件箱里 accept 后才发生，不是你的职责。

每题输出形状（SourcedQuestion）：
{
  "kind": "${CANONICAL_QUESTION_KINDS} 之一（按答案类型与题面结构选择）",
  "prompt_md": "题面 markdown（忠实抽取，可含 LaTeX）",
  "reference_md": "参考答案 + 简短解析",
  "choices_md": ["选项 A", "选项 B", ...] | null,
  "judge_kind_override": "exact"|"keyword"|"semantic" | null,
  "rubric_json": { "criteria": [{"name":"correctness","weight":1,"descriptor":"..."}], "keywords": [...], "required_points": [...] } | null,
  "difficulty": 1-5 的整数,
  "knowledge_ids": ["这道题考查的知识点 id"],
  "source_url": "题目来自的具体网页 URL",
  "source_title": "该网页标题",
  "extract": "（必填）你从该网页**逐字抽取**的原始题面片段（质检会用它与题面做确定性比对，证明 source_url 真实可追溯；忠实粘贴，勿改写）",
  "extraction_hash": "(可选) 抽取内容指纹"
}

图片型题源输出形状（SourcingImageCandidate，**可选数组**，没有就省略）：
{
  "source_url": "题干为图片的具体网页 URL（accept 时会从这里下载图片）",
  "source_title": "该网页标题",
  "summary_md": "为什么判定为图片型源（如 tavily_extract 返回空文本但搜索结果指向真题）+ 该页大致含什么内容（给用户在收件箱里决定要不要花一次抽图）"
}

整体严格 JSON 输出（不带 markdown 代码块包裹），shape 名 SourcingTaskOutput：
{"questions":[SourcedQuestion, ...],"image_candidates":[SourcingImageCandidate, ...](可省略),"query_plan":["你执行的检索查询", ...],"fetched_at":"ISO8601 时间戳","tool":"tavily"}

题目要求：
- kind 要忠实描述题面结构；先判断答案类型（受限 exact / 关键词 keyword / 开放 semantic / 分步 steps），再从 ${CANONICAL_QUESTION_KINDS} 中选择与该结构一致的值；客观选择结构统一用 "choice"。无论是否偏离上游 kinds 提示，都必须遵循输出的 kind 对应的格式规则。
- choice / true_false：judge_kind_override="exact"，给选项，reference_md 第一行是正确选项原文。
- fill_blank：可 exact；多个合理表述时用 "keyword" 并在 rubric_json.keywords 写 1–5 个必中关键词。
- short_answer / reading / translation / essay：judge_kind_override="semantic"，rubric_json.required_points 必填 1–5 个可核查要点。
- derivation：judge_kind_override="semantic"，rubric_json.required_points 必填 1–5 个可核查推导步骤，避免缺少 steps 判分契约。
- computation：只验最终答案可 exact；验方法要点用 semantic + required_points。
- knowledge_ids 用 knowledge_context 里真实存在的知识点 id，不要发明。
- whitelist 非空时**优先**抽取命中白名单域名的来源；白名单外的来源仍可抽（会在入库时被降权标记，不影响质检），但不要为了凑数抽明显低质的来源。
约束（强约束）：
- 每道题必须有有效的 source_url（具体网页 URL）+ source_title，否则会被拒收。
- **必填** extract（从 source_url 逐字抽取的原始题面片段）：质检会用它对题面做确定性 grounding 比对，证明来源真实。缺 extract 或 extract 与题面毫无重叠 → 该题被判为来源不可锚定/伪造、拒收。
- 图片型题源报进 image_candidates，**不要**自己抽图、**不要**为图片源编造文本题。
- **同一个源不要既报成 question 又报成 image_candidate**：能抽出文本就只放 questions；抽不出文本（图片型）就只放 image_candidates。二选一。
- 一道题都没找到、且也没有图片型源时，宁可返回空 questions（运行会失败）也不要编题；但只要有图片型源，至少报进 image_candidates。
- 禁止：emoji、营销话、套话、JSON 之外的文字、用 markdown 代码块包裹整段 JSON。`;
}

export const sourcingTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'SourcingTask',
    description:
      "YUK-216 S2 slice 2 (题源扩展 Strategy D, docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §3). Tool-calling agent: given a subject + 考点/题型 + count, searches the web (Tavily) for EXISTING practice questions, restructures each into a SourcedQuestion (kind + prompt_md + reference_md + per-question source_url/title provenance), and emits a SourcingTaskOutput. First cut extracts from HTML/TEXT sources only (OF-1; no image sources). The sourcing handler injects the Tavily remote MCP + the in-process domain-tool MCP at run time (mirrors QuizGenTask's mount pattern) — allowedTools stays [] here so non-handler callers / tests register no tools. Output questions land as draft_status='draft' (source='web_sourced', tier 2) and chain a source_verify job.",
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 8, timeout: 120_000 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildSourcingPrompt },
  },
  outputSchema: SourcingTaskOutput,
  parseText: (text) => parseTaskOutput(text, 'SourcingTask', SourcingTaskOutput),
} satisfies TaskSpec<unknown, SourcingTaskOutputT>;
