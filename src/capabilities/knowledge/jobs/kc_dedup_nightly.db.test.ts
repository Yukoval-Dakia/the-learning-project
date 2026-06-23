// P5 (YUK-489) — kc_dedup_nightly DB tests. Seeds KCs with controlled 1024-dim
// embeddings (near-parallel for a near-dup pair, orthogonal for a far pair) +
// `experimental:auto_tag_kc_created` events to mark them recent-auto-created, then
// asserts the propose-only merge behaviour.
//
// Controlled cosine distance (pgvector `<=>` = 1 - cosine_similarity):
//   - two NEAR-parallel vectors `[1,ε,0,…]` vs `[1,0,0,…]` → cos ≈ 1/√(1+ε²) ≈
//     1 - ε²/2, so distance ≈ ε²/2. ε=0.1 → distance ≈ 0.005 (≤ 0.10 ⇒ near-dup).
//   - two ORTHOGONAL unit vectors → distance ≈ 1 (> 0.10 ⇒ far, no proposal).
import { newId } from '@/core/ids';
import { event, knowledge } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import type { WriteProposalEntry } from '../server/proposals';
import { runKcDedupNightly } from './kc_dedup_nightly';

const DIMS = 1024;

/** A 1024-dim unit basis vector: 1 at index `i`, 0 elsewhere. Orthogonal across i. */
function unitVec(i: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[i] = 1;
  return v;
}

/** A 1024-dim vector very close to unitVec(0): cosine distance ≈ eps²/2 from it. */
function nearUnit0(eps: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = 1;
  v[1] = eps;
  return v;
}

async function seedKc(
  db: ReturnType<typeof testDb>,
  id: string,
  embedding: number[] | null,
  opts: {
    createdAt?: Date;
    version?: number;
    archived?: boolean;
    parent_id?: string | null;
  } = {},
): Promise<void> {
  const now = opts.createdAt ?? new Date();
  const values: Record<string, unknown> = {
    id,
    name: id,
    domain: null,
    parent_id: opts.parent_id ?? null,
    merged_from: [],
    proposed_by_ai: true,
    approval_status: 'approved',
    archived_at: opts.archived ? now : null,
    created_at: now,
    updated_at: now,
    version: opts.version ?? 0,
  };
  if (embedding) values.embedding = embedding;
  await db.insert(knowledge).values(values as typeof knowledge.$inferInsert);
}

/** Mark a KC as recently auto-created (the budget bound the scan keys on). */
async function markAutoCreated(
  db: ReturnType<typeof testDb>,
  kcId: string,
  opts: { createdAt?: Date } = {},
): Promise<void> {
  await db.insert(event).values({
    id: newId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'tag_knowledge',
    action: 'experimental:auto_tag_kc_created',
    subject_kind: 'knowledge',
    subject_id: kcId,
    outcome: 'success',
    payload: { source: 'tag_knowledge', auto_created_kc_id: kcId },
    created_at: opts.createdAt ?? new Date(),
  });
}

