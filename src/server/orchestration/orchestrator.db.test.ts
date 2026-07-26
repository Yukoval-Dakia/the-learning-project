// YUK-758 — orchestrator 触发语义 DB 测试。
//
// 用合成图（非真 manifest，保持 scope 无关）+ fake boss，验证：
//   ① start 建 run + 落节点 + enqueue 根；
//   ② 硬上游成功 → 下游 enqueue；
//   ③ 硬上游失败 → 下游 skipped + 留痕；
//   ④ 软上游失败 → 下游照跑（enqueue 带 stale:true）；
//   ⑤ 全终态 → run 收尾 completed，不再自调度 tick；
//   ⑥ 单飞：同日重复 start 不建第二条 run。

import { dag_orchestration_node, dag_orchestration_run } from '@/db/schema';
import { type JobDagMemberInput, buildJobDag } from '@/kernel/job-dag';
import { reportJobYield } from '@/server/boss/job-yield';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { ORCHESTRATOR_QUEUE } from './constants';
import {
  MINUTES_PER_DAY,
  type OrchestratorBoss,
  isWithinCatchUpWindow,
  minutesSinceAnchor,
  runOrchestratorCatchUp,
  runOrchestratorStart,
  runOrchestratorTick,
} from './orchestrator';
import { finishRun, updateNodeStatus } from './store';

const db = testDb();
const RUN_DATE = '2026-07-25';
const NOW = new Date('2026-07-25T02:30:00+08:00');

/**
 * fake pg-boss：记录 send，按 (name,id) 回放可编程 state。
 *
 * 建模真 pg-boss 的两个关键契约（YUK-758 review ToTaI）：
 *  · `send` 接受调用方指定的 `options.id`（SendOptions.id），job 以该 id 落库；
 *  · job INSERT 是 `ON CONFLICT DO NOTHING`——同 id 重发**不建第二条**且返回 null。
 */
class FakeBoss implements OrchestratorBoss {
  memberSends: {
    name: string;
    data: { stale?: boolean };
    id?: string;
    startAfter?: number;
  }[] = [];
  tickSends = 0;
  /** payloads of the self-scheduled tick sends (carry the run id — see ToTvLt). */
  tickPayloads: object[] = [];
  /** member job names for which send() returns null (models pg-boss "no job created"). */
  nullSendJobs = new Set<string>();
  /** member job names whose send() throws — models a crash/transient failure after the claim commit. */
  throwOnSendJobs = new Set<string>();
  /** make the tick-chain send throw (models a DB hiccup while arming the next tick). */
  failTickSend = false;
  /** make the tick-chain send return null (pg-boss "no job created"). */
  nullTickSend = false;
  /** every cancel(name, id) the orchestrator issued, in order. */
  cancels: { name: string; id: string }[] = [];
  /** member job names whose cancel() throws (models a DB hiccup / missing queue). */
  throwOnCancelJobs = new Set<string>();
  /**
   * job 表：key = `${name}:${id}`，value = **一条 job 记录**。
   *
   * state 与 output 合成一条记录而非两张平行表（YUK-779 PR #1076 review）：生产里它们
   * 就是 pgboss.job **同一行**的两个字段，拆成两张表就可能只共享其中一张——那种
   * 「共享了一半」的替身比完全不共享更危险，因为它看起来忠实。合成一条后，
   * 只要共享这张表，state 和 output 必然一起共享，这类漏洞在结构上不可能再出现。
   */
  private jobs: Map<string, { state: string; output?: unknown }>;
  private counter = 0;

  /**
   * @param sharedJobs 传入即与另一个 FakeBoss **共享同一份 job 表**（state + output）。
   *
   * 建模保真（YUK-779 PR #1076 修 A7 flake）：生产里多个 worker 副本连的是**同一个**
   * pg-boss 库，`getJobById` 是一次 DB 查询——副本 B 一定看得见副本 A 刚插的 job，
   * 也一定读得到 A 写下的 output。用各自独立的内存 job 表建模「两个副本」是**不忠实**的：
   * B 查不到 A 发的 job，pollInflightNode 的自愈补发就把它判成「send never landed」并
   * 重发一次；只共享 state 不共享 output 则会让跨副本的 node detail 回写契约漏测。
   * 默认仍是独立表（单副本用例不受影响）。
   */
  constructor(sharedJobs?: Map<string, { state: string; output?: unknown }>) {
    this.jobs = sharedJobs ?? new Map<string, { state: string; output?: unknown }>();
  }

  async send(
    name: string,
    data: object,
    options?: { startAfter?: number; id?: string },
  ): Promise<string | null> {
    if (name === ORCHESTRATOR_QUEUE) {
      if (this.failTickSend) throw new Error('simulated tick send failure');
      this.tickSends += 1;
      this.tickPayloads.push(data);
      return this.nullTickSend ? null : `tick_${this.tickSends}`;
    }
    if (this.throwOnSendJobs.has(name)) {
      throw new Error(`simulated send failure for '${name}'`);
    }
    this.memberSends.push({
      name,
      data: data as { stale?: boolean },
      id: options?.id,
      startAfter: options?.startAfter,
    });
    if (this.nullSendJobs.has(name)) return null;
    this.counter += 1;
    const id = options?.id ?? `boss_${this.counter}`;
    // ON CONFLICT DO NOTHING: an id that already exists is not re-inserted, and
    // pg-boss returns null (no RETURNING row) rather than an id.
    if (this.jobs.has(`${name}:${id}`)) return null;
    this.jobs.set(`${name}:${id}`, { state: 'created' });
    return id;
  }

  async getJobById(name: string, id: string): Promise<{ state: string; output?: unknown } | null> {
    const row = this.jobs.get(`${name}:${id}`);
    if (!row) return null;
    // Model pg-boss's jsonb round-trip so the reader is exercised on plain JSON,
    // not on the in-memory object identity.
    return row.output === undefined
      ? { state: row.state }
      : { state: row.state, output: JSON.parse(JSON.stringify(row.output)) };
  }

  /**
   * Models pg-boss v12.26.1 `cancelJobs` (plans.js):
   *   UPDATE ... SET state = 'cancelled' WHERE name = $1 AND id = ANY($2) AND state < 'completed'
   * `job_state` is an ORDERED enum (created < retry < active < completed < cancelled < failed),
   * so the guard covers exactly created/retry/active and leaves terminal jobs alone. A missing
   * id is simply 0 rows affected — never an error.
   */
  async cancel(name: string, id: string): Promise<void> {
    if (this.throwOnCancelJobs.has(name)) {
      throw new Error(`simulated cancel failure for '${name}'`);
    }
    this.cancels.push({ name, id });
    const row = this.jobs.get(`${name}:${id}`);
    if (row && (row.state === 'created' || row.state === 'retry' || row.state === 'active')) {
      row.state = 'cancelled';
    }
  }

  /** Would pg-boss still hand this job to a worker? (created/retry are pollable, active is running.) */
  isExecutable(name: string, id: string): boolean {
    const state = this.jobs.get(`${name}:${id}`)?.state;
    return state === 'created' || state === 'retry';
  }

  jobState(name: string, id: string): string | undefined {
    return this.jobs.get(`${name}:${id}`)?.state;
  }

  setJobState(name: string, id: string, state: string): void {
    const row = this.jobs.get(`${name}:${id}`);
    if (row) row.state = state;
    else this.jobs.set(`${name}:${id}`, { state });
  }

  /**
   * YUK-779 — stash what the handler resolved with (pg-boss stores it as job.output).
   * Upserts onto the SAME record as the state (production: one pgboss.job row), so a
   * shared job table necessarily shares the output too.
   */
  setJobOutput(name: string, id: string, output: unknown): void {
    const row = this.jobs.get(`${name}:${id}`);
    if (row) row.output = output;
    // 无 job 行时不可能有 output（生产同理：output 是 job 行的一个列）。调用方
    // （completeMemberWithYield）总是先 setJobState，故此分支实际不可达。
    else this.jobs.set(`${name}:${id}`, { state: 'created', output });
  }

  /** 该 (name,id) 是否真的存在一条 job 行。 */
  hasJob(name: string, id: string): boolean {
    return this.jobs.has(`${name}:${id}`);
  }
}

function dagOf(...members: JobDagMemberInput[]) {
  return buildJobDag(members);
}
const member = (
  name: string,
  dependsOn: JobDagMemberInput['dependsOn'] = [],
): JobDagMemberInput => ({ name, owner: 'test', dependsOn });

/**
 * A `db` double whose FIRST read of `dag_orchestration_node` throws, and which is the real `db`
 * for everything else. Used to fail exactly the stale-run `loadNodes` inside the abandon path
 * without disturbing the rest of the start (PR #1075 OCR major).
 */
function dbWithOneFailingNodeLoad(real: typeof db): typeof db {
  let armed = true;
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's fluent builder has no public seam to wrap.
  const anyReal = real as any;
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== 'select') return Reflect.get(target, prop, receiver);
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return (...args: any[]) => {
        const builder = anyReal.select(...args);
        return new Proxy(builder, {
          get(b, p) {
            if (p === 'from') {
              return (table: unknown) => {
                if (armed && table === dag_orchestration_node) {
                  armed = false;
                  throw new Error('simulated DB outage while loading nodes');
                }
                return b.from(table);
              };
            }
            const value = b[p];
            return typeof value === 'function' ? value.bind(b) : value;
          },
        });
      };
    },
  }) as typeof db;
}

