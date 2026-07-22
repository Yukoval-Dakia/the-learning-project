// YUK-546 (part 2) — propose-side lock discipline on the edge-proposal ACCEPT path.
//
// The merge ACCEPT (acceptProposal) locks the mutation's knowledge rows FOR UPDATE (id-sorted,
// lockMutationRows) then rewireKnowledgeEdges takes a sorted `knowledge_edge:<id>` advisory. The
// edge-proposal ACCEPT path (decideKnowledgeEdgeProposal → create/reverse/change_type) is the OTHER
// live-edge writer. It now (1) locks its endpoint knowledge rows FOR UPDATE NOWAIT + retries, then
// (2) takes the same-namespace sorted advisory, then (3) reads the live mesh through the fold. This
// suite pins:
//   1. concurrent accepts of A->B and B->A: the reverse is rejected by the ADR-0034 topology gate
//      once the forward edge is committed (no 2-cycle);
//   2. an accept serializes cleanly behind a holder that owns only the advisory;
//   3. lock-then-revalidate: a merge that archives an endpoint under the locks makes the accept
//      reject (codex P2 TOCTOU) — no live edge lands on the archived node;
//   4. NOWAIT keeps the accept deadlock-free against the three-endpoint merge scenario codex P1
//      (round-3) described: merge holds {from,into}, rewrites an edge into->Z and FK-locks the
//      external endpoint Z that is NOT in the merge's row batch.
//
// NOWAIT means the accept never BLOCKS on a contended endpoint row — it fails fast (55P03) and the
// outer loop retries — so most cases synchronize by "hold the lock, fire the accept, release, await
// the accept" rather than by polling for a blocked session. Each holder tx resolves `lockAcquired`
// only after it owns its lock(s), and the accept is fired strictly after awaiting that. Self-isolated
// fixtures (own knowledge ids, own reset) so this never shares a mutable count with the propose_edge
// cost-ledger concurrency flake (YUK-724).

import { createKnowledgeEdge } from '@/capabilities/knowledge/server/edges';
import { newId } from '@/core/ids';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { decideKnowledgeEdgeProposal } from '@/server/proposals/actions';
import { eq, inArray, isNull, sql } from 'drizzle-orm';
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

// YUK-737 — a SUPERSEDE propose event (edge_op='supersede' + judged metadata). The supersede accept
// branch reads all of this off the propose payload, so seeding the event lets us drive the branch
// through decideKnowledgeEdgeProposal directly (no proposal-inbox row needed, same as
// seedProposeEdgeEvent above).
async function seedSupersedeProposeEvent(opts: {
  newFrom: string;
  newTo: string;
  supersededEdgeId: string;
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
      edge_op: 'supersede',
      from_knowledge_id: opts.newFrom,
      to_knowledge_id: opts.newTo,
      relation_type: opts.relation_type ?? 'prerequisite',
      weight: 1,
      reasoning: 'reconcile supersede candidate',
      archive_edge_id: opts.supersededEdgeId,
      supersede_confidence: 0.9,
      supersede_neighbor_index: 0,
      supersede_affected_refs: [{ kind: 'question', id: `q_supersede_${id}` }],
    },
    caused_by_event_id: null,
    created_at: new Date(),
  });
  return id;
}

