// YUK-546 (part 2) — propose-side symmetric advisory lock on the edge-proposal ACCEPT path.
//
// rewireKnowledgeEdges (the merge-side edge rewrite) takes a sorted
// `pg_advisory_xact_lock(hashtext('knowledge_edge:<id>'))` on its two merge endpoints (YUK-543
// review L1). The edge-proposal ACCEPT path (decideKnowledgeEdgeProposal → the create/reverse/
// change_type branch) is the OTHER writer that reads the live mesh, passes the ADR-0034 topology
// gate (via the fold under PROJECTION_IS_WRITER=1), then writes a live edge — but it took no lock,
// leaving the "two READ COMMITTED txs each pass the gate then merge into a cycle" window open. This
// suite pins that the accept path now takes the SAME namespace + SAME sorted acquisition on its
// [from, to] endpoints, so:
//   1. concurrent accepts of A->B and B->A serialize under the lock and the second is rejected by
//      the topology gate (a 2-cycle can never both commit); and
//   2. a propose-accept and a (simulated) merge-side lock holder on overlapping endpoints do NOT
//      deadlock — both sort their ids, so they acquire the shared lock in one global order.
//
// Self-isolated fixtures (own knowledge ids, own reset) so this never shares a mutable count with
// the propose_edge cost-ledger concurrency flake (YUK-724).

