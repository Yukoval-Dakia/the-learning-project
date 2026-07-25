// YUK-779 (PR #1076 review) — **生产** pg-boss→OrchestratorBoss 适配器的端到端契约测试。
//
// 为什么这个文件必须存在（也是它为什么不用 FakeBoss）：
//
// orchestrator 的既有 DB 测试注入 `FakeBoss implements OrchestratorBoss`。FakeBoss 是
// **适配器下游**的替身 —— 它自己实现了 output 透传，于是整条 handler→output→node.detail
// 链路在测试里通畅，而生产的 `toOrchestratorBoss` 曾经把 `output` 整个丢掉，链路在真实
// 运行中是断的。**测试替身比生产实现更完整**，全绿掩盖了一个功能为零的 feature。
//
// 因此这里刻意跑**真 pg-boss**（DB 分区有真 Postgres），验的是两段真实契约：
//   ① pg-boss 确实把 handler 的 resolved value 存进 job.output（batchSize:1）；
//   ② 生产适配器确实把它透传出来，且能被 readJobYieldReport 解析。
// 两段合起来 = 夜链产出报告在真实运行中抵达 orchestrator 的完整证明。
//
// 红/绿实证：把 toOrchestratorBoss 里 `output: job.output` 删掉 → 本文件第一条用例转红
// （既有的 orchestrator.db.test.ts 仍全绿 —— 那正是问题所在）。

// 具名导出（`export declare class PgBoss` —— pg-boss v12 无 default export），
// 与 src/server/boss/client.ts 的 import 形态一致。
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JOB_YIELD_OUTPUT_KEY, readJobYieldReport, reportJobYield } from '@/server/boss/job-yield';
import { toOrchestratorBoss } from './register';

/** 独立 schema：与应用单例 boss（pgboss）隔离，避免跨文件/跨 fork 干扰。 */
const TEST_SCHEMA = 'pgboss_yuk779';
const QUEUE = 'yuk779_adapter_probe';

let boss: PgBoss;

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  boss = new PgBoss({ connectionString, schema: TEST_SCHEMA, max: 2 });
  await boss.start();
  await boss.createQueue(QUEUE);
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
});

/** 等一个 job 走到终态并返回它（轮询，避免依赖 work 回调的时序）。 */
async function waitForTerminal(id: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await boss.getJobById(QUEUE, id);
    if (job && (job.state === 'completed' || job.state === 'failed')) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} did not reach a terminal state in ${timeoutMs}ms`);
}

describe('toOrchestratorBoss — 生产适配器（真 pg-boss，非 FakeBoss）', () => {
  it('handler 返回的 yield report 经真实 pg-boss 落进 job.output，并被生产适配器透传出来', async () => {
    // 夜链 handler 的真实收尾形态：吞错之后把产出报告作为返回值交给 pg-boss。
    const handlerReturn = reportJobYield('yuk779_probe_nightly', {
      attempted: 3,
      succeeded: 0,
      failed: 3,
    });

    const workerId = await boss.work(
      QUEUE,
      { pollingIntervalSeconds: 1, batchSize: 1 },
      async () => handlerReturn,
    );

    const id = await boss.send(QUEUE, {});
    if (!id) throw new Error('send returned null');
    const terminal = await waitForTerminal(id);
    // v12 签名是 offWork(name, options?)——name 是位置参数（index.d.ts:37）。
    await boss.offWork(QUEUE, { id: workerId });

    // ① pg-boss 契约：batchSize:1 时 handler 的 resolved value 就是 job.output。
    //    （此前只靠读 manager.js:434 断言，这里是实测。）
    expect(terminal.state).toBe('completed');
    expect(terminal.output).toMatchObject({
      [JOB_YIELD_OUTPUT_KEY]: { job: 'yuk779_probe_nightly', level: 'stalled' },
    });

    // ② 生产适配器契约：output 必须透传（删掉 register.ts 里的 `output: job.output` 即转红）。
    const adapter = toOrchestratorBoss(boss);
    const seen = await adapter.getJobById(QUEUE, id);
    expect(seen).not.toBeNull();
    expect(seen?.state).toBe('completed');

    // ③ 端到端：orchestrator 真的能从适配器的返回值里解出报告 —— 这一步正是
    //    pollInflightNode 盖 node.detail 用的那一步。
    const report = readJobYieldReport(seen?.output);
    expect(report).toBeDefined();
    expect(report?.level).toBe('stalled');
    expect(report?.attempted).toBe(3);
    expect(report?.succeeded).toBe(0);
    expect(report?.failed).toBe(3);
    expect(report?.detail).toContain('0/3 resolved unit(s) succeeded');
  }, 60_000);

  it('handler 返回 void（旧形态 / 非夜链 job）→ output 无报告，适配器照常工作不抛', async () => {
    const workerId = await boss.work(
      QUEUE,
      { pollingIntervalSeconds: 1, batchSize: 1 },
      async () => {
        /* 返回 void —— 迁移前的全部 handler 都是这个形态 */
      },
    );

    const id = await boss.send(QUEUE, {});
    if (!id) throw new Error('send returned null');
    await waitForTerminal(id);
    // v12 签名是 offWork(name, options?)——name 是位置参数（index.d.ts:37）。
    await boss.offWork(QUEUE, { id: workerId });

    const seen = await toOrchestratorBoss(boss).getJobById(QUEUE, id);
    expect(seen?.state).toBe('completed');
    // 防御性解析：读不出报告就是 undefined，绝不抛 —— 观测层不得炸掉 tick。
    expect(readJobYieldReport(seen?.output)).toBeUndefined();
  }, 60_000);

  it('查不到的 job → null（适配器的 not-found 语义不受 output 改动影响）', async () => {
    const seen = await toOrchestratorBoss(boss).getJobById(
      QUEUE,
      '00000000-0000-0000-0000-000000000000',
    );
    expect(seen).toBeNull();
  }, 60_000);
});
