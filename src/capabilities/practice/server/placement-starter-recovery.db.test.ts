// YUK-761 — placement starter recovery sweeper db tests (real Postgres).
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()，不假设跨文件状态/执行序。
//
// 关注点（票面验证清单 + 首轮评审）：超期 pending_dispatch claim 被重驱、未超期不动、幂等重跑
// 不双发、终态 claim 不受影响；retry_scheduled 的**反向**契约——绝不被重驱（会双发付费批次），
// 只在 grace 到期**且** pg-boss job 确已不能重投时才被收割成 'exhausted'；以及两条腿各自独立
// 取数、每条被访问的 claim 都推进游标（防「同一批老 claim 每夜霸占额度、后面的僵尸永不被收割」
// 的饿死路径）。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  resolvePlacementStarterGoalAuthority,
  terminalizeLostPlacementDelivery,
} from '@/kernel/placement';
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
});

describe('sweepStalePlacementStarterClaims — queued/running/verifying recovery', () => {
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
});
