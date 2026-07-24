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

import { writeAttemptSnapshotBrackets } from '@/capabilities/practice/server/attempt-snapshot';
import { newId } from '@/core/ids';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type {
  StateSnapshotExperimentalT,
  ThetaRowSnapshotT,
} from '@/core/schema/event/state-snapshot';
import { event, knowledge, knowledge_edge, mastery_state, material_fsrs_state } from '@/db/schema';
import { gatherAndFoldKnowledgeEdge } from '@/server/projections/gather';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
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

// YUK-561 S1 — build a rich ThetaRowSnapshot `before` (verbatim shape). `theta_hat`
// is the only field the conflict guard/restore assertions here read; the rest are
// valid filler so the parse barrier + verbatim restore accept it.
function richBefore(theta_hat: number): ThetaRowSnapshotT {
  return {
    theta_hat,
    evidence_count: 1,
    success_count: 1,
    fail_count: 0,
    theta_precision: 1,
    last_theta_delta: null,
    last_outcome_at: new Date('2026-06-01T00:00:00Z'),
    rt_correct_ms: null,
    theta_grid_json: null,
  };
}

// Build a state_snapshot event payload. `theta` / `fsrs` describe the
// before/after pairs the orchestrator must conflict-check + restore.
function snapshotPayload(opts: {
  attemptEventId: string;
  theta?: { kc_id: string; before: ThetaRowSnapshotT | number | null; after: number };
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
        theta: { kc_id: kcId, before: richBefore(0), after: 1.5 },
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
    const liveArchivedAt = await readEdgeArchivedAt(edgeId);
    expect(liveArchivedAt).not.toBeNull();
    expect(liveArchivedAt).not.toBeUndefined();

    // HIGH (fold parity): re-folding the edge from its event log must ALSO produce
    // archived — proving the fold-visible generate(edge_op='archive') was written.
    // Without it, the still-present generate(create) re-folds to a LIVE row and a
    // projection rebuild would RESURRECT the edge. This assertion FAILS on an
    // imperative-only undo and PASSES once the archive event is written.
    const folded = await gatherAndFoldKnowledgeEdge(db, edgeId);
    expect(folded).not.toBeNull();
    expect(folded?.archived_at).not.toBeNull();
    // The folded archived_at == the imperative archived_at (same tx-wide `now`, no
    // ms drift) — the NIT "now not threaded into archiveKnowledgeEdge" guard.
    expect(folded?.archived_at?.getTime()).toBe((liveArchivedAt as Date).getTime());

    // Every reverted node gets a `correct` compensation event.
    expect(await countCorrectionsFor(reply)).toBe(1);
    expect(await countCorrectionsFor(snapEvent)).toBe(1);
    expect(await countCorrectionsFor(generateEventId)).toBe(1);
    expect(await countCorrectionsFor(checkpoint)).toBe(1);
  });

  // ── YUK-495 S4: full-precision warm θ̂ round-trips EXACTLY (no false conflict) ──
  it('reverts a full-precision (non-float4-exact) warm θ̂ with no false conflict', async () => {
    const db = testDb();
    const kcId = newId();
    // 0.1 + 0.2 = 0.30000000000000004 (a full-precision JS double, NOT float4-exact).
    // Since YUK-495 S4 widened theta_hat to `double precision`, the live column now stores
    // this EXACTLY (no truncation) and reads it back identical to the snapshot payload's
    // `after` — so the exact `thetaExactEq` guard sees no drift and the warm revert proceeds.
    const afterDouble = 0.1 + 0.2;
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: afterDouble, // stored full-precision in the double column
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
        theta: { kc_id: kcId, before: richBefore(0.5), after: afterDouble },
      }),
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    // The crux: NOT a false conflict — the warm revert succeeds and restores before.
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(`expected ok, got refusal: ${result.refusal} — ${result.reason}`);
    expect(result.reverted.snapshotsRestored).toBe(1);
    expect(await readTheta(kcId)).toBe(0.5);
  });

  // ── YUK-495 S4: the exact guard now CATCHES sub-float4 external drift ──────────
  it('refuses (conflict) when current θ̂ drifted by a sub-float4 amount vs snapshot.after', async () => {
    const db = testDb();
    const kcId = newId();
    // after and a drifted-current that map to the SAME float4 grid point (their gap is
    // below float4 resolution). The OLD float4Eq guard rounded both with Math.fround and
    // saw them as equal → MASKED the drift → silent false "no conflict". After the S4 widen
    // (double column) + the exact `thetaExactEq` guard, this genuine external drift IS a
    // conflict and the whole revert must refuse — decision-④'s bit-exact intent.
    const snapAfter = 0.3;
    const driftedCurrent = snapAfter + 1e-9; // ~3e-9 < float4 ULP near 0.3 (~3e-8): same float4, distinct f64
    expect(Math.fround(snapAfter)).toBe(Math.fround(driftedCurrent)); // old guard would have masked it
    expect(snapAfter === driftedCurrent).toBe(false); // exact guard sees the drift

    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: driftedCurrent,
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
        theta: { kc_id: kcId, before: 0.5, after: snapAfter },
      }),
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    // The strengthened guard catches it: refuse the WHOLE revert (no partial undo).
    expect(result.ok).toBe(false);
    // current θ̂ untouched by the refused revert.
    expect(await readTheta(kcId)).toBe(driftedCurrent);
  });

  // ── fail-closed: reverting an ARCHIVE generate has no clean fold-visible inverse
  it('refuses (irreversible) on reverting a generate(edge_op=archive); no silent un-archive', async () => {
    const db = testDb();
    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const { edgeId, generateEventId } = await seedLiveEdgeWithGenerate({
      checkpointEventId: checkpoint,
      archived: true, // the generate ARCHIVED this edge
    });
    const archivedBefore = await readEdgeArchivedAt(edgeId);
    expect(archivedBefore).not.toBeNull();

    const result = await orchestrateCascadeRevert(db, checkpoint);

    // Reverting an archive would have to RE-ACTIVATE the edge, but the edge fold has
    // no fold-visible event that restores a live row without rewriting its create
    // metadata → fail-closed rather than ship an undo a rebuild silently re-archives.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    if (result.refusal !== 'irreversible')
      throw new Error(`expected irreversible, got ${result.refusal}`);
    expect(result.irreversibleEventIds).toContain(generateEventId);

    // Atomicity: the edge is untouched (still archived at its original time), no
    // compensation written.
    expect(((await readEdgeArchivedAt(edgeId)) as Date)?.getTime()).toBe(
      (archivedBefore as Date).getTime(),
    );
    expect(await countCorrectionsFor(generateEventId)).toBe(0);
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

  it('refuses (irreversible) a closure whose rate=accept accepted a proposal (wave-7 TeZZO)', async () => {
    const db = testDb();
    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const proposeEvent = await seedEvent({
      action: 'propose',
      subject_kind: 'knowledge',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
    });
    // The accept vote landed a KG mutation outside this chain → the whole closure is fail-closed.
    const acceptRate = await seedEvent({
      action: 'rate',
      subject_kind: 'event',
      caused_by_event_id: proposeEvent,
      payload: { rating: 'accept' },
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    if (result.refusal !== 'irreversible')
      throw new Error(`expected irreversible, got ${result.refusal}`);
    expect(result.irreversibleEventIds).toContain(acceptRate);
    // Nothing mutated — no half-revert of the ask→propose→rate chain.
    expect(await countCorrectionsFor(acceptRate)).toBe(0);
  });

  it('reverts a closure whose rate=dismiss landed nothing (dismiss stays reversible) (wave-7 TeZZO)', async () => {
    const db = testDb();
    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    const proposeEvent = await seedEvent({
      action: 'propose',
      subject_kind: 'knowledge',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
    });
    await seedEvent({
      action: 'rate',
      subject_kind: 'event',
      caused_by_event_id: proposeEvent,
      payload: { rating: 'dismiss' },
    });

    const result = await orchestrateCascadeRevert(db, checkpoint);

    if (!result.ok) throw new Error(`expected ok, got refusal: ${result.refusal}`);
    expect(result.ok).toBe(true);
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

  // ── YUK-561 S3 (O2 dual-sibling) — GOLDEN topology via the real writer ─────────
  //
  // Seed the θ̂ bracket through the SAME `writeAttemptSnapshotBrackets` the attempt
  // writers use (spec §6.5: builder == writer). This proves the orchestrator reverts
  // the PRODUCTION shape (`${E}:checkpoint:theta` → `${E}:snapshot:theta`), not the
  // synthetic copilot_user_ask topology the older tests use.
  async function seedThetaBracket(
    attemptEventId: string,
    kcId: string,
    before: ThetaRowSnapshotT | null,
    after: number,
  ): Promise<void> {
    await testDb().transaction(async (tx) => {
      await writeAttemptSnapshotBrackets(tx, {
        attemptEventId,
        sessionId: null,
        now: new Date(),
        thetaSnapshots: [{ kc_id: kcId, before, after }],
        fsrsSnapshots: [],
      });
    });
  }

  it('reverts the GOLDEN dual-sibling θ̂ bracket (production writer shape)', async () => {
    const db = testDb();
    const attemptId = newId();
    const kcId = newId();
    // live row = after; the bracket snapshots before→after.
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: 1.1,
      evidence_count: 2,
      success_count: 2,
      fail_count: 0,
      last_outcome_at: new Date(),
    });
    await seedThetaBracket(attemptId, kcId, richBefore(0.2), 1.1);

    const result = await orchestrateCascadeRevert(db, `${attemptId}:checkpoint:theta`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.refusal}`);
    // θ̂ restored to before; both nodes (snapshot + checkpoint) compensated.
    expect(await readTheta(kcId)).toBe(0.2);
    expect(result.reverted.snapshotsRestored).toBe(1);
    expect(await countCorrectionsFor(`${attemptId}:snapshot:theta`)).toBe(1);
    expect(await countCorrectionsFor(`${attemptId}:checkpoint:theta`)).toBe(1);
  });

  it('non-existent checkpoint → no_checkpoint refusal (NOT irreversible)', async () => {
    const db = testDb();
    const result = await orchestrateCascadeRevert(db, `${newId()}:checkpoint:theta`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    // A missing bracket is the honest "nothing to revert, defer" signal — NOT a
    // caller bug (irreversible). The atomic caller maps it to a full_reprojection marker.
    expect(result.refusal).toBe('no_checkpoint');
  });

  it('revert(checkpoint:theta) twice → the SECOND is a conflict (LIFO guard, Lens A F4)', async () => {
    const db = testDb();
    const attemptId = newId();
    const kcId = newId();
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: 1.1,
      evidence_count: 2,
      success_count: 2,
      fail_count: 0,
      last_outcome_at: new Date(),
    });
    await seedThetaBracket(attemptId, kcId, richBefore(0.2), 1.1);

    const first = await orchestrateCascadeRevert(db, `${attemptId}:checkpoint:theta`);
    expect(first.ok).toBe(true);
    expect(await readTheta(kcId)).toBe(0.2); // restored to before

    // Second revert: the snapshot IS re-collected (cascade only drops `correct` nodes),
    // but the conflict guard trips — current θ̂ (0.2 = before) ≠ snapshot.after (1.1).
    // This is the real double-revert defense (NOT the tombstone) — the §1.2 订正.
    const second = await orchestrateCascadeRevert(db, `${attemptId}:checkpoint:theta`);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected conflict');
    expect(second.refusal).toBe('conflict');
    expect(await readTheta(kcId)).toBe(0.2); // untouched by the refused second revert
  });

  it('waits for a concurrent shared state writer and refuses instead of overwriting newer evidence', async () => {
    const db = testDb();
    const attemptId = newId();
    const kcId = newId();
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: 1.1,
      evidence_count: 2,
      success_count: 2,
      fail_count: 0,
      last_outcome_at: new Date(),
    });
    await seedThetaBracket(attemptId, kcId, richBefore(0.2), 1.1);

    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL not set');
    const writer = postgres(url, { max: 1 });
    try {
      let signalAcquired: (() => void) | undefined;
      const acquired = new Promise<void>((resolve) => {
        signalAcquired = resolve;
      });
      let releaseWriter: (() => void) | undefined;
      const release = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      const writeNewEvidence = writer.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:knowledge:${kcId}`}))`;
        await sql`UPDATE mastery_state SET theta_hat = 1.3, evidence_count = 3 WHERE subject_kind = 'knowledge' AND subject_id = ${kcId}`;
        signalAcquired?.();
        await release;
      });
      await acquired;

      const revertPromise = orchestrateCascadeRevert(db, `${attemptId}:checkpoint:theta`);
      releaseWriter?.();
      await writeNewEvidence;
      const result = await revertPromise;

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected conflict');
      expect(result.refusal).toBe('conflict');
      expect(await readTheta(kcId)).toBe(1.3);
      expect(await countCorrectionsFor(`${attemptId}:snapshot:theta`)).toBe(0);
    } finally {
      // Always release the dedicated writer connection, even if an assertion above throws.
      await writer.end();
    }
  });

  it('tx-aware: runs inside a caller tx + threads reasonContext into the retract reason_md', async () => {
    const db = testDb();
    const attemptId = newId();
    const kcId = newId();
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: 1.1,
      evidence_count: 2,
      success_count: 2,
      fail_count: 0,
      last_outcome_at: new Date(),
    });
    await seedThetaBracket(attemptId, kcId, richBefore(0.2), 1.1);

    // The atomic judge-overturn caller passes its OWN tx (revert commits with the
    // overturn). Inside the tx the orchestrator's step-6 opens a SAVEPOINT.
    let result: Awaited<ReturnType<typeof orchestrateCascadeRevert>> | undefined;
    await db.transaction(async (tx) => {
      result = await orchestrateCascadeRevert(tx, `${attemptId}:checkpoint:theta`, {
        reasonContext: { appeal_event_id: 'appeal_x', note: 'partial→correct' },
      });
    });
    expect(result?.ok).toBe(true);
    expect(await readTheta(kcId)).toBe(0.2);

    // The retract for the snapshot node carries the appeal provenance in reason_md.
    const retracts = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'correct'), eq(event.subject_id, `${attemptId}:snapshot:theta`)));
    expect(retracts).toHaveLength(1);
    const reasonMd = (retracts[0].payload as { reason_md: string }).reason_md;
    expect(reasonMd).toContain('appeal:appeal_x');
    expect(reasonMd).toContain('partial→correct');
  });

  it('in-tx re-check conflict rolls back the SAVEPOINT + returns typed refusal; outer tx survives + commits', async () => {
    // FIX-4 — the atomicity/defence-in-depth path (spec §4.4 / Q2a). step-5 pre-check
    // PASSES (both snapshots' `after` == the live θ̂), but INSIDE the tx, restoring the
    // FIRST snapshot moves θ̂ off `after`, so the SECOND snapshot's in-tx re-check sees the
    // mutation → throws CascadeRevertConflictError → the orchestrator's catch rolls back
    // ONLY the apply SAVEPOINT and RETURNS a typed `conflict` refusal (never propagates),
    // leaving the caller's OUTER tx alive to write a marker + commit. Two sibling snapshots
    // on the SAME kc under one checkpoint is synthetic-but-deterministic topology — the
    // first restore is the in-cascade mutator that the pre-check couldn't foresee (no mock).
    const db = testDb();
    const kcId = newId();
    // live θ̂ = 1.5 == BOTH snapshots' `after` → step-5 pre-check passes for both.
    await upsertMasteryState(db, {
      subject_id: kcId,
      theta_hat: 1.5,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: new Date(),
    });

    const checkpoint = await seedEvent({ action: 'experimental:copilot_user_ask' });
    // Distinct `before` (0.2 / 0.9), both ≠ after — whichever restore runs first moves θ̂
    // off 1.5, so the other snapshot's in-tx re-check conflicts (order-independent).
    const snapA = await seedEvent({
      action: 'experimental:state_snapshot',
      subject_kind: 'event',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
      payload: snapshotPayload({
        attemptEventId: checkpoint,
        theta: { kc_id: kcId, before: richBefore(0.2), after: 1.5 },
      }),
    });
    const snapB = await seedEvent({
      action: 'experimental:state_snapshot',
      subject_kind: 'event',
      subject_id: newId(),
      caused_by_event_id: checkpoint,
      payload: snapshotPayload({
        attemptEventId: checkpoint,
        theta: { kc_id: kcId, before: richBefore(0.9), after: 1.5 },
      }),
    });

    // The atomic caller runs the orchestrator inside its OWN tx, then writes a marker row
    // in the SAME tx after the typed refusal comes back — the whole outer tx must commit.
    const markerId = newId();
    let result: Awaited<ReturnType<typeof orchestrateCascadeRevert>> | undefined;
    await db.transaction(async (tx) => {
      result = await orchestrateCascadeRevert(tx, checkpoint);
      await tx.insert(event).values({
        id: markerId,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'test',
        action: 'experimental:reproject_deferred',
        subject_kind: 'event',
        subject_id: checkpoint,
        outcome: 'success',
        payload: { note: 'outer tx survived the in-tx conflict refusal' },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });
    });

    // Typed refusal RETURNED (not thrown) so the caller could dispatch.
    expect(result?.ok).toBe(false);
    if (result?.ok) throw new Error('expected conflict refusal');
    expect(result?.refusal).toBe('conflict');

    // Outer tx COMMITTED the marker — the SAVEPOINT rollback did not poison the outer tx.
    const markerRows = await db.select().from(event).where(eq(event.id, markerId));
    expect(markerRows).toHaveLength(1);

    // SAVEPOINT rollback: θ̂ untouched (still 1.5), NO compensation from either snapshot.
    expect(await readTheta(kcId)).toBe(1.5);
    expect(await countCorrectionsFor(snapA)).toBe(0);
    expect(await countCorrectionsFor(snapB)).toBe(0);
  });
});
