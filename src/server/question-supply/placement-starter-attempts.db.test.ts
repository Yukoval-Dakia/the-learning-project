import {
  event,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  placement_starter_cost_component,
  question,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  PLACEMENT_ATTEMPT_HEARTBEAT_MS,
  PLACEMENT_ATTEMPT_LEASE_MS,
  PLACEMENT_DECISION_DEADLINE_MS,
  PLACEMENT_QUEUE_EXPIRY_MS,
  PLACEMENT_RENEWAL_CEILING_MS,
  PLACEMENT_VERIFY_POLL_MS,
  acquirePlacementAttempt,
  assertPlacementAuthority,
  countEligiblePlacementQuestions,
  placementDeliveryMetadata,
  placementFulfillmentDisposition,
  reserveAuthorizedPaidCall,
  settleAuthorizedPaidCall,
  startPlacementAttemptHeartbeat,
} from './placement-starter-attempts';

describe('placementDeliveryMetadata', () => {
  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
  ])('maps retryCount %s to paid delivery %s', (retryCount, deliveryNo) => {
    expect(placementDeliveryMetadata({ retryCount, retryLimit: 2 })).toEqual({ deliveryNo });
  });

  it.each([undefined, -1, 0.5, 3, Number.NaN])(
    'rejects malformed retryCount %s before admission',
    (retryCount) => {
      expect(() => placementDeliveryMetadata({ retryCount, retryLimit: 2 })).toThrow(/retryCount/);
    },
  );

  it.each([undefined, 0, 1, 3, 2.5])('rejects retryLimit %s', (retryLimit) => {
    expect(() => placementDeliveryMetadata({ retryCount: 0, retryLimit })).toThrow(/retryLimit/);
  });
});

describe('placement attempt timing contract', () => {
  it('pins poll, lease, heartbeat, deadline, renewal ceiling, and queue expiry', () => {
    expect(PLACEMENT_VERIFY_POLL_MS).toBe(2_000);
    expect(PLACEMENT_ATTEMPT_LEASE_MS).toBe(20 * 60_000);
    expect(PLACEMENT_ATTEMPT_HEARTBEAT_MS).toBe(5 * 60_000);
    expect(PLACEMENT_DECISION_DEADLINE_MS).toBe(105 * 60_000);
    expect(PLACEMENT_RENEWAL_CEILING_MS).toBe(110 * 60_000);
    expect(PLACEMENT_QUEUE_EXPIRY_MS).toBe(120 * 60_000);
  });
});

const CLAIM_ID = 'placement-starter-claim-test';
const JOB_ID = 'job-test';

async function seedClaim(now: Date) {
  await testDb().insert(placement_starter_claim).values({
    id: CLAIM_ID,
    fingerprint: 'placement-starter|test',
    goal_id: 'goal-test',
    semantic_goal_revision_id: 'rev-test',
    subject_id: 'wenyan',
    knowledge_id: 'k-test',
    demand_id: 'demand-test',
    target_id: 'target-test',
    status: 'queued',
    pg_boss_job_id: JOB_ID,
    max_paid_attempts: 3,
    budget_limit_micro_usd: 1_000_000,
    known_cost_micro_usd: 0,
    next_reconcile_at: now,
    created_at: now,
    updated_at: now,
  });
}

async function seedAuthorizedQuestion(
  now: Date,
  input: {
    attemptId: string;
    questionId: string;
    epoch: string;
    status?: 'authorized' | 'superseded';
    draftStatus?: 'draft' | 'active';
  },
) {
  await testDb()
    .insert(question)
    .values({
      id: input.questionId,
      kind: 'short_answer',
      prompt_md: input.questionId,
      reference_md: 'answer',
      knowledge_ids: ['k-test'],
      difficulty: 1,
      source: 'quiz_gen',
      source_ref: 'k-test',
      draft_status: input.draftStatus ?? 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
    });
  await testDb()
    .insert(placement_starter_attempt_question)
    .values({
      attempt_id: input.attemptId,
      claim_id: CLAIM_ID,
      question_id: input.questionId,
      canonical_hash: `hash-${input.questionId}`,
      verification_authority_epoch: input.epoch,
      verification_status: input.status ?? 'authorized',
      created_at: now,
    });
  if ((input.draftStatus ?? 'active') === 'active') {
    await testDb()
      .insert(event)
      .values({
        id: `verify-${input.questionId}`,
        actor_kind: 'agent',
        actor_ref: 'quiz_verify',
        action: 'experimental:quiz_verify',
        subject_kind: 'question',
        subject_id: input.questionId,
        outcome: 'success',
        payload: {},
        created_at: now,
        ingest_at: now,
      });
  }
}

