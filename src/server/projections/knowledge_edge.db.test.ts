// YUK-471 W1 PR-A2a — DB tests for projectKnowledgeEdge (testcontainer).
//
// Edges are simple: every edge event keys on subject_id=edgeId. Seed raw `event` rows,
// call projectKnowledgeEdge, assert the live knowledge_edge row. The topology-reject test
// seeds a LIVE edge (the liveMesh fixture) + a cyclic prerequisite generate event and
// asserts the fold THROWS (the shell lets it propagate so the caller tx aborts).
//
// FK note: knowledge_edge.from/to reference knowledge.id, so endpoint nodes must exist
// before inserting/projecting an edge row. Hermetic: resetDb() in beforeEach.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, knowledge, knowledge_edge } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { projectKnowledgeEdge } from './knowledge_edge';

type EdgeEventSeed = {
  id: string;
  action: string;
  subject_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
};

async function seedEdgeEvent(s: EdgeEventSeed): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: s.id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: s.action,
    subject_kind: 'knowledge_edge',
    subject_id: s.subject_id,
    outcome: 'partial',
    payload: s.payload,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: s.created_at,
  });
}

async function insertNode(id: string): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: null,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: true,
    approval_status: 'approved',
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function insertLiveEdge(opts: {
  id: string;
  from: string;
  to: string;
  relation_type: string;
}): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge_edge).values({
    id: opts.id,
    from_knowledge_id: opts.from,
    to_knowledge_id: opts.to,
    relation_type: opts.relation_type,
    weight: 1,
    created_by: { by: 'ai', task_kind: 'dreaming' },
    reasoning: null,
    created_at: now,
    archived_at: null,
  });
}

async function readEdge(id: string) {
  const db = testDb();
  const rows = await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, id));
  return rows[0] ?? null;
}

const T0 = new Date('2026-06-01T00:00:00.000Z');
const T1 = new Date('2026-06-01T01:00:00.000Z');

describe('projectKnowledgeEdge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('generate-create — upserts a live edge row', async () => {
    await insertNode('kn_a');
    await insertNode('kn_b');
    const edgeId = 'ke_create';
    await seedEdgeEvent({
      id: 'ev_gen_create',
      action: 'generate',
      subject_id: edgeId,
      payload: {
        edge_op: 'create',
        from_knowledge_id: 'kn_a',
        to_knowledge_id: 'kn_b',
        relation_type: 'related_to',
        weight: 0.8,
        reasoning: 'related',
        propose_event_id: 'ev_propose_edge',
      },
      created_at: T0,
    });

    await projectKnowledgeEdge(testDb(), edgeId);

    const row = await readEdge(edgeId);
    expect(row).not.toBeNull();
    expect(row?.from_knowledge_id).toBe('kn_a');
    expect(row?.to_knowledge_id).toBe('kn_b');
    expect(row?.relation_type).toBe('related_to');
    expect(row?.weight).toBeCloseTo(0.8);
    expect(row?.reasoning).toBe('related');
    expect(row?.archived_at).toBeNull();
    expect(row?.created_at.getTime()).toBe(T0.getTime());
  });

  it('generate-archive — stamps archived_at on the existing row', async () => {
    await insertNode('kn_c');
    await insertNode('kn_d');
    const edgeId = 'ke_archive';
    await seedEdgeEvent({
      id: 'ev_gen_create2',
      action: 'generate',
      subject_id: edgeId,
      payload: {
        edge_op: 'create',
        from_knowledge_id: 'kn_c',
        to_knowledge_id: 'kn_d',
        relation_type: 'related_to',
        weight: 1,
      },
      created_at: T0,
    });
    await seedEdgeEvent({
      id: 'ev_gen_archive',
      action: 'generate',
      subject_id: edgeId,
      payload: { edge_op: 'archive', archive_edge_id: edgeId },
      created_at: T1,
    });

    await projectKnowledgeEdge(testDb(), edgeId);

    const row = await readEdge(edgeId);
    expect(row).not.toBeNull();
    expect(row?.archived_at?.getTime()).toBe(T1.getTime());
    // create fields preserved through the archive.
    expect(row?.from_knowledge_id).toBe('kn_c');
    expect(row?.to_knowledge_id).toBe('kn_d');
  });

  it('fold → null DELETEs an existing edge row (no matching events)', async () => {
    await insertNode('kn_e');
    await insertNode('kn_f');
    const edgeId = 'ke_orphan';
    // A live edge row exists but has NO events → fold returns null → DELETE.
    await insertLiveEdge({ id: edgeId, from: 'kn_e', to: 'kn_f', relation_type: 'related_to' });

    expect(await readEdge(edgeId)).not.toBeNull();
    await projectKnowledgeEdge(testDb(), edgeId);
    expect(await readEdge(edgeId)).toBeNull();
  });

  it('topology reject — a cyclic prerequisite create THROWS (ADR-0034)', async () => {
    await insertNode('kn_x');
    await insertNode('kn_y');
    // LIVE prerequisite edge X → Y (the liveMesh fixture).
    await insertLiveEdge({
      id: 'ke_xy',
      from: 'kn_x',
      to: 'kn_y',
      relation_type: 'prerequisite',
    });
    // A generate-create for the REVERSE prerequisite Y → X — direction contradiction.
    const edgeId = 'ke_yx';
    await seedEdgeEvent({
      id: 'ev_gen_cycle',
      action: 'generate',
      subject_id: edgeId,
      payload: {
        edge_op: 'create',
        from_knowledge_id: 'kn_y',
        to_knowledge_id: 'kn_x',
        relation_type: 'prerequisite',
        weight: 1,
      },
      created_at: T0,
    });

    await expect(projectKnowledgeEdge(testDb(), edgeId)).rejects.toThrow(/topology reject/i);
    // The rejected edge must NOT have been written.
    expect(await readEdge(edgeId)).toBeNull();
  });
});
