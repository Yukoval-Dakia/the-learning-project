// YUK-594 (durable judge main path, W1) — durable judge_run pg-boss handler。
//
// 把练习判分从同步 HTTP 面（submit.ts 的 judgeSubmit inline invoke）桥到异步
// durable pg-boss 面：submit dispatch（JUDGE_DURABLE_ENABLED=1）→ 写 attempt/outcome
// 占位（run_id）+ boss.send('judge_run') → 本 handler 在 worker 进程判分 → 回填事务
// 原子写 review event(id=run_id) + 独立 judge event + FSRS/θ̂/snapshot/family/calibration
// （复用 submit.ts 的 persistSubmit，零漂移）+ 终态 job_event 携判词，SSE/poll 消费。
//
// 蓝本：copilot_run.ts（YUK-575 durable copilot）。差别：judge 是单次无状态 LLM 调用
// （无对话记忆/工具循环/取消语义），故 handler 远薄；且 judge 需要 pg-boss redelivery
// 做 transient 层（endpoint-down 兜底），故失败 rethrow 触发重投，最后一次重投切
// 跨 provider lane（D7/D9）。run handle = run_id = job_events business_id（W2 submit 面：
// run_id = 该次作答 attempt/outcome event id；其它面 W3 各自定锚，不写死为通用契约）。
//
// D5：profile 在 enqueue 时冻结进 payload（reflect 作答当下画像，不重解析）。
// D7：in-process transient retry 对本 durable handler 保持 OFF（durable:{}→invoker
//   强制 enableTransientRetry:false）；queue redelivery 是唯一 transient 层，worst-case
//   付费调用 = 1 + JOB_RETRY_LIMIT。

import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';
import { SubjectProfileSchema } from '@/subjects/profile';
import { and, eq } from 'drizzle-orm';
import type { JobWithMetadata } from 'pg-boss';
import { ZodError } from 'zod';
import { CreateAttemptBodySchema } from '../api/contracts';
import { normalizeReviewSubmitActivityRef } from '../server/activity-ref';
import { resolveDurableProviderOverride } from '../server/judge-durable-config';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from '../server/judge-run-status';

/**
 * judge_run job 体。submit 面投递（submit.ts enqueueDurableJudge）。`caller` 标面
 * （W2=submit only；W3 加 probe/paper/advice/solve）。`submit` 携冻结的 submit 输入
 * （D5：profile 冻结）；其它面 W3 各自定 payload 分支，不复用 submit 的字段形。
 */
export interface JudgeRunJobData {
  /**
   * run handle + job_events business_id。**W2 submit 面**：= 该次作答 attempt/outcome
   * event id（persistSubmit 以它做 eventId，见 opts.attemptEventId）。此「= attempt
   * event id」契约是 submit 面特化，不对全部面通用（advice 面无 event，W3 另定）。
   */
  run_id: string;
  /** 发起面（回填路由 + payload 分支判别）。W2 只有 'submit'。 */
  caller: 'submit';
  /** submit 面冻结输入（D5：profile 冻结进 payload，作答当下画像）。 */
  submit: {
    /** 冻结的 CreateAttemptBody（JSON）。worker 侧 CreateAttemptBodySchema 复校。 */
    body: unknown;
    question_id: string;
    /** D5 — enqueue 时冻结的 SubjectProfile（JSON）。worker 侧 SubjectProfileSchema 复校。 */
    subject_profile: unknown;
    /** 作答时刻（ISO）——FSRS 调度锚定作答当下，非 worker 拾取时刻。 */
    submitted_at: string;
  };
}

export type JudgeRunOutcome =
  | { status: 'done'; run_id: string; coarse_outcome: string; judge_event_id: string | null }
  | { status: 'skipped'; run_id: string; reason: string }
  | { status: 'failed'; run_id: string; error: string };

export interface JudgeRunDeps {
  /** test seam — 默认动态 import submit.ts 的 judgeSubmit（durable 复用同步面判分头）。 */
  judgeSubmitFn?: typeof import('../api/submit')['judgeSubmit'];
  /** test seam — 默认动态 import submit.ts 的 persistSubmit（durable 复用同步面回填体）。 */
  persistSubmitFn?: typeof import('../api/submit')['persistSubmit'];
}

/** pg-boss 投递的 job metadata（retryCount/retryLimit 驱动跨 provider lane 决策）。 */
export interface JudgeRunJobMeta {
  retryCount: number;
  retryLimit: number;
}