/** narrow a nullable run to non-null (a start that returns null is a test failure). */
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`expected non-null ${label}`);
  return value;
}

async function nodeRow(runId: string, jobName: string) {
  const rows = await db
    .select()
    .from(dag_orchestration_node)
    .where(
      and(eq(dag_orchestration_node.run_id, runId), eq(dag_orchestration_node.job_name, jobName)),
    );
  return rows[0];
}

/** 把某成员节点的 pg-boss job 置为 completed（供下一 tick 观测终态）。 */
async function completeMember(boss: FakeBoss, runId: string, jobName: string) {
  const node = await nodeRow(runId, jobName);
  if (node?.boss_job_id) boss.setJobState(jobName, node.boss_job_id, 'completed');
}
async function failMember(boss: FakeBoss, runId: string, jobName: string) {
  const node = await nodeRow(runId, jobName);
  if (node?.boss_job_id) boss.setJobState(jobName, node.boss_job_id, 'failed');
}

/**
 * YUK-779 — 把某成员节点的 job 置为 completed **并**带上 handler 的产出报告
 * （pg-boss 把 handler 返回值存进 job.output）。
 */
async function completeMemberWithYield(
  boss: FakeBoss,
  runId: string,
  jobName: string,
  y: { attempted: number; succeeded: number; failed: number },
) {
  const node = await nodeRow(runId, jobName);
  if (!node?.boss_job_id) throw new Error(`no boss_job_id for '${jobName}'`);
  boss.setJobState(jobName, node.boss_job_id, 'completed');
  boss.setJobOutput(jobName, node.boss_job_id, reportJobYield(jobName, y));
}

