import type { PgBoss } from 'pg-boss';
import type { PlacementVerificationAuthority } from '@/capabilities/practice/public';
import type { Db } from '@/db/client';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';
import { fenceAwareJobHandler } from '@/server/contract-epoch';
import { buildBriefGenerator } from '@/server/memory/brief-writer';
import { registerMemoryHandlers } from '@/server/memory/triggers';
import { buildEchoHandler } from './handlers/echo';
import { buildPromoteConversationIdleHandler } from './handlers/promote_conversation_idle';
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
//   - verify_dispatch_recover（VERIFY_DISPATCH_RECOVERY_QUEUE，question-supply 安全网，只补发 verify）

/**
 * YUK-1007 — 本簿 cron 声明的**静态投影表**（单一真相源）：registerHandlers
 * 尾部从本表循环注册 boss.schedule，admin config 读面（schedules[] 的 infra
 * 行）也经组合根 facts seam 投影同一张表——两边不会漂移出第二份手工清单。
 * 仅收录本簿拥有的 cron；域 job 的 schedule 在各 capability manifest 声明。
 */
export interface InfraScheduleDeclaration {
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly queue: 'fast';
  readonly note?: string;
}

export const INFRA_HOUSEKEEPING_SCHEDULES: readonly InfraScheduleDeclaration[] = [
  {
    name: 'prune_orphan_review_sessions',
    cron: '15 4 * * *',
    tz: 'Asia/Shanghai',
    queue: 'fast',
    note: 'ADR-0013: abandon review sessions stuck in started >6h（BJT 04:15 after prune_job_events）',
  },
  {
    name: 'prune_orphan_placement_sessions',
    cron: '35 4 * * *',
    tz: 'Asia/Shanghai',
    queue: 'fast',
    note: 'YUK-470: abandon placement probes stuck in started >6h（BJT 04:35 stagger）',
  },
  {
    name: 'promote_conversation_idle',
    cron: '* * * * *',
    tz: 'Asia/Shanghai',
    queue: 'fast',
    note: "YUK-14: promote active conversation sessions to 'idle' after 5min idle",
  },
  {
    name: 'prune_orphan_conversation_sessions',
    cron: '25 4 * * *',
    tz: 'Asia/Shanghai',
    queue: 'fast',
    note: 'YUK-14: abandon conversation sessions stuck in active/idle >6h（BJT 04:25，与 review prune 错峰 10min）',
  },
  {
    // 队列名必须用 verify-dispatch-outbox 导出的常量（值为
    // 'verify_dispatch_recover'，无尾部 y）——手写字面量会撞 cron FK（CI
    // run 36557897314 的 RED：pg-boss 报 Queue verify_dispatch_recovery
    // not found，连锁拖死 worker-boot/verify-dispatch-recovery/extract 三面）。
    name: VERIFY_DISPATCH_RECOVERY_QUEUE,
    cron: '10 4 * * *',
    tz: 'Asia/Shanghai',
    queue: 'fast',
    note: 'YUK-700 nightly safety net：只补发 source_verify/quiz_verify，从不重跑 sourcing/quiz_gen（startup 触发在 start-worker）',
  },
];

/**
 * Register pg-boss queue handlers + schedules for infrastructure/housekeeping
 * queues only（域 job 走 capability manifest）。
 *
 * 在 worker entrypoint 启动时调一次（start-worker.ts），随后必须紧跟
 * registerCapabilityJobs 挂载各包声明的 job。
 */
