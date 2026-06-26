import { z } from 'zod';
import {
  LearningRecordActivityKind,
  LearningRecordCaptureMode,
  LearningRecordKind,
  MemoryBriefScopeKey,
} from '../business';
import { CauseCategory } from './blocks';

// Note (T-D7 / YUK-126, 2026-05-28): the former ToolUseExperimental schema +
// `experimental:tool_use` reserved action have been promoted out of this file
// into KnownEvent as `ToolUseQuery` / `action='tool_use'`. See
// `src/core/schema/event/known.ts` and ADR-0011 §1.1 promotion record.

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
// Action names that have a dedicated typed schema. The generic `ExperimentalEvent`
// fallback must REJECT these — otherwise a malformed event with a reserved action
// name (e.g., `{ action: 'experimental:user_cause', payload: {} }`) would silently
// fall through to generic parse and lose schema validation.
//
// Adding a new specialised experimental schema? Add its action literal here too.
//
// Note (T-D7 / YUK-126, 2026-05-28): `'experimental:tool_use'` removed from this
// set after promotion to KnownEvent `tool_use` (ADR-0011 §1.1).

export const RESERVED_EXPERIMENTAL_ACTIONS = new Set<string>([
  'experimental:user_cause',
  'experimental:record_capture',
  'experimental:memory_brief_refresh',
  // ADR-0044 §3 (YUK-471 Wave 0) — A-class θ̂/FSRS snapshot has a dedicated
  // StateSnapshotExperimental schema (./state-snapshot.ts). Generic fallback
  // must reject it so malformed snapshot payloads can't lose schema validation.
  'experimental:state_snapshot',
  // YUK-471 Wave 1 (Codex #4 parse barrier) — pre-W1 row backfill seed has a
  // dedicated GenesisExperimental schema (./genesis.ts). The fold trusts genesis
  // as ground truth, so a malformed seed would corrupt the whole projection;
  // generic fallback must reject it so the typed schema always validates the seed.
  'experimental:genesis',
  // YUK-471 Wave 2 (goal fold) — goal status/scope action events have dedicated
  // typed schemas (./goal-events.ts) so a status/scope transition is fold-visible.
  // The fold trusts these to reproduce version/updated_at; a malformed payload must
  // be rejected at the barrier, not fall through to the loose generic.
  'experimental:goal_status_update',
  'experimental:goal_scope_update',
  // YUK-471 Wave 2 (mistake_variant fold, critic A4) — the RUNTIME creation BASE event
  // (./mistake-variant-events.ts) carries the full initial row INCLUDING the fold-blind
  // cause_category. It is the runtime analog of the backfill-only experimental:genesis (A4:
  // genesis must NOT be used on the creation hot path). The fold trusts payload.row as the row's
  // base/ground truth, so a malformed create payload must be rejected here, not fall through.
  'experimental:mistake_variant_create',
  // YUK-471 Wave 2 (learning_item fold) — the three status-transition action events
  // (./learning-item-events.ts) make a complete/relearn/archive fold-visible via Q1 (the
  // recommended route — no rate-payload side-channel reverse-lookup). The fold trusts them to
  // reproduce status/completed_at/archived_at/version; a malformed payload must be rejected at
  // the barrier, not fall through to the loose generic.
  'experimental:learning_item_complete',
  'experimental:learning_item_relearn',
  'experimental:learning_item_archive',
  // YUK-471 Wave 3 (artifact fold, design §3 #2/#3/#4) — the three artifact action events
  // (./artifact-events.ts) make every structural artifact mutation fold-visible + self-sufficient:
  // body_blocks_edit (full AFTER-snapshot), artifact_create (runtime creation BASE, unifying the 8
  // INSERT sites — genesis stays backfill-only, critic A4), artifact_lifecycle (archive/unarchive +
  // generation_status/verification_status transitions, F1). The fold trusts these to reproduce
  // body_blocks/version/status; a malformed payload must be rejected at the barrier, not fall
  // through to the loose generic. NOTE: the legacy `experimental:artifact_body_blocks_edit`
  // (body-blocks-edit.ts) is intentionally NOT reserved — its on-disk events lack body_blocks and
  // keep parsing via the generic fallback; W3-C1 migrates the writer to `experimental:body_blocks_edit`.
  'experimental:body_blocks_edit',
  'experimental:artifact_create',
  'experimental:artifact_lifecycle',
  // YUK-471 Wave 3 (question_block fold, design §3 #5/#6) — the two question_block action events
  // (./question-block-events.ts) move the structured edit off the loose `job_events`
  // `block.structured_edited` row onto the canonical log: edit_question_block_structured (full AFTER
  // snapshot per affected block — a merge's 1+N job_events collapse to ONE canonical event, with the
  // absorbed rows as merged_source, NO merged_into), question_block_create (OCR/rescue/docx/import
  // creation BASE — genesis stays backfill-only, critic A4). The fold trusts these to reproduce
  // structured/figures/status/version; a malformed payload must be rejected at the barrier, not fall
  // through to the loose generic. NOTE: the legacy `job_events` `block.structured_edited` is a
  // transport row, NOT an `experimental:*` action, so it is unaffected by this reservation.
  'experimental:edit_question_block_structured',
  'experimental:question_block_create',
]);

// ====================================================================
// ExperimentalEvent — 通用 escape hatch (ADR-0006 v2)
// ====================================================================
//
// 新 action 探索期先用 experimental:<name> 命名空间，payload 是松守的任意 record。
// 稳定后 promote 到 KnownEvent（写 Zod schema + 测试 + 数据迁移）。
//
// Parse 时各 reserved experimental schema（UserCauseExperimental / RecordCaptureExperimental /
// MemoryBriefRefreshExperimental）应优先 try（它们是 ExperimentalEvent 的特例，shape 更
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
        'reserved experimental action — payload must satisfy the dedicated schema (e.g., experimental:user_cause → UserCauseExperimental)',
    }),
  payload: z.record(z.string(), z.unknown()),
});
export type ExperimentalEventT = z.infer<typeof ExperimentalEvent>;
