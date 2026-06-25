// YUK-471 Wave 0 (deferred capstone) — cascade-revert ORCHESTRATOR tests.
//
// The orchestrator (`orchestrateCascadeRevert`) is the consumer that makes the
// Wave-0 snapshot/cascade machinery actually usable:
//   collectCascadeFromCheckpoint (cascade.ts)  → the closure to revert
//   restoreStateSnapshot         (restore-snapshot.ts) → A-class state revert
//   writeEvent action='correct'  (corrections.ts trap) → event-layer compensation
//
// Contract under test (ADR-0044 §4 + 诚实天花板):
//   - clean per-utterance revert → A-class snapshot restored + B-class fold events
//     compensated with `correct` events; structured result returned.
//   - irreversible downstream (real attempt/review/FSRS register/user_verified) →
//     whole revert REFUSED, NOTHING mutated (atomicity).
//   - truncated cascade → honest-reject, NOTHING mutated.
//   - conflict guard: current state row != snapshot.after → 409-style refuse.
//
// Partition: db (seeds `event` + reads mastery_state / material_fsrs_state →
// imports tests/helpers/db). Matches allTestInclude's `src/**/*.test.ts` and is
// NOT in fastTestInclude → db config.

import { newId } from '@/core/ids';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { StateSnapshotExperimentalT } from '@/core/schema/event/state-snapshot';
import { event, mastery_state, material_fsrs_state } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { upsertFsrsState } from '../fsrs/state';
import { upsertMasteryState } from '../mastery/state';
import { orchestrateCascadeRevert } from './cascade-revert';

// Direct insert (test fixture; ADR-0005 single-owner applies to production code).
// We need free-form `caused_by` wiring that writeEvent's parse barrier would
// otherwise constrain. Mirrors cascade.db.test.ts's seedEvent helper.
async function seedEvent(opts: {
  id?: string;
  action?: string;
  subject_kind?: string;
  subject_id?: string;
  caused_by_event_id?: string | null;
  payload?: unknown;
  actor_kind?: string;
  actor_ref?: string;
  created_at?: Date;
}): Promise<string> {
  const db = testDb();
  const id = opts.id ?? newId();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: opts.actor_kind ?? 'system',
    actor_ref: opts.actor_ref ?? 'test',
    action: opts.action ?? 'attempt',
    subject_kind: opts.subject_kind ?? 'event',
    subject_id: opts.subject_id ?? id,
    outcome: null,
    payload: (opts.payload ?? {}) as Record<string, unknown>,
    caused_by_event_id: opts.caused_by_event_id ?? null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
  return id;
}

function makeCard(over: Partial<FsrsStateSchemaT> = {}): FsrsStateSchemaT {
  return {
    due: new Date('2030-01-01T00:00:00.000Z'),
    stability: 5,
    difficulty: 5,
    scheduled_days: 3,
    learning_steps: 0,
    reps: 2,
    lapses: 0,
    state: 'review',
    last_review: new Date('2029-12-29T00:00:00.000Z'),
    ...over,
  };
}

// Build a state_snapshot event payload. `theta` / `fsrs` describe the
// before/after pairs the orchestrator must conflict-check + restore.
function snapshotPayload(opts: {
  attemptEventId: string;
  theta?: { kc_id: string; before: number | null; after: number };
  fsrs?: {
    subject_kind: 'question' | 'knowledge';
    subject_id: string;
    before: FsrsStateSchemaT | null;
    after: FsrsStateSchemaT;
  };
}): StateSnapshotExperimentalT['payload'] {
  return {
    attempt_event_id: opts.attemptEventId,
    theta_snapshots: opts.theta ? [opts.theta] : [],
    fsrs_snapshots: opts.fsrs ? [opts.fsrs] : [],
  };
}

async function readTheta(kcId: string): Promise<number | null> {
  const db = testDb();
  const rows = await db
    .select()
    .from(mastery_state)
    .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, kcId)))
    .limit(1);
  return rows[0]?.theta_hat ?? null;
}

async function readFsrsExists(subjectKind: string, subjectId: string): Promise<boolean> {
  const db = testDb();
  const rows = await db
    .select()
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subjectKind),
        eq(material_fsrs_state.subject_id, subjectId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function countCorrectionsFor(targetEventId: string): Promise<number> {
  const db = testDb();
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'correct'),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, targetEventId),
      ),
    );
  return rows.length;
}

