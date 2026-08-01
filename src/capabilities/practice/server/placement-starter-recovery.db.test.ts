// YUK-761 — placement starter recovery sweeper db tests (real Postgres).
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()，不假设跨文件状态/执行序。
//
// 关注点（票面验证清单 + 首轮评审）：超期 pending_dispatch claim 被重驱、未超期不动、幂等重跑
// 不双发、终态 claim 不受影响；retry_scheduled 的**反向**契约——绝不被重驱（会双发付费批次），
// 只在 grace 到期**且** pg-boss job 确已不能重投时才被收割成 'exhausted'；以及两条腿各自独立
// 取数、每条被访问的 claim 都推进游标（防「同一批老 claim 每夜霸占额度、后面的僵尸永不被收割」
// 的饿死路径）。

import { db } from '@/db/client';
import {
  goal,
  knowledge,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  question,
} from '@/db/schema';
import {
  PLACEMENT_QUEUE_EXPIRY_MS,
  dispatchPlacementStarterClaim,
  resolvePlacementStarterGoalAuthority,
  terminalizeLostPlacementDelivery,
} from '@/kernel/placement';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import {
  PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
  PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS,
  sweepStalePlacementStarterClaims,
} from './placement-starter-recovery';

const NOW = new Date('2026-07-25T06:00:00Z');
const CREATED = new Date('2026-07-20T00:00:00Z');

// Only pg-boss transport is mocked. The recovery leg, production dispatch wrapper, nested
// savepoint, real Postgres partial-unique conflict, admission locks, and retry all execute for
// real. Distinct job ids make the rolled-back first enqueue distinguishable from the later winner.
const bossMock = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/server/boss/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/boss/client')>();
  return {
    ...actual,
    getStartedBoss: async () => ({ send: bossMock.send }),
  };
});

/** Default seam: no pg-boss job is ever live, so the reap leg is governed purely by grace. */
const noJobLive = async () => false;

beforeEach(async () => {
  bossMock.send.mockReset();
  await resetDb();
});

/**
 * Seed the KC tree once. Kept to `@/db/schema` writes — a practice-capability test may depend on
 * `@/kernel/*`, itself, and (migration-period exemption) `@/db/*`, but not on another capability's
 * server internals or on `@/server/**` implementations (src/capabilities/AGENTS.md).
 */
async function seedTree(): Promise<void> {
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
}

async function seedGoalRow(id: string): Promise<void> {
  await db.insert(goal).values({
    id,
    title: `读懂古文 ${id}`,
    subject_id: 'yuwen',
    scope_knowledge_ids: ['kc-explicit'],
    scope_mode: 'explicit',
    sequence_hint: 0,
    status: 'active',
    source: 'manual',
    created_at: CREATED,
    updated_at: CREATED,
  });
}

async function seedGoal(): Promise<void> {
  await seedTree();
  await seedGoalRow('goal-1');
}

/** The revision id the sweeper's stale-revision guard will compare against, via the facade. */
async function currentRevision(goalId: string): Promise<string> {
  return (await resolvePlacementStarterGoalAuthority(db, goalId)).semanticGoalRevisionId;
}

/**
 * Insert a claim directly. `semantic_goal_revision_id` defaults to the goal's CURRENT authoritative
 * revision, so a claim is dispatchable unless a test deliberately makes it stale.
 */
async function insertClaim(
  i: number,
  overrides: Partial<typeof placement_starter_claim.$inferInsert> = {},
): Promise<string> {
  const id = (overrides.id as string | undefined) ?? `claim-${i}`;
  const goalId = (overrides.goal_id as string | undefined) ?? 'goal-1';
  await db.insert(placement_starter_claim).values({
    id,
    fingerprint: `fp-${id}`,
    goal_id: goalId,
    semantic_goal_revision_id: await currentRevision(goalId),
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

/** One goal + one dispatchable pending_dispatch claim on it. */
async function seedClaim(
  overrides: Partial<typeof placement_starter_claim.$inferInsert> = {},
): Promise<string> {
  await seedGoal();
  return insertClaim(0, { id: 'claim-main', ...overrides });
}

/**
 * N goals, each with one claim. Distinct goals are REQUIRED for a multi-claim backlog: two
 * pending claims on one goal can only differ by revision, and only one revision is authoritative
 * (the rest are cancelled by the stale-revision guard) — plus
 * `placement_starter_claim_revision_subject_uq` forbids sharing one.
 */
async function seedClaimsOnDistinctGoals(n: number): Promise<string[]> {
  await seedTree();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    await seedGoalRow(`goal-${i}`);
    ids.push(await insertClaim(i, { id: `claim-${i}`, goal_id: `goal-${i}` }));
  }
  return ids;
}

async function readClaim(claimId: string) {
  const [row] = await db
    .select()
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, claimId));
  if (!row) throw new Error(`claim ${claimId} vanished`);
  return row;
}

