import { z } from 'zod';

// ====================================================================
// JudgePendingAttemptExperimental — YUK-777 A2 record-unjudged-at-submit
// ====================================================================
//
// `experimental:judge_pending_attempt` is the IMMUTABLE evidence that a learner
// answered, written at submit time on the durable judge lane — BEFORE any judging.
//
// Why it exists (codex #Tu71c, confirmed real data loss): the W1/W2 durable lane
// returned 202 after `boss.send` alone, so between the 202 and a successful backfill
// the answer lived nowhere but the pg-boss payload. A run whose deliveries all failed
// into `judge_run_dlq`, or whose question was deleted before pickup, lost that answer
// permanently — absent from the domain log, with no pending attempt for a sweeper or a
// human to recover. Design doc §2 ("record-unjudged-then-backfill", RULED D3) and
// §3.6b (the domain-state-scan sweeper) both presuppose this row.
//
// **It is deliberately NOT `action='attempt'`.** An `attempt` event is a JUDGED outcome:
// its `outcome` enum is required, and `knowledge_mastery`
// (drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql:27),
// `kt_estimate_nightly` and `personalized-difficulty` all aggregate
// `action IN ('attempt','review')`. Writing one here would either invent an outcome the
// judge has not produced yet, or double-count this answer once the worker writes its
// `review` event. A distinct action keeps every existing aggregate byte-identical while
// still living in the permanent domain log.
//
// RESERVED + typed (not the loose `experimental:*` hatch) because the payload is
// LOAD-BEARING on two hot paths, so a malformed one must fail loud at the parseEvent
// barrier rather than degrade silently:
//   - the reconcile sweeper re-enqueues a `judge_run` straight from `payload.submit`;
//   - the late-arrival guard reads `payload.knowledge_ids` + `payload.submit.submitted_at`
//     as the ordering water mark.
// Same discipline as `experimental:grading_checkpoint` / `experimental:copilot_nudge`.

/**
 * The frozen judge input — byte-for-byte the `submit` block of `JudgeRunJobData`
 * (capabilities/practice/jobs/judge_run.ts). Kept structurally loose on purpose: the
 * worker re-validates each part with its own owning schema (`CreateAttemptBodySchema`,
 * `SubjectProfileSchema`, `FrozenQuestionSnapshotSchema`), and re-declaring those trees
 * here would be exactly the double-write `judge-run-payload.ts` exists to avoid. This
 * barrier's job is to reject STRUCTURAL corruption, not to re-litigate domain schemas.
 *
 * Storing it verbatim is what makes the row self-sufficient: the sweeper re-enqueues it
 * unchanged, so a recovered run judges the profile + question face the learner actually
 * answered (D5 freezing survives recovery) instead of whatever those rows say later.
 */
export const JudgePendingSubmitInput = z.object({
  body: z.record(z.string(), z.unknown()),
  question_id: z.string().min(1),
  subject_profile: z.record(z.string(), z.unknown()),
  question_snapshot: z.record(z.string(), z.unknown()),
  /** ISO — the answer instant. The ordering water mark; also the FSRS scheduling anchor. */
  submitted_at: z.string().datetime(),
});
export type JudgePendingSubmitInputT = z.infer<typeof JudgePendingSubmitInput>;

export const JudgePendingAttemptPayload = z.object({
  /**
   * Load-bearing join key. The reserved `judge_run` handle, which is ALSO the id the
   * worker gives the `review` event it writes on backfill (the submit-face contract).
   * So "has this pending attempt been judged?" is exactly "does `event.id = run_id`
   * exist?" — one indexed PK lookup, independent of `job_events` and its retention.
   */
  run_id: z.string().min(1),
  /** Originating face. W2/W3-core only ever writes 'submit'; other faces land in YUK-800. */
  caller: z.literal('submit'),
  /**
   * Load-bearing: the material this verdict will write, denormalised so the late-arrival
   * guard can read the evidence water mark without loading each pending run's question.
   * Mirrors `question.knowledge_ids` at answer time (the θ̂ write domain — a superset of
   * the FSRS subset).
   */
  knowledge_ids: z.array(z.string()),
  /** The frozen judge input, re-enqueued verbatim on recovery. */
  submit: JudgePendingSubmitInput,
});
export type JudgePendingAttemptPayloadT = z.infer<typeof JudgePendingAttemptPayload>;

export const JudgePendingAttemptExperimental = z.object({
  actor_kind: z.literal('user'),
  actor_ref: z.literal('self'),
  action: z.literal('experimental:judge_pending_attempt'),
  subject_kind: z.literal('question'),
  subject_id: z.string(),
  // NULL by construction: an unjudged attempt HAS no outcome. That absence is the whole
  // point — it is what keeps this row out of every success/failure aggregate, and what
  // makes "unjudged" unforgeable rather than a flag someone must remember to read.
  outcome: z.null().optional(),
  payload: JudgePendingAttemptPayload,
  caused_by_event_id: z.null().optional(),
  task_run_id: z.null().optional(),
  cost_micro_usd: z.null().optional(),
});
export type JudgePendingAttemptExperimentalT = z.infer<typeof JudgePendingAttemptExperimental>;
