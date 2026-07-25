// YUK-758 — orchestrator 挂载器的两条运行期契约（review ToTaz / ToTa0）。
//
// DB 分区（不碰 DB，但 register.ts 经 queue-config → boss/client 实装 import 了 pg-boss，
// 按分区纪律不得进 unit config）。boss 用 fake，断言挂载副作用而非真跑队列。

import type { PgBoss } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapabilityManifest } from '@/kernel/manifest';
import { EXPIRE_AGENT, JOB_RETRY_DELAY_SECONDS, JOB_RETRY_LIMIT } from '@/server/boss/queue-config';
import {
  LAYER_STAGGER_MAX_SECONDS,
  NODE_TIMEOUT_SECONDS,
  ORCHESTRATOR_DLQ,
  ORCHESTRATOR_QUEUE,
} from './constants';
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
  /** YUK-778 — createQueue 的 (name, opts)，按调用顺序。纯观察，不新增任何行为。 */
  createQueueCalls: { name: string; opts?: Record<string, unknown> }[] = [];
  /** member names whose unschedule rejects (models a transient DB failure). */
  failUnschedule = new Set<string>();

  async createQueue(name: string, opts?: Record<string, unknown>): Promise<void> {
    this.createdQueues.push(name);
    this.createQueueCalls.push({ name, opts });
  }
  async updateQueue(name: string): Promise<void> {
    this.createdQueues.push(`update:${name}`);
  }
  async work(name: string): Promise<string> {
    this.workedQueues.push(name);
    return `worker_${name}`;
  }
  async unschedule(name: string): Promise<void> {
    if (this.failUnschedule.has(name)) throw new Error(`simulated unschedule failure: ${name}`);
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

  // YUK-758 review ToTvLr — a legacy cron left registered while the anchor also drives
  // that member means duplicate PAID jobs and a bypassed dependency gate, and it persists
  // until the process restarts. Fail the mount loudly instead.
  it('aborts the mount when a legacy cron cannot be cleared, and registers no worker or anchor', async () => {
    const boss = new FakeBoss();
    boss.failUnschedule.add('b');
    const caps = [
      capability('practice', [
        { name: 'a', dependsOn: [] },
        { name: 'b', dependsOn: [] },
      ]),
    ];

    await expect(
      registerOrchestrator(boss as unknown as PgBoss, {} as never, caps),
    ).rejects.toThrow(/could not clear legacy cron/);

    // Nothing half-mounted: no anchor cron, and no consumer left behind.
    expect(boss.scheduled).toEqual([]);
    expect(boss.workedQueues).toEqual([]);
  });

  // ToTsdt — boss.work has no rollback, so it must come after every fallible step;
  // otherwise a caught-and-retried registration stacks a second consumer on the queue
  // and every orchestrator job (including paid root jobs) runs twice.
  it('registers the worker only after unschedule and schedule succeed', async () => {
    const boss = new FakeBoss();
    boss.failUnschedule.add('a');
    const caps = [capability('practice', [{ name: 'a', dependsOn: [] }])];

    await expect(
      registerOrchestrator(boss as unknown as PgBoss, {} as never, caps),
    ).rejects.toThrow();
    expect(boss.workedQueues).toEqual([]); // no orphaned consumer

    // The latch was rolled back, so a retry can mount cleanly — and still only one worker.
    boss.failUnschedule.clear();
    await registerOrchestrator(boss as unknown as PgBoss, {} as never, caps);
    expect(boss.workedQueues).toEqual([ORCHESTRATOR_QUEUE]);
    expect(boss.scheduled).toEqual([ORCHESTRATOR_QUEUE]);
  });

  // YUK-781 A — the mount now runs a boot catch-up for a missed anchor. That catch-up is a
  // best-effort loss-limiter; a worker that fails to boot drains NO queue at all, which is
  // strictly worse than one missed night. So a catch-up that cannot even reach the DB must
  // leave the mount intact (start-worker.ts reconcileStuckAiTaskRuns precedent).
  //
  // The clock is pinned INSIDE the catch-up window on purpose: the window gate short-circuits
  // before any DB access, so at a wall-clock time outside 02:30–07:30 Asia/Shanghai this test
  // would pass without ever exercising the failure path it claims to cover.
  it('completes the mount even when the boot catch-up cannot reach the DB', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-25T03:00:00+08:00'));
      const boss = new FakeBoss();
      const caps = [capability('practice', [{ name: 'a', dependsOn: [] }])];
      const explodingDb = new Proxy(
        {},
        {
          get() {
            throw new Error('simulated DB outage during worker boot');
          },
        },
      ) as never;

      await expect(
        registerOrchestrator(boss as unknown as PgBoss, explodingDb, caps),
      ).resolves.toBeUndefined();
      expect(boss.workedQueues).toEqual([ORCHESTRATOR_QUEUE]);
      expect(boss.scheduled).toEqual([ORCHESTRATOR_QUEUE]);
    } finally {
      vi.useRealTimers();
    }
  });

  // YUK-778 ① — the mount must actually route through the DLQ-backed recipe. The real pg-boss
  // proof that the resulting config lands in `pgboss.queue` lives in
  // orchestrator-queue-policy.db.test.ts; this case pins the other half of the chain — that the
  // mount calls it AT ALL, and in the only order pg-boss accepts (the DLQ is a FK target and is
  // resolved through getQueueCache, so creating the main queue first throws).
  it('creates the dead-letter queue before the orchestrator queue that references it', async () => {
    const boss = new FakeBoss();
    const caps = [capability('practice', [{ name: 'a', dependsOn: [] }])];

    await registerOrchestrator(boss as unknown as PgBoss, {} as never, caps);

    const dlqAt = boss.createQueueCalls.findIndex((c) => c.name === ORCHESTRATOR_DLQ);
    const mainAt = boss.createQueueCalls.findIndex((c) => c.name === ORCHESTRATOR_QUEUE);
    expect(dlqAt).toBeGreaterThanOrEqual(0);
    expect(mainAt).toBeGreaterThanOrEqual(0);
    expect(dlqAt).toBeLessThan(mainAt);
    expect(boss.createQueueCalls[mainAt].opts).toMatchObject({
      deadLetter: ORCHESTRATOR_DLQ,
      retryDelay: JOB_RETRY_DELAY_SECONDS,
      retryLimit: JOB_RETRY_LIMIT,
      retryBackoff: true,
    });
  });

  it('does not mount at all when no DAG members are declared', async () => {
    const boss = new FakeBoss();
    const caps = [capability('practice', [{ name: 'bare_cron' }])];

    await registerOrchestrator(boss as unknown as PgBoss, {} as never, caps);

    expect(boss.workedQueues).toEqual([]);
    expect(boss.scheduled).toEqual([]);
  });
});

