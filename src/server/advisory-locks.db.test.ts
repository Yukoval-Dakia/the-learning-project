// YUK-497 — two-connection regressions for the GLOBAL learning-state write lock
// ('learning-state:write', src/server/advisory-locks.ts).
//
// Review findings closed here (REQUEST CHANGES round on yuk-497-copilot-checkpoint-revert):
//   1. Absent-row / check-then-insert races: every production material_fsrs_state /
//      mastery_state writer serializes behind ONE global advisory lock at tx entry —
//      while ANY learning-state tx is in flight, a second writer cannot even run its
//      existence check, so noncooperative-writer and absent-row races are closed.
//   2. Multi-key deadlock overlap: submit locks the FSRS subset (e.g. {b}) then the θ̂
//      superset {a,b} via updateThetaForAttempt, while revert/merge sort-lock {a,b}.
//      With the global lock FIRST at tx entry the per-key fsrs:* locks can no longer
//      form a cycle, so overlapping writers must complete with ZERO 40P01.
//
// Construction mirrors onpath-lock.db.test.ts ("second session blocks"): a SECOND
// independent DB session holds the GLOBAL lock; the contended side is fired and must
// stay pending for LOCK_PROBE_MS, then complete after release. The contended side is
// always a REAL production writer (the live /api/review/submit route handler, the
// updateThetaForAttempt tx shape auto-enroll runs, the merge retire pair, and the
// shared upsert primitives) — NOT a synthetic cooperative writer.

import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';

import { POST as submitPOST } from '@/capabilities/practice/api/submit';
import { initialFsrsState } from '@/capabilities/practice/server/fsrs';
import { newId } from '@/core/ids';
import { knowledge, mastery_state, material_fsrs_state, question } from '@/db/schema';
import { retireFsrsStateOnMerge, upsertFsrsState } from '@/server/fsrs/state';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import {
  retireMasteryStateOnMerge,
  updateThetaForAttempt,
  upsertMasteryState,
} from '@/server/mastery/state';
import { resetDb, testDb } from '../../tests/helpers/db';

// The contended production writer must stay blocked at least this long. Unobstructed,
// each writer here completes in well under 100ms, so 600ms is a comfortable margin
// against CI jitter while still failing fast if the global-lock acquisition is missing.
const LOCK_PROBE_MS = 600;
const GLOBAL_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('learning-state:write'))";

