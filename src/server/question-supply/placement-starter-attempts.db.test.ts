import {
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
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
  placementDeliveryMetadata,
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
