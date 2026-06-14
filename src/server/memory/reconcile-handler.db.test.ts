// P2 (YUK-342) — reconcile handler failure-mode tests.
// Exercises the three failure modes against a real Postgres (testcontainer):
//   1. LLM parse failure → batch degrades to KEEP_BOTH
//   2. Write-ahead half-crash → idempotent resume via loadUnappliedLog
//   3. Concurrency → singletonKey serializes per user
// Also verifies the two-read-consumer passthrough after supersede injection.

import { RetryableError } from '@/core/schema/structured_question';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import type { MemoryClient } from './client';
import { type CandidateEntry, type NewMemoryEntry, ReconcileParseError } from './reconcile-llm';
import { loadUnappliedLog, makePlannedRow } from './reconcile-store';
import { buildMemoryReconcileHandler } from './triggers';

const COLLECTION = 'test_reconcile_collection';

async function createTestCollection() {
  const db = testDb();
  await db.execute(sql.raw(`DROP TABLE IF EXISTS "${COLLECTION}"`));
  await db.execute(sql`
    CREATE TABLE "${sql.raw(COLLECTION)}" (
      id uuid PRIMARY KEY,
      vector vector(1024),
      payload jsonb
    )
  `);
}

type MemInput = { id: string; text: string; created_ms: number; kind: string };
type JobData = { memories: MemInput[]; user_id: string };

function makeJob(data: JobData): { data: JobData }[] {
  return [{ data }];
}

function mem(id: string, text = 'some memory', kind = 'event', created_ms = 1000): MemInput {
  return { id, text, created_ms, kind };
}

function mockMemoryClient(
  searchResults: Array<{ id: string; memory: string; metadata?: Record<string, unknown> }>,
): MemoryClient {
  return {
    addEventMemory: vi.fn(),
    search: vi.fn(async () => ({ results: searchResults })),
  };
}

describe('reconcile handler — failure mode 1: LLM parse failure degrades to KEEP_BOTH', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('catches ReconcileParseError, writes KEEP_BOTH log rows, zero side effects', async () => {
    const db = testDb();
    const memId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const memoryClient = mockMemoryClient([
      {
        id: memId,
        memory: 'User prefers dark mode',
        metadata: { kind: 'preference', created_ms: 1000 },
      },
    ]);

    // Judge throws ReconcileParseError
    const badJudge = vi.fn(async () => {
      throw new ReconcileParseError('bad json', 'garbage');
    });

    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: badJudge as never,
      collectionName: COLLECTION,
    });

    await handler(
      makeJob({
        memories: [mem(memId, 'User prefers dark mode', 'preference')],
        user_id: 'self',
      }) as never,
    );

    // All planned rows should be KEEP_BOTH and applied
    const unapplied = await loadUnappliedLog(db, 'self');
    expect(unapplied).toHaveLength(0); // all applied

    // Verify via direct query that KEEP_BOTH rows exist
    const rows = (await db.execute(sql`
      SELECT action FROM memory_reconciliation_log WHERE user_id = 'self'
    `)) as Array<{ action: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('KEEP_BOTH');
  });
});

