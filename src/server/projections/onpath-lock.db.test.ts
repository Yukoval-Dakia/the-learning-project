// YUK-499 — DB tests proving each event-sourcing entity's ON-path mutation acquires a FOR UPDATE
// row lock on the entity row BEFORE its project step.
//
// Construction (the "second session blocks" pattern the lane asked for): a SECOND, independent DB
// session opens a tx and holds `SELECT … FOR UPDATE` on the entity row. The ON-path call is then
// fired and MUST block (its promise stays unresolved) for at least LOCK_PROBE_MS — proving the call
// contends for the SAME row lock before it can finish. The holder then releases and the call must
// complete successfully. Were the FOR-UPDATE guard absent, the call would resolve immediately and
// `expect(stillPending).toBe(true)` would fail — so this test is a real regression gate for the lock.
//
// The per-entity SoT-flip flag (PROJECTION_IS_WRITER_*) is intentionally left OFF (default): the
// YUK-499 lock is the FIRST statement of the write tx, taken BEFORE the flag/anchor gate, so it is
// exercised on the OFF path too (and the OFF imperative write still lands the expected final row).
//
// Hermetic: resetDb() + materialized_id_index cleanup in beforeEach (the completion path writes a
// genesis anchor into that no-FK table, so it is not reached by resetDb's CASCADE truncation).

import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { updateGoalStatus } from '@/capabilities/agency/server/goals/queries';
import { acceptCompletionProposal } from '@/capabilities/agency/server/proposal-appliers';
import { newId } from '@/core/ids';
import { goal, learning_item, materialized_id_index, mistake_variant } from '@/db/schema';
import { dismissAiProposal } from '@/server/proposals/actions';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import { writeVariantQuestionProposal } from '@/server/proposals/producers';
import { resetDb, testDb } from '../../../tests/helpers/db';

const T0 = new Date('2026-06-01T00:00:00.000Z');
// The contended call must stay blocked at least this long. The ON-path mutations here complete in
// well under 100ms when unobstructed, so 600ms is a comfortable margin against CI jitter while still
// failing fast if the FOR-UPDATE guard is missing.
const LOCK_PROBE_MS = 600;

// Per-entity SoT-flip flags — cleared around each test (computed-member delete matches the repo
// idiom in goal/learning_item/mistake_variant .db.test.ts and avoids lint/performance/noDelete,
// which only flags static dot-access deletes).
const FLAGS = [
  'PROJECTION_IS_WRITER_GOAL',
  'PROJECTION_IS_WRITER_LEARNING_ITEM',
  'PROJECTION_IS_WRITER_MISTAKE_VARIANT',
] as const;

type LockableTable = 'goal' | 'learning_item' | 'mistake_variant';

/**
 * Hold `SELECT … FOR UPDATE` on (table, rowId) in a SEPARATE session, then run `contended()` while
 * the lock is held. Assert the contended promise does NOT resolve within LOCK_PROBE_MS (it is
 * blocked on the same row lock), release the holder, and assert the contended call then completes
 * successfully. `table` is a fixed union (never user input), so it is safe to interpolate.
 */
async function assertContendedCallBlocksOnRowLock(
  table: LockableTable,
  rowId: string,
  contended: () => Promise<unknown>,
): Promise<void> {
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

    // Open a tx on the holder session, take the row lock, signal acquired, then hold until released.
    const holdTx = holder.begin(async (sql) => {
      await sql.unsafe(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [rowId]);
      acquired();
      await released;
    });

    await acquiredP; // ensure the holder owns the row lock BEFORE firing the contended call

    let done = false;
    let err: unknown;
    const contendedP = contended().then(
      () => {
        done = true;
      },
      (e) => {
        err = e;
        done = true;
      },
    );

    await new Promise((r) => setTimeout(r, LOCK_PROBE_MS));
    // The contended ON-path call must STILL be blocked on the FOR UPDATE the holder owns. If this is
    // false, the call did not contend for the row lock before its project step (the YUK-499 guard is
    // missing / mis-placed).
    expect(done).toBe(false);

    release();
    await holdTx;
    await contendedP;
    // Once the lock is free the call must SUCCEED (not error out).
    expect(done).toBe(true);
    if (err) throw err;
  } finally {
    await holder.end({ timeout: 5 });
  }
}