export async function registerHandlers(boss: PgBoss, db: Db): Promise<void> {
  // YUK-1055 — 全部消费者套 per-delivery epoch fence：错过停机的活 worker 在
  // epoch 翻转后仍会被每个 delivery 拒跑（ContractEpochFenceError → 重投/DLQ）。
  // Step 4: echo golden E2E queue (FAST — trivial round-trip)
  await createOrUpdateQueue(boss, 'echo', FAST_QUEUE_OPTS);
  await boss.work(
    'echo',
    { pollingIntervalSeconds: 0.5, batchSize: 1 },
    fenceAwareJobHandler(db, 'echo', buildEchoHandler(db)),
  );

  // Step 5: nightly housekeeping cron（同区段的 knowledge_propose_nightly 已迁
  // knowledge manifest jobs 声明，由注册器挂载）
  // T-37 / YUK-185: Mem0 fact ingest + per-scope brief regen queues. Station 2A
  // injects the real brief writer (buildBriefGenerator) so the regen pipeline
  // produces memory_brief_note rows instead of falling back to the throwing
  // defaultGenerateBrief (triggers.ts). I-1: was a stale `YUK-37` comment — this
  // wiring is YUK-185 / T-37. 队列内的 per-delivery epoch fence 在
  // registerMemoryHandlers 内部挂（triggers.ts，与本簿同约定）。
  await registerMemoryHandlers(boss, db, { generateBrief: buildBriefGenerator({ db }) });

  // ADR-0013: abandon review sessions stuck in 'started' >6h (sendBeacon
  // fallback when normal close didn't fire). BJT 04:15 after prune_job_events.
  await createOrUpdateQueue(boss, 'prune_orphan_review_sessions', FAST_QUEUE_OPTS); // FAST — cheap SELECT + per-row transition
  await boss.work(
    'prune_orphan_review_sessions',
    fenceAwareJobHandler(
      db,
      'prune_orphan_review_sessions',
      buildPruneOrphanReviewSessionsHandler(db),
    ),
  );

  // YUK-470 (orphan-sweep leg): abandon placement probes stuck in 'started' >6h
  // (sibling of the review sweep; placement has no 'paused'). BJT 04:35 — the three
  // learning_session sweeps are staggered 04:15 (review) / 04:25 (conversation) /
  // 04:35 (placement) so they never hit the table on the same minute. Dark-ship
  // today (no probe created while PLACEMENT_PROBE_ENABLED=false) — lands ahead of go-live.
  await createOrUpdateQueue(boss, 'prune_orphan_placement_sessions', FAST_QUEUE_OPTS); // FAST — cheap SELECT + per-row transition
  await boss.work(
    'prune_orphan_placement_sessions',
    fenceAwareJobHandler(
      db,
      'prune_orphan_placement_sessions',
      buildPruneOrphanPlacementSessionsHandler(db),
    ),
  );

  // YUK-14 (docs/design/2026-05-24-teaching-idle-state-machine.md): promote
  // active conversation sessions to 'idle' after 5min of no user input.
  // Runs every minute; cheap SELECT + per-row single-owner transition.
  await createOrUpdateQueue(boss, 'promote_conversation_idle', FAST_QUEUE_OPTS); // FAST — every-minute cheap SELECT
  await boss.work(
    'promote_conversation_idle',
    fenceAwareJobHandler(db, 'promote_conversation_idle', buildPromoteConversationIdleHandler(db)),
  );

  // YUK-14: abandon conversation sessions stuck in 'active'|'idle' >6h
  // (sendBeacon fallback). BJT 04:25, offset 10min from review prune to
  // avoid lock contention on learning_session.
  await createOrUpdateQueue(boss, 'prune_orphan_conversation_sessions', FAST_QUEUE_OPTS); // FAST — cheap SELECT + per-row transition
  await boss.work(
    'prune_orphan_conversation_sessions',
    fenceAwareJobHandler(
      db,
      'prune_orphan_conversation_sessions',
      buildPruneOrphanConversationSessionsHandler(db),
    ),
  );

  // YUK-700 — startup + nightly safety net for drafts whose verify enqueue was
  // interrupted. Recovery reads durable per-question intents and enqueues ONLY
  // source_verify/quiz_verify; it never reruns sourcing or quiz_gen.
  //
  // YUK-891: the STARTUP trigger no longer fires here. This worker starts
  // polling the moment boss.work returns, while the practice-owned
  // quiz_verify / source_verify queues are only created later by
  // registerCapabilityJobs (YUK-868 moved them into the practice manifest), so
  // a trigger fired at this point races the registrar and the first recovery
  // execution sends into a missing queue. start-worker fires
  // sendVerifyDispatchStartupRecovery() after capability registration; the
  // nightly cron schedule stays here. Both triggers use the same payload-agnostic,
  // idempotent recovery handler; every completed boot deliberately enqueues one pass.
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
    fenceAwareJobHandler(
      db,
      VERIFY_DISPATCH_RECOVERY_QUEUE,
      buildVerifyDispatchRecoveryHandler(db, enqueueRecoveredVerify),
    ),
  );

  // YUK-1007：cron 注册从 INFRA_HOUSEKEEPING_SCHEDULES 静态表循环驱动（单一
  // 真相源——上表即读面投影的同一份声明，队列名一律取各导出常量）。
  //
  // 诚实说明（P2，保留现状不改）：相对旧的逐点内联注册，本循环把全部 cron
  // 注册后移到 registerHandlers 末尾——若某个中途步骤 throw，失败前已启动的
  // consumer 数量/时序与旧实现不同（旧行为：prune_job_events 的 cron 在早期
  // 已挂）。验证审裁定为 P2 默认不在本 PR 改；启动尾部完整行为由 worker-boot
  // （YUK-980）与 QA 独立覆盖。
  for (const decl of INFRA_HOUSEKEEPING_SCHEDULES) {
    await boss.schedule(decl.name, decl.cron, {}, { tz: decl.tz });
  }
}
