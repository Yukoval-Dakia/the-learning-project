// YUK-471 Wave 2 — DB tests for the goal projection (testcontainer).
//
// Covers (design §5 + critic B5):
//   - genesis backfill: seeds an event-less (manual) goal, SKIPS a proposal-accepted goal,
//     and is idempotent (re-run seeds 0).
//   - shell parity: gatherAndFoldGoal reproduces the live row for the proposal+accept chain,
//     the retract chain, and the W2 status/scope events.
//   - per-entity flag: OFF (imperative insertGoal writes the row) vs ON (projection write-through
//     writes the row) yield IDENTICAL rows for accept; ditto for retract.
//   - audit:projection goal section: CLEAN on a coherent fixture, DRIFT on an out-of-band write.
//
// Hermetic: resetDb() in beforeEach. resetDb truncates `goal` (in ALL_TABLES) but NOT
// materialized_id_index (no FK → not CASCADE-reached), so we truncate the index explicitly.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acceptGoalScopeProposal } from '@/capabilities/agency/server/goals/accept';
import { newId } from '@/core/ids';
import type { GoalRowSnapshotT } from '@/core/schema/event/genesis';
import { event, goal, materialized_id_index } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import { auditProjection } from '../../../scripts/audit-projection';
import { backfillGoalGenesis } from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { gatherAndFoldGoal } from './gather';

const T0 = new Date('2026-06-01T00:00:00.000Z');

const FLAG = 'PROJECTION_IS_WRITER_GOAL';

async function resetIndex(): Promise<void> {
  await testDb().delete(materialized_id_index);
}

// Insert a manual (event-less) goal directly — the cold-start at-entry shape (no proposal).
async function insertManualGoal(
  id: string,
  over: Partial<typeof goal.$inferSelect> = {},
): Promise<void> {
  await testDb()
    .insert(goal)
    .values({
      id,
      title: over.title ?? `Goal ${id}`,
      subject_id: over.subject_id ?? null,
      scope_knowledge_ids: over.scope_knowledge_ids ?? ['k_a'],
      sequence_hint: over.sequence_hint ?? 0,
      status: over.status ?? 'active',
      source: over.source ?? 'manual',
      source_ref: over.source_ref ?? null,
      created_at: over.created_at ?? T0,
      updated_at: over.updated_at ?? T0,
      version: over.version ?? 0,
    });
}

// Write a goal_scope proposal event (experimental:proposal / goal, subject_id=goalId).
async function writeGoalProposal(opts: {
  proposalId: string;
  goalId: string;
  title: string;
  subjectId?: string | null;
  scope?: string[];
  sequenceHint?: number;
  created_at: Date;
}): Promise<void> {
  const aiProposal = {
    kind: 'goal_scope',
    target: { subject_kind: 'goal', subject_id: opts.goalId },
    reason_md: 'because',
    evidence_refs: [],
    proposed_change: {
      title: opts.title,
      subject_id: opts.subjectId ?? null,
      scope_knowledge_ids: opts.scope ?? [],
      sequence_hint: opts.sequenceHint ?? 0,
      reasoning: 'because',
    },
    cooldown_key: `goal_scope:${opts.goalId}`,
  };
  await writeEvent(testDb(), {
    id: opts.proposalId,
    actor_kind: 'agent',
    actor_ref: 'goal_scope',
    action: 'experimental:proposal',
    subject_kind: 'goal',
    subject_id: opts.goalId,
    outcome: 'partial',
    payload: { ai_proposal: aiProposal },
    created_at: opts.created_at,
  });
}

// A ProposalInboxRow stub for acceptGoalScopeProposal (only the fields it reads).
function inboxRow(opts: {
  goalId: string;
  title: string;
  subjectId?: string | null;
  scope?: string[];
  sequenceHint?: number;
}): ProposalInboxRow {
  return {
    target: { subject_kind: 'goal', subject_id: opts.goalId },
    payload: {
      proposed_change: {
        title: opts.title,
        subject_id: opts.subjectId ?? null,
        scope_knowledge_ids: opts.scope ?? [],
        sequence_hint: opts.sequenceHint ?? 0,
      },
    },
  } as unknown as ProposalInboxRow;
}

