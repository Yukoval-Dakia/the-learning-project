// YUK-778 ① — ORCHESTRATOR_QUEUE 的重试策略 / DLQ，**用真 pg-boss 验**。
//
// 为什么必须是真 pg-boss 而不是 fake：本项要证明的命题是「配置真的生效」，而生效与否
// 完全发生在 pg-boss 内部——`createQueue` 是 `INSERT ... ON CONFLICT DO NOTHING` 的
// plpgsql，未给的字段一律落到 `QUEUE_DEFAULTS`（v12.26.1 plans.js:45-54：retry_limit 2 /
// retry_delay 0 / retry_backoff false / dead_letter NULL）。拿 fake boss 断言「我们传了
// retryDelay: 30」只证明了我们**调用**时的参数，证明不了那个值落进了 `pgboss.queue` 行，
// 更证明不了它会被复制到每条 job 上。二者之间隔着 pg-boss 的 SQL——正是本票要修的地方。
//
// 三条命题，逐级更接近运行期事实：
//  ① 队列行本身带上了策略（读回 pgboss.queue）；
//  ② **每条真 job** 继承了它（读回 pgboss.job —— 这是 tick 失败时真正生效的那份配置）；
//  ③ 终态失败的 job 真的落进了 DLQ（残骸可查，本票 DLQ 一半的全部意义）。
//
// 三条都跑在**升级路径**上：beforeAll 先把队列种成 YUK-758 的旧形态再调
// `ensureOrchestratorQueues`，因为生产库上这个队列早就存在，新配置只能靠 `updateQueue`
// 覆盖上去（详见 beforeAll 内的注释）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgBoss } from 'pg-boss';