import { createKnowledgeEdge } from '@/capabilities/knowledge/server/edges';
import { newId } from '@/core/ids';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { writeEvent } from '@/server/events/queries';
import { decideKnowledgeEdgeProposal } from '@/server/proposals/actions';
import { eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

const KNOWLEDGE_BASE = {
  domain: 'yuwen',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function seedKnowledge(ids: string[]): Promise<void> {
  const db = testDb();
  const now = new Date();
  for (const id of ids) {
    await db.insert(knowledge).values({
      id,
      name: id,
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...KNOWLEDGE_BASE,
    });
  }
}

async function seedProposeEdgeEvent(opts: {
  from: string;
  to: string;
  relation_type?: string;
}): Promise<string> {
  const db = testDb();
  const id = newId();
  await writeEvent(db, {
    id,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'propose',
    subject_kind: 'knowledge_edge',
    subject_id: `edge_proposed_${id}`,
    outcome: 'partial',
    payload: {
      from_knowledge_id: opts.from,
      to_knowledge_id: opts.to,
      relation_type: opts.relation_type ?? 'prerequisite',
      weight: 1,
      reasoning: 'AI thinks these are related',
    },
    caused_by_event_id: null,
    created_at: new Date(),
  });
  return id;
}

// Poll pg_stat_activity until SOME other backend of this database is blocked waiting on a lock —
// the deterministic barrier the merge-side lock tests use (proposals.db.test.ts). An
// advisory-lock wait surfaces as wait_event_type='Lock', so this fires once the second tx has
// blocked on the advisory lock the first tx holds.
async function waitForBlockedDatabaseSession(): Promise<void> {
  const db = testDb();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = (await db.execute(sql<{ blocked: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      ) AS blocked
    `)) as Array<{ blocked: boolean }>;
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for a database session to block on the advisory lock');
}

describe('decideKnowledgeEdgeProposal — YUK-546 symmetric advisory lock', () => {
  beforeEach(async () => {
    await resetDb();
    // Run the PRODUCTION path (PROJECTION_IS_WRITER=1): the accept path projects the new edge
    // through the fold, whose ADR-0034 topology reject THROWS and rolls back the accept. (Under
    // the OFF path the imperative INSERT commits first and only the parity assert re-folds — a
    // prod warn, not a rollback — so ON is the faithful prod behaviour to test.)
    vi.stubEnv('PROJECTION_IS_WRITER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serializes concurrent A->B / B->A accepts; the second is rejected by the topology gate (no 2-cycle)', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    // B->A is the proposal under test. A->B is created by the tx that holds the lock first, so
    // when B->A finally acquires the lock its fold sees A->B and the reverse edge is a direction
    // contradiction. NOTE: A->B and B->A are DISTINCT unique keys, so the UNIQUE(from,to,type)
    // constraint does NOT catch this — only lock-serialization + the topology gate does.
    const proposeBA = await seedProposeEdgeEvent({ from: 'B', to: 'A' });

    // tx1 stands in for the winning writer: it grabs the sorted [A,B] locks, commits a live A->B
    // edge, and holds the tx open on a barrier so the accept below blocks on the SAME lock.
    let releaseTx1: () => void = () => {};
    const tx1Barrier = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });
    const tx1Done = db.transaction(async (tx) => {
      await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', ['A', 'B']);
      await createKnowledgeEdge(tx, {
        from_knowledge_id: 'A',
        to_knowledge_id: 'B',
        relation_type: 'prerequisite',
        weight: 1,
        actor_kind: 'user',
        actor_ref: 'self',
        created_at: new Date(),
      });
      await tx1Barrier;
    });

    // Fire the real accept (B->A). It blocks acquiring 'knowledge_edge:A' (held by tx1).
    const acceptBA = decideKnowledgeEdgeProposal(db, proposeBA, { decision: 'accept' });

    await waitForBlockedDatabaseSession();
    releaseTx1();
    await tx1Done;

    // Now unblocked, B->A's fold sees the committed A->B and the ADR-0034 gate rejects the reverse.
    await expect(acceptBA).rejects.toThrow(/topology|cycle|direction|prerequisite/i);

    // Exactly one live edge (A->B) — the cycle never formed.
    const live = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
    expect(live).toHaveLength(1);
    expect(live[0].from_knowledge_id).toBe('A');
    expect(live[0].to_knowledge_id).toBe('B');

    // The rejected accept left no rate/generate events behind (tx rolled back).
    const rateRows = await db.select().from(event).where(eq(event.caused_by_event_id, proposeBA));
    expect(rateRows).toHaveLength(0);
  });

  it('propose-accept vs a merge-side lock holder on overlapping endpoints does not deadlock (sorted order)', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    // related_to skips the topology gate, so this isolates the deadlock-freedom property: after the
    // held lock releases the accept must simply COMPLETE, never fail with a 40P01 deadlock.
    const proposeBA = await seedProposeEdgeEvent({
      from: 'B',
      to: 'A',
      relation_type: 'related_to',
    });

    // Stand in for rewireKnowledgeEdges holding its merge-endpoint lock mid-tx: the merge side
    // acquires [from, into] through the SAME acquireSortedAdvisoryLocks('knowledge_edge', ...).
    // Input order here is [A, B]; the accept below passes [B, A] (reversed) — an UNSORTED impl
    // would grab ':B' first and risk an A<->B deadlock. The shared sort prevents it.
    let releaseMerge: () => void = () => {};
    const mergeBarrier = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    const mergeHold = db.transaction(async (tx) => {
      await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', ['A', 'B']);
      await mergeBarrier;
    });

    const acceptBA = decideKnowledgeEdgeProposal(db, proposeBA, { decision: 'accept' });

    // The accept blocks on 'knowledge_edge:A' (sorted-first), NOT on ':B' — proving both sides
    // acquire in the same global order.
    await waitForBlockedDatabaseSession();
    releaseMerge();
    await mergeHold;

    // Completes cleanly once the lock frees; a deadlock would have rejected this promise (40P01).
    const result = await acceptBA;
    expect(result.edge_id).toBeTruthy();

    const live = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
    expect(live).toHaveLength(1);
    expect(live[0].relation_type).toBe('related_to');
    expect(live[0].from_knowledge_id).toBe('B');
    expect(live[0].to_knowledge_id).toBe('A');
  });

  it('lock-then-revalidate: a merge that archives an endpoint under the lock makes the accept reject; zero live edge lands (codex P2 TOCTOU)', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    const proposeAB = await seedProposeEdgeEvent({ from: 'A', to: 'B' });

    // Stand in for rewireKnowledgeEdges: hold knowledge_edge:{A,B} and archive endpoint A mid-tx
    // (the merge side flips absorbed from_ids' archived_at under this exact lock), then commit on
    // release. The accept's PRE-lock endpoint check runs against the still-committed (live) A —
    // A's archive is uncommitted while the barrier holds — so it passes; the accept then blocks on
    // the lock. Without lock-then-revalidate the accept would resume and land a live A->B edge
    // pointing at the just-archived A (FK holds on the tombstone).
    let releaseMerge: () => void = () => {};
    const mergeBarrier = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    const mergeHold = db.transaction(async (tx) => {
      await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', ['A', 'B']);
      await tx.update(knowledge).set({ archived_at: new Date() }).where(eq(knowledge.id, 'A'));
      await mergeBarrier;
    });

    const acceptAB = decideKnowledgeEdgeProposal(db, proposeAB, { decision: 'accept' });

    await waitForBlockedDatabaseSession();
    releaseMerge();
    await mergeHold;

    // Accept re-reads endpoints UNDER the lock, sees A now archived, and rejects (the endpoint
    // revalidation, not the topology gate).
    await expect(acceptAB).rejects.toThrow(/archived|unknown|not.?found/i);

    // No edge landed at all — the accept tx rolled back its rate/generate events and any insert.
    const all = await db.select().from(knowledge_edge);
    expect(all).toHaveLength(0);
  });
});