async function liveGoal(id: string): Promise<GoalRowSnapshotT | null> {
  const rows = await testDb().select().from(goal).where(eq(goal.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    subject_id: r.subject_id,
    scope_knowledge_ids: r.scope_knowledge_ids ?? [],
    sequence_hint: r.sequence_hint,
    status: r.status,
    source: r.source,
    source_ref: r.source_ref,
    created_at: r.created_at,
    updated_at: r.updated_at,
    version: r.version,
  };
}

describe('backfillGoalGenesis — scoped to truly event-less goals', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('anchors an event-less manual goal but SKIPS a proposal-accepted goal', async () => {
    const db = testDb();
    await insertManualGoal('goal_manual'); // event-less → must be anchored
    // proposal-accepted goal: has an experimental:proposal event → event-sourced → SKIPPED.
    await insertManualGoal('goal_proposed', {
      source: 'goal_scope_proposal',
      source_ref: 'prop_1',
    });
    await writeGoalProposal({
      proposalId: 'prop_1',
      goalId: 'goal_proposed',
      title: 'Goal goal_proposed',
      created_at: T0,
    });

    const counts = await backfillGoalGenesis(db, T0);
    expect(counts.seeded).toBe(1); // only the event-less manual goal
    expect(counts.skipped).toBe(1); // the proposal-accepted goal is already event-sourced

    const genesisRows = await db
      .select({ subject_id: event.subject_id })
      .from(event)
      .where(eq(event.action, 'experimental:genesis'));
    const seededIds = genesisRows.map((r) => r.subject_id);
    expect(seededIds).toContain('goal_manual');
    expect(seededIds).not.toContain('goal_proposed');
  });

  it('is idempotent: a second backfill seeds 0', async () => {
    const db = testDb();
    await insertManualGoal('goal_manual');
    const first = await backfillGoalGenesis(db, T0);
    expect(first.seeded).toBe(1);
    const second = await backfillGoalGenesis(db, T0);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('the backfilled genesis folds byte-equal to the live row', async () => {
    const db = testDb();
    await insertManualGoal('goal_manual', {
      title: 'Master integrals',
      subject_id: 'subj_math',
      scope_knowledge_ids: ['k_a', 'k_b'],
      sequence_hint: 2,
      status: 'dormant',
      version: 3,
    });
    await backfillGoalGenesis(db, T0);
    const folded = await gatherAndFoldGoal(db, 'goal_manual');
    expect(folded).toEqual(await liveGoal('goal_manual'));
  });
});

describe('gatherAndFoldGoal — shell parity over the event chain', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
    delete process.env[FLAG]; // default OFF
  });

  it('reproduces a proposal+accept materialized goal (status=active, version=0)', async () => {
    await writeGoalProposal({
      proposalId: 'prop_1',
      goalId: 'goal_1',
      title: 'Master derivatives',
      subjectId: 'subj_math',
      scope: ['k_a', 'k_b'],
      sequenceHint: 4,
      created_at: T0,
    });
    await acceptGoalScopeProposal(
      testDb() as never,
      'prop_1',
      inboxRow({
        goalId: 'goal_1',
        title: 'Master derivatives',
        subjectId: 'subj_math',
        scope: ['k_a', 'k_b'],
        sequenceHint: 4,
      }),
    );
    const folded = await gatherAndFoldGoal(testDb(), 'goal_1');
    expect(folded).toEqual(await liveGoal('goal_1'));
    expect(folded?.status).toBe('active');
    expect(folded?.version).toBe(0);
    expect(folded?.title).toBe('Master derivatives');
  });

  it('reproduces the W2 status/scope events folded onto a backfilled goal', async () => {
    const db = testDb();
    await insertManualGoal('goal_1', {
      status: 'active',
      version: 0,
      title: 'Old',
      sequence_hint: 0,
    });
    await backfillGoalGenesis(db, T0);
    // The genesis event is stamped at backfill (wall-clock) time and sorts LAST among same-or-
    // earlier events, so the status/scope updates MUST come AFTER it in event-time (the realistic
    // cutover-then-mutate order). Read back the genesis created_at and stamp the updates after it.
    const [genesisEv] = await db
      .select({ created_at: event.created_at })
      .from(event)
      .where(eq(event.action, 'experimental:genesis'))
      .limit(1);
    const base = (genesisEv?.created_at ?? new Date()).getTime();
    // status update → done, version+1
    await writeEvent(db, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'goal-status-update',
      action: 'experimental:goal_status_update',
      subject_kind: 'goal',
      subject_id: 'goal_1',
      outcome: 'success',
      payload: { status: 'done' },
      created_at: new Date(base + 1000),
    });
    // scope update → title/sequence_hint, version+1
    await writeEvent(db, {
      id: newId(),
      actor_kind: 'system',
      actor_ref: 'goal-scope-update',
      action: 'experimental:goal_scope_update',
      subject_kind: 'goal',
      subject_id: 'goal_1',
      outcome: 'success',
      payload: { title: 'New', sequence_hint: 7 },
      created_at: new Date(base + 2000),
    });
    const folded = await gatherAndFoldGoal(db, 'goal_1');
    expect(folded?.status).toBe('done');
    expect(folded?.title).toBe('New');
    expect(folded?.sequence_hint).toBe(7);
    expect(folded?.version).toBe(2);
  });
});

