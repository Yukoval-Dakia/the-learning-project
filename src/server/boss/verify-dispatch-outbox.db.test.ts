import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb } from '../../../tests/helpers/db';
import {
  VERIFY_DISPATCH_COMPLETE_ACTION,
  VERIFY_DISPATCH_INTENT_ACTION,
  VERIFY_DISPATCH_VERSION,
  dispatchPendingVerifyIntents,
  recoverOrphanVerifyDispatches,
  writeVerifyDispatchIntent,
} from './verify-dispatch-outbox';

// The un-versioned id the outbox used before intent ids were version-scoped. A stale intent left by
// a different schema version lands here — the same id the synthesizer would reuse if it were not
// version-scoped — so seeding at this id proves the valid replacement does not collide with it.
function legacyUnscopedIntentId(questionId: string, verifier: 'quiz_verify' | 'source_verify') {
  return `verify-dispatch-intent-${createHash('sha256').update(`${verifier}\0${questionId}`).digest('hex')}`;
}

async function seedQuestion(
  id: string,
  source: 'quiz_gen' | 'web_sourced',
  over: Partial<typeof question.$inferInsert> = {},
) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: id,
    source,
    draft_status: 'draft',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  });
}

async function seedIntent(questionId: string, verifier: 'quiz_verify' | 'source_verify') {
  await writeVerifyDispatchIntent(db, { questionId, verifier });
}

