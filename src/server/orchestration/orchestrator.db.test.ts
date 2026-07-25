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
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { ORCHESTRATOR_QUEUE } from './constants';
import { type OrchestratorBoss, runOrchestratorStart, runOrchestratorTick } from './orchestrator';
import { updateNodeStatus } from './store';

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
  /** member job names for which send() returns null (models pg-boss "no job created"). */
  nullSendJobs = new Set<string>();
  /** member job names whose send() throws — models a crash/transient failure after the claim commit. */
  throwOnSendJobs = new Set<string>();
  private states = new Map<string, string>();
  private counter = 0;

  async send(
    name: string,
    data: object,
    options?: { startAfter?: number; id?: string },
  ): Promise<string | null> {
    if (name === ORCHESTRATOR_QUEUE) {
      this.tickSends += 1;
      return `tick_${this.tickSends}`;
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
    if (this.states.has(`${name}:${id}`)) return null;
    this.states.set(`${name}:${id}`, 'created');
    return id;
  }

  async getJobById(name: string, id: string): Promise<{ state: string } | null> {
    const state = this.states.get(`${name}:${id}`);
    return state ? { state } : null;
  }

  setJobState(name: string, id: string, state: string): void {
    this.states.set(`${name}:${id}`, state);
  }

  /** 该 (name,id) 是否真的存在一条 job 行。 */
  hasJob(name: string, id: string): boolean {
    return this.states.has(`${name}:${id}`);
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

  it('④ soft upstream failure → downstream runs anyway with stale:true', async () => {
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
    expect(bSend?.data).toEqual({ stale: true });
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

  it('tick with no active run is a no-op', async () => {
    const boss = new FakeBoss();
    const dag = dagOf(member('a'));
    await expect(
      runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE }),
    ).resolves.toBeUndefined();
    expect(boss.memberSends).toHaveLength(0);
  });
});
