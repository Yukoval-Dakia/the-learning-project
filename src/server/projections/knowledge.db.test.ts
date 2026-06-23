// YUK-471 W1 PR-A2a — DB tests for projectKnowledgeNode (testcontainer).
//
// Each test seeds RAW `event` rows (+ a materialized_id_index entry where the create
// shape needs the reverse index) for one create/mutate path, calls projectKnowledgeNode,
// and asserts the live `knowledge` row matches the pure fold's expectation. Events are
// inserted DIRECTLY via db.insert(event) (not writeEvent) so we can synthesize the
// POST-KEYSTONE accept-rate payload.materialized_ids the live accept path does not yet
// emit (PR-A2a is behavior-preserving; the keystone writer lands in PR-A2b/PR-B).
//
// Hermetic contract: resetDb() in beforeEach. resetDb does NOT truncate
// materialized_id_index (no FK → not reached by CASCADE), so we truncate it explicitly to
// keep the reverse-index hermetic across tests.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, knowledge } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { projectKnowledgeNode } from './knowledge';
import { upsertMaterializedIdIndex } from './materialized-id-index';

type EventSeed = {
  id: string;
  action: string;
  subject_kind?: string;
  subject_id: string;
  payload: Record<string, unknown>;
  caused_by_event_id?: string | null;
  actor_kind?: string;
  actor_ref?: string;
  outcome?: string | null;
  created_at: Date;
};

async function seedEvent(s: EventSeed): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: s.id,
    session_id: null,
    actor_kind: s.actor_kind ?? 'agent',
    actor_ref: s.actor_ref ?? 'dreaming',
    action: s.action,
    subject_kind: s.subject_kind ?? 'knowledge',
    subject_id: s.subject_id,
    outcome: s.outcome ?? 'partial',
    payload: s.payload,
    caused_by_event_id: s.caused_by_event_id ?? null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: s.created_at,
  });
}

// An accept-rate event (action='rate', subject_kind='event', caused_by=proposeId). Carries
// payload.materialized_ids — the POST-KEYSTONE shape the reducer reads minted node ids from.
async function seedAcceptRate(opts: {
  id: string;
  proposeId: string;
  created_at: Date;
  materializedKnowledge?: string[];
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: opts.proposeId,
    outcome: 'success',
    payload: opts.materializedKnowledge
      ? { rating: 'accept', materialized_ids: { knowledge: opts.materializedKnowledge } }
      : { rating: 'accept' },
    caused_by_event_id: opts.proposeId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at,
  });
}

async function insertKnowledge(opts: {
  id: string;
  name?: string;
  parent_id?: string | null;
  archived?: boolean;
  version?: number;
  merged_from?: string[];
  embed_model?: string | null;
  embed_version?: number | null;
  embed_content_hash?: string | null;
}): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id: opts.id,
    name: opts.name ?? opts.id,
    domain: null,
    parent_id: opts.parent_id ?? null,
    merged_from: opts.merged_from ?? [],
    proposed_by_ai: true,
    approval_status: 'approved',
    archived_at: opts.archived ? now : null,
    created_at: now,
    updated_at: now,
    version: opts.version ?? 0,
    embed_model: opts.embed_model ?? null,
    embed_version: opts.embed_version ?? null,
    embed_content_hash: opts.embed_content_hash ?? null,
  });
}

async function readNode(id: string) {
  const db = testDb();
  const rows = await db.select().from(knowledge).where(eq(knowledge.id, id));
  return rows[0] ?? null;
}

const T0 = new Date('2026-06-01T00:00:00.000Z');
const T1 = new Date('2026-06-01T01:00:00.000Z');
const T2 = new Date('2026-06-01T02:00:00.000Z');

