// Native durable assessment execution; original domain inputs own all scoring.
// Legacy completed runs can reconstruct notifications. Unfinished legacy payloads
// retain their original answer and terminate without invoking a retired scorer.

import { eq } from 'drizzle-orm';
import type { JobWithMetadata } from 'pg-boss';
import { ZodError } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { EvaluateSubmissionError } from '../server/judge/evaluate-submission';
import {
  JudgeReceiptConflict,
  JudgeRunClosedError,
  disposeJudgeRun,
} from '../server/judge-operational';
import { projectJudgeRunNotification } from '../server/judge-run-notification';
import { readJudgeRunPermanent } from '../server/judge-run-observation';
import type { JudgeRunJobData } from '../server/judge-run-payload';
import { JUDGE_RUN_EVENTS } from '../server/judge-run-status';

// Original native input pointers and historical queue payloads share the recovery envelope.
export type { JudgeRunJobData } from '../server/judge-run-payload';

export type JudgeRunOutcome =
  | { status: 'done'; run_id: string; coarse_outcome: string; judge_event_id: string | null }
  | { status: 'skipped'; run_id: string; reason: string }
  | { status: 'failed'; run_id: string; error: string };

export interface JudgeRunDeps {
  /** Failure/recovery seam around the real native executor; production supplies none. */
  executeNativeAttemptFn?: typeof import('../server/assessment/durable-attempt')['executeNativeAttempt'];
}

export async function runJudgeWorkflowDelivery(
  db: Db,
  untrusted: unknown,
  deps: JudgeRunDeps = {},
) {
  const input = JudgeWorkflowInput.parse(untrusted);
  const [row] = await db.select().from(event).where(eq(event.id, input.pending_id));
  const pending = JudgePendingAttemptPayload.parse(row?.payload);
  if (
    pending.caller !== 'native_assessment' ||
    pending.run_id !== input.run_id ||
    canonicalHash(pending) !== input.pending_digest
  )
    throw new JudgeReceiptConflict('Workflow input differs from frozen pending operation');
  return runJudgeRun(
    db,
    {
      run_id: pending.run_id,
      caller: 'native_assessment',
      submit: pending.submit,
      operational: input,
    },
    { retryCount: 0, retryLimit: 0, deliveryId: input.delivery_id },
    deps,
  );
}

/** Queue retry metadata governs infrastructure retries, never automatic model fallback. */
export interface JudgeRunJobMeta {
  retryCount: number;
  retryLimit: number;
  /** pg-boss job id; absent only for legacy/direct callers. */
  deliveryId?: string;
}

