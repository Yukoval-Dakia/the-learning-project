/**
 * Rejudge enqueue config — kept SEPARATE from `rejudge.ts` (the handler) on
 * purpose: `appeal.ts` (a lightweight API route) only needs this constant to
 * enqueue, and must NOT statically pull the handler's heavy graph (`judgeAnswer`
 * LLM modules, subject-profile). `handlers.ts` already dynamic-imports the
 * handler to keep it lazy; this mirrors the YUK-486 split where
 * `AUTO_ENROLL_SINGLETON_SECONDS` lives in `workflow-judge-config.ts`, not the
 * job.
 */

/**
 * YUK-491 — singleton debounce window (seconds) for the appeal→`rejudge` enqueue
 * in `appeal.ts`. The `rejudge` queue is created with NO policy (standard), so a
 * BARE `singletonKey` is a NO-OP in pg-boss v12: every singleton unique index is
 * gated on a non-standard policy except the policy-INDEPENDENT `job_i4`, which
 * requires `singleton_on IS NOT NULL` — populated ONLY when `singletonSeconds` is
 * passed. Pairing the key with this window makes the send-layer dedup real, so
 * two near-simultaneous sends for the same appeal collapse to ONE job. (pg-boss
 * buckets `singleton_on` by this window — bucketed, NOT sliding — so the collapse
 * catches near-simultaneous sends within a bucket; a same-id pair straddling a
 * bucket boundary falls through to the handler `caused_by` backstop below, which
 * is exactly what that backstop is for.)
 *
 * The handler's `caused_by` re-check (rejudge.ts) is the correctness backstop (a
 * duplicate that slips through still bails before re-judging); this window's job
 * is to prevent the WASTED concurrent LLM re-judge that a bare key never stopped.
 * 60s comfortably covers the observed same-instant double-send (dev double-worker
 * consume / a retry re-send) and can never suppress a legitimate distinct appeal
 * — each appeal POST mints a NEW appeal-event id = a NEW singletonKey. Mirrors
 * `AUTO_ENROLL_SINGLETON_SECONDS` (YUK-486) + `memory/triggers.ts`.
 */
export const REJUDGE_SINGLETON_SECONDS = 60;