describe('projectKnowledgeNode', () => {
  beforeEach(async () => {
    // materialized_id_index is now in ALL_TABLES (tests/helpers/db.ts), so resetDb
    // truncates the reverse-index too — no explicit truncate needed.
    await resetDb();
  });

  it('propose_new — projects a created node found via the reverse index (Q2)', async () => {
    const nodeId = 'kn_new_node';
    const proposeId = 'ev_propose_new';
    // propose_new: subject_id = the PROPOSAL id (NOT the node id); the minted node id is in
    // the accepting rate's materialized_ids. Q1 (subject_id=nodeId) misses it; Q2 (reverse
    // index → anchor) finds it.
    await seedEvent({
      id: proposeId,
      action: 'propose',
      subject_id: proposeId,
      payload: { name: '通假字', parent_id: 'seed:root', reasoning: 'r' },
      created_at: T0,
    });
    await seedAcceptRate({
      id: 'ev_rate_new',
      proposeId,
      created_at: T1,
      materializedKnowledge: [nodeId],
    });
    await upsertMaterializedIdIndex(testDb(), {
      materialized_id: nodeId,
      anchor_event_id: proposeId,
      subject_kind: 'knowledge',
    });

    await projectKnowledgeNode(testDb(), nodeId);

    const row = await readNode(nodeId);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(nodeId);
    expect(row?.name).toBe('通假字');
    expect(row?.parent_id).toBe('seed:root');
    expect(row?.version).toBe(0);
    expect(row?.archived_at).toBeNull();
    // created/updated stamped from the ACCEPT (rate) event time.
    expect(row?.created_at.getTime()).toBe(T1.getTime());
    expect(row?.updated_at.getTime()).toBe(T1.getTime());
  });

  it('reparent — projects parent_id + version bump from a subject-keyed mutation (Q1)', async () => {
    const nodeId = 'kn_reparent';
    // Seed the node via genesis so the reducer has a base row, then reparent it.
    await seedEvent({
      id: 'ev_genesis_rp',
      action: 'experimental:genesis',
      subject_id: nodeId,
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      outcome: 'success',
      payload: {
        row: {
          id: nodeId,
          name: 'movable',
          domain: null,
          parent_id: 'old_parent',
          merged_from: [],
          archived_at: null,
          proposed_by_ai: true,
          approval_status: 'approved',
          created_at: T0.toISOString(),
          updated_at: T0.toISOString(),
          version: 0,
        },
      },
      created_at: T0,
    });
    const proposeId = 'ev_reparent';
    await seedEvent({
      id: proposeId,
      action: 'experimental:knowledge_reparent',
      subject_id: nodeId,
      // expected_version is required by KnowledgeMutationProposalChange (the reducer reparses
      // the payload through it); the live writer always carries it.
      payload: {
        node_id: nodeId,
        new_parent_id: 'new_parent',
        expected_version: 0,
        reasoning: 'r',
      },
      created_at: T1,
    });
    await seedAcceptRate({ id: 'ev_rate_rp', proposeId, created_at: T2 });

    await projectKnowledgeNode(testDb(), nodeId);

    const row = await readNode(nodeId);
    expect(row?.parent_id).toBe('new_parent');
    expect(row?.domain).toBeNull();
    expect(row?.version).toBe(1);
    expect(row?.updated_at.getTime()).toBe(T2.getTime());
  });

  it('archive — sets archived_at + version bump (Q1)', async () => {
    const nodeId = 'kn_archive';
    await seedEvent({
      id: 'ev_genesis_ar',
      action: 'experimental:genesis',
      subject_id: nodeId,
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      outcome: 'success',
      payload: {
        row: {
          id: nodeId,
          name: 'doomed',
          domain: null,
          parent_id: 'p',
          merged_from: [],
          archived_at: null,
          proposed_by_ai: true,
          approval_status: 'approved',
          created_at: T0.toISOString(),
          updated_at: T0.toISOString(),
          version: 0,
        },
      },
      created_at: T0,
    });
    const proposeId = 'ev_archive';
    await seedEvent({
      id: proposeId,
      action: 'experimental:knowledge_archive',
      subject_id: nodeId,
      payload: { node_id: nodeId, reasoning: 'r' },
      created_at: T1,
    });
    await seedAcceptRate({ id: 'ev_rate_ar', proposeId, created_at: T2 });

    await projectKnowledgeNode(testDb(), nodeId);

    const row = await readNode(nodeId);
    expect(row?.archived_at?.getTime()).toBe(T2.getTime());
    expect(row?.version).toBe(1);
  });

  it('merge — into_id appends merged_from (Q1) AND a from_id is archived via Q3', async () => {
    const intoId = 'kn_into';
    const fromId = 'kn_from';
    // Both nodes seeded via genesis.
    for (const id of [intoId, fromId]) {
      await seedEvent({
        id: `ev_genesis_${id}`,
        action: 'experimental:genesis',
        subject_id: id,
        actor_kind: 'system',
        actor_ref: 'genesis-backfill',
        outcome: 'success',
        payload: {
          row: {
            id,
            name: id,
            domain: null,
            parent_id: 'p',
            merged_from: [],
            archived_at: null,
            proposed_by_ai: true,
            approval_status: 'approved',
            created_at: T0.toISOString(),
            updated_at: T0.toISOString(),
            version: 0,
          },
        },
        created_at: T0,
      });
    }
    // merge: subject_id = into_id; from_ids in payload.
    const proposeId = 'ev_merge';
    await seedEvent({
      id: proposeId,
      action: 'experimental:knowledge_merge',
      subject_id: intoId,
      // expected_versions (one per from_id) is required by the merge schema branch.
      payload: {
        into_id: intoId,
        from_ids: [fromId],
        expected_versions: { [fromId]: 0 },
        reasoning: 'r',
      },
      created_at: T1,
    });
    await seedAcceptRate({ id: 'ev_rate_merge', proposeId, created_at: T2 });

    // into_id: found via Q1 (subject_id === intoId).
    await projectKnowledgeNode(testDb(), intoId);
    const into = await readNode(intoId);
    expect(into?.merged_from).toEqual([fromId]);
    expect(into?.version).toBe(1);
    expect(into?.archived_at).toBeNull();

    // from_id: found ONLY via Q3 (the merge event's subject_id is intoId, not fromId; fromId
    // lives in payload.from_ids). Asserts the jsonb-containment gather path.
    await projectKnowledgeNode(testDb(), fromId);
    const from = await readNode(fromId);
    expect(from?.archived_at?.getTime()).toBe(T2.getTime());
    expect(from?.version).toBe(1);
  });

  it('split — from_id archived (Q1) AND a new node created via the reverse index (Q2)', async () => {
    const fromId = 'kn_split_from';
    const newChildId = 'kn_split_child';
    await seedEvent({
      id: 'ev_genesis_split',
      action: 'experimental:genesis',
      subject_id: fromId,
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      outcome: 'success',
      payload: {
        row: {
          id: fromId,
          name: 'splittable',
          domain: null,
          parent_id: 'p',
          merged_from: [],
          archived_at: null,
          proposed_by_ai: true,
          approval_status: 'approved',
          created_at: T0.toISOString(),
          updated_at: T0.toISOString(),
          version: 0,
        },
      },
      created_at: T0,
    });
    // split: subject_id = from_id; new node ids in the accepting rate's materialized_ids,
    // order matching payload.into[].
    const proposeId = 'ev_split';
    await seedEvent({
      id: proposeId,
      action: 'experimental:knowledge_split',
      subject_id: fromId,
      payload: {
        from_id: fromId,
        into: [{ name: 'child-a', parent_id: 'p' }],
        expected_version: 0,
        reasoning: 'r',
      },
      created_at: T1,
    });
    await seedAcceptRate({
      id: 'ev_rate_split',
      proposeId,
      created_at: T2,
      materializedKnowledge: [newChildId],
    });
    await upsertMaterializedIdIndex(testDb(), {
      materialized_id: newChildId,
      anchor_event_id: proposeId,
      subject_kind: 'knowledge',
    });

    // from_id: archived via Q1 (subject_id === fromId).
    await projectKnowledgeNode(testDb(), fromId);
    const from = await readNode(fromId);
    expect(from?.archived_at?.getTime()).toBe(T2.getTime());
    expect(from?.version).toBe(1);

    // new child: created via Q2 (reverse index → anchor=proposeId, materialized_ids[0]).
    await projectKnowledgeNode(testDb(), newChildId);
    const child = await readNode(newChildId);
    expect(child).not.toBeNull();
    expect(child?.name).toBe('child-a');
    expect(child?.parent_id).toBe('p');
    expect(child?.version).toBe(0);
  });

  it('genesis seed — projects the snapshot row verbatim (Q1)', async () => {
    const nodeId = 'kn_genesis_only';
    await seedEvent({
      id: 'ev_genesis_only',
      action: 'experimental:genesis',
      subject_id: nodeId,
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      outcome: 'success',
      payload: {
        row: {
          id: nodeId,
          name: 'seeded',
          domain: 'wenyan',
          parent_id: 'seed:root',
          merged_from: ['old1'],
          archived_at: null,
          proposed_by_ai: false,
          approval_status: 'approved',
          created_at: T0.toISOString(),
          updated_at: T0.toISOString(),
          version: 3,
        },
      },
      created_at: T0,
    });

    await projectKnowledgeNode(testDb(), nodeId);

    const row = await readNode(nodeId);
    expect(row?.name).toBe('seeded');
    expect(row?.domain).toBe('wenyan');
    expect(row?.parent_id).toBe('seed:root');
    expect(row?.merged_from).toEqual(['old1']);
    expect(row?.proposed_by_ai).toBe(false);
    expect(row?.version).toBe(3);
    expect(row?.created_at.getTime()).toBe(T0.getTime());
  });

  it('fold → null DELETEs an existing row (no events resolve to a created node)', async () => {
    const nodeId = 'kn_to_delete';
    // A live row exists, but there are NO events that create it (e.g. an unaccepted propose,
    // or a row whose creating events were never indexed). fold returns null → DELETE.
    await insertKnowledge({ id: nodeId, name: 'stale' });
    // A propose with NO accept rate → reducer yields null.
    const proposeId = 'ev_unaccepted';
    await seedEvent({
      id: proposeId,
      action: 'propose',
      subject_id: proposeId,
      payload: { name: 'never', parent_id: 'p', reasoning: 'r' },
      created_at: T0,
    });
    await upsertMaterializedIdIndex(testDb(), {
      materialized_id: nodeId,
      anchor_event_id: proposeId,
      subject_kind: 'knowledge',
    });

    expect(await readNode(nodeId)).not.toBeNull();
    await projectKnowledgeNode(testDb(), nodeId);
    expect(await readNode(nodeId)).toBeNull();
  });

  it('embed_* are preserved untouched on re-project (excluded from upsert SET)', async () => {
    const nodeId = 'kn_embed';
    // A live row with embedding maintenance state already filled (simulating embed_backfill).
    await insertKnowledge({
      id: nodeId,
      name: 'before',
      parent_id: 'p',
      embed_model: 'voyage-code-3',
      embed_version: 7,
      embed_content_hash: 'deadbeef',
    });
    // Re-project from a genesis seed that changes a STRUCTURAL field (name) — embed_* must
    // survive because the upsert SET omits them.
    await seedEvent({
      id: 'ev_genesis_embed',
      action: 'experimental:genesis',
      subject_id: nodeId,
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      outcome: 'success',
      payload: {
        row: {
          id: nodeId,
          name: 'after',
          domain: null,
          parent_id: 'p',
          merged_from: [],
          archived_at: null,
          proposed_by_ai: true,
          approval_status: 'approved',
          created_at: T0.toISOString(),
          updated_at: T0.toISOString(),
          version: 0,
        },
      },
      created_at: T0,
    });

    await projectKnowledgeNode(testDb(), nodeId);

    const row = await readNode(nodeId);
    expect(row?.name).toBe('after'); // structural field updated
    // embed_* preserved (NOT clobbered to NULL by the upsert).
    expect(row?.embed_model).toBe('voyage-code-3');
    expect(row?.embed_version).toBe(7);
    expect(row?.embed_content_hash).toBe('deadbeef');
  });
});