describe('orchestrator trigger semantics', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('① start creates a run, inserts all nodes, enqueues only roots', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );

    const a = await nodeRow(run.id, 'a');
    const b = await nodeRow(run.id, 'b');
    expect(a?.status).toBe('enqueued');
    expect(b?.status).toBe('pending'); // waits on a
    // root enqueued exactly once; a tick was scheduled (run not complete).
    expect(boss.memberSends.map((s) => s.name)).toEqual(['a']);
    expect(boss.tickSends).toBe(1);
  });

  // ── YUK-779: 静默空跑在 DAG 上「可见」的端到端实证 ─────────────────────────
  // handler 返回产出报告 → pg-boss 存进 job.output → orchestrator 轮询时读回来 →
  // 盖进节点 detail。**不改 status**：节点仍 succeeded，硬下游仍照跑。

  it('YUK-779 RED — 异常空跑（试过、全败）→ 节点 detail 留痕，但仍 succeeded 且硬下游照跑', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    // 限流风暴：3 格全试、全败、全被吞 → handler 仍正常 resolve。
    await completeMemberWithYield(boss, run.id, 'a', { attempted: 3, succeeded: 0, failed: 3 });
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const a = await nodeRow(run.id, 'a');
    // ① 失败语义**未变**：job 没 throw，节点照常转绿。
    expect(a?.status).toBe('succeeded');
    // ② 但「昨晚一切正常」的假象被打破了——节点上留下了真相。
    expect(a?.detail).toContain('zero yield');
    // 分母与判据同源（PR #1076 review）：resolved = succeeded + failed。
    expect(a?.detail).toContain('0/3 resolved unit(s) succeeded');
    expect(a?.detail).toContain('3 swallowed failure(s)');
    // ③ 硬下游依然照跑（是否该改成 skip 是留给 owner 的语义决策）。
    expect((await nodeRow(run.id, 'b'))?.status).toBe('enqueued');
  });

  it('YUK-779 GREEN — 正常的零产出（空队列，压根没试）→ 节点 detail 保持 null', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    // 空夜：一次可失败调用都没发生。产出同样是 0，但这是正常的。
    await completeMemberWithYield(boss, run.id, 'a', { attempted: 0, succeeded: 0, failed: 0 });
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const a = await nodeRow(run.id, 'a');
    expect(a?.status).toBe('succeeded');
    expect(a?.detail).toBeNull(); // 不占 detail，不制造噪声
  });

  it('YUK-779 GREEN — 有输入但可失败步骤全部正常返回（无产出是合法结论）→ detail 保持 null', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    // recalibration_nightly 的招牌夜：200 道题全部 below_threshold —— 全部正常返回。
    await completeMemberWithYield(boss, run.id, 'a', {
      attempted: 200,
      succeeded: 200,
      failed: 0,
    });
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const a = await nodeRow(run.id, 'a');
    expect(a?.status).toBe('succeeded');
    expect(a?.detail).toBeNull();
  });

  it('YUK-779 — job 没带 output（旧 handler / 非夜链 job）时行为不变，绝不炸 tick', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await completeMember(boss, run.id, 'a'); // 无 output
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    expect((await nodeRow(run.id, 'a'))?.status).toBe('succeeded');
    expect((await nodeRow(run.id, 'a'))?.detail).toBeNull();
    expect((await nodeRow(run.id, 'b'))?.status).toBe('enqueued');
  });

  it('② hard upstream success → downstream enqueues on next advance', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    expect((await nodeRow(run.id, 'a'))?.status).toBe('succeeded');
    expect((await nodeRow(run.id, 'b'))?.status).toBe('enqueued');
    expect(boss.memberSends.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('③ hard upstream failure → downstream skipped with a reason, never enqueued', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await failMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    expect((await nodeRow(run.id, 'a'))?.status).toBe('failed');
    const b = await nodeRow(run.id, 'b');
    expect(b?.status).toBe('skipped');
    expect(b?.detail).toMatch(/upstream 'a' failed/);
    // b never enqueued (only a was sent).
    expect(boss.memberSends.map((s) => s.name)).toEqual(['a']);
  });

  // YUK-778 ③ — the soft-edge semantics (downstream runs anyway) are unchanged; what changed is
  // that the fact is recorded ONLY on the scheduling row. The `{ stale: true }` job payload had
  // no reader anywhere in the repo — neither soft-edge downstream (knowledge_maintenance_nightly,
  // dreaming_nightly) touches job.data — so it was a promise ("the handler adapts") that nothing
  // kept. Sending an empty payload states the truth: the member is simply triggered.
  it('④ soft upstream failure → downstream runs anyway, stale recorded on the node, NOT in the payload', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', [{ job: 'a', soft: true }]));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await failMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const b = await nodeRow(run.id, 'b');
    expect(b?.status).toBe('enqueued');
    expect(b?.stale).toBe(true);
    const bSend = boss.memberSends.find((s) => s.name === 'b');
    expect(bSend?.data).toEqual({}); // exact equality — a `stale` key would fail this
  });

  // The self-healing re-send (⑪) is the OTHER site that used to reconstruct the payload, from
  // the persisted `node.stale` column. It must stay shaped like the original send — "same id,
  // same job" has to hold in more than just the id.
  it('④b the idempotent re-send of a stale node carries the same empty payload', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', [{ job: 'a', soft: true }]));
    boss.throwOnSendJobs.add('b'); // b's first send crashes after the claim committed
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await failMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }); // claims b as stale, send throws

    const claimed = await nodeRow(run.id, 'b');
    expect(claimed?.status).toBe('enqueued');
    expect(claimed?.stale).toBe(true);
    const reservedId = must(claimed?.boss_job_id, 'reserved boss job id');
    expect(boss.hasJob('b', reservedId)).toBe(false);

    boss.throwOnSendJobs.clear();
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const bSends = boss.memberSends.filter((s) => s.name === 'b');
    expect(bSends).toHaveLength(1); // only the recovery send was recorded (the first one threw)
    expect(bSends[0].id).toBe(reservedId);
    expect(bSends[0].data).toEqual({});
  });

  it('⑤ run finishes as completed once all nodes are terminal; no further tick scheduled', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }); // enqueues b
    await completeMember(boss, run.id, 'b');
    const tickBefore = boss.tickSends;
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }); // b succeeds → complete

    const finished = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, run.id))
    )[0];
    expect(finished.status).toBe('completed');
    expect(finished.finished_at).not.toBeNull();
    // completing tick must NOT schedule another tick.
    expect(boss.tickSends).toBe(tickBefore);
  });

  it('⑥ single-flight: a second start on the same date adopts the existing run', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const first = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'first run',
    );
    const second = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'manual'),
      'second run',
    );
    expect(second.id).toBe(first.id);
    const runs = await db
      .select()
      .from(dag_orchestration_run)
      .where(eq(dag_orchestration_run.run_date, RUN_DATE));
    expect(runs).toHaveLength(1);
    // root a enqueued exactly once across both starts (idempotent adoption).
    expect(boss.memberSends.filter((s) => s.name === 'a')).toHaveLength(1);
  });

  it('⑦ cron redeliver after completion does not create a second run; manual rerun does', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const first = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'first run',
    );
    await completeMember(boss, first.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }); // a → completed

    // A crash-recovery redeliver of the cron start job for the SAME date must NOT
    // build a second run + re-enqueue roots (YUK-758 review ToPUE).
    const redeliver = await runOrchestratorStart(
      { db, boss, dag, now: NOW, localDate: () => RUN_DATE },
      'cron',
    );
    expect(redeliver).toBeNull();
    let runs = await db
      .select()
      .from(dag_orchestration_run)
      .where(eq(dag_orchestration_run.run_date, RUN_DATE));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(boss.memberSends.filter((s) => s.name === 'a')).toHaveLength(1);

    // An explicit MANUAL rerun after completion IS allowed to create a fresh run.
    const rerun = await runOrchestratorStart(
      { db, boss, dag, now: NOW, localDate: () => RUN_DATE },
      'manual',
    );
    expect(rerun).not.toBeNull();
    expect(rerun?.id).not.toBe(first.id);
    runs = await db
      .select()
      .from(dag_orchestration_run)
      .where(eq(dag_orchestration_run.run_date, RUN_DATE));
    expect(runs).toHaveLength(2);
  });

  it('⑧ boss.send returning null marks the node failed immediately (no 3h wait) + hard downstream skips', async () => {
    const boss = new FakeBoss();
    boss.nullSendJobs.add('a');
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    const a = await nodeRow(run.id, 'a');
    expect(a?.status).toBe('failed');
    expect(a?.detail).toMatch(/no job exists for the reserved id/);
    // The id is now reserved BEFORE the send (intent-first), so it is persisted even
    // on the failure path — what marks the node failed is that no job exists for it.
    expect(a?.boss_job_id).not.toBeNull();

    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    expect((await nodeRow(run.id, 'b'))?.status).toBe('skipped');
    // b never enqueued (its only send would be its own; a's null send is recorded but no boss_job_id).
    expect(boss.memberSends.filter((s) => s.name === 'b')).toHaveLength(0);
  });

  it('⑨ adopting a run committed with 0 nodes self-heals (backfills nodes + enqueues roots)', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    // Simulate the crash window: createRun committed a running run, insertNodes never ran.
    await db.insert(dag_orchestration_run).values({
      id: 'orphan-run',
      run_date: RUN_DATE,
      trigger: 'cron',
      status: 'running',
      started_at: NOW,
      updated_at: NOW,
    });

    // A redelivered cron start adopts the orphan run; it must backfill the missing
    // nodes and enqueue the root rather than spin forever on a 0-node run (ToqXn).
    const run = await runOrchestratorStart(
      { db, boss, dag, now: NOW, localDate: () => RUN_DATE },
      'cron',
    );
    expect(run?.id).toBe('orphan-run');
    expect((await nodeRow('orphan-run', 'a'))?.status).toBe('enqueued');
    expect((await nodeRow('orphan-run', 'b'))?.status).toBe('pending');
    expect(boss.memberSends.map((s) => s.name)).toEqual(['a']);
  });

  // ⑩ YUK-758 review ToTaZ — an 'expired' pg-boss state must resolve to failed, not to
  // "unknown" (which would leave the node in-flight until the 3h NODE_TIMEOUT and delay
  // every hard-downstream skip decision by a whole night).
  it('⑩ a pg-boss job in state expired is treated as failed (no 3h wait) + hard downstream skips', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    const a = await nodeRow(run.id, 'a');
    boss.setJobState('a', must(a?.boss_job_id, 'boss job id'), 'expired');

    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    expect((await nodeRow(run.id, 'a'))?.status).toBe('failed');
    expect((await nodeRow(run.id, 'b'))?.status).toBe('skipped');
  });

  // ⑪ YUK-758 review ToTaI — the crash window between "job sent" and "job id recorded".
  // The id is now reserved with the CAS *before* the send, so a crashed send leaves a
  // node that still knows its pg-boss identity and can be recovered by an idempotent
  // re-send under the same id.
  it('⑪ a send that never lands leaves the reserved id persisted and is re-sent idempotently', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    boss.throwOnSendJobs.add('a');

    // The anchor start crashes inside boss.send, after claimNodePending committed. The
    // throw is absorbed so the tick chain still gets scheduled (see ⑭); what matters
    // here is the state it left behind.
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    const runId = run.id;
    const crashed = await nodeRow(runId, 'a');
    // Intent was persisted before the send: the node is enqueued AND knows its job id.
    expect(crashed?.status).toBe('enqueued');
    const reservedId = must(crashed?.boss_job_id, 'reserved boss job id');
    expect(boss.hasJob('a', reservedId)).toBe(false); // the send truly never landed

    // Recovery: the next tick notices there is no job for the reserved id and re-sends
    // under that same id rather than polling a ghost until NODE_TIMEOUT_SECONDS.
    boss.throwOnSendJobs.clear();
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    expect(boss.hasJob('a', reservedId)).toBe(true);
    const recovered = await nodeRow(runId, 'a');
    expect(recovered?.status).toBe('enqueued'); // NOT failed
    expect(recovered?.boss_job_id).toBe(reservedId); // same identity, no second job

    // A further tick must not create a second job (same id → ON CONFLICT DO NOTHING).
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    expect(boss.memberSends.filter((s) => s.name === 'a' && s.id !== reservedId)).toHaveLength(0);

    // And the recovered job drives the graph forward normally.
    await completeMember(boss, runId, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    expect((await nodeRow(runId, 'a'))?.status).toBe('succeeded');
    expect((await nodeRow(runId, 'b'))?.status).toBe('enqueued');
  });

  it('⑪b past the recovery grace window a still-missing job times out to failed', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    boss.throwOnSendJobs.add('a');
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    const runId = run.id;

    // Far past both the recovery grace window and the (test-shrunk) node timeout, with
    // the send still failing: the node must converge to failed rather than hang forever.
    const later = new Date(NOW.getTime() + 4 * 60 * 60 * 1000);
    await runOrchestratorTick({
      db,
      boss,
      dag,
      now: later,
      localDate: () => RUN_DATE,
      timeoutSeconds: 60,
    });

    expect((await nodeRow(runId, 'a'))?.status).toBe('failed');
    expect((await nodeRow(runId, 'a'))?.detail).toMatch(/not found/);
  });

  // ⑫ YUK-758 review ToTaz — a stale poll must never revive a terminal node. Reviving
  // it would clear finished_at and keep summarize() from ever reaching complete, so the
  // run would spin on self-scheduled ticks forever.
  it('⑫ a terminal node cannot be dragged back to a non-terminal status', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const succeeded = await nodeRow(run.id, 'a');
    expect(succeeded?.status).toBe('succeeded');
    const finishedAt = succeeded?.finished_at;

    // A stale in-flight poll landing late tries to write 'running' over the terminal row.
    await updateNodeStatus(db, must(succeeded?.id, 'node id'), { status: 'running', now: NOW });

    const after = await nodeRow(run.id, 'a');
    expect(after?.status).toBe('succeeded'); // unchanged
    expect(after?.finished_at).toEqual(finishedAt); // finished_at preserved
  });

  it('⑫b a terminal node cannot be flipped to a different terminal status', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    const node = await nodeRow(run.id, 'a');

    await updateNodeStatus(db, must(node?.id, 'node id'), {
      status: 'failed',
      detail: 'stale writer',
      now: NOW,
    });

    expect((await nodeRow(run.id, 'a'))?.status).toBe('succeeded');
  });

  // ⑬ YUK-758 review ToTeE — a member job still working through its pg-boss retry budget
  // must not be declared timed out. agent-queue members can legally live for
  // (1 + JOB_RETRY_LIMIT) × EXPIRE_AGENT ≈ 6h, and enqueued_at is not reset per retry.
  it('⑬ a node still inside the pg-boss retry budget is not timed out', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    const a = await nodeRow(run.id, 'a');
    // pg-boss re-queued the job for a further attempt after an expiry.
    boss.setJobState('a', must(a?.boss_job_id, 'boss job id'), 'retry');

    // 4h in: past the old 3h ceiling, still inside the real retry budget.
    const fourHoursIn = new Date(NOW.getTime() + 4 * 60 * 60 * 1000);
    await runOrchestratorTick({ db, boss, dag, now: fourHoursIn, localDate: () => RUN_DATE });

    expect((await nodeRow(run.id, 'a'))?.status).toBe('enqueued'); // still waiting, not failed
    expect((await nodeRow(run.id, 'b'))?.status).toBe('pending'); // downstream not skipped

    // The retry then succeeds — the graph must proceed normally rather than having been
    // written off an hour earlier.
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: fourHoursIn, localDate: () => RUN_DATE });
    expect((await nodeRow(run.id, 'a'))?.status).toBe('succeeded');
    expect((await nodeRow(run.id, 'b'))?.status).toBe('enqueued');
  });

  it('⑬b a node past the whole retry budget still times out to failed', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    const a = await nodeRow(run.id, 'a');
    boss.setJobState('a', must(a?.boss_job_id, 'boss job id'), 'retry');

    // 8h in: beyond NODE_TIMEOUT_SECONDS (7h) — the backstop must still fire.
    const eightHoursIn = new Date(NOW.getTime() + 8 * 60 * 60 * 1000);
    await runOrchestratorTick({ db, boss, dag, now: eightHoursIn, localDate: () => RUN_DATE });

    expect((await nodeRow(run.id, 'a'))?.status).toBe('failed');
    expect((await nodeRow(run.id, 'a'))?.detail).toMatch(/timeout/);
    expect((await nodeRow(run.id, 'b'))?.status).toBe('skipped');
  });

  // ⑭ review 面板必修 1 — tick 自调度是当夜唯一续跑通道。advanceRun 步骤②（claim / send /
  // updateNodeStatus）整段裸奔，一次瞬时异常原本会跳过续链，让 run 永久停在 running 且当夜
  // 剩余节点全部静默不跑。续链现在无条件发生。
  it('⑭ an advance that throws still schedules exactly one next tick, and the run recovers', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await completeMember(boss, run.id, 'a');

    // The next tick will throw inside step ② while enqueueing b.
    boss.throwOnSendJobs.add('b');
    const ticksBefore = boss.tickSends;
    await expect(
      runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }),
    ).resolves.toBeUndefined(); // swallowed, not propagated

    // EXACTLY one next tick — not zero (chain dead) and not several (forked chains
    // would re-enqueue paid member jobs).
    expect(boss.tickSends).toBe(ticksBefore + 1);
    const stillRunning = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, run.id))
    )[0];
    expect(stillRunning.status).toBe('running');

    // The chain survives: once the transient condition clears, the run converges.
    boss.throwOnSendJobs.clear();
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    expect((await nodeRow(run.id, 'b'))?.status).toBe('enqueued');
    await completeMember(boss, run.id, 'b');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const finished = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, run.id))
    )[0];
    expect(finished.status).toBe('completed');
  });

  it('⑭b a throwing advance on the anchor start still leaves a live tick chain', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    boss.throwOnSendJobs.add('a');

    // The anchor's own advance throws while enqueueing the root. The run must still
    // exist AND still have a tick scheduled to carry it forward.
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    expect(boss.tickSends).toBe(1);

    boss.throwOnSendJobs.clear();
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    expect((await nodeRow(run.id, 'a'))?.status).toBe('enqueued');
  });

  // ⑮ review 面板疑点 ② — `JobDecl.queue` 是档位标签而非 pg-boss 队列名（每只 job 自己一个
  // 队列 + 自己的 worker），故 batchSize:1 拦不住跨 job 并发：8 个根会同秒砸向 LLM provider。
  // 同轮入队者按序错峰，恢复迁移前 cron 错峰顺带提供的限流分摊。
  it('⑮ jobs enqueued in the same pass are staggered; a lone ready node is not delayed', async () => {
    const boss = new FakeBoss();
    // four roots — the burst shape the anchor produces.
    const dag = dagOf(member('r1'), member('r2'), member('r3'), member('r4'));
    await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron');

    const roots = boss.memberSends.filter((s) => s.name.startsWith('r'));
    expect(roots).toHaveLength(4);
    // strictly increasing offsets; the first goes out immediately.
    const offsets = roots.map((s) => s.startAfter ?? 0);
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i], `root ${i}`).toBeGreaterThan(offsets[i - 1]);
    }
  });

  it('⑮b a serial chain adds no stagger delay (one ready node per tick)', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    // Both a and b were the only ready node in their pass → neither is delayed.
    for (const send of boss.memberSends) {
      expect(send.startAfter ?? 0, send.name).toBe(0);
    }
  });

  // ⑯ YUK-758 review ToTjN — a mid-run upgrade that drops/renames a member leaves a
  // persisted pending node with no counterpart in the running build. Skipping it forever
  // kept it in summarize()'s total, so the run could never complete and ticks spun until
  // the next night abandoned it.
  it('⑯ a persisted node that is no longer a DAG member converges instead of stalling the run', async () => {
    const boss = new FakeBoss();
    // The run is created from the OLD graph (a, b, retired).
    const oldDag = dagOf(member('a'), member('b', ['a']), member('retired'));
    const run = must(
      await runOrchestratorStart(
        { db, boss, dag: oldDag, now: NOW, localDate: () => RUN_DATE },
        'cron',
      ),
      'run',
    );
    expect((await nodeRow(run.id, 'retired'))?.status).toBe('enqueued');

    // Worker restarts on a build where `retired` no longer declares dependsOn.
    const newDag = dagOf(member('a'), member('b', ['a']));
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag: newDag, now: NOW, localDate: () => RUN_DATE });
    await completeMember(boss, run.id, 'b');
    await runOrchestratorTick({ db, boss, dag: newDag, now: NOW, localDate: () => RUN_DATE });

    // `retired` was already enqueued before the upgrade, so it converges via its job.
    await completeMember(boss, run.id, 'retired');
    await runOrchestratorTick({ db, boss, dag: newDag, now: NOW, localDate: () => RUN_DATE });
    const finished = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, run.id))
    )[0];
    expect(finished.status).toBe('completed');
  });

  it('⑯b a still-pending node dropped from the graph is skipped with a reason', async () => {
    const boss = new FakeBoss();
    // `retired` depends on `a`, so it is still pending when the upgrade lands.
    const oldDag = dagOf(member('a'), member('retired', ['a']));
    const run = must(
      await runOrchestratorStart(
        { db, boss, dag: oldDag, now: NOW, localDate: () => RUN_DATE },
        'cron',
      ),
      'run',
    );
    expect((await nodeRow(run.id, 'retired'))?.status).toBe('pending');

    const newDag = dagOf(member('a'));
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag: newDag, now: NOW, localDate: () => RUN_DATE });

    const retired = await nodeRow(run.id, 'retired');
    expect(retired?.status).toBe('skipped');
    expect(retired?.detail).toMatch(/no longer a DAG member/);
    // and the run can now actually finish rather than spinning forever.
    const finished = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, run.id))
    )[0];
    expect(finished.status).toBe('completed');
  });

  // ⑰ review ToTbw — step ② per-node isolation: one node's enqueue failure must not
  // stop the other ready nodes in the SAME pass.
  it('⑰ one node failing to enqueue does not block its siblings in the same pass', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('r1'), member('r2'), member('r3'));
    boss.throwOnSendJobs.add('r2');

    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );

    // r1 and r3 still went out even though r2 threw mid-pass.
    expect((await nodeRow(run.id, 'r1'))?.status).toBe('enqueued');
    expect((await nodeRow(run.id, 'r3'))?.status).toBe('enqueued');
    expect(boss.memberSends.map((s) => s.name).sort()).toEqual(['r1', 'r3']);
  });

  // ⑱ YUK-758 review ToTk1I / ToTvY — the swallow is only legitimate once the next tick
  // is CONFIRMED queued. If arming the chain itself fails, the error must propagate so
  // pg-boss redelivers; swallowing it would leave the night dead AND unretried.
  it('⑱ a failure to arm the next tick propagates instead of being swallowed', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );

    // The continuation send now fails.
    boss.failTickSend = true;
    await expect(
      runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }),
    ).rejects.toThrow();

    // Run is still open, so a redelivered tick can pick it back up.
    const stillRunning = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, run.id))
    )[0];
    expect(stillRunning.status).toBe('running');
  });

  it('⑱b a null tick send is treated as "chain not armed" and also propagates', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron');

    boss.nullTickSend = true;
    await expect(
      runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }),
    ).rejects.toThrow(/tick chain not armed/);
  });

  // ⑲ YUK-758 review ToTk1N / ToTvT — the symmetric half of ToTjN: a member ADDED by a
  // mid-run upgrade had no node row, so any existing downstream depending on it resolved
  // its upstream to undefined and stayed pending forever, stalling the whole run.
  it('⑲ a member added mid-run is backfilled by the tick instead of stalling its downstream', async () => {
    const boss = new FakeBoss();
    // Run created from the OLD graph: just `a`.
    const oldDag = dagOf(member('a'));
    const run = must(
      await runOrchestratorStart(
        { db, boss, dag: oldDag, now: NOW, localDate: () => RUN_DATE },
        'cron',
      ),
      'run',
    );
    await completeMember(boss, run.id, 'a');

    // Upgrade lands mid-run: `x` is new, and `a`'s successor `y` depends on it.
    const newDag = dagOf(member('a'), member('x'), member('y', ['x']));
    await runOrchestratorTick({ db, boss, dag: newDag, now: NOW, localDate: () => RUN_DATE });

    // Both new members got node rows; the new root went out.
    expect((await nodeRow(run.id, 'x'))?.status).toBe('enqueued');
    expect((await nodeRow(run.id, 'y'))?.status).toBe('pending');

    // And the run can still converge rather than spinning forever.
    await completeMember(boss, run.id, 'x');
    await runOrchestratorTick({ db, boss, dag: newDag, now: NOW, localDate: () => RUN_DATE });
    expect((await nodeRow(run.id, 'y'))?.status).toBe('enqueued');
    await completeMember(boss, run.id, 'y');
    await runOrchestratorTick({ db, boss, dag: newDag, now: NOW, localDate: () => RUN_DATE });
    const finished = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, run.id))
    )[0];
    expect(finished.status).toBe('completed');
  });

  // ⑳ ToTk1L — the re-send window must cover a real restart, not just the millisecond
  // crash gap: a job that provably never existed should still be recoverable an hour later.
  it('⑳ a never-landed send is still recovered well beyond the old 5-minute window', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    boss.throwOnSendJobs.add('a');
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    const reservedId = must((await nodeRow(run.id, 'a'))?.boss_job_id, 'reserved id');
    expect(boss.hasJob('a', reservedId)).toBe(false);

    // An hour later — long past the old grace, still far inside the node timeout.
    boss.throwOnSendJobs.clear();
    const anHourLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    await runOrchestratorTick({ db, boss, dag, now: anHourLater, localDate: () => RUN_DATE });

    expect(boss.hasJob('a', reservedId)).toBe(true);
    expect((await nodeRow(run.id, 'a'))?.status).toBe('enqueued'); // recovered, not failed
  });

  // ㉑ YUK-758 review ToTvLt — a run that spans local midnight (e.g. a manual full-chain
  // rerun started at 23:5x) used to become unreachable: the first tick after the date
  // rolls over looked up "today's" run, found none, and returned — leaving the run
  // `running` with its remaining members stalled until the 02:30 anchor abandoned it.
  it('㉑ a tick finds its own run by id across a local-midnight rollover', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'manual'),
      'run',
    );
    await completeMember(boss, run.id, 'a');

    // The clock has rolled into the NEXT local day; a date-keyed lookup would miss.
    const nextDay = () => '2026-07-26';
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: nextDay }, run.id);

    // The run kept advancing rather than being stranded.
    expect((await nodeRow(run.id, 'a'))?.status).toBe('succeeded');
    expect((await nodeRow(run.id, 'b'))?.status).toBe('enqueued');
  });

  it('㉑b without a runId the tick still falls back to the date lookup', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    expect((await nodeRow(run.id, 'b'))?.status).toBe('enqueued');
  });

  it('㉑c the scheduled next tick carries its run id', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    expect(boss.tickPayloads).toContainEqual({ tick: true, runId: run.id });
  });

  it('tick with no active run is a no-op', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    await expect(
      runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }),
    ).resolves.toBeUndefined();
    expect(boss.memberSends).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YUK-781 A — 错过单锚点 = 整夜零运行，无补跑。
