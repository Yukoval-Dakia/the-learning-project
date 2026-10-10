// YUK-758 — orchestrator 触发语义 DB 测试。
//
// 用合成图（非真 manifest，保持 scope 无关）+ fake boss，验证：
//   ① start 建 run + 落节点 + enqueue 根；
//   ② 硬上游成功 → 下游 enqueue；
//   ③ 硬上游失败 → 下游 skipped + 留痕；
//   ④ 软上游失败 → 下游照跑（enqueue 带 stale:true）；
//   ⑤ 全终态 → run 收尾 completed，不再自调度 tick；
//   ⑥ 单飞：同日重复 start 不建第二条 run。

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dag_orchestration_node, dag_orchestration_run } from '@/db/schema';
import { type JobDagMemberInput, buildJobDag } from '@/kernel/job-dag';
import {
  beginTestTransaction,
  resetDb,
  rollbackTestTransaction,
  testDb,
} from '../../../tests/helpers/db';
import { ORCHESTRATOR_QUEUE } from './constants';
import {
  type OrchestratorBoss,
  runOrchestratorCatchUp,
  runOrchestratorStart,
  runOrchestratorTick,
} from './orchestrator';
import { finishRun, updateNodeStatus } from './store';

let db = testDb();
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

describe('orchestrator trigger semantics', () => {
  beforeAll(resetDb);

  beforeEach(async () => {
    await beginTestTransaction();
    db = testDb();
  });

  afterEach(async () => {
    await rollbackTestTransaction();
    db = testDb();
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

  const catchUp = (boss: FakeBoss, dag: ReturnType<typeof dagOf>, now: Date) =>
    runOrchestratorCatchUp({ db, boss, dag, now, localDate: () => RUN_DATE });

  const runsForDate = () =>
    db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.run_date, RUN_DATE));

  beforeEach(async () => {
    await resetDb();
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
