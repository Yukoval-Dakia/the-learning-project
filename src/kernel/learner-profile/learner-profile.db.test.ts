// @invariant data-irreversibility
// The learner_profile projection must rebuild the same canonical LearnerJudgment
// from the settled records it projects over, and a persisted row must serve
// time-derived reads at the caller's later as_of — never a frozen R(t). This
// test exercises the durable path — append intent → drain → read — advances
// the evaluation clock without a new intent, and asserts the persisted row
// re-derives the same numbers as the canonical reader. It also proves an
// operational component failure leaves the pending intent retryable instead
// of being consumed under a degraded row.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { knowledge, learner_profile, mastery_state, material_fsrs_state } from '@/db/schema';
import {
  appendLearnerProfileIntent,
  drainLearnerProfileRefresh,
  readLearnerProfiles,
} from '@/kernel/learner-profile';
import { readLearnerJudgments } from '@/kernel/read-models/learner-judgment';
import { resetDb } from '../../../tests/helpers/db';

async function seedKnowledge(id: string) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: `K-${id}`,
    domain: 'yuwen',
    parent_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedMastery(kcId: string, theta = 1.25, evidence = 4) {
  const now = new Date();
  await db.insert(mastery_state).values({
    id: `mst_${createId()}`,
    subject_kind: 'knowledge',
    subject_id: kcId,
    theta_hat: theta,
    evidence_count: evidence,
    success_count: evidence,
    fail_count: 0,
    last_outcome_at: now,
    updated_at: now,
  });
}

async function seedFsrs(kcId: string) {
  const now = new Date();
  const due = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  await db.insert(material_fsrs_state).values({
    id: newId(),
    subject_kind: 'knowledge',
    subject_id: kcId,
    state: {
      due,
      stability: 4.2,
      difficulty: 5.1,
      scheduled_days: 3,
      learning_steps: 0,
      reps: 3,
      lapses: 0,
      state: 'review',
      last_review: now,
    },
    due_at: due,
    last_review_event_id: null,
    updated_at: now,
  });
}