// A resolve-on-demand promise. The holder tx resolves `lockAcquired` after it owns its lock(s); the
// main flow awaits that before firing the accept, and `release` lets the holder commit on demand.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Poll pg_stat_activity until another backend blocks waiting on a lock. Only usable when the accept
// is expected to BLOCK — i.e. behind a holder that owns the advisory (the accept's advisory acquire
// is a plain blocking wait); it is NOT usable behind a row-lock holder, since the NOWAIT row lock
// fails fast instead of blocking.
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
  throw new Error('timed out waiting for a database session to block on a lock');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('decideKnowledgeEdgeProposal — YUK-546 lock discipline', () => {
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

  it('A->B / B->A: the reverse accept is rejected by the topology gate once the forward edge commits (no 2-cycle)', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    // A->B is created + committed by the holder tx first; B->A is the accept under test. NOTE: A->B
    // and B->A are DISTINCT unique keys, so the UNIQUE(from,to,type) constraint does NOT catch this —
    // only the topology gate (fold) does, once it sees the committed A->B.
    const proposeBA = await seedProposeEdgeEvent({ from: 'B', to: 'A' });

    const lockAcquired = deferred();
    const release = deferred();
    const holderDone = db.transaction(async (tx) => {
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
      lockAcquired.resolve();
      await release.promise;
    });

    await lockAcquired.promise;
    // The accept's NOWAIT endpoint lock contends with the holder's FK KEY SHARE (from
    // createKnowledgeEdge) and the advisory, so it retries until the holder commits — at which point
    // A->B is visible and the fold rejects the reverse. Release the holder right after firing.
    const acceptBA = decideKnowledgeEdgeProposal(db, proposeBA, { decision: 'accept' });
    release.resolve();

    await expect(acceptBA).rejects.toThrow(/topology|cycle|direction|prerequisite/i);
    await holderDone;

    const live = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
    expect(live).toHaveLength(1);
    expect(live[0].from_knowledge_id).toBe('A');
    expect(live[0].to_knowledge_id).toBe('B');

    const rateRows = await db.select().from(event).where(eq(event.caused_by_event_id, proposeBA));
    expect(rateRows).toHaveLength(0);
  });

  it('serializes cleanly behind a holder that owns only the advisory; no deadlock', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    // related_to skips the topology gate, so this isolates advisory serialization: the accept's
    // NOWAIT rows succeed (holder owns no rows), then it BLOCKS on the advisory; after release it
    // must simply COMPLETE.
    const proposeBA = await seedProposeEdgeEvent({
      from: 'B',
      to: 'A',
      relation_type: 'related_to',
    });

    const lockAcquired = deferred();
    const release = deferred();
    const holdAdvisory = db.transaction(async (tx) => {
      await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', ['A', 'B']);
      lockAcquired.resolve();
      await release.promise;
    });

    await lockAcquired.promise;
    const acceptBA = decideKnowledgeEdgeProposal(db, proposeBA, { decision: 'accept' });

    await waitForBlockedDatabaseSession();
    release.resolve();
    await holdAdvisory;

    const result = await acceptBA;
    expect(result.edge_id).toBeTruthy();

    const live = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
    expect(live).toHaveLength(1);
    expect(live[0].relation_type).toBe('related_to');
    expect(live[0].from_knowledge_id).toBe('B');
    expect(live[0].to_knowledge_id).toBe('A');
  });

  it('lock-then-revalidate: a merge that archives an endpoint under the locks makes the accept reject; zero live edge lands (codex P2 TOCTOU)', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    const proposeAB = await seedProposeEdgeEvent({ from: 'A', to: 'B' });

    // Full merge accept order: knowledge rows FOR UPDATE (id-sorted) -> advisory -> archive an
    // endpoint. The accept's PRE-lock check runs against the still-committed (live) A (the archive is
    // uncommitted while the holder holds), so it passes; the accept then NOWAIT-retries behind the
    // held rows. Without lock-then-revalidate it would, after the holder commits, land a live A->B
    // edge pointing at the just-archived A (FK holds on the tombstone).
    const lockAcquired = deferred();
    const release = deferred();
    const mergeHold = db.transaction(async (tx) => {
      await tx
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(inArray(knowledge.id, ['A', 'B']))
        .orderBy(knowledge.id)
        .for('update');
      await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', ['A', 'B']);
      await tx.update(knowledge).set({ archived_at: new Date() }).where(eq(knowledge.id, 'A'));
      lockAcquired.resolve();
      await release.promise;
    });

    await lockAcquired.promise;
    const acceptAB = decideKnowledgeEdgeProposal(db, proposeAB, { decision: 'accept' });
    release.resolve();

    // Accept retries until the merge commits, then re-reads endpoints under its own locks, sees A
    // archived, and rejects (the endpoint revalidation, not the topology gate).
    await expect(acceptAB).rejects.toThrow(/archived|unknown|not.?found/i);
    await mergeHold;

    // No edge landed at all — the accept tx rolled back its rate/generate events and any insert.
    const all = await db.select().from(knowledge_edge);
    expect(all).toHaveLength(0);
  });

  it('three-endpoint scenario: NOWAIT keeps the accept deadlock-free when a merge rewrites into->Z (codex P1 round-3)', async () => {
    const db = testDb();
    // ids chosen so the accept's remote endpoint (m_0) sorts BEFORE the merge target (m_b): the
    // accept locks m_0 first, then contends on m_b (held by the merge). m_a is the merge's
    // from-node; m_b is the into-node. The merge's row batch {m_a, m_b} does NOT include m_0.
    await seedKnowledge(['m_0', 'm_a', 'm_b']);
    const proposeBZ = await seedProposeEdgeEvent({ from: 'm_b', to: 'm_0' });

    // merge-sim: hold {m_a, m_b} FOR UPDATE (lockMutationRows order), then — on release — INSERT the
    // rewritten edge m_b -> m_0 (rewireKnowledgeEdges' createKnowledgeEdge(into -> Z), FK-locking
    // the external m_0), then commit. Pre-fix (blocking FOR UPDATE) the accept would hold m_0 and
    // wait on m_b while the merge holds m_b and waits on m_0 = 40P01. NOWAIT breaks the cycle: the
    // accept fails fast on m_b, releases m_0, and retries, so the merge's insert proceeds.
    const lockAcquired = deferred();
    const release = deferred();
    const mergeSim = db.transaction(async (tx) => {
      await tx
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(inArray(knowledge.id, ['m_a', 'm_b']))
        .orderBy(knowledge.id)
        .for('update');
      lockAcquired.resolve();
      await release.promise;
      await createKnowledgeEdge(tx, {
        from_knowledge_id: 'm_b',
        to_knowledge_id: 'm_0',
        relation_type: 'prerequisite',
        weight: 1,
        actor_kind: 'user',
        actor_ref: 'self',
        created_at: new Date(),
      });
    });

    await lockAcquired.promise;
    const acceptBZ = decideKnowledgeEdgeProposal(db, proposeBZ, { decision: 'accept' });
    // Attach the settled handler NOW: the accept may exhaust its NOWAIT retries and reject during the
    // sleep below, and without a handler already attached that would surface as an unhandled
    // rejection. allSettled registers handlers on both promises synchronously here.
    const settledP = Promise.allSettled([mergeSim, acceptBZ]);

    // Give the accept time to attempt (pre-fix: lock m_0 + block on m_b; post-fix: NOWAIT-fail +
    // retry, having released m_0) BEFORE the merge inserts m_b -> m_0. Time-assisted because a
    // NOWAIT accept never blocks, so there is no lock-wait to synchronize on.
    await sleep(250);
    release.resolve();

    const settled = await settledP;
    for (const r of settled) {
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        expect(msg).not.toMatch(/deadlock|40P01/i);
      }
    }

    // Exactly one live m_b -> m_0 edge — whichever writer won, the relationship exists once and no
    // cycle / dangling edge remains.
    const live = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
    expect(live).toHaveLength(1);
    expect(live[0].from_knowledge_id).toBe('m_b');
    expect(live[0].to_knowledge_id).toBe('m_0');
  }, 20000);

  // YUK-737 — the SUPERSEDE accept branch creates a live replacement edge. Before this it had NO
  // accept-time topology gate, so a replacement that closes a prerequisite cycle would land. These
  // two pin the new gate (cycle rejected) + a legal regression (a non-cyclic replacement applies).
  it('supersede accept: a replacement that reverses a live prerequisite is rejected by the topology gate; nothing lands', async () => {
    const db = testDb();
    await seedKnowledge(['sc_a', 'sc_b', 'sc_c']);
    // Live backbone: sc_a -> sc_b. Old edge sc_b -> sc_c is the supersede target.
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'sc_a',
      to_knowledge_id: 'sc_b',
      relation_type: 'prerequisite',
      weight: 1,
      actor_kind: 'user',
      actor_ref: 'self',
      created_at: new Date(),
    });
    const oldEdgeId = await createKnowledgeEdge(db, {
      from_knowledge_id: 'sc_b',
      to_knowledge_id: 'sc_c',
      relation_type: 'prerequisite',
      weight: 1,
      actor_kind: 'user',
      actor_ref: 'self',
      created_at: new Date(),
    });
    // Replacement candidate sc_b -> sc_a: touches the old edge (shared sc_b), not a duplicate. Once
    // sc_b -> sc_c is archived and sc_b -> sc_a created, sc_b -> sc_a reverses the live sc_a -> sc_b.
    const proposeId = await seedSupersedeProposeEvent({
      newFrom: 'sc_b',
      newTo: 'sc_a',
      supersededEdgeId: oldEdgeId,
    });

    await expect(
      decideKnowledgeEdgeProposal(db, proposeId, { decision: 'accept' }),
    ).rejects.toThrow(/cycle|direction|topology|prerequisite/i);

    // The supersede rolled back: the old edge stays LIVE, no replacement landed, no cycle exists.
    const live = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
    const keys = live.map((e) => `${e.from_knowledge_id}->${e.to_knowledge_id}`).sort();
    expect(keys).toEqual(['sc_a->sc_b', 'sc_b->sc_c']);
    // No rate / generate events chained off the propose (whole tx rolled back).
    const chained = await db.select().from(event).where(eq(event.caused_by_event_id, proposeId));
    expect(chained).toHaveLength(0);
  });

  it('supersede accept: a legal (non-cyclic) replacement applies — old edge archived, new edge live', async () => {
    const db = testDb();
    await seedKnowledge(['sl_a', 'sl_b', 'sl_c', 'sl_d']);
    await createKnowledgeEdge(db, {
      from_knowledge_id: 'sl_a',
      to_knowledge_id: 'sl_b',
      relation_type: 'prerequisite',
      weight: 1,
      actor_kind: 'user',
      actor_ref: 'self',
      created_at: new Date(),
    });
    const oldEdgeId = await createKnowledgeEdge(db, {
      from_knowledge_id: 'sl_b',
      to_knowledge_id: 'sl_c',
      relation_type: 'prerequisite',
      weight: 1,
      actor_kind: 'user',
      actor_ref: 'self',
      created_at: new Date(),
    });
    // Replacement sl_b -> sl_d: touches old (sl_b), not a duplicate, no cycle.
    const proposeId = await seedSupersedeProposeEvent({
      newFrom: 'sl_b',
      newTo: 'sl_d',
      supersededEdgeId: oldEdgeId,
    });

    const result = await decideKnowledgeEdgeProposal(db, proposeId, { decision: 'accept' });
    expect(result.edge_id).toBeTruthy();

    const live = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
    const keys = live.map((e) => `${e.from_knowledge_id}->${e.to_knowledge_id}`).sort();
    expect(keys).toEqual(['sl_a->sl_b', 'sl_b->sl_d']);
  });
});
