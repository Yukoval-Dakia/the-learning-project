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

const db = testDb();
const RUN_DATE = '2026-07-25';
const NOW = new Date('2026-07-25T02:30:00+08:00');

/** fake pg-boss：记录 send，按 (name,id) 回放可编程 state。 */
class FakeBoss implements OrchestratorBoss {
  memberSends: { name: string; data: { stale?: boolean } }[] = [];
  tickSends = 0;
  /** member job names for which send() returns null (models pg-boss "no job created"). */
  nullSendJobs = new Set<string>();
  private states = new Map<string, string>();
  private counter = 0;

  async send(name: string, data: object): Promise<string | null> {
    if (name === ORCHESTRATOR_QUEUE) {
      this.tickSends += 1;
      return `tick_${this.tickSends}`;
    }
    this.memberSends.push({ name, data: data as { stale?: boolean } });
    if (this.nullSendJobs.has(name)) return null;
    this.counter += 1;
    const id = `boss_${this.counter}`;
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
    expect(a?.detail).toMatch(/boss\.send returned null/);
    expect(a?.boss_job_id).toBeNull();

    await runOrchestratorTick({ db, boss, dag, now: NOW, localDate: () => RUN_DATE });
    expect((await nodeRow(run.id, 'b'))?.status).toBe('skipped');
    // b never enqueued (its only send would be its own; a's null send is recorded but no boss_job_id).
    expect(boss.memberSends.filter((s) => s.name === 'b')).toHaveLength(0);
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
