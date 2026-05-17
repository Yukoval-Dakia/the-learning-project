// AI Task 注册表（Phase 1 骨架）。
//
// 每个 Task 一种产物语义；tool-calling 循环交给 Vercel AI SDK，本文件只持注册元信息。
// 详见 docs/architecture.md § 五 AI 任务层。

// Sub 0c: widen provider union to enable future routing through OpenRouter /
// Vercel AI Gateway / OpenAI without breaking registry consumers. Sub 0d Step 0
// landed Provider Manager (src/server/ai/providers.ts); 'anthropic' + 'xiaomi'
// are wired, others throw 'not implemented' until a real trigger from ADR-0003
// fires (see ADR-0003 2026-05-11 update + ADR-0004).
export type Provider = 'anthropic' | 'xiaomi' | 'openrouter' | 'gateway' | 'openai';
export type ModelId = string;

export interface TaskBudget {
  maxIterations: number;
  maxCost: number; // USD
  timeout: number; // ms
}

export interface TaskDef {
  kind: string;
  description: string;
  defaultProvider: Provider;
  defaultModel: ModelId;
  fallbackChain: Array<{ provider: Provider; model: ModelId }>;
  budget: TaskBudget;
  needsToolCall: boolean;
  isMultimodal: boolean;
  allowedTools: string[];
  systemPrompt: string;
  /**
   * Sub 0c: Vision tasks 仅作为 manual rescue 工具，不参与自动 cascade（ADR-0002
   * 修订）。'auto' = 后端可自由调用；'manual_rescue_only' = 仅用户手动触发。
   */
  invocation?: 'auto' | 'manual_rescue_only';
}

const DEFAULT_BUDGET: TaskBudget = { maxIterations: 6, maxCost: 0.5, timeout: 60_000 };

