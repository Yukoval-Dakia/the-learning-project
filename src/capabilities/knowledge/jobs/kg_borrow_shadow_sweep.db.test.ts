// YUK-559 (S3) — DB tests for the kg-borrowing SHADOW sweep. Proves:
//   - FLAG-INDEPENDENT: emits data even though both A5/A6 flags are dark (the design point).
//   - one summary event (experimental:kg_borrow_shadow), ingest_at non-null (memory opt-out).
//   - the shadow detects A5/A6 moves + would-borrow counts over live mastery_state + edges.
//   - over-cap related_to component → skipped + size recorded (componentCap override).
//   - empty DB → NO-OP (no event).
//   - never writes mastery_state / knowledge_edge (report-only).
//
// Hermetic: resetDb() in beforeEach.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { event, knowledge, knowledge_edge, mastery_state } from '@/db/schema';
import { upsertMasteryState } from '@/server/mastery/state';
import { resetDb } from '../../../../tests/helpers/db';
import {
  KG_BORROW_SHADOW_ACTION,
  KG_BORROW_SHADOW_SUBJECT_KIND,
  runKgBorrowShadowSweep,
} from './kg_borrow_shadow_sweep';

const NOW = new Date('2026-07-05T00:00:00.000Z');

async function seedKnowledge(id: string): Promise<void> {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain: 'wenyan',
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedObserved(kc: string, thetaHat: number, precision = 4): Promise<void> {
  await seedKnowledge(kc);
  await upsertMasteryState(db, {
    subject_id: kc,
    theta_hat: thetaHat,
    evidence_count: 3,
    success_count: 2,
    fail_count: 1,
    last_outcome_at: new Date(),
    theta_precision: precision,
  });
}

async function seedEdge(
  from: string,
  to: string,
  relation: string,
  archived = false,
): Promise<void> {
  await db.insert(knowledge_edge).values({
    id: newId(),
    from_knowledge_id: from,
    to_knowledge_id: to,
    relation_type: relation,
    weight: 1,
    created_by: { by: 'user' },
    reasoning: null,
    created_at: new Date(),
    archived_at: archived ? new Date() : null,
  });
}

async function shadowEvents() {
  return db.select().from(event).where(eq(event.action, KG_BORROW_SHADOW_ACTION));
}

describe('runKgBorrowShadowSweep (YUK-559 S3)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('empty DB → NO-OP (no summary event)', async () => {
    const report = await runKgBorrowShadowSweep(db, { now: NOW });
    expect(report.noop).toBe(true);
    expect(report.eventId).toBeNull();
    expect(await shadowEvents()).toHaveLength(0);
  });

  it('FLAG-DARK: still emits ONE summary event with ingest_at set (memory opt-out)', async () => {
    // Observed neighbour + unobserved related_to neighbour → A5 would borrow (flags dark).
    await seedObserved('kObs', 2.0, 5);
    await seedKnowledge('kUnobs'); // knowledge node, NO mastery_state row
    await seedEdge('kObs', 'kUnobs', 'related_to');

    const report = await runKgBorrowShadowSweep(db, { now: NOW });
    expect(report.noop).toBe(false);

    const rows = await shadowEvents();
    expect(rows).toHaveLength(1);
    const ev = rows[0];
    expect(ev.subject_kind).toBe(KG_BORROW_SHADOW_SUBJECT_KIND);
    expect(ev.actor_ref).toBe('kg_borrow_shadow_sweep');
    expect(ev.outcome).toBeNull();
    // Memory opt-out (F1): ingest_at stamped so the outbox poller skips it.
    expect(ev.ingest_at).toEqual(NOW);

    const p = ev.payload as Record<string, unknown>;
    expect(p.observed_count).toBe(1);
    // kObs moved (κ ridge + coupling) → observed_moved_count ≥ 1; kUnobs would borrow.
    expect(p.observed_moved_count).toBe(1);
    expect(p.would_borrow_count).toBe(1);
    expect(p.threshold_deferred).toBe(true);
    // const snapshot travels with the event for later re-read.
    const consts = p.consts as Record<string, unknown>;
    expect(consts.lambda).toBeCloseTo(0.5, 10);
    expect(consts.kappa).toBeCloseTo(0.01, 10);
    // delta_theta summary present (there is a move).
    expect(p.delta_theta).not.toBeNull();
    expect(p.borrowed_theta).not.toBeNull();
  });

  it('A6: a weak prereq presses the dependent down → counted as a move', async () => {
    await seedObserved('kPre', 0.0, 4);
    await seedObserved('kDep', 2.0, 4);
    await seedEdge('kPre', 'kDep', 'prerequisite');

    const report = await runKgBorrowShadowSweep(db, { now: NOW });
    // Both observed KCs move (dependent pressed down, prereq retro-credited up).
    expect(report.observed_moved_count).toBe(2);
    expect(report.would_borrow_count).toBe(0);
  });

  it('archived edges are ignored (no move, no borrow)', async () => {
    await seedObserved('kObs2', 2.0, 5);
    await seedKnowledge('kUn2');
    await seedEdge('kObs2', 'kUn2', 'related_to', /* archived */ true);

    const report = await runKgBorrowShadowSweep(db, { now: NOW });
    expect(report.observed_moved_count).toBe(0);
    expect(report.would_borrow_count).toBe(0);
  });

  it('over-cap related_to component → skipped (no smoothing) + size recorded', async () => {
    // 2-node related_to component, cap override = 1 → over cap → fail-safe skip.
    await seedObserved('cA', 2.0, 5);
    await seedKnowledge('cB'); // unobserved
    await seedEdge('cA', 'cB', 'related_to');

    const report = await runKgBorrowShadowSweep(db, { now: NOW, componentCap: 1 });
    expect(report.skipped_components).toBe(1);
    expect(report.skipped_component_sizes).toEqual([2]);
    // component was skipped → no smoothing → nothing moved / borrowed.
    expect(report.observed_moved_count).toBe(0);
    expect(report.would_borrow_count).toBe(0);
  });

  it('REPORT-ONLY: never writes mastery_state / knowledge_edge', async () => {
    await seedObserved('r1', 1.0, 5);
    await seedObserved('r2', -1.0, 5);
    await seedEdge('r1', 'r2', 'related_to');

    const beforeMs = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_kind, 'knowledge'));
    const beforeEdges = await db
      .select()
      .from(knowledge_edge)
      .where(and(eq(knowledge_edge.from_knowledge_id, 'r1')));

    await runKgBorrowShadowSweep(db, { now: NOW });

    const afterMs = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_kind, 'knowledge'));
    const afterEdges = await db
      .select()
      .from(knowledge_edge)
      .where(and(eq(knowledge_edge.from_knowledge_id, 'r1')));
    // row counts + the anchored θ̂ values are untouched (read-side recompute only).
    expect(afterMs.length).toBe(beforeMs.length);
    expect(afterEdges.length).toBe(beforeEdges.length);
    expect(afterMs.find((r) => r.subject_id === 'r1')?.theta_hat).toBe(1.0);
  });
});
