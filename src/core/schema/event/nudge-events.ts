import { z } from 'zod';

// ====================================================================
// NudgeExperimental — YUK-577 copilot 主动开口触发留痕（RESERVED + typed）
// ====================================================================
//
// `experimental:copilot_nudge` 是**承重非 report-only**事件：`GET /api/copilot/nudges`
// 读它驱动 user-facing 面，频控 + 过期 filter + surfacing gate 全依赖 payload 承重键
// （kind / headline / expires_at / shadow / in_active_session）。因此走 RESERVED + typed
// schema（非通用 experimental:* 逃逸阀）——坏 payload 在 parseEvent barrier fail-loud，
// 而非静默退化成松守 record。设计裁决见 `docs/design/2026-07-07-yuk577-proactive-triggers.md`
// §3.3（should#2）；机制先例 = `experimental:grading_checkpoint`（state-snapshot.ts）。
//
// 判定器（copilot/server/nudge-triggers.ts）是唯一 writer；确定性代码零 LLM。
// `caused_by_event_id` = 触发源 event（ingestion extract event / [cut-2] attempt event），
// 既是 evidence-first 证据链，也是 per-source 幂等唯一键（partial unique index，§3.3）。

/** kind 判别子——读模型据此分派呈现 + 频控 scope。cut-1 只产 ingestion_complete。 */
export const NudgeKind = z.enum(['ingestion_complete', 'kc_wrong_streak']);
export type NudgeKindT = z.infer<typeof NudgeKind>;

export const NudgePayload = z.object({
  // 承重：读模型分派 + 频控 scope + dismiss-fuse scope。
  kind: NudgeKind,
  // 承重：badge 展示文案（确定性模板渲染，零 LLM；ingestion 用 flag-invariant「提取到 N 个题目片段」）。
  headline: z.string(),
  // 承重：读模型过期 filter（ISO 时间）。过期 nudge 静默自沉（A3「可静默消失」），不删行。
  expires_at: z.string(),
  // 承重：surfacing gate（§3.7）。true = shadow 期证据行，GET /nudges 必须排除；owner 读它校准参数。
  shadow: z.boolean(),
  // 承重：静默窗读模型 backstop（§3.2 / Q7）。判定时的 open-practice-session 态，供读模型 defer interrupt-sensitive kind。
  in_active_session: z.boolean(),
  // loose：kind 特定证据（ingestion: session_id/block_count；[cut-2] streak: kc_id/streak_n/attempt_event_ids）。
  evidence: z.record(z.string(), z.unknown()),
});
export type NudgePayloadT = z.infer<typeof NudgePayload>;

export const NudgeExperimental = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.literal('copilot_nudge_trigger'),
  action: z.literal('experimental:copilot_nudge'),
  // ingestion→learning_session；[cut-2] streak→knowledge。
  subject_kind: z.enum(['learning_session', 'knowledge']),
  subject_id: z.string(),
  outcome: z.null().optional(),
  payload: NudgePayload,
  // REQUIRED（非 optional）——证据链 + partial unique index 唯一键都靠它。
  caused_by_event_id: z.string(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type NudgeExperimentalT = z.infer<typeof NudgeExperimental>;
