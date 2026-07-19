// YUK-549 (K10/K13) — DB test pinning the DUAL-ENTRY consistency of the two audit entry points now
// that both read+fold through the ONE registry pass (PROJECTION_ENTITIES[kind].gatherWithContext): the
// value audit (auditProjectionKind, the b3-gate / audit:projection leg) and the symmetric audit
// (auditProjectionKindSymmetric, the Q4a oracle leg) MUST classify the same out-of-band drift on the
// same entity with the SAME field diffs. Before K10 these were two hand-written per-kind switches that
// could silently diverge in HOW they read the live row or fold the events — this test would catch it.
//
// Uses `knowledge` so the K6 prefetch-primed gatherWithContext (merge + rate legs) is on the read path.
// Hermetic: resetDb() in beforeEach.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { knowledge } from '@/db/schema';
import { backfillKnowledgeGenesis } from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { auditProjectionKind, auditProjectionKindSymmetric } from './audit-kind';

const T0 = new Date('2026-06-01T00:00:00.000Z');

async function insertNode(id: string, name: string): Promise<void> {
  await testDb().insert(knowledge).values({
    id,
    name,
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

describe('audit-kind dual-entry consistency (K10)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a coherently backfilled entity is CLEAN on BOTH entry points', async () => {
    const db = testDb();
    await insertNode('k1', 'Alpha');
    await backfillKnowledgeGenesis(db, T0);

    const value = await auditProjectionKind(db, 'knowledge');
    expect(value.checked).toBe(1);
    expect(value.drift).toEqual([]);

    const symmetric = await db.transaction((tx) => auditProjectionKindSymmetric(tx, 'knowledge'), {
      isolationLevel: 'repeatable read',
    });
    expect(symmetric).toEqual([]);
  });

  it('an out-of-band value change is reported by BOTH entry points with the SAME field diffs (K10 drift-scenario pin)', async () => {
    const db = testDb();
    await insertNode('k1', 'Original');
    await backfillKnowledgeGenesis(db, T0); // event-sourced → fold == live row
    // out-of-band structural mutation → the live row diverges from fold(genesis).
    await db.update(knowledge).set({ name: 'TAMPERED' }).where(eq(knowledge.id, 'k1'));

    // value audit (b3-gate / audit:projection path).
    const value = await auditProjectionKind(db, 'knowledge');
    const valueDrift = value.drift.find((d) => d.id === 'k1');
    expect(valueDrift).toBeDefined();

    // symmetric audit (Q4a oracle path), inside the REPEATABLE READ tx it contracts on (M4).
    const symmetric = await db.transaction((tx) => auditProjectionKindSymmetric(tx, 'knowledge'), {
      isolationLevel: 'repeatable read',
    });
    const symDrift = symmetric.find((r) => r.id === 'k1');
    expect(symDrift?.verdict).toBe('FIELD_DRIFT');

    // THE PIN: both entry points, sharing gatherWithContext, produce the IDENTICAL field diff — they
    // cannot diverge in how they read the live row or fold the events.
    expect(symDrift?.diffs).toEqual(valueDrift?.diffs);
    expect(valueDrift?.diffs.join(';')).toContain('name');
  });
});
