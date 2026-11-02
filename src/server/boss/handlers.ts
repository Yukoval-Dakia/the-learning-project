import type { PgBoss } from 'pg-boss';
import type { PlacementVerificationAuthority } from '@/capabilities/practice/public';
import type { Db } from '@/db/client';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';
import { fenceAwareJobHandler } from '@/server/contract-epoch';
import { buildEchoHandler } from './handlers/echo';
import { buildPromoteConversationIdleHandler } from './handlers/promote_conversation_idle';
import { INFRA_HOUSEKEEPING_SCHEDULES } from './infra-schedules';
import { registerMemoryHandlers } from './memory-queues';
import { VERIFY_DISPATCH_RECOVERY_QUEUE } from './queue-names';
import { buildVerifyDispatchRecoveryHandler } from './verify-dispatch-recovery';

// 只挂基础设施。域 job 在各 capability manifest，经 register-capability-jobs 挂载，不要迁回这里。
// 留在这里的是 echo、会话空闲、Agency 记忆管线自己的队列（memory-queues.ts），以及校验补发。
// 建队配方在 queue-config.ts。

/**
 * 基础设施队列。start-worker 在这之后才调用 registerCapabilityJobs。
 */
export async function registerHandlers(boss: PgBoss, db: Db): Promise<void> {
  // 每个 delivery 都过 epoch fence。echo 和空闲晋升是 drain，活跃 marker 不挑 epoch。
  // 校验补发是 translate，出生 epoch 不对就拒。这些队列没有死信，拒跑按 fast 重试。
  await createOrUpdateQueue(boss, 'echo', FAST_QUEUE_OPTS);
  await boss.work(
    'echo',
    { pollingIntervalSeconds: 0.5, batchSize: 1 },
    fenceAwareJobHandler(db, 'echo', buildEchoHandler(db)),
  );

  // brief writer、付费判官与 fence 都在 registerMemoryHandlers 里面装配。
  await registerMemoryHandlers(boss, db);

  await createOrUpdateQueue(boss, 'promote_conversation_idle', FAST_QUEUE_OPTS);
  await boss.work(
    'promote_conversation_idle',
    fenceAwareJobHandler(db, 'promote_conversation_idle', buildPromoteConversationIdleHandler(db)),
  );

  // 这里只挂消费者和夜间 cron。启动补发要等 registerCapabilityJobs 建好校验队列，
  // 否则第一次 send 会打到还不存在的队列，排空推迟到夜间。补发只入校验队，不重跑出题。
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

  // schedule 在消费者都挂上之后才登记。中途抛错时，这些 cron 不会补上。
  for (const decl of INFRA_HOUSEKEEPING_SCHEDULES) {
    await boss.schedule(decl.name, decl.cron, {}, { tz: decl.tz });
  }
}
