// @invariant data-irreversibility
// The learner_profile projection must rebuild the same canonical LearnerJudgment
// from the settled records it projects over. This test exercises the durable
// path — append intent → drain → read — and asserts the persisted row carries
// real ability/retention numbers (never an all-null substitute).

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
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

    const rows = await db.select().from(learner_profile).where(eq(learner_profile.knowledge_id, kc));
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
  });
});