export async function runJudgeRun(
  db: Db,
  data: JudgeRunJobData,
  meta: JudgeRunJobMeta,
  deps: JudgeRunDeps = {},
): Promise<JudgeRunOutcome> {
  const runId = data.run_id;

  // ── 幂等守卫 ────────────────────────────────────────────────────────────
  // 回填事务已 commit（attempt event id=run_id 已写）但终态 job_event 写前 worker
  // 崩溃 → pg-boss redeliver。此时重跑 persistSubmit 会因 event PK=run_id 冲突炸，
  // 且会重复判分/双写 FSRS。守卫：attempt event 已存在 → 回填已发生，best-effort
  // 补写 DONE 终态（补 SSE/poll 消费）+ 早返，绝不重判重写。
  const priorAttempt = await db
    .select({ id: event.id })
    .from(event)
    .where(eq(event.id, runId))
    .limit(1);
  if (priorAttempt.length > 0) {
    // The backfill committed. If a terminal DONE already landed (crash AFTER the
    // DONE write), do NOT write another — a slim {already_persisted} DONE would
    // become the last DONE and terminalJudgeRunResult would drop the real verdict
    // (poll/SSE would lose coarse_outcome/feedback). Only when NO DONE exists
    // (crash between the persist commit and the DONE write) do we reconstruct the
    // FULL verdict from the persisted judge event so recovery gets the real verdict.
    const priorEvents = await computeReplay(db, {
      businessTable: JUDGE_RUN_TABLE,
      businessId: runId,
      lastEventId: 0,
    });
    const hasDone = priorEvents.some((e) => e.event_type === JUDGE_RUN_EVENTS.DONE);
    if (!hasDone) {
      // #2 — MUST throw on failure (NOT best-effort): if this reconstruct write fails
      // and we swallow it, the run stays persisted-but-terminal-less → poll/SSE sit
      // pending forever. A throw here propagates out → pg-boss redelivers → this same
      // guard retries the reconstruct until it lands (or DLQ surfaces it).
      await writeTerminalJobEvent(db, {
        businessId: runId,
        eventType: JUDGE_RUN_EVENTS.DONE,
        payload: await reconstructDonePayloadFromJudgeEvent(db, runId),
      });
    }
    return { status: 'skipped', run_id: runId, reason: 'already_persisted' };
  }

  // started 心跳——消费者据此把 status 从 queued 推到 started。非终态进度信号，
  // best-effort（丢一条心跳不影响正确性；terminal DONE/FAILED 才是承重）。
  await bestEffortWriteJobEvent(db, {
    businessId: runId,
    eventType: JUDGE_RUN_EVENTS.STARTED,
    payload: { caller: data.caller, retry_count: meta.retryCount },
  });

  // #2 — tracks whether the backfill tx COMMITTED. If it did but the terminal DONE
  // write then fails, we must rethrow (not write a misleading FAILED) so pg-boss
  // redelivers and the idempotency guard reconstructs the real DONE.
  let persistedOk = false;
  try {
    if (data.caller !== 'submit') {
      // W2 只支持 submit 面；其它面 W3 落地。收到未知面 → 不重投（rethrow 只会
      // 3 次重跑同样失败），写终态 FAILED 后早返（deriveJudgeRunStatus → failed）。
      throw new NonRetryableJudgeRunError(`unsupported judge_run caller '${data.caller}'`);
    }

    const judgeSubmit = deps.judgeSubmitFn ?? (await import('../api/submit')).judgeSubmit;
    const persistSubmit = deps.persistSubmitFn ?? (await import('../api/submit')).persistSubmit;

    // 重建 ValidatedSubmit（body 复校、profile 用冻结值 D5、now=作答时刻）。question
    // row 由 persistSubmit/judgeSubmit 侧按 id 现读（题面近不可变；D5 只钉 profile）。
    const body = CreateAttemptBodySchema.parse(data.submit.body);
    const subjectProfile = SubjectProfileSchema.parse(data.submit.subject_profile);
    const now = new Date(data.submit.submitted_at);
    // An unparseable submitted_at yields an Invalid Date whose getTime() is NaN;
    // feeding it into FSRS scheduling (the attempt anchor) corrupts the schedule.
    // A malformed payload is a permanent defect, NOT a transient failure → don't
    // burn re-deliveries on it (classified non-retryable below like the Zod parses).
    if (Number.isNaN(now.getTime())) {
      throw new NonRetryableJudgeRunError(
        `judge_run ${runId} has an invalid submitted_at '${data.submit.submitted_at}'`,
      );
    }
    const questionId = data.submit.question_id;
    const q = await loadQuestionRow(db, questionId);
    if (!q) {
      throw new NonRetryableJudgeRunError(
        `question ${questionId} not found for judge_run ${runId}`,
      );
    }
    const activityRef = normalizeReviewSubmitActivityRef(body).activity_ref;
    const validated = { body, now, questionId, activityRef, q };

    // 跨 provider lane 决策（D7/D9）：仅最后一次重投切 fallback provider（有界）。
    const providerOverride = resolveDurableProviderOverride({
      retryCount: meta.retryCount,
      retryLimit: meta.retryLimit,
    });

    // 判分（复用同步面 judgeSubmit 头：photo-only gate + invoke + rating 解析）。
    // durable:{}→invoker 强制 enableTransientRetry:false（D7）+ 末次重投切 provider（D9）。
    // 冻结 profile（D5）直接注入，不重解析（避免 enqueue↔pickup 间画像编辑漂移）。
    //
    // #5 rate-limit 语义（承重）：checkRateLimit 是**进程内**单例，且 worker 与 API 是
    // 独立进程——worker 侧不会命中 API 侧的窗口。这是**故意**的：judge_run 的唯一入队
    // 源是 submit 的 enqueueDurableJudge，那里已 checkRateLimit（入队即已限流）；worker
    // 只是消费已受限的队列，付费上限由 pg-boss 重投预算（1+JOB_RETRY_LIMIT）界定，不做
    // 二次限流（skipRateLimit:true）。**W3 注意**：若将来新增非入队来源（manual
    // re-enqueue / rejudge-style），必须让其经同一 rate-limited 入队面，或在 worker 侧
    // 加一道粗杆闸——否则那条路径的付费调用不受控。
    const judged = await judgeSubmit(validated, {
      subjectProfile,
      skipRateLimit: true,
      durable: { ...(providerOverride ? { providerOverride } : {}) },
    });

    // 回填事务（复用同步面 persistSubmit：review event(id=run_id) + judge event +
    // FSRS/θ̂/snapshot/family/calibration 原子 tx + post-commit 信号）。attemptEventId=
    // run_id 让 attempt event id 与 run handle 对齐（幂等守卫据它跳重投）。
    const persisted = await persistSubmit(validated, judged, { attemptEventId: runId });
    persistedOk = true;

    // 终态 DONE，携判词（JudgeResultV2 + telemetry + lane provenance）供 SSE/poll 回填。
    // #2 — MUST throw on failure (writeTerminalJobEvent, not best-effort): swallowing a
    // failed DONE write leaves the run persisted-but-pending forever. On a throw the
    // catch sees persistedOk=true and rethrows for redelivery (→ guard reconstructs DONE).
    await writeTerminalJobEvent(db, {
      businessId: runId,
      eventType: JUDGE_RUN_EVENTS.DONE,
      payload: {
        attempt_event_id: runId,
        judge_event_id: persisted.judgeEventId,
        outcome: persisted.outcome,
        final_rating: judged.finalRating,
        route: judged.judgeRoute,
        ...(judged.judgeResult
          ? {
              coarse_outcome: judged.judgeResult.coarse_outcome,
              score: judged.judgeResult.score,
              confidence: judged.judgeResult.confidence,
              feedback_md: judged.judgeResult.feedback_md,
              capability_ref: judged.judgeResult.capability_ref,
            }
          : {}),
        ...(judged.judgeTelemetry ? { telemetry: judged.judgeTelemetry } : {}),
        // YUK-573 lane provenance — 记本次真正产判词的 provider lane（跨 provider 兜底
        // 后 lane 非固定；calibration same_lane 推断读它）。
        provider_override: providerOverride ?? null,
      },
    });

    return {
      status: 'done',
      run_id: runId,
      coarse_outcome: judged.judgeResult?.coarse_outcome ?? 'unsupported',
      judge_event_id: persisted.judgeEventId,
    };
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
    // A malformed job payload (Zod parse of body/profile, or an invalid date) is a
    // permanent defect: re-delivery would just re-fail identically and waste the
    // retry budget. Classify ZodError as non-retryable alongside our explicit marker.
    const nonRetryable = err instanceof NonRetryableJudgeRunError || err instanceof ZodError;
    // 失败痕迹（coordinator note#1）：显式写终态 FAILED job_event，保证 replay/UI 不
    // 悬空。deriveJudgeRunStatus last-writer-wins：transient 失败先显 failed，成功重投
    // 写 DONE 翻回 done。非 retryable（未知面/题缺失/坏 payload）不重投——写 FAILED 后早返。
    await bestEffortWriteJobEvent(db, {
      businessId: runId,
      eventType: JUDGE_RUN_EVENTS.FAILED,
      payload: {
        reason: nonRetryable ? 'non_retryable' : 'error',
        error: message,
        retry_count: meta.retryCount,
        retry_limit: meta.retryLimit,
      },
    });
    if (nonRetryable) {
      return { status: 'failed', run_id: runId, error: message };
    }
    // rethrow → pg-boss 按策略重投（JOB_RETRY_LIMIT=2，30s→60s backoff），耗尽进
    // judge_run_dlq（handlers.ts createJobQueue 挂 DLQ）。上面已写 FAILED 终态痕迹。
    throw err;
  }
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
    await writeJobEvent(db, {
      business_table: JUDGE_RUN_TABLE,
      business_id: args.businessId,
      event_type: args.eventType,
      payload: args.payload,
    });
  } catch (err) {
    console.error(`[judge_run] ${args.eventType} write failed for`, args.businessId, err);
  }
}

