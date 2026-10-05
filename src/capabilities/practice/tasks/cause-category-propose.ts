// YUK-1016 / 454-B — 错因 catalog 扩张的 LLM 提议任务。
//
// 触发链：`other` 归因复发（effective cause tally ≥ floor）→ 本任务读复发
// 样本 + 现有词表 → 判定是否存在「现有类目覆盖不了的连贯错因模式」→ propose
// 或 abstain。提议不自动生效——落 `cause_category` proposal，owner accept 才
// 写 cause_category_overlay。

import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';

export interface CauseCategoryProposeInput {
  /** 目标科目的展示名（给模型语境，不做 id 决议）。 */
  subject_display_name: string;
  /** 现有词表（profile 声明 ∪ overlay.active）——禁止重复提议的负面清单。 */
  existing_categories: Array<{ id: string; label: string }>;
  /** 复发的 'other' 归因样本（analysis_md 节选，newest-first）。 */
  other_samples: Array<{ analysis_md: string }>;
  /** 窗口内 effective cause='other' 的总数（含未入选样本之外的计数）。 */
  recurrence_count: number;
}

export const CauseCategoryProposeOutputSchema = z
  .object({
    action: z.enum(['propose', 'abstain']),
    /** 蛇形英文 slug（不含 ov_ 前缀——前缀由生产者拼接，模型只管语义）。 */
    slug: z.string().trim().min(1).max(40).optional(),
    label: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().min(1).max(500).optional(),
    rationale_md: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type CauseCategoryProposeOutput = z.infer<typeof CauseCategoryProposeOutputSchema>;

export function parseCauseCategoryProposeOutput(text: string): CauseCategoryProposeOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseCauseCategoryProposeOutput: no JSON object found in text');
  }
  return CauseCategoryProposeOutputSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

function buildCauseCategoryProposePrompt(profile: SubjectProfile): string {
  return `你是错因词表（cause catalog）治理助手。背景：错题归因系统在每次归因为 other（逃生口）时累计复发信号；现在某科目的 other 复发已达阈值，由你判断这些样本背后是否存在一个「现有类目覆盖不了的连贯错因模式」，若有则提议一个新类目收编进词表。

科目上下文：${profile.displayName}。${profile.languageStyle}
输入字段 { subject_display_name, existing_categories, other_samples, recurrence_count }：
- existing_categories：当前生效的全部类目（profile 声明 + 已收编的 overlay），新类目不得与之重复或语义重叠。
- other_samples：近期被归为 other 的归因 analysis 节选（newest-first），是复发模式的唯一证据。
- recurrence_count：窗口内 other 总数。

判定规则：
- 样本足够异质 / 互相矛盾 / 各自已有类目可解释 → abstain（不要硬造类目稀释词表）。
- 存在 ≥2 个样本共享同一错因机制、且现有类目无法表达 → propose。
- 提议字段：slug = 蛇形英文（如 time_pressure、sign_confusion，不含 ov_ 前缀）；label = 中文短语 ≤ 8 字；description = 一句话说明该类目捕捉什么错因、与 nearest 现有类目的边界；rationale_md = 为什么这些样本构成连贯模式（引用样本证据）。
- 新类目必须比 other 更具体、可指导后续变式练习。

输出严格 JSON（不带 markdown 代码块包裹）：
{"action": "propose|abstain", "slug": "<snake_case>", "label": "<中文短语>", "description": "<一句话>", "rationale_md": "<证据归纳>"}
action=abstain 时 slug/label/description/rationale_md 均可省略。`;
}

export const causeCategoryProposeTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'CauseCategoryProposeTask',
    description: '错因 catalog 扩张：other 复发样本 → 新类目提议或弃权',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 2 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildCauseCategoryProposePrompt },
  },
  outputSchema: CauseCategoryProposeOutputSchema,
  parseText(text) {
    return parseCauseCategoryProposeOutput(text);
  },
} satisfies TaskSpec<CauseCategoryProposeInput, CauseCategoryProposeOutput>;