export async function runJudgeRun(
  db: Db,
  data: JudgeRunJobData,
  meta: JudgeRunJobMeta,
  deps: JudgeRunDeps = {},
): Promise<JudgeRunOutcome> {
  const runId = data.run_id;
  const permanent = await readJudgeRunPermanent(db, runId);
  if (permanent.kind === 'manual') {
    await writeTerminalJobEvent(db, {
      businessId: runId,
      eventType: JUDGE_RUN_EVENTS.FAILED,
      payload: { reason: 'manual', error_code: permanent.disposition.reason },
    });
    return { status: 'skipped', run_id: runId, reason: 'manual' };
  }

  // ── 幂等守卫 ────────────────────────────────────────────────────────────
  // 回填事务已 commit（attempt event id=run_id 已写）但终态 job_event 写前 worker
  // 崩溃 → pg-boss redeliver。此时重跑 deferred settlement 会因 event PK=run_id 冲突炸，
  // 且会重复判分/双写 FSRS。守卫：attempt event 已存在 → 回填已发生，补齐缺失的
  // DONE 终态（供 SSE/poll 消费）后早返，绝不重判重写。见 recoverAlreadyPersisted；
  // 同一条恢复路径也是 #1 重复投递竞态（catch 里）的落点。
  if (await attemptAlreadyPersisted(db, runId)) {
    return await recoverAlreadyPersisted(db, runId, meta.deliveryId);
  }

  // started 心跳——消费者据此把 status 从 queued 推到 started。非终态进度信号，
  // best-effort（丢一条心跳不影响正确性；terminal DONE/FAILED 才是承重）。
  await bestEffortWriteJobEvent(db, {
    businessId: runId,
    eventType: JUDGE_RUN_EVENTS.STARTED,
    payload: {
      caller: data.caller,
      retry_count: meta.retryCount,
      ...(meta.deliveryId ? { delivery_id: meta.deliveryId } : {}),
    },
  });

  // #2 — tracks whether the backfill tx COMMITTED. If it did but the terminal DONE
  // write then fails, we must rethrow (not write a misleading FAILED) so pg-boss
  // redelivers and the idempotency guard reconstructs the real DONE.
  let persistedOk = false;
  try {
    if (data.caller === 'native_assessment') {
      const { executeNativeAttempt } = await import('../server/assessment/durable-attempt');
      const committed = await (deps.executeNativeAttemptFn ?? executeNativeAttempt)(db, data);
      persistedOk = true;
      await recoverAlreadyPersisted(db, runId, meta.deliveryId);
      return {
        status: 'done',
        run_id: runId,
        coarse_outcome: committed.candidate.result.coarse_outcome,
        judge_event_id: null,
      };
    }
    if (data.caller === 'submit') {
      throw new NonRetryableJudgeRunError(
        'legacy queued assessment has no original native binding; answer retained for review',
        'historical_unknown',
      );
    }
    throw new NonRetryableJudgeRunError('unsupported judge_run caller');
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    // #2 — the backfill COMMITTED but the terminal DONE write threw: the run SUCCEEDED,
    // only its terminal notification failed. Do NOT write a misleading FAILED — rethrow
    // so pg-boss redelivers and the idempotency guard reconstructs the real DONE from
    // the persisted judge event. (Writing FAILED here would be a lie about a committed run.)
    if (persistedOk) {
      console.error(
        '[judge_run] terminal DONE write failed after backfill commit — rethrowing for redelivery',
        runId,
        err,
      );
      throw err;
    }
    // #1 (major) — DUPLICATE-DELIVERY RACE. pg-boss can hand the same job to a second
    // worker while the first is still inside its slow LLM call (expire window exceeded).
    // Both pass the entry guard (no attempt event yet). Worker A commits + writes DONE;
    // worker B's deferred settlement then dies on the event PK (id=runId already inserted).
    // Treating that like any other failure wrote a terminal FAILED which, being the LAST
    // terminal event, made deriveJudgeRunStatus report 'failed' FOREVER for a run that was
    // correctly judged and persisted. A committed attempt event means "someone else already
    // persisted this run" — exactly the entry guard's condition — so route to the SAME
    // recovery instead: reconstruct DONE if missing, and NEVER write FAILED.
    if (await attemptAlreadyPersisted(db, runId)) {
      console.warn(
        '[judge_run] persist failed but the attempt event exists — another delivery already committed this run; recovering instead of failing',
        runId,
        err,
      );
      return await recoverAlreadyPersisted(db, runId, meta.deliveryId);
    }
    // A malformed job payload (Zod parse of body/profile/question snapshot, or an invalid
    // date) is a permanent defect: re-delivery would just re-fail identically and waste the
    // retry budget. Classify ZodError as non-retryable alongside our explicit marker.
    // W5 #Tu1cZ — a persistence VALIDATION failure is permanent, not transient. Settlement
    // throws `ApiError('corrupt_state', …, 422)` when an existing FSRS card cannot be parsed;
    // that is deterministic, so every redelivery re-runs a PAID judge before failing the same
    // way, burning the whole retry budget and ending as `retries_exhausted` — which also buries
    // the actionable "reset this card" signal the 422 was carrying. Classified permanent so it
    // terminalizes on the first delivery with its own reason code.
    const nonRetryable =
      err instanceof NonRetryableJudgeRunError ||
      err instanceof JudgeRunClosedError ||
      err instanceof JudgeReceiptConflict ||
      (err instanceof EvaluateSubmissionError && err.code !== 'evaluation_busy') ||
      err instanceof ZodError ||
      isPermanentPersistError(err) ||
      (data.caller === 'native_assessment' &&
        err instanceof ApiError &&
        [
          'coordinate_mismatch',
          'stale_head',
          'unsupported_judge_route',
          'judge_authorization_required',
          'judge_disposed',
          'attempt_conflict',
        ].includes(err.code));
    // W4 #TtWiB — will pg-boss deliver this job again? Only when the failure is retryable AND
    // the budget is not spent. That question, not "did something fail", decides whether the
    // trace we write is TERMINAL. Round 3 over-generalized the "terminal writes must throw"
    // rule into "every failure writes terminal FAILED", which told poll/SSE clients the run
    // was dead while pg-boss had a redelivery queued that would likely write DONE.
    const willRetry = !nonRetryable && meta.retryCount < meta.retryLimit;
    // #6 — the raw error message stays SERVER-SIDE. The generic SSE face
    // (`/api/jobs/judge_run/[id]/events`) streams job_event payloads verbatim to clients, so
    // a DB error string / internal path / provider response fragment in `payload.error` was
    // leaking straight out. The payload now carries only a classified code; the raw message
    // is logged here and nowhere else.
    console.error(
      `[judge_run] ${runId} attempt failed (${nonRetryable ? 'non_retryable' : 'error'}; ${
        willRetry ? 'retry pending' : 'terminal'
      })`,
      err,
    );

    if (!willRetry) {
      // Permanent manual evidence precedes notification and diagnostic release.
      if (permanent.kind !== 'absent')
        await disposeJudgeRun(db, runId, {
          reason:
            data.caller === 'submit'
              ? 'historical_unknown'
              : err instanceof JudgeReceiptConflict
                ? 'invalid_receipt'
                : (err instanceof ApiError || err instanceof EvaluateSubmissionError) &&
                    ['coordinate_mismatch', 'stale_head', 'attempt_conflict'].includes(err.code)
                  ? 'input_conflict'
                  : 'terminal_delivery',
          actorRef: 'judge:worker',
          evidenceRefs: [`evt_pending_${runId}`, meta.deliveryId ?? runId],
          evidenceDigest: canonicalHash({
            runId,
            deliveryId: meta.deliveryId ?? null,
            code: classifyJudgeRunFailure(err),
          }),
        });
      const claimedAt = new Date(data.submit.submitted_at);
      if (!Number.isNaN(claimedAt.getTime())) {
        await (
          await import('../server/review-operation')
        ).releaseInterventionDiagnosticSubmissionClaim(
          { questionId: data.submit.question_id, claimedAt },
          db,
        );
      }
    }

    if (willRetry) {
      // NON-terminal trace: evidence that this delivery failed, without judging the run dead.
      // deriveJudgeRunStatus keeps it at 'started', so clients stay subscribed for the retry.
      // Best-effort on purpose: we rethrow below regardless, so pg-boss redelivers either way
      // — losing a progress breadcrumb cannot strand the run (unlike a terminal write).
      await bestEffortWriteJobEvent(db, {
        businessId: runId,
        eventType: JUDGE_RUN_EVENTS.ATTEMPT_FAILED,
        payload: {
          error_code: classifyJudgeRunFailure(err),
          retry_count: meta.retryCount,
          retry_limit: meta.retryLimit,
          ...(meta.deliveryId ? { delivery_id: meta.deliveryId } : {}),
        },
      });
      // rethrow → pg-boss 按策略重投（JOB_RETRY_LIMIT=2，30s→60s backoff）。
      throw err;
    }

    // Terminal: either non-retryable (unknown face / missing question / bad payload — a
    // redelivery would re-fail identically) or the retry budget is spent and the next stop is
    // `judge_run_dlq`. Either way no further delivery will change the outcome, so the run is
    // honestly dead and replay/UI must be told.
    //
    // #3 (codex) — 这条终态写**不可吞错**（原先走 bestEffort）：非 retryable 分支写完就
    // return success，一旦这条 FAILED 写失败被吞掉，pg-boss 认为 job 成功、run 却无任何
    // 终态 → poll/SSE 永远 pending。与 DONE 侧同语义：写失败 → 抛出 → 重投递重试终态写
    // （耗尽则 DLQ 暴露），绝不静默成功。
    try {
      await writeTerminalJobEvent(db, {
        businessId: runId,
        eventType: JUDGE_RUN_EVENTS.FAILED,
        payload: {
          reason: nonRetryable ? 'non_retryable' : 'retries_exhausted',
          error_code: classifyJudgeRunFailure(err),
          retry_count: meta.retryCount,
          retry_limit: meta.retryLimit,
          ...(meta.deliveryId ? { delivery_id: meta.deliveryId } : {}),
        },
      });
    } catch (writeErr) {
      console.error(
        '[judge_run] terminal FAILED write failed — rethrowing for redelivery (a swallowed terminal write leaves the run pending forever)',
        runId,
        writeErr,
      );
      throw writeErr;
    }
    if (nonRetryable) {
      return { status: 'failed', run_id: runId, error: message };
    }
    // Budget spent: rethrow so pg-boss completes the failure and routes to judge_run_dlq
    // (handlers.ts createJobQueue). The terminal FAILED trace above is already committed.
    throw err;
  }
}