describe('orchestrateCascadeRevert', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── clean per-utterance revert ──────────────────────────────────────────────
  it('reverts a clean per-utterance cascade: A-class restored + B-class compensated', async () => {
    const db = testDb();
    const kcId = newId();

    // Materialize CURRENT state = the `after` value the snapshot will record.
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: 1.5, // after
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: new Date(),
    });

    // Checkpoint = a user_ask chip. Downstream: a structural generate (B-class)
    // and a state_snapshot (A-class) — both reversible.
    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const structural = await seedEvent({
      action: 'generate',
      subject_kind: 'knowledge',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
    });
    const snapEvent = await seedEvent({
      action: 'experimental:state_snapshot',
      subject_kind: 'event',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
      payload: snapshotPayload({
        attemptEventId: checkpoint,
        theta: { kc_id: kcId, before: 0, after: 1.5 },
      }),
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.reverted.snapshotsRestored).toBe(1);
    // Two structural-fold nodes: the `generate` + the checkpoint anchor itself
    // (the root is reverted last with event-layer compensation only).
    expect(result.reverted.foldsCompensated).toBe(2);
    expect(result.reverted.totalNodes).toBe(3);

    // A-class: θ̂ restored to before (0).
    expect(await readTheta(kcId)).toBe(0);

    // Every reverted node (structural + snapshot + root) gets a `correct` event.
    expect(await countCorrectionsFor(structural)).toBe(1);
    expect(await countCorrectionsFor(snapEvent)).toBe(1);
    expect(await countCorrectionsFor(checkpoint)).toBe(1);
  });

  it('restores a cold-start snapshot by DELETING the FSRS row (before=null)', async () => {
    const db = testDb();
    const subjectId = newId();

    const card = makeCard();
    // Current row = `after` (the attempt created it from cold-start).
    await upsertFsrsState(db, {
      subject_kind: 'knowledge',
      subject_id: subjectId,
      state: card,
      due_at: card.due,
      last_review_event_id: null,
    });
    expect(await readFsrsExists('knowledge', subjectId)).toBe(true);

    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    await seedEvent({
      action: 'experimental:state_snapshot',
      subject_kind: 'event',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
      payload: snapshotPayload({
        attemptEventId: checkpoint,
        fsrs: {
          subject_kind: 'knowledge',
          subject_id: subjectId,
          before: null, // cold-start
          after: card,
        },
      }),
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);
    expect(result.ok).toBe(true);
    // Cold-start revert removes the row entirely.
    expect(await readFsrsExists('knowledge', subjectId)).toBe(false);
  });

  // ── honest-reject: irreversible downstream ─────────────────────────────────
  it('refuses the WHOLE revert when a downstream real attempt is irreversible (atomic)', async () => {
    const db = testDb();
    const kcId = newId();
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: 2,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: new Date(),
    });

    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const snapEvent = await seedEvent({
      action: 'experimental:state_snapshot',
      subject_kind: 'event',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
      payload: snapshotPayload({
        attemptEventId: checkpoint,
        theta: { kc_id: kcId, before: 0, after: 2 },
      }),
    });
    // A real attempt downstream → irreversible. Whole cascade must refuse.
    const realAttempt = await seedEvent({ action: 'attempt', caused_by_event_id: checkpoint });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    if (result.refusal !== 'irreversible')
      throw new Error(`expected irreversible, got ${result.refusal}`);
    expect(result.irreversibleEventIds).toContain(realAttempt);

    // Atomicity: NOTHING mutated — θ̂ still at `after`, no compensation written.
    expect(await readTheta(kcId)).toBe(2);
    expect(await countCorrectionsFor(snapEvent)).toBe(0);
  });

  // ── honest-reject: truncation ──────────────────────────────────────────────
  it('refuses on a truncated cascade (node cap exceeded), mutating nothing', async () => {
    const db = testDb();
    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    for (let i = 0; i < 10; i++) {
      await seedEvent({ action: 'generate', caused_by_event_id: checkpoint });
    }

    const result = await orchestrateCascadeRevert(db, checkpoint, { nodeCap: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.refusal).toBe('truncated');
    // No compensation events written anywhere.
    const db2 = testDb();
    const corrections = await db2.select().from(event).where(eq(event.action, 'correct'));
    expect(corrections).toHaveLength(0);
  });

  // ── conflict guard ─────────────────────────────────────────────────────────
  it('refuses (conflict) when current state != snapshot.after, mutating nothing', async () => {
    const db = testDb();
    const kcId = newId();
    // Current θ̂ = 9 (someone outside the cascade moved it), but snapshot.after = 2.
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: 9,
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      last_outcome_at: new Date(),
    });

    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const snapEvent = await seedEvent({
      action: 'experimental:state_snapshot',
      subject_kind: 'event',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
      payload: snapshotPayload({
        attemptEventId: checkpoint,
        theta: { kc_id: kcId, before: 0, after: 2 },
      }),
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.refusal).toBe('conflict');

    // Atomicity: θ̂ untouched, no compensation.
    expect(await readTheta(kcId)).toBe(9);
    expect(await countCorrectionsFor(snapEvent)).toBe(0);
  });
});