async function seedInflightClaim(
  status: 'queued' | 'running' | 'verifying',
  options: {
    leaseExpiresAt?: Date | null;
    updatedAt?: Date;
    withAttempt?: boolean;
  } = {},
) {
  const claimId = await seedClaim();
  const jobId = 'boss-inflight-1';
  const attemptId = 'attempt-inflight-1';
  const fencingToken = '11111111-1111-4111-8111-111111111111';
  await db
    .update(placement_starter_claim)
    .set({
      status,
      pg_boss_job_id: jobId,
      next_reconcile_at: CREATED,
      updated_at: options.updatedAt ?? CREATED,
    })
    .where(eq(placement_starter_claim.id, claimId));
  const withAttempt = options.withAttempt ?? status !== 'queued';
  if (withAttempt) {
    await db.insert(placement_starter_attempt).values({
      id: attemptId,
      claim_id: claimId,
      pg_boss_job_id: jobId,
      delivery_no: 1,
      fencing_token: fencingToken,
      status: status === 'queued' ? 'running' : status,
      lease_expires_at:
        options.leaseExpiresAt === undefined
          ? new Date(NOW.getTime() - 60_000)
          : options.leaseExpiresAt,
      started_at: CREATED,
      created_at: CREATED,
      updated_at: CREATED,
    });
  }
  return { attemptId, claimId, fencingToken, jobId };
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
    const claimId = await seedClaim();
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
    expect(calls).toEqual([{ claimId: claimId, admitted: true }]);
    const claim = await readClaim(claimId);
    expect(claim.next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
    // The acquire CAS is a scheduler cursor, not a state transition: updated_at/version untouched.
    expect(claim.version).toBe(0);
    expect(claim.updated_at.getTime()).toBe(CREATED.getTime());
  });

  it('leaves a claim whose next_reconcile_at is still in the future untouched', async () => {
    const claimId = await seedClaim();
    const future = new Date(NOW.getTime() + 60 * 60_000);
    await db
      .update(placement_starter_claim)
      .set({ next_reconcile_at: future })
      .where(eq(placement_starter_claim.id, claimId));
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
    expect((await readClaim(claimId)).next_reconcile_at.getTime()).toBe(future.getTime());
  });

  it('is idempotent: a second sweep inside the backoff window re-drives nothing', async () => {
    const claimId = await seedClaim();
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
    expect(calls[0]?.claimId).toBe(claimId);
  });

  it('refuses paid admission when the goal scope already has an eligible question', async () => {
    const claimId = await seedClaim();
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
    expect(calls).toEqual([{ claimId: claimId, admitted: false }]);
    // An admission-refused claim still advanced its cursor (the acquire happens BEFORE dispatch),
    // so it cannot re-occupy a per-run slot next run.
    expect((await readClaim(claimId)).next_reconcile_at.getTime()).toBe(
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

describe('sweepStalePlacementStarterClaims — stale revision guard', () => {
  // Review PRRT…ua3w. The live /placement/start path can only dispatch the CURRENT revision's
  // claim; this sweeper is the only code that can pick up an older one. Doing so is destructive:
  // it pays for obsolete work and lets the stale claim take the nonterminal_uq slot, delaying the
  // CURRENT revision even though its 23505 loser now correctly stays pending (YUK-776).
  it('cancels a superseded-revision claim instead of dispatching it', async () => {
    await seedGoal();
    const staleId = await insertClaim(0, {
      id: 'claim-stale',
      semantic_goal_revision_id: 'rev-superseded',
      fingerprint: 'fp-stale',
    });
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedPending: 1, staleRevision: 1, redispatched: 0 });
    expect(calls).toHaveLength(0);
    const claim = await readClaim(staleId);
    expect(claim.status).toBe('cancelled');
    expect(claim.last_error_code).toBe('stale_revision');
    // Terminal → out of the scan entirely, not re-examined every window.
    const second = await sweepStalePlacementStarterClaims(db, {
      now: new Date(NOW.getTime() + 60_000),
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });
    expect(second.scannedPending).toBe(0);
  });

  // Review PRRT…h8a: the pre-check is a lockless read, so a goal re-scoped between it and the
  // dispatch transaction would still get the just-superseded revision dispatched. The dispatch tx
  // therefore redoes the comparison under a goal row lock. Here the goal is re-scoped AFTER the
  // pre-check has already passed (simulated by mutating it from inside the dispatch seam, which
  // runs at exactly that point), so only the in-transaction re-check can catch it.
  it('catches a revision superseded after the pre-check, inside the dispatch transaction', async () => {
    await seedGoal();
    const claimId = await insertClaim(0, { id: 'claim-toctou' });
    let admitVerdict: boolean | null = null;

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: (async (
        dbArg: typeof db,
        _claimId: string,
        admit?: (tx: never, claim: never) => Promise<boolean>,
      ) => {
        // Re-scope the goal now — i.e. after the sweeper's pre-check passed, before admission.
        await db
          .update(goal)
          .set({ scope_knowledge_ids: ['kc-explicit', 'seed:yuwen:root'], updated_at: NOW })
          .where(eq(goal.id, 'goal-1'));
        admitVerdict = await dbArg.transaction((tx) =>
          (admit as (t: unknown, c: unknown) => Promise<boolean>)(tx, undefined),
        );
        return admitVerdict ? 'job-should-not-happen' : null;
      }) as never,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    // Admission refused on staleness → nothing enqueued, and the claim is terminalized.
    expect(admitVerdict).toBe(false);
    expect(result).toMatchObject({ staleRevision: 1, redispatched: 0, admissionSkipped: 0 });
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('cancelled');
    expect(claim.last_error_code).toBe('stale_revision');

    // The whole point of NOT dispatching the stale claim: the new revision's claim can still be
    // established and dispatched. Cancelling the stale one leaves the (goal, subject) single-flight
    // slot free — which is exactly what dispatching it would have destroyed.
    const freshId = await insertClaim(1, { id: 'claim-fresh', fingerprint: 'fp-fresh' });
    const { calls, dispatch } = recordingDispatch();
    const second = await sweepStalePlacementStarterClaims(db, {
      now: new Date(NOW.getTime() + 60_000),
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(second).toMatchObject({ scannedPending: 1, redispatched: 1, staleRevision: 0 });
    expect(calls).toEqual([{ claimId: freshId, admitted: true }]);
  });

  // The end-to-end shape of the hazard: two revisions stranded pending_dispatch, oldest cursor
  // first. Without the guard the stale one would be dispatched and would cancel the current one.
  it('dispatches only the current revision when two revisions are stranded together', async () => {
    await seedGoal();
    await insertClaim(0, {
      id: 'claim-old-revision',
      semantic_goal_revision_id: 'rev-superseded',
      fingerprint: 'fp-old',
      next_reconcile_at: CREATED,
    });
    const currentId = await insertClaim(1, {
      id: 'claim-current-revision',
      fingerprint: 'fp-current',
      next_reconcile_at: new Date(CREATED.getTime() + 5_000),
    });
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedPending: 2, staleRevision: 1, redispatched: 1 });
    // The stale claim was never handed to dispatch at all.
    expect(calls).toEqual([{ claimId: currentId, admitted: true }]);
    expect((await readClaim('claim-old-revision')).status).toBe('cancelled');
    expect((await readClaim(currentId)).status).toBe('pending_dispatch');
  });
});

describe('sweepStalePlacementStarterClaims — non-active goal guard', () => {
  // Review PRRT…upw3: a goal retracted to 'dormant' (proposals retract path) or finished as 'done'
  // has left the active-goal flow, but the revision guard sails through — revisions are derived
  // from genesis/scope events, so a STATUS change does not invalidate them. Without this check the
  // sweeper spends real money generating a batch for a goal the owner retired.
  it.each(['dormant', 'done'] as const)(
    'defers, never cancels, a %s goal claim',
    async (status) => {
      const claimId = await seedClaim();
      await db.update(goal).set({ status }).where(eq(goal.id, 'goal-1'));
      const { calls, dispatch } = recordingDispatch();

      const result = await sweepStalePlacementStarterClaims(db, {
        now: NOW,
        dispatch,
        isJobLive: noJobLive,
        placementProbeEnabled: true,
      });

      expect(result).toMatchObject({ scannedPending: 1, goalNotActive: 1, redispatched: 0 });
      expect(calls).toHaveLength(0);
      const claim = await readClaim(claimId);
      // DEFERRED, not cancelled: claim ids are deterministic and materialize is onConflictDoNothing,
      // so a cancelled claim could never be re-created if the goal came back.
      expect(claim.status).toBe('pending_dispatch');
      expect(claim.next_reconcile_at.getTime()).toBe(
        NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
      );
    },
  );

  it('dispatches again once a dormant goal is reactivated', async () => {
    const claimId = await seedClaim();
    await db.update(goal).set({ status: 'dormant' }).where(eq(goal.id, 'goal-1'));
    await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: recordingDispatch().dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    await db.update(goal).set({ status: 'active' }).where(eq(goal.id, 'goal-1'));
    const { calls, dispatch } = recordingDispatch();
    const second = await sweepStalePlacementStarterClaims(db, {
      // Past the deferral backoff.
      now: new Date(NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS + 60_000),
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(second).toMatchObject({ goalNotActive: 0, redispatched: 1 });
    expect(calls).toEqual([{ claimId, admitted: true }]);
  });

  // Same TOCTOU shape as the revision guard: the pre-check is lockless, so the status is re-read
  // under the goal row lock inside the dispatch transaction.
  it('catches a goal retracted after the pre-check, inside the dispatch transaction', async () => {
    await seedGoal();
    const claimId = await insertClaim(0, { id: 'claim-retracted' });
    let admitVerdict: boolean | null = null;

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: (async (
        dbArg: typeof db,
        _claimId: string,
        admit?: (tx: never, claim: never) => Promise<boolean>,
      ) => {
        // Retract now — after the sweeper's pre-check passed, before admission.
        await db.update(goal).set({ status: 'dormant' }).where(eq(goal.id, 'goal-1'));
        admitVerdict = await dbArg.transaction((tx) =>
          (admit as (t: unknown, c: unknown) => Promise<boolean>)(tx, undefined),
        );
        return admitVerdict ? 'job-should-not-happen' : null;
      }) as never,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(admitVerdict).toBe(false);
    expect(result).toMatchObject({ goalNotActive: 1, redispatched: 0, staleRevision: 0 });
    expect((await readClaim(claimId)).status).toBe('pending_dispatch');
  });
});

describe('sweepStalePlacementStarterClaims — anti-starvation', () => {
  // The bug this guards: one shared capped scan ordered by next_reconcile_at would let a backlog
  // of untouched pending_dispatch claims monopolise every run, so a retry_scheduled zombie sorted
  // behind them is NEVER reaped — the blocked-revision failure this sweeper exists to fix.
  it('reaps a zombie even when a full page of older pending claims is suppressed by the flag', async () => {
    await seedClaimsOnDistinctGoals(3);
    const stalled = new Date(NOW.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS - 60_000);
    // Sorts strictly AFTER every pending claim on the shared (next_reconcile_at, created_at) order.
    await seedGoalRow('goal-zombie');
    await insertClaim(99, {
      id: 'claim-zombie',
      goal_id: 'goal-zombie',
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
    await seedClaimsOnDistinctGoals(3);
    const stalled = new Date(NOW.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS - 60_000);
    await seedGoalRow('goal-zombie');
    await insertClaim(99, {
      id: 'claim-zombie',
      goal_id: 'goal-zombie',
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

  // NOTE (review PRRT…QL7): the goal-vanishes-between-the-existence-check-and-the-authority-call
  // race is handled in production code (the not_found catch labels it `goalMissing` rather than
  // letting guardClaim call it `claimErrors`), but it is deliberately NOT tested here. Deleting
  // the goal before the sweep exercises the EARLIER projection guard, so such a test would pass
  // without ever reaching the new catch — false confidence. Reproducing the real interleaving
  // would need a seam that exists only for the test, which is not worth it for an
  // observability-labelling fix on a race that cannot occur today (goals are status-retracted,
  // never hard-deleted). The label assertion below covers the reachable path.
  it('advances the cursor of a goal-missing claim so it cannot squat the budget forever', async () => {
    const claimId = await seedClaim();
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
    const claim = await readClaim(claimId);
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

  it('gives pending, retry, and in-flight work independent budgets in the same run', async () => {
    const [inflightId, retryId, pendingId] = await seedClaimsOnDistinctGoals(3);
    const stalled = new Date(NOW.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS - 60_000);
    await db
      .update(placement_starter_claim)
      .set({
        status: 'queued',
        pg_boss_job_id: 'boss-inflight-dead',
        next_reconcile_at: CREATED,
        updated_at: CREATED,
      })
      .where(eq(placement_starter_claim.id, inflightId));
    await db
      .update(placement_starter_claim)
      .set({
        status: 'retry_scheduled',
        pg_boss_job_id: 'boss-retry-dead',
        next_reconcile_at: CREATED,
        updated_at: stalled,
      })
      .where(eq(placement_starter_claim.id, retryId));
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      maxPerRun: 1,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({
      scannedPending: 1,
      redispatched: 1,
      scannedRetry: 1,
      reaped: 1,
      scannedInflight: 1,
      inflightReaped: 1,
    });
    expect(calls.map((call) => call.claimId)).toEqual([pendingId]);
    expect((await readClaim(inflightId)).status).toBe('exhausted');
    expect((await readClaim(retryId)).status).toBe('exhausted');
  });
});

describe('sweepStalePlacementStarterClaims — terminal states', () => {
  it.each(['satisfied', 'exhausted', 'cancelled'] as const)(
    'never touches a %s claim',
    async (status) => {
      const claimId = await seedClaim();
      await db
        .update(placement_starter_claim)
        .set({
          status,
          satisfied_at: status === 'satisfied' ? NOW : null,
          exhausted_at: status === 'exhausted' ? NOW : null,
          next_reconcile_at: CREATED,
        })
        .where(eq(placement_starter_claim.id, claimId));
      const before = await readClaim(claimId);
      const { calls, dispatch } = recordingDispatch();

      const result = await sweepStalePlacementStarterClaims(db, {
        now: NOW,
        dispatch,
        isJobLive: noJobLive,
        placementProbeEnabled: true,
      });

      expect(result).toMatchObject({ scannedInflight: 0, scannedPending: 0, scannedRetry: 0 });
      expect(calls).toHaveLength(0);
      expect(await readClaim(claimId)).toEqual(before);
    },
  );
});

describe('sweepStalePlacementStarterClaims — queued/running/verifying recovery', () => {
  it('parks a fresh queued claim on the existing 120-minute queue expiry without probing pg-boss', async () => {
    const queuedAt = new Date(NOW.getTime() - 45 * 60_000);
    const { claimId } = await seedInflightClaim('queued', { updatedAt: queuedAt });
    let probes = 0;

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: async () => {
        probes += 1;
        return false;
      },
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({
      scannedInflight: 1,
      inflightQueuePending: 1,
      inflightReaped: 0,
    });
    expect(probes).toBe(0);
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('queued');
    expect(claim.next_reconcile_at).toEqual(
      new Date(queuedAt.getTime() + PLACEMENT_QUEUE_EXPIRY_MS),
    );

    const insideWindow = await sweepStalePlacementStarterClaims(db, {
      now: new Date(NOW.getTime() + 60_000),
      isJobLive: async () => {
        probes += 1;
        return false;
      },
      placementProbeEnabled: false,
    });
    expect(insideWindow.scannedInflight).toBe(0);
    expect(probes).toBe(0);
  });

  it('terminalizes a queued claim only after its owning job is confirmed dead', async () => {
    const { claimId, jobId } = await seedInflightClaim('queued', {
      // Equality is expired: the queue contract is live while expiry > now, not at the deadline.
      updatedAt: new Date(NOW.getTime() - PLACEMENT_QUEUE_EXPIRY_MS),
    });
    const probed: Array<string | null> = [];

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: async (candidate) => {
        probed.push(candidate);
        return false;
      },
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({
      scannedInflight: 1,
      inflightJobLive: 0,
      inflightLeaseActive: 0,
      inflightReaped: 1,
    });
    expect(probed).toEqual([jobId]);
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('exhausted');
    expect(claim.exhausted_at?.getTime()).toBe(NOW.getTime());
    expect(claim.last_error_code).toBe('inflight_delivery_lost');
  });

  it('defers a queued claim while its owning job can still deliver', async () => {
    const { claimId } = await seedInflightClaim('queued');

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: async () => true,
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({
      scannedInflight: 1,
      inflightJobLive: 1,
      inflightReaped: 0,
    });
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('queued');
    expect(claim.next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
  });

  it.each(['running', 'verifying'] as const)(
    'atomically fences and terminalizes an expired %s attempt after its job is dead',
    async (status) => {
      const { attemptId, claimId } = await seedInflightClaim(status);
      await db
        .update(placement_starter_attempt)
        .set({
          provider_task_run_id: `provider-run-${status}-20260725`,
          provider_output_hash: `sha256-output-${status}`,
          provider_output_recorded_at: CREATED,
        })
        .where(eq(placement_starter_attempt.id, attemptId));
      const fixtures = [
        {
          id: `question-${status}-lexical`,
          prompt:
            '《屈原列传》“屈平疾王听之不聪也”中“疾”应如何解释？结合宾语和并列分句说明为何不是“生病”。',
          reference: '“疾”是痛心、憎恨；其宾语为“王听之不聪”，并与后文批评并列。',
          verificationStatus: 'authorized',
          epoch: '22222222-2222-4222-8222-222222222221',
        },
        {
          id: `question-${status}-counterfactual`,
          prompt:
            '若删去“谗谄之蔽明也”，屈原遭疏的哪一条因果解释会失去直接文本支撑？请列出证据链。',
          reference: '会失去“谗臣蒙蔽君王导致疏远”的直接支撑，证据链须含行为者、机制与结果。',
          verificationStatus: 'authorized',
          epoch: '22222222-2222-4222-8222-222222222222',
        },
        {
          id: `question-${status}-contrast`,
          prompt: '对比“君有疾在腠理”与“屈平疾王听之不聪也”的“疾”义项，并分别给出句法证据。',
          reference: '前者为疾病、处所结构作补足；后者为痛恨、后接事件性宾语。',
          verificationStatus: 'failed',
          epoch: '22222222-2222-4222-8222-222222222223',
        },
      ] as const;
      await db.insert(question).values(
        fixtures.map((fixture, index) => ({
          id: fixture.id,
          kind: 'short_answer' as const,
          prompt_md: fixture.prompt,
          reference_md: fixture.reference,
          knowledge_ids: ['kc-explicit'],
          difficulty: index + 2,
          source: 'quiz_gen' as const,
          source_ref: `provider-run-${status}-20260725`,
          draft_status: 'draft' as const,
          metadata: { fixture: 'yuk-776-complex-recovery', evidenceDepth: index + 1 },
          created_at: CREATED,
          updated_at: CREATED,
        })),
      );
      await db.insert(placement_starter_attempt_question).values(
        fixtures.map((fixture) => ({
          attempt_id: attemptId,
          claim_id: claimId,
          question_id: fixture.id,
          canonical_hash: `hash-${fixture.id}`,
          verification_authority_epoch: fixture.epoch,
          verification_status: fixture.verificationStatus,
          created_at: CREATED,
        })),
      );

      const result = await sweepStalePlacementStarterClaims(db, {
        now: NOW,
        isJobLive: noJobLive,
        placementProbeEnabled: false,
      });

      expect(result).toMatchObject({ scannedInflight: 1, inflightReaped: 1, lost: 0 });
      const claim = await readClaim(claimId);
      expect(claim.status).toBe('exhausted');
      expect(claim.last_error_code).toBe('inflight_delivery_lost');
      const [attempt] = await db
        .select()
        .from(placement_starter_attempt)
        .where(eq(placement_starter_attempt.id, attemptId));
      expect(attempt).toMatchObject({
        status: 'interrupted',
        lease_expires_at: null,
        error_class: 'stalled',
        error_code: 'inflight_delivery_lost',
      });
      expect(attempt?.finished_at?.getTime()).toBe(NOW.getTime());
      const authorities = await db
        .select()
        .from(placement_starter_attempt_question)
        .where(eq(placement_starter_attempt_question.attempt_id, attemptId));
      expect(
        Object.fromEntries(
          authorities.map((authority) => [authority.question_id, authority.verification_status]),
        ),
      ).toEqual({
        [`question-${status}-lexical`]: 'superseded',
        [`question-${status}-counterfactual`]: 'superseded',
        [`question-${status}-contrast`]: 'failed',
      });
    },
  );

  it.each(['running', 'verifying'] as const)(
    'does not even probe pg-boss while a %s attempt lease is still active',
    async (status) => {
      const leaseExpiresAt = new Date(NOW.getTime() + 5 * 60_000);
      const { claimId } = await seedInflightClaim(status, { leaseExpiresAt });
      let probes = 0;

      const result = await sweepStalePlacementStarterClaims(db, {
        now: NOW,
        isJobLive: async () => {
          probes += 1;
          return false;
        },
        placementProbeEnabled: false,
      });

      expect(result).toMatchObject({
        scannedInflight: 1,
        inflightLeaseActive: 1,
        inflightReaped: 0,
      });
      expect(probes).toBe(0);
      const claim = await readClaim(claimId);
      expect(claim.status).toBe(status);
      expect(claim.next_reconcile_at).toEqual(leaseExpiresAt);
    },
  );

  it('defers an expired attempt while its owning job can still retry', async () => {
    const { attemptId, claimId } = await seedInflightClaim('verifying');

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: async () => true,
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({
      scannedInflight: 1,
      inflightJobLive: 1,
      inflightReaped: 0,
    });
    expect((await readClaim(claimId)).status).toBe('verifying');
    expect((await readClaim(claimId)).next_reconcile_at).toEqual(
      new Date(NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS),
    );
    const [attempt] = await db
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, attemptId));
    expect(attempt?.status).toBe('verifying');
  });

  it('re-checks the lease under the fence after the external job probe', async () => {
    const { attemptId, claimId } = await seedInflightClaim('running');
    const renewedUntil = new Date(NOW.getTime() + 10 * 60_000);

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: async () => {
        await db
          .update(placement_starter_attempt)
          .set({ lease_expires_at: renewedUntil })
          .where(eq(placement_starter_attempt.id, attemptId));
        return false;
      },
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({ scannedInflight: 1, inflightReaped: 0, lost: 1 });
    expect((await readClaim(claimId)).status).toBe('running');
    const [attempt] = await db
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, attemptId));
    expect(attempt).toMatchObject({ status: 'running', lease_expires_at: renewedUntil });
  });

  it('fails safe when the pg-boss liveness probe is unavailable', async () => {
    const { claimId } = await seedInflightClaim('running');

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: async () => {
        throw new Error('boss unavailable');
      },
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({
      scannedInflight: 1,
      inflightJobLive: 1,
      inflightReaped: 0,
    });
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('running');
    expect(claim.next_reconcile_at).toEqual(
      new Date(NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS),
    );
  });

  it.each([
    ['running without any attempt', 'running', false, undefined],
    ['verifying with a null lease', 'verifying', true, null],
  ] as const)(
    'recovers the abnormal state %s after the owning job is dead',
    async (_name, status, withAttempt, leaseExpiresAt) => {
      const seeded = await seedInflightClaim(status, { withAttempt, leaseExpiresAt });

      const result = await sweepStalePlacementStarterClaims(db, {
        now: NOW,
        isJobLive: noJobLive,
        placementProbeEnabled: false,
      });

      expect(result).toMatchObject({ scannedInflight: 1, inflightReaped: 1, lost: 0 });
      expect((await readClaim(seeded.claimId)).status).toBe('exhausted');
      if (withAttempt) {
        const [attempt] = await db
          .select()
          .from(placement_starter_attempt)
          .where(eq(placement_starter_attempt.id, seeded.attemptId));
        expect(attempt).toMatchObject({ status: 'interrupted', lease_expires_at: null });
      }
    },
  );

  it('ignores terminal delivery history when proving that a running claim has no active attempt', async () => {
    const { claimId, jobId } = await seedInflightClaim('running', { withAttempt: false });
    await db.insert(placement_starter_attempt).values([
      {
        id: 'attempt-history-1',
        claim_id: claimId,
        pg_boss_job_id: jobId,
        delivery_no: 1,
        fencing_token: '33333333-3333-4333-8333-333333333331',
        status: 'underfilled',
        lease_expires_at: new Date(NOW.getTime() + 60_000),
        started_at: CREATED,
        finished_at: new Date(CREATED.getTime() + 60_000),
        created_at: CREATED,
        updated_at: CREATED,
      },
      {
        id: 'attempt-history-2',
        claim_id: claimId,
        pg_boss_job_id: jobId,
        delivery_no: 2,
        fencing_token: '33333333-3333-4333-8333-333333333332',
        status: 'timed_out',
        lease_expires_at: null,
        started_at: CREATED,
        finished_at: new Date(CREATED.getTime() + 120_000),
        created_at: CREATED,
        updated_at: CREATED,
      },
    ]);

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: noJobLive,
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({ scannedInflight: 1, inflightReaped: 1 });
    const history = await db
      .select({ id: placement_starter_attempt.id, status: placement_starter_attempt.status })
      .from(placement_starter_attempt);
    expect(history.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'attempt-history-1', status: 'underfilled' },
      { id: 'attempt-history-2', status: 'timed_out' },
    ]);
  });

  it('stands down with zero half-write when the attempt fence rotates after the job probe', async () => {
    const { attemptId, claimId } = await seedInflightClaim('running');
    const rotatedFence = '44444444-4444-4444-8444-444444444444';

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: async () => {
        await db
          .update(placement_starter_attempt)
          .set({ fencing_token: rotatedFence })
          .where(eq(placement_starter_attempt.id, attemptId));
        return false;
      },
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({ inflightReaped: 0, lost: 1 });
    expect((await readClaim(claimId)).status).toBe('running');
    const [attempt] = await db
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, attemptId));
    expect(attempt).toMatchObject({ status: 'running', fencing_token: rotatedFence });
  });

  it('stands down with zero half-write when claim job authority changes after the probe', async () => {
    const { attemptId, claimId } = await seedInflightClaim('verifying');

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: async () => {
        await db
          .update(placement_starter_claim)
          .set({ pg_boss_job_id: 'boss-replacement' })
          .where(eq(placement_starter_claim.id, claimId));
        return false;
      },
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({ inflightReaped: 0, lost: 1 });
    expect(await readClaim(claimId)).toMatchObject({
      status: 'verifying',
      pg_boss_job_id: 'boss-replacement',
    });
    const [attempt] = await db
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, attemptId));
    expect(attempt?.status).toBe('verifying');
  });

  it('lets concurrent sweepers probe and reap one in-flight claim at most once', async () => {
    const { claimId } = await seedInflightClaim('queued');
    let probes = 0;
    const deps = {
      now: NOW,
      isJobLive: async () => {
        probes += 1;
        await Promise.resolve();
        return false;
      },
      placementProbeEnabled: false,
    };

    const results = await Promise.all([
      sweepStalePlacementStarterClaims(db, deps),
      sweepStalePlacementStarterClaims(db, deps),
    ]);

    expect(probes).toBe(1);
    expect(results.reduce((sum, result) => sum + result.inflightReaped, 0)).toBe(1);
    expect((await readClaim(claimId)).status).toBe('exhausted');
    const rerun = await sweepStalePlacementStarterClaims(db, deps);
    expect(rerun.scannedInflight).toBe(0);
  });

  it.each(['claim', 'attempt'] as const)(
    'stands down immediately when a live writer holds the %s row lock',
    async (lockedRow) => {
      const { attemptId, claimId, fencingToken, jobId } = await seedInflightClaim('running');
      let releaseLock: (() => void) | undefined;
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let announceLock: (() => void) | undefined;
      const lockReady = new Promise<void>((resolve) => {
        announceLock = resolve;
      });
      const holder = db.transaction(async (tx) => {
        if (lockedRow === 'claim') {
          await tx
            .select({ id: placement_starter_claim.id })
            .from(placement_starter_claim)
            .where(eq(placement_starter_claim.id, claimId))
            .for('update');
        } else {
          await tx
            .select({ id: placement_starter_attempt.id })
            .from(placement_starter_attempt)
            .where(eq(placement_starter_attempt.id, attemptId))
            .for('update');
        }
        announceLock?.();
        await released;
      });
      await lockReady;

      const recovery = terminalizeLostPlacementDelivery(
        db,
        {
          claimId,
          pgBossJobId: jobId,
          attempt: { attemptId, fencingToken, pgBossJobId: jobId },
        },
        NOW,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        recovery,
        new Promise<'blocked'>((resolve) => {
          timeout = setTimeout(() => resolve('blocked'), 2_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      releaseLock?.();
      await holder;
      const eventual = await recovery;

      expect(outcome).toBe(false);
      expect(eventual).toBe(false);
      expect((await readClaim(claimId)).status).toBe('running');
      const [attempt] = await db
        .select()
        .from(placement_starter_attempt)
        .where(eq(placement_starter_attempt.id, attemptId));
      expect(attempt).toMatchObject({ status: 'running', fencing_token: fencingToken });
    },
  );

  it('keeps current pending while the old job is live, then reaps old and dispatches that same claim', async () => {
    await seedGoal();
    const currentRevisionId = await currentRevision('goal-1');
    const oldClaimId = await insertClaim(0, {
      id: 'claim-old-running',
      semantic_goal_revision_id: 'revision-superseded-before-yuk-776',
      status: 'running',
      pg_boss_job_id: 'boss-old-flight',
      next_reconcile_at: CREATED,
      updated_at: CREATED,
    });
    await db.insert(placement_starter_attempt).values({
      id: 'attempt-old-running',
      claim_id: oldClaimId,
      pg_boss_job_id: 'boss-old-flight',
      delivery_no: 2,
      fencing_token: '55555555-5555-4555-8555-555555555555',
      status: 'running',
      lease_expires_at: new Date(NOW.getTime() - 60_000),
      started_at: CREATED,
      created_at: CREATED,
      updated_at: CREATED,
    });
    const currentClaimId = await insertClaim(1, {
      id: 'claim-current-pending',
      semantic_goal_revision_id: currentRevisionId,
      status: 'pending_dispatch',
      next_reconcile_at: CREATED,
      updated_at: CREATED,
    });
    const probes: string[] = [];
    bossMock.send
      .mockResolvedValueOnce('boss-current-rolled-back')
      .mockResolvedValueOnce('boss-current-after-reap');

    // Round 1: the expired attempt is not enough to reap — the old pg-boss delivery is still live.
    // The paid leg then exercises the REAL dispatch Tx helper, hits nonterminal_uq on its
    // pending→queued transition, rolls back that savepoint, and preserves the current claim.
    const first = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      isJobLive: async (jobId) => {
        probes.push(`live:${jobId}`);
        return true;
      },
      dispatch: dispatchPlacementStarterClaim,
      placementProbeEnabled: true,
    });

    expect(first).toMatchObject({
      scannedInflight: 1,
      inflightJobLive: 1,
      inflightReaped: 0,
      scannedPending: 1,
      redispatched: 0,
      admissionSkipped: 1,
    });
    expect(probes).toEqual(['live:boss-old-flight']);
    expect(bossMock.send).toHaveBeenCalledTimes(1);
    expect((await readClaim(oldClaimId)).status).toBe('running');
    expect(await readClaim(currentClaimId)).toMatchObject({
      status: 'pending_dispatch',
      pg_boss_job_id: null,
      last_error_class: null,
    });

    // Round 2: after the independent recovery cursors mature, the old job is confirmed dead.
    // In-flight recovery fences/reaps it BEFORE the paid leg; the SAME deterministic current claim
    // now takes the freed slot through the production dispatcher. No re-materialization shortcut.
    const secondNow = new Date(NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS + 60_000);
    const second = await sweepStalePlacementStarterClaims(db, {
      now: secondNow,
      isJobLive: async (jobId) => {
        probes.push(`dead:${jobId}`);
        return false;
      },
      dispatch: dispatchPlacementStarterClaim,
      placementProbeEnabled: true,
    });

    expect(second).toMatchObject({
      scannedInflight: 1,
      inflightReaped: 1,
      scannedPending: 1,
      redispatched: 1,
      admissionSkipped: 0,
    });
    expect(probes).toEqual(['live:boss-old-flight', 'dead:boss-old-flight']);
    expect(bossMock.send).toHaveBeenCalledTimes(2);
    expect(await readClaim(oldClaimId)).toMatchObject({
      status: 'exhausted',
      last_error_code: 'inflight_delivery_lost',
    });
    expect(await readClaim(currentClaimId)).toMatchObject({
      status: 'queued',
      pg_boss_job_id: 'boss-current-after-reap',
      last_error_class: null,
    });
  });
});

describe('sweepStalePlacementStarterClaims — retry_scheduled reap', () => {
  async function seedZombie(): Promise<string> {
    const claimId = await seedClaim();
    const stalled = new Date(NOW.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS - 60_000);
    await db
      .update(placement_starter_claim)
      .set({
        status: 'retry_scheduled',
        pg_boss_job_id: 'boss-job-1',
        updated_at: stalled,
        next_reconcile_at: stalled,
      })
      .where(eq(placement_starter_claim.id, claimId));
    return claimId;
  }

  it('reaps a retry_scheduled claim whose job can no longer redeliver, without dispatching', async () => {
    const claimId = await seedZombie();
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
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('exhausted');
    expect(claim.exhausted_at?.getTime()).toBe(NOW.getTime());
    expect(claim.satisfied_at).toBeNull();
    expect(claim.last_error_code).toBe('retry_never_redelivered');
  });

  // The hazard: a paused / saturated quiz_gen queue can hold a LEGITIMATE retry unfetched past
  // the grace window. Reaping then makes the eventual delivery fail admission in
  // acquirePlacementAttempt and throws away paid generation work that was still coming.
  it('does NOT reap a past-grace claim whose quiz_gen job is still live', async () => {
    const claimId = await seedZombie();
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: async () => true,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedRetry: 1, reaped: 0, retryJobLive: 1 });
    expect(calls).toHaveLength(0);
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('retry_scheduled');
    expect(claim.exhausted_at).toBeNull();
    // Cursor advanced so it is re-probed next window instead of squatting the budget.
    expect(claim.next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
  });

  it('fails safe and defers the reap when the pg-boss job probe throws', async () => {
    const claimId = await seedZombie();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: recordingDispatch().dispatch,
      isJobLive: async () => {
        throw new Error('boss unreachable');
      },
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedRetry: 1, reaped: 0, retryJobLive: 1 });
    expect((await readClaim(claimId)).status).toBe('retry_scheduled');
  });

  it('leaves a freshly retry_scheduled claim alone and parks the cursor on its reap deadline', async () => {
    const claimId = await seedClaim();
    const recent = new Date(NOW.getTime() - 60_000);
    await db
      .update(placement_starter_claim)
      .set({
        status: 'retry_scheduled',
        pg_boss_job_id: 'boss-job-1',
        updated_at: recent,
        next_reconcile_at: recent,
      })
      .where(eq(placement_starter_claim.id, claimId));
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
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('retry_scheduled');
    expect(claim.next_reconcile_at.getTime()).toBe(
      recent.getTime() + PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS,
    );
    // updated_at must stay put: it IS the staleness signal the reap deadline is computed from.
    expect(claim.updated_at.getTime()).toBe(recent.getTime());
  });

  it('reaps zombies even while the placement probe flag is off', async () => {
    const claimId = await seedZombie();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: recordingDispatch().dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: false,
    });

    expect(result).toMatchObject({ reaped: 1, redispatchSuppressed: true });
    expect((await readClaim(claimId)).status).toBe('exhausted');
  });

  it('treats a claim with no pg_boss_job_id as having no redelivery source', async () => {
    const claimId = await seedZombie();
    await db
      .update(placement_starter_claim)
      .set({ pg_boss_job_id: null })
      .where(eq(placement_starter_claim.id, claimId));

    // Real probe semantics for a null job id: no job → not live. Asserted through the default
    // seam contract rather than a stub, so this pins isPlacementStarterJobLive's null branch.
    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: recordingDispatch().dispatch,
      isJobLive: async (jobId) => jobId != null,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ reaped: 1 });
    expect((await readClaim(claimId)).status).toBe('exhausted');
  });

  it('is idempotent across reruns: a reaped claim is terminal and never re-scanned', async () => {
    const claimId = await seedZombie();
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
    expect((await readClaim(claimId)).status).toBe('exhausted');
  });
});