describe('placement attempt authority', () => {
  beforeEach(async () => resetDb());

  it('creates one deterministic attempt per delivery and rejects an active duplicate', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    await seedClaim(now);
    const first = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 1,
      startedOn: now,
      now,
    });
    await expect(
      acquirePlacementAttempt(testDb(), {
        claimId: CLAIM_ID,
        pgBossJobId: JOB_ID,
        deliveryNo: 1,
        startedOn: now,
        now: new Date(now.getTime() + 1_000),
      }),
    ).rejects.toThrow(/active/);
    const rows = await testDb()
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, first.attemptId));
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_no).toBe(1);
    expect(rows[0].lease_expires_at).toEqual(new Date(now.getTime() + 20 * 60_000));
  });

  it('atomically supersedes expired authority rows during takeover', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    await seedClaim(now);
    const first = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 1,
      startedOn: now,
      now,
    });
    await seedAuthorizedQuestion(now, {
      attemptId: first.attemptId,
      questionId: 'q-old',
      epoch: '11111111-1111-4111-8111-111111111111',
    });
    const takeoverAt = new Date(now.getTime() + PLACEMENT_ATTEMPT_LEASE_MS + 1);
    await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 2,
      startedOn: takeoverAt,
      now: takeoverAt,
    });
    const [oldAuthority] = await testDb()
      .select()
      .from(placement_starter_attempt_question)
      .where(eq(placement_starter_attempt_question.question_id, 'q-old'));
    expect(oldAuthority.verification_status).toBe('superseded');
  });

  it('rejects an old verification tuple after fenced takeover', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    await seedClaim(now);
    const first = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 1,
      startedOn: now,
      now,
    });
    const questionId = 'q-authority';
    await testDb()
      .insert(question)
      .values({
        id: questionId,
        kind: 'short_answer',
        prompt_md: 'prompt',
        reference_md: 'answer',
        knowledge_ids: ['k-test'],
        difficulty: 1,
        source: 'quiz_gen',
        source_ref: 'k-test',
        draft_status: 'draft',
        metadata: {},
        created_at: now,
        updated_at: now,
      });
    const epoch = '11111111-1111-4111-8111-111111111111';
    await testDb().insert(placement_starter_attempt_question).values({
      attempt_id: first.attemptId,
      claim_id: CLAIM_ID,
      question_id: questionId,
      canonical_hash: 'hash',
      verification_authority_epoch: epoch,
      verification_status: 'authorized',
      created_at: now,
    });
    await testDb()
      .update(placement_starter_attempt)
      .set({ status: 'verifying' })
      .where(eq(placement_starter_attempt.id, first.attemptId));
    const tuple = {
      claim_id: CLAIM_ID,
      attempt_id: first.attemptId,
      question_id: questionId,
      verification_authority_epoch: epoch,
      fencing_token: first.fencingToken,
    };
    await expect(
      testDb().transaction((tx) => assertPlacementAuthority(tx, tuple, now)),
    ).resolves.toBeUndefined();
    await testDb()
      .update(placement_starter_attempt)
      .set({ fencing_token: '22222222-2222-4222-8222-222222222222' })
      .where(eq(placement_starter_attempt.id, first.attemptId));
    await expect(
      testDb().transaction((tx) => assertPlacementAuthority(tx, tuple, now)),
    ).rejects.toThrow(/stale/);
  });
});

