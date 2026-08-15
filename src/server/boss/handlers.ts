import { buildJudgeRunHandler } from '@/capabilities/practice/jobs/judge_run';
import type { PlacementVerificationAuthority } from '@/capabilities/practice/public';
import { JUDGE_RUN_QUEUE } from '@/capabilities/practice/server/judge-durable-config';
import type { Db } from '@/db/client';
import {
  EXPIRE_AGENT,
  EXPIRE_LLM,
  FAST_QUEUE_OPTS,
  createJobQueue,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';
import { buildBriefGenerator } from '@/server/memory/brief-writer';
import { registerMemoryHandlers } from '@/server/memory/triggers';
import type { PgBoss } from 'pg-boss';
import { buildEchoHandler } from './handlers/echo';
import { buildPromoteConversationIdleHandler } from './handlers/promote_conversation_idle';
import { buildPruneJobEventsHandler } from './handlers/prune_job_events';
import { buildPruneOrphanConversationSessionsHandler } from './handlers/prune_orphan_conversation_sessions';
import { buildPruneOrphanPlacementSessionsHandler } from './handlers/prune_orphan_placement_sessions';
import { buildPruneOrphanReviewSessionsHandler } from './handlers/prune_orphan_review_sessions';
import { buildSessionSummaryHandler } from './handlers/session_summary';
import {
  VERIFY_DISPATCH_RECOVERY_QUEUE,
  buildVerifyDispatchRecoveryHandler,
} from './verify-dispatch-outbox';

// M4-T3 (YUK-319)：本文件已渐缩为「未迁域 job 注册簿」。建队配方（YUK-237 三档
// expire/retention/DLQ + YUK-259 race 防护）抽到 queue-config.ts，与 capability
// jobs 注册器（register-capability-jobs.ts）共用。已迁入 manifest jobs 声明并由
// 注册器挂载的 job 不再出现在这里：knowledge 夜链、practice failure-learning、
// notes 的 hub_auto_sync_nightly + note_refine、agency
// 四 cron（dreaming/coach_daily/coach_weekly/goal_scope）。
//
// 仍留簿的注册（M5 拆除采石场时清账）：
//   - echo（golden E2E，0.5s polling）
//   - rejudge（非默认 1s polling + inline 动态 import，非工厂形态）
//   - prune_job_events / prune_orphan_* / promote_conversation_idle（FAST housekeeping cron）
//   - registerMemoryHandlers（memory_* 队列归 memory 模块）
//   - session_summary（链式 LLM）
//
// YUK-882 (F3.6c)：腾讯 OCR 提取与 auto-enroll 两条 job 已迁 ingestion
// manifest jobs 声明（含 0.5s polling + includeMetadata + lazy r2 的 worker
// 元数据），由注册器挂载；ingestion 域自此无留簿注册。

/**
 * Register pg-boss queue handlers + schedules for jobs NOT yet owned by a
 * capability manifest（渐缩簿）。
 *
 * 在 worker entrypoint 启动时调一次（start-worker.ts），随后必须紧跟
 * registerCapabilityJobs 挂载各包声明的 job。
 */
export async function registerHandlers(boss: PgBoss, db: Db): Promise<void> {
  // Step 4: echo golden E2E queue (FAST — trivial round-trip)
  await createOrUpdateQueue(boss, 'echo', FAST_QUEUE_OPTS);
  await boss.work('echo', { pollingIntervalSeconds: 0.5, batchSize: 1 }, buildEchoHandler(db));

  // M2 (YUK-316, D15) — 申诉自动重判。appeal API 投递（singletonKey=appeal
  // event id）；handler 本体在 practice capability 包，manifest 声明无 load
  // （注册形态是非默认 1s polling + inline 动态 import，非工厂，不走注册器
  // 统一配方）——注册留簿，M5 清账。
  await createJobQueue(boss, 'rejudge', EXPIRE_LLM);
  await boss.work('rejudge', { pollingIntervalSeconds: 1, batchSize: 1 }, async (jobs) => {
    const { handleRejudge } = await import('@/capabilities/practice/jobs/rejudge');
    for (const job of jobs) {
      await handleRejudge(db, job.data as { appeal_event_id: string });
    }
  });

  // YUK-594 (durable judge main path, W1) — durable judge_run queue（practice 域）。
  // handler 本体在 practice capability 包（jobs/judge_run.ts）；manifest 声明无 load
  // 纯归属（同 rejudge：注册形态要 includeMetadata:true 读 retryCount 驱动跨 provider
  // lane 决策，非注册器统一配方）。createJobQueue 挂 judge_run_dlq（LLM 档，1h expire，
  // JOB_RETRY_LIMIT×30-60s backoff → DLQ）。dark-ship：JUDGE_DURABLE_ENABLED 默认 OFF
  // 时无人投递此队列（submit 面走同步），队列空跑无害。
  await createJobQueue(boss, JUDGE_RUN_QUEUE, EXPIRE_LLM);
  await boss.work(
    JUDGE_RUN_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1, includeMetadata: true },
    buildJudgeRunHandler(db),
  );

  // Step 5: nightly housekeeping cron（同区段的 knowledge_propose_nightly 已迁
  // knowledge manifest jobs 声明，由注册器挂载）
  await createOrUpdateQueue(boss, 'prune_job_events', FAST_QUEUE_OPTS); // FAST — bulk DELETE housekeeping, re-runs next cron
  await boss.work('prune_job_events', buildPruneJobEventsHandler(db));
  await boss.schedule('prune_job_events', '0 4 * * *', {}, { tz: 'Asia/Shanghai' });

  // T-37 / YUK-185: Mem0 fact ingest + per-scope brief regen queues. Station 2A
  // injects the real brief writer (buildBriefGenerator) so the regen pipeline
  // produces memory_brief_note rows instead of falling back to the throwing
  // defaultGenerateBrief (triggers.ts). I-1: was a stale `YUK-37` comment — this
  // wiring is YUK-185 / T-37.
  await registerMemoryHandlers(boss, db, { generateBrief: buildBriefGenerator({ db }) });

  // ADR-0013: abandon review sessions stuck in 'started' >6h (sendBeacon
  // fallback when normal close didn't fire). BJT 04:15 after prune_job_events.
  await createOrUpdateQueue(boss, 'prune_orphan_review_sessions', FAST_QUEUE_OPTS); // FAST — cheap SELECT + per-row transition
  await boss.work('prune_orphan_review_sessions', buildPruneOrphanReviewSessionsHandler(db));
  await boss.schedule('prune_orphan_review_sessions', '15 4 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-470 (orphan-sweep leg): abandon placement probes stuck in 'started' >6h
  // (sibling of the review sweep; placement has no 'paused'). BJT 04:35 — the three
  // learning_session sweeps are staggered 04:15 (review) / 04:25 (conversation) /
  // 04:35 (placement) so they never hit the table on the same minute. Dark-ship
  // today (no probe created while PLACEMENT_PROBE_ENABLED=false) — lands ahead of go-live.
  await createOrUpdateQueue(boss, 'prune_orphan_placement_sessions', FAST_QUEUE_OPTS); // FAST — cheap SELECT + per-row transition
  await boss.work('prune_orphan_placement_sessions', buildPruneOrphanPlacementSessionsHandler(db));
  await boss.schedule('prune_orphan_placement_sessions', '35 4 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-14 (docs/design/2026-05-24-teaching-idle-state-machine.md): promote
  // active conversation sessions to 'idle' after 5min of no user input.
  // Runs every minute; cheap SELECT + per-row single-owner transition.
  await createOrUpdateQueue(boss, 'promote_conversation_idle', FAST_QUEUE_OPTS); // FAST — every-minute cheap SELECT
  await boss.work('promote_conversation_idle', buildPromoteConversationIdleHandler(db));
  await boss.schedule('promote_conversation_idle', '* * * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-14: abandon conversation sessions stuck in 'active'|'idle' >6h
  // (sendBeacon fallback). BJT 04:25, offset 10min from review prune to
  // avoid lock contention on learning_session.
  await createOrUpdateQueue(boss, 'prune_orphan_conversation_sessions', FAST_QUEUE_OPTS); // FAST — cheap SELECT + per-row transition
  await boss.work(
    'prune_orphan_conversation_sessions',
    buildPruneOrphanConversationSessionsHandler(db),
  );
  await boss.schedule(
    'prune_orphan_conversation_sessions',
    '25 4 * * *',
    {},
    { tz: 'Asia/Shanghai' },
  );

  // Phase 1d: SessionSummaryTask — enqueued by review-session completion
  // after a review session transitions to completed. async so the LLM call
  // doesn't block the close request.
  await createJobQueue(boss, 'session_summary', EXPIRE_LLM);
  await boss.work(
    'session_summary',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildSessionSummaryHandler(db),
  );

  // YUK-700 — startup + nightly safety net for drafts whose verify enqueue was
  // interrupted. Recovery reads durable per-question intents and enqueues ONLY
  // source_verify/quiz_verify; it never reruns sourcing or quiz_gen.
  const enqueueRecoveredVerify = async (
    verifier: 'quiz_verify' | 'source_verify',
    questionIds: string[],
    options?: object,
    placementAuthorities?: PlacementVerificationAuthority[],
  ) => {
    await boss.send(
      verifier,
      {
        question_ids: questionIds,
        ...(placementAuthorities?.length ? { placement_authorities: placementAuthorities } : {}),
      },
      options,
    );
  };
  await createOrUpdateQueue(boss, VERIFY_DISPATCH_RECOVERY_QUEUE, FAST_QUEUE_OPTS);
  await boss.work(
    VERIFY_DISPATCH_RECOVERY_QUEUE,
    buildVerifyDispatchRecoveryHandler(db, enqueueRecoveredVerify),
  );
  await boss.schedule(
    VERIFY_DISPATCH_RECOVERY_QUEUE,
    '10 4 * * *',
    {},
    {
      tz: 'Asia/Shanghai',
    },
  );
  await boss.send(
    VERIFY_DISPATCH_RECOVERY_QUEUE,
    { trigger: 'startup' },
    { singletonKey: 'verify-dispatch-startup' },
  );
}
