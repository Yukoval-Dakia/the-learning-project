// YUK-471 Wave 0 (deferred capstone) — cascade-revert ORCHESTRATOR tests.
//
// The orchestrator (`orchestrateCascadeRevert`) is the consumer that makes the
// Wave-0 snapshot/cascade machinery actually usable:
//   collectCascadeFromCheckpoint (cascade.ts)  → the closure to revert
//   restoreStateSnapshot         (restore-snapshot.ts) → A-class state revert
//   writeEvent action='correct'  (corrections.ts trap) → event-layer compensation
//
// Contract under test (ADR-0044 §4 + 诚实天花板):
//   - clean per-utterance revert (incl. a real copilot_reply child + a structural
//     edge generate) → A-class snapshot restored, the live knowledge_edge ROW
//     actually archived (not just a `correct` event), `correct` events written.
//   - irreversible downstream (real attempt/review/FSRS register/user_verified, or
//     a no-clean-inverse structural shape) → whole revert REFUSED, NOTHING mutated.
//   - truncated cascade → honest-reject, NOTHING mutated.
//   - conflict guard (θ̂ float4 grid + FSRS) : current != snapshot.after → refuse.
//   - HIGH-1 regression: a non-float4-exact warm θ̂ revert does NOT false-conflict.
//
// Partition: db (seeds `event` / knowledge / knowledge_edge + reads mastery_state
// / material_fsrs_state → imports tests/helpers/db). Matches allTestInclude's
// `src/**/*.test.ts` and is NOT in fastTestInclude → db config.

import { newId } from '@/core/ids';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { StateSnapshotExperimentalT } from '@/core/schema/event/state-snapshot';
import { event, knowledge, knowledge_edge, mastery_state, material_fsrs_state } from '@/db/schema';
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

async function readFsrsState(
  subjectKind: string,
  subjectId: string,
): Promise<FsrsStateSchemaT | null> {
  const db = testDb();
  const rows = await db
    .select({ state: material_fsrs_state.state })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subjectKind),
        eq(material_fsrs_state.subject_id, subjectId),
      ),
    )
    .limit(1);
  return rows[0]?.state ?? null;
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

// Seed a knowledge node (FK target for edges).
async function seedKnowledge(): Promise<string> {
  const db = testDb();
  const id = newId();
  const now = new Date();
  await db.insert(knowledge).values({ id, name: `kc_${id}`, created_at: now, updated_at: now });
  return id;
}

// Seed a LIVE knowledge_edge row + its `generate` provenance event (caused_by the
// checkpoint), mirroring the create path (proposals/actions.ts). subject_id of the
// generate IS the edge id. Returns the edge id + generate event id.
async function seedLiveEdgeWithGenerate(opts: {
  checkpointEventId: string;
  archived?: boolean;
}): Promise<{ edgeId: string; generateEventId: string }> {
  const db = testDb();
  const from = await seedKnowledge();
  const to = await seedKnowledge();
  const edgeId = newId();
  const now = new Date();
  await db.insert(knowledge_edge).values({
    id: edgeId,
    from_knowledge_id: from,
    to_knowledge_id: to,
    relation_type: 'related_to',
    weight: 1,
    created_by: { actor_kind: 'user', actor_ref: 'self' } as never,
    created_at: now,
    archived_at: opts.archived ? now : null,
  });
  const generateEventId = await seedEvent({
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: edgeId,
    caused_by_event_id: opts.checkpointEventId,
    payload: opts.archived ? { edge_op: 'archive' } : {},
  });
  return { edgeId, generateEventId };
}

async function readEdgeArchivedAt(edgeId: string): Promise<Date | null | undefined> {
  const db = testDb();
  const rows = await db
    .select({ archived_at: knowledge_edge.archived_at })
    .from(knowledge_edge)
    .where(eq(knowledge_edge.id, edgeId))
    .limit(1);
  return rows.length > 0 ? rows[0].archived_at : undefined;
}

