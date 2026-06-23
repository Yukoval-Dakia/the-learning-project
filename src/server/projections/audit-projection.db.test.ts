// YUK-471 W1 PR-A2a — DB tests for the projection auditor (testcontainer).
//
// Tests the auditProjection FUNCTION (not the process exit). The fixture is a SMALL coherent
// world: a few `knowledge` rows + their genesis events + matching materialized_id_index
// entries (seeded via the backfill pipeline fns, so fold(genesis)==row by construction). The
// auditor must report CLEAN. Then we mutate a live row OUT-OF-BAND (a raw UPDATE that bypasses
// the projection) and assert the auditor flags exactly that id as DRIFT. A third case proves
// the allowlist suppresses a known drift.
//
// Hermetic: resetDb() in beforeEach. resetDb does NOT truncate materialized_id_index (no FK →
// not reached by CASCADE), so we truncate it explicitly to keep the reverse-index hermetic.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { knowledge, knowledge_edge } from '@/db/schema';
import { auditProjection } from '../../../scripts/audit-projection';
import {
  backfillKnowledgeEdgeGenesis,
  backfillKnowledgeGenesis,
} from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';

const T0 = new Date('2026-06-01T00:00:00.000Z');

async function insertKnowledge(opts: {
  id: string;
  name?: string;
  domain?: string | null;
  parent_id?: string | null;
  version?: number;
}): Promise<void> {
  const db = testDb();
  await db.insert(knowledge).values({
    id: opts.id,
    name: opts.name ?? opts.id,
    domain: opts.domain ?? null,
    parent_id: opts.parent_id ?? null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: null,
    created_at: T0,
    updated_at: T0,
    version: opts.version ?? 0,
  });
}

async function insertEdge(opts: { id: string; from: string; to: string }): Promise<void> {
  const db = testDb();
  await db.insert(knowledge_edge).values({
    id: opts.id,
    from_knowledge_id: opts.from,
    to_knowledge_id: opts.to,
    relation_type: 'related_to',
    weight: 1,
    created_by: { by: 'user' },
    reasoning: null,
    created_at: T0,
    archived_at: null,
  });
}

describe('auditProjection', () => {
  beforeEach(async () => {
    // materialized_id_index is now in ALL_TABLES (tests/helpers/db.ts), so resetDb
    // truncates the reverse-index too — no explicit truncate needed.
    await resetDb();
  });

  it('reports CLEAN when every live row is backed by a matching genesis event', async () => {
    const db = testDb();
    // A small coherent world: 3 knowledge rows + 1 edge.
    await insertKnowledge({ id: 'kn_a', name: 'A', domain: 'wenyan', parent_id: 'seed:root' });
    await insertKnowledge({ id: 'kn_b', name: 'B', parent_id: 'kn_a', version: 2 });
    await insertKnowledge({ id: 'kn_c', name: 'C' });
    await insertEdge({ id: 'ke_ab', from: 'kn_a', to: 'kn_b' });

    // Seed genesis events + index entries via the real backfill pipeline, so fold==row holds.
    await backfillKnowledgeGenesis(db, T0);
    await backfillKnowledgeEdgeGenesis(db, T0);

    const result = await auditProjection(db);
    expect(result.ok).toBe(true);
    expect(result.checkedNodes).toBe(3);
    expect(result.checkedEdges).toBe(1);
    expect(result.drift).toEqual([]);
    expect(result.allowed).toEqual([]);
  });

  it('flags exactly the out-of-band-mutated row as DRIFT', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_a', name: 'A', parent_id: 'seed:root' });
    await insertKnowledge({ id: 'kn_b', name: 'B', parent_id: 'kn_a' });
    await backfillKnowledgeGenesis(db, T0);

    // Sanity: clean before the out-of-band write.
    expect((await auditProjection(db)).ok).toBe(true);

    // Mutate kn_b's name DIRECTLY (bypassing the projection) — the genesis snapshot still says
    // 'B', so fold(events) for kn_b yields name='B' but the live row now says 'TAMPERED'.
    await db.update(knowledge).set({ name: 'TAMPERED' }).where(eq(knowledge.id, 'kn_b'));

    const result = await auditProjection(db);
    expect(result.ok).toBe(false);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.id).toBe('kn_b');
    expect(result.drift[0]?.subject_kind).toBe('knowledge');
    // the diff names the `name` column.
    expect(result.drift[0]?.diffs.some((d) => d.startsWith('name:'))).toBe(true);
    // kn_a is untouched → not in drift.
    expect(result.drift.some((r) => r.id === 'kn_a')).toBe(false);
  });

  it('a present live row whose events fold to null is DRIFT (stale row)', async () => {
    const db = testDb();
    // A live row with NO genesis event and NO creating events → fold yields null, but the row
    // is present → DRIFT (present → fold-null).
    await insertKnowledge({ id: 'kn_orphan', name: 'orphan' });

    const result = await auditProjection(db);
    expect(result.ok).toBe(false);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.id).toBe('kn_orphan');
    expect(result.drift[0]?.diffs.some((d) => d.includes('present → fold-null'))).toBe(true);
  });

  it('allowlist suppresses a known drifted id (reported as allowed, not a failure)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_a', name: 'A' });
    await backfillKnowledgeGenesis(db, T0);
    await db.update(knowledge).set({ name: 'TAMPERED' }).where(eq(knowledge.id, 'kn_a'));

    const result = await auditProjection(db, {
      kn_a: {
        reason: 'test — known acceptable drift',
        resolves_when: { kind: 'manual', ref: 'test', expected_by: '2026-12-31' },
      },
    });
    expect(result.ok).toBe(true); // allowlisted → not a failure
    expect(result.drift).toEqual([]);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]?.id).toBe('kn_a');
  });
});
