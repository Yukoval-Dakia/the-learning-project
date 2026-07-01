// YUK-531 (A5 S4 / RT1) — Tier-1 F1 fix: the two-track UPSERT guard on the misconception
// promotion writer. Drives promoteConjectureToMisconception directly against real rows to prove
// the three F1 invariants that become load-bearing once the dark hard track coexists with soft:
//   ① source is MONOTONE soft→hard — a plain soft re-accept NEVER downgrades a confirmed hard row,
//   ② archived_at is NOT unconditionally reset — only an explicit reactivate clears it,
//   ③ the `misc:<id>` advisory lock serializes concurrent promotes of the same cause×KC.
// (The flag-gated live accept path is covered in conjecture-accept.db.test.ts.)
import {
  type PromoteConjectureInput,
  promoteConjectureToMisconception,
} from '@/capabilities/agency/server/misconception-promote';
import type { Tx } from '@/db/client';
import { misconception, misconception_edge } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const CAUSE = 'concept';
const KC = 'kn_chain_rule';

function promoteInput(over: Partial<PromoteConjectureInput> = {}): PromoteConjectureInput {
  return {
    conjectureId: 'cj_1',
    knowledgeId: KC,
    claimMd: 'you treat the chain rule as multiplying derivatives',
    causeCategory: CAUSE,
    confidence: 0.7,
    recurrenceCount: 2,
    evidenceEventIds: ['evt_a', 'evt_b'],
    now: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

async function promote(over: Partial<PromoteConjectureInput> = {}) {
  const db = testDb();
  return db.transaction((tx: Tx) => promoteConjectureToMisconception(tx, promoteInput(over)));
}

async function miscRows() {
  return testDb().select().from(misconception);
}

describe('promoteConjectureToMisconception — F1 two-track UPSERT guard', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('① a soft re-accept NEVER downgrades a confirmed hard row (source is monotone soft→hard)', async () => {
    // Mint the row on the HARD track first (a future decideDissociation()==='HARD_CONFIRM' path).
    const first = await promote({ source: 'hard' });
    let rows = await miscRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('hard');

    // A later SOFT re-induction (different proposal, same cause×KC ⇒ same deterministic id).
    const second = await promote({ source: 'soft', conjectureId: 'cj_2' });
    expect(second.misconceptionId).toBe(first.misconceptionId);

    rows = await miscRows();
    expect(rows).toHaveLength(1);
    // Downgrade REFUSED — stays hard (this was the silent-demotion F1 bug).
    expect(rows[0].source).toBe('hard');
  });

  it('allows the intended soft→hard UPGRADE (monotone direction is one-way, not frozen)', async () => {
    await promote({ source: 'soft' });
    expect((await miscRows())[0].source).toBe('soft');

    await promote({ source: 'hard', conjectureId: 'cj_2' });
    const rows = await miscRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('hard');
  });

  it('② a plain re-accept does NOT un-archive a soft-archived node; reactivate:true does', async () => {
    const minted = await promote({ source: 'soft' });
    const db = testDb();
    // Simulate the retire/reconcile ring soft-archiving the node.
    await db
      .update(misconception)
      .set({ archived_at: new Date('2026-07-05T00:00:00Z') })
      .where(eq(misconception.id, minted.misconceptionId));

    // A plain soft re-accept must PRESERVE archived_at (no silent resurrection).
    await promote({ source: 'soft', conjectureId: 'cj_2', now: new Date('2026-07-06T00:00:00Z') });
    let rows = await miscRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].archived_at).not.toBeNull();

    // An EXPLICIT reactivation un-archives immediately (design §Tier1-8).
    await promote({
      source: 'soft',
      conjectureId: 'cj_3',
      reactivate: true,
      now: new Date('2026-07-07T00:00:00Z'),
    });
    rows = await miscRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].archived_at).toBeNull();
  });

  it('③ the misc:<id> advisory lock serializes concurrent promotes of the same cause×KC into one consistent row', async () => {
    const db = testDb();
    // Two concurrent promotes of the SAME identity, one hard + one soft. Regardless of scheduling
    // the advisory lock (+ monotone SET) collapses them to ONE row that is NEVER downgraded.
    await Promise.all([
      db.transaction((tx: Tx) =>
        promoteConjectureToMisconception(
          tx,
          promoteInput({ source: 'hard', conjectureId: 'cj_h' }),
        ),
      ),
      db.transaction((tx: Tx) =>
        promoteConjectureToMisconception(
          tx,
          promoteInput({ source: 'soft', conjectureId: 'cj_s' }),
        ),
      ),
    ]);

    const rows = await miscRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('hard');

    // Exactly ONE caused_by edge survives (the throat's idempotent upsert under the same lock).
    const edges = await db
      .select()
      .from(misconception_edge)
      .where(eq(misconception_edge.from_id, rows[0].id));
    expect(edges).toHaveLength(1);
  });
});