describe('learner-profile canonical projection', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Dates serialize to ISO strings on the DB round-trip; compare the stored
  // projection and the canonical reader on the same JSON shape.
  const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

  it('rebuilds the persisted row from settled records through intent→drain→read', async () => {
    const kc = `kc_${createId()}`;
    await seedKnowledge(kc);
    await seedMastery(kc);
    await seedFsrs(kc);

    // 1. Intent append (what the settlement producer emits inside its tx).
    await db.transaction(async (tx) => {
      await appendLearnerProfileIntent(tx, {
        knowledgeId: kc,
        sourceKind: 'settlement_event',
        sourceRef: `stl_test_${createId()}`,
      });
    });

    // 2. Read before drain: the getter reports the row stale and still returns
    //    the same canonical judgment (same numbers) as the incumbent reader.
    const stale = await readLearnerProfiles(db, {
      knowledge_ids: [kc],
      as_of: new Date(),
    });
    expect(stale.items).toHaveLength(1);
    expect(stale.items[0].freshness.kind).toBe('missing');
    const canonical = await readLearnerJudgments(db, {
      knowledge_ids: [kc],
      context: 'any',
      as_of: stale.as_of,
    });
    expect(wire(stale.items[0].judgment)).toEqual(wire(canonical.items[0]));

    // 3. Drain: the worker claims the intent, rebuilds and CAS-upserts the row.
    const drained = await drainLearnerProfileRefresh(db);
    expect(drained.refreshed).toBe(1);

    const rows = await db
      .select()
      .from(learner_profile)
      .where(eq(learner_profile.knowledge_id, kc));
    expect(rows).toHaveLength(1);
    expect(rows[0].profile_version).toBe(1);
    expect((rows[0].consumed_intent_ids as string[]).length).toBe(1);
    // Stored components carry the same canonical component reads — real
    // numbers where the records supply them, named unknowns where they do not.
    const storedRetention = rows[0].retention as { kind: string };
    expect(storedRetention.kind).toBe('available');

    // 4. Read after drain: current row — identical judgment to the canonical
    //    reader's same-snapshot output, freshness now 'current'.
    const current = await readLearnerProfiles(db, {
      knowledge_ids: [kc],
      as_of: stale.as_of,
    });
    expect(current.items[0].freshness.kind).toBe('current');
    expect(wire(current.items[0].judgment)).toEqual(wire(canonical.items[0]));
    expect(current.items[0].judgment.retention.kind).toBe('available');

    // 5. P1-1: advance the evaluation clock ~60d with no new intent. The same
    //    persisted row must re-derive R(T1) at the caller's as_of — lower than
    //    R(T0) — and still equal the canonical reader at T1, not the stored T0.
    const t0Retention =
      current.items[0].judgment.retention.kind === 'available'
        ? (current.items[0].judgment.retention.reading as number)
        : null;
    const t1 = new Date(stale.as_of.getTime() + 60 * 24 * 60 * 60 * 1000);
    const later = await readLearnerProfiles(db, { knowledge_ids: [kc], as_of: t1 });
    expect(later.items[0].freshness.kind).toBe('current');
    const canonicalT1 = await readLearnerJudgments(db, {
      knowledge_ids: [kc],
      context: 'any',
      as_of: t1,
    });
    expect(wire(later.items[0].judgment)).toEqual(wire(canonicalT1.items[0]));
    const t1Retention =
      later.items[0].judgment.retention.kind === 'available'
        ? (later.items[0].judgment.retention.reading as number)
        : null;
    expect(t0Retention).not.toBeNull();
    expect(t1Retention).not.toBeNull();
    expect(t1Retention as number).toBeLessThan(t0Retention as number);
  });

  // One operational-failure contract across owned components: a contended
  // component read must abort the drain (strict ProfileComponentError) and
  // leave the intent retryable — never a degraded row consumed under
  // 'current'. Each entry locks the table a different component reads.
  for (const lockedTable of ['material_fsrs_state', 'event'] as const) {
    it(`leaves the intent retryable when ${lockedTable} is contended`, async () => {
      const kc = `kc_${createId()}`;
      await seedKnowledge(kc);
      await seedMastery(kc);
      await seedFsrs(kc);
      await db.transaction(async (tx) => {
        await appendLearnerProfileIntent(tx, {
          knowledgeId: kc,
          sourceKind: 'settlement_event',
          sourceRef: `stl_test_${createId()}`,
        });
      });

      // A real operational failure inside the drain: a second connection
      // holds an ACCESS EXCLUSIVE lock on the component's read target, so the
      // drain's SELECT aborts on lock_timeout after it already holds G.
      // material_fsrs_state → scheduling component; event → the activity clock
      // (seeded card carries no last_review_event_id, so the duration read
      //  short-circuits and the activity read is the one that contends).
      const postgres = (await import('postgres')).default;
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const schema = await import('@/db/schema');
      const url = process.env.TEST_DATABASE_URL;
      if (!url) throw new Error('TEST_DATABASE_URL not set');

      const holder = postgres(url, { max: 1 });
      const drainClient = postgres(url, { max: 1 });
      try {
        await holder`BEGIN`;
        await holder`SET lock_timeout = '5s'`;
        await holder.unsafe(`LOCK TABLE ${lockedTable} IN ACCESS EXCLUSIVE MODE`);

        await drainClient`SET lock_timeout = '300ms'`;
        const drainDb = drizzle(drainClient, {
          schema,
        }) as unknown as import('@/db/client').Db;
        const { drainLearnerProfileRefresh } = await import('@/kernel/learner-profile');
        await expect(drainLearnerProfileRefresh(drainDb)).rejects.toThrow();
      } finally {
        await holder`ROLLBACK`.catch(() => {});
        await holder.end().catch(() => {});
        await drainClient.end().catch(() => {});
      }

      // The intent is still pending — the aborted drain did not consume it.
      const { learner_profile_refresh_intent } = await import('@/db/schema');
      const { isNull } = await import('drizzle-orm');
      const pending = await db
        .select({ id: learner_profile_refresh_intent.id })
        .from(learner_profile_refresh_intent)
        .where(
          and(
            eq(learner_profile_refresh_intent.knowledge_id, kc),
            isNull(learner_profile_refresh_intent.consumed_at),
          ),
        );
      expect(pending.length).toBe(1);
      // No row was written under the failed drain.
      expect(
        (await db.select().from(learner_profile).where(eq(learner_profile.knowledge_id, kc)))
          .length,
      ).toBe(0);

      // Retryable: a clean drain completes the profile from the retained intent.
      const { drainLearnerProfileRefresh } = await import('@/kernel/learner-profile');
      const retried = await drainLearnerProfileRefresh(db);
      expect(retried.refreshed).toBe(1);
      const rows = await db
        .select()
        .from(learner_profile)
        .where(eq(learner_profile.knowledge_id, kc));
      expect(rows).toHaveLength(1);
    });
  }
});