describe('orchestrateCascadeRevert', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── clean per-utterance revert (the flagship use case) ──────────────────────
  it('reverts a clean per-utterance cascade: θ̂ restored, edge ROW archived, reply compensated', async () => {
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

    // Checkpoint = a real copilot user_ask. Downstream:
    //   - a copilot_reply (MED-1: depth-1 child of EVERY real turn) — event-layer,
    //   - a state_snapshot (A-class),
    //   - a live knowledge_edge + its generate (B-class structural_imperative).
    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const reply = await seedEvent({
      action: 'experimental:copilot_reply',
      subject_kind: 'event',
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
    const { edgeId, generateEventId } = await seedLiveEdgeWithGenerate({
      checkpointEventId: checkpoint,
    });
    // Sanity: the edge is LIVE before the revert.
    expect(await readEdgeArchivedAt(edgeId)).toBeNull();

    const result = await orchestrateCascadeRevert(db, checkpoint);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.reverted.snapshotsRestored).toBe(1);
    // B-class with a live SoT row: the edge generate.
    expect(result.reverted.structuralRowsArchived).toBe(1);
    // event-layer: copilot_reply + the checkpoint anchor (root, reverted last).
    expect(result.reverted.eventLayerCompensated).toBe(2);
    expect(result.reverted.totalNodes).toBe(4);

    // A-class: θ̂ restored to before (0).
    expect(await readTheta(kcId)).toBe(0);

    // HIGH-2: the live knowledge_edge ROW is actually ARCHIVED (not just a
    // `correct` event) — without the imperative undo this row stays active.
    expect(await readEdgeArchivedAt(edgeId)).not.toBeNull();

    // Every reverted node gets a `correct` compensation event.
    expect(await countCorrectionsFor(reply)).toBe(1);
    expect(await countCorrectionsFor(snapEvent)).toBe(1);
    expect(await countCorrectionsFor(generateEventId)).toBe(1);
    expect(await countCorrectionsFor(checkpoint)).toBe(1);
  });

  // ── HIGH-1: non-float4-exact warm θ̂ must NOT false-conflict ─────────────────
  it('reverts a warm θ̂ whose after is NOT float4-exact (no false conflict)', async () => {
    const db = testDb();
    const kcId = newId();
    // 0.1 + 0.2 = 0.30000000000000004 (a full-precision JS double). When written to
    // a float4 column it is truncated to Math.fround(...) and read back truncated.
    // The snapshot payload stores the UN-truncated double — a bare === would
    // false-conflict. The conflict guard must compare on the float4 grid.
    const afterDouble = 0.1 + 0.2;
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: afterDouble, // stored as Math.fround(afterDouble)
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: new Date(),
    });

    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    await seedEvent({
      action: 'experimental:state_snapshot',
      subject_kind: 'event',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
      payload: snapshotPayload({
        attemptEventId: checkpoint,
        theta: { kc_id: kcId, before: 0.5, after: afterDouble },
      }),
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    // The crux: NOT a false conflict — the warm revert succeeds and restores before.
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(`expected ok, got refusal: ${result.refusal} — ${result.reason}`);
    expect(result.reverted.snapshotsRestored).toBe(1);
    expect(await readTheta(kcId)).toBe(Math.fround(0.5));
  });

  // ── revert an ARCHIVE generate → un-archive the edge ────────────────────────
  it('reverts an archive-generate by RE-ACTIVATING the edge (un-archive)', async () => {
    const db = testDb();
    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const { edgeId } = await seedLiveEdgeWithGenerate({
      checkpointEventId: checkpoint,
      archived: true, // the generate ARCHIVED this edge
    });
    expect(await readEdgeArchivedAt(edgeId)).not.toBeNull();

    const result = await orchestrateCascadeRevert(db, checkpoint);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.reverted.structuralRowsArchived).toBe(1);
    // Reverting the archive re-activates the edge.
    expect(await readEdgeArchivedAt(edgeId)).toBeNull();
  });

  // ── fail-closed: a structural shape with no clean inverse (extract) ──────────
  it('refuses (irreversible) on a structural extract with no clean inverse, mutating nothing', async () => {
    const db = testDb();
    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const extractEvent = await seedEvent({
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    if (result.refusal !== 'irreversible')
      throw new Error(`expected irreversible, got ${result.refusal}`);
    expect(result.irreversibleEventIds).toContain(extractEvent);
    // Nothing mutated (fail-loud, not a silent ok:true no-op).
    expect(await countCorrectionsFor(extractEvent)).toBe(0);
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

  // ── MED-3(a): warm FSRS restore (before != null) ────────────────────────────
  it('restores a warm FSRS Card to its before-state (before != null)', async () => {
    const db = testDb();
    const subjectId = newId();
    const beforeCard = makeCard({
      stability: 2,
      reps: 1,
      due: new Date('2029-06-01T00:00:00.000Z'),
    });
    const afterCard = makeCard({
      stability: 8,
      reps: 3,
      due: new Date('2030-03-01T00:00:00.000Z'),
    });

    // Current row = after (the attempt advanced the card).
    await upsertFsrsState(db, {
      subject_kind: 'knowledge',
      subject_id: subjectId,
      state: afterCard,
      due_at: afterCard.due,
      last_review_event_id: null,
    });

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
          before: beforeCard,
          after: afterCard,
        },
      }),
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);
    expect(result.ok).toBe(true);
    // Card restored to before (stability 2, reps 1), not left at after (8, 3).
    const restored = await readFsrsState('knowledge', subjectId);
    expect(restored).not.toBeNull();
    expect(restored?.stability).toBe(2);
    expect(restored?.reps).toBe(1);
  });

  // ── MED-3(b): FSRS conflict guard negative path ─────────────────────────────
  it('refuses (conflict) when current FSRS state != snapshot.after, mutating nothing', async () => {
    const db = testDb();
    const subjectId = newId();
    const afterCard = makeCard({ stability: 8 });
    const driftedCard = makeCard({ stability: 99 }); // someone outside moved it
    const beforeCard = makeCard({ stability: 2 });

    await upsertFsrsState(db, {
      subject_kind: 'knowledge',
      subject_id: subjectId,
      state: driftedCard,
      due_at: driftedCard.due,
      last_review_event_id: null,
    });

    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const snapEvent = await seedEvent({
      action: 'experimental:state_snapshot',
      subject_kind: 'event',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
      payload: snapshotPayload({
        attemptEventId: checkpoint,
        fsrs: {
          subject_kind: 'knowledge',
          subject_id: subjectId,
          before: beforeCard,
          after: afterCard,
        },
      }),
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    if (result.refusal !== 'conflict') throw new Error(`expected conflict, got ${result.refusal}`);
    expect(result.conflictRef.kind).toBe('fsrs');

    // Atomicity: the drifted card is untouched, no compensation written.
    expect((await readFsrsState('knowledge', subjectId))?.stability).toBe(99);
    expect(await countCorrectionsFor(snapEvent)).toBe(0);
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