async function seedKnowledge(id: string) {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain: 'yuwen',
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedQuestion(id: string, knowledgeIds: string[]) {
  const now = new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'short_answer',
      prompt_md: `Prompt ${id}`,
      reference_md: null,
      knowledge_ids: knowledgeIds,
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

function submitReq(body: unknown) {
  return new Request('http://localhost/api/review/submit', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Hold the GLOBAL learning-state lock on a SEPARATE session, fire `contended()` (a real
 * production writer), assert it does NOT settle within LOCK_PROBE_MS, release the holder,
 * and return the contended result (which must then complete successfully).
 */
async function assertBlocksOnGlobalLock<T>(contended: () => Promise<T>): Promise<T> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set — globalSetup did not run');
  const holder = postgres(url, { max: 1 });
  try {
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let acquired!: () => void;
    const acquiredP = new Promise<void>((r) => {
      acquired = r;
    });
    const holdTx = holder.begin(async (sql) => {
      await sql.unsafe(GLOBAL_LOCK_SQL);
      acquired();
      await released;
    });
    await acquiredP;

    let settled = false;
    const contendedP = contended().finally(() => {
      settled = true;
    });
    // Swallow nothing: a rejection settles too and fails the pending assertion below
    // (and re-throws when awaited at the end).
    await new Promise((r) => setTimeout(r, LOCK_PROBE_MS));
    expect(settled).toBe(false);

    release();
    await holdTx;
    return await contendedP;
  } finally {
    await holder.end({ timeout: 5 });
  }
}

describe('YUK-497 — global learning-state write lock (two-connection regressions)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
  });

  it('the LIVE /api/review/submit route blocks behind the global lock, then lands its FSRS/θ̂ writes', async () => {
    const kc = newId();
    const qId = newId();
    await seedKnowledge(kc);
    await seedQuestion(qId, [kc]);

    const res = await assertBlocksOnGlobalLock(() =>
      submitPOST(submitReq({ mistake_id: qId, rating: 'good', latency_ms: 1200 })),
    );
    expect(res.status).toBeLessThan(300);

    const fsrsRows = await testDb()
      .select({ id: material_fsrs_state.id })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          eq(material_fsrs_state.subject_id, kc),
        ),
      );
    expect(fsrsRows).toHaveLength(1);
    const thetaRows = await testDb()
      .select({ id: mastery_state.id })
      .from(mastery_state)
      .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, kc)));
    expect(thetaRows).toHaveLength(1);
  });

  it('upsertFsrsState (absent-row insert path) blocks behind the global lock', async () => {
    const kc = newId();
    await seedKnowledge(kc);
    const initial = initialFsrsState(new Date());

    await assertBlocksOnGlobalLock(() =>
      upsertFsrsState(testDb(), {
        subject_kind: 'knowledge',
        subject_id: kc,
        state: initial.state,
        due_at: initial.dueAt,
        last_review_event_id: null,
      }),
    );

    const rows = await testDb()
      .select({ id: material_fsrs_state.id })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          eq(material_fsrs_state.subject_id, kc),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('upsertMasteryState (absent-row insert path) blocks behind the global lock', async () => {
    const kc = newId();
    await seedKnowledge(kc);

    await assertBlocksOnGlobalLock(() =>
      upsertMasteryState(testDb(), {
        subject_id: kc,
        theta_hat: 0.4,
        evidence_count: 1,
        success_count: 1,
        fail_count: 0,
        last_outcome_at: new Date(),
      }),
    );

    const rows = await testDb()
      .select({ id: mastery_state.id })
      .from(mastery_state)
      .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, kc)));
    expect(rows).toHaveLength(1);
  });

  it('updateThetaForAttempt (auto-enroll/submit tx shape) blocks behind the global lock', async () => {
    const kcA = newId();
    const kcB = newId();
    const qId = newId();
    await seedKnowledge(kcA);
    await seedKnowledge(kcB);
    await seedQuestion(qId, [kcA, kcB]);

    await assertBlocksOnGlobalLock(() =>
      testDb().transaction((tx) =>
        updateThetaForAttempt(tx, {
          knowledgeIds: [kcA, kcB],
          questionId: qId,
          outcome: 1,
          difficulty: 3,
          attemptEventId: newId(),
          now: new Date(),
        }),
      ),
    );

    const rows = await testDb()
      .select({ subject_id: mastery_state.subject_id })
      .from(mastery_state)
      .where(eq(mastery_state.subject_kind, 'knowledge'));
    expect(new Set(rows.map((r) => r.subject_id))).toEqual(new Set([kcA, kcB]));
  });

  it('merge retire pair (retireMasteryStateOnMerge + retireFsrsStateOnMerge) blocks behind the global lock', async () => {
    const from = newId();
    const into = newId();
    await seedKnowledge(from);
    await seedKnowledge(into);
    await upsertMasteryState(testDb(), {
      subject_id: from,
      theta_hat: 0.2,
      evidence_count: 2,
      success_count: 1,
      fail_count: 1,
      last_outcome_at: new Date(),
    });
    const initial = initialFsrsState(new Date());
    await upsertFsrsState(testDb(), {
      subject_kind: 'knowledge',
      subject_id: from,
      state: initial.state,
      due_at: initial.dueAt,
      last_review_event_id: null,
    });

    const outcome = await assertBlocksOnGlobalLock(() =>
      testDb().transaction(async (tx) => ({
        mastery: await retireMasteryStateOnMerge(tx, from, into),
        fsrs: await retireFsrsStateOnMerge(tx, from, into),
      })),
    );
    expect(outcome).toEqual({ mastery: 'renamed', fsrs: 'renamed' });
  });

  it('submit subset {b}→superset {a,b} vs merge sorted {a,b}: overlapping writers never deadlock', async () => {
    const kcA = newId();
    const kcB = newId();
    const qId = newId();
    await seedKnowledge(kcA);
    await seedKnowledge(kcB);
    // Question labelled {a,b}; the submit body requests only {b}, so the route's
    // per-subject FSRS pre-locks cover the SUBSET {b} while updateThetaForAttempt
    // later locks the SUPERSET {a,b} — the exact pre-fix deadlock shape against a
    // sorted {a,b} acquirer.
    await seedQuestion(qId, [kcA, kcB]);

    for (let i = 0; i < 6; i++) {
      __resetRateLimitForTests();
      const submitShaped = submitPOST(
        submitReq({
          mistake_id: qId,
          rating: i % 2 === 0 ? 'good' : 'again',
          referenced_knowledge_ids: [kcB],
        }),
      ).then((res) => {
        expect(res.status).toBeLessThan(300);
      });
      const mergeShaped = testDb().transaction(async (tx) => {
        // Real merge writers, sorted-{a,b} acquisition (fsrs:knowledge namespace).
        await retireMasteryStateOnMerge(tx, kcA, kcB);
        await retireFsrsStateOnMerge(tx, kcA, kcB);
      });

      const results = await Promise.allSettled([submitShaped, mergeShaped]);
      for (const r of results) {
        if (r.status === 'rejected') {
          const code = (r.reason as { code?: string } | undefined)?.code;
          // 40P01 = deadlock_detected — the regression this test exists for.
          expect(code).not.toBe('40P01');
          throw r.reason;
        }
      }
    }
  });
});
