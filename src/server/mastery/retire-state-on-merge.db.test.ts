// YUK-543 — retire-on-merge 3-case matrices for the 4 per-KC state owners (mastery / fsrs / axis /
// kc_typed). Each: neither row → 'noop'; only from → RENAME → 'renamed'; both → FREEZE → 'frozen'.
// NEVER merges a statistic. Plus: the mastery lock is the SHARED fsrs:knowledge namespace (mutual
// exclusion with grading), and kc_typed ALSO rewrites the confused_with_kc_id pointer.

import { db } from '@/db/client';
import {
  kc_typed_state,
  learner_axis_state,
  mastery_state,
  material_fsrs_state,
} from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../tests/helpers/db';
import { retireLearnerAxisStateOnMerge } from '../calibration/axis-writer';
import { retireKcTypedStateOnMerge } from '../conjectures/typed-state';
import { retireFsrsStateOnMerge } from '../fsrs/state';
import { retireMasteryStateOnMerge } from './state';

// The retire fn only reads subject_id; the FSRS Card content is irrelevant to the 3-case logic.
const MINIMAL_FSRS = { stability: 1, difficulty: 5, reps: 0, lapses: 0, state: 0 } as never;

async function insertMastery(subjectId: string) {
  await db.insert(mastery_state).values({ id: `ms_${subjectId}`, subject_id: subjectId });
}
async function insertFsrs(subjectId: string) {
  await db.insert(material_fsrs_state).values({
    id: `fs_${subjectId}`,
    subject_kind: 'knowledge',
    subject_id: subjectId,
    state: MINIMAL_FSRS,
    due_at: new Date(),
  });
}
async function insertAxis(subjectId: string) {
  await db.insert(learner_axis_state).values({ id: `ax_${subjectId}`, subject_id: subjectId });
}
async function insertTyped(subjectId: string, confusedWith?: string) {
  await db.insert(kc_typed_state).values({
    id: `kt_${subjectId}`,
    subject_id: subjectId,
    confused_with_kc_id: confusedWith ?? null,
  });
}

