// P5 (YUK-489) — kc_dedup_nightly DB tests. Seeds KCs with controlled 1024-dim
// embeddings (near-parallel for a near-dup pair, orthogonal for a far pair) +
// `experimental:auto_tag_kc_created` events to mark them recent-auto-created, then
// asserts the propose-only merge behaviour.
//
// Controlled cosine distance (pgvector `<=>` = 1 - cosine_similarity):
//   - two NEAR-parallel vectors `[1,ε,0,…]` vs `[1,0,0,…]` → cos ≈ 1/√(1+ε²) ≈
//     1 - ε²/2, so distance ≈ ε²/2. ε=0.1 → distance ≈ 0.005 (≤ 0.10 ⇒ near-dup).
//   - two ORTHOGONAL unit vectors → distance ≈ 1 (> 0.10 ⇒ far, no proposal).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/core/ids';
import { event, knowledge } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
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

/** Seed a prior merge proposal event for an unordered pair (into, from) — the
 *  cross-run idempotency skip-set keys on `experimental:knowledge_merge` events
 *  with top-level payload `into_id` + `from_ids` within the window. */
async function seedPriorMergeProposal(
  db: ReturnType<typeof testDb>,
  into: string,
  from: string,
  opts: { createdAt?: Date } = {},
): Promise<void> {
  await db.insert(event).values({
    id: newId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'kc_dedup_nightly',
    action: 'experimental:knowledge_merge',
    subject_kind: 'knowledge',
    subject_id: into,
    outcome: 'partial',
    payload: { into_id: into, from_ids: [from] },
    created_at: opts.createdAt ?? new Date(),
  });
}

describe('runKcDedupNightly', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('cross-run idempotency: a pair already proposed within the window is NOT re-proposed', async () => {
    const db = testDb();
    await seedKc(db, 'kc-old', unitVec(0), { createdAt: new Date('2026-06-20T00:00:00Z') });
    await seedKc(db, 'kc-new', nearUnit0(0.1), { createdAt: new Date('2026-06-21T00:00:00Z') });
    await markAutoCreated(db, 'kc-old');
    await markAutoCreated(db, 'kc-new');
    // A prior merge proposal for this exact pair, written recently (within the window).
    await seedPriorMergeProposal(db, 'kc-old', 'kc-new');

    const proposeFn = vi.fn(async () => newId());
    const res = await runKcDedupNightly(db, { proposeFn });

    // Still SCANNED (it is a near-dup) but NOT re-proposed — counted skipped.
    expect(res.scanned_pairs).toBe(1);
    expect(res.merge_proposals_created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(proposeFn).not.toHaveBeenCalled();
  });
});
