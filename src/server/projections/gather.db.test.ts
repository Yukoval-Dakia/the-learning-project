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

import { newId } from '@/core/ids';
import type {
  KnowledgeEdgeRowSnapshotT,
  LearningItemRowSnapshotT,
} from '@/core/schema/event/genesis';
import type { Db } from '@/db/client';
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
  gatherAndFoldKnowledgeNode,
  gatherAndFoldLearningItem,
  prefetchKnowledgeMergeEvents,
  prefetchKnowledgeRates,
  prefetchLearningItemMergeEvents,
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

  it('a FOREIGN multi-hop prerequisite chain in the mesh drives the verdict (non-degenerate: not a self-edge short-circuit)', async () => {
    const db = testDb();
    await insertNode('kn_p');
    await insertNode('kn_q');
    await insertNode('kn_r');
    // Two FOREIGN live prerequisites forming a chain p → q → r. Neither is the candidate, so the
    // verdict is driven by REAL mesh content (the chain), not the candidate's own self-edge — this
    // is the non-degenerate case the self-edge tests above could not exercise.
    await insertEdge({ id: 'ke_pq', from: 'kn_p', to: 'kn_q', relation_type: 'prerequisite' });
    await insertEdge({ id: 'ke_qr', from: 'kn_q', to: 'kn_r', relation_type: 'prerequisite' });
    // Candidate generate-create prerequisite r → p — closes the transitive cycle p → q → r → p.
    await seedGenerateCreateEvent({
      id: 'ev_cycle_rp',
      edgeId: 'ke_rp',
      from: 'kn_r',
      to: 'kn_p',
      relation_type: 'prerequisite',
      created_at: T1,
    });

    const mesh = await liveMesh(); // holds the foreign chain p → q, q → r

    // The cycle exists ONLY because the mesh carries BOTH foreign edges (p → q AND q → r): folding
    // r → p must transitively reach r. The injected-mesh and self-fetching paths reject identically.
    await expect(gatherAndFoldKnowledgeEdgeWithMesh(db, 'ke_rp', mesh)).rejects.toThrow(
      /topology reject/i,
    );
    await expect(gatherAndFoldKnowledgeEdge(db, 'ke_rp')).rejects.toThrow(/topology reject/i);
    // Empty mesh: no chain → no cycle → the create projects a row. Proves the foreign chain, carried
    // identically by both mesh-construction paths, is what drives the reject (mesh is not inert).
    const projected = await gatherAndFoldKnowledgeEdgeWithMesh(db, 'ke_rp', []);
    expect(projected?.from_knowledge_id).toBe('kn_r');
    expect(projected?.to_knowledge_id).toBe('kn_p');
  });
});

// ── YUK-547: learning_item merge-event prefetch threading ─────────────────────────────────────
//
// gatherAndFoldLearningItem's Q3 leg (every knowledge_merge propose event + the accept rates
// chained to them) is item-INDEPENDENT, so a full-table audit re-ran the two full-table SELECTs
// per item (O(N × full table)). prefetchLearningItemMergeEvents fetches them ONCE and threads them
// into each fold. These tests prove the threading is (1) EQUIVALENT to the self-fetching path and
// (2) actually eliminates the per-item full-table SELECTs (the named perf hotspot).

const LI_T0 = new Date('2026-06-01T00:00:00.000Z');

function liGenesisSnapshot(id: string, knowledgeIds: string[]): LearningItemRowSnapshotT {
  return {
    id,
    source: 'learning_intent',
    source_ref: null,
    title: `Item ${id}`,
    content: 'content',
    knowledge_ids: knowledgeIds,
    primary_artifact_id: null,
    parent_learning_item_id: null,
    status: 'pending',
    user_pinned: false,
    completed_at: null,
    dismissed_at: null,
    archived_at: null,
    archived_reason: null,
    created_at: LI_T0,
    updated_at: LI_T0,
    version: 0,
  };
}

async function seedLearningItemGenesis(id: string, knowledgeIds: string[]): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id: newId(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      action: 'experimental:genesis',
      subject_kind: 'learning_item',
      subject_id: id,
      outcome: 'success',
      payload: { row: liGenesisSnapshot(id, knowledgeIds) },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: LI_T0,
    });
}

// Seed an ACCEPTED knowledge_merge (propose event on the survivor + accept rate chained to it).
async function seedAcceptedMerge(fromIds: string[], intoId: string): Promise<void> {
  const db = testDb();
  const proposeId = newId();
  await db.insert(event).values({
    id: proposeId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'experimental:knowledge_merge',
    subject_kind: 'knowledge',
    subject_id: intoId,
    outcome: 'partial',
    payload: { from_ids: fromIds, into_id: intoId },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(LI_T0.getTime() + 1000),
  });
  await db.insert(event).values({
    id: newId(),
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposeId,
    outcome: 'success',
    payload: { rating: 'accept' },
    caused_by_event_id: proposeId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(LI_T0.getTime() + 2000),
  });
}