describe('sweepStalePlacementStarterClaims — goal lock contention', () => {
  // Review PRRT…HNf: the in-tx goal lock inverts the order materializePlacementStartersForGoal
  // uses (goal → claim), so a plain FOR UPDATE is a real AB-BA cycle that Postgres resolves by
  // aborting one side — possibly the LEARNER's /placement/start, i.e. a 5xx for a real person.
  // NOWAIT removes the cycle rather than documenting it: a deadlock needs both sides to WAIT and
  // this side never does. Here a concurrent transaction holds the goal row while the sweep runs.
  it('stands down instead of blocking when the goal row is locked by a concurrent writer', async () => {
    const claimId = await seedClaim();
    let released: (() => void) | undefined;
    const holdReleased = new Promise<void>((resolve) => {
      released = resolve;
    });
    let locked: (() => void) | undefined;
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve;
    });

    // A separate transaction holding `goal-1` FOR UPDATE for the duration of the sweep.
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: goal.id }).from(goal).where(eq(goal.id, 'goal-1')).for('update');
      locked?.();
      await holdReleased;
    });
    await lockAcquired;

    let result: Awaited<ReturnType<typeof sweepStalePlacementStarterClaims>>;
    try {
      result = await sweepStalePlacementStarterClaims(db, {
        now: NOW,
        dispatch: recordingDispatch().dispatch,
        isJobLive: noJobLive,
        placementProbeEnabled: true,
      });
    } finally {
      released?.();
      await holder;
    }

    // Deferred, not blocked, not deadlocked, and above all NOT dispatched.
    expect(result).toMatchObject({
      scannedPending: 1,
      goalLockBusy: 1,
      redispatched: 0,
      claimErrors: 0,
    });
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('pending_dispatch');
    expect(claim.next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
  });

  it('takes the goal lock and dispatches normally when it is free', async () => {
    await seedClaim();
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ redispatched: 1, goalLockBusy: 0 });
    expect(calls).toEqual([{ claimId: 'claim-main', admitted: true }]);
  });
});

