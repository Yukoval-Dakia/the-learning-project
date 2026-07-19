// YUK-546 (part 2) — propose-side lock discipline on the edge-proposal ACCEPT path.
//
// rewireKnowledgeEdges (the merge-side edge rewrite) takes a sorted
// `pg_advisory_xact_lock(hashtext('knowledge_edge:<id>'))` on its two merge endpoints (YUK-543
// review L1), and the merge ACCEPT (acceptProposal) first takes the mutation's knowledge rows FOR
// UPDATE (id-sorted, lockMutationRows) BEFORE that advisory. The edge-proposal ACCEPT path
// (decideKnowledgeEdgeProposal → create/reverse/change_type) is the OTHER writer that reads the live
// mesh, passes the ADR-0034 topology gate (via the fold under PROJECTION_IS_WRITER=1), then writes a
// live edge. This suite pins the lock discipline that keeps it consistent with the merge path:
//   1. concurrent accepts of A->B and B->A serialize and the second is rejected by the topology gate
//      (a 2-cycle can never both commit);
//   2. an accept serializes cleanly behind a holder that owns only the advisory;
//   3. lock-then-revalidate: a merge that archives an endpoint under the lock makes the accept reject
//      (codex P2 TOCTOU) — no live edge lands on the archived node;
//   4. the accept takes endpoint rows FOR UPDATE BEFORE the advisory (same global order as the merge
//      accept), so a merge-ordered holder (row FOR UPDATE -> advisory) never 40P01-deadlocks it
//      (codex P1).
//
// Every holder tx resolves `lockAcquired` ONLY after it holds its lock(s); the waiter is fired
// (and waitForBlockedDatabaseSession polled) strictly after that promise, so there is no implicit
// "whoever fires first wins the lock" race (CodeRabbit/codex round-2). Self-isolated fixtures (own
// knowledge ids, own reset) so this never shares a mutable count with the propose_edge cost-ledger
// concurrency flake (YUK-724).

import { createKnowledgeEdge } from '@/capabilities/knowledge/server/edges';
import { newId } from '@/core/ids';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { writeEvent } from '@/server/events/queries';
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

// A resolved-on-demand promise. The holder tx resolves `lockAcquired` after it owns its lock(s); the
// main flow awaits that before firing the waiter, and `release` lets the holder commit on demand.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Poll pg_stat_activity until SOME other backend of this database is blocked waiting on a lock (row
// lock OR advisory — both surface as wait_event_type='Lock'). The waiter is already known to have
// started (we await the holder's lockAcquired before firing it), so this fires once the waiter has
// actually queued behind the held lock.
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

  it('serializes concurrent A->B / B->A accepts; the second is rejected by the topology gate (no 2-cycle)', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    // B->A is the proposal under test. A->B is created + committed by the holder tx first, so when
    // B->A finally acquires the locks its fold sees A->B and the reverse edge is a direction
    // contradiction. NOTE: A->B and B->A are DISTINCT unique keys, so the UNIQUE(from,to,type)
    // constraint does NOT catch this — only lock-serialization + the topology gate does.
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
    const acceptBA = decideKnowledgeEdgeProposal(db, proposeBA, { decision: 'accept' });

    await waitForBlockedDatabaseSession();
    release.resolve();
    await holderDone;

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

  it('serializes cleanly behind a holder that owns only the advisory; no deadlock', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    // related_to skips the topology gate, so this isolates serialization: after the held advisory
    // releases the accept must simply COMPLETE (never a 40P01).
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

  it('lock-then-revalidate: a merge that archives an endpoint under the lock makes the accept reject; zero live edge lands (codex P2 TOCTOU)', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    const proposeAB = await seedProposeEdgeEvent({ from: 'A', to: 'B' });

    // Full merge accept order: knowledge rows FOR UPDATE (id-sorted) -> knowledge_edge advisory ->
    // archive an endpoint. The accept's PRE-lock check runs against the still-committed (live) A —
    // A's archive is uncommitted while the holder holds — so it passes; the accept then blocks on
    // the row lock. Without lock-then-revalidate the accept would resume and land a live A->B edge
    // pointing at the just-archived A (FK holds on the tombstone).
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

    await waitForBlockedDatabaseSession();
    release.resolve();
    await mergeHold;

    // Accept re-reads endpoints UNDER the lock, sees A now archived, and rejects (the endpoint
    // revalidation, not the topology gate).
    await expect(acceptAB).rejects.toThrow(/archived|unknown|not.?found/i);

    // No edge landed at all — the accept tx rolled back its rate/generate events and any insert.
    const all = await db.select().from(knowledge_edge);
    expect(all).toHaveLength(0);
  });

  it('does not 40P01-deadlock against a merge-ordered holder (knowledge row FOR UPDATE -> advisory) (codex P1)', async () => {
    const db = testDb();
    await seedKnowledge(['A', 'B']);
    const proposeAB = await seedProposeEdgeEvent({ from: 'A', to: 'B' });

    // Reproduce the exact pre-fix deadlock interleaving. The merge-sim grabs the knowledge ROW A
    // FOR UPDATE first (as lockMutationRows does), signals, waits until the accept is blocked, THEN
    // grabs the knowledge_edge advisory. Pre-fix the accept took the advisory FIRST then wanted the
    // row -> accept holds advisory + wants row A, merge holds row A + wants advisory = cycle -> a
    // Postgres 40P01. Post-fix the accept takes the ROW first (same global order as the merge), so
    // it simply queues behind row A and no cycle forms.
    const mergeHasRow = deferred();
    const releaseAdvisory = deferred();
    const mergeSim = db.transaction(async (tx) => {
      await tx
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(inArray(knowledge.id, ['A']))
        .orderBy(knowledge.id)
        .for('update');
      mergeHasRow.resolve();
      await releaseAdvisory.promise;
      await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', ['A']);
    });

    await mergeHasRow.promise;
    const acceptAB = decideKnowledgeEdgeProposal(db, proposeAB, { decision: 'accept' });

    // Accept is now blocked on knowledge row A FOR UPDATE (post-fix). Release the merge-sim to grab
    // the advisory: post-fix it grabs it freely (accept holds no advisory) and commits; pre-fix it
    // would block on the accept's advisory and trip the deadlock detector.
    await waitForBlockedDatabaseSession();
    releaseAdvisory.resolve();

    const settled = await Promise.allSettled([mergeSim, acceptAB]);
    for (const r of settled) {
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        expect(msg).not.toMatch(/deadlock|40P01/i);
      }
    }

    // The accept committed a live A->B edge (semantics intact: the merge-sim never archived A).
    expect(settled[1].status).toBe('fulfilled');
    const live = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
    expect(live).toHaveLength(1);
    expect(live[0].from_knowledge_id).toBe('A');
    expect(live[0].to_knowledge_id).toBe('B');
  }, 20000);
});
