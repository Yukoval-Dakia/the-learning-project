// YUK-548 (worklist #5, Q4b) — DB tests for the retained-golden capture + reaudit (component 7).
// Proves the golden re-fold is CLEAN on a freshly captured golden, survives the JSON round-trip
// (date revival), and — the crux — is NON-TAUTOLOGICAL: a golden imperative row the current fold no
// longer reproduces is flagged DRIFT (the reference is independent of the fold).
//
// Hermetic: resetDb() in beforeEach.

import { beforeEach, describe, expect, it } from 'vitest';

import { goal } from '@/db/schema';
import { backfillGoalGenesis } from '../../../scripts/backfill-genesis-events';
import { captureGolden } from '../../../scripts/capture-golden';
import { parseGolden, reauditGolden } from '../../../scripts/golden-reaudit';
import { resetDb, testDb } from '../../../tests/helpers/db';

const T0 = new Date('2026-06-01T00:00:00.000Z');

async function insertGoal(id: string, title: string): Promise<void> {
  await testDb()
    .insert(goal)
    .values({
      id,
      title,
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
}

describe('golden capture + reaudit (Q4b)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('CLEAN: re-folding a freshly captured golden reproduces every imperative row', async () => {
    const db = testDb();
    await insertGoal('g1', 'Alpha');
    await insertGoal('g2', 'Beta');
    await backfillGoalGenesis(db, T0); // now event-sourced → fold == imperative row (gate-equivalent)

    const golden = await captureGolden(db, 'goal');
    expect(golden.kind).toBe('goal');
    expect(golden.rowCount).toBe(2);

    const result = reauditGolden(golden);
    expect(result.checked).toBe(2);
    expect(result.drifted).toEqual([]);
  });

  it('survives the JSON round-trip (date revival): serialized → parsed golden re-audits CLEAN', async () => {
    const db = testDb();
    await insertGoal('g1', 'Alpha');
    await backfillGoalGenesis(db, T0);
    const golden = await captureGolden(db, 'goal');

    // exactly what capture-golden.ts writes to disk + golden-reaudit.ts reads back.
    const roundTripped = parseGolden(JSON.stringify(golden));

    // CR4 — the full-tree date reviver must NOT leak into top-level metadata: capturedAt is typed
    // string (GoldenSnapshot contract; capture-golden's main() calls .slice(0, 10) on it).
    expect(typeof roundTripped.capturedAt).toBe('string');
    expect(roundTripped.capturedAt).toBe(golden.capturedAt);
    expect(reauditGolden(roundTripped).drifted).toEqual([]);
  });

  it('NON-TAUTOLOGY: a golden imperative row the current fold no longer reproduces is flagged DRIFT', async () => {
    const db = testDb();
    await insertGoal('g1', 'Alpha');
    await backfillGoalGenesis(db, T0);
    const golden = await captureGolden(db, 'goal');
    // sanity: it starts CLEAN.
    expect(reauditGolden(golden).drifted).toEqual([]);

    // Simulate a post-flip reducer regression: the FROZEN imperative row now differs from what
    // fold(golden.events) produces (exactly what a changed reducer would cause). Because the golden
    // ROW is an INDEPENDENT reference (the imperative output, NOT a re-read of the fold), the reaudit
    // CATCHES the divergence — proving the check is non-tautological (a self-comparison could not).
    (golden.rows.g1 as Record<string, unknown>).title =
      'Tampered — a changed reducer would diverge here';

    const result = reauditGolden(golden);
    const drifted = result.drifted.find((d) => d.id === 'g1');
    expect(drifted).toBeDefined();
    expect(drifted?.diffs.join(';')).toContain('title');
  });
});