describe('placement attempt heartbeat lifecycle', () => {
  beforeEach(async () => resetDb());

  it('renews every five minutes throughout generation longer than the initial lease', async () => {
    const startedOn = new Date('2026-07-23T00:00:00.000Z');
    await seedClaim(startedOn);
    const attempt = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 1,
      startedOn,
      now: startedOn,
    });
    let clock = startedOn.getTime();
    const waits: Array<() => void> = [];
    const heartbeat = startPlacementAttemptHeartbeat(
      testDb(),
      attempt,
      new AbortController().signal,
      {
        now: () => new Date(clock),
        sleep: async () => new Promise<void>((resolve) => waits.push(resolve)),
      },
    );

    for (let minutes = 5; minutes <= 25; minutes += 5) {
      clock = startedOn.getTime() + minutes * 60_000;
      waits.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [row] = await testDb()
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, attempt.attemptId));
    expect(row.lease_expires_at).toEqual(new Date(startedOn.getTime() + 45 * 60_000));
    await heartbeat.stop();
  });

  it('stops cleanly without renewing after handler cleanup', async () => {
    const startedOn = new Date('2026-07-23T00:00:00.000Z');
    await seedClaim(startedOn);
    const attempt = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 1,
      startedOn,
      now: startedOn,
    });
    let clock = startedOn.getTime();
    const waits: Array<() => void> = [];
    const heartbeat = startPlacementAttemptHeartbeat(
      testDb(),
      attempt,
      new AbortController().signal,
      {
        now: () => new Date(clock),
        sleep: async () => new Promise<void>((resolve) => waits.push(resolve)),
      },
    );
    await heartbeat.stop();
    clock += 10 * 60_000;
    waits.shift()?.();
    await Promise.resolve();
    const [row] = await testDb()
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, attempt.attemptId));
    expect(row.lease_expires_at).toEqual(new Date(startedOn.getTime() + 20 * 60_000));
  });

  it('surfaces fence loss and prevents successful heartbeat completion', async () => {
    const startedOn = new Date('2026-07-23T00:00:00.000Z');
    await seedClaim(startedOn);
    const attempt = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 1,
      startedOn,
      now: startedOn,
    });
    let clock = startedOn.getTime();
    const waits: Array<() => void> = [];
    const heartbeat = startPlacementAttemptHeartbeat(
      testDb(),
      attempt,
      new AbortController().signal,
      {
        now: () => new Date(clock),
        sleep: async () => new Promise<void>((resolve) => waits.push(resolve)),
      },
    );
    await testDb()
      .update(placement_starter_attempt)
      .set({ fencing_token: '33333333-3333-4333-8333-333333333333' })
      .where(eq(placement_starter_attempt.id, attempt.attemptId));
    clock += 5 * 60_000;
    waits.shift()?.();
    await expect(heartbeat.done).rejects.toThrow(/fence lost/);
    await expect(heartbeat.assertHealthy()).rejects.toThrow(/fence lost/);
    await heartbeat.stop();
  });
});

