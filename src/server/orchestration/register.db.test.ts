// YUK-758 — orchestrator 挂载器的两条运行期契约（review ToTaz / ToTa0）。
//
// DB 分区（不碰 DB，但 register.ts 经 queue-config → boss/client 实装 import 了 pg-boss，
// 按分区纪律不得进 unit config）。boss 用 fake，断言挂载副作用而非真跑队列。

import type { PgBoss } from 'pg-boss';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CapabilityManifest } from '@/kernel/manifest';
import { ORCHESTRATOR_QUEUE } from './constants';
import {
  parseOrchestratorPayload,
  registerOrchestrator,
  resetOrchestratorMountForTest,
} from './register';

/** 记录挂载副作用的 fake boss（只实现 registerOrchestrator 用到的方法）。 */
class FakeBoss {
  createdQueues: string[] = [];
  workedQueues: string[] = [];
  unscheduled: string[] = [];
  scheduled: string[] = [];

  async createQueue(name: string): Promise<void> {
    this.createdQueues.push(name);
  }
  async updateQueue(name: string): Promise<void> {
    this.createdQueues.push(`update:${name}`);
  }
  async work(name: string): Promise<string> {
    this.workedQueues.push(name);
    return `worker_${name}`;
  }
  async unschedule(name: string): Promise<void> {
    this.unscheduled.push(name);
  }
  async schedule(name: string): Promise<void> {
    this.scheduled.push(name);
  }
}

const capability = (name: string, jobs: { name: string; dependsOn?: [] }[]): CapabilityManifest =>
  ({
    name,
    jobs: { handlers: jobs.map((j) => ({ ...j, queue: 'llm', load: async () => async () => {} })) },
  }) as unknown as CapabilityManifest;

describe('registerOrchestrator mount guard', () => {
  beforeEach(() => {
    resetOrchestratorMountForTest();
  });

  it('mounts the worker and anchor cron once, and unschedules every member', async () => {
    const boss = new FakeBoss();
    const caps = [capability('practice', [{ name: 'a', dependsOn: [] }, { name: 'bare_cron' }])];

    await registerOrchestrator(boss as unknown as PgBoss, {} as never, caps);

    expect(boss.workedQueues).toEqual([ORCHESTRATOR_QUEUE]);
    expect(boss.scheduled).toEqual([ORCHESTRATOR_QUEUE]);
    // only DAG members (dependsOn declared) get unscheduled; bare cron jobs are untouched.
    expect(boss.unscheduled).toEqual(['a']);
  });

  // A second registration in the same process would mount a SECOND boss.work consumer on
  // the orchestrator queue — i.e. two anchors driving the same nightly graph.
  it('is idempotent: a duplicate registration mounts nothing more', async () => {
    const boss = new FakeBoss();
    const caps = [capability('practice', [{ name: 'a', dependsOn: [] }])];

    await registerOrchestrator(boss as unknown as PgBoss, {} as never, caps);
    await registerOrchestrator(boss as unknown as PgBoss, {} as never, caps);

    expect(boss.workedQueues).toEqual([ORCHESTRATOR_QUEUE]);
    expect(boss.scheduled).toEqual([ORCHESTRATOR_QUEUE]);
  });

  it('does not mount at all when no DAG members are declared', async () => {
    const boss = new FakeBoss();
    const caps = [capability('practice', [{ name: 'bare_cron' }])];

    await registerOrchestrator(boss as unknown as PgBoss, {} as never, caps);

    expect(boss.workedQueues).toEqual([]);
    expect(boss.scheduled).toEqual([]);
  });
});

describe('parseOrchestratorPayload', () => {
  it('accepts the three shapes the orchestrator queue actually sends', () => {
    expect(parseOrchestratorPayload({})).toEqual({});
    expect(parseOrchestratorPayload(null)).toEqual({});
    expect(parseOrchestratorPayload(undefined)).toEqual({});
    expect(parseOrchestratorPayload({ tick: true })).toEqual({ tick: true });
    expect(parseOrchestratorPayload({ trigger: 'manual' })).toEqual({ trigger: 'manual' });
  });

  // A malformed payload previously slid through a bare `as` into the start branch and
  // re-ran the whole nightly chain as if cron had fired.
  it('rejects malformed payloads instead of defaulting them into a full chain rerun', () => {
    expect(() => parseOrchestratorPayload({ trigger: 'cron' })).toThrow(/'trigger' must be/);
    expect(() => parseOrchestratorPayload({ trigger: 'wat' })).toThrow(/'trigger' must be/);
    expect(() => parseOrchestratorPayload({ tick: 'yes' })).toThrow(/'tick' must be boolean/);
    expect(() => parseOrchestratorPayload('start')).toThrow(/not an object/);
    expect(() => parseOrchestratorPayload([1, 2])).toThrow(/not an object/);
  });
});
