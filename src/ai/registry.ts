// AI Task 注册表（Phase 1 骨架）。
//
// 每个 Task 一种产物语义；tool-calling 循环交给 Vercel AI SDK，本文件只持注册元信息。
// 详见 docs/architecture.md § 五 AI 任务层。

// Sub 0c: widen provider union to enable future routing through OpenRouter /
// Vercel AI Gateway / OpenAI without breaking registry consumers. Only
// 'anthropic' is wired in runner.ts; others throw 'not implemented' until
// Sub 0d's Provider Manager lands (see ADR-0003 2026-05-11 update + ADR-0004).
export type Provider = 'anthropic' | 'openrouter' | 'gateway' | 'openai';
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
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    fallbackChain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }],
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
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
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
    description: '错题图片 → 切块（heavy / Tier 3 — sonnet manual rescue）',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
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
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    fallbackChain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }],
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
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    fallbackChain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }],
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
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbackChain: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 30_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    systemPrompt:
      '你是学习陪练，会复盘刚结束的复习 session。输入 { session_id, duration_min, total_reviewed, ratings: { again, hard, good, easy }, top_causes: [...], top_knowledge: [...], notable_attempts: [{ prompt_md, user_response_md, fsrs_rating }, ...] } —— ratings 是 FSRS 评分分布，top_causes 来自 chained judge events，notable_attempts 是 again/hard 的最多 3 题。\n输出一段 ≤120 字的中文短文（纯文本，不要 JSON / markdown 代码块 / 列表）。三段意图：\n1) 量化总结：「X 题，Y% 正确，主要错在 Z」\n2) 模式观察：指 1-2 个具体题或知识点的卡壳\n3) 下次建议：1 句具体可执行的建议（例：「下次重点过『之-主谓间用法』，先把 e_xxx 那题再做一遍」）\n禁止：套话（「继续加油」「再接再厉」）、夸夸（「做得很好」）、笼统（「多练习」）。要具体、可执行、不超过 120 字。',
  },
  KnowledgeReviewTask: {
    kind: 'KnowledgeReviewTask',
    description:
      '看完整 tree + 最近 mistakes，提议任意 mutation（reparent/merge/split/archive/propose_new）让 tree 更合理',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    fallbackChain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }],
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