/**
 * #6 — client-safe failure classification. The FAILED job_event payload is streamed
 * verbatim over the generic SSE face, so it carries one of these coarse codes instead of
 * the raw error text (which is logged server-side only).
 */
function classifyJudgeRunFailure(err: unknown): string {
  if (err instanceof ZodError) return 'invalid_payload';
  if (err instanceof NonRetryableJudgeRunError) return err.code;
  if (isPermanentPersistError(err)) return 'corrupt_state';
  return 'judge_failed';
}

/**
 * W5 #Tu1cZ — is this a DETERMINISTIC persistence failure that redelivery cannot fix?
 *
 * Keyed on the ApiError `code`, not the HTTP status: 422 is also used for transient-ish
 * semantic rejections elsewhere, whereas `corrupt_state` specifically means stored state
 * failed to parse — identical on every attempt. Matching the code keeps the classification
 * narrow enough that a genuinely retryable failure is never mislabelled permanent (which
 * would be the more dangerous direction: it would drop a run that a retry would have saved).
 */
function isPermanentPersistError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'corrupt_state';
}

/** 该 run 的 attempt/outcome event（id=run_id）是否已落库 ⇒ 回填已由某次投递提交。 */
async function attemptAlreadyPersisted(db: Db, runId: string): Promise<boolean> {
  return (await readJudgeRunPermanent(db, runId)).kind === 'resolved';
}

