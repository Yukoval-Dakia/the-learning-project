// Curator returns a report; durable changes are owned by its versioned write tool.
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { COMMUNICATION_RULES } from '../context/topic-contract';

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

import { z } from 'zod';

export const DreamingReportSchema = z.string();

export function parseDreamingReport(text: string): string {
  return DreamingReportSchema.parse(text);
}

export const dreamingTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'DreamingTask',
    description: 'Curator consolidates learner context through reversible versioned DomainTools.',
    budget: { ...DEFAULT_BUDGET, maxIterations: Number(DEFAULT_BUDGET.maxIterations) },
    needsToolCall: true,
    isMultimodal: false,
    // The nightly handler supplies the surface-specific DomainTool allowlist
    // from src/kernel/tools/allowlists.ts; registry default stays empty.
    allowedTools: [],
    context: { view: 'curator' },

    prompt: {
      kind: 'inline',
      text: `你是 Curator，唯一职责是整理和压缩学习者记忆。使用 curate_context 直接新增、supersede、merge 有证据的事实，所有动作可撤销。weakness/event 不可合并；学习者 correction 最高优先，不可推翻。不要制定学习计划。${COMMUNICATION_RULES}其他主题自由命名。事实正文只忠实归纳证据，禁止添加教学建议、推送安排或下一步计划。只提交有变化的主题，没有进展就停止。`,
    },
  },
  outputSchema: DreamingReportSchema,
  parseText: parseDreamingReport,
} satisfies TaskSpec<unknown, string>;