describe('retireMasteryStateOnMerge (YUK-543)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('neither row → noop', async () => {
    const out = await db.transaction((tx) => retireMasteryStateOnMerge(tx, 'k_from', 'k_into'));
    expect(out).toBe('noop');
  });

  it('only from → renamed (row re-keyed to into, from gone)', async () => {
    await insertMastery('k_from');
    const out = await db.transaction((tx) => retireMasteryStateOnMerge(tx, 'k_from', 'k_into'));
    expect(out).toBe('renamed');
    const from = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k_from'));
    const into = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k_into'));
    expect(from).toHaveLength(0);
    expect(into).toHaveLength(1);
  });

  it('both rows → frozen (both retained, no combine)', async () => {
    await insertMastery('k_from');
    await insertMastery('k_into');
    const out = await db.transaction((tx) => retireMasteryStateOnMerge(tx, 'k_from', 'k_into'));
    expect(out).toBe('frozen');
    const rows = await db.select().from(mastery_state);
    expect(rows.map((r) => r.subject_id).sort()).toEqual(['k_from', 'k_into']);
  });

  it('holds the SHARED fsrs:knowledge advisory lock during the merge tx (mutual exclusion w/ grading)', async () => {
    await insertMastery('k_from');
    let heldByRetire = false;
    await db.transaction(async (tx1) => {
      await retireMasteryStateOnMerge(tx1, 'k_from', 'k_into'); // acquires fsrs:knowledge:k_from + :k_into
      // A SEPARATE connection's non-blocking try on the same key must FAIL (lock held by tx1).
      await db.transaction(async (tx2) => {
        const r = (await tx2.execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtext(${'fsrs:knowledge:k_from'})) AS locked`,
        )) as unknown as Array<{ locked: boolean }>;
        heldByRetire = r[0]?.locked === false;
      });
    });
    expect(heldByRetire).toBe(true);
  });
});

describe('retireFsrsStateOnMerge (YUK-543)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('neither → noop', async () => {
    expect(await db.transaction((tx) => retireFsrsStateOnMerge(tx, 'k_from', 'k_into'))).toBe(
      'noop',
    );
  });
  it('only from → renamed', async () => {
    await insertFsrs('k_from');
    expect(await db.transaction((tx) => retireFsrsStateOnMerge(tx, 'k_from', 'k_into'))).toBe(
      'renamed',
    );
    const rows = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'k_into'));
    expect(rows).toHaveLength(1);
  });
  it('both → frozen', async () => {
    await insertFsrs('k_from');
    await insertFsrs('k_into');
    expect(await db.transaction((tx) => retireFsrsStateOnMerge(tx, 'k_from', 'k_into'))).toBe(
      'frozen',
    );
    expect(await db.select().from(material_fsrs_state)).toHaveLength(2);
  });
});

describe('retireLearnerAxisStateOnMerge (YUK-543)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('neither → noop', async () => {
    expect(
      await db.transaction((tx) => retireLearnerAxisStateOnMerge(tx, 'k_from', 'k_into')),
    ).toBe('noop');
  });
  it('only from → renamed', async () => {
    await insertAxis('k_from');
    expect(
      await db.transaction((tx) => retireLearnerAxisStateOnMerge(tx, 'k_from', 'k_into')),
    ).toBe('renamed');
    const rows = await db
      .select()
      .from(learner_axis_state)
      .where(eq(learner_axis_state.subject_id, 'k_into'));
    expect(rows).toHaveLength(1);
  });
  it('both → frozen', async () => {
    await insertAxis('k_from');
    await insertAxis('k_into');
    expect(
      await db.transaction((tx) => retireLearnerAxisStateOnMerge(tx, 'k_from', 'k_into')),
    ).toBe('frozen');
    expect(await db.select().from(learner_axis_state)).toHaveLength(2);
  });
});

describe('retireKcTypedStateOnMerge (YUK-543)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('neither → noop', async () => {
    expect(await db.transaction((tx) => retireKcTypedStateOnMerge(tx, 'k_from', 'k_into'))).toBe(
      'noop',
    );
  });
  it('only from → renamed', async () => {
    await insertTyped('k_from');
    expect(await db.transaction((tx) => retireKcTypedStateOnMerge(tx, 'k_from', 'k_into'))).toBe(
      'renamed',
    );
    const rows = await db
      .select()
      .from(kc_typed_state)
      .where(eq(kc_typed_state.subject_id, 'k_into'));
    expect(rows).toHaveLength(1);
  });
  it('both → frozen', async () => {
    await insertTyped('k_from');
    await insertTyped('k_into');
    expect(await db.transaction((tx) => retireKcTypedStateOnMerge(tx, 'k_from', 'k_into'))).toBe(
      'frozen',
    );
    expect(await db.select().from(kc_typed_state)).toHaveLength(2);
  });
  it('rewrites the confused_with_kc_id pointer on OTHER rows (from → into)', async () => {
    // A row keyed by k_other says "confused with k_from"; after the merge it must say k_into.
    await insertTyped('k_other', 'k_from');
    const out = await db.transaction((tx) => retireKcTypedStateOnMerge(tx, 'k_from', 'k_into'));
    expect(out).toBe('noop'); // no keyed row for k_from itself
    const other = await db
      .select({ confused: kc_typed_state.confused_with_kc_id })
      .from(kc_typed_state)
      .where(eq(kc_typed_state.subject_id, 'k_other'));
    expect(other[0]?.confused).toBe('k_into');
  });
  it('rename AND pointer rewrite compose (from keyed row renamed, sibling pointer repaired)', async () => {
    await insertTyped('k_from');
    await insertTyped('k_other', 'k_from');
    const out = await db.transaction((tx) => retireKcTypedStateOnMerge(tx, 'k_from', 'k_into'));
    expect(out).toBe('renamed');
    const rows = await db.select().from(kc_typed_state);
    const byId = new Map(rows.map((r) => [r.subject_id, r]));
    expect(byId.has('k_into')).toBe(true);
    expect(byId.has('k_from')).toBe(false);
    expect(byId.get('k_other')?.confused_with_kc_id).toBe('k_into');
  });
});