describe('placement paid-call reservations', () => {
  beforeEach(async () => resetDb());

  it('serializes concurrent reservations against the bounded claim budget', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    await seedClaim(now);
    const attempt = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 1,
      startedOn: now,
      now,
    });
    await testDb()
      .update(placement_starter_attempt)
      .set({ status: 'verifying' })
      .where(eq(placement_starter_attempt.id, attempt.attemptId));
    await seedAuthorizedQuestion(now, {
      attemptId: attempt.attemptId,
      questionId: 'q-budget',
      epoch: '11111111-1111-4111-8111-111111111111',
      draftStatus: 'draft',
    });
    const authority = {
      claim_id: CLAIM_ID,
      attempt_id: attempt.attemptId,
      question_id: 'q-budget',
      verification_authority_epoch: '11111111-1111-4111-8111-111111111111',
      fencing_token: attempt.fencingToken,
    };
    const results = await Promise.allSettled([
      testDb().transaction((tx) =>
        reserveAuthorizedPaidCall(tx, {
          authority,
          kind: 'solution_check',
          reservationKey: 'first',
          maxCostMicroUsd: 600_000,
          now,
        }),
      ),
      testDb().transaction((tx) =>
        reserveAuthorizedPaidCall(tx, {
          authority,
          kind: 'teaching_quality',
          reservationKey: 'second',
          maxCostMicroUsd: 600_000,
          now,
        }),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const [claim] = await testDb()
      .select()
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, CLAIM_ID));
    expect(claim.known_cost_micro_usd).toBe(600_000);
  });

  it('settles actual cost without exceeding the reserved budget and is replay-safe', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    await seedClaim(now);
    await testDb()
      .update(placement_starter_claim)
      .set({ budget_limit_micro_usd: 2_000_000 })
      .where(eq(placement_starter_claim.id, CLAIM_ID));
    const attempt = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 1,
      startedOn: now,
      now,
    });
    await testDb()
      .update(placement_starter_attempt)
      .set({ status: 'verifying' })
      .where(eq(placement_starter_attempt.id, attempt.attemptId));
    await seedAuthorizedQuestion(now, {
      attemptId: attempt.attemptId,
      questionId: 'q-settle',
      epoch: '11111111-1111-4111-8111-111111111111',
      draftStatus: 'draft',
    });
    const authority = {
      claim_id: CLAIM_ID,
      attempt_id: attempt.attemptId,
      question_id: 'q-settle',
      verification_authority_epoch: '11111111-1111-4111-8111-111111111111',
      fencing_token: attempt.fencingToken,
    };
    await testDb().transaction((tx) =>
      reserveAuthorizedPaidCall(tx, {
        authority,
        kind: 'solution_check',
        reservationKey: 'settle',
        maxCostMicroUsd: 500_000,
        now,
      }),
    );
    await expect(
      testDb().transaction((tx) =>
        settleAuthorizedPaidCall(tx, {
          authority,
          reservationKey: 'settle',
          providerTaskRunId: 'run-over-cap',
          costMicroUsd: 700_000,
          now,
        }),
      ),
    ).resolves.toEqual({ overCap: true });
    const [overCapComponent] = await testDb().select().from(placement_starter_cost_component);
    expect(overCapComponent).toMatchObject({
      provider_task_run_id: 'run-over-cap',
      cost_micro_usd: 700_000,
    });
    await testDb().transaction((tx) =>
      reserveAuthorizedPaidCall(tx, {
        authority,
        kind: 'solution_check',
        reservationKey: 'settle-normal',
        maxCostMicroUsd: 500_000,
        now,
      }),
    );
    await testDb().transaction((tx) =>
      settleAuthorizedPaidCall(tx, {
        authority,
        reservationKey: 'settle-normal',
        providerTaskRunId: 'run-settle',
        costMicroUsd: 400_000,
        now,
      }),
    );
    await testDb().transaction((tx) =>
      reserveAuthorizedPaidCall(tx, {
        authority,
        kind: 'solution_check',
        reservationKey: 'settle-retry',
        maxCostMicroUsd: 500_000,
        now,
      }),
    );
    await testDb().transaction((tx) =>
      settleAuthorizedPaidCall(tx, {
        authority,
        reservationKey: 'settle-retry',
        providerTaskRunId: 'run-retry',
        costMicroUsd: 300_000,
        now,
      }),
    );
    const components = await testDb().select().from(placement_starter_cost_component);
    expect(components.map((row) => row.provider_task_run_id).sort()).toEqual([
      'run-over-cap',
      'run-retry',
      'run-settle',
    ]);
    expect(components.map((row) => row.cost_micro_usd).sort((a, b) => a - b)).toEqual([
      300_000, 400_000, 700_000,
    ]);
    const [claim] = await testDb()
      .select()
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, CLAIM_ID));
    expect(claim.known_cost_micro_usd).toBe(1_400_000);
  });
});

describe('placement exact fulfillment', () => {
  beforeEach(async () => resetDb());

  it('counts only the current fenced attempt after superseded takeover', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    await seedClaim(now);
    const first = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 1,
      startedOn: now,
      now,
    });
    await seedAuthorizedQuestion(now, {
      attemptId: first.attemptId,
      questionId: 'q-old-count',
      epoch: '11111111-1111-4111-8111-111111111111',
    });
    const takeoverAt = new Date(now.getTime() + PLACEMENT_ATTEMPT_LEASE_MS + 1);
    const second = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 2,
      startedOn: takeoverAt,
      now: takeoverAt,
    });
    for (let index = 0; index < 8; index += 1) {
      await seedAuthorizedQuestion(takeoverAt, {
        attemptId: second.attemptId,
        questionId: `q-current-${index}`,
        epoch: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
      });
    }
    expect(await countEligiblePlacementQuestions(testDb(), CLAIM_ID, second.attemptId)).toBe(8);
    expect(
      placementFulfillmentDisposition(
        await countEligiblePlacementQuestions(testDb(), CLAIM_ID, second.attemptId),
      ),
    ).toBe('satisfied');
  });

  it('succeeds only at exactly eight', () => {
    expect(placementFulfillmentDisposition(8)).toBe('satisfied');
  });

  it('keeps seven underfilled', () => {
    expect(placementFulfillmentDisposition(7)).toBe('underfilled');
  });

  it('rejects nine as an invariant violation', () => {
    expect(() => placementFulfillmentDisposition(9)).toThrow(/exceeded exact count/);
  });
});
