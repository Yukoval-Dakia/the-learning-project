// Import-free except queue names: admin-config-facts loads this in the API process, which must not reach
// handlers.ts and through it the worker-only paid Mem0 judge.
import { VERIFY_DISPATCH_RECOVERY_QUEUE } from './queue-names';

/**
 * handlers.ts 的 cron 只登记在这张表里。启动循环和 admin 读面投影同一张表，避免第二份手写清单。
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
