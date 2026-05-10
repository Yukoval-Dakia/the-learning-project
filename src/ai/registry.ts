// AI Task 注册表（Phase 1 骨架）。
//
// 每个 Task 一种产物语义；tool-calling 循环交给 Vercel AI SDK，本文件只持注册元信息。
// 详见 docs/architecture.md § 五 AI 任务层。

export type Provider = 'anthropic';
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
      '你是错题归因助手。给定一道做错的题、用户的错答、参考答案和已挂的知识点上下文，分析错因。\n输出严格 JSON 格式（不带 markdown 代码块包裹）：\n{"primary_category": "<10 类之一>", "secondary_categories": [...], "ai_analysis_md": "<分析过程，含错答与参考答案差异 + 涉及的知识点 / 概念>", "confidence": 0.0-1.0}\n10 类 cause: concept | knowledge_gap | calculation | reading | memory | expression | method | carelessness | time_pressure | other。低信心走 other + 详细 ai_analysis_md。',
  },
  VisionExtractTask: {
    kind: 'VisionExtractTask',
    description: '错题图片 → 切块 + 题面 + 答案 + bbox',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbackChain: [],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    systemPrompt:
      '你是错题录入助手。给定一张题目图片（试卷/手写/教材截图），输出严格 JSON（不带 markdown 代码块包裹）：\n{"blocks":[{"extracted_prompt_md":"...","reference_md":"...|null","wrong_answer_md":"...|null","page_index":0,"bbox":{"x":0.1,"y":0.2,"width":0.6,"height":0.3},"role":"prompt|answer_area|continuation","visual_complexity":"low|medium|high","extraction_confidence":0.0-1.0,"knowledge_hint":"...|null"}]}\n约束：bbox 坐标 0-1 归一化（不是像素）；一图可输出 1+ 个 block（一页多题）；page_index 由调用方覆盖；wrong_answer_md 仅当图上有用户错答 / 批改痕迹时填；knowledge_hint 是软提示。',
  },
  VisionExtractTaskHeavy: {
    kind: 'VisionExtractTaskHeavy',
    description: '错题图片 → 切块（heavy / Tier 3 — sonnet 兜底）',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    fallbackChain: [],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
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
      '你是知识图谱编辑助手。用户录入了一道做错的题，挂的 knowledge_ids 是用户自选。看错题内容 + 当前 tree snapshot，如果你认为 tree 里缺一个**更精确**的子节点能挂这条 mistake（例：「之-主谓间用法」之于「虚词」），propose 它。0-3 条，不必凑数。每条返回 { name, parent_id, reasoning }。parent_id 必须是 tree 里已有节点 id；若找不到合适 parent，跳过这条。',
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
      '你是知识图谱维护助手。看完整 tree（含层级 / archived / merged_from）+ 最近的 mistake 数据，propose 让 tree 更合理的 mutation。可选 mutation：propose_new（加新子节点）/ reparent（移到别 parent 下）/ merge（合并冗余）/ split（拆解过粗）/ archive（archive 没用的）。每 propose 一条，调一次 write_proposal({mutation, payload, reasoning})。reasoning 必须具体（指向 mistake id 或 tree 结构）。不必凑数；如果 tree 已经合理，0 条也行。Phase 1a 单 domain wenyan：禁止 propose_new / reparent / split 把节点变 root（parent_id=null）。',
  },
  // 其余 Task（VariantGen / Judge* / Dreaming / Maintenance 等）见
  // docs/architecture.md § 五，按需补全。
} satisfies Record<string, TaskDef>;

export type TaskKind = keyof typeof tasks;