/**
 * 「回填已提交」的统一恢复路径——入口幂等守卫与 catch 里的重复投递竞态（#1）共用。
 *
 * 若终态 DONE 已在（崩在 DONE 写**之后**）→ 不再补写：一条精简的 {already_persisted}
 * DONE 会成为最后一条 DONE，terminalJudgeRunResult 就会丢掉真判词（poll/SSE 失去
 * coarse_outcome/feedback）。仅当没有 DONE（崩在 commit 与 DONE 写**之间**，或本次是
 * 竞态输家而赢家尚未写 DONE）才从已持久化的 judge event 重建**完整**判词。
 *
 * 这条重建写**必须抛错**（非 best-effort）：吞掉它，run 就停在已持久化但无终态，
 * poll/SSE 永远 pending。抛出 → pg-boss 重投 → 本守卫重试直到写成功（或 DLQ 暴露）。
 */
async function recoverAlreadyPersisted(
  db: Db,
  runId: string,
  _deliveryId?: string,
): Promise<JudgeRunOutcome> {
  const state = await readJudgeRunPermanent(db, runId);
  if (state.kind !== 'resolved')
    throw new JudgeReceiptConflict('Notification repair requires exact domain completion');
  await writeTerminalJobEvent(db, {
    businessId: runId,
    eventType: JUDGE_RUN_EVENTS.DONE,
    payload: state.result,
  });
  return { status: 'skipped', run_id: runId, reason: 'already_persisted' };
}

/**
 * best-effort job_event 写——仅用于**非终态**进度信号（STARTED 心跳）。丢一条心跳
 * 不影响正确性。终态 DONE/FAILED 绝不用它（吞错会让 run 悬空）——见 writeTerminalJobEvent。
 */
async function bestEffortWriteJobEvent(
  db: Db,
  args: { businessId: string; eventType: string; payload: Record<string, unknown> },
): Promise<void> {
  try {
    await projectJudgeRunNotification(db, args.businessId, {
      eventType: args.eventType,
      payload: args.payload,
    });
  } catch (err) {
    console.error(`[judge_run] ${args.eventType} write failed for`, args.businessId, err);
  }
}