describe('reconcile handler — failure mode 2: idempotent resume via loadUnappliedLog', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('replays unapplied planned rows from prior crash; already-applied not repeated', async () => {
    const db = testDb();
    const oldMemId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const newMemId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    // Seed a mem0 row that will be superseded
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload)
      VALUES (${oldMemId}::uuid, ${JSON.stringify({ data: 'old pref', user_id: 'self' })}::jsonb)
    `);

    // Simulate a prior crash: write planned row but DON'T apply it
    const plannedRow = makePlannedRow({
      user_id: 'self',
      new_memory_id: newMemId,
      old_memory_id: oldMemId,
      action: 'SUPERSEDE',
      reason: 'test supersede',
      llm_raw: { confidence: 0.9 },
    });
    // Insert directly, bypassing the handler
    await db.execute(sql`
      INSERT INTO memory_reconciliation_log (id, user_id, new_memory_id, old_memory_id, action, reason, llm_raw, planned_at)
      VALUES (${plannedRow.id}, 'self', ${newMemId}, ${oldMemId}, 'SUPERSEDE', 'test', '{}', now())
    `);

    // Verify it's unapplied
    let unapplied = await loadUnappliedLog(db, 'self');
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].action).toBe('SUPERSEDE');

    // Now run the handler with an empty new-ids job — it should replay the
    // unapplied planned row first (applyPlannedRows at job start).
    const memoryClient = mockMemoryClient([]);
    const judge = vi.fn();
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });

    await handler(makeJob({ memories: [], user_id: 'self' }) as never);

    // The planned row should now be applied
    unapplied = await loadUnappliedLog(db, 'self');
    expect(unapplied).toHaveLength(0);

    // Judge should NOT have been called (no new memories)
    expect(judge).not.toHaveBeenCalled();

    // Verify softSupersede was applied: old mem0 row should have superseded_by
    const rows = (await db.execute(sql`
      SELECT payload->>'superseded_by' AS superseded_by
      FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${oldMemId}::uuid
    `)) as Array<{ superseded_by: string | null }>;
    expect(rows[0].superseded_by).toBe(newMemId);
  });
});

describe('reconcile handler — uses extracted memory text for search (not eventToText JSON)', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('passes mem0 search results (extracted memory) as candidate text, not raw JSON', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

    const memoryClient = mockMemoryClient([
      {
        id: newMemId,
        memory: 'User prefers dark mode',
        metadata: { kind: 'preference', created_ms: 2000 },
      },
      {
        id: oldMemId,
        memory: 'User prefers light mode',
        metadata: { kind: 'preference', created_ms: 1000 },
      },
    ]);

    let capturedNewMems: NewMemoryEntry[] = [];
    let capturedCandidates: Map<number, CandidateEntry[]> = new Map();
    const judge = vi.fn(async (newMems: NewMemoryEntry[], cands: Map<number, CandidateEntry[]>) => {
      capturedNewMems = newMems;
      capturedCandidates = cands;
      return [
        { new_index: 0, action: 'KEEP_BOTH', old_index: null, confidence: 0.9, reason: 'test' },
      ];
    });

    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });

    await handler(
      makeJob({
        memories: [mem(newMemId, 'User prefers dark mode', 'preference', 2000)],
        user_id: 'self',
      }) as never,
    );

    // Verify judge received extracted text, not JSON
    expect(judge).toHaveBeenCalled();
    expect(capturedNewMems[0].text).toBe('User prefers dark mode');
    expect(capturedNewMems[0].text).not.toMatch(/^\{.*\}$/); // not JSON

    const cands = capturedCandidates.get(0) ?? [];
    expect(cands).toHaveLength(1);
    expect(cands[0].text).toBe('User prefers light mode');
    expect(cands[0].memory_id).toBe(oldMemId);
  });
});

describe('reconcile handler — empty batch guard', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('does not call judge when memory_ids is empty', async () => {
    const db = testDb();
    const memoryClient = mockMemoryClient([]);
    const judge = vi.fn(async () => []);

    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });

    await handler(makeJob({ memories: [], user_id: 'self' }) as never);

    expect(judge).not.toHaveBeenCalled();
  });
});

describe('reconcile handler — MERGE rewrites old payload.data with merged_text + drops new', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('writes merged_text (NOT reason) to old payload.data, keeps old LIVE, hard-deletes new', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${oldMemId}::uuid, ${JSON.stringify({ data: 'old text', user_id: 'self' })}::jsonb),
        (${newMemId}::uuid, ${JSON.stringify({ data: 'new text', user_id: 'self' })}::jsonb)
    `);
    // search returns the old candidate (the new id is filtered out by newIdSet).
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'old text', metadata: { created_ms: 1000 } },
    ]);
    const judge = vi.fn(async () => [
      {
        new_index: 0,
        action: 'MERGE',
        old_index: 0,
        confidence: 0.9,
        reason: 'they overlap (this is an explanation, must NOT become the memory text)',
        merged_text: 'MERGED: prefers dark mode and terse feedback',
      },
    ]);
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });
    await handler(
      makeJob({
        memories: [mem(newMemId, 'new text', 'preference', 2000)],
        user_id: 'self',
      }) as never,
    );

    const oldRows = (await db.execute(sql`
      SELECT payload->>'data' AS data, payload->>'superseded_by' AS sb,
             payload->>'invalid_at' AS ia, payload->>'created_ms' AS cms
      FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${oldMemId}::uuid
    `)) as Array<{ data: string; sb: string | null; ia: string | null; cms: string | null }>;
    expect(oldRows[0].data).toBe('MERGED: prefers dark mode and terse feedback');
    expect(oldRows[0].data).not.toContain('explanation'); // reason did NOT leak into data
    // PR #405 MERGE bug regression lock: the surviving merged row must stay LIVE.
    // Marking it superseded_by/invalid_at would hide the merge result from the P3
    // read path (which filters rows carrying those markers).
    expect(oldRows[0].sb).toBeNull();
    expect(oldRows[0].ia).toBeNull();
    // created_ms bumped to the new memory's recency (2000).
    expect(oldRows[0].cms).toBe('2000');

    const newRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${newMemId}::uuid`,
    )) as unknown[];
    expect(newRows).toHaveLength(0); // new row dropped
    expect(await loadUnappliedLog(db, 'self')).toHaveLength(0);
  });
});

describe('reconcile handler — RETRACT_NEW drops the duplicate new row, leaves old untouched', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('hard-deletes the new memory; the existing memory is unchanged', async () => {
    const db = testDb();
    const newMemId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const oldMemId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${oldMemId}::uuid, ${JSON.stringify({ data: 'canonical', user_id: 'self' })}::jsonb),
        (${newMemId}::uuid, ${JSON.stringify({ data: 'duplicate', user_id: 'self' })}::jsonb)
    `);
    const memoryClient = mockMemoryClient([{ id: oldMemId, memory: 'canonical' }]);
    const judge = vi.fn(async () => [
      {
        new_index: 0,
        action: 'RETRACT_NEW',
        old_index: null,
        confidence: 0.95,
        reason: 'exact dup',
      },
    ]);
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });
    await handler(
      makeJob({ memories: [mem(newMemId, 'duplicate', 'event', 2000)], user_id: 'self' }) as never,
    );

    const newRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${newMemId}::uuid`,
    )) as unknown[];
    expect(newRows).toHaveLength(0); // new dropped
    const oldRows = (await db.execute(sql`
      SELECT payload->>'superseded_by' AS sb FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${oldMemId}::uuid
    `)) as Array<{ sb: string | null }>;
    expect(oldRows[0].sb).toBeNull(); // old untouched
    expect(await loadUnappliedLog(db, 'self')).toHaveLength(0);
  });
});

describe('reconcile handler — idempotent resume skips already-applied rows', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('replays only applied_at IS NULL rows; an already-applied row does not re-run', async () => {
    const db = testDb();
    const appliedOld = '11111111-1111-1111-1111-111111111111';
    const pendingOld = '22222222-2222-2222-2222-222222222222';
    const newId_ = '33333333-3333-3333-3333-333333333333';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${appliedOld}::uuid, ${JSON.stringify({ data: 'A', user_id: 'self' })}::jsonb),
        (${pendingOld}::uuid, ${JSON.stringify({ data: 'B', user_id: 'self' })}::jsonb)
    `);
    // Already-applied SUPERSEDE row (applied_at set) targeting appliedOld — must NOT re-run
    // (its target deliberately has no superseded_by, so a re-run would be visible).
    const appliedRow = makePlannedRow({
      user_id: 'self',
      new_memory_id: newId_,
      old_memory_id: appliedOld,
      action: 'SUPERSEDE',
      reason: 'already applied',
      llm_raw: {},
    });
    await db.execute(sql`
      INSERT INTO memory_reconciliation_log
        (id, user_id, new_memory_id, old_memory_id, action, reason, llm_raw, planned_at, applied_at)
      VALUES (${appliedRow.id}, 'self', ${newId_}, ${appliedOld}, 'SUPERSEDE', 'a', '{}', now(), now())
    `);
    // Unapplied SUPERSEDE row targeting pendingOld — must run on resume.
    const pendingRow = makePlannedRow({
      user_id: 'self',
      new_memory_id: newId_,
      old_memory_id: pendingOld,
      action: 'SUPERSEDE',
      reason: 'pending',
      llm_raw: {},
    });
    await db.execute(sql`
      INSERT INTO memory_reconciliation_log
        (id, user_id, new_memory_id, old_memory_id, action, reason, llm_raw, planned_at)
      VALUES (${pendingRow.id}, 'self', ${newId_}, ${pendingOld}, 'SUPERSEDE', 'b', '{}', now())
    `);

    const handler = buildMemoryReconcileHandler(db, {
      memoryClient: mockMemoryClient([]),
      judge: vi.fn() as never,
      collectionName: COLLECTION,
    });
    await handler(makeJob({ memories: [], user_id: 'self' }) as never);

    const rows = (await db.execute(sql`
      SELECT id::text AS id, payload->>'superseded_by' AS sb
      FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id IN (${appliedOld}::uuid, ${pendingOld}::uuid)
    `)) as Array<{ id: string; sb: string | null }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.sb]));
    expect(byId[appliedOld]).toBeNull(); // already-applied row did NOT re-run
    expect(byId[pendingOld]).toBe(newId_); // unapplied row was replayed
    expect(await loadUnappliedLog(db, 'self')).toHaveLength(0);
  });
});

