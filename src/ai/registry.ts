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
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: [
      'search_knowledge_by_concept',
      'get_knowledge_node',
      'get_node_neighbors',
      'find_similar_mistakes',
      'create_knowledge_node',
      'link_mistake_to_node',
    ],
    systemPrompt:
      '你是错题归因助手。给定一道做错的题、用户的错答和参考答案，分析错因并选择最匹配的知识点。错因从 10 类中选：concept / knowledge_gap / calculation / reading / memory / expression / method / carelessness / time_pressure / other。低信心走 other + 详细 ai_analysis_md。',
  },
  VisionExtractTask: {
    kind: 'VisionExtractTask',
    description: '错题图片 → 题面 / LaTeX / 选项',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbackChain: [],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    systemPrompt: '识别图片中的题目题面、参考答案（如可见）、选项；输出结构化 JSON。',
  },
  // 其余 Task（VariantGen / Judge* / Dreaming / Maintenance 等）见
  // docs/architecture.md § 五，按需补全。
} satisfies Record<string, TaskDef>;

export type TaskKind = keyof typeof tasks;
