import { z } from 'zod';
import {
  LearningRecordActivityKind,
  LearningRecordCaptureMode,
  LearningRecordKind,
  MemoryBriefScopeKey,
} from '../business';
import { CauseCategory } from './blocks';

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
// UserCauseExperimental — Phase 1c.2 (待稳)
// ====================================================================
//
// 用户在 POST /api/mistakes 时手填错因。actor_kind='user'，作用在 attempt event 上
// （subject_kind='event' / subject_id=<attempt_event_id> / caused_by=<同 id>）。
// 与 KnownEvent.JudgeOnEvent (actor_kind='agent') 并存：当两者都对同一 attempt
// 存在时，业务层 cause 投影优先 user_cause（用户判断盖过 AI）。
//
// Stabilization criteria：1c.2 落地 + 真实使用 4 周后 promote 为 KnownEvent.UserCauseOnEvent
// （去 experimental: 前缀；payload shape 已经 locked 在这里）。

export const UserCausePayload = z.object({
  primary_category: CauseCategory,
  user_notes: z.string().nullable().optional(),
});
export type UserCausePayloadT = z.infer<typeof UserCausePayload>;

export const UserCauseExperimental = z.object({
  actor_kind: z.literal('user'),
  actor_ref: z.string(),
  action: z.literal('experimental:user_cause'),
  subject_kind: z.literal('event'),
  subject_id: z.string(),
  outcome: z.enum(['success']).nullable().optional(),
  payload: UserCausePayload,
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type UserCauseExperimentalT = z.infer<typeof UserCauseExperimental>;

// ====================================================================
// RecordCaptureExperimental — Phase 1c.2 (待稳)
// ====================================================================
//
// Direct /record entry is still an activity. The route writes this capture
// event first, then materializes the user-visible LearningRecord linked by
// origin_event_id.

export const RecordCaptureExperimental = z.object({
  actor_kind: z.enum(['user', 'agent']),
  actor_ref: z.string(),
  action: z.literal('experimental:record_capture'),
  subject_kind: z.literal('record'),
  subject_id: z.string(),
  outcome: z.literal('success'),
  payload: z.object({
    record_kind: LearningRecordKind,
    activity_kind: LearningRecordActivityKind,
    capture_mode: LearningRecordCaptureMode,
    summary_md: z.string().optional(),
  }),
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type RecordCaptureExperimentalT = z.infer<typeof RecordCaptureExperimental>;

// ====================================================================
// MemoryBriefRefreshExperimental — Phase 1c.2 (待稳)
// ====================================================================
//
// Dreaming-maintained memory brief refresh trace. The scheduled handler lands
// later; the event contract lands with the table so future writes are typed.

export const MemoryBriefRefreshExperimental = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.literal('dreaming'),
  action: z.literal('experimental:memory_brief_refresh'),
  subject_kind: z.literal('memory_brief'),
  subject_id: z.string(),
  outcome: z.enum(['success', 'partial', 'failure']),
  payload: z.object({
    scope_key: MemoryBriefScopeKey,
    changed_sections: z.array(z.enum(['recent_week', 'recent_months', 'long_term'])),
    evidence_ids: z.array(z.string()),
    previous_version: z.number().int().nullable(),
    next_version: z.number().int().nullable(),
    failure_reason: z.string().optional(),
  }),
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type MemoryBriefRefreshExperimentalT = z.infer<typeof MemoryBriefRefreshExperimental>;

// ====================================================================
// Reserved experimental actions
// ====================================================================
//
// Action names that have a dedicated typed schema (e.g., ToolUseExperimental). The generic
// `ExperimentalEvent` fallback must REJECT these — otherwise a malformed event with a
// reserved action name (e.g., `{ action: 'experimental:tool_use', payload: {} }`) would
// silently fall through to generic parse and lose schema validation.
//
// Adding a new specialised experimental schema? Add its action literal here too.

export const RESERVED_EXPERIMENTAL_ACTIONS = new Set<string>([
  'experimental:tool_use',
  'experimental:user_cause',
  'experimental:record_capture',
  'experimental:memory_brief_refresh',
]);

// ====================================================================
// ExperimentalEvent — 通用 escape hatch (ADR-0006 v2)
// ====================================================================
//
// 新 action 探索期先用 experimental:<name> 命名空间，payload 是松守的任意 record。
// 稳定后 promote 到 KnownEvent（写 Zod schema + 测试 + 数据迁移）。
//
// Parse 时 ToolUseExperimental 应该优先 try（它是 ExperimentalEvent 的特例，shape 更
// 紧）—— 顶层 Event union 的顺序处理这点（见 ./index.ts）。此外，generic ExperimentalEvent
// 拒绝 reserved action names 防止 malformed reserved-action event 绕过专用 schema 校验。

export const ExperimentalEvent = z.object({
  action: z
    .string()
    .refine((s) => s.startsWith('experimental:'), {
      message: 'experimental action must start with "experimental:"',
    })
    .refine((s) => !RESERVED_EXPERIMENTAL_ACTIONS.has(s), {
      message:
        'reserved experimental action — payload must satisfy the dedicated schema (e.g., experimental:tool_use → ToolUseExperimental)',
    }),
  payload: z.record(z.string(), z.unknown()),
});
export type ExperimentalEventT = z.infer<typeof ExperimentalEvent>;