//
// pg-boss 不重放错过的 cron：timekeeper 每 30s 跑 cron()，`shouldSendIt()` 只在
// 「上一次 cron 时刻距今 < 60s」时入队（dist/timekeeper.js）。整栈在 02:30±60s 停机
// （夜间断电 / compose down 部署 / 镜像拉取慢）→ 该夜锚点根本没入过队 → 14 个成员一个不跑，
// `dag_orchestration_run` 里连一行都没有，直到次日 02:30。
// ─────────────────────────────────────────────────────────────────────────────
describe('YUK-781 A — boot catch-up for a missed anchor', () => {
  // 全部以真实 Asia/Shanghai 时区算 —— 窗口判据用的就是这套 Intl 换算，不另设 DI seam。
  const AT_ANCHOR = new Date('2026-07-25T02:30:00+08:00'); // 距锚点 0min
  const HALF_HOUR_PAST = new Date('2026-07-25T03:00:00+08:00'); // 30min
  const LAST_MINUTE_IN = new Date('2026-07-25T07:29:00+08:00'); // 299min（窗内最后一分钟）
  const FIRST_MINUTE_OUT = new Date('2026-07-25T07:30:00+08:00'); // 300min（窗外第一分钟）
  const NOON = new Date('2026-07-25T12:00:00+08:00'); // 570min —— 中午重启
  const BEFORE_ANCHOR = new Date('2026-07-25T02:00:00+08:00'); // −30min

  const catchUp = (boss: FakeBoss, dag: ReturnType<typeof dagOf>, now: Date) =>
    runOrchestratorCatchUp({ db, boss, dag, now, localDate: () => RUN_DATE });

  const runsForDate = () =>
    db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.run_date, RUN_DATE));

  beforeEach(async () => {
    await resetDb();
  });

  it('A1 backfills tonight’s run when the worker boots after the anchor was missed', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));

    const outcome = await catchUp(boss, dag, HALF_HOUR_PAST);

    expect(outcome.action).toBe('started');
    const runs = await runsForDate();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');
    expect(runs[0].trigger).toBe('cron');
    // roots actually went out, and the tick chain is armed — a run row alone is not "running".
    expect((await nodeRow(runs[0].id, 'a'))?.status).toBe('enqueued');
    expect((await nodeRow(runs[0].id, 'b'))?.status).toBe('pending');
    expect(boss.memberSends.map((s) => s.name)).toEqual(['a']);
    expect(boss.tickSends).toBe(1);
  });

  it('A2 a repeated boot creates no second run and does not fork the tick chain', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));

    await catchUp(boss, dag, HALF_HOUR_PAST);
    const ticksAfterFirst = boss.tickSends;
    const outcome = await catchUp(boss, dag, HALF_HOUR_PAST);

    expect(outcome).toEqual({ action: 'skipped', reason: 'run-exists' });
    expect(await runsForDate()).toHaveLength(1);
    // The paid root went out exactly once…
    expect(boss.memberSends.filter((s) => s.name === 'a')).toHaveLength(1);
    // …and no SECOND tick chain was armed alongside the one already living in pg-boss.
    expect(boss.tickSends).toBe(ticksAfterFirst);
  });

  it('A3 a run that already completed today is not re-run by a later boot', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    await catchUp(boss, dag, AT_ANCHOR);
    const run = (await runsForDate())[0];
    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: AT_ANCHOR, localDate: () => RUN_DATE });
    expect((await runsForDate())[0].status).toBe('completed');

    const outcome = await catchUp(boss, dag, HALF_HOUR_PAST);

    expect(outcome).toEqual({ action: 'skipped', reason: 'run-exists' });
    expect(await runsForDate()).toHaveLength(1);
    expect(boss.memberSends.filter((s) => s.name === 'a')).toHaveLength(1);
  });

  // The whole point of the window: without it, ANY daytime restart drags the entire nightly
  // chain (8 paid LLM roots + downstream) into the middle of the user's day.
  it('A4 a midday restart does NOT drag the nightly chain into daylight', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));

    const outcome = await catchUp(boss, dag, NOON);

    expect(outcome).toEqual({ action: 'skipped', reason: 'outside-window' });
    expect(await runsForDate()).toHaveLength(0);
    expect(boss.memberSends).toHaveLength(0);
    expect(boss.tickSends).toBe(0);
  });

  it('A5 a boot BEFORE the anchor waits for the anchor instead of starting early', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));

    const outcome = await catchUp(boss, dag, BEFORE_ANCHOR);

    expect(outcome).toEqual({ action: 'skipped', reason: 'outside-window' });
    expect(await runsForDate()).toHaveLength(0);
  });

  it('A6 the window is [anchor, anchor + 5h): inclusive at the anchor, exclusive at the edge', async () => {
    const dag = dagOf(member('a'));

    const atAnchor = new FakeBoss();
    expect((await catchUp(atAnchor, dag, AT_ANCHOR)).action).toBe('started');
    await resetDb();

    const lastIn = new FakeBoss();
    expect((await catchUp(lastIn, dag, LAST_MINUTE_IN)).action).toBe('started');
    await resetDb();

    const firstOut = new FakeBoss();
    expect(await catchUp(firstOut, dag, FIRST_MINUTE_OUT)).toEqual({
      action: 'skipped',
      reason: 'outside-window',
    });
    expect(await runsForDate()).toHaveLength(0);
  });

  // Two worker replicas booting in the same second both pass the window + "no run today" gate.
  // The DB partial unique (run_date) WHERE status='running' is what has to hold the line.
  it('A7 two workers booting at once create exactly one run and enqueue each root once', async () => {
    // 两个副本共享**同一份** job 表 —— 生产里它们连同一个 pg-boss 库（见 FakeBoss
    // 构造器）。此前各给一份独立表，B 查不到 A 刚发的 job，自愈补发便把它判成
    // 「send never landed」重发一次，于是 allSends 里出现两条 'r1' —— 一个纯粹的
    // 建模产物，且只在特定交错下出现（CI 上偶发红、本地几乎必绿）。
    const sharedJobs = new Map<string, { state: string; output?: unknown }>();
    const bossA = new FakeBoss(sharedJobs);
    const bossB = new FakeBoss(sharedJobs);
    const dag = dagOf(member('r1'), member('r2'), member('down', ['r1']));

    const [outA, outB] = await Promise.all([
      catchUp(bossA, dag, HALF_HOUR_PAST),
      catchUp(bossB, dag, HALF_HOUR_PAST),
    ]);

    const runs = await runsForDate();
    expect(runs).toHaveLength(1);
    // Both replicas converge on the same run (one created it, the other adopted it) and
    // NEITHER errors out — the loser must lose cleanly via ON CONFLICT DO NOTHING, not by
    // raising a 23505 out of the single-flight insert.
    for (const out of [outA, outB]) {
      if (out.action === 'started') expect(out.run.id).toBe(runs[0].id);
      else expect(out.reason).toBe('run-exists');
    }
    expect([outA.action, outB.action]).toContain('started');
    // Each paid root was sent exactly once ACROSS both replicas (claimNodePending CAS).
    const allSends = [...bossA.memberSends, ...bossB.memberSends].map((s) => s.name);
    expect(allSends.filter((n) => n === 'r1')).toHaveLength(1);
    expect(allSends.filter((n) => n === 'r2')).toHaveLength(1);
    expect(allSends.filter((n) => n === 'down')).toHaveLength(0);
    expect((await nodeRow(runs[0].id, 'r1'))?.status).toBe('enqueued');
    expect((await nodeRow(runs[0].id, 'r2'))?.status).toBe('enqueued');

    // 更承重的一条：真正代表「没有重复付费」的不是 send **调用**次数，而是**落库的 job
    // 行数**。共享 job 表让这条可断言了——即便某条路径重发，reserved id 相同 +
    // ON CONFLICT DO NOTHING 也只会存在一行。
    const jobKeys = [...sharedJobs.keys()];
    expect(jobKeys.filter((k) => k.startsWith('r1:'))).toHaveLength(1);
    expect(jobKeys.filter((k) => k.startsWith('r2:'))).toHaveLength(1);
    expect(jobKeys.filter((k) => k.startsWith('down:'))).toHaveLength(0);
    // 且落库的那一行用的正是节点预留的 id（意图先落库不变量）。
    for (const root of ['r1', 'r2'] as const) {
      const node = await nodeRow(runs[0].id, root);
      expect(node?.boss_job_id).toBeTruthy();
      expect(bossA.hasJob(root, node?.boss_job_id ?? '')).toBe(true);
    }
  });

  // A7 的**确定性**姊妹用例（YUK-779 PR #1076）。A7 用 Promise.all 抢并发，「副本 B 在 A
  // 已入队之后才轮询 r1」这个关键交错只是**偶尔**发生（CI 偶发红、本地几乎必绿）。这里用
  // 「A 起 run → B 推一拍」把那个交错钉死，不再靠调度运气。
  //
  // 被钉的生产不变量：推进既有 run 的**另一个副本**不得重发已入队的根。它成立靠的是
  // 「两个副本查同一个 pg-boss 库」—— B 的 getJobById 查得到 A 插的行，于是
  // pollInflightNode 不走 `send never landed` 自愈补发那一支。把 bossB 换成独立 job 表
  // （即修复前的建模）这条立刻转红，正是 CI 上那条 `[ 'r1', 'r1' ]` 的机理。
  it('A7b 另一个副本推进同一条 run 时不重发已入队的根（确定性交错）', async () => {
    const sharedJobs = new Map<string, { state: string; output?: unknown }>();
    const bossA = new FakeBoss(sharedJobs);
    const bossB = new FakeBoss(sharedJobs);
    const dag = dagOf(member('r1'), member('r2'), member('down', ['r1']));

    const outA = await catchUp(bossA, dag, HALF_HOUR_PAST);
    expect(outA.action).toBe('started');
    expect(bossA.memberSends.map((s) => s.name).sort()).toEqual(['r1', 'r2']);

    // 副本 B 推进同一条 run：它会轮询 A 已入队的 r1/r2。
    await runOrchestratorTick({
      db,
      boss: bossB,
      dag,
      now: HALF_HOUR_PAST,
      localDate: () => RUN_DATE,
    });

    // B 一条成员 job 都不该发（r1/r2 在飞、down 的硬上游未成功）。
    expect(bossB.memberSends.map((s) => s.name)).toEqual([]);

    // 全局仍是每根恰一条 job 行。
    const jobKeys = [...sharedJobs.keys()];
    expect(jobKeys.filter((k) => k.startsWith('r1:'))).toHaveLength(1);
    expect(jobKeys.filter((k) => k.startsWith('r2:'))).toHaveLength(1);
  });

  // YUK-779 PR #1076 review — **跨副本**的 output → node.detail 回写契约。
  //
  // 上一轮只把 FakeBoss 的 state 做成可共享、output 仍是每实例私有，于是这条链路
  // 在多副本下从未被测：副本 A 执行完 job 写下 yield report，副本 B 轮询时看到的却是
  // 「一条没有 output 的旧任务」，detail 永远盖不上。生产里 state 与 output 是
  // pgboss.job **同一行**的两个字段，A 写的 output B 必然读得到。
  //
  // 现在两者合成一条记录（见 FakeBoss.jobs），本用例钉死：A 写、B 读、B 盖 detail。
  it('A7c 副本 A 写下的 yield report，副本 B 轮询时读得到并盖进 node detail', async () => {
    const sharedJobs = new Map<string, { state: string; output?: unknown }>();
    const bossA = new FakeBoss(sharedJobs);
    const bossB = new FakeBoss(sharedJobs);
    const dag = dagOf(member('r1'), member('down', ['r1']));

    const outA = await catchUp(bossA, dag, HALF_HOUR_PAST);
    expect(outA.action).toBe('started');
    const runId = outA.action === 'started' ? outA.run.id : '';

    // 副本 A 那侧执行完 r1：静默空跑（试过 3 格、全败），report 随 job.output 落库。
    await completeMemberWithYield(bossA, runId, 'r1', { attempted: 3, succeeded: 0, failed: 3 });

    // 由**副本 B**推进——它必须看得见 A 写下的 output。
    await runOrchestratorTick({
      db,
      boss: bossB,
      dag,
      now: HALF_HOUR_PAST,
      localDate: () => RUN_DATE,
    });

    const r1 = await nodeRow(runId, 'r1');
    expect(r1?.status).toBe('succeeded');
    // ★ 跨副本回写：detail 由 B 盖上，内容来自 A 写的 output。
    expect(r1?.detail).toContain('zero yield');
    expect(r1?.detail).toContain('0/3 resolved unit(s) succeeded');
    // 失败语义未变：硬下游照跑。
    expect((await nodeRow(runId, 'down'))?.status).toBe('enqueued');
  });

  // PR #1075 OCR minor — the window is an ELAPSED-time interval [0, window), not a
  // same-calendar-day subtraction. A plain `minuteOfDay - anchorMinute` silently and
  // permanently disables the catch-up for any anchor whose window crosses local midnight.
  describe('minutesSinceAnchor wraps around local midnight', () => {
    const ELEVEN_PM = 23 * 60; // an anchor moved to 23:00

    it('measures elapsed time, not a same-day offset, for a late-evening anchor', () => {
      // 00:30 local is 90 minutes AFTER a 23:00 anchor — the naive subtraction gives −1350.
      expect(minutesSinceAnchor(new Date('2026-07-26T00:30:00+08:00'), ELEVEN_PM)).toBe(90);
      expect(minutesSinceAnchor(new Date('2026-07-25T23:00:00+08:00'), ELEVEN_PM)).toBe(0);
      expect(minutesSinceAnchor(new Date('2026-07-26T03:00:00+08:00'), ELEVEN_PM)).toBe(240);
    });

    it('still reports a pre-anchor moment as nearly a full day since the LAST anchor', () => {
      // 02:00 with the live 02:30 anchor: 30min BEFORE tonight's anchor = 1410min since
      // yesterday's. Far outside any sane window, so the catch-up correctly waits (test A5).
      expect(minutesSinceAnchor(new Date('2026-07-25T02:00:00+08:00'))).toBe(1410);
      expect(minutesSinceAnchor(new Date('2026-07-25T02:30:00+08:00'))).toBe(0);
      expect(minutesSinceAnchor(new Date('2026-07-25T07:29:00+08:00'))).toBe(299);
    });
  });

  // PR #1075 OCR major/minor — this gate exists to REFUSE, so when it cannot compute an
  // answer it must refuse. The naive forms fail the other way: `NaN >= window` is false
  // (→ "not outside the window" → catch up at any hour), and a >=24h window makes the
  // mod-1440 elapsed always smaller than it (→ same). Both would fire the whole paid chain.
  describe('isWithinCatchUpWindow fails closed', () => {
    it('accepts only a real elapsed reading inside the window', () => {
      expect(isWithinCatchUpWindow(0, 300)).toBe(true);
      expect(isWithinCatchUpWindow(299, 300)).toBe(true);
      expect(isWithinCatchUpWindow(300, 300)).toBe(false);
      expect(isWithinCatchUpWindow(1410, 300)).toBe(false);
    });

    it('refuses (throws) rather than admitting an unreadable clock', () => {
      expect(() => isWithinCatchUpWindow(Number.NaN, 300)).toThrow(/unreadable local clock/);
      expect(() => isWithinCatchUpWindow(Number.POSITIVE_INFINITY, 300)).toThrow(
        /unreadable local clock/,
      );
    });

    it('refuses (throws) rather than honouring a window that cannot discriminate', () => {
      expect(() => isWithinCatchUpWindow(100, MINUTES_PER_DAY)).toThrow(/must be >0 and </);
      expect(() => isWithinCatchUpWindow(100, MINUTES_PER_DAY + 1)).toThrow(/must be >0 and </);
      expect(() => isWithinCatchUpWindow(100, 0)).toThrow(/must be >0 and </);
    });
  });

  // End-to-end companion to the unit tests above. Note the division of labour: an *invalid
  // Date* makes `Intl.formatToParts` THROW (not return NaN), so this case is carried by the
  // catch-up's swallow rather than by the finite-check — the NaN branch itself is pinned by
  // the unit test above. What this one pins is that neither route ends in "start the chain".
  it('A9 an unreadable clock skips instead of firing the chain at an arbitrary hour', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));

    const outcome = await runOrchestratorCatchUp({
      db,
      boss,
      dag,
      now: new Date(Number.NaN),
      localDate: () => RUN_DATE,
    });

    expect(outcome).toEqual({ action: 'skipped', reason: 'error' });
    expect(await runsForDate()).toHaveLength(0);
    expect(boss.memberSends).toHaveLength(0);
  });

  // Contract: the catch-up NEVER throws. A worker that cannot boot drains no queue at all,
  // which is strictly worse than a missed night (start-worker.ts reconcileStuckAiTaskRuns
  // precedent).
  it('A8 never throws when the DB is unreachable — worker boot is not blocked', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const explodingDb = new Proxy(
      {},
      {
        get() {
          throw new Error('simulated DB outage during boot');
        },
      },
    ) as never;

    await expect(
      runOrchestratorCatchUp({
        db: explodingDb,
        boss,
        dag,
        now: HALF_HOUR_PAST,
        localDate: () => RUN_DATE,
      }),
    ).resolves.toEqual({ action: 'skipped', reason: 'error' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YUK-781 B — abandon 跨日 run 时不取消其在飞 pg-boss job。
//
// 旧 run 的 created/retry/active job 在 abandon 后仍会执行、写业务数据，而今日新 run 会再发
// 一遍同名成员 → 重复付费 + 旧 job 绕过新图依赖门。
// ─────────────────────────────────────────────────────────────────────────────
describe('YUK-781 B — cancelling in-flight jobs of an abandoned run', () => {
  const YESTERDAY = '2026-07-24';
  const LAST_NIGHT = new Date('2026-07-24T02:30:00+08:00');

  beforeEach(async () => {
    await resetDb();
  });

  /** 起一条"昨夜"的 run（根已 enqueue、下游仍 pending），模拟 worker 中途挂掉的残留。 */
  async function startLastNightRun(boss: FakeBoss, dag: ReturnType<typeof dagOf>) {
    return must(
      await runOrchestratorStart(
        { db, boss, dag, now: LAST_NIGHT, localDate: () => YESTERDAY },
        'cron',
      ),
      'last night run',
    );
  }

  it('B1 the old run’s enqueued job is cancelled before the run is abandoned', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const old = await startLastNightRun(boss, dag);
    const oldJobId = must((await nodeRow(old.id, 'a'))?.boss_job_id, 'old boss job id');
    expect(boss.isExecutable('a', oldJobId)).toBe(true); // pg-boss would still hand it to a worker

    await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron');

    // The stale job can no longer run and write business data.
    expect(boss.cancels).toContainEqual({ name: 'a', id: oldJobId });
    expect(boss.jobState('a', oldJobId)).toBe('cancelled');
    expect(boss.isExecutable('a', oldJobId)).toBe(false);

    const oldRun = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, old.id))
    )[0];
    expect(oldRun.status).toBe('abandoned');
    // The abandoned run's node rows settle instead of showing phantom "enqueued" forever.
    const oldA = await nodeRow(old.id, 'a');
    expect(oldA?.status).toBe('failed');
    expect(oldA?.detail).toMatch(/pg-boss job cancelled/);
    // A never-enqueued node settles as `skipped`, not `failed` — it did not run at all, and
    // counting it as a failure would inflate the failure tally on the read surface (YUK-774).
    const oldB = await nodeRow(old.id, 'b');
    expect(oldB?.status).toBe('skipped');
    expect(oldB?.detail).toMatch(/before this node was enqueued/);
  });

  it('B2 tonight’s run re-sends the same member under a NEW id, and only that one can run', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const old = await startLastNightRun(boss, dag);
    const oldJobId = must((await nodeRow(old.id, 'a'))?.boss_job_id, 'old boss job id');

    const fresh = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'tonight run',
    );
    const newJobId = must((await nodeRow(fresh.id, 'a'))?.boss_job_id, 'new boss job id');

    expect(newJobId).not.toBe(oldJobId);
    // Exactly one executable copy of member 'a' exists — no duplicate paid run, and the old
    // copy (which is NOT bound by tonight's dependency edges) is off the table.
    expect(boss.isExecutable('a', newJobId)).toBe(true);
    expect(boss.isExecutable('a', oldJobId)).toBe(false);
  });

  it('B3 a job already claimed by a worker (active) is cancelled at the row level too', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const old = await startLastNightRun(boss, dag);
    const oldJobId = must((await nodeRow(old.id, 'a'))?.boss_job_id, 'old boss job id');
    // pg-boss handed it to a worker; the handler is mid-flight.
    boss.setJobState('a', oldJobId, 'active');

    await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron');

    // v12 cancelJobs guards on `state < 'completed'`, so active IS covered: the row flips to
    // cancelled and its remaining retry budget is cut off. (Residual, untestable-here risk:
    // the already-running handler is not interrupted, so its current attempt still writes.)
    expect(boss.jobState('a', oldJobId)).toBe('cancelled');
  });

  it('B4 a cancel failure blocks neither the abandon nor tonight’s run', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const old = await startLastNightRun(boss, dag);
    boss.throwOnCancelJobs.add('a');

    const fresh = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'tonight run',
    );

    const oldRun = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, old.id))
    )[0];
    expect(oldRun.status).toBe('abandoned'); //止损失败也不许卡住新一夜
    expect((await nodeRow(old.id, 'a'))?.detail).toMatch(/cancel failed/);
    expect((await nodeRow(fresh.id, 'a'))?.status).toBe('enqueued');
  });

  it('B5 an already-terminal node of the old run is not cancelled', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const old = await startLastNightRun(boss, dag);
    await completeMember(boss, old.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: LAST_NIGHT, localDate: () => YESTERDAY });
    const succeededId = must((await nodeRow(old.id, 'a'))?.boss_job_id, 'succeeded job id');
    const inflightId = must((await nodeRow(old.id, 'b'))?.boss_job_id, 'in-flight job id');

    await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron');

    expect(boss.cancels.map((c) => c.id)).not.toContain(succeededId);
    expect(boss.cancels.map((c) => c.id)).toContain(inflightId);
    expect((await nodeRow(old.id, 'a'))?.status).toBe('succeeded'); // untouched
  });

  it('B6 today’s own active run is never cancelled by a same-day start', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );

    // A manual full-chain rerun / a redelivered cron on the SAME date adopts the run; the
    // in-flight member must keep running.
    await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'manual');

    expect(boss.cancels).toHaveLength(0);
    expect((await nodeRow(run.id, 'a'))?.status).toBe('enqueued');
  });

  // 同族缺口：判超时 failed 会让硬下游按「上游失败」跳过，但那只 job 在 pg-boss 侧仍是
  // created/retry/active，之后照样执行并写数据——图上说"没跑"、实际跑了。
  it('B7 a node judged timed out has its pg-boss job cancelled, not just marked failed', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    const jobId = must((await nodeRow(run.id, 'a'))?.boss_job_id, 'boss job id');
    boss.setJobState('a', jobId, 'retry'); // still inside pg-boss's retry budget

    const wayLater = new Date(NOW.getTime() + 8 * 60 * 60 * 1000);
    await runOrchestratorTick({ db, boss, dag, now: wayLater, localDate: () => RUN_DATE });

    expect((await nodeRow(run.id, 'a'))?.status).toBe('failed');
    expect(boss.cancels).toContainEqual({ name: 'a', id: jobId });
    expect(boss.isExecutable('a', jobId)).toBe(false);
  });

  // PR #1075 OCR major — the per-node try/catch only isolates a NODE. A failure OUTSIDE the
  // loop (loading the old run's nodes) used to escape `runOrchestratorStart` entirely, which
  // skipped the abandon AND stopped tonight's run from being created — one transient DB blip
  // turning a loss-limiter into the very "whole night doesn't run" failure this ticket fixes.
  it('B9 a failure to load the old run’s nodes still abandons it and still starts tonight', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const old = await startLastNightRun(boss, dag);

    const fresh = must(
      await runOrchestratorStart(
        { db: dbWithOneFailingNodeLoad(db), boss, dag, now: NOW, localDate: () => RUN_DATE },
        'cron',
      ),
      'tonight run',
    );

    // The loss-limiter genuinely failed (nothing cancelled — loud-logged), but it did NOT take
    // the night down with it.
    expect(boss.cancels).toHaveLength(0);
    const oldRun = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, old.id))
    )[0];
    expect(oldRun.status).toBe('abandoned');
    expect(fresh.run_date).toBe(RUN_DATE);
    expect((await nodeRow(fresh.id, 'a'))?.status).toBe('enqueued');
  });

  // PR #1075 OCR minor (TOCTOU) — while the sweep runs, the old run must already be closed.
  // If it were still `running`, its tick chain (still sitting in pg-boss from last night) could
  // be consumed mid-sweep and `advanceRun` would claim + send a NEW member job born after our
  // `loadNodes` snapshot — uncancelled, and running against last night's graph.
  it('B10 the old run is already abandoned before the cancel sweep runs', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const old = await startLastNightRun(boss, dag);

    // Observe the old run's status at the moment the first cancel is issued.
    let statusDuringSweep: string | undefined;
    const realCancel = boss.cancel.bind(boss);
    boss.cancel = async (name: string, id: string) => {
      statusDuringSweep ??= (
        await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, old.id))
      )[0]?.status;
      await realCancel(name, id);
    };

    await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron');

    expect(boss.cancels.length).toBeGreaterThan(0); // the sweep really ran
    expect(statusDuringSweep).toBe('abandoned'); // …and the run was already closed to new ticks
  });

  it('B8 a timed-out node whose job row is gone issues no pointless cancel', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    boss.throwOnSendJobs.add('a'); // the send never landed → no job row for the reserved id
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );

    const wayLater = new Date(NOW.getTime() + 8 * 60 * 60 * 1000);
    await runOrchestratorTick({ db, boss, dag, now: wayLater, localDate: () => RUN_DATE });

    expect((await nodeRow(run.id, 'a'))?.detail).toMatch(/not found/);
    expect(boss.cancels).toHaveLength(0);
  });
});

