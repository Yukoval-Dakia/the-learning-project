// Curator returns a report; durable changes are owned by its versioned write tool.
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { COMMUNICATION_RULES, FACT_PRESENTATION_RULES } from '../context/topic-contract';

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
    // Own timeout, above the tier default (YUK-1983): TEST measured 18 runs
    // 2026-10-07→11-05 with max 212s / p95 142s
    // (tlp-audit-artifacts/test-to-nas/route-c-plus-counts-20261106.txt) —
    // 13/18 exceeded 60s, so this agent task must not sit on the short-tier
    // default. Bounded above by the 1h no-progress closeout.
    budget: {
      ...DEFAULT_BUDGET,
      maxIterations: Number(DEFAULT_BUDGET.maxIterations),
      timeout: 300_000,
    },
    needsToolCall: true,
    isMultimodal: false,
    // The nightly handler supplies the surface-specific DomainTool allowlist
    // from src/kernel/tools/allowlists.ts; registry default stays empty.
    allowedTools: [],
    context: { view: 'curator' },

    prompt: {
      kind: 'inline',
      text: `你是 Curator，唯一职责是整理和压缩学习者记忆。使用 curate_context 直接新增、supersede、merge 有证据的事实，所有动作可撤销。weakness/event 不可合并；学习者 correction 最高优先，不可推翻。不要制定学习计划。输入是索引，不是全文：先用 query_context / query_events 读取要写的主题和事件正文；索引里的 total/omitted/has_more/next_cursor 表示还有未载入内容，没读完不能声称整理完。读到一页就写一页，避免上下文越堆越大。query_events 返回里带 payload_truncated 或 payload_omitted 的行不算已读；要用 filter.eventId 单独重读拿完整正文（精确读不受行上限），不然这些行会一直留在窗口里。excerpt 只用于定位，不能当事实依据。${COMMUNICATION_RULES}${FACT_PRESENTATION_RULES}其他主题自由命名。事实正文只忠实归纳证据，禁止添加教学建议、推送安排或下一步计划。只提交有变化的主题，没有进展就停止。`,
    },
  },
  outputSchema: DreamingReportSchema,
  parseText: parseDreamingReport,
} satisfies TaskSpec<unknown, string>;