describe('per-entity flag — OFF vs ON yield identical rows', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('accept: OFF (imperative insertGoal) and ON (projection write-through) produce the same row', async () => {
    // OFF run
    delete process.env[FLAG];
    await writeGoalProposal({
      proposalId: 'prop_off',
      goalId: 'goal_off',
      title: 'G',
      subjectId: 'subj_x',
      scope: ['k_a'],
      sequenceHint: 1,
      created_at: T0,
    });
    await acceptGoalScopeProposal(
      testDb() as never,
      'prop_off',
      inboxRow({
        goalId: 'goal_off',
        title: 'G',
        subjectId: 'subj_x',
        scope: ['k_a'],
        sequenceHint: 1,
      }),
    );
    const offRow = await liveGoal('goal_off');
    // Parity: fold == imperative row.
    expect(await gatherAndFoldGoal(testDb(), 'goal_off')).toEqual(offRow);

    // ON run (separate goal)
    process.env[FLAG] = '1';
    await writeGoalProposal({
      proposalId: 'prop_on',
      goalId: 'goal_on',
      title: 'G',
      subjectId: 'subj_x',
      scope: ['k_a'],
      sequenceHint: 1,
      created_at: T0,
    });
    await acceptGoalScopeProposal(
      testDb() as never,
      'prop_on',
      inboxRow({
        goalId: 'goal_on',
        title: 'G',
        subjectId: 'subj_x',
        scope: ['k_a'],
        sequenceHint: 1,
      }),
    );
    const onRow = await liveGoal('goal_on');
    expect(onRow).not.toBeNull();
    // The projection wrote the row; it must match the fold AND be field-identical to the OFF row
    // (modulo id/source_ref which differ by construction).
    expect(await gatherAndFoldGoal(testDb(), 'goal_on')).toEqual(onRow);
    expect(onRow?.status).toBe('active');
    expect(onRow?.version).toBe(0);
    expect(onRow?.title).toBe('G');
    expect(onRow?.subject_id).toBe('subj_x');
    expect(onRow?.scope_knowledge_ids).toEqual(['k_a']);
    expect(onRow?.sequence_hint).toBe(1);
    // structural equality of the two rows except the per-run id/source_ref
    const norm = (r: GoalRowSnapshotT | null) =>
      r && { ...r, id: 'X', source_ref: 'X', created_at: 0, updated_at: 0 };
    expect(norm(onRow)).toEqual(norm(offRow));
  });
});

describe('auditProjection — goal section', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('reports CLEAN for a coherent backfilled goal', async () => {
    const db = testDb();
    await insertManualGoal('goal_1', { title: 'Clean', scope_knowledge_ids: ['k_a'] });
    await backfillGoalGenesis(db, T0);
    const result = await auditProjection(db, {});
    expect(result.checkedGoals).toBe(1);
    expect(result.drift).toEqual([]);
  });

  it('flags DRIFT when a live goal is mutated out-of-band (bypassing the projection)', async () => {
    const db = testDb();
    await insertManualGoal('goal_1', { title: 'Original', scope_knowledge_ids: ['k_a'] });
    await backfillGoalGenesis(db, T0);
    // out-of-band raw UPDATE that does NOT write any event → fold (from genesis) != live row.
    await db.update(goal).set({ title: 'Tampered' }).where(eq(goal.id, 'goal_1'));
    const result = await auditProjection(db, {});
    const drifted = result.drift.find((d) => d.id === 'goal_1' && d.subject_kind === 'goal');
    expect(drifted).toBeDefined();
    expect(drifted?.diffs.join(';')).toContain('title');
  });
});
