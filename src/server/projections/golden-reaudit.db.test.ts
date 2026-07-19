// YUK-548 (worklist #5, Q4b) — DB tests for the retained-golden capture + reaudit (component 7).
// Proves the golden re-fold is CLEAN on a freshly captured golden, survives the JSON round-trip
// (date revival), and — the crux — is NON-TAUTOLOGICAL: a golden imperative row the current fold no
// longer reproduces is flagged DRIFT (the reference is independent of the fold).
//
// Hermetic: resetDb() in beforeEach.

import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { event, goal, knowledge } from '@/db/schema';
import {
  backfillGoalGenesis,
  backfillKnowledgeGenesis,
} from '../../../scripts/backfill-genesis-events';
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

async function insertNode(id: string): Promise<void> {
  await testDb().insert(knowledge).values({
    id,
    name: id,
    domain: null,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: null,
    created_at: T0,
    updated_at: T0,
    version: 0,
  });
}

// Seed a raw event row (K8 tests) — a standalone cross-entity proposal, no accept chain.
async function seedRawEvent(opts: {
  action: string;
  subject_kind: string;
  subject_id: string;
}): Promise<void> {
  await testDb().insert(event).values({
    id: newId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'test',
    action: opts.action,
    subject_kind: opts.subject_kind,
    subject_id: opts.subject_id,
    outcome: 'partial',
    payload: {},
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: T0,
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

// ── YUK-549 (K8): CROSS_REF_ACTIONS no longer over-captures bare propose/generate ─────────────
//
// Every reducer that consumes propose/generate guards on subject_kind ∈ {knowledge, knowledge_edge}
// (foldKnowledgeNode's `action==='propose' && subject_kind==='knowledge'`; foldKnowledgeEdge's
// generate equivalent). So those events are ALWAYS carried by the golden's unchanged `subject_kind`
// leg for those two kinds, and NO other kind's fold reads them — making the bare 'propose'/'generate'
// CROSS_REF entries dead weight (they only pulled unrelated entities' proposals into every golden).
describe('golden capture — YUK-549 (K8) CROSS_REF_ACTIONS trim', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a goal golden no longer over-captures bare propose/generate (they are knowledge/edge-subject, dropped from CROSS_REF)', async () => {
    const db = testDb();
    await insertGoal('g1', 'Alpha');
    await backfillGoalGenesis(db, T0);
    // stray cross-entity proposals the bare 'propose'/'generate' CROSS_REF entries USED to pull into
    // EVERY golden — now excluded (no fold outside knowledge/knowledge_edge reads them).
    await seedRawEvent({ action: 'propose', subject_kind: 'knowledge', subject_id: 'k_prop' });
    await seedRawEvent({ action: 'generate', subject_kind: 'knowledge_edge', subject_id: 'e_gen' });

    const golden = await captureGolden(db, 'goal');
    // the goal golden captures its own subject_kind='goal' events, NOT the stray propose/generate.
    expect(golden.events.some((e) => e.action === 'propose' || e.action === 'generate')).toBe(
      false,
    );
    // and the trim did not lose anything the goal fold needs — birth reaudit stays CLEAN.
    expect(reauditGolden(golden).drifted).toEqual([]);
  });

  it('a knowledge golden STILL captures propose via the subject_kind leg (no regression from the trim)', async () => {
    const db = testDb();
    await insertNode('k1');
    await backfillKnowledgeGenesis(db, T0);
    // a propose keyed on subject_kind='knowledge' — the fold consumes propose ONLY at that subject_kind,
    // so the UNCHANGED subject_kind leg (not the dropped CROSS_REF entry) is what must carry it.
    await seedRawEvent({ action: 'propose', subject_kind: 'knowledge', subject_id: 'k_prop' });

    const golden = await captureGolden(db, 'knowledge');
    expect(
      golden.events.some((e) => e.action === 'propose' && e.subject_kind === 'knowledge'),
    ).toBe(true);
    // the un-accepted stray propose is inert to the live node's fold (skipped before parse) → CLEAN.
    expect(reauditGolden(golden).drifted).toEqual([]);
  });
});
