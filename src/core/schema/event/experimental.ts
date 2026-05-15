import { z } from 'zod';

// ====================================================================
// ToolUseExperimental — ADR-0011 §1 (待稳)
// ====================================================================
//
// Copilot tool-use 路径。subject_id 自标识（'tool_use_<cuid>'）。args 是任意 record
// （tool 入参 shape 因 tool 而异）。outcome='failure' 时 error_reason 应填（业务层）。
//
// Stabilization criteria (ADR-0011 §1)：至少 3 个 tool 落地 + payload shape 稳定 2 周
// 之后可 promote 为正式 ToolUseQuery (去 experimental: 前缀)。

export const ToolUseExperimental = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),
  action: z.literal('experimental:tool_use'),
  subject_kind: z.literal('query'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    tool_name: z.string(),
    args: z.record(z.string(), z.unknown()),
    result_summary: z.string().optional(),
    result_count: z.number().int().optional(),
    error_reason: z.string().optional(),
  }),
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type ToolUseExperimentalT = z.infer<typeof ToolUseExperimental>;

// ====================================================================
// ExperimentalEvent — 通用 escape hatch (ADR-0006 v2)
// ====================================================================
//
// 新 action 探索期先用 experimental:<name> 命名空间，payload 是松守的任意 record。
// 稳定后 promote 到 KnownEvent（写 Zod schema + 测试 + 数据迁移）。
//
// Parse 时 ToolUseExperimental 应该优先 try（它是 ExperimentalEvent 的特例，shape 更
// 紧）—— 顶层 Event union 的顺序处理这点（见 ./index.ts）。

export const ExperimentalEvent = z.object({
  action: z.string().refine((s) => s.startsWith('experimental:'), {
    message: 'experimental action must start with "experimental:"',
  }),
  payload: z.record(z.string(), z.unknown()),
});
export type ExperimentalEventT = z.infer<typeof ExperimentalEvent>;
