// YUK-471 W1 B3 — DB tests for the prod-clone SoT-flip gate orchestrator (testcontainer).
//
// runB3Gate runs the documented B3 procedure against a (clone) DB: snapshot live ids → scoped
// genesis backfill → pre-rebuild audit → full rebuild → rowset parity → a go/no-go report. These
// tests prove the GO path plus every NO-GO leg:
//   (GO)            a coherent pre-event-sourcing world backfills + audits CLEAN + rebuilds to the
//                   same row set (seed root survives) → go=true.
//   (NO-GO topology) an imperatively-created CYCLIC prerequisite pair (the accept path never gated)
//                   → the pre-rebuild fold THROWS + the rebuild re-confirms → go=false.
//   (NO-GO drift)   an accept-path row whose imperative value diverges from its fold → the
//                   pre-rebuild audit reports DRIFT (the real value teeth the scoped backfill unlocks).
//   (NO-GO deletion) a row that folds to null → the rebuild DELETEs it → rowset parity flags it.
//   (NO-GO resurrection) an event-only row with no live counterpart → the rebuild MATERIALIZEs it →
//                   the rowset creation check flags it (the live-only audit never sees this class).
//
// FK: knowledge_edge.from/to reference knowledge.id, so endpoint nodes exist first.
// Hermetic: resetDb() in beforeEach.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, knowledge, knowledge_edge } from '@/db/schema';
import { runB3Gate } from '../../../scripts/b3-gate';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { projectKnowledgeEdge } from './knowledge_edge';

const T0 = new Date('2026-06-01T00:00:00.000Z'); // pre-existing rows + generate-create events
const TGEN = new Date('2026-06-02T00:00:00.000Z'); // backfill genesis time (AFTER T0)

async function insertKnowledge(opts: {
  id: string;
  name?: string;
  domain?: string | null;
  parent_id?: string | null;
}): Promise<void> {
  const db = testDb();
  await db.insert(knowledge).values({
    id: opts.id,
    name: opts.name ?? opts.id,
    domain: opts.domain ?? null,
    parent_id: opts.parent_id ?? null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: null,
    created_at: T0,
    updated_at: T0,
    version: 0,
  });
}

async function insertEdge(opts: {
  id: string;
  from: string;
  to: string;
  relation_type?: string;
  archived_at?: Date | null;
}): Promise<void> {
  const db = testDb();
  await db.insert(knowledge_edge).values({
    id: opts.id,
    from_knowledge_id: opts.from,
    to_knowledge_id: opts.to,
    relation_type: opts.relation_type ?? 'related_to',
    weight: 1,
    created_by: { by: 'user' },
    reasoning: null,
    created_at: T0,
    archived_at: opts.archived_at ?? null,
  });
}

// Seed a generate-create event for a prerequisite edge (no genesis) at T0 — earlier than the
// backfill genesis (TGEN), so the fold processes the create (and runs ADR-0034 topology) first.
async function seedGenerateCreatePrereq(opts: {
  edgeId: string;
  from: string;
  to: string;
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: `ev_gen_${opts.edgeId}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: opts.edgeId,
    outcome: 'partial',
    payload: {
      edge_op: 'create',
      from_knowledge_id: opts.from,
      to_knowledge_id: opts.to,
      relation_type: 'prerequisite',
      weight: 1,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: T0,
  });
}

// A generate-create related_to edge with a given weight (no topology gate runs for related_to).
async function seedGenerateCreateRelated(opts: {
  edgeId: string;
  from: string;
  to: string;
  weight: number;
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: `ev_gen_${opts.edgeId}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: opts.edgeId,
    outcome: 'partial',
    payload: {
      edge_op: 'create',
      from_knowledge_id: opts.from,
      to_knowledge_id: opts.to,
      relation_type: 'related_to',
      weight: opts.weight,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: T0,
  });
}

