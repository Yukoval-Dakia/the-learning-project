// YUK-471 W1 B3 — DB tests for the prod-clone SoT-flip gate orchestrator (testcontainer).
//
// runB3Gate runs the documented B3 procedure against a (clone) DB: snapshot live ids →
// genesis backfill → full projection rebuild → audit + survival/topology verification → a
// go/no-go report. These tests prove the two verdicts that matter:
//   (GO)    a coherent pre-event-sourcing world backfills+rebuilds+audits CLEAN with zero
//           deletions (seed roots survive) → go=true.
//   (NO-GO) an imperatively-created CYCLIC prerequisite pair — which the accept path never
//           gated (ADR-0034 runs only in the fold) — is caught: the rebuild topology-rejects
//           → go=false, with the reject surfaced (not swallowed).
//
// FK: knowledge_edge.from/to reference knowledge.id, so endpoint nodes exist first.
// Hermetic: resetDb() in beforeEach.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, knowledge, knowledge_edge } from '@/db/schema';
import { runB3Gate } from '../../../scripts/b3-gate';
import { resetDb, testDb } from '../../../tests/helpers/db';

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
    expect(report.survival.ok).toBe(true);
    expect(report.survival.deletedKnowledge).toEqual([]);
    expect(report.survival.deletedEdges).toEqual([]);
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
    expect(report.rebuild.ok).toBe(false);
    expect(report.rebuild.topologyReject).toMatch(/topology reject/i);
  });
});
