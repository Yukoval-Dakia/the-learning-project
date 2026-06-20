// YUK-237 [STB-3]: per-queue expiration / retention / dead-letter config.
// M4-T3 (YUK-319)：从 handlers.ts 抽出共享——渐缩簿（handlers.ts）与 capability
// jobs 注册器（register-capability-jobs.ts）共用同一建队配方，YUK-237/259 的
// 调和 + race 防护不维护两份。
//
// Background: pg-boss v12 sets these at the QUEUE level (createQueue options),
// inherited by each job. Defaults are `expireInSeconds: 900` (15 min — a job is
// retried/failed if it stays active longer) and `retentionSeconds: 1209600`
// (14 days a created/retry job survives before deletion). The 15-min active
// ceiling is too tight for our long tool-calling LLM jobs (quiz_gen / sourcing /
// dreaming can run multi-step agent loops), so an over-running job was being
// silently retried mid-flight. We raise expiry per workload tier and add a
// dead-letter queue for the expensive LLM producers so a job that exhausts its
// retries is preserved for inspection instead of vanishing.
//
// Tiers (expireInSeconds is the max time a job may stay `active`):
//   FAST  — sub-second housekeeping (echo / prune_* / promote_idle). Brief floor
//           of 1h is overkill for these but keeps a single safe minimum.
//   LLM   — single ~30-90s LLM call handlers (note_*, variant_*, coach_*,
//           session_summary, attribution_followup, review_plan,
//           goal_scope, hub_auto_sync, auto_enroll). 1h ceiling.
//   AGENT — multi-step tool-calling agents that can legitimately run for many
//           minutes (quiz_gen / quiz_verify / sourcing / source_verify /
//           dreaming_nightly / knowledge_maintenance / tencent_ocr). 2h ceiling.
//
// retentionSeconds: 7 days everywhere (brief floor; below the 14-day default so
// we don't keep stuck created/retry jobs around for two weeks).
//
// Dead-letter: only the AGENT + LLM producers route exhausted jobs to
// `<queue>_dlq`. We create the DLQ first (createQueue is idempotent on name) so
// the failed payload lands somewhere queryable. FAST housekeeping queues skip
// the DLQ — a dropped prune tick just re-runs on the next cron.

import type { PgBoss } from 'pg-boss';

import { isQueueCreateRace } from '@/server/boss/client';

export const RETENTION_7D = 604_800; // 7 days, brief floor
export const EXPIRE_FAST = 3_600; // 1h — brief minimum floor for cheap jobs
export const EXPIRE_LLM = 3_600; // 1h — single LLM call handlers
export const EXPIRE_AGENT = 7_200; // 2h — multi-step tool-calling agent loops

export const FAST_QUEUE_OPTS = {
  expireInSeconds: EXPIRE_FAST,
  retentionSeconds: RETENTION_7D,
} as const;

/**
 * Build createQueue options for an LLM/agent queue, wiring a dead-letter queue.
 * Caller MUST create the returned `deadLetter` queue first (see createJobQueue).
 */
function jobQueueOpts(queueName: string, expireInSeconds: number) {
  return {
    expireInSeconds,
    retentionSeconds: RETENTION_7D,
    deadLetter: `${queueName}_dlq`,
  } as const;
}

/**
 * Create a queue AND reconcile its config if it already exists.
 *
 * pg-boss `createQueue` is `INSERT ... ON CONFLICT DO NOTHING` (plans.js
 * `create_queue` plpgsql) — on an upgrade where the queue was already created by
 * an older worker, it leaves the *old* expire/retention/dead-letter untouched.
 * That silently no-ops the YUK-237 stability tuning on every existing prod DB
 * (the only DBs that matter for a long-running NAS worker). `updateQueue` runs
 * `UPDATE ${schema}.queue SET expire_seconds/retention_seconds/dead_letter ...
 * WHERE name = $1` (plans.js `updateQueue`), so calling it right after
 * createQueue forces the live config onto both brand-new and pre-existing
 * queues. On a fresh queue updateQueue is a harmless self-update; on a missing
 * queue it is a no-op UPDATE (0 rows) — but we always createQueue first, so the
 * row exists. Keeping the SAME opts object for both calls keeps them in lockstep.
 *
 * YUK-259: concurrency-safe. When the app's in-process boss (instrumentation,
 * getStartedBoss) and the worker both register/start against the same DB during
 * a cold start, pg-boss's queue INSERT can race past its own ON CONFLICT and
 * raise a 23505 `queue_pkey` violation (observed repeatedly in the test env —
 * worker crashed in registration with `Key (name)=(...) already exists`). A
 * 23505 here means the queue already exists, which is the desired end state, so
 * we swallow it and STILL run `updateQueue` — the reconcile that lands the
 * YUK-237 config onto the (now confirmed-existing) row. #329 semantics are
 * preserved: an already-existing queue still gets the new config. Any other
 * error is re-thrown.
 */
export async function createOrUpdateQueue(
  boss: PgBoss,
  name: string,
  opts: { expireInSeconds: number; retentionSeconds: number; deadLetter?: string },
): Promise<void> {
  try {
    await boss.createQueue(name, opts);
  } catch (err) {
    if (!isQueueCreateRace(err)) throw err;
    // Benign create race — the queue row exists; fall through to updateQueue so
    // the YUK-237 config still gets reconciled onto it.
    console.warn(
      `[boss] createQueue('${name}') hit a concurrent create race (23505 queue_pkey) — queue already exists, reconciling config (YUK-259)`,
    );
  }
  await boss.updateQueue(name, opts);
}

/**
 * Create an LLM/agent producer queue together with its dead-letter queue.
 *
 * Order matters: the DLQ must exist before the main queue references it as
 * `deadLetter`. createQueue is idempotent on name, so re-running registration is
 * safe; createOrUpdateQueue additionally reconciles config onto an existing
 * queue (see its docblock — required so YUK-237 tuning lands on upgraded prod
 * DBs, not just fresh ones). The DLQ itself uses FAST opts (7-day retention, 1h
 * expire) — it only holds inert failed payloads, never runs a worker.
 */
export async function createJobQueue(
  boss: PgBoss,
  name: string,
  expireInSeconds: number,
): Promise<void> {
  await createOrUpdateQueue(boss, `${name}_dlq`, FAST_QUEUE_OPTS);
  await createOrUpdateQueue(boss, name, jobQueueOpts(name, expireInSeconds));
}