/**
 * #2 — terminal job_event 写，**故意不吞错**（与 bestEffort 相反）。一个失败的终态写
 * 会让 run 卡在无终态（poll/SSE 永远 pending），故 throw 让上游触发 redelivery →
 * 幂等守卫重建 DONE。用于 happy-path DONE + already_persisted 恢复 DONE 两处。
 */
async function writeTerminalJobEvent(
  db: Db,
  args: { businessId: string; eventType: string; payload: Record<string, unknown> },
): Promise<void> {
  await writeJobEvent(db, {
    business_table: JUDGE_RUN_TABLE,
    business_id: args.businessId,
    event_type: args.eventType,
    payload: args.payload,
  });
}

async function loadQuestionRow(db: Db, questionId: string) {
  const rows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Reconstruct the terminal DONE payload from the persisted judge event when the
 * backfill committed but the DONE job_event never landed (crash between commit and
 * the terminal write). Reads the real verdict (coarse_outcome/score/feedback_md/
 * capability_ref/route) off the judge event chained to the attempt (subject_id=run_id)
 * so poll/SSE recovery gets the actual verdict, not a slim placeholder.
 */
async function reconstructDonePayloadFromJudgeEvent(
  db: Db,
  runId: string,
): Promise<Record<string, unknown>> {
  const [je] = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'judge'), eq(event.subject_id, runId)))
    .limit(1);
  const p = (je?.payload ?? {}) as Record<string, unknown>;
  return {
    attempt_event_id: runId,
    judge_event_id: je?.id ?? null,
    already_persisted: true,
    ...(typeof p.coarse_outcome === 'string' ? { coarse_outcome: p.coarse_outcome } : {}),
    ...(p.score != null ? { score: p.score } : {}),
    ...(typeof p.feedback_md === 'string' ? { feedback_md: p.feedback_md } : {}),
    ...(p.capability_ref ? { capability_ref: p.capability_ref } : {}),
    ...(typeof p.judge_route === 'string' ? { route: p.judge_route } : {}),
  };
}

/** 判定为不可重投的失败（未知面 / 题缺失 / body 复校失败）——写 FAILED 后不 rethrow。 */
export class NonRetryableJudgeRunError extends Error {
  override name = 'NonRetryableJudgeRunError';
}

/**
 * pg-boss handler 工厂。register 在 handlers.ts（渐缩簿）以 includeMetadata:true 注册，
 * 故 jobs 是 JobWithMetadata（带 retryCount/retryLimit，驱动跨 provider lane 决策）。
 * batchSize:1 → 串行一次一 run。
 */
export function buildJudgeRunHandler(
  db: Db,
): (jobs: JobWithMetadata<JudgeRunJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data;
      if (!data?.run_id || !data?.caller || !data?.submit) {
        console.warn('[judge_run] job missing run_id/caller/submit', job.id);
        continue;
      }
      const result = await runJudgeRun(db, data, {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
      console.log(`[judge_run] ${data.run_id} -> ${result.status}`);
    }
  };
}
