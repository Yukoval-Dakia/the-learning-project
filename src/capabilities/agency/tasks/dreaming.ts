// YUK-879 — DreamingTask contract, owned by the agency capability (Foundation D
// lineage). The nightly handler supplies the surface-specific DomainTool
// allowlist; mutations ride propose_* tools, so the free-text tail is a report,
// not a parsed artifact — the owned output schema is the raw text. Prompt text
// is byte-identical to the former central quarry entry.
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

// Legacy quarry alias preserved verbatim inside the moved definitions.
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
    description:
      'Foundation D — nightly Dreaming agent. Uses DomainTools to inspect learning signals and write bounded inbox proposals.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 12, timeout: 120_000 },
    needsToolCall: true,
    isMultimodal: false,
    // The nightly handler supplies the surface-specific DomainTool allowlist
    // from src/server/ai/tools/allowlists.ts so this registry default stays
    // empty for tests and non-nightly callers.
    allowedTools: [],
    prompt: {
      kind: 'inline',
      text: '你是 Dreaming agent。夜间读取学习信号，使用允许的 DomainTools 发现少量真正值得用户审核的建议，并通过 propose_* 工具写入 inbox。不要直接修改用户学习数据；没有高价值建议时停止。',
    },
  },
  outputSchema: DreamingReportSchema,
  parseText: parseDreamingReport,
} satisfies TaskSpec<unknown, string>;
