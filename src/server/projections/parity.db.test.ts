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
import {
  event,
  goal,
  knowledge,
  knowledge_edge,
  learning_item,
  materialized_id_index,
  mistake_variant,
} from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backfillGoalGenesis,
  backfillLearningItemGenesis,
  backfillMistakeVariantGenesis,
} from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  assertGoalParity,
  assertKnowledgeEdgeParity,
  assertKnowledgeNodeParity,
  assertLearningItemParity,
  assertMistakeVariantParity,
  goalLiveRowToSnapshot,
  hasKnowledgeNodeGenesisAnchor,
  knowledgeEdgesWithGenesisAnchor,
  knowledgeNodesWithGenesisAnchor,
  learningItemLiveRowToSnapshot,
  mistakeVariantLiveRowToSnapshot,
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

// ── YUK-548 (slice 5): OFF-entity prod-warn contract ─────────────────────────────────────────────
//
// onParityMismatch's PROD path (NODE_ENV==='production' → console.warn + return, NEVER throw —
// parity.ts:70-90) was covered for knowledge/edge but not the W2 trio. These three mirror it: seed an
// event-sourced row, feed a DIVERGENT live snapshot, and assert exactly one console.warn + no throw in
// production (a live accept must never be broken over a fold/parity divergence).
describe('assertXParity — OFF-entity prod-warn contract (goal / mistake_variant / learning_item)', () => {
  const PW_T0 = new Date('2026-06-01T00:00:00.000Z');
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    vi.stubEnv('NODE_ENV', 'production');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('assertGoalParity: prod warns ONCE + does NOT throw when the live goal diverges from fold(events)', async () => {
    const db = testDb();
    await db.insert(goal).values({
      id: 'g1',
      title: 'Original',
      subject_id: null,
      scope_knowledge_ids: ['k_a'],
      sequence_hint: 0,
      status: 'active',
      source: 'manual',
      source_ref: null,
      created_at: PW_T0,
      updated_at: PW_T0,
      version: 0,
    });
    await backfillGoalGenesis(db, PW_T0); // event-sourced → fold != the divergent snapshot below
    const [live] = await db.select().from(goal).where(eq(goal.id, 'g1'));
    if (!live) throw new Error('seed missing');
    const divergent = { ...goalLiveRowToSnapshot(live), title: 'DIVERGED' };

    await expect(assertGoalParity(db, 'g1', divergent)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('[projection-parity]');
  });

  it('assertMistakeVariantParity: prod warns ONCE + does NOT throw on divergence', async () => {
    const db = testDb();
    await db.insert(mistake_variant).values({
      id: 'mv1',
      parent_question_id: 'q_parent',
      variant_question_id: null,
      proposal_event_id: null,
      status: 'draft',
      failure_reasons: [],
      cause_category: 'concept_confusion',
      created_at: PW_T0,
      updated_at: PW_T0,
    });
    await backfillMistakeVariantGenesis(db, PW_T0);
    const [live] = await db.select().from(mistake_variant).where(eq(mistake_variant.id, 'mv1'));
    if (!live) throw new Error('seed missing');
    const divergent = {
      ...mistakeVariantLiveRowToSnapshot(live),
      cause_category: 'careless_error',
    };

    await expect(assertMistakeVariantParity(db, 'mv1', divergent)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('[projection-parity]');
  });

  it('assertLearningItemParity: prod warns ONCE + does NOT throw on divergence', async () => {
    const db = testDb();
    await db.insert(learning_item).values({
      id: 'li1',
      source: 'learning_intent',
      source_ref: null,
      title: 'Original',
      content: 'content',
      knowledge_ids: ['k_a'],
      primary_artifact_id: null,
      parent_learning_item_id: null,
      status: 'pending',
      user_pinned: false,
      completed_at: null,
      dismissed_at: null,
      archived_at: null,
      archived_reason: null,
      created_at: PW_T0,
      updated_at: PW_T0,
      version: 0,
    });
    await backfillLearningItemGenesis(db, PW_T0);
    const [live] = await db.select().from(learning_item).where(eq(learning_item.id, 'li1'));
    if (!live) throw new Error('seed missing');
    const divergent = { ...learningItemLiveRowToSnapshot(live), title: 'DIVERGED' };

    await expect(assertLearningItemParity(db, 'li1', divergent)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('[projection-parity]');
  });
});

// ── YUK-548 (independent review K1): knowledgeEdgesWithGenesisAnchor — action filter is load-bearing ─
//
// The edge anchor gate must count ONLY events the edge fold can seed a row from (`generate` /
// `experimental:genesis` — KNOWLEDGE_EDGE_ANCHOR_ACTIONS, mirroring edgesWithOriginatingEvent). The
// K1 regression: `proposeKnowledgeEdgeArchive` writes a `propose` event keyed on the REAL edge_id, so
// an un-anchored legacy edge with ONLY that propose event must NOT count as anchored — otherwise the
// Q4a sweep skips the applicability gate, folds it to null, and reports a FALSE MISSING (plus a
// permanent false forensic breadcrumb). This helper previously had zero direct coverage.
describe('knowledgeEdgesWithGenesisAnchor (K1) — anchor-action filter', () => {
  const KE_T0 = new Date('2026-06-01T00:00:00.000Z');

  beforeEach(async () => {
    await resetDb();
  });

  // relation_type must vary per edge — knowledge_edge_unique constrains (from, to, relation_type)
  // and every test edge shares the same endpoint pair. Irrelevant to the anchor query under test.
  async function insertEdge(id: string, relationType: string): Promise<void> {
    const db = testDb();
    await db.insert(knowledge_edge).values({
      id,
      from_knowledge_id: 'kn_from',
      to_knowledge_id: 'kn_to',
      relation_type: relationType,
      weight: 1,
      created_by: { by: 'user' },
      reasoning: null,
      created_at: KE_T0,
      archived_at: null,
    });
  }

  async function insertEdgeEvent(edgeId: string, action: string): Promise<void> {
    const db = testDb();
    await db.insert(event).values({
      id: `ev_${action.replace(/[^a-z_]/gi, '_')}_${edgeId}`,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'test',
      action,
      subject_kind: 'knowledge_edge',
      subject_id: edgeId,
      outcome: 'partial',
      payload: {},
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: KE_T0,
    });
  }

  it('an edge whose ONLY event is a `propose` (edge-archive proposal on the real edge_id) is NOT anchored', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_from' });
    await insertKnowledge({ id: 'kn_to' });
    await insertEdge('ke_propose_only', 'related_to');
    // The K1 trigger: proposeKnowledgeEdgeArchive writes action='propose' keyed on the edge id.
    await insertEdgeEvent('ke_propose_only', 'propose');

    const anchored = await knowledgeEdgesWithGenesisAnchor(db, ['ke_propose_only']);
    // fold-blind (the edge fold only seeds from generate/genesis) → must be SKIPPED, not anchored.
    expect(anchored.has('ke_propose_only')).toBe(false);
  });

  it('a `generate` event anchors; an `experimental:genesis` seed anchors; an index anchor anchors; event-less does not', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_from' });
    await insertKnowledge({ id: 'kn_to' });
    await insertEdge('ke_generate', 'related_to');
    await insertEdge('ke_genesis', 'contrasts_with');
    await insertEdge('ke_indexed', 'applied_in');
    await insertEdge('ke_eventless', 'derived_from');
    await insertEdgeEvent('ke_generate', 'generate');
    await insertEdgeEvent('ke_genesis', 'experimental:genesis');
    await db.insert(materialized_id_index).values({
      materialized_id: 'ke_indexed',
      anchor_event_id: 'ev_anchor_ke_indexed',
      subject_kind: 'knowledge_edge',
    });

    const anchored = await knowledgeEdgesWithGenesisAnchor(db, [
      'ke_generate',
      'ke_genesis',
      'ke_indexed',
      'ke_eventless',
    ]);
    expect(anchored.has('ke_generate')).toBe(true);
    expect(anchored.has('ke_genesis')).toBe(true);
    expect(anchored.has('ke_indexed')).toBe(true);
    expect(anchored.has('ke_eventless')).toBe(false);
  });
});