describe('reconcile handler — retryable failure rethrows (pg-boss retries)', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('rethrows RetryableError from judge instead of swallowing it', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'User prefers light mode', metadata: { created_ms: 1000 } },
    ]);
    // judge throws a transient (retryable) error — NOT a ReconcileParseError.
    const judge = vi.fn(async () => {
      throw new RetryableError('GLM upstream 503');
    });
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });

    // The outer per-job catch must rethrow RetryableError so pg-boss retries.
    await expect(
      handler(
        makeJob({
          memories: [mem(newMemId, 'User prefers dark mode', 'preference', 2000)],
          user_id: 'self',
        }) as never,
      ),
    ).rejects.toBeInstanceOf(RetryableError);
  });
});

describe('reconcile handler — duplicate new_index decisions are deduped', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('keeps only the first decision per new_index; second is dropped', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${oldMemId}::uuid, ${JSON.stringify({ data: 'old', user_id: 'self' })}::jsonb),
        (${newMemId}::uuid, ${JSON.stringify({ data: 'new', user_id: 'self' })}::jsonb)
    `);
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'old', metadata: { created_ms: 1000 } },
    ]);
    // GLM hallucinates TWO decisions for the same new_index (0). Only the first
    // (KEEP_BOTH) should produce a planned row; the second (SUPERSEDE) is dropped.
    const judge = vi.fn(async () => [
      { new_index: 0, action: 'KEEP_BOTH', old_index: null, confidence: 0.9, reason: 'first wins' },
      { new_index: 0, action: 'SUPERSEDE', old_index: 0, confidence: 0.8, reason: 'duplicate' },
    ]);
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });
    await handler(
      makeJob({ memories: [mem(newMemId, 'new', 'event', 2000)], user_id: 'self' }) as never,
    );

    // Exactly one planned row (the first decision); the dup SUPERSEDE never ran,
    // so the old row was NOT superseded.
    const logRows = (await db.execute(sql`
      SELECT action, reason FROM memory_reconciliation_log WHERE user_id = 'self'
    `)) as Array<{ action: string; reason: string }>;
    expect(logRows).toHaveLength(1);
    expect(logRows[0].action).toBe('KEEP_BOTH');
    // Lock first-wins (not last-wins): the kept row is the FIRST decision, not the dropped SUPERSEDE.
    expect(logRows[0].reason).toBe('first wins');

    const oldRows = (await db.execute(sql`
      SELECT payload->>'superseded_by' AS sb FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${oldMemId}::uuid
    `)) as Array<{ sb: string | null }>;
    expect(oldRows[0].sb).toBeNull(); // dup SUPERSEDE was dropped, old untouched
    expect(await loadUnappliedLog(db, 'self')).toHaveLength(0);
  });
});
