// YUK-761 — placement starter recovery sweeper db tests (real Postgres).
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()，不假设跨文件状态/执行序。
//
// 关注点（票面验证清单 + 首轮评审）：超期 pending_dispatch claim 被重驱、未超期不动、幂等重跑
// 不双发、终态 claim 不受影响；retry_scheduled 的**反向**契约——绝不被重驱（会双发付费批次），
// 只在 grace 到期**且** pg-boss job 确已不能重投时才被收割成 'exhausted'；以及两条腿各自独立
// 取数、每条被访问的 claim 都推进游标（防「同一批老 claim 每夜霸占额度、后面的僵尸永不被收割」
// 的饿死路径）。

import { insertGoal } from '@/capabilities/agency/server/goals/queries';
import { db } from '@/db/client';
import { goal, knowledge, placement_starter_claim, question } from '@/db/schema';
import type { PlacementStarterIdentity } from '@/server/question-supply/placement-starter-identity';
import { materializePlacementStartersForGoal } from '@/server/question-supply/placement-starter-store';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import {
  PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
  PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS,
  sweepStalePlacementStarterClaims,
} from './placement-starter-recovery';

const NOW = new Date('2026-07-25T06:00:00Z');
const CREATED = new Date('2026-07-20T00:00:00Z');

/** Default seam: no pg-boss job is ever live, so the reap leg is governed purely by grace. */
const noJobLive = async () => false;

beforeEach(() => resetDb());

async function seedGoal(): Promise<void> {
  await db.insert(knowledge).values([
    {
      id: 'seed:yuwen:root',
      name: '语文',
      domain: 'yuwen',
      parent_id: null,
      created_at: CREATED,
      updated_at: CREATED,
    },
    {
      id: 'kc-explicit',
      name: '文言实词',
      domain: null,
      parent_id: 'seed:yuwen:root',
      created_at: CREATED,
      updated_at: CREATED,
    },
  ]);
  await insertGoal(db, {
    id: 'goal-1',
    title: '读懂古文',
    subject_id: 'yuwen',
    scope_knowledge_ids: ['kc-explicit'],
    scope_mode: 'explicit',
    sequence_hint: 0,
    source: 'manual',
    now: CREATED,
  });
}

/** Materialize a real pending_dispatch claim through the production path. */
async function seedClaim(): Promise<PlacementStarterIdentity> {
  await seedGoal();
  const { identities } = await db.transaction((tx) =>
    materializePlacementStartersForGoal(tx, 'goal-1', CREATED),
  );
  const identity = identities[0];
  if (!identity) throw new Error('missing placement identity');
  return identity;
}

/** Insert a synthetic claim directly (for multi-claim ordering / starvation scenarios). */
async function insertClaim(
  i: number,
  overrides: Partial<typeof placement_starter_claim.$inferInsert> = {},
): Promise<string> {
  const id = (overrides.id as string | undefined) ?? `claim-${i}`;
  await db.insert(placement_starter_claim).values({
    id,
    fingerprint: `fp-${id}`,
    goal_id: 'goal-1',
    semantic_goal_revision_id: `rev-${id}`,
    subject_id: 'yuwen',
    knowledge_id: 'kc-explicit',
    demand_id: `demand-${id}`,
    target_id: `target-${id}`,
    status: 'pending_dispatch',
    next_reconcile_at: new Date(CREATED.getTime() + i * 1000),
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  });
  return id;
}

async function readClaim(claimId: string) {
  const [row] = await db
    .select()
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, claimId));
  if (!row) throw new Error(`claim ${claimId} vanished`);
  return row;
}

/** A dispatch seam that records calls and reports the admission verdict it computed. */
function recordingDispatch() {
  const calls: Array<{ claimId: string; admitted: boolean }> = [];
  const dispatch = async (
    dbArg: typeof db,
    claimId: string,
    admit?: (tx: never, claim: never) => Promise<boolean>,
  ): Promise<string | null> => {
    const admitted = admit
      ? await dbArg.transaction((tx) => admit(tx as never, undefined as never))
      : true;
    calls.push({ claimId, admitted });
    return admitted ? `job-${claimId}` : null;
  };
  return { calls, dispatch: dispatch as never };
}