// A generate-ARCHIVE event with NO preceding create — a malformed history that folds to null
// (the archive branch has no prior row + no structural fields). It IS event-sourced (has a
// generate event), so the scoped backfill skips it → the fold drops it → the rebuild DELETEs it.
async function seedGenerateArchiveOnly(edgeId: string): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: `ev_arch_${edgeId}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: edgeId,
    outcome: 'partial',
    payload: { edge_op: 'archive', archive_edge_id: edgeId },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: T0,
  });
}

describe('runB3Gate', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('GO: a coherent pre-event-sourcing world backfills, rebuilds, audits CLEAN with zero deletions (seed root survives)', async () => {
    const db = testDb();
    // An unanchored seed root + children + a live related_to edge + a live prerequisite edge + an
    // archived edge — none have events (pre-event-sourcing), exactly what the backfill anchors.
    await insertKnowledge({ id: 'seed:wenyan:root', name: 'wenyan', domain: 'wenyan' });
    await insertKnowledge({ id: 'kn_a', name: 'A', parent_id: 'seed:wenyan:root' });
    await insertKnowledge({ id: 'kn_b', name: 'B', parent_id: 'kn_a' });
    await insertKnowledge({ id: 'kn_c', name: 'C', parent_id: 'kn_a' });
    await insertEdge({ id: 'ke_ab', from: 'kn_a', to: 'kn_b' });
    await insertEdge({ id: 'ke_ac_pre', from: 'kn_a', to: 'kn_c', relation_type: 'prerequisite' });
    await insertEdge({ id: 'ke_bc_arch', from: 'kn_b', to: 'kn_c', archived_at: T0 });

    const report = await runB3Gate(db, {}, TGEN);

    expect(report.go).toBe(true);
    expect(report.rebuild.ok).toBe(true);
    expect(report.rebuild.topologyReject).toBeNull();
    expect(report.audit.clean).toBe(true);
    expect(report.audit.driftCount).toBe(0);
    expect(report.audit.topologyReject).toBeNull();
    expect(report.survival.ok).toBe(true);
    expect(report.survival.deletedKnowledge).toEqual([]);
    expect(report.survival.deletedEdges).toEqual([]);
    // The rebuild actually re-folded the world (not a silent no-op that would make survival pass trivially).
    expect(report.rebuild.counts?.nodes).toBeGreaterThan(0);
    expect(report.rebuild.counts?.edges).toBeGreaterThan(0);
    // Backfill anchored the pre-event-sourcing rows (4 nodes + 3 edges).
    expect(report.backfill.knowledge.seeded).toBe(4);
    expect(report.backfill.knowledge_edge.seeded).toBe(3);
    // The unanchored seed root SURVIVES the rebuild (the keystone non-delete guard + its anchor).
    const root = await db.select().from(knowledge).where(eq(knowledge.id, 'seed:wenyan:root'));
    expect(root).toHaveLength(1);
  });

  it('NO-GO: an imperatively-created CYCLIC prerequisite pair is caught — rebuild topology-rejects', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_x', name: 'X' });
    await insertKnowledge({ id: 'kn_y', name: 'Y' });
    // Two LIVE prerequisite edges forming a direct cycle x→y and y→x, each created via a
    // generate-create event. The imperative edge path does NOT run the ADR-0034 topology gate, so
    // such a cyclic pair CAN exist in prod — the fold (rebuild) is where it surfaces.
    await insertEdge({ id: 'ke_xy', from: 'kn_x', to: 'kn_y', relation_type: 'prerequisite' });
    await insertEdge({ id: 'ke_yx', from: 'kn_y', to: 'kn_x', relation_type: 'prerequisite' });
    await seedGenerateCreatePrereq({ edgeId: 'ke_xy', from: 'kn_x', to: 'kn_y' });
    await seedGenerateCreatePrereq({ edgeId: 'ke_yx', from: 'kn_y', to: 'kn_x' });

    const report = await runB3Gate(db, {}, TGEN);

    expect(report.go).toBe(false);
    // The PRE-rebuild audit folds the cyclic edge and throws first → caught as a topology NO-GO.
    expect(report.audit.topologyReject).toMatch(/topology reject/i);
    expect(report.audit.clean).toBe(false);
    // The rebuild independently re-confirms it.
    expect(report.rebuild.ok).toBe(false);
    expect(report.rebuild.topologyReject).toMatch(/topology reject/i);
  });

  it('NO-GO (real value teeth): an accept-path row whose imperative value DIVERGES from its fold is caught as audit DRIFT', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_a', name: 'A' });
    await insertKnowledge({ id: 'kn_b', name: 'B' });
    // An event-sourced edge: a generate-create event (weight 1) + the row materialized by the shell
    // so it starts EQUAL to its fold. The scoped backfill will NOT anchor it (it has a generate
    // event), so the audit re-folds it from the event — the teeth the scoped backfill unlocks.
    await seedGenerateCreateRelated({ edgeId: 'ke_rel', from: 'kn_a', to: 'kn_b', weight: 1 });
    await projectKnowledgeEdge(db, 'ke_rel');
    // Corrupt the LIVE row out-of-band so it diverges from fold(events) — stands in for a
    // mutation-reducer value bug the imperative write would have produced but the fold would not.
    await db.update(knowledge_edge).set({ weight: 5 }).where(eq(knowledge_edge.id, 'ke_rel'));

    const report = await runB3Gate(db, {}, TGEN);

    // The PRE-rebuild audit compares fold(weight=1) vs the imperative row (weight=5) → DRIFT.
    // (A post-rebuild audit would miss this — the rebuild overwrites the row with the fold.)
    expect(report.go).toBe(false);
    expect(report.audit.clean).toBe(false);
    expect(report.audit.driftCount).toBeGreaterThan(0);
    expect(report.audit.topologyReject).toBeNull();
  });

  it('NO-GO (survival): a row the rebuild would DELETE (folds to null) is caught — data-loss teeth', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_a', name: 'A' });
    await insertKnowledge({ id: 'kn_b', name: 'B' });
    // A live edge whose ONLY event is a generate-ARCHIVE (no create) → folds to null. It is
    // event-sourced (has a generate event), so the scoped backfill skips it → the rebuild DELETEs it.
    await insertEdge({ id: 'ke_archonly', from: 'kn_a', to: 'kn_b' });
    await seedGenerateArchiveOnly('ke_archonly');

    const report = await runB3Gate(db, {}, TGEN);

    expect(report.go).toBe(false);
    expect(report.survival.ok).toBe(false);
    expect(report.survival.deletedEdges).toContain('ke_archonly');
  });

  it('NO-GO (resurrection): the rebuild MATERIALIZES an event-only row with no live counterpart — caught by the rowset creation check', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_a', name: 'A' });
    await insertKnowledge({ id: 'kn_b', name: 'B' });
    // A generate-create event for an edge with NO live row (its live row was dropped out-of-band; the
    // event remains). The rebuild's edge universe includes event subject_ids → it RE-CREATES the edge.
    // The live-only audit never sees this class, so the rowset creation diff is the only leg that
    // catches the flip resurrecting it.
    await seedGenerateCreateRelated({
      edgeId: 'ke_resurrect',
      from: 'kn_a',
      to: 'kn_b',
      weight: 1,
    });

    const report = await runB3Gate(db, {}, TGEN);

    expect(report.go).toBe(false);
    expect(report.survival.ok).toBe(false);
    expect(report.survival.createdEdges).toContain('ke_resurrect');
    // the audit (live-only scan) does NOT see the event-only row — the creation check is what catches it.
    expect(report.audit.clean).toBe(true);
  });
});
