// P2 (YUK-342) — reconcile-store DB tests (testcontainer).
// Exercises softSupersede jsonb merge, hardDelete, write-ahead log lifecycle
// against a real Postgres. The mem0 collection table (learning_project_memories)
// is created manually here since it's NOT a drizzle-managed table (mem0's
// PGVector provider creates it at runtime).

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  hardDeleteMemory,
  insertPlannedRows,
  loadUnappliedLog,
  makePlannedRow,
  markApplied,
  softSupersede,
} from './reconcile-store';

const COLLECTION = 'test_mem0_collection';

async function createTestCollection() {
  const db = testDb();
  // Drop if exists (from prior run), then create fresh.
  await db.execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));
  await db.execute(sql`
    CREATE TABLE "${sql.raw(COLLECTION)}" (
      id uuid PRIMARY KEY,
      vector vector(1024),
      payload jsonb
    )
  `);
}

async function seedMem0Row(id: string, payload: Record<string, unknown>) {
  const db = testDb();
  await db.execute(sql`
    INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload)
    VALUES (${id}::uuid, ${JSON.stringify(payload)}::jsonb)
  `);
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

describe('reconcile-store — hardDeleteMemory', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('physically deletes the row', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await seedMem0Row(id, { data: 'temp memory' });

    await hardDeleteMemory(testDb(), COLLECTION, id);

    const payload = await getPayload(id);
    expect(payload).toBeNull();
  });

  it('is idempotent — deleting a non-existent row does not throw', async () => {
    const nonExistent = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    await expect(hardDeleteMemory(testDb(), COLLECTION, nonExistent)).resolves.toBeUndefined();
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
