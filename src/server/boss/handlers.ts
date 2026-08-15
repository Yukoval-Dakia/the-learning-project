import type { PlacementVerificationAuthority } from '@/capabilities/practice/public';
import type { Db } from '@/db/client';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';
import { buildBriefGenerator } from '@/server/memory/brief-writer';
import { registerMemoryHandlers } from '@/server/memory/triggers';
import type { PgBoss } from 'pg-boss';
import { buildEchoHandler } from './handlers/echo';
import { buildPromoteConversationIdleHandler } from './handlers/promote_conversation_idle';
import { buildPruneJobEventsHandler } from './handlers/prune_job_events';
import { buildPruneOrphanConversationSessionsHandler } from './handlers/prune_orphan_conversation_sessions';
import { buildPruneOrphanPlacementSessionsHandler } from './handlers/prune_orphan_placement_sessions';
import { buildPruneOrphanReviewSessionsHandler } from './handlers/prune_orphan_review_sessions';
import {
  VERIFY_DISPATCH_RECOVERY_QUEUE,
  buildVerifyDispatchRecoveryHandler,
} from './verify-dispatch-outbox';

// YUK-885 (F3.11)：本文件现在只注册 infrastructure/housekeeping——域 job 全部
// 由 capability manifest jobs 声明、register-capability-jobs.ts 挂载。建队配方
// （YUK-237 三档 expire/retention/DLQ + YUK-259 race 防护）在 queue-config.ts，
// 与 capability jobs 注册器共用。域 job 注册（knowledge 夜链、practice
// failure-learning / 判分链、notes 夜链、agency cron、ingestion OCR 链）
// 已全部迁入各 capability manifest，一律不得回迁本簿。
//
// 留簿注册 = 纯基础设施：
//   - echo（golden E2E，0.5s polling）
//   - prune_job_events / prune_orphan_* / promote_conversation_idle（FAST housekeeping cron）
//   - registerMemoryHandlers（memory_* 队列归 memory 模块）
//   - verify_dispatch_recovery（question-supply 安全网，读 durable intents 只补发 verify）

/**
 * Register pg-boss queue handlers + schedules for infrastructure/housekeeping
 * queues only（域 job 走 capability manifest）。
 *
 * 在 worker entrypoint 启动时调一次（start-worker.ts），随后必须紧跟
 * registerCapabilityJobs 挂载各包声明的 job。
 */
export async function registerHandlers(boss: PgBoss, db: Db): Promise<void> {
  // Step 4: echo golden E2E queue (FAST — trivial round-trip)
  await createOrUpdateQueue(boss, 'echo', FAST_QUEUE_OPTS);
  await boss.work('echo', { pollingIntervalSeconds: 0.5, batchSize: 1 }, buildEchoHandler(db));

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
