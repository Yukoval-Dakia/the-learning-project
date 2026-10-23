import type { PgBoss } from 'pg-boss';
import type { PlacementVerificationAuthority } from '@/capabilities/practice/public';
import type { Db } from '@/db/client';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';
import { fenceAwareJobHandler } from '@/server/contract-epoch';
import { buildBriefGenerator } from '@/server/memory/brief-writer';
import { registerMemoryHandlers } from '@/server/memory/triggers';
import { buildEchoHandler } from './handlers/echo';
import { buildPromoteConversationIdleHandler } from './handlers/promote_conversation_idle';
import {
  VERIFY_DISPATCH_RECOVERY_QUEUE,
  buildVerifyDispatchRecoveryHandler,
} from './verify-dispatch-recovery';

// 只挂基础设施。域 job 在各 capability manifest，经 register-capability-jobs 挂载，不要迁回这里。
// 留在这里的是 echo、会话空闲、memory 模块自己的队列，以及校验补发。
// 建队配方在 queue-config.ts。

/**
 * 本文件的 cron 只登记在这张表里。启动循环和 admin 读面投影同一张表，避免第二份手写清单。
 * 域 job 的 schedule 在各自的 manifest。
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
    name: 'promote_conversation_idle',
    cron: '* * * * *',
    tz: 'Asia/Shanghai',
    queue: 'fast',
    note: "YUK-14: promote active conversation sessions to 'idle' after 5min idle",
  },
  {
    // 队列名用导出常量。手写 verify_dispatch_recovery 会让 cron 指向一个不存在的队列。
    name: VERIFY_DISPATCH_RECOVERY_QUEUE,
    cron: '10 4 * * *',
    tz: 'Asia/Shanghai',
    queue: 'fast',
    note: 'YUK-700 nightly safety net：只补发 source_verify/quiz_verify，从不重跑 sourcing/quiz_gen（startup 触发在 start-worker）',
  },
];

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

  // 不传 writer 时，brief 重算会落到会抛错的默认实现。fence 在 registerMemoryHandlers 里面。
  await registerMemoryHandlers(boss, db, { generateBrief: buildBriefGenerator({ db }) });

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