/**
 * #2 / #3 — terminal job_event 写，**故意不吞错**（与 bestEffort 相反）。一个失败的终态
 * 写会让 run 卡在无终态（poll/SSE 永远 pending），故 throw 让上游触发 redelivery →
 * 幂等守卫重建终态。**所有**终态写都走它：happy-path DONE、already_persisted 恢复
 * DONE、以及 catch 里的 FAILED（#3：FAILED 曾走 bestEffort，写失败被吞 + 非 retryable
 * 分支照常 return success ⇒ pg-boss 丢 job 而 run 无终态）。
 */
async function writeTerminalJobEvent(
  db: Db,
  args: { businessId: string; eventType: string; payload: Record<string, unknown> },
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < TERMINAL_WRITE_ATTEMPTS; attempt++) {
    try {
      await projectJudgeRunNotification(db, args.businessId, {
        eventType: args.eventType,
        payload: args.payload,
      });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < TERMINAL_WRITE_ATTEMPTS - 1) {
        console.warn(
          `[judge_run] terminal ${args.eventType} write failed (attempt ${attempt + 1}/${TERMINAL_WRITE_ATTEMPTS}) — retrying`,
          args.businessId,
          err,
        );
        await sleep(TERMINAL_WRITE_BACKOFF_MS[attempt] ?? 0);
      }
    }
  }
  throw lastErr;
}

/**
 * W5 #Tuey9 — in-process retry budget for a TERMINAL job_event write.
 *
 * Why this exists: redelivery is not a universal safety net for the terminal write. On the
 * FINAL delivery (`retryCount === retryLimit`) the pg-boss budget is already spent, so a
 * throw sends the job to the DLQ and the idempotency guard never runs again — an attempt that
 * COMMITTED would sit behind its STARTED event with no terminal event, leaving poll/SSE
 * pending forever. The finding describes a *transient* insert failure, and a bounded
 * in-process retry is the remedy that matches that shape: it does not depend on any further
 * delivery.
 *
 * **Why this cannot double-write.** `writeJobEvent` INSERTs a new `job_events` row; it never
 * updates in place. Three cases:
 *   - the insert genuinely failed → the retry produces exactly one row;
 *   - the insert committed but the ack was lost → the retry adds a SECOND terminal row with
 *     an identical payload. Both consumers are idempotent under that: `deriveJudgeRunStatus`
 *     is last-writer-wins over a terminal kind (two DONEs ⇒ done; two FAILEDs ⇒ failed), and
 *     `terminalJudgeRunResult` returns the LAST DONE payload — which is byte-identical to the
 *     first. So a duplicate is invisible downstream;
 *   - all attempts fail → we rethrow, which is strictly better than swallowing.
 * Note this is retrying the *notification*, not the backfill: the attempt tx is already
 * committed and is never re-executed here, so there is no risk of a second judge or a second
 * FSRS write.
 *
 * Residual (documented, W3/YUK-777): if the DB is unreachable for the whole window we cannot
 * durably record ANY terminal marker anywhere, so the run stays pending until the
 * domain-state-scan sweeper picks it up. No in-process scheme can close that.
 */
const TERMINAL_WRITE_ATTEMPTS = 3;
const TERMINAL_WRITE_BACKOFF_MS = [100, 400];

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** 判定为不可重投的失败（未知面 / 题缺失 / body 复校失败）——写 FAILED 后不 rethrow。 */
export class NonRetryableJudgeRunError extends Error {
  override name = 'NonRetryableJudgeRunError';
  constructor(
    message: string,
    readonly code = 'unprocessable_run',
  ) {
    super(message);
  }
}

/**
 * pg-boss handler 工厂。register 在 handlers.ts（渐缩簿）以 includeMetadata:true 注册，
 * 故 jobs 是 JobWithMetadata（带 retryCount/retryLimit，驱动跨 provider lane 决策）。
 * batchSize:1 → 串行一次一 run。
 */
