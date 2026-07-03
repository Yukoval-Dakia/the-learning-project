// P2 (YUK-342) — reconcile-store DB tests (testcontainer).
// Exercises softSupersede jsonb merge, hardDelete, write-ahead log lifecycle
// against a real Postgres. The mem0 collection table (learning_project_memories)
// is created manually here since it's NOT a drizzle-managed table (mem0's
// PGVector provider creates it at runtime).

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  createMem0Collection,
  seedMem0Row as seedMem0RowHelper,
} from '../../../tests/helpers/mem0-collection';
import type { MemoryClient } from './client';
import {
  capturePrevState,
  hardDeleteMemory,
  insertPlannedRows,
  loadUnappliedLog,
  makePlannedRow,
  markApplied,
  rewriteMemoryText,
  softSupersede,
} from './reconcile-store';

const COLLECTION = 'test_mem0_collection';

// YUK-557 (F7): DDL/seed delegate to the shared tests/helpers/mem0-collection
// (single source of the runtime-created mem0 collection DDL). getPayload stays
// local (a test-only read util, not converged with prod — V8-E2/R4 WONTFIX).
async function createTestCollection() {
  await createMem0Collection(testDb(), COLLECTION);
}

async function seedMem0Row(id: string, payload: Record<string, unknown>) {
  await seedMem0RowHelper(testDb(), COLLECTION, id, payload);
}

async function getPayload(id: string): Promise<Record<string, unknown> | null> {
  const db = testDb();
  const rows = (await db.execute(sql`
    SELECT payload FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${id}::uuid
  `)) as Array<{ payload: Record<string, unknown> }>;
  return rows[0]?.payload ?? null;
}

describe('reconcile-store — softSupersede', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('merges superseded_by/invalid_at/created_ms into payload without clobbering existing keys', async () => {
    const oldId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await seedMem0Row(oldId, {
      data: 'User prefers light mode',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      hash: 'abc123',
      user_id: 'self',
    });

    const newId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await softSupersede(testDb(), COLLECTION, {
      oldMemoryId: oldId,
      supersededByNewId: newId,
      invalidAtMs: 1718000000000,
      createdMs: 1718000000000,
    });

    const payload = await getPayload(oldId);
    expect(payload).not.toBeNull();
    // Original keys preserved
    expect(payload?.data).toBe('User prefers light mode');
    expect(payload?.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(payload?.hash).toBe('abc123');
    expect(payload?.user_id).toBe('self');
    // New keys added
    expect(payload?.superseded_by).toBe(newId);
    expect(payload?.invalid_at).toBe(new Date(1718000000000).toISOString());
    expect(payload?.created_ms).toBe('1718000000000');
    // superseded_by is NOT JSON null (sentinel discipline)
    expect(payload?.superseded_by).not.toBeNull();
  });
});

describe('reconcile-store — rewriteMemoryText (MERGE survivor stays live)', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('rewrites payload.data + created_ms WITHOUT marking the row superseded', async () => {
    const oldId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await seedMem0Row(oldId, {
      data: 'User prefers light mode',
      createdAt: '2026-01-01T00:00:00Z',
      hash: 'abc123',
      user_id: 'self',
    });

    await rewriteMemoryText(testDb(), COLLECTION, {
      memoryId: oldId,
      mergedText: 'MERGED: prefers dark mode and terse feedback',
      createdMs: 1718000000000,
    });

    const payload = await getPayload(oldId);
    expect(payload).not.toBeNull();
    // Merged text written
    expect(payload?.data).toBe('MERGED: prefers dark mode and terse feedback');
    // created_ms bumped (string, like softSupersede)
    expect(payload?.created_ms).toBe('1718000000000');
    // Original non-data keys preserved
    expect(payload?.hash).toBe('abc123');
    expect(payload?.user_id).toBe('self');
    // Regression lock (PR #405 MERGE bug): the survivor MUST stay live — no
    // supersede markers, or the P3 read path would filter the merged memory out.
    expect(payload).not.toHaveProperty('superseded_by');
    expect(payload).not.toHaveProperty('invalid_at');
  });
});

// YUK-557 (Q2a/M4): a test-double whose hardDelete executes a REAL raw DELETE
// against the injected test collection — the guts of what the production
// client.hardDelete does (mem0 official delete()). This preserves genuine
// physical-delete coverage (getPayload===null) rather than degrading to
// "mock was called". No error-swallowing needed: a raw DELETE against a missing
// row is a natural 0-row no-op (idempotent), so this double stays a faithful
// stand-in without copying any not-found handling (F1: the production idempotency
// is verify-absence, exercised as a unit in client.test.ts).
function rawDeleteClient(): Pick<MemoryClient, 'hardDelete'> {
  return {
    async hardDelete(memoryId: string) {
      await testDb().execute(
        sql`DELETE FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${memoryId}::uuid`,
      );
    },
  };
}

describe('reconcile-store — hardDeleteMemory (delegates to client.hardDelete)', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('physically deletes the row via the injected client', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await seedMem0Row(id, { data: 'temp memory' });

    await hardDeleteMemory(rawDeleteClient(), id);

    const payload = await getPayload(id);
    expect(payload).toBeNull();
  });

  it('is idempotent — deleting a non-existent row does not throw', async () => {
    const nonExistent = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    await expect(hardDeleteMemory(rawDeleteClient(), nonExistent)).resolves.toBeUndefined();
  });
});

