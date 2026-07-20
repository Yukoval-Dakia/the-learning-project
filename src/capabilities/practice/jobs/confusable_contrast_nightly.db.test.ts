// YUK-734 — end-to-end db test for the confusable-contrast supply nightly (real Postgres).
// Twin of question_supply_nightly.db.test.ts: this paid-acquisition cron (manifest.ts
// registers `confusable_contrast_nightly`, cron 20 6 * * *, queue llm) triggers paid LLM
// quiz_gen via the dispatcher. Its ONLY cost guards are the dispatcher's 7d fingerprint
// cooldown + this job's per-run cap (DEFAULT_MAX_PER_RUN=25, the G-COST red line). Before
// this file it had ZERO coverage, so a regression dropping the slice (or an off-by-one in
// `deferred`) would flood the paid quiz_gen queue undetected.
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()，不假设跨文件状态/执行序。

import { db } from '@/db/client';
import { event, knowledge, misconception_edge } from '@/db/schema';
import type { EnqueueFn } from '@/server/question-supply/dispatcher';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { runConfusableContrastNightly } from './confusable_contrast_nightly';

async function seedKnowledge(id: string, domain = 'yuwen') {
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

async function seedEdge(opts: {
  fromId: string;
  toKind: 'misconception' | 'knowledge' | 'event';
  toId: string;
  relationType: string;
  weight?: number;
}): Promise<void> {
  const now = new Date();
  await db.insert(misconception_edge).values({
    id: createId(),
    from_kind: 'misconception',
    from_id: opts.fromId,
    to_kind: opts.toKind,
    to_id: opts.toId,
    relation_type: opts.relationType,
    weight: opts.weight ?? 1,
    created_by: { by: 'system' },
    proposed_by_ai: true,
    created_at: now,
    updated_at: now,
    archived_at: null,
  });
}

// M1 caused_by A, M2 caused_by B, M1 confusable_with M2 → confusable pair [A,B].
// Distinct misconception + KC ids per call so N calls mint N distinct pairs (distinct
// fingerprints), unlike the discovery test's single hardcoded pair.
async function seedConfusablePair(weight = 0.8): Promise<{ kcA: string; kcB: string }> {
  const mcA = `mc_${createId()}`;
  const mcB = `mc_${createId()}`;
  const kcA = `kc_${createId()}`;
  const kcB = `kc_${createId()}`;
  await seedKnowledge(kcA);
  await seedKnowledge(kcB);
  await seedEdge({ fromId: mcA, toKind: 'knowledge', toId: kcA, relationType: 'caused_by' });
  await seedEdge({ fromId: mcB, toKind: 'knowledge', toId: kcB, relationType: 'caused_by' });
  await seedEdge({
    fromId: mcA,
    toKind: 'misconception',
    toId: mcB,
    relationType: 'confusable_with',
    weight,
  });
  return { kcA, kcB };
}

describe('runConfusableContrastNightly', () => {
  const prev = process.env.CONFUSABLE_CONTRAST_ENABLED;
  beforeEach(async () => {
    await resetDb();
    process.env.CONFUSABLE_CONTRAST_ENABLED = '1'; // ON by default; the OFF case opts out.
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    if (prev === undefined) delete process.env.CONFUSABLE_CONTRAST_ENABLED;
    else process.env.CONFUSABLE_CONTRAST_ENABLED = prev;
  });

  // ① flag OFF → discovery is a NO-OP → zero-target early return → all-zero result AND
  // dispatchSupplyTargets is NEVER called (no paid job). Guards the flag-gated dark path.
  it('flag OFF → all-zero result and never enqueues a paid job', async () => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.CONFUSABLE_CONTRAST_ENABLED;
    await seedConfusablePair(); // a confusable pair exists, but the flag keeps it dark.

    const enqueued: Array<{ queue: string }> = [];
    const enqueue: EnqueueFn = async (queue) => {
      enqueued.push({ queue });
      return 'job';
    };

    const result = await runConfusableContrastNightly(db, { dispatchDeps: { enqueue } });

    expect(result).toEqual({
      discovered: 0,
      considered: 0,
      deferred: 0,
      dispatched: 0,
      manual: 0,
      skipped: 0,
      failed: 0,
    });
    expect(enqueued).toHaveLength(0);
  });

  // ② flag ON + one confusable pair → one quiz_gen dispatch. Confusable targets route to
  // quiz_gen (routePreference, minSourceTier=3, closed_book → no Tavily dependency).
  it('dispatches a confusable pair to the quiz_gen queue and tallies it as dispatched', async () => {
    await seedConfusablePair();

    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const enqueue: EnqueueFn = async (queue, data) => {
      enqueued.push({ queue, data });
      return `job-${enqueued.length}`;
    };

    const result = await runConfusableContrastNightly(db, { dispatchDeps: { enqueue } });

    expect(result.discovered).toBe(1);
    expect(result.considered).toBe(1);
    expect(result.deferred).toBe(0);
    expect(result.dispatched).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.queue).toBe('quiz_gen');
    // Observability event was written with status='dispatched' (the cooldown ledger).
    const supplyEvents = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.action, 'experimental:question_supply'));
    expect(supplyEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ③ per-run cap (G-COST red line): many discovered targets but maxPerRun=1 → only the
  // single highest-priority target is dispatched; the rest are deferred. This is the
  // accident hard-cap preventing a first run (before the 7d cooldown takes effect) from
  // flooding the paid quiz_gen queue with every confusable pair at once.
  it('caps per-run dispatch to maxPerRun and defers the rest (G-COST)', async () => {
    await seedConfusablePair();
    await seedConfusablePair();
    await seedConfusablePair(); // three distinct confusable pairs → three targets.

    const enqueued: Array<{ queue: string }> = [];
    const enqueue: EnqueueFn = async (queue) => {
      enqueued.push({ queue });
      return `job-${enqueued.length}`;
    };

    const result = await runConfusableContrastNightly(db, {
      maxPerRun: 1,
      dispatchDeps: { enqueue },
    });

    expect(result.discovered).toBe(3);
    expect(result.considered).toBe(1);
    expect(result.deferred).toBe(2); // discovered − considered
    expect(result.dispatched).toBe(1);
    // The crux: exactly one enqueue despite three discovered targets — no flood.
    expect(enqueued).toHaveLength(1);
  });

  // ④ per-target dispatch throw is isolated: enqueue throws on the first target only →
  // that target is counted as failed while the remaining target still dispatches, and the
  // status tally sums back to considered (dispatched + failed).
  it('isolates a per-target dispatch throw: failed counted, remaining target still dispatches', async () => {
    await seedConfusablePair();
    await seedConfusablePair(); // two distinct targets.

    let calls = 0;
    const enqueue: EnqueueFn = async (queue) => {
      calls++;
      if (calls === 1) throw new Error('simulated boss.send failure');
      return `job-${calls}`;
    };

    const result = await runConfusableContrastNightly(db, { dispatchDeps: { enqueue } });

    expect(result.considered).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.dispatched).toBe(1);
    // Tally is exhaustive: every considered target lands in exactly one status bucket.
    expect(result.dispatched + result.manual + result.skipped + result.failed).toBe(
      result.considered,
    );
  });

  // ⑤ cooldown / idempotency: run twice → the 2nd run finds the 1st run's dispatched
  // fingerprint within the 7d cooldown window → skips → NO second enqueue. This is the
  // load-bearing cost guardrail for an automatic paid cron (mirrors the question_supply twin).
  it('SKIPS re-dispatch of the same fingerprint on a second nightly run (cooldown)', async () => {
    await seedConfusablePair();

    const enqueued: Array<{ queue: string }> = [];
    const enqueue: EnqueueFn = async (queue) => {
      enqueued.push({ queue });
      return `job-${enqueued.length}`;
    };

    const first = await runConfusableContrastNightly(db, { dispatchDeps: { enqueue } });
    expect(first.dispatched).toBe(1);
    expect(enqueued).toHaveLength(1);

    // Second run: same pair → same fingerprint → cooldown SKIP, no new boss.send.
    const second = await runConfusableContrastNightly(db, { dispatchDeps: { enqueue } });
    expect(second.dispatched).toBe(0);
    expect(second.skipped).toBe(1);
    expect(enqueued).toHaveLength(1); // still one — no re-dispatch.
  });
});