// YUK-758 review ToTsds — NODE_TIMEOUT_SECONDS is a literal derived from queue-config's
// retry budget, with only a ⚠️ comment asking future editors to recompute it. That is not
// a guard. `constants.ts` stays dependency-free on purpose (queue-config transitively
// imports a live pg-boss, and this repo enforces a unit/DB partition to stop that spreading),
// so the invariant is pinned HERE instead — this file is already in the DB partition.
describe('NODE_TIMEOUT_SECONDS covers the pg-boss retry budget', () => {
  it('exceeds the worst-case legal lifetime of an agent-tier member job', () => {
    // Worst case: every attempt runs to the queue expiry ceiling, plus the backoff waits
    // between them, plus the largest stagger this orchestrator can add before the job
    // even starts. enqueued_at is stamped once at claim time and NOT reset per retry,
    // so the node timeout is measured against this whole span.
    const attempts = 1 + JOB_RETRY_LIMIT;
    const retryBackoff = JOB_RETRY_DELAY_SECONDS * (2 ** JOB_RETRY_LIMIT - 1); // 30 + 60
    const worstCase = attempts * EXPIRE_AGENT + retryBackoff + LAYER_STAGGER_MAX_SECONDS;

    expect(
      NODE_TIMEOUT_SECONDS,
      `NODE_TIMEOUT_SECONDS (${NODE_TIMEOUT_SECONDS}s) must exceed the worst-case member lifetime (${worstCase}s). If EXPIRE_AGENT / JOB_RETRY_LIMIT / JOB_RETRY_DELAY_SECONDS / LAYER_STAGGER_MAX_SECONDS changed, recompute it — too small silently fails nodes mid-retry and permanently skips their hard downstreams.`,
    ).toBeGreaterThan(worstCase);
  });
});

describe('parseOrchestratorPayload', () => {
  it('accepts the shapes the orchestrator queue actually sends', () => {
    expect(parseOrchestratorPayload({})).toEqual({});
    expect(parseOrchestratorPayload(null)).toEqual({});
    expect(parseOrchestratorPayload(undefined)).toEqual({});
    expect(parseOrchestratorPayload({ tick: true })).toEqual({ tick: true });
    expect(parseOrchestratorPayload({ trigger: 'manual' })).toEqual({ trigger: 'manual' });
    // ToTvLt — the self-scheduled tick carries its run id.
    expect(parseOrchestratorPayload({ tick: true, runId: 'run_1' })).toEqual({
      tick: true,
      runId: 'run_1',
    });
  });

  it('rejects a runId that is malformed or attached to the wrong shape', () => {
    expect(() => parseOrchestratorPayload({ tick: true, runId: '' })).toThrow(/non-empty string/);
    expect(() => parseOrchestratorPayload({ tick: true, runId: 7 })).toThrow(/non-empty string/);
    // runId only travels with a tick; on a cron/manual payload it means a shape mix-up.
    expect(() => parseOrchestratorPayload({ runId: 'run_1' })).toThrow(/only valid with tick/);
    expect(() => parseOrchestratorPayload({ trigger: 'manual', runId: 'run_1' })).toThrow(
      /only valid with tick/,
    );
  });

  // A malformed payload previously slid through a bare `as` into the start branch and
  // re-ran the whole nightly chain as if cron had fired.
  it('rejects malformed payloads instead of defaulting them into a full chain rerun', () => {
    expect(() => parseOrchestratorPayload({ trigger: 'cron' })).toThrow(/'trigger' must be/);
    expect(() => parseOrchestratorPayload({ trigger: 'wat' })).toThrow(/'trigger' must be/);
    expect(() => parseOrchestratorPayload({ tick: 'yes' })).toThrow(/'tick' must be exactly true/);
    expect(() => parseOrchestratorPayload('start')).toThrow(/not an object/);
    expect(() => parseOrchestratorPayload([1, 2])).toThrow(/not an object/);
  });

  // YUK-758 review ToTe7 — each of these is type-plausible but would silently land in
  // the cron start branch (or silently drop manual semantics), i.e. one slipped field
  // burns a whole night of paid LLM root jobs.
  it('rejects the three near-miss shapes that would silently start a full chain', () => {
    // `tick: false` is a valid boolean but falls through to the start branch.
    expect(() => parseOrchestratorPayload({ tick: false })).toThrow(/'tick' must be exactly true/);
    // an unknown key is ignored under a permissive parser → treated as cron.
    expect(() => parseOrchestratorPayload({ manual: true })).toThrow(/unexpected job payload key/);
    // both set: tick wins and the manual intent is silently swallowed.
    expect(() => parseOrchestratorPayload({ tick: true, trigger: 'manual' })).toThrow(
      /mutually exclusive/,
    );
  });
});