import { _resetBossForTests, getStartedBoss } from '@/server/boss/client';
import {
  FAST_QUEUE_OPTS,
  JOB_RETRY_DELAY_SECONDS,
  JOB_RETRY_LIMIT,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';
import { ORCHESTRATOR_DLQ, ORCHESTRATOR_QUEUE } from './constants';
import { ensureOrchestratorQueues } from './register';

let boss: PgBoss;

beforeAll(async () => {
  _resetBossForTests();
  boss = await getStartedBoss();

  // **升级路径，不是全新库**（YUK-778 独立评审 MINOR）。唯一真正重要的那个数据库——跑着
  // YUK-758 的生产 compose——上面 `nightly_orchestrator` **已经存在**，且带着旧配置
  // （retry_delay 0 / dead_letter NULL）。pg-boss 的 `createQueue` 是 `INSERT … ON CONFLICT
  // DO NOTHING`，对已存在的队列**什么都不改**；新配置全靠随后的 `updateQueue` 落地
  // （createOrUpdateQueue 的存在理由，见 queue-config.ts 的 docblock）。只测全新建队会让
  // 「生产升级后到底有没有生效」这个唯一要紧的问题完全没被覆盖，故先把队列种成旧形态。
  await createOrUpdateQueue(boss, ORCHESTRATOR_QUEUE, FAST_QUEUE_OPTS);
  const legacy = await boss.getQueue(ORCHESTRATOR_QUEUE);
  // 前置断言：确认种出来的确实是**旧**形态，否则下面全部测试退化成自证。
  expect(legacy?.retryDelay).toBe(0);
  expect(legacy?.retryBackoff).toBe(false);
  expect(legacy?.deadLetter ?? null).toBeNull();

  await ensureOrchestratorQueues(boss);
});

afterAll(async () => {
  await boss.stop({ graceful: false, timeout: 1_000 });
  _resetBossForTests();
});

describe('YUK-778 ① the orchestrator queue no longer inherits the bare pg-boss defaults', () => {
  it('creates the dead-letter queue and points the orchestrator queue at it', async () => {
    // The DLQ must EXIST, not merely be named: `queue.dead_letter` is a FK to `queue(name)`
    // (plans.js:131) and createQueue resolves it through getQueueCache (manager.js:1382),
    // so a wrong creation ORDER fails loudly here rather than silently at 02:30.
    expect(await boss.getQueue(ORCHESTRATOR_DLQ)).not.toBeNull();

    const queue = await boss.getQueue(ORCHESTRATOR_QUEUE);
    expect(queue).not.toBeNull();
    expect(queue?.deadLetter).toBe(ORCHESTRATOR_DLQ);
  });

  it('persists a non-zero retry delay onto the queue row', async () => {
    const queue = await boss.getQueue(ORCHESTRATOR_QUEUE);

    // The counterfactual FIRST: pg-boss's QUEUE_DEFAULTS.retry_delay is 0, which is what this
    // queue had before. Pinning "not the default" separately from "the value we chose" means a
    // future edit that drops the retry policy fails on a sentence an operator can read.
    expect(
      queue?.retryDelay,
      'the tick queue must not fall back to pg-boss QUEUE_DEFAULTS.retry_delay = 0 — three attempts would burn back-to-back within seconds of the same outage',
    ).toBeGreaterThan(0);
    expect(queue?.retryDelay).toBe(JOB_RETRY_DELAY_SECONDS);
    expect(queue?.retryBackoff).toBe(true);
    // retryLimit stays at pg-boss's implicit 2 on purpose — declaring it is a zero-count
    // change (queue-config.ts YUK-576), so this asserts intent, not a delta.
    expect(queue?.retryLimit).toBe(JOB_RETRY_LIMIT);
  });

  it('copies that policy onto an actual job — the config a failing tick really runs under', async () => {
    const jobId = await boss.send(ORCHESTRATOR_QUEUE, { probe: 'yuk778' });
    expect(jobId).not.toBeNull();

    // pgboss.job carries its own retry_delay / dead_letter columns, snapshotted from the queue
    // at INSERT time (plans.js:1474 `COALESCE("deadLetter", q.dead_letter)`). A queue row that
    // looks right but does not propagate would leave the tick running on the old policy.
    const job = await boss.getJobById(ORCHESTRATOR_QUEUE, jobId as string);
    expect(job?.retryDelay).toBe(JOB_RETRY_DELAY_SECONDS);
    expect(job?.retryBackoff).toBe(true);
    expect(job?.retryLimit).toBe(JOB_RETRY_LIMIT);
    expect(job?.deadLetter).toBe(ORCHESTRATOR_DLQ);
  });

  it('routes a job that exhausts its retries into the dead-letter queue', async () => {
    // retryLimit is overridden PER JOB (0) purely to skip the 30s retry wait this PR just
    // introduced — the queue-level delay is asserted above. Everything being tested here
    // (dead_letter wiring, the DLQ insert) still comes from the QUEUE config.
    const jobId = (await boss.send(
      ORCHESTRATOR_QUEUE,
      { probe: 'yuk778-dlq' },
      { retryLimit: 0 },
    )) as string;
    // Batch-fetch and select by id: an earlier case in this file leaves its own probe job on
    // the queue, and pg-boss hands out the oldest first. Pinning `fetch()[0]` would make this
    // case depend on execution order rather than on what it claims to test.
    const fetched = await boss.fetch(ORCHESTRATOR_QUEUE, { batchSize: 10 });
    expect(fetched.map((j) => j.id)).toContain(jobId);

    await boss.fail(ORCHESTRATOR_QUEUE, jobId, { reason: 'simulated exhausted tick' });

    // Before this PR the exhausted job simply vanished from the queue and the only trace of a
    // dead nightly chain was one console.error line.
    const original = await boss.getJobById(ORCHESTRATOR_QUEUE, jobId);
    expect(original?.state).toBe('failed');

    const dlq = await boss.fetch(ORCHESTRATOR_DLQ, { batchSize: 10, includeMetadata: true });
    const preserved = dlq.find((j) => j.sourceId === jobId);
    expect(
      preserved,
      'an exhausted orchestrator tick must be preserved in the DLQ for post-mortem, not dropped',
    ).toBeDefined();
    expect(preserved?.sourceName).toBe(ORCHESTRATOR_QUEUE);
    expect(preserved?.data).toEqual({ probe: 'yuk778-dlq' });
  });
});
