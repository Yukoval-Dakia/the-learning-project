// YUK-471 W1 PR-A2b (DoubleWrite) — DB tests for the accept-time projection PARITY ASSERT.
//
// Proves the dev/test-THROW behavior of assertKnowledge{Node,Edge}Parity (src/.../parity.ts):
//   - a CLEAN accept (live row reproducible from its events) passes the assert,
//   - an out-of-band mutation that diverges the live row from fold(events) THROWS,
//   - the genesis-anchor applicability gate (knowledgeNodesWithGenesisAnchor) skips a
//     pre-event-sourcing node (no anchor → fold null is not a real mismatch).
//
// These run with NODE_ENV !== 'production', so onParityMismatch THROWs (the prod warn+return
// path is the documented contract, not exercised here — we assert the strict dev/test gate).
//
// Hermetic: resetDb() truncates `event`, `knowledge`, `knowledge_edge`, and
// `materialized_id_index` (all in ALL_TABLES), so each test starts clean.

import { acceptProposal } from '@/capabilities/knowledge/server/proposals';
import { KnowledgeRowSnapshot } from '@/core/schema/event/genesis';
import { event, knowledge, knowledge_edge, materialized_id_index } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  assertKnowledgeEdgeParity,
  assertKnowledgeNodeParity,
  hasKnowledgeNodeGenesisAnchor,
  knowledgeNodesWithGenesisAnchor,
} from './parity';

async function insertKnowledge(opts: {
  id: string;
  name?: string;
  domain?: string | null;
  parent_id?: string | null;
  version?: number;
}): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id: opts.id,
    name: opts.name ?? opts.id,
    domain: opts.domain !== undefined ? opts.domain : 'wenyan',
    parent_id: opts.parent_id ?? null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: opts.version ?? 0,
  });
}

async function insertProposeEvent(opts: {
  id: string;
  payload: Record<string, unknown>;
  subject_id?: string;
}): Promise<void> {
  const db = testDb();
  const now = new Date();
  const action =
    opts.payload.mutation === 'propose_new'
      ? 'propose'
      : `experimental:knowledge_${opts.payload.mutation}`;
  const { mutation: _m, ...rest } = opts.payload;
  void _m;
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action,
    subject_kind: 'knowledge',
    subject_id: opts.subject_id ?? `subject_${opts.id}`,
    outcome: 'partial',
    payload: { ...rest, reasoning: 'r' },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
}

async function liveSnapshot(id: string) {
  const db = testDb();
  const rows = await db.select().from(knowledge).where(eq(knowledge.id, id));
  if (!rows[0]) return null;
  return KnowledgeRowSnapshot.parse(rows[0]);
}

describe('assertKnowledgeNodeParity — accept-time projection parity', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a CLEAN propose_new accept passes the parity assert (fold == live row)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:root', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p_clean',
      payload: { mutation: 'propose_new', name: '通假字', parent_id: 'seed:wenyan:root' },
    });

    // acceptProposal already runs the parity assert internally; reaching here without a
    // throw proves the clean path passes. Re-assert explicitly for an independent check.
    const result = await acceptProposal(db, 'p_clean');
    if (result.kind !== 'propose_new_applied') throw new Error('unexpected kind');
    const nodeId = result.new_node_id;

    const live = await liveSnapshot(nodeId);
    await expect(assertKnowledgeNodeParity(db, nodeId, live)).resolves.toBeUndefined();
  });

  it('THROWS when the live row is mutated OUT-OF-BAND to diverge from fold(events)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:root', domain: 'wenyan' });
    await insertKnowledge({ id: 'seed:wenyan:other', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p_div',
      payload: { mutation: 'propose_new', name: '互文', parent_id: 'seed:wenyan:root' },
    });
    const result = await acceptProposal(db, 'p_div');
    if (result.kind !== 'propose_new_applied') throw new Error('unexpected kind');
    const nodeId = result.new_node_id;

    // Out-of-band write: directly UPDATE the live knowledge row so it no longer matches the
    // event log (the fold still reconstructs parent_id='seed:wenyan:root', name='互文'). This
    // is exactly the drift the assert exists to catch.
    await db
      .update(knowledge)
      .set({ name: 'TAMPERED', parent_id: 'seed:wenyan:other' })
      .where(eq(knowledge.id, nodeId));

    const tamperedLive = await liveSnapshot(nodeId);
    await expect(assertKnowledgeNodeParity(db, nodeId, tamperedLive)).rejects.toThrow(
      /projection-parity/i,
    );
  });

  it('THROWS when the passed-in live row is null but the fold produces a row', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:root', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p_nullrow',
      payload: { mutation: 'propose_new', name: '倒装', parent_id: 'seed:wenyan:root' },
    });
    const result = await acceptProposal(db, 'p_nullrow');
    if (result.kind !== 'propose_new_applied') throw new Error('unexpected kind');
    const nodeId = result.new_node_id;

    // fold reproduces a row, but we claim the live row is null → whole-row mismatch → throw.
    await expect(assertKnowledgeNodeParity(db, nodeId, null)).rejects.toThrow(/projection-parity/i);
  });

  it('merge accept: into_id parity holds (merged_from append + version bump reproduce)', async () => {
    const db = testDb();
    // Seed into + from nodes via propose_new accepts so each has an event-log genesis (the
    // parity gate requires it; a bare INSERT has no anchor and would be skipped).
    await insertKnowledge({ id: 'seed:root', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p_into',
      payload: { mutation: 'propose_new', name: 'into', parent_id: 'seed:root' },
    });
    const intoSeed = await acceptProposal(db, 'p_into');
    if (intoSeed.kind !== 'propose_new_applied') throw new Error('into seed failed');
    const intoId = intoSeed.new_node_id;

    await insertProposeEvent({
      id: 'p_from',
      payload: { mutation: 'propose_new', name: 'from', parent_id: 'seed:root' },
    });
    const fromSeed = await acceptProposal(db, 'p_from');
    if (fromSeed.kind !== 'propose_new_applied') throw new Error('from seed failed');
    const fromId = fromSeed.new_node_id;

    // merge from → into. subject_id convention for merge = into_id.
    await insertProposeEvent({
      id: 'p_merge',
      subject_id: intoId,
      payload: {
        mutation: 'merge',
        from_ids: [fromId],
        into_id: intoId,
        expected_versions: { [fromId]: 0 },
      },
    });
    // acceptProposal runs the parity assert for BOTH into_id (merged_from append) and fromId
    // (archived) — reaching here without throwing proves both folds reproduce their rows.
    const merged = await acceptProposal(db, 'p_merge');
    expect(merged.kind).toBe('merge_applied');

    // Explicit cross-check on the into node: its merged_from now contains fromId, and the
    // fold reproduces that.
    const intoLive = await liveSnapshot(intoId);
    expect(intoLive?.merged_from).toContain(fromId);
    await expect(assertKnowledgeNodeParity(db, intoId, intoLive)).resolves.toBeUndefined();
  });
});