describe('runKcDedupNightly', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('proposes exactly ONE merge for a near-dup pair (into=older, from=[newer], correct expected_versions)', async () => {
    const db = testDb();
    const older = new Date('2026-06-20T00:00:00Z');
    const newer = new Date('2026-06-21T00:00:00Z');
    // kc-old is older (→ into), kc-new is newer (→ from). Near-parallel embeddings.
    await seedKc(db, 'kc-old', unitVec(0), { createdAt: older, version: 3 });
    await seedKc(db, 'kc-new', nearUnit0(0.1), { createdAt: newer, version: 7 });
    await markAutoCreated(db, 'kc-old');
    await markAutoCreated(db, 'kc-new');

    const captured: WriteProposalEntry[] = [];
    const proposeFn = vi.fn(async (_db, entry: WriteProposalEntry) => {
      captured.push(entry);
      return newId();
    });

    const res = await runKcDedupNightly(db, { proposeFn });

    expect(res.scanned_pairs).toBe(1);
    expect(res.merge_proposals_created).toBe(1);
    expect(res.skipped).toBe(0);
    expect(proposeFn).toHaveBeenCalledTimes(1);

    expect(captured).toHaveLength(1);
    const payload = captured[0].payload;
    expect(payload.mutation).toBe('merge');
    if (payload.mutation !== 'merge') throw new Error('unreachable');
    // older = into, newer = from
    expect(payload.into_id).toBe('kc-old');
    expect(payload.from_ids).toEqual(['kc-new']);
    // expected_versions: exactly one entry, keyed by the from_id, = its version.
    expect(payload.expected_versions).toEqual({ 'kc-new': 7 });
    expect(captured[0].actor_ref).toBe('kc_dedup_nightly');
  });

  it('does NOT propose for a far pair (distance > DEDUP_DISTANCE_MAX)', async () => {
    const db = testDb();
    // Orthogonal unit vectors → cosine distance ≈ 1, far above the 0.10 ceiling.
    await seedKc(db, 'kc-a', unitVec(0));
    await seedKc(db, 'kc-b', unitVec(1));
    await markAutoCreated(db, 'kc-a');
    await markAutoCreated(db, 'kc-b');

    const proposeFn = vi.fn(async () => newId());
    const res = await runKcDedupNightly(db, { proposeFn });

    expect(res.scanned_pairs).toBe(0);
    expect(res.merge_proposals_created).toBe(0);
    expect(proposeFn).not.toHaveBeenCalled();
  });

  it('does NOT scan a near-dup pair when NEITHER side is recent-auto-created (budget/window)', async () => {
    const db = testDb();
    // Near-dup embeddings, but no experimental:auto_tag_kc_created event for either.
    await seedKc(db, 'kc-x', unitVec(0));
    await seedKc(db, 'kc-y', nearUnit0(0.1));
    // (no markAutoCreated calls)

    const proposeFn = vi.fn(async () => newId());
    const res = await runKcDedupNightly(db, { proposeFn });

    expect(res.scanned_pairs).toBe(0);
    expect(res.merge_proposals_created).toBe(0);
    expect(proposeFn).not.toHaveBeenCalled();
  });

  it('excludes a near-dup pair when the recent-auto-created event is OUTSIDE the window', async () => {
    const db = testDb();
    await seedKc(db, 'kc-old1', unitVec(0));
    await seedKc(db, 'kc-old2', nearUnit0(0.1));
    // Auto-created 30 days ago — outside the default 7-day window.
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await markAutoCreated(db, 'kc-old1', { createdAt: longAgo });
    await markAutoCreated(db, 'kc-old2', { createdAt: longAgo });

    const proposeFn = vi.fn(async () => newId());
    const res = await runKcDedupNightly(db, { proposeFn });

    expect(res.scanned_pairs).toBe(0);
    expect(proposeFn).not.toHaveBeenCalled();
  });

  it('excludes archived and null-embedding KCs from the scan', async () => {
    const db = testDb();
    // A live recent-auto-created KC...
    await seedKc(db, 'kc-live', unitVec(0));
    await markAutoCreated(db, 'kc-live');
    // ...paired against an ARCHIVED near-dup and a NULL-embedding near-dup. Both
    // partners are excluded, so no live pair remains → no proposal.
    await seedKc(db, 'kc-archived', nearUnit0(0.1), { archived: true });
    await markAutoCreated(db, 'kc-archived');
    await seedKc(db, 'kc-null', null);
    await markAutoCreated(db, 'kc-null');

    const proposeFn = vi.fn(async () => newId());
    const res = await runKcDedupNightly(db, { proposeFn });

    expect(res.scanned_pairs).toBe(0);
    expect(proposeFn).not.toHaveBeenCalled();
  });

  it('PROPOSE-ONLY: after the run BOTH KCs are still live (not archived, merged_from unchanged)', async () => {
    const db = testDb();
    const older = new Date('2026-06-20T00:00:00Z');
    const newer = new Date('2026-06-21T00:00:00Z');
    await seedKc(db, 'kc-old', unitVec(0), { createdAt: older });
    await seedKc(db, 'kc-new', nearUnit0(0.1), { createdAt: newer });
    await markAutoCreated(db, 'kc-old');
    await markAutoCreated(db, 'kc-new');

    // Use the REAL writer (default proposeFn) — it writes a pending propose event,
    // it must NOT mutate the knowledge rows. (This is the structural proof the job
    // never called applyMerge: applyMerge would archive the from-KC + push into
    // merged_from.)
    const res = await runKcDedupNightly(db);
    expect(res.merge_proposals_created).toBe(1);

    const [oldRow] = await db.select().from(knowledge).where(eq(knowledge.id, 'kc-old'));
    const [newRow] = await db.select().from(knowledge).where(eq(knowledge.id, 'kc-new'));
    // Neither archived.
    expect(oldRow.archived_at).toBeNull();
    expect(newRow.archived_at).toBeNull();
    // into's merged_from still empty (applyMerge would have appended the from id).
    expect(oldRow.merged_from).toEqual([]);
    expect(newRow.merged_from).toEqual([]);

    // The merge proposal IS a pending, human-acceptable inbox event:
    // experimental:knowledge_merge, outcome 'partial' (pending), subject_id=into.
    const mergeEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:knowledge_merge'));
    expect(mergeEvents).toHaveLength(1);
    expect(mergeEvents[0].outcome).toBe('partial');
    expect(mergeEvents[0].subject_id).toBe('kc-old');
  });

  it('writes an experimental:kc_dedup_scan audit event with the counts (NOT a pending inbox proposal)', async () => {
    const db = testDb();
    await seedKc(db, 'kc-old', unitVec(0), { createdAt: new Date('2026-06-20T00:00:00Z') });
    await seedKc(db, 'kc-new', nearUnit0(0.1), { createdAt: new Date('2026-06-21T00:00:00Z') });
    await markAutoCreated(db, 'kc-old');
    await markAutoCreated(db, 'kc-new');

    // Use the REAL writer (default proposeFn) so the merge proposal actually
    // lands as an experimental:knowledge_merge event — required for the
    // inbox-fold assertion below to be meaningful.
    await runKcDedupNightly(db);

    const scanEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:kc_dedup_scan'));
    expect(scanEvents).toHaveLength(1);
    const ev = scanEvents[0];
    expect(ev.subject_kind).toBe('knowledge');
    expect(ev.outcome).toBe('success');
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.scanned_pairs).toBe(1);
    expect(payload.merge_proposals_created).toBe(1);
    expect(payload.skipped).toBe(0);
    expect(payload.threshold).toBeTypeOf('number');
    expect(payload.window_days).toBeTypeOf('number');

    // proposalWhere() folds only propose / experimental:knowledge_% /
    // experimental:proposal / experimental:propose_learning_intent — the scan
    // action matches NONE, so it is audit-only, never surfaced as a pending item.
    const { listProposalInboxRows } = await import('@/server/proposals/inbox');
    const inbox = await listProposalInboxRows(db, { status: 'pending' });
    expect(inbox.some((r) => r.source_action === 'experimental:kc_dedup_scan')).toBe(false);
    // The merge proposal IS in the inbox (the human-acceptable item).
    expect(inbox.some((r) => r.source_action === 'experimental:knowledge_merge')).toBe(true);
  });

  it('best-effort: a per-pair propose failure is counted as skipped and the batch continues', async () => {
    const db = testDb();
    // Two independent near-dup pairs (two near-parallel clusters around different
    // basis vectors), all recent-auto-created.
    await seedKc(db, 'kc-a1', unitVec(0), { createdAt: new Date('2026-06-20T00:00:00Z') });
    await seedKc(db, 'kc-a2', nearUnit0(0.1), { createdAt: new Date('2026-06-21T00:00:00Z') });
    const around2 = (eps: number) => {
      const v = new Array<number>(DIMS).fill(0);
      v[2] = 1;
      v[3] = eps;
      return v;
    };
    const at2 = () => unitVec(2);
    await seedKc(db, 'kc-b1', at2(), { createdAt: new Date('2026-06-20T00:00:00Z') });
    await seedKc(db, 'kc-b2', around2(0.1), { createdAt: new Date('2026-06-21T00:00:00Z') });
    for (const id of ['kc-a1', 'kc-a2', 'kc-b1', 'kc-b2']) await markAutoCreated(db, id);

    let call = 0;
    const proposeFn = vi.fn(async (_db, _entry: WriteProposalEntry) => {
      call += 1;
      if (call === 1) throw new Error('stubbed propose-write failure');
      return newId();
    });

    const res = await runKcDedupNightly(db, { proposeFn });

    expect(res.scanned_pairs).toBe(2);
    expect(res.merge_proposals_created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(proposeFn).toHaveBeenCalledTimes(2);
  });
});