export function buildJudgeRunHandler(
  db: Db,
  /** test seam — forwarded to runJudgeRun (production registration passes none). */
  deps: JudgeRunDeps = {},
): (jobs: JobWithMetadata<JudgeRunJobData>[]) => Promise<void> {
  return async (jobs) => {
    // #11 — per-job isolation. `batchSize:1` (handlers.ts) means today's batch is always a
    // single job, so a throw could only ever abort "the rest of" an empty remainder. That
    // safety is INCIDENTAL, not designed: bump batchSize and one retryable throw would
    // abandon every later job in the batch (pg-boss fails the whole batch, and the skipped
    // jobs never even ran). Each job now runs in its own try/catch: a failure is logged and
    // recorded, the loop keeps draining, and the batch still fails at the end so pg-boss
    // redelivers — retry semantics unchanged, blast radius bounded to the failing job.
    let firstError: unknown = null;
    for (const job of jobs) {
      const data = job.data;
      if (!data?.run_id || !data?.caller || !data?.submit) {
        // W4 #TtZ8i — a silent `continue` returned success to pg-boss, which CONSUMED the job
        // with no terminal job_event anywhere: the file's core invariant (every run reaches
        // DONE/FAILED for poll/SSE) was violated precisely where nothing could ever fix it,
        // and `runJudgeRun`'s own malformed-payload guard (which DOES write FAILED) was
        // bypassed by this earlier check so the safety net never fired.
        //
        // With a run_id we can still terminalize honestly. Without one there is no business_id
        // to key an event on, so the only correct move is to fail the job: pg-boss retries and
        // then routes to `judge_run_dlq`, where an operator can actually see the malformed
        // payload — infinitely better than dropping it on the floor.
        console.error('[judge_run] job missing run_id/caller/submit', job.id, {
          has_run_id: Boolean(data?.run_id),
          has_caller: Boolean(data?.caller),
          has_submit: Boolean(data?.submit),
        });
        if (data?.run_id) {
          // Same semantics as runJudgeRun's non-retryable branch: terminalize and CONSUME the
          // job. A malformed payload cannot improve on redelivery, so retrying would only
          // re-write the same FAILED twice more before the DLQ.
          try {
            if ((await readJudgeRunPermanent(db, data.run_id)).kind !== 'absent')
              await disposeJudgeRun(db, data.run_id, {
                reason: 'invalid_receipt',
                actorRef: 'judge:worker',
                evidenceRefs: [job.id],
                evidenceDigest: canonicalHash(data),
              });
            await writeTerminalJobEvent(db, {
              businessId: data.run_id,
              eventType: JUDGE_RUN_EVENTS.FAILED,
              payload: {
                reason: 'non_retryable',
                error_code: 'invalid_payload',
                retry_count: job.retryCount,
                retry_limit: job.retryLimit,
              },
            });
          } catch (writeErr) {
            // The terminal write is the whole point here — if it fails, fail the job so a
            // redelivery can retry it rather than leaving the run pending forever.
            console.error(
              '[judge_run] terminal FAILED write failed for malformed job',
              data.run_id,
              writeErr,
            );
            firstError ??= writeErr;
          }
          continue;
        }
        // No run_id ⇒ nothing to terminalize against. Fail the job so it reaches the DLQ.
        firstError ??= new Error(
          `judge_run job ${job.id} missing run_id — cannot terminalize; routing to the DLQ`,
        );
        continue;
      }
      try {
        if (
          data.caller === 'native_assessment' &&
          data.operational &&
          data.operational.delivery_id !== job.id
        )
          throw new JudgeReceiptConflict(
            'pg-boss delivery ID differs from retained workflow input',
          );
        const result = await runJudgeRun(
          db,
          data,
          { retryCount: job.retryCount, retryLimit: job.retryLimit, deliveryId: job.id },
          deps,
        );
        console.log(`[judge_run] ${data.run_id} -> ${result.status}`);
      } catch (err) {
        console.error(`[judge_run] ${data.run_id} threw — continuing the batch`, err);
        firstError ??= err;
      }
    }
    // Surface the failure AFTER draining so pg-boss still redelivers (retryable runs must
    // not be silently consumed), without letting one job strand its batch-mates.
    if (firstError !== null) throw firstError;
  };
}