describe('knowledge node genesis-anchor gate (parity applicability)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a bare-INSERTed (pre-event-sourcing) node has NO genesis anchor → gate skips it', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'legacy_node', domain: 'wenyan' });
    expect(await hasKnowledgeNodeGenesisAnchor(db, 'legacy_node')).toBe(false);
    const set = await knowledgeNodesWithGenesisAnchor(db, ['legacy_node']);
    expect(set.has('legacy_node')).toBe(false);
  });

  it('a propose_new-minted node HAS a genesis anchor (materialized_id_index row)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:root', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p_anchor',
      payload: { mutation: 'propose_new', name: 'anchored', parent_id: 'seed:root' },
    });
    const result = await acceptProposal(db, 'p_anchor');
    if (result.kind !== 'propose_new_applied') throw new Error('unexpected kind');
    const nodeId = result.new_node_id;

    // The accept wrote a materialized_id_index row anchoring nodeId → the proposal.
    const idxRows = await db
      .select()
      .from(materialized_id_index)
      .where(eq(materialized_id_index.materialized_id, nodeId));
    expect(idxRows).toHaveLength(1);
    expect(await hasKnowledgeNodeGenesisAnchor(db, nodeId)).toBe(true);
  });

  it('an auto_tag-created node HAS a genesis anchor (auto_tag event subject_id)', async () => {
    const db = testDb();
    // Synthesize the auto_tag create shape (row + experimental:auto_tag_kc_created event)
    // the way tag-knowledge.ts writes it.
    const now = new Date();
    await insertKnowledge({ id: 'autotag_node', domain: null, parent_id: 'seed:root' });
    await db.insert(event).values({
      id: 'autotag_ev',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'tag_knowledge',
      action: 'experimental:auto_tag_kc_created',
      subject_kind: 'knowledge',
      subject_id: 'autotag_node',
      outcome: 'success',
      payload: { name: 'autotag_node', parent_id: 'seed:root', source: 'tag_knowledge' },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
    expect(await hasKnowledgeNodeGenesisAnchor(db, 'autotag_node')).toBe(true);
  });
});