// ── YUK-778 ② 调度控制面的日志可观测出口 ────────────────────────────────────────
//
// `dag_orchestration_run` / `_node` 两张表都在 BACKUP_EXCLUDED 里，读面（YUK-774）还没建，
// 所以「昨晚为什么没跑」在生产上只能从**进程日志**回答。在本票之前那条路是断的：skip /
// fail / abandon 一行不打，连一次成功的夜跑都完全无声——「跑了且全绿」与「worker 根本没起来」
// 在日志里长得一模一样。
//
// 这些用例断言的是 orchestrator 对着**空日志**说话这件事被修好了；YUK-779 修的是另一件
// （succeeded 却零产出），两者互不覆盖。
describe('YUK-778 ② the scheduling control plane leaves a diagnosable trail', () => {
  let logs: { level: 'log' | 'warn' | 'error'; line: string }[];

  beforeEach(async () => {
    await resetDb();
    logs = [];
    const capture =
      (level: 'log' | 'warn' | 'error') =>
      (...args: unknown[]) => {
        logs.push({ level, line: args.map((a) => (typeof a === 'string' ? a : '')).join(' ') });
      };
    vi.spyOn(console, 'log').mockImplementation(capture('log'));
    vi.spyOn(console, 'warn').mockImplementation(capture('warn'));
    vi.spyOn(console, 'error').mockImplementation(capture('error'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const linesMatching = (re: RegExp, level?: 'log' | 'warn' | 'error') =>
    logs.filter((l) => (level ? l.level === level : true) && re.test(l.line)).map((l) => l.line);

  it('L1 a hard-upstream skip names the node, the run and the reason', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await failMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    // warn, not error: a hard-upstream skip is the DESIGNED degradation path, and shouting
    // at the same level as a real failure is how a log stops being read.
    const skips = linesMatching(/node 'b' skipped/, 'warn');
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain(run.id);
    expect(skips[0]).toMatch(/upstream 'a' failed/);
  });

  it('L2 a failed node is logged at error level with its reason', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await failMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const fails = linesMatching(/node 'a' failed/, 'error');
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain(run.id);
    expect(fails[0]).toMatch(/pg-boss job failed/);
  });

  it('L3 a fully successful night is still visible: a start line and a completion census', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );

    // Before this PR the whole of the following produced ZERO log output.
    const started = linesMatching(new RegExp(`run ${run.id} started for ${RUN_DATE}`), 'log');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatch(/trigger=cron/);
    expect(started[0]).toMatch(/2 member\(s\)/);

    await completeMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    await completeMember(boss, run.id, 'b');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const completed = linesMatching(/completed:/, 'log');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toContain(run.id);
    expect(completed[0]).toMatch(/2\/2 succeeded, 0 failed, 0 skipped/);
  });

  // YUK-778 ③ 的另一半：删掉无人读的 `{ stale: true }` payload 后，`node.stale` 这一列
  // 必须有一个**当下就成立**的读者，否则只是把同一个「建成不通电」从 payload 挪到列上。
  // 收尾总账就是那个读者。
  it('L4 the completion census reports how many nodes were enqueued despite a non-succeeded soft upstream', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', [{ job: 'a', soft: true }]));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await failMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }); // b enqueues, stale
    await completeMember(boss, run.id, 'b');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const completed = linesMatching(/completed:/, 'log');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatch(/1 enqueued despite a non-succeeded soft upstream/);
    // The counter records the soft-edge RELEASE, not execution — a claimed-then-failed node
    // still counts. The wording must not claim the node ran (PR #1083 codex P2).
    expect(completed[0]).not.toMatch(/ran with/);
  });

  // The divergence that forced the wording (PR #1083 codex P2): `node.stale` is written at CLAIM
  // time, so a node counts as stale even when it never executes. Here b is released by the soft
  // edge, claimed, and then killed by a send that created no job — it ran on nothing at all.
  // A census saying "ran with a stale upstream" would send an operator hunting for b's output.
  it('L4b a stale node that never executed is still counted — so the wording must not claim it ran', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', [{ job: 'a', soft: true }]));
    boss.nullSendJobs.add('b'); // send returns null AND no job exists for the reserved id
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await failMember(boss, run.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });

    const b = await nodeRow(run.id, 'b');
    expect(b?.stale).toBe(true); // released by the soft edge…
    expect(b?.status).toBe('failed'); // …but it never ran

    const completed = linesMatching(/completed:/, 'log');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatch(/1 enqueued despite a non-succeeded soft upstream/);
    expect(completed[0]).not.toMatch(/ran with/);
  });

  it('L5 abandoning a leftover run reports it plus the census of where it was stuck', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const yesterday = '2026-07-24';
    const old = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => yesterday }, 'cron'),
      'yesterday run',
    );
    logs.length = 0; // only care about what tonight's anchor says

    await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron');

    const abandoned = linesMatching(new RegExp(`ABANDONING run ${old.id}`), 'error');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toContain(yesterday);

    // The census is the only snapshot of WHERE it was stuck: the sweep right after this line
    // rewrites every non-terminal node, so the scheduling table can no longer answer it.
    const census = linesMatching(new RegExp(`abandoned run ${old.id}`), 'error');
    expect(census).toHaveLength(1);
    expect(census[0]).toMatch(/0\/2 succeeded/);
    expect(census[0]).toMatch(/1 still in flight/); // a was enqueued
    expect(census[0]).toMatch(/1 never started/); // b never got its turn
  });

  // The log is this feature's ONLY output, so it must never report a transition that did not
  // happen. Both `updateNodeStatus` and `finishRun` are CAS writes whose losers still resolve;
  // gating every line on "did the row actually change" is what keeps the trail truthful.
  //
  // HONEST LIMITATION (YUK-778 独立评审 NIT): this case only *exercises* the gate when both ticks
  // read the node as `enqueued` before either writes. If they serialize, the second tick's
  // pollInflightNode returns early (node already terminal) and never reaches settleNode — the
  // assertion still holds, but for a different reason. It is a smoke test for the composed
  // behavior; the deterministic proof that the gate's input is correct is L7/L8.
  it('L6 a losing CAS logs nothing — concurrent ticks settle a node once and report it once', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'), member('b', ['a']));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    await failMember(boss, run.id, 'a');

    await Promise.all([
      runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }),
      runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }),
    ]);

    expect(linesMatching(/node 'a' failed/, 'error')).toHaveLength(1);
  });

  it('L7 finishRun reports whether IT performed the transition, so completion is logged once', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );

    expect(await finishRun(db, run.id, 'completed', NOW)).toBe(true);
    // Second call loses the CAS (status is no longer 'running') — an unconditional log here
    // would announce a second, imaginary completion.
    expect(await finishRun(db, run.id, 'abandoned', NOW)).toBe(false);

    const settled = (
      await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, run.id))
    )[0];
    expect(settled.status).toBe('completed'); // the loser changed nothing
  });

  // The FOURTH way tonight can silently not run, found by the independent review of this PR:
  // the cron redeliver guard. src/server/export/constants.ts:312-316 documents it as a known
  // silent path (an archive restore leaves a `completed` row → the guard skips that whole
  // calendar day). Leaving it unlogged would reproduce, for a different cause, exactly the
  // "did it run, or did nothing happen?" ambiguity this PR exists to remove.
  it('L9 a cron anchor stopped by the redeliver guard says so instead of returning silently', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const first = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    // Drive it to completion so the guard hits the `completed`-row branch (the restore scenario),
    // not the "adopt the running run" branch.
    await completeMember(boss, first.id, 'a');
    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    logs.length = 0;

    const second = await runOrchestratorStart(
      { db, boss, dag, now: NOW, localDate: () => RUN_DATE },
      'cron',
    );

    expect(second).toBeNull(); // behavior unchanged: still no second run, still no re-sent roots
    const guarded = linesMatching(/did NOT start a chain/, 'warn');
    expect(guarded).toHaveLength(1);
    expect(guarded[0]).toContain(first.id);
    expect(guarded[0]).toContain(RUN_DATE);
  });

  it('L8 updateNodeStatus reports whether the terminal guard let the write through', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    const run = must(
      await runOrchestratorStart({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }, 'cron'),
      'run',
    );
    const node = must(await nodeRow(run.id, 'a'), 'node');

    expect(
      await updateNodeStatus(db, node.id, { status: 'failed', detail: 'first', now: NOW }),
    ).toBe(true);
    expect(
      await updateNodeStatus(db, node.id, { status: 'succeeded', detail: 'second', now: NOW }),
    ).toBe(false);
    expect((await nodeRow(run.id, 'a'))?.detail).toBe('first');
  });
});
