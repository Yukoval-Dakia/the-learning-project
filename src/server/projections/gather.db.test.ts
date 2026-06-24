// YUK-471 W1 B3 (audit perf) — DB tests for the mesh-injected edge gather variant.
//
// gatherAndFoldKnowledgeEdge re-fetches the ENTIRE live edge mesh on EVERY call, so the
// full-table auditor (which folds every edge) is O(E²). The fix adds
// gatherAndFoldKnowledgeEdgeWithMesh(db, edgeId, liveMesh): the caller fetches the mesh ONCE
// and passes it in. In a READ-ONLY scan the live mesh is constant, so one fetch == N fetches.
//
// These tests prove the refactor is SAFE:
//   (1) EQUIVALENCE — for the SAME mesh, the mesh-injected variant returns a row byte-identical
//       to the self-fetching per-edge function, across a realistic mesh (genesis-live +
//       genesis-archived + a generate-create prerequisite whose verdict depends on the mesh).
//   (2) MESH IS LOAD-BEARING — the injected mesh actually drives the ADR-0034 topology verdict:
//       a reverse prerequisite create THROWS against a mesh holding the forward edge, but does
//       NOT throw against an empty mesh — and the self-fetching fn (which reads the real live
//       mesh) matches the full-mesh branch. This guarantees the variant did not silently drop
//       the mesh.
//
// FK note: knowledge_edge.from/to reference knowledge.id, so endpoint nodes exist first.
// Hermetic: resetDb() in beforeEach.

import { isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { KnowledgeEdgeRowSnapshotT } from '@/core/schema/event/genesis';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import {
  backfillKnowledgeEdgeGenesis,
  backfillKnowledgeGenesis,
} from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  edgeRowToSnapshot,
  gatherAndFoldKnowledgeEdge,
  gatherAndFoldKnowledgeEdgeWithMesh,
} from './gather';

const T0 = new Date('2026-06-01T00:00:00.000Z');
const T1 = new Date('2026-06-01T01:00:00.000Z');

async function insertNode(id: string): Promise<void> {
  const db = testDb();
  await db.insert(knowledge).values({
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

async function seedGenerateCreateEvent(opts: {
  id: string;
  edgeId: string;
  from: string;
  to: string;
  relation_type: string;
  created_at: Date;
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
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
      relation_type: opts.relation_type,
      weight: 1,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at,
  });
}

// Build the live mesh exactly as the auditor will: live (archived_at IS NULL) edges → snapshot.
async function liveMesh(): Promise<KnowledgeEdgeRowSnapshotT[]> {
  const db = testDb();
  const rows = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
  return rows.map(edgeRowToSnapshot);
}

describe('gatherAndFoldKnowledgeEdgeWithMesh', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('is byte-identical to the self-fetching gatherAndFoldKnowledgeEdge for every edge in a realistic mesh', async () => {
    const db = testDb();
    await insertNode('kn_a');
    await insertNode('kn_b');
    await insertNode('kn_c');

    // edge1: live related_to (genesis-backfilled, mesh-independent fold).
    await insertEdge({ id: 'ke_live', from: 'kn_a', to: 'kn_b', relation_type: 'related_to' });
    // edge2: ARCHIVED (genesis-backfilled → folds to archived; excluded from the mesh).
    await insertEdge({
      id: 'ke_arch',
      from: 'kn_a',
      to: 'kn_c',
      relation_type: 'related_to',
      archived_at: T1,
    });
    // Backfill genesis for the two pre-existing edges (and their endpoint nodes).
    await backfillKnowledgeGenesis(db, T0);
    await backfillKnowledgeEdgeGenesis(db, T0);

    // edge3: a generate-create PREREQUISITE (b → c) — its fold runs the ADR-0034 topology gate
    // AGAINST the mesh, so the mesh genuinely participates. No cycle → verdict ok → row.
    // Inserted AFTER backfill so it has ONLY the generate event (no genesis), keeping the
    // topology path the sole driver.
    await insertEdge({ id: 'ke_prereq', from: 'kn_b', to: 'kn_c', relation_type: 'prerequisite' });
    await seedGenerateCreateEvent({
      id: 'ev_prereq_create',
      edgeId: 'ke_prereq',
      from: 'kn_b',
      to: 'kn_c',
      relation_type: 'prerequisite',
      created_at: T1,
    });

    const mesh = await liveMesh();
    for (const edgeId of ['ke_live', 'ke_arch', 'ke_prereq']) {
      const withMesh = await gatherAndFoldKnowledgeEdgeWithMesh(db, edgeId, mesh);
      const perEdge = await gatherAndFoldKnowledgeEdge(db, edgeId);
      expect(withMesh).toEqual(perEdge);
    }
  });

  it('the injected mesh is load-bearing: it drives the ADR-0034 topology verdict', async () => {
    const db = testDb();
    await insertNode('kn_x');
    await insertNode('kn_y');
    // LIVE forward prerequisite X → Y.
    await insertEdge({ id: 'ke_xy', from: 'kn_x', to: 'kn_y', relation_type: 'prerequisite' });
    // A generate-create for the REVERSE prerequisite Y → X (direction contradiction).
    await seedGenerateCreateEvent({
      id: 'ev_cycle',
      edgeId: 'ke_yx',
      from: 'kn_y',
      to: 'kn_x',
      relation_type: 'prerequisite',
      created_at: T1,
    });

    const meshWithForward = await liveMesh(); // holds X → Y

    // Against the real mesh (holds the forward edge): topology reject → THROWS.
    await expect(gatherAndFoldKnowledgeEdgeWithMesh(db, 'ke_yx', meshWithForward)).rejects.toThrow(
      /topology reject/i,
    );
    // The self-fetching fn reads the SAME live mesh → matches the full-mesh branch (throws).
    await expect(gatherAndFoldKnowledgeEdge(db, 'ke_yx')).rejects.toThrow(/topology reject/i);
    // Against an EMPTY mesh: no forward edge → no cycle → the create projects a row (no throw).
    const projected = await gatherAndFoldKnowledgeEdgeWithMesh(db, 'ke_yx', []);
    expect(projected?.from_knowledge_id).toBe('kn_y');
    expect(projected?.to_knowledge_id).toBe('kn_x');
  });
});
