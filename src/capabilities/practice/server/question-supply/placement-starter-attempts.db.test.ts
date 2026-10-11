import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  event,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  placement_starter_cost_component,
  question,
} from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import {
  PLACEMENT_ATTEMPT_LEASE_MS,
  PlacementStarterStaleAuthorityError,
  PlacementStarterUnknownCostError,
  acquirePlacementAttempt,
  finishPlacementAttempt,
  recordPlacementAttemptOutput,
  reserveAuthorizedPaidCall,
  settleAuthorizedPaidCall,
  terminalizePlacementUnknownCost,
} from './placement-starter-attempts';
import { placementSchemaFailure } from './placement-starter-outcome';

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

  it('atomically seals schema failure with terminal claim status and retains the immutable paid receipt', async () => {
    const now = new Date('2026-10-10T00:00:00.000Z');
    await seedClaim(now);
    const attempt = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 3,
      startedOn: now,
      now,
    });
    await recordPlacementAttemptOutput(testDb(), attempt, {
      taskRunId: 'successful-model-schema-rejected',
      outputText: 'immutable provider receipt',
      costMicroUsd: 18885,
      now,
    });
    const reason = placementSchemaFailure([
      {
        code: 'invalid_type',
        expected: 'object',
        path: ['questions', 0, 'rubric_json', 'reference_solution'],
        message: 'private provider value',
      },
    ]);
    await finishPlacementAttempt(testDb(), attempt, 'interrupted', now, reason);
    const [claim] = await testDb().select().from(placement_starter_claim);
    const [finished] = await testDb().select().from(placement_starter_attempt);
    const receipts = await testDb().select().from(placement_starter_cost_component);
    expect(claim).toMatchObject({
      status: 'exhausted',
      known_cost_micro_usd: 18885,
      last_error_code: 'schema_invalid',
      last_error: JSON.stringify(reason),
    });
    expect(finished).toMatchObject({
      status: 'interrupted',
      lease_expires_at: null,
      error_code: 'schema_invalid',
      error_message: JSON.stringify(reason),
      provider_task_run_id: 'successful-model-schema-rejected',
    });
    expect(finished?.provider_output_hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(finishPlacementAttempt(testDb(), attempt, 'succeeded', now)).rejects.toThrow(
      PlacementStarterStaleAuthorityError,
    );
    expect(await testDb().select().from(placement_starter_claim)).toEqual([claim]);
    expect(await testDb().select().from(placement_starter_attempt)).toEqual([finished]);
    expect(await testDb().select().from(placement_starter_cost_component)).toEqual(receipts);
  });

  it('rolls back reason and attempt finalization when claim authority is already fail-closed', async () => {
    const now = new Date('2026-10-10T00:00:00.000Z');
    await seedClaim(now);
    const attempt = await acquirePlacementAttempt(testDb(), {
      claimId: CLAIM_ID,
      pgBossJobId: JOB_ID,
      deliveryNo: 3,
      startedOn: now,
      now,
    });
    await seedAuthorizedQuestion(now, {
      attemptId: attempt.attemptId,
      questionId: 'late-authority',
      epoch: '11111111-1111-4111-8111-111111111111',
    });
    await testDb()
      .update(placement_starter_claim)
      .set({
        status: 'exhausted',
        exhausted_at: now,
        known_cost_micro_usd: null,
        last_error_code: 'cost_unknown',
      })
      .where(eq(placement_starter_claim.id, CLAIM_ID));
    const before = {
      claim: await testDb().select().from(placement_starter_claim),
      attempts: await testDb().select().from(placement_starter_attempt),
      links: await testDb().select().from(placement_starter_attempt_question),
    };
    await expect(
      finishPlacementAttempt(testDb(), attempt, 'interrupted', now, { code: 'json_invalid' }),
    ).rejects.toThrow(PlacementStarterStaleAuthorityError);
    expect(await testDb().select().from(placement_starter_claim)).toEqual(before.claim);
    expect(await testDb().select().from(placement_starter_attempt)).toEqual(before.attempts);
    expect(await testDb().select().from(placement_starter_attempt_question)).toEqual(before.links);
  });

  it.each(['fence', 'expired', 'job', 'claim', 'delivery'] as const)(
    'rejects a %s mismatch without writing any failure reason',
    async (mismatch) => {
      const now = new Date('2026-10-10T00:00:00.000Z');
      await seedClaim(now);
      const attempt = await acquirePlacementAttempt(testDb(), {
        claimId: CLAIM_ID,
        pgBossJobId: JOB_ID,
        deliveryNo: 1,
        startedOn: now,
        now,
      });
      const altered = {
        ...attempt,
        fencingToken:
          mismatch === 'fence' ? '11111111-1111-4111-8111-111111111111' : attempt.fencingToken,
        pgBossJobId: mismatch === 'job' ? 'other-job' : attempt.pgBossJobId,
        claimId: mismatch === 'claim' ? 'other-claim' : attempt.claimId,
        deliveryNo: mismatch === 'delivery' ? 3 : attempt.deliveryNo,
      };
      const claims = await testDb().select().from(placement_starter_claim);
      const attempts = await testDb().select().from(placement_starter_attempt);
      await expect(
        finishPlacementAttempt(
          testDb(),
          altered,
          'interrupted',
          mismatch === 'expired' ? attempt.leaseExpiresAt : now,
          { code: 'json_invalid' },
        ),
      ).rejects.toThrow(PlacementStarterStaleAuthorityError);
      expect(await testDb().select().from(placement_starter_claim)).toEqual(claims);
      expect(await testDb().select().from(placement_starter_attempt)).toEqual(attempts);
    },
  );

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
    ).resolves.toEqual({ overCap: true, costUnknown: false });
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
    ).resolves.toEqual({ overCap: true, costUnknown: false });
    const [overCapComponent] = await testDb().select().from(placement_starter_cost_component);
    expect(overCapComponent).toMatchObject({
      provider_task_run_id: 'run-over-cap',
      cost_micro_usd: 700_000,
      over_cap: true,
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
    await expect(
      testDb().transaction((tx) =>
        settleAuthorizedPaidCall(tx, {
          authority,
          reservationKey: 'settle-normal',
          providerTaskRunId: 'run-settle',
          costMicroUsd: 400_000,
          now,
        }),
      ),
    ).resolves.toEqual({ overCap: false, costUnknown: false });
    await expect(
      testDb().transaction((tx) =>
        settleAuthorizedPaidCall(tx, {
          authority,
          reservationKey: 'settle-normal',
          providerTaskRunId: 'run-settle',
          costMicroUsd: 400_000,
          now,
        }),
      ),
    ).resolves.toEqual({ overCap: false, costUnknown: false });
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
    expect(components.map((row) => row.cost_micro_usd).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      [300_000, 400_000, 700_000],
    );
    expect(components.find((row) => row.provider_task_run_id === 'run-settle')?.over_cap).toBe(
      false,
    );
    const [claim] = await testDb()
      .select()
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, CLAIM_ID));
    expect(claim.known_cost_micro_usd).toBe(1_400_000);
    await testDb()
      .update(placement_starter_cost_component)
      .set({ over_cap: null })
      .where(eq(placement_starter_cost_component.provider_task_run_id, 'run-settle'));
    await expect(
      testDb().transaction((tx) =>
        settleAuthorizedPaidCall(tx, {
          authority,
          reservationKey: 'settle-normal',
          providerTaskRunId: 'run-settle',
          costMicroUsd: 400_000,
          now,
        }),
      ),
    ).rejects.toThrow(/missing over-cap disposition/);
  });

  it('replays one unknown settlement after terminalization without another adjustment', async () => {
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
      questionId: 'q-unknown-cost',
      epoch: '11111111-1111-4111-8111-111111111111',
      draftStatus: 'draft',
    });
    await seedAuthorizedQuestion(now, {
      attemptId: attempt.attemptId,
      questionId: 'q-already-satisfied',
      epoch: '11111111-1111-4111-8111-111111111125',
      draftStatus: 'draft',
    });
    await testDb()
      .update(placement_starter_attempt_question)
      .set({ verification_status: 'satisfied' })
      .where(eq(placement_starter_attempt_question.question_id, 'q-already-satisfied'));
    const authority = {
      claim_id: CLAIM_ID,
      attempt_id: attempt.attemptId,
      question_id: 'q-unknown-cost',
      verification_authority_epoch: '11111111-1111-4111-8111-111111111111',
      fencing_token: attempt.fencingToken,
    };
    await testDb().transaction((tx) =>
      reserveAuthorizedPaidCall(tx, {
        authority,
        kind: 'solution_check',
        reservationKey: 'unknown-cost',
        now,
      }),
    );
    await expect(
      testDb().transaction((tx) =>
        settleAuthorizedPaidCall(tx, {
          authority,
          reservationKey: 'unknown-cost',
          providerTaskRunId: 'run-unknown-cost',
          costMicroUsd: null,
          now,
        }),
      ),
    ).resolves.toEqual({ overCap: false, costUnknown: true });
    await expect(
      testDb().transaction((tx) =>
        reserveAuthorizedPaidCall(tx, {
          authority,
          kind: 'teaching_quality',
          reservationKey: 'after-unknown',
          now,
        }),
      ),
    ).rejects.toBeInstanceOf(PlacementStarterUnknownCostError);
    await terminalizePlacementUnknownCost(testDb(), {
      claimId: CLAIM_ID,
      attemptId: attempt.attemptId,
      fencingToken: attempt.fencingToken,
      now,
    });
    await expect(
      testDb().transaction((tx) =>
        settleAuthorizedPaidCall(tx, {
          authority,
          reservationKey: 'unknown-cost',
          providerTaskRunId: 'run-unknown-cost',
          costMicroUsd: 25_000,
          now,
        }),
      ),
    ).resolves.toEqual({ overCap: false, costUnknown: true });
    await expect(
      testDb().transaction((tx) =>
        settleAuthorizedPaidCall(tx, {
          authority,
          reservationKey: 'unknown-cost',
          providerTaskRunId: 'run-not-the-exact-replay',
          costMicroUsd: null,
          now,
        }),
      ),
    ).rejects.toBeInstanceOf(PlacementStarterStaleAuthorityError);

    const components = await testDb().select().from(placement_starter_cost_component);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      provider_task_run_id: 'run-unknown-cost',
      cost_micro_usd: null,
      over_cap: null,
    });
    const [claim] = await testDb()
      .select()
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, CLAIM_ID));
    expect(claim.status).toBe('exhausted');
    expect(claim.known_cost_micro_usd).toBeNull();
    const [terminalAttempt] = await testDb()
      .select()
      .from(placement_starter_attempt)
      .where(eq(placement_starter_attempt.id, attempt.attemptId));
    expect(terminalAttempt.status).toBe('invariant_failed');
    const attemptQuestions = await testDb()
      .select()
      .from(placement_starter_attempt_question)
      .where(eq(placement_starter_attempt_question.attempt_id, attempt.attemptId));
    expect(
      Object.fromEntries(attemptQuestions.map((row) => [row.question_id, row.verification_status])),
    ).toEqual({
      'q-already-satisfied': 'satisfied',
      'q-unknown-cost': 'exhausted',
    });
    const componentsAfterRejectedReservation = await testDb()
      .select()
      .from(placement_starter_cost_component);
    expect(
      componentsAfterRejectedReservation.some((component) =>
        component.provider_task_run_id.startsWith('reservation:'),
      ),
    ).toBe(false);
  });

  it('serializes concurrent exact settlement replay to one canonical adjustment', async () => {
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
      questionId: 'q-concurrent-settle',
      epoch: '11111111-1111-4111-8111-111111111124',
      draftStatus: 'draft',
    });
    const authority = {
      claim_id: CLAIM_ID,
      attempt_id: attempt.attemptId,
      question_id: 'q-concurrent-settle',
      verification_authority_epoch: '11111111-1111-4111-8111-111111111124',
      fencing_token: attempt.fencingToken,
    };
    await testDb().transaction((tx) =>
      reserveAuthorizedPaidCall(tx, {
        authority,
        kind: 'solution_check',
        reservationKey: 'concurrent-exact',
        maxCostMicroUsd: 50_000,
        now,
      }),
    );

    const results = await Promise.all([
      testDb().transaction((tx) =>
        settleAuthorizedPaidCall(tx, {
          authority,
          reservationKey: 'concurrent-exact',
          providerTaskRunId: 'run-concurrent-exact',
          costMicroUsd: 75_000,
          now,
        }),
      ),
      testDb().transaction((tx) =>
        settleAuthorizedPaidCall(tx, {
          authority,
          reservationKey: 'concurrent-exact',
          providerTaskRunId: 'run-concurrent-exact',
          costMicroUsd: 75_000,
          now,
        }),
      ),
    ]);

    expect(results).toEqual([
      { overCap: true, costUnknown: false },
      { overCap: true, costUnknown: false },
    ]);
    const components = await testDb().select().from(placement_starter_cost_component);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      provider_task_run_id: 'run-concurrent-exact',
      cost_micro_usd: 75_000,
      over_cap: true,
    });
    const [claim] = await testDb()
      .select()
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, CLAIM_ID));
    expect(claim.known_cost_micro_usd).toBe(75_000);
  });
});
