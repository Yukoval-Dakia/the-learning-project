// YUK-471 W1 B3 — DB tests for the SCOPED genesis backfill (testcontainer).
//
// The backfill anchors ONLY truly event-less rows (seed roots / pre-W1 legacy). A row that is
// already event-sourced — a node with a genesis / auto_tag event or a materialized_id_index
// anchor, or an edge with a generate / genesis event — is SKIPPED, so it re-folds through its
// OWN reducers in the B3 audit (anchoring it with a current-state snapshot would mask reducer
// drift, since the genesis snapshot sorts last in the fold and overwrites the mutation output).
// Idempotent: a second run skips everything (the first run's rows now carry a genesis event).
//
// Hermetic: resetDb() in beforeEach.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, knowledge, knowledge_edge } from '@/db/schema';
import {
  backfillKnowledgeEdgeGenesis,
  backfillKnowledgeGenesis,
} from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';

const T0 = new Date('2026-06-01T00:00:00.000Z');

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

async function insertEdge(id: string, from: string, to: string): Promise<void> {
  const db = testDb();
  await db.insert(knowledge_edge).values({
    id,
    from_knowledge_id: from,
    to_knowledge_id: to,
    relation_type: 'related_to',
    weight: 1,
    created_by: { by: 'user' },
    reasoning: null,
    created_at: T0,
    archived_at: null,
  });
}

async function seedEvent(opts: {
  id: string;
  action: string;
  subject_kind: 'knowledge' | 'knowledge_edge';
  subject_id: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: opts.action,
    subject_kind: opts.subject_kind,
    subject_id: opts.subject_id,
    outcome: 'success',
    payload: opts.payload ?? {},
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: T0,
  });
}

async function genesisCount(subjectId: string): Promise<number> {
  const db = testDb();
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.action, 'experimental:genesis'), eq(event.subject_id, subjectId)));
  return rows.length;
}

describe('backfillGenesis — scoped to truly event-less rows', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('anchors an event-less node but SKIPS one already event-sourced (auto_tag create)', async () => {
    const db = testDb();
    await insertNode('seed:root'); // event-less → must be anchored
    await insertNode('kn_tagged'); // event-sourced via auto_tag → must be SKIPPED
    await seedEvent({
      id: 'ev_autotag',
      action: 'experimental:auto_tag_kc_created',
      subject_kind: 'knowledge',
      subject_id: 'kn_tagged',
    });

    const counts = await backfillKnowledgeGenesis(db, T0);

    expect(counts.seeded).toBe(1); // only the event-less seed root
    expect(counts.skipped).toBe(1); // the auto_tag node is already event-sourced
    expect(await genesisCount('seed:root')).toBe(1);
    expect(await genesisCount('kn_tagged')).toBe(0); // NOT anchored → folds from its own events
  });

  it('anchors an event-less edge but SKIPS one that already has a generate event', async () => {
    const db = testDb();
    await insertNode('a');
    await insertNode('b');
    await insertNode('c');
    await insertEdge('ke_seed', 'a', 'b'); // event-less → anchored
    await insertEdge('ke_gen', 'a', 'c'); // event-sourced via generate → SKIPPED
    await seedEvent({
      id: 'ev_gen_edge',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'ke_gen',
      payload: {
        edge_op: 'create',
        from_knowledge_id: 'a',
        to_knowledge_id: 'c',
        relation_type: 'related_to',
        weight: 1,
      },
    });

    const counts = await backfillKnowledgeEdgeGenesis(db, T0);

    expect(counts.seeded).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(await genesisCount('ke_seed')).toBe(1);
    expect(await genesisCount('ke_gen')).toBe(0);
  });

  it('is idempotent — a second run seeds nothing (first run anchored the event-less rows)', async () => {
    const db = testDb();
    await insertNode('seed:root');
    await insertEdge('ke_seed', 'seed:root', 'seed:root');

    const first = await backfillKnowledgeGenesis(db, T0);
    const firstEdge = await backfillKnowledgeEdgeGenesis(db, T0);
    expect(first.seeded).toBe(1);
    expect(firstEdge.seeded).toBe(1);

    const second = await backfillKnowledgeGenesis(db, T0);
    const secondEdge = await backfillKnowledgeEdgeGenesis(db, T0);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(secondEdge.seeded).toBe(0);
    expect(secondEdge.skipped).toBe(1);
  });
});