describe('sweepStalePlacementStarterClaims — concurrent dispatch attribution', () => {
  // Review PRRT…0VF: dispatchPlacementStarterClaimTx re-reads the claim FOR UPDATE and, when the
  // status is no longer 'pending_dispatch', early-returns the EXISTING pg_boss_job_id without ever
  // calling admit. Reachable in the ordinary case — a learner hitting /placement/start during the
  // sweep window — because the sweeper's acquire moves only the cursor, never the status. Counting
  // that as `redispatched` credits the sweeper for a dispatch it did not perform.
  it('does not claim credit when a concurrent path dispatched the claim first', async () => {
    const claimId = await seedClaim();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      // Stands in for dispatchPlacementStarterClaimTx's early return: never INVOKES admit (the
      // real early return precedes the admit call), hands back the job id of whoever actually
      // dispatched. Not invoking admit is the whole point — that is the signal the sweeper reads.
      dispatch: (async () => 'job-from-placement-start') as never,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({
      scannedPending: 1,
      dispatchedElsewhere: 1,
      redispatched: 0,
      admissionSkipped: 0,
    });
    expect((await readClaim(claimId)).next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
  });

  it('still counts a dispatch it actually drove as redispatched', async () => {
    await seedClaim();
    const { calls, dispatch } = recordingDispatch();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ redispatched: 1, dispatchedElsewhere: 0 });
  });
});