describe('YUK-499 — ON-path mutations hold a FOR UPDATE row lock before the project step', () => {
  beforeEach(async () => {
    await resetDb();
    await testDb().delete(materialized_id_index); // no FK → not reached by resetDb CASCADE
    for (const f of FLAGS) delete process.env[f];
  });
  afterEach(() => {
    for (const f of FLAGS) delete process.env[f];
  });

  it('goal: updateGoalStatus blocks while the goal row is FOR-UPDATE-locked, then commits', async () => {
    const db = testDb();
    const goalId = 'goal_lock';
    await db.insert(goal).values({
      id: goalId,
      title: 'G',
      subject_id: null,
      scope_knowledge_ids: ['k_a'],
      sequence_hint: 0,
      status: 'active',
      source: 'manual',
      source_ref: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    });

    await assertContendedCallBlocksOnRowLock('goal', goalId, () =>
      updateGoalStatus(db, goalId, 'dormant'),
    );

    const [row] = await db.select().from(goal).where(eq(goal.id, goalId)).limit(1);
    expect(row?.status).toBe('dormant');
  }, 20000);

  it('learning_item: acceptCompletionProposal blocks while the item row is FOR-UPDATE-locked, then commits', async () => {
    const db = testDb();
    const itemId = 'li_lock';
    await db.insert(learning_item).values({
      id: itemId,
      source: 'learning_intent',
      source_ref: null,
      title: 'Item',
      content: 'content',
      knowledge_ids: ['k_a'],
      primary_artifact_id: null,
      parent_learning_item_id: null,
      status: 'pending',
      user_pinned: false,
      completed_at: null,
      dismissed_at: null,
      archived_at: null,
      archived_reason: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    });
    const inbox = {
      kind: 'completion',
      payload: { proposed_change: { learning_item_id: itemId } },
    } as unknown as ProposalInboxRow;

    await assertContendedCallBlocksOnRowLock('learning_item', itemId, () =>
      acceptCompletionProposal(db as never, newId(), inbox, {}),
    );

    const [row] = await db
      .select()
      .from(learning_item)
      .where(eq(learning_item.id, itemId))
      .limit(1);
    expect(row?.status).toBe('done');
  }, 20000);

  it('mistake_variant: dismissAiProposal (variant_question) blocks while the draft row is FOR-UPDATE-locked, then commits', async () => {
    const db = testDb();
    const proposalId = await writeVariantQuestionProposal(db as never, {
      reason_md: 'because',
      source_question_id: 'q_src',
      source_attempt_event_id: 'ev_att',
      prompt_md: 'prompt',
      reference_md: 'reference',
      difficulty: 3,
      knowledge_ids: ['k_a'],
      parent_variant_id: '',
      root_question_id: 'q_src',
      variant_depth: 1,
    });
    const mvId = 'mv_lock';
    await db.insert(mistake_variant).values({
      id: mvId,
      parent_question_id: 'q_src',
      variant_question_id: null,
      proposal_event_id: proposalId,
      status: 'draft',
      failure_reasons: [],
      cause_category: 'concept_confusion',
      created_at: T0,
      updated_at: T0,
    });

    await assertContendedCallBlocksOnRowLock('mistake_variant', mvId, () =>
      dismissAiProposal(db, proposalId),
    );

    const [row] = await db
      .select()
      .from(mistake_variant)
      .where(eq(mistake_variant.id, mvId))
      .limit(1);
    expect(row?.status).toBe('dismissed');
  }, 20000);
});