// Count-instrumenting Proxy over a drizzle db: increments `counter.n` per `.select()` call. Only
// `.select()` is intercepted; `.from()/.where()` run on the real (un-proxied) builder the real
// select returns, so query behavior is unchanged — the counter just distinguishes prefetched
// (N q1 SELECTs) from self-fetching (N × [q1 + merges + rates]).
function countingDb(base: Db, counter: { n: number }): Db {
  return new Proxy(base as object, {
    get(target, prop, receiver) {
      if (prop === 'select') {
        return (...args: unknown[]) => {
          counter.n += 1;
          return (target as { select: (...a: unknown[]) => unknown }).select(...args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Db;
}

describe('gatherAndFoldLearningItem — YUK-547 merge-event prefetch threading', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('threading a prefetched merge set folds IDENTICALLY to the self-fetching path (across items + a rewrite)', async () => {
    const db = testDb();
    // li_a's KC k_a is absorbed by an accepted merge into k_c → its fold rewrites knowledge_ids.
    // li_b's KC k_x is untouched → its fold is a no-op merge. Both must agree self-fetch vs prefetch.
    await seedLearningItemGenesis('li_a', ['k_a']);
    await seedLearningItemGenesis('li_b', ['k_x']);
    await seedAcceptedMerge(['k_a'], 'k_c');

    const prefetched = await prefetchLearningItemMergeEvents(db);
    // the prefetch carries the merge propose event + its accept rate (2 rows).
    expect(prefetched).toHaveLength(2);

    for (const id of ['li_a', 'li_b']) {
      const selfFetch = await gatherAndFoldLearningItem(db, id);
      const threaded = await gatherAndFoldLearningItem(db, id, prefetched);
      expect(threaded).toEqual(selfFetch);
    }
    // sanity: the merge actually rewrote li_a's knowledge_ids (non-trivial fold).
    expect((await gatherAndFoldLearningItem(db, 'li_a', prefetched))?.knowledge_ids).toEqual([
      'k_c',
    ]);
    expect((await gatherAndFoldLearningItem(db, 'li_b', prefetched))?.knowledge_ids).toEqual([
      'k_x',
    ]);
  });

  it('perf smoke: threading eliminates the per-item full-table merge SELECTs (1 prefetch, not N)', async () => {
    const db = testDb();
    const itemIds = ['li_1', 'li_2', 'li_3'];
    for (const id of itemIds) await seedLearningItemGenesis(id, ['k_a']);
    await seedAcceptedMerge(['k_a'], 'k_c');

    const counter = { n: 0 };
    const cdb = countingDb(db, counter);

    // Prefetch ONCE: the full-table merge SELECT + the chained-rate SELECT = exactly 2 selects.
    counter.n = 0;
    const prefetched = await prefetchLearningItemMergeEvents(cdb);
    expect(counter.n).toBe(2);

    // Folding N items WITH the prefetched set issues exactly ONE SELECT per item (the subject-keyed
    // q1) — zero per-item merge/rate re-fetches.
    counter.n = 0;
    for (const id of itemIds) await gatherAndFoldLearningItem(cdb, id, prefetched);
    expect(counter.n).toBe(itemIds.length);

    // Folding N items self-fetching re-runs q1 + merges + rates per item (3 × N) — the O(N × full
    // table) hotspot the prefetch removes.
    counter.n = 0;
    for (const id of itemIds) await gatherAndFoldLearningItem(cdb, id);
    expect(counter.n).toBe(itemIds.length * 3);
  });
});

// Seed a knowledge genesis event at a CONTROLLED created_at (T0). backfillKnowledgeGenesis stamps the
// genesis at real wall-clock time (only `ingest_at` takes the passed `now`), which would sort AFTER a
// T0-relative merge in the canonical replay and mask the archive — this keeps ordering deterministic.
async function seedKnowledgeGenesis(id: string): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id: newId(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'genesis-backfill',
      action: 'experimental:genesis',
      subject_kind: 'knowledge',
      subject_id: id,
      outcome: 'success',
      payload: {
        row: {
          id,
          name: id,
          domain: null,
          parent_id: null,
          merged_from: [],
          archived_at: null,
          proposed_by_ai: false,
          approval_status: 'approved',
          created_at: T0,
          updated_at: T0,
          version: 0,
        },
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: T0,
    });
}

// Seed an ACCEPTED knowledge_merge with the KNOWLEDGE fold's stricter payload (from_ids + into_id +
// expected_versions). The learning_item seedAcceptedMerge above omits expected_versions, which the node
// fold's KnowledgeMutationProposalChange parse REQUIRES — so the node fold would skip it as malformed.
async function seedKnowledgeMerge(fromIds: string[], intoId: string): Promise<void> {
  const db = testDb();
  const proposeId = newId();
  await db.insert(event).values({
    id: proposeId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'experimental:knowledge_merge',
    subject_kind: 'knowledge',
    subject_id: intoId,
    outcome: 'partial',
    payload: {
      from_ids: fromIds,
      into_id: intoId,
      expected_versions: Object.fromEntries([...fromIds, intoId].map((id) => [id, 0])),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(T0.getTime() + 1000),
  });
  await db.insert(event).values({
    id: newId(),
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposeId,
    outcome: 'success',
    payload: { rating: 'accept' },
    caused_by_event_id: proposeId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(T0.getTime() + 2000),
  });
}

// ── YUK-549 (K6): knowledge-node merge + rate prefetch threading ──────────────────────────────
//
// gatherAndFoldKnowledgeNode's Q3 leg (every knowledge_merge propose event, containment-filtered) and
// its rate-resolution leg (the accept rates chained to the gathered propose/merge events) are both
// node-INDEPENDENT full-table scans, so a full-table audit that folds N nodes re-ran them per node
// (O(N × full table)). prefetchKnowledgeMergeEvents / prefetchKnowledgeRates fetch each ONCE and thread
// them in; the two legs then filter in memory to the EXACT rows the per-node queries returned. These
// tests prove the threading is (1) EQUIVALENT to the self-fetching path and (2) eliminates the per-node
// full-table SELECTs. Mirrors the YUK-547 learning_item tests above.
describe('gatherAndFoldKnowledgeNode — YUK-549 (K6) merge + rate prefetch threading', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('threading prefetched merge + rate sets folds IDENTICALLY to the self-fetching path (across nodes + a merge)', async () => {
    const db = testDb();
    // k_a is absorbed into k_c by an accepted merge → the from-node's fold archives it (Q3 leg) and the
    // into-node's fold appends merged_from (rate leg gates the merge on acceptance). k_x is untouched.
    await seedKnowledgeGenesis('k_a');
    await seedKnowledgeGenesis('k_c');
    await seedKnowledgeGenesis('k_x');
    await seedKnowledgeMerge(['k_a'], 'k_c');

    const merges = await prefetchKnowledgeMergeEvents(db);
    const rates = await prefetchKnowledgeRates(db);
    // grouped structure (review round-1): merges keyed by ABSORBED node id, rates by caused_by id.
    expect(merges.get('k_a')).toHaveLength(1); // the one merge that archives k_a
    expect(merges.has('k_c')).toBe(false); // k_c is the into_id, never a from_id → not a merge key
    expect(rates.size).toBe(1); // the one accept rate, keyed by its merge-propose id

    // EQUIVALENCE (the round-1 fix's core assertion): the grouped-Map prefetch path folds
    // byte-identically to the per-node SQL query path — across the merged from-node, the merged-into
    // node, and an untouched node.
    for (const id of ['k_a', 'k_c', 'k_x']) {
      const selfFetch = await gatherAndFoldKnowledgeNode(db, id); // per-node containment + caused_by queries
      const threaded = await gatherAndFoldKnowledgeNode(db, id, merges, rates); // O(1) grouped lookups
      expect(threaded).toEqual(selfFetch);
    }
    // sanity: the merge is a NON-TRIVIAL fold — k_a archived (Q3), k_c carries merged_from (Q1+rate).
    expect(
      (await gatherAndFoldKnowledgeNode(db, 'k_a', merges, rates))?.archived_at,
    ).not.toBeNull();
    expect((await gatherAndFoldKnowledgeNode(db, 'k_c', merges, rates))?.merged_from).toContain(
      'k_a',
    );
  });

  it('perf smoke: threading eliminates the per-node full-table merge + rate SELECTs (2 prefetch, not per-node)', async () => {
    const db = testDb();
    const nodeIds = ['k_1', 'k_2', 'k_3'];
    for (const id of nodeIds) await seedKnowledgeGenesis(id);
    await seedKnowledgeMerge(['k_1'], 'k_2');

    const counter = { n: 0 };
    const cdb = countingDb(db, counter);

    // Prefetch ONCE: the full-table merge SELECT + the full-table rate SELECT = exactly 2 selects.
    counter.n = 0;
    const merges = await prefetchKnowledgeMergeEvents(cdb);
    const rates = await prefetchKnowledgeRates(cdb);
    expect(counter.n).toBe(2);

    // Delta-based (robust to the anchor-lookup select count): the self-fetching path adds EXACTLY the
    // per-node Q3 merge SELECT + rate SELECT (2 × N) that the prefetched path filters in memory instead.
    counter.n = 0;
    for (const id of nodeIds) await gatherAndFoldKnowledgeNode(cdb, id, merges, rates);
    const prefetchTotal = counter.n;
    counter.n = 0;
    for (const id of nodeIds) await gatherAndFoldKnowledgeNode(cdb, id);
    const selfFetchTotal = counter.n;
    expect(selfFetchTotal - prefetchTotal).toBe(nodeIds.length * 2);
  });
});