describe('verify dispatch outbox (YUK-700)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('unsticks a live draft whose only intent is current-version but schema-incomplete', async () => {
    // Regression (review round-3 codex P2): the round-2 guards only checked `version`, so a
    // current-version intent that still fails the schema — here missing the required question_id —
    // slipped through: the anti-join counted it as "already owned" (no valid replacement synthesized)
    // and dispatch safeParse-dropped it without a completion (never enqueued). Net: draft stuck.
    await seedQuestion('q-incomplete', 'quiz_gen');
    await writeEvent(db, {
      id: legacyUnscopedIntentId('q-incomplete', 'quiz_verify'),
      actor_kind: 'system',
      actor_ref: 'verify_dispatch_outbox',
      action: VERIFY_DISPATCH_INTENT_ACTION,
      subject_kind: 'question',
      subject_id: 'q-incomplete',
      outcome: null,
      // Current version + valid verifier_kind, but no question_id — passes the version guard, fails
      // verifyDispatchIntentPayloadSchema.
      payload: { version: VERIFY_DISPATCH_VERSION, verifier_kind: 'quiz_verify' },
      ingest_at: new Date(),
    });
    const enqueue = vi.fn(async () => {});

    const result = await recoverOrphanVerifyDispatches(db, { enqueue });

    expect(result).toMatchObject({ synthesized: 1, dispatched: 1 });
    expect(enqueue).toHaveBeenCalledWith('quiz_verify', ['q-incomplete'], expect.any(Object));
    const completion = await db
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.subject_id, 'q-incomplete'),
          eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION),
          eq(event.outcome, 'success'),
        ),
      );
    expect(completion).toHaveLength(1);
    expect(completion[0]?.payload).toMatchObject({ recovery: true, disposition: 'enqueued' });

    // Idempotent: a second recovery neither re-synthesizes nor re-enqueues.
    const again = await recoverOrphanVerifyDispatches(db, { enqueue });
    expect(again).toMatchObject({ synthesized: 0, dispatched: 0 });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('keeps placement intent identity scoped to authority while ordinary intents remain deterministic', async () => {
    await seedQuestion('q-authority', 'quiz_gen');
    const first = {
      claim_id: 'claim-1',
      attempt_id: 'attempt-1',
      question_id: 'q-authority',
      verification_authority_epoch: '11111111-1111-4111-8111-111111111111',
      fencing_token: '22222222-2222-4222-8222-222222222222',
    };
    const firstId = await writeVerifyDispatchIntent(db, {
      questionId: 'q-authority',
      verifier: 'quiz_verify',
      placementAuthority: first,
    });
    const secondId = await writeVerifyDispatchIntent(db, {
      questionId: 'q-authority',
      verifier: 'quiz_verify',
      placementAuthority: {
        ...first,
        claim_id: 'claim-2',
        attempt_id: 'attempt-2',
        verification_authority_epoch: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(secondId).not.toBe(firstId);
    const ordinaryId = await writeVerifyDispatchIntent(db, {
      questionId: 'q-authority',
      verifier: 'quiz_verify',
    });
    expect(
      await writeVerifyDispatchIntent(db, {
        questionId: 'q-authority',
        verifier: 'quiz_verify',
      }),
    ).toBe(ordinaryId);
    expect(await db.select().from(event).where(eq(event.subject_id, 'q-authority'))).toHaveLength(
      3,
    );
  });

  it('rolls back the intent when candidate persistence does not commit', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(question).values({
          id: 'q-rollback',
          kind: 'short_answer',
          prompt_md: 'rollback',
          source: 'quiz_gen',
          draft_status: 'draft',
          created_at: new Date(),
          updated_at: new Date(),
        });
        await writeVerifyDispatchIntent(tx, {
          questionId: 'q-rollback',
          verifier: 'quiz_verify',
        });
        throw new Error('simulated worker crash before commit');
      }),
    ).rejects.toThrow('simulated worker crash');
    expect(await db.select().from(question).where(eq(question.id, 'q-rollback'))).toHaveLength(0);
    expect(await db.select().from(event).where(eq(event.subject_id, 'q-rollback'))).toHaveLength(0);
  });

  it('keeps the draft + pending intent after enqueue failure, then recovers verify only', async () => {
    await seedQuestion('q-orphan', 'web_sourced');
    await seedIntent('q-orphan', 'source_verify');
    const failed = await dispatchPendingVerifyIntents(db, {
      enqueue: vi.fn().mockRejectedValue(new Error('boss unavailable')),
    });
    expect(failed.failed).toBe(1);
    const failureEvents = await db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION), eq(event.outcome, 'failure')));
    expect(failureEvents[0]?.payload).toMatchObject({
      stage: 'verify_enqueue',
      recovery: false,
    });
    expect(
      await db
        .select({ id: event.id })
        .from(event)
        .where(
          and(eq(event.subject_id, 'q-orphan'), eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION)),
        ),
    ).toHaveLength(0);
    expect(await db.select().from(question).where(eq(question.id, 'q-orphan'))).toHaveLength(1);

    const recoveredEnqueue = vi.fn(async () => {});
    const recovered = await recoverOrphanVerifyDispatches(db, { enqueue: recoveredEnqueue });
    expect(recovered.dispatched).toBe(1);
    expect(recoveredEnqueue).toHaveBeenCalledWith(
      'source_verify',
      ['q-orphan'],
      expect.any(Object),
    );
    expect(await recoverOrphanVerifyDispatches(db, { enqueue: recoveredEnqueue })).toMatchObject({
      dispatched: 0,
    });
    expect(recoveredEnqueue).toHaveBeenCalledTimes(1);
    const completion = await db
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.subject_id, 'q-orphan'),
          eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION),
          eq(event.outcome, 'success'),
        ),
      );
    expect(completion[0]?.payload).toMatchObject({ recovery: true, disposition: 'enqueued' });
  });

  it('synthesizes missing legacy intents but never resurrects terminal or archived drafts', async () => {
    await seedQuestion('q-legacy', 'quiz_gen');
    await seedQuestion('q-rejected', 'quiz_gen');
    await seedQuestion('q-archived', 'web_sourced', { metadata: { archived_at: new Date() } });
    await seedQuestion('q-active', 'web_sourced', { draft_status: 'active' });
    for (const [id, verifier] of [
      ['q-rejected', 'quiz_verify'],
      ['q-archived', 'source_verify'],
    ] as const) {
      await seedIntent(id, verifier);
    }
    await writeEvent(db, {
      id: createId(),
      actor_kind: 'agent',
      actor_ref: 'quiz_verify',
      action: 'experimental:quiz_verify',
      subject_kind: 'question',
      subject_id: 'q-rejected',
      outcome: 'failure',
      payload: { verdict: 'fail' },
      ingest_at: new Date(),
    });
    const enqueue = vi.fn(async () => {});

    const result = await recoverOrphanVerifyDispatches(db, { enqueue });

    expect(result).toMatchObject({ synthesized: 1, dispatched: 1 });
    expect(enqueue).toHaveBeenCalledWith('quiz_verify', ['q-legacy'], expect.any(Object));
    const completed = await db
      .select({ subjectId: event.subject_id, payload: event.payload })
      .from(event)
      .where(eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION));
    expect(completed.map((row) => row.subjectId).sort()).toEqual([
      'q-archived',
      'q-legacy',
      'q-rejected',
    ]);
    expect(
      completed
        .filter((row) => row.subjectId !== 'q-legacy')
        .every((row) => (row.payload as Record<string, unknown>).disposition === 'terminal_skip'),
    ).toBe(true);
  });

  it('locks intents so concurrent recovery emits one verifier job per question + kind', async () => {
    await Promise.all([seedQuestion('q-c1', 'quiz_gen'), seedQuestion('q-c2', 'quiz_gen')]);
    await Promise.all([seedIntent('q-c1', 'quiz_verify'), seedIntent('q-c2', 'quiz_verify')]);
    const batches: string[][] = [];
    const enqueue = vi.fn(async (_verifier: string, ids: string[]) => {
      batches.push(ids);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await Promise.all([
      dispatchPendingVerifyIntents(db, { enqueue }),
      dispatchPendingVerifyIntents(db, { enqueue }),
    ]);

    expect(batches.flat().sort()).toEqual(['q-c1', 'q-c2']);
    const completions = await db
      .select({ subjectId: event.subject_id })
      .from(event)
      .where(
        and(
          eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION),
          inArray(event.subject_id, ['q-c1', 'q-c2']),
        ),
      );
    expect(completions).toHaveLength(2);
  });
});