describe('sweepStalePlacementStarterClaims — pending_dispatch re-drive', () => {
  it('re-drives an overdue stranded claim and advances its recovery cursor', async () => {
    const identity = await seedClaim();
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({
      scannedPending: 1,
      redispatched: 1,
      admissionSkipped: 0,
      redispatchFailed: 0,
      lost: 0,
      redispatchSuppressed: false,
      errored: false,
    });
    expect(calls).toEqual([{ claimId: identity.claimId, admitted: true }]);
    const claim = await readClaim(identity.claimId);
    expect(claim.next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
    // The acquire CAS is a scheduler cursor, not a state transition: updated_at/version untouched.
    expect(claim.version).toBe(0);
    expect(claim.updated_at.getTime()).toBe(CREATED.getTime());
  });

  it('leaves a claim whose next_reconcile_at is still in the future untouched', async () => {
    const identity = await seedClaim();
    const future = new Date(NOW.getTime() + 60 * 60_000);
    await db
      .update(placement_starter_claim)
      .set({ next_reconcile_at: future })
      .where(eq(placement_starter_claim.id, identity.claimId));
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result.scannedPending).toBe(0);
    expect(result.redispatched).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await readClaim(identity.claimId)).next_reconcile_at.getTime()).toBe(future.getTime());
  });

  it('is idempotent: a second sweep inside the backoff window re-drives nothing', async () => {
    const identity = await seedClaim();
    const { calls, dispatch } = recordingDispatch();

    await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });
    // The claim is still pending_dispatch (the fake dispatch does not transition it), so ONLY the
    // cursor CAS can prevent a double drive — exactly the anti-double-send contract under test.
    const second = await sweepStalePlacementStarterClaims(db, {
      now: new Date(NOW.getTime() + 60_000),
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(second.scannedPending).toBe(0);
    expect(second.redispatched).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.claimId).toBe(identity.claimId);
  });

  it('refuses paid admission when the goal scope already has an eligible question', async () => {
    const identity = await seedClaim();
    await db.insert(question).values({
      id: 'question-warm',
      kind: 'short_answer',
      prompt_md: 'warm',
      knowledge_ids: ['kc-explicit'],
      difficulty: 3,
      source: 'quiz_gen',
      draft_status: null,
      created_at: new Date('2026-07-21T00:00:00Z'),
      updated_at: new Date('2026-07-21T00:00:00Z'),
    });
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedPending: 1, redispatched: 0, admissionSkipped: 1 });
    expect(calls).toEqual([{ claimId: identity.claimId, admitted: false }]);
    // An admission-refused claim still advanced its cursor (the acquire happens BEFORE dispatch),
    // so it cannot re-occupy a per-run slot next run.
    expect((await readClaim(identity.claimId)).next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
  });

  it('suppresses paid re-dispatch while the placement probe flag is off', async () => {
    await seedClaim();
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: false,
    });

    // The paid leg does not even scan while the flag is off.
    expect(result).toMatchObject({
      scannedPending: 0,
      redispatched: 0,
      redispatchSuppressed: true,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('sweepStalePlacementStarterClaims — anti-starvation', () => {
  // The bug this guards: one shared capped scan ordered by next_reconcile_at would let a backlog
  // of untouched pending_dispatch claims monopolise every run, so a retry_scheduled zombie sorted
  // behind them is NEVER reaped — the blocked-revision failure this sweeper exists to fix.
  it('reaps a zombie even when a full page of older pending claims is suppressed by the flag', async () => {
    await seedGoal();
    for (let i = 0; i < 3; i++) await insertClaim(i);
    const stalled = new Date(NOW.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS - 60_000);
    // Sorts strictly AFTER every pending claim on the shared (next_reconcile_at, created_at) order.
    await insertClaim(99, {
      id: 'claim-zombie',
      status: 'retry_scheduled',
      pg_boss_job_id: 'boss-dead',
      updated_at: stalled,
      next_reconcile_at: new Date(CREATED.getTime() + 99_000),
    });
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      maxPerRun: 3,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({ scannedRetry: 1, reaped: 1, scannedPending: 0 });
    expect(calls).toHaveLength(0);
    expect((await readClaim('claim-zombie')).status).toBe('exhausted');
  });

  it('reaps a zombie even when a full page of older pending claims fills the paid leg', async () => {
    await seedGoal();
    for (let i = 0; i < 3; i++) await insertClaim(i);
    const stalled = new Date(NOW.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS - 60_000);
    await insertClaim(99, {
      id: 'claim-zombie',
      status: 'retry_scheduled',
      pg_boss_job_id: 'boss-dead',
      updated_at: stalled,
      next_reconcile_at: new Date(CREATED.getTime() + 99_000),
    });
    const { dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      maxPerRun: 3,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    // Paid leg saturated at its own cap of 3; the reap leg still got its own full budget.
    expect(result).toMatchObject({
      scannedPending: 3,
      redispatched: 3,
      scannedRetry: 1,
      reaped: 1,
    });
    expect((await readClaim('claim-zombie')).status).toBe('exhausted');
  });

  it('advances the cursor of a goal-missing claim so it cannot squat the budget forever', async () => {
    const identity = await seedClaim();
    await db.delete(goal).where(eq(goal.id, 'goal-1'));
    const { calls, dispatch } = recordingDispatch();

    const first = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(first).toMatchObject({ scannedPending: 1, goalMissing: 1, redispatched: 0 });
    expect(calls).toHaveLength(0);
    const claim = await readClaim(identity.claimId);
    expect(claim.status).toBe('pending_dispatch');
    expect(claim.next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
    // Next run inside the window: the claim no longer occupies a slot.
    const second = await sweepStalePlacementStarterClaims(db, {
      now: new Date(NOW.getTime() + 60_000),
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });
    expect(second.scannedPending).toBe(0);
  });
});

describe('sweepStalePlacementStarterClaims — terminal and non-swept states', () => {
  it.each(['satisfied', 'exhausted', 'cancelled'] as const)(
    'never touches a %s claim',
    async (status) => {
      const identity = await seedClaim();
      await db
        .update(placement_starter_claim)
        .set({
          status,
          satisfied_at: status === 'satisfied' ? NOW : null,
          exhausted_at: status === 'exhausted' ? NOW : null,
          next_reconcile_at: CREATED,
        })
        .where(eq(placement_starter_claim.id, identity.claimId));
      const before = await readClaim(identity.claimId);
      const { calls, dispatch } = recordingDispatch();

      const result = await sweepStalePlacementStarterClaims(db, {
        now: NOW,
        dispatch,
        isJobLive: noJobLive,
        placementProbeEnabled: true,
      });

      expect(result).toMatchObject({ scannedPending: 0, scannedRetry: 0 });
      expect(calls).toHaveLength(0);
      expect(await readClaim(identity.claimId)).toEqual(before);
    },
  );

  it.each(['queued', 'running', 'verifying'] as const)(
    'leaves an in-flight %s claim to the attempt lease machinery',
    async (status) => {
      const identity = await seedClaim();
      await db
        .update(placement_starter_claim)
        .set({ status, next_reconcile_at: CREATED })
        .where(eq(placement_starter_claim.id, identity.claimId));
      const before = await readClaim(identity.claimId);
      const { calls, dispatch } = recordingDispatch();

      const result = await sweepStalePlacementStarterClaims(db, {
        now: NOW,
        dispatch,
        isJobLive: noJobLive,
        placementProbeEnabled: true,
      });

      expect(result).toMatchObject({ scannedPending: 0, scannedRetry: 0 });
      expect(calls).toHaveLength(0);
      expect(await readClaim(identity.claimId)).toEqual(before);
    },
  );
});

describe('sweepStalePlacementStarterClaims — retry_scheduled reap', () => {
  async function seedZombie(): Promise<PlacementStarterIdentity> {
    const identity = await seedClaim();
    const stalled = new Date(NOW.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS - 60_000);
    await db
      .update(placement_starter_claim)
      .set({
        status: 'retry_scheduled',
        pg_boss_job_id: 'boss-job-1',
        updated_at: stalled,
        next_reconcile_at: stalled,
      })
      .where(eq(placement_starter_claim.id, identity.claimId));
    return identity;
  }

  it('reaps a retry_scheduled claim whose job can no longer redeliver, without dispatching', async () => {
    const identity = await seedZombie();
    const { calls, dispatch } = recordingDispatch();
    const probed: Array<string | null> = [];

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: async (jobId) => {
        probed.push(jobId);
        return false;
      },
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedRetry: 1, reaped: 1, retryPending: 0, retryJobLive: 0 });
    expect(probed).toEqual(['boss-job-1']);
    // NEVER re-driven: a second quiz_gen job would double-pay against one claim.
    expect(calls).toHaveLength(0);
    const claim = await readClaim(identity.claimId);
    expect(claim.status).toBe('exhausted');
    expect(claim.exhausted_at?.getTime()).toBe(NOW.getTime());
    expect(claim.satisfied_at).toBeNull();
    expect(claim.last_error_code).toBe('retry_never_redelivered');
  });

  // The hazard: a paused / saturated quiz_gen queue can hold a LEGITIMATE retry unfetched past
  // the grace window. Reaping then makes the eventual delivery fail admission in
  // acquirePlacementAttempt and throws away paid generation work that was still coming.
  it('does NOT reap a past-grace claim whose quiz_gen job is still live', async () => {
    const identity = await seedZombie();
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: async () => true,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedRetry: 1, reaped: 0, retryJobLive: 1 });
    expect(calls).toHaveLength(0);
    const claim = await readClaim(identity.claimId);
    expect(claim.status).toBe('retry_scheduled');
    expect(claim.exhausted_at).toBeNull();
    // Cursor advanced so it is re-probed next window instead of squatting the budget.
    expect(claim.next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
  });

  it('fails safe and defers the reap when the pg-boss job probe throws', async () => {
    const identity = await seedZombie();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: recordingDispatch().dispatch,
      isJobLive: async () => {
        throw new Error('boss unreachable');
      },
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedRetry: 1, reaped: 0, retryJobLive: 1 });
    expect((await readClaim(identity.claimId)).status).toBe('retry_scheduled');
  });

  it('leaves a freshly retry_scheduled claim alone and parks the cursor on its reap deadline', async () => {
    const identity = await seedClaim();
    const recent = new Date(NOW.getTime() - 60_000);
    await db
      .update(placement_starter_claim)
      .set({
        status: 'retry_scheduled',
        pg_boss_job_id: 'boss-job-1',
        updated_at: recent,
        next_reconcile_at: recent,
      })
      .where(eq(placement_starter_claim.id, identity.claimId));
    const probed: Array<string | null> = [];
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: async (jobId) => {
        probed.push(jobId);
        return false;
      },
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedRetry: 1, reaped: 0, retryPending: 1 });
    expect(calls).toHaveLength(0);
    // Inside grace the probe is not even consulted — no pg-boss round trip for the common case.
    expect(probed).toHaveLength(0);
    const claim = await readClaim(identity.claimId);
    expect(claim.status).toBe('retry_scheduled');
    expect(claim.next_reconcile_at.getTime()).toBe(
      recent.getTime() + PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS,
    );
    // updated_at must stay put: it IS the staleness signal the reap deadline is computed from.
    expect(claim.updated_at.getTime()).toBe(recent.getTime());
  });

  it('reaps zombies even while the placement probe flag is off', async () => {
    const identity = await seedZombie();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: recordingDispatch().dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({ reaped: 1, redispatchSuppressed: true });
    expect((await readClaim(identity.claimId)).status).toBe('exhausted');
  });

  it('treats a claim with no pg_boss_job_id as having no redelivery source', async () => {
    const identity = await seedZombie();
    await db
      .update(placement_starter_claim)
      .set({ pg_boss_job_id: null })
      .where(eq(placement_starter_claim.id, identity.claimId));

    // Real probe semantics for a null job id: no job → not live. Asserted through the default
    // seam contract rather than a stub, so this pins isPlacementStarterJobLive's null branch.
    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: recordingDispatch().dispatch,
      isJobLive: async (jobId) => jobId != null,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ reaped: 1 });
    expect((await readClaim(identity.claimId)).status).toBe('exhausted');
  });

  it('is idempotent across reruns: a reaped claim is terminal and never re-scanned', async () => {
    const identity = await seedZombie();
    const { calls, dispatch } = recordingDispatch();

    await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });
    const second = await sweepStalePlacementStarterClaims(db, {
      now: new Date(NOW.getTime() + 60_000),
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(second).toMatchObject({ scannedRetry: 0, reaped: 0 });
    expect(calls).toHaveLength(0);
    expect((await readClaim(identity.claimId)).status).toBe('exhausted');
  });
});

describe('sweepStalePlacementStarterClaims — guards', () => {
  it('isolates a throwing dispatch: the claim stays pending for the next window', async () => {
    const identity = await seedClaim();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: (async () => {
        throw new Error('boss unavailable');
      }) as never,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedPending: 1, redispatchFailed: 1, redispatched: 0 });
    const claim = await readClaim(identity.claimId);
    expect(claim.status).toBe('pending_dispatch');
    expect(claim.next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
  });

  it('honours the per-run cap so a backlog cannot flood the paid queue', async () => {
    await seedGoal();
    for (let i = 0; i < 4; i++) await insertClaim(i);
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      maxPerRun: 2,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedPending: 2, redispatched: 2 });
    // Oldest-overdue first — the recovery index's own (next_reconcile_at, created_at) order.
    expect(calls.map((c) => c.claimId)).toEqual(['claim-0', 'claim-1']);
  });
});