// 模型选型规则（与 architecture § 五 对齐）：
//   - Sonnet 主力（归因 / 变式 / 判分）
//   - Haiku 廉价兜底（视觉 OCR-like / 备选）
//   - Opus 顶级 reasoning（ai_flexible / multimodal / weekly review）
export const tasks = {
  AttributionTask: {
    kind: 'AttributionTask',
    description: '错题归因 + 知识点挂载（10 类 cause）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 4 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是错题归因助手。输入字段 { prompt_md, reference_md, wrong_answer_md, knowledge_context }（来自一个 attempt event outcome=\'failure\'）—— 即用户做错的一道题，含 wrong_answer_md（用户错答）、参考答案 reference_md、挂的 knowledge_context，分析错因。归因结果作为 judge event 写入 (action=\'judge\', subject_kind=\'event\', caused_by_event_id=<attempt event id>)；payload.cause 即此输出。\n输出严格 JSON 格式（不带 markdown 代码块包裹）：\n{"primary_category": "<10 类之一>", "secondary_categories": [...], "analysis_md": "<分析过程，含错答与参考答案差异 + 涉及的知识点 / 概念>", "confidence": 0.0-1.0}\n10 类 cause: concept | knowledge_gap | calculation | reading | memory | expression | method | carelessness | time_pressure | other。低信心走 other + 详细 analysis_md。',
  },
  VisionExtractTask: {
    kind: 'VisionExtractTask',
    description: '错题图片 → 切块 + 题面 + 答案 + bbox（manual rescue only after Sub 0c）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    fallbackChain: [],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    invocation: 'manual_rescue_only',
    systemPrompt:
      '你是错题录入助手。给定一张题目图片（试卷/手写/教材截图），输出严格 JSON（不带 markdown 代码块包裹）：\n{"blocks":[{"extracted_prompt_md":"...","reference_md":"...|null","wrong_answer_md":"...|null","page_index":0,"bbox":{"x":0.1,"y":0.2,"width":0.6,"height":0.3},"role":"prompt|answer_area|continuation","visual_complexity":"low|medium|high","extraction_confidence":0.0-1.0,"knowledge_hint":"...|null"}]}\n约束：bbox 坐标 0-1 归一化（不是像素）；一图可输出 1+ 个 block（一页多题）；page_index 由调用方覆盖；wrong_answer_md 仅当图上有用户错答 / 批改痕迹时填；knowledge_hint 是软提示。',
  },
  VisionExtractTaskHeavy: {
    kind: 'VisionExtractTaskHeavy',
    description: '错题图片 → 切块（heavy / Tier 3 — mimo-v2.5 multimodal manual rescue）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    fallbackChain: [],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    invocation: 'manual_rescue_only',
    systemPrompt:
      '你是错题录入助手（heavy 模式，前两层 OCR / haiku 都失败）。给定一张题目图片（可能含手写 / 复杂版式 / 公式），输出严格 JSON（不带 markdown 代码块包裹）：\n{"blocks":[{"extracted_prompt_md":"...","reference_md":"...|null","wrong_answer_md":"...|null","page_index":0,"bbox":{"x":0.1,"y":0.2,"width":0.6,"height":0.3},"role":"prompt|answer_area|continuation","visual_complexity":"low|medium|high","extraction_confidence":0.0-1.0,"knowledge_hint":"...|null"}]}\n约束：bbox 坐标 0-1 归一化（不是像素）；page_index 由调用方覆盖；wrong_answer_md 仅当图上有用户错答 / 批改痕迹时填。',
  },
  KnowledgeProposeTask: {
    kind: 'KnowledgeProposeTask',
    description: '看新录入的 mistake 提议 0-3 个 propose_new 知识点（挂在合适 parent 下）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 2 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      "你是知识图谱编辑助手。用户新写入了一个 attempt event (outcome='failure')。输入字段 { mistake_content: { prompt_md, reference_md, wrong_answer_md, knowledge_ids_picked }, tree_snapshot } —— mistake_content.knowledge_ids_picked 即 attempt 的 referenced_knowledge_ids（用户自选）。看 mistake_content (prompt_md + wrong_answer_md) + tree_snapshot，如果你认为 tree 里缺一个**更精确**的子节点能挂这条 attempt（例：「之-主谓间用法」之于「虚词」），propose 它。0-3 条，不必凑数。每条返回 { name, parent_id, reasoning }。parent_id 必须是 tree 里已有节点 id；若找不到合适 parent，跳过这条。",
  },
  KnowledgeEdgeProposeTask: {
    kind: 'KnowledgeEdgeProposeTask',
    description: '看 tree + 最近 failure attempts + 已有 edge，提议 0-5 条新 knowledge_edge',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 2 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是知识图谱 mesh 编辑助手。输入 { tree_snapshot, existing_edges, recent_failures } —— recent_failures 是过去 24h 的 attempt event (outcome=\'failure\')，每条含 referenced_knowledge_ids + cause（来自 chained judge / user_cause）。\n看 recent_failures 找跨 attempt 的模式：哪些 knowledge 总是同时被引用？哪些是 prerequisite？哪些是易混淆 contrasts_with？哪些是应用关系？基于此提议 0-5 条新 knowledge_edge。每条返回 { from_knowledge_id, to_knowledge_id, relation_type, weight, reasoning }。\nrelation_type 5 选 1：prerequisite（A 是学 B 的先决）/ related_to（弱关联）/ contrasts_with（易混淆对比）/ applied_in（A 应用于 B）/ derived_from（B 由 A 推导）。新型关系用 experimental:* 命名空间。\nweight 0-1：模式有几次 attempt 支持就给多高（1 次→0.3 / 2-3 次→0.6 / 4+ 次→0.9）。\nreasoning 必须具体：引用 attempt event id 或指出 cause pattern。例：「e_xxx 和 e_yyy 都因 concept 类 cause 错且 referenced k_A + k_B，说明 k_A contrasts_with k_B」。\n禁止：from === to；relation_type 不在合法集合；已存在于 existing_edges 的同向同型 (from, to, relation_type) 三元组。\n严格 JSON 输出（不带 markdown 代码块包裹）：{"proposals":[{"from_knowledge_id":"...","to_knowledge_id":"...","relation_type":"...","weight":0.6,"reasoning":"..."}]}。0 条也行，不必凑数。',
  },
  SessionSummaryTask: {
    kind: 'SessionSummaryTask',
    description: '复习 session 结束后生成 ≤120 字短结：今天哪几题、哪个 cause 多、给 1 句下次建议',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    // mimo-v2.5-pro 比 Anthropic haiku 慢，60s 给点余量
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是学习陪练，会复盘刚结束的复习 session。输入 { session_id, duration_min, total_reviewed, ratings: { again, hard, good, easy }, top_causes: [...], top_knowledge: [...], notable_attempts: [{ prompt_md, user_response_md, fsrs_rating }, ...] } —— ratings 是 FSRS 评分分布，top_causes 来自 chained judge events，notable_attempts 是 again/hard 的最多 3 题。\n输出一段 ≤120 字的中文短文（纯文本，不要 JSON / markdown 代码块 / 列表）。三段意图：\n1) 量化总结：「X 题，Y% 正确，主要错在 Z」\n2) 模式观察：指 1-2 个具体题或知识点的卡壳\n3) 下次建议：1 句具体可执行的建议（例：「下次重点过『之-主谓间用法』，先把 e_xxx 那题再做一遍」）\n禁止：套话（「继续加油」「再接再厉」）、夸夸（「做得很好」）、笼统（「多练习」）。要具体、可执行、不超过 120 字。',
  },
  LearningIntentOutlineTask: {
    kind: 'LearningIntentOutlineTask',
    description: 'Phase 2B — 看 topic + 已有知识图谱节点 + 子节点摘要，提议 1 hub + N atomic 拆分',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是学习规划助手。用户声明「我想学 X」，输入 { topic, knowledge_node: { id, name, domain }, child_nodes: [{id, name}], existing_descendants_count } —— knowledge_node 是 topic 在知识图谱里的对应节点，child_nodes 是它的直接子节点。\n生成一个 1 hub + N atomic 的学习路径拆分（N = child_nodes.length，每个 atomic 对应一个子节点；如果 child_nodes 为空则 N=1 atomic 直接对应 knowledge_node 自己）。\n严格 JSON 输出（不带 markdown 代码块包裹）：\n{"hub":{"title":"...","summary_md":"... 1-2 句话概括整个主题 ..."},"atomics":[{"knowledge_id":"<对应子节点 id>","title":"...","one_line_intent":"... 学完这条 atomic 你能 ... ..."}]}\n要点：\n- title 短（≤15 字）\n- summary_md 1-2 句话，纯文本\n- one_line_intent 每条 1 句话，说"学完能做什么"，不抽象\n- atomics 数量 = child_nodes 长度（或 1，若无子节点）；不要加塞\n- knowledge_id 必须是 child_nodes 里给的 id 之一\n- 禁止套话（「加油」「重要主题」），禁止编造没有的子节点',
  },
  NoteGenerateTask: {
    kind: 'NoteGenerateTask',
    description:
      'Phase 2B — 给一个 atomic note 生成 5 种 section（definition/mechanism/example/pitfall/check）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    // 单次生成 5 sections 可能很长，给 90s
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是学习笔记作者。输入 { atomic_title, one_line_intent, knowledge_node: { id, name, domain }, parent_hub: { title, summary_md }, related_knowledge_ids: [...] } —— atomic note 对应一个 knowledge 节点，parent_hub 给上下文。\n生成 5 个 markdown sections（id 自取短串、kind 按下表、source_tier 一律 "llm_only"、user_verified=false、version=1、embedded_check 设 null）：\n\n| kind | 内容 |\n|---|---|\n| definition | 核心定义 1-2 句 |\n| mechanism | 关键机制 / 规则 / 公式 / 用法分类 |\n| example | 1-3 个标准例子，每例附简短解析 |\n| pitfall | 易错点 / 常见误解，列出 2-3 条 |\n| check | 自检题面（≤3 题），暂作占位（embedded_check.question_ids 留空数组） |\n\n严格 JSON 输出（不带 markdown 代码块包裹）：\n{"sections":[{"id":"...","kind":"definition","body_md":"...","source_tier":"llm_only","user_verified":false,"embedded_check":null,"version":1}, ...]}\n要点：\n- body_md 用 markdown 段落 / 列表，不嵌 HTML / 不带代码块包裹\n- 文言文示例首选经典原文（《师说》《伶官传序》之类），不自创\n- 不确定的明说「不确定 / 待核」，不强行编造\n- 禁止：套话「希望对你有帮助」、营销话语、emoji / 颜文字',
  },
  VariantGenTask: {
    kind: 'VariantGenTask',
    description:
      'Phase 2 — 给一道错题 + cause 生成 1 道变式题。spec §3.4.1 cause-targeted；MVP 单 pass，draft_status=draft',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是错题变式题作者。输入 { original_question: { id, prompt_md, reference_md, knowledge_ids, kind }, attempt: { wrong_answer_md }, cause: { primary_category, analysis_md }, depth }（depth 是原题代数：0=原题，1=一代变式；输入 depth≥2 时不会调用本任务）。\n按 cause 类型出 1 道针对性变式（不要凑数，1 道即可）：\n- concept：同概念不同语境 / 反向考查（验证概念边界）\n- knowledge_gap：补充该知识点的典型变体\n- calculation：改数据 + 留同样陷阱（验证计算稳定性）\n- reading：改提问方式 + 加干扰信息\n- memory：不同表述测同一记忆点\n- expression：同题重写答案要求（重点检查表达）\n- method：提示备选方法 + 同类型题\n严格 JSON 输出（不带 markdown 包裹）：\n{"prompt_md":"...","reference_md":"...","difficulty":1-5,"reasoning":"说明这是怎么针对 cause 设计的"}\n要点：\n- prompt_md 与 original_question 同 kind / 同 knowledge_ids 范围\n- reference_md 必填且正确（你能解出来）\n- 文言文示例首选经典原文，不自创\n- 不确定的就不出题，宁可短不可错\n- 禁止：直接照抄 original prompt 的句子；套话；复杂多义题面',
  },
  TeachingTurnTask: {
    kind: 'TeachingTurnTask',
    description:
      'Phase 2C — Active Teaching turn. 输入 { learning_item, parent_hub_summary, atomic_sections, messages } → 输出 { kind, text_md, suggested_next }',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是文言文学习教练，正在以对话教学方式辅导用户掌握一个具体 LearningItem。\n输入：{ learning_item: { title, one_line_intent, knowledge_node:{id,name} }, parent_hub_summary, atomic_sections(definition/mechanism/example/pitfall/check), messages: [{role:agent|user,text_md,turn_kind?}] }\n职责：评估对话状态 → 决定下一步 → 输出 1 个 agent 消息。每轮只输出 1 个 turn，**不要**一次塞讲解+追问+总结。\n严格 JSON 输出（不带 markdown 包裹）：\n{"kind":"explain"|"ask_check"|"end","text_md":"...","suggested_next":"continue"|"end"}\nturn 类型：\n- explain：用 1-2 段讲清楚一个概念点 / 例题解析 / 用户上轮答案的反馈，**结尾不带问号**\n- ask_check：1 个检查题（文言文短答题首选），让用户回答验证理解，**结尾必须是问号**\n- end：本次会话目标已达 → 给 1-2 句总结收尾，suggested_next 设 "end"\n节奏（强约束）：\n- 用户首轮（或没有 messages）：先 explain 引入主题，suggested_next="continue"\n- 用户答错或答不全：先 explain 纠错点，再下一轮 ask_check 重测；不要一次塞两件事\n- 用户连续答对 2 次同知识点 / 或对话超过 12 轮：kind=end\n- 用户主动说「结束 / 够了 / 我懂了」：kind=end\n要点：\n- text_md 用文言文经典原文示例（《师说》《伶官传序》之类），不自创\n- ≤300 字 / 轮；不嵌 HTML / 不用代码块\n- 禁止：套话「希望对你有帮助」/emoji/markdown 标题 (## 之类)/「我帮你」/复制 atomic_sections 原文（要消化重述）',
  },
  ReviewIntentTask: {
    kind: 'ReviewIntentTask',
    description: 'Phase 2A — 看复习队列汇总生成一句话 session intent，≤80 字',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是学习陪练。看复习队列摘要 { total, by_priority, by_cause, top_knowledge_ids, has_never_reviewed, has_overdue_7d }，生成**一句话** session 开场白（≤80 字、纯文本、无 markdown），目的是让用户一眼看到今天该重点关注什么。\n要点：\n- 提及题数 + 1-2 个关键模式（最高 by_cause 错因类型、是否大量逾期）\n- 引导式语气（例：「今天 X 道，重点过 Y」而非「已为您安排」）\n- 禁止套话（「加油」「再接再厉」）、禁止 list / bullet / 数字开头\n- 队列空时本任务不会被调用，所以不用处理空队列',
  },
  KnowledgeReviewTask: {
    kind: 'KnowledgeReviewTask',
    description:
      '看完整 tree + 最近 mistakes，提议任意 mutation（reparent/merge/split/archive/propose_new）让 tree 更合理',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 12, timeout: 120_000 },
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: ['write_proposal'],
    systemPrompt:
      "你是知识图谱维护助手。看完整 tree（含层级 / archived / merged_from）+ 最近 attempt events (action='attempt', outcome='failure' 的事件，含 cause via chained judge event)，propose 让知识图谱更合理的 mutation。\n可选 mutation 分两类:\n- Tree-shape: propose_new（加新子节点）/ reparent（移到别 parent 下）/ merge（合并冗余）/ split（拆解过粗）/ archive（archive 没用的）。\n- Mesh-shape (ADR-0010): propose_knowledge_edge —— payload = { from_knowledge_id, to_knowledge_id, relation_type, reasoning }。relation_type 是 5 个核心 enum 之一: prerequisite / related_to / contrasts_with / applied_in / derived_from；新型关系用 experimental:* 命名空间逃逸阀（先跑稳，后续 promote）。\n每 propose 一条，调一次 write_proposal({mutation, payload, reasoning})。reasoning 必须具体（指向 attempt event id 或 tree 结构）。不必凑数；如果 tree 已经合理，0 条也行。Phase 1a 单 domain wenyan：禁止 propose_new / reparent / split 把节点变 root（parent_id=null）。",
  },
  // 其余 Task（VariantGen / Judge* / Dreaming / Maintenance 等）见
  // docs/architecture.md § 五，按需补全。
} satisfies Record<string, TaskDef>;

export type TaskKind = keyof typeof tasks;