describe('reconcile-store — capturePrevState', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('returns { text, metadata } for an existing row (write-ahead snapshot source)', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const payload = { data: 'snapshot me', user_id: 'self', kind: 'preference', hash: 'h1' };
    await seedMem0Row(id, payload);

    const snap = await capturePrevState(testDb(), COLLECTION, id);
    expect(snap).not.toBeNull();
    expect(snap?.text).toBe('snapshot me');
    expect(snap?.metadata).toMatchObject(payload);
  });

  it('returns null for a non-existent row (defensive; caller leaves prev_metadata NULL)', async () => {
    const nonExistent = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const snap = await capturePrevState(testDb(), COLLECTION, nonExistent);
    expect(snap).toBeNull();
  });
});

describe('reconcile-store — write-ahead log lifecycle', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('inserts planned rows with applied_at NULL, marks applied, and loadUnappliedLog returns only unapplied', async () => {
    const db = testDb();
    const row1 = makePlannedRow({
      user_id: 'self',
      new_memory_id: 'mem1',
      old_memory_id: 'mem2',
      action: 'SUPERSEDE',
      reason: 'updated preference',
      llm_raw: { confidence: 0.9 },
      // YUK-557 (Q2b/F2): a destructive row must carry its undo snapshot or
      // insertPlannedRows fail-closes.
      prev_text: 'old preference text',
    });
    const row2 = makePlannedRow({
      user_id: 'self',
      new_memory_id: 'mem3',
      old_memory_id: null,
      action: 'KEEP_BOTH',
      reason: 'different facts',
      llm_raw: { confidence: 0.8 },
    });

    await insertPlannedRows(db, [row1, row2]);

    // Both should be unapplied initially
    let unapplied = await loadUnappliedLog(db, 'self');
    expect(unapplied).toHaveLength(2);

    // Mark row1 applied
    await markApplied(db, row1.id);

    unapplied = await loadUnappliedLog(db, 'self');
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].id).toBe(row2.id);
    expect(unapplied[0].action).toBe('KEEP_BOTH');
  });

  it('loadUnappliedLog returns rows ordered by planned_at ASC', async () => {
    const db = testDb();
    const early = makePlannedRow({
      user_id: 'self',
      new_memory_id: 'mem-early',
      old_memory_id: null,
      action: 'KEEP_BOTH',
      reason: 'first',
      llm_raw: null,
    });
    early.planned_at = new Date('2026-01-01T00:00:00Z');
    const late = makePlannedRow({
      user_id: 'self',
      new_memory_id: 'mem-late',
      old_memory_id: null,
      action: 'KEEP_BOTH',
      reason: 'second',
      llm_raw: null,
    });
    late.planned_at = new Date('2026-06-01T00:00:00Z');

    await insertPlannedRows(db, [late, early]);

    const unapplied = await loadUnappliedLog(db, 'self');
    expect(unapplied[0].id).toBe(early.id);
    expect(unapplied[1].id).toBe(late.id);
  });

  it('isolates by user_id', async () => {
    const db = testDb();
    const rowSelf = makePlannedRow({
      user_id: 'self',
      new_memory_id: 'mem1',
      old_memory_id: null,
      action: 'KEEP_BOTH',
      reason: 'self',
      llm_raw: null,
    });
    const rowOther = makePlannedRow({
      user_id: 'other',
      new_memory_id: 'mem2',
      old_memory_id: null,
      action: 'KEEP_BOTH',
      reason: 'other',
      llm_raw: null,
    });

    await insertPlannedRows(db, [rowSelf, rowOther]);

    const selfUnapplied = await loadUnappliedLog(db, 'self');
    expect(selfUnapplied).toHaveLength(1);
    expect(selfUnapplied[0].user_id).toBe('self');
  });
});

describe('reconcile-store — insertPlannedRows prev_text invariant (F2)', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('fail-closes on a destructive row (SUPERSEDE/MERGE/RETRACT_NEW) missing prev_text', async () => {
    const db = testDb();
    for (const action of ['SUPERSEDE', 'MERGE', 'RETRACT_NEW'] as const) {
      const row = makePlannedRow({
        user_id: 'self',
        new_memory_id: 'memN',
        old_memory_id: action === 'RETRACT_NEW' ? null : 'memO',
        action,
        reason: 'x',
        llm_raw: null,
        // prev_text intentionally omitted
      });
      await expect(insertPlannedRows(db, [row])).rejects.toThrow(
        /destructive planned row without prev_text snapshot/,
      );
    }
    // Nothing was written (fail-closed BEFORE the insert).
    expect(await loadUnappliedLog(db, 'self')).toHaveLength(0);
  });

  it('allows a KEEP_BOTH row without prev_text (no undo target)', async () => {
    const db = testDb();
    const row = makePlannedRow({
      user_id: 'self',
      new_memory_id: 'memN',
      old_memory_id: null,
      action: 'KEEP_BOTH',
      reason: 'different facts',
      llm_raw: null,
    });
    await expect(insertPlannedRows(db, [row])).resolves.toBeUndefined();
    expect(await loadUnappliedLog(db, 'self')).toHaveLength(1);
  });
});