describe('decideKnowledgeEdgeProposal — accept-time edge parity (via acceptAiProposal)', () => {
  // The edge create path (actions.ts) asserts parity internally after writing the edge +
  // generate event. A clean create must pass; we drive it through the real edge accept and
  // assert it returns a materialized edge id (reaching here without a throw == parity held).
  beforeEach(async () => {
    await resetDb();
  });

  it('a clean edge create accept passes the in-tx edge parity assert', async () => {
    const { acceptAiProposal } = await import('@/server/proposals/actions');
    const { writeAiProposal } = await import('@/server/proposals/writer');
    const db = testDb();
    const now = new Date();
    for (const id of ['ke_from', 'ke_to']) {
      await db.insert(knowledge).values({
        id,
        name: id,
        domain: 'wenyan',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        archived_at: null,
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }
    await writeAiProposal(db, {
      id: 'edge_parity_p',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'from unlocks to',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'ke_from',
          to_knowledge_id: 'ke_to',
          relation_type: 'prerequisite',
          weight: 0.6,
        },
      },
    });

    const result = await acceptAiProposal(db, 'edge_parity_p');
    expect(result.kind).toBe('knowledge_edge');
    if (result.kind !== 'knowledge_edge') throw new Error('unexpected kind');
    expect(result.edge_id).toBeTruthy();
  });

  // Insert a live knowledge_edge row + its matching `generate` event so fold(events) == row
  // (created_by/created_at/reasoning all reproduce). One shared `now` keeps the row's and the
  // event's created_at equal (the reducer stamps the edge created_at from the generate event).
  async function insertEdgeWithGenerate(opts: {
    edgeId: string;
    from: string;
    to: string;
    relation_type?: string;
    weight?: number;
  }): Promise<void> {
    const db = testDb();
    const now = new Date();
    const rt = opts.relation_type ?? 'related_to';
    const w = opts.weight ?? 1;
    const createdBy = {
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      propose_event_id: `pe_${opts.edgeId}`,
    };
    await db.insert(knowledge_edge).values({
      id: opts.edgeId,
      from_knowledge_id: opts.from,
      to_knowledge_id: opts.to,
      relation_type: rt,
      weight: w,
      // `as never`: the column is typed AgentRefT but the live edge create (actions.ts:514-518)
      // stores this { actor_kind, actor_ref, propose_event_id } shape — match it so fold==row.
      created_by: createdBy as never,
      reasoning: 'r',
      created_at: now,
      archived_at: null,
    });
    await db.insert(event).values({
      id: `gen_${opts.edgeId}`,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: opts.edgeId,
      outcome: 'success',
      payload: {
        from_knowledge_id: opts.from,
        to_knowledge_id: opts.to,
        relation_type: rt,
        weight: w,
        reasoning: 'r',
        propose_event_id: `pe_${opts.edgeId}`,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
  }

  async function edgeLiveSnapshot(edgeId: string) {
    const db = testDb();
    const r = (await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, edgeId)))[0];
    if (!r) return null;
    return {
      id: r.id,
      from_knowledge_id: r.from_knowledge_id,
      to_knowledge_id: r.to_knowledge_id,
      relation_type: r.relation_type,
      weight: r.weight,
      created_by: r.created_by as Record<string, unknown>,
      reasoning: r.reasoning,
      created_at: r.created_at,
      archived_at: r.archived_at,
    };
  }

  it('THROWS when the live edge row is mutated out-of-band to diverge from fold(events)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'ke_a' });
    await insertKnowledge({ id: 'ke_b' });
    await insertEdgeWithGenerate({
      edgeId: 'edge_div',
      from: 'ke_a',
      to: 'ke_b',
      relation_type: 'related_to',
      weight: 0.5,
    });
    // clean: fold(generate) == live row.
    await expect(
      assertKnowledgeEdgeParity(db, 'edge_div', await edgeLiveSnapshot('edge_div')),
    ).resolves.toBeUndefined();
    // out-of-band: change the live edge weight so fold(weight=0.5) != row(weight=0.99) → THROW.
    await db.update(knowledge_edge).set({ weight: 0.99 }).where(eq(knowledge_edge.id, 'edge_div'));
    await expect(
      assertKnowledgeEdgeParity(db, 'edge_div', await edgeLiveSnapshot('edge_div')),
    ).rejects.toThrow(/projection-parity/i);
  });

  it('routes a fold-side ADR-0034 topology REJECT through the dev-throws switch (<fold-threw>)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'ke_x' });
    await insertKnowledge({ id: 'ke_y' });
    // A LIVE prerequisite Y→X forms the liveMesh the fold checks topology against.
    await insertEdgeWithGenerate({
      edgeId: 'edge_yx',
      from: 'ke_y',
      to: 'ke_x',
      relation_type: 'prerequisite',
    });
    // A `generate` event ONLY (no live row, so edge_xy is NOT in liveMesh → no self-inclusion):
    // folding it CREATES a live prerequisite X→Y that reverses the live Y→X → checkEdgeTopology
    // REJECTS → gatherAndFoldKnowledgeEdge THROWS. assertKnowledgeEdgeParity must CATCH that and
    // route it through onParityMismatch (dev/test → throw with the <fold-threw> marker, prod →
    // warn+return — the contract that keeps a fold-side reject from aborting a live accept).
    const now = new Date();
    await db.insert(event).values({
      id: 'gen_edge_xy',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'edge_xy',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'ke_x',
        to_knowledge_id: 'ke_y',
        relation_type: 'prerequisite',
        weight: 1,
        reasoning: 'r',
        propose_event_id: 'pe_edge_xy',
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
    await expect(assertKnowledgeEdgeParity(db, 'edge_xy', null)).rejects.toThrow(/fold-threw/i);
  });
});