describe('sweepStalePlacementStarterClaims — failure containment', () => {
  // Review PRRT…OZI: only dispatch()/isJobLive() were guarded, so a throw from the goal read,
  // scope resolution, the acquire, or the reap tx would abort the whole leg mid-way.
  it('isolates one poisoned claim so the rest of the leg still runs', async () => {
    await seedClaimsOnDistinctGoals(3);
    const calls: string[] = [];
    const dispatch = (async (
      dbArg: typeof db,
      claimId: string,
      admit?: (tx: never, claim: never) => Promise<boolean>,
    ) => {
      // Invoke admit like the real dispatch does, so these count as sweeper-driven dispatches
      // rather than concurrent ones (see the attribution suite above).
      if (admit) await dbArg.transaction((tx) => admit(tx as never, undefined as never));
      calls.push(claimId);
      // Not a dispatch-shaped failure (that path has its own counter) — this stands in for an
      // arbitrary throw escaping a claim's handling.
      if (claimId === 'claim-1') throw Object.assign(new Error('poison'), { fatal: true });
      return `job-${claimId}`;
    }) as never;

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    // claim-1's failure is contained by the dispatch guard; the leg completed all three.
    expect(calls).toEqual(['claim-0', 'claim-1', 'claim-2']);
    expect(result).toMatchObject({ scannedPending: 3, redispatched: 2, redispatchFailed: 1 });
    // Every visited claim advanced, including the failed one.
    for (const id of ['claim-0', 'claim-1', 'claim-2']) {
      expect((await readClaim(id)).next_reconcile_at.getTime()).toBe(
        NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
      );
    }
  });

  // Review PRRT…OZJ: resolveGoalPlacementScope() used to run BEFORE the acquire, so a throw from
  // its DB reads left the cursor un-advanced and the claim re-occupied a slot on every run.
  // Acquire-first makes "visited ⇒ advanced" hold even when the scope read explodes; here the
  // scope read is made to explode by deleting the KC tree out from under a subject_live goal.
  it('advances the cursor before the goal read, so a post-acquire throw cannot starve the run', async () => {
    const claimId = await seedClaim();
    // Force the reap/redrive path to throw AFTER the acquire by removing the goal's whole tree,
    // then asserting the claim still moved. (goalMissing is the benign shape of this; the
    // invariant under test is the ordering, asserted through the cursor.)
    await db.delete(goal).where(eq(goal.id, 'goal-1'));

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: recordingDispatch().dispatch,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ goalMissing: 1, claimErrors: 0 });
    expect((await readClaim(claimId)).next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
  });

  // Splitting the legs is pointless if one leg's scan failure takes the other down with it.
  it('contains a leg failure so the sibling leg still runs', async () => {
    const claimId = await seedClaim();
    const stalled = new Date(NOW.getTime() - PLACEMENT_STARTER_RETRY_ZOMBIE_GRACE_MS - 60_000);
    await db
      .update(placement_starter_claim)
      .set({ status: 'retry_scheduled', updated_at: stalled, next_reconcile_at: stalled })
      .where(eq(placement_starter_claim.id, claimId));
    await seedGoalRow('goal-pending');
    await insertClaim(50, { id: 'claim-pending', goal_id: 'goal-pending' });

    // The reap leg blows up inside its loop (probe guard re-throws via a non-Error rejection is
    // already covered; here the failure escapes the claim guard's own advance too).
    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: recordingDispatch().dispatch,
      isJobLive: () => {
        throw Object.assign(new Error('probe exploded'), {});
      },
      placementProbeEnabled: true,
    });

    // Probe throw is caught by the inner guard → deferral, not a leg failure; and the paid leg
    // ran regardless.
    expect(result).toMatchObject({ retryJobLive: 1, scannedPending: 1, redispatched: 1 });
    expect(result.legErrors).toBe(0);
  });
});

describe('sweepStalePlacementStarterClaims — guards', () => {
  it('isolates a throwing dispatch: the claim stays pending for the next window', async () => {
    const claimId = await seedClaim();

    const result = await sweepStalePlacementStarterClaims(db, {
      now: NOW,
      dispatch: (async () => {
        throw new Error('boss unavailable');
      }) as never,
      isJobLive: noJobLive,
      placementProbeEnabled: true,
    });

    expect(result).toMatchObject({ scannedPending: 1, redispatchFailed: 1, redispatched: 0 });
    const claim = await readClaim(claimId);
    expect(claim.status).toBe('pending_dispatch');
    expect(claim.next_reconcile_at.getTime()).toBe(
      NOW.getTime() + PLACEMENT_STARTER_RECOVERY_BACKOFF_MS,
    );
  });

  it('honours the per-run cap so a backlog cannot flood the paid queue', async () => {
    await seedClaimsOnDistinctGoals(4);
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
