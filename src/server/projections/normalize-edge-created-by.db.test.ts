// YUK-471 W1 B3 — DB tests for the legacy-edge created_by/created_at normalization migration.
//
// A pre-fix (legacy) edge stored a STRING created_by + its OWN created_at (≠ the generate event's),
// so it folds != row. normalizeEdgeCreatedBy repairs those two columns to the fold's values. After
// it, the edge folds == row. Idempotent; event-less edges are skipped (genesis backfill handles
// them). Hermetic: resetDb() in beforeEach.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, knowledge, knowledge_edge } from '@/db/schema';
import { edgeRowToSnapshot, gatherAndFoldKnowledgeEdge } from '@/server/projections/gather';
import { diffSnapshots } from '@/server/projections/snapshot-diff';
import { normalizeEdgeCreatedBy } from '../../../scripts/normalize-edge-created-by';
import { resetDb, testDb } from '../../../tests/helpers/db';

const T_EVENT = new Date('2026-06-01T00:00:00.000Z'); // the generate event's timestamp (the SoT)
const T_ROW = new Date('2026-06-01T00:00:00.123Z'); // the legacy row's own (divergent) stamp

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
    created_at: T_EVENT,
    updated_at: T_EVENT,
    version: 0,
  });
}

// A LEGACY edge: created_by stored as a bare string, created_at != the generate event's stamp.
async function insertLegacyEdge(id: string, from: string, to: string): Promise<void> {
  const db = testDb();
  await db.insert(knowledge_edge).values({
    id,
    from_knowledge_id: from,
    to_knowledge_id: to,
    relation_type: 'related_to',
    weight: 1,
    created_by: 'dreaming' as never, // legacy bare-string shape
    reasoning: null,
    created_at: T_ROW, // diverges from the event's T_EVENT
  });
  await db.insert(event).values({
    id: `ev_gen_${id}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: id,
    outcome: 'success',
    payload: {
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: 'related_to',
      weight: 1,
      reasoning: null,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: T_EVENT,
  });
}

describe('normalizeEdgeCreatedBy', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('repairs a legacy edge (string created_by + divergent created_at) to fold-consistent, then folds == row', async () => {
    const db = testDb();
    await insertNode('a');
    await insertNode('b');
    await insertLegacyEdge('ke_legacy', 'a', 'b');

    // Before: folds != row (string created_by + divergent created_at).
    const before = (
      await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, 'ke_legacy'))
    )[0];
    const foldedBefore = await gatherAndFoldKnowledgeEdge(db, 'ke_legacy');
    expect(
      diffSnapshots(
        edgeRowToSnapshot(before as never) as Record<string, unknown>,
        foldedBefore as unknown as Record<string, unknown>,
      ).length,
    ).toBeGreaterThan(0);

    const counts = await normalizeEdgeCreatedBy(db);
    expect(counts.normalized).toBe(1);

    // After: created_by is the fold's object, created_at is the event's, and fold == row.
    const after = (
      await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, 'ke_legacy'))
    )[0];
    expect(after?.created_by).toEqual({ actor_kind: 'agent', actor_ref: 'dreaming' });
    expect(after?.created_at.getTime()).toBe(T_EVENT.getTime());
    const foldedAfter = await gatherAndFoldKnowledgeEdge(db, 'ke_legacy');
    expect(
      diffSnapshots(
        edgeRowToSnapshot(after as never) as Record<string, unknown>,
        foldedAfter as unknown as Record<string, unknown>,
      ),
    ).toEqual([]);
  });

  it('is idempotent — a second run normalizes nothing', async () => {
    const db = testDb();
    await insertNode('a');
    await insertNode('b');
    await insertLegacyEdge('ke_legacy', 'a', 'b');

    expect((await normalizeEdgeCreatedBy(db)).normalized).toBe(1);
    expect((await normalizeEdgeCreatedBy(db)).normalized).toBe(0);
  });

  it('skips an event-less edge (no generate event → handled by the genesis backfill, not deleted)', async () => {
    const db = testDb();
    await insertNode('a');
    await insertNode('b');
    // an edge with NO events — folds to null
    await db.insert(knowledge_edge).values({
      id: 'ke_eventless',
      from_knowledge_id: 'a',
      to_knowledge_id: 'b',
      relation_type: 'related_to',
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: T_ROW,
    });

    const counts = await normalizeEdgeCreatedBy(db);
    expect(counts.normalized).toBe(0);
    // still present (not deleted) — backfill anchors it instead.
    const row = await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, 'ke_eventless'));
    expect(row).toHaveLength(1);
  });
});
