// YUK-372 L5 — 供给目标发现 + 派发夜扫 job 的端到端 db 测（真实 Postgres）。
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()，不假设跨文件状态/执行序。
//
// 关注点：job 把 discoverSupplyTargets → dispatchSupplyTargets 串起来并按 status 汇总。
// 成本护栏（7d fingerprint cooldown）的端到端覆盖是 scenario ③——cron 自动付费获取的唯一
// 防 spam 闸，必须有 job 层证据。

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { knowledge, learning_item } from '@/db/schema';
import type { EnqueueFn } from '@/server/question-supply/dispatcher';
import { resetDb } from '../../../../tests/helpers/db';
import { runQuestionSupplyNightly } from './question_supply_nightly';

async function seedKnowledge(id: string, domain = 'wenyan') {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedActiveLearningItem(knowledgeIds: string[]) {
  const now = new Date();
  await db.insert(learning_item).values({
    id: createId(),
    source: 'test',
    title: 'active item',
    content: '',
    knowledge_ids: knowledgeIds,
    status: 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

describe('runQuestionSupplyNightly', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ① empty pool → zero counts, no enqueue (early return before any dispatch).
  it('returns zero counts and enqueues nothing when there are no supply targets', async () => {
    const enqueued: Array<{ queue: string }> = [];
    const enqueue: EnqueueFn = async (queue) => {
      enqueued.push({ queue });
      return 'job';
    };

    const result = await runQuestionSupplyNightly(db, {
      dispatchDeps: { enqueue, tavilyAvailable: () => true },
    });

    expect(result).toEqual({
      considered: 0,
      dispatched: 0,
      manual: 0,
      skipped: 0,
      failed: 0,
    });
    expect(enqueued).toHaveLength(0);
  });

  // ② frontier KC + zero questions → at least one sourcing_web dispatch + experimental:question_supply
  // event with status='dispatched'.
  it('dispatches a frontier_zero target to the sourcing queue and tallies it as dispatched', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);
    // ZERO active questions → frontier_zero gap.

    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const enqueue: EnqueueFn = async (queue, data) => {
      enqueued.push({ queue, data });
      return `job-${enqueued.length}`;
    };

    const result = await runQuestionSupplyNightly(db, {
      // sourcing_web needs Tavily; force-available to isolate wiring from env (TAVILY_API_KEY
      // is unset in tests).
      dispatchDeps: { enqueue, tavilyAvailable: () => true },
    });

    expect(result.considered).toBeGreaterThanOrEqual(1);
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    // The frontier_zero target routed to the sourcing queue.
    expect(enqueued.some((e) => e.queue === 'sourcing')).toBe(true);
    const sourcing = enqueued.find((e) => e.queue === 'sourcing');
    expect(sourcing?.data).toMatchObject({
      trigger: 'knowledge',
      ref_id: kid,
      knowledge_id: kid,
    });
  });

  // ③ idempotency / cooldown: run twice → 2nd run finds the 1st run's dispatched event within the
  // 7d fingerprint cooldown window → skips → NO second enqueue. This is the load-bearing
  // cost guardrail for an automatic paid cron.
  it('SKIPS re-dispatch of the same unsatisfied fingerprint on a second nightly run (cooldown)', async () => {
    const kid = createId();
    await seedKnowledge(kid);
    await seedActiveLearningItem([kid]);

    const enqueued: Array<{ queue: string }> = [];
    const enqueue: EnqueueFn = async (queue) => {
      enqueued.push({ queue });
      return `job-${enqueued.length}`;
    };

    const first = await runQuestionSupplyNightly(db, {
      dispatchDeps: { enqueue, tavilyAvailable: () => true },
    });
    expect(first.dispatched).toBeGreaterThanOrEqual(1);
    const firstEnqueueCount = enqueued.length;
    expect(firstEnqueueCount).toBeGreaterThanOrEqual(1);

    // Second nightly run: gap still unsatisfied (KC still has zero active questions) → same
    // fingerprint → cooldown SKIP. No new boss.send.
    const second = await runQuestionSupplyNightly(db, {
      dispatchDeps: { enqueue, tavilyAvailable: () => true },
    });
    expect(second.dispatched).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    // The crux: no additional enqueue on the second run.
    expect(enqueued).toHaveLength(firstEnqueueCount);
  });

  // ④ single-target dispatch throws → swallowed by dispatchSupplyTargets' per-target try/catch →
  // counted as failed, other targets still dispatch. Use an enqueue that throws on the first call
  // only, then succeeds — so with >=2 frontier targets one fails and the rest proceed.
  it('isolates a per-target dispatch throw: failed counted, remaining targets still dispatch', async () => {
    // Two distinct frontier KCs → two frontier_zero targets.
    const kidA = createId();
    const kidB = createId();
    await seedKnowledge(kidA);
    await seedKnowledge(kidB);
    await seedActiveLearningItem([kidA]);
    await seedActiveLearningItem([kidB]);

    let calls = 0;
    const succeeded: string[] = [];
    const enqueue: EnqueueFn = async (queue) => {
      calls++;
      if (calls === 1) {
        // First enqueue throws — dispatchSupplyTarget catches it → failed result.
        throw new Error('simulated boss.send failure');
      }
      succeeded.push(queue);
      return `job-${calls}`;
    };

    const result = await runQuestionSupplyNightly(db, {
      dispatchDeps: { enqueue, tavilyAvailable: () => true },
    });

    // Both targets were considered; one enqueue failed, the other(s) dispatched.
    expect(result.considered).toBeGreaterThanOrEqual(2);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    // The second target's enqueue actually ran (not aborted by the first's throw).
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
  });
});
