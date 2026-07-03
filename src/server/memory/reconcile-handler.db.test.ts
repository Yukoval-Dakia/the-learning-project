// P2 (YUK-342) — reconcile handler failure-mode tests.
// Exercises the three failure modes against a real Postgres (testcontainer):
//   1. LLM parse failure → batch degrades to KEEP_BOTH
//   2. Write-ahead half-crash → idempotent resume via loadUnappliedLog
//   3. Concurrency → singletonKey serializes per user
// Also verifies the two-read-consumer passthrough after supersede injection.

import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { createMem0Collection } from '../../../tests/helpers/mem0-collection';
import { memoryClientMock } from '../../../tests/helpers/memory-client-mock';
import type { MemoryClient } from './client';
import { type CandidateEntry, type NewMemoryEntry, ReconcileParseError } from './reconcile-llm';
import { insertPlannedRows, loadUnappliedLog, makePlannedRow } from './reconcile-store';
import { buildMemoryReconcileHandler } from './triggers';

const COLLECTION = 'test_reconcile_collection';

// YUK-557 (F7): DDL delegates to the shared tests/helpers/mem0-collection.
async function createTestCollection() {
  await createMem0Collection(testDb(), COLLECTION);
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
  searchResults: Array<{
    id: string;
    memory: string;
    metadata?: Record<string, unknown>;
    // YUK-557 (Q1): mem0 fused score — threaded into CandidateEntry.score and
    // consumed by the structural corroboration gate.
    score?: number;
  }>,
): MemoryClient {
  // YUK-557 (F7): partial reuse of the shared MemoryClient double — only search +
  // hardDelete are load-bearing here (addEventMemory/history/restoreVerbatim default
  // to no-ops). hardDelete runs a REAL raw DELETE against the test collection — the
  // guts of what production client.hardDelete does (mem0 official delete()) — so the
  // physical-delete assertions (newRows.toHaveLength(0)) stay genuine coverage
  // rather than "mock was called".
  return memoryClientMock({
    search: vi.fn(async () => ({ results: searchResults })),
    hardDelete: vi.fn(async (memoryId: string) => {
      await testDb().execute(
        sql`DELETE FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${memoryId}::uuid`,
      );
    }),
  });
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
    // YUK-557: score 0.9 ≥ floor → the structural gate passes on a PRESENT score
    // (not abstention), so the MERGE genuinely clears both gates. kind=preference
    // (not weakness/event) so the per-kind gate does not forbid MERGE either.
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'old text', metadata: { created_ms: 1000 }, score: 0.9 },
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
    // YUK-557: score 0.9 ≥ floor. RETRACT_NEW here has old_index=null, so the gate
    // keys on topCandidateScore (max over candidates) = 0.9 → passes on a present
    // score, exercising the fallback path (not abstention).
    const memoryClient = mockMemoryClient([{ id: oldMemId, memory: 'canonical', score: 0.9 }]);
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

  // YUK-353 (item 2): a PermanentError (judge auth 401/403, 4xx, non-JSON 2xx)
  // must propagate too — previously it was swallowed, so the job reported success
  // and pg-boss never archived it (auth/config breakage looked like a healthy
  // no-op reconcile).
  it('rethrows PermanentError from judge instead of swallowing it', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'User prefers light mode', metadata: { created_ms: 1000 } },
    ]);
    // judge throws a non-retryable (permanent) error — e.g. GLM auth 401.
    const judge = vi.fn(async () => {
      throw new PermanentError('GLM reconcile requires ZHIPU_API_KEY (via mem0 config)');
    });
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });

    await expect(
      handler(
        makeJob({
          memories: [mem(newMemId, 'User prefers dark mode', 'preference', 2000)],
          user_id: 'self',
        }) as never,
      ),
    ).rejects.toBeInstanceOf(PermanentError);
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

// YUK-557 (Q1/Q1b/Q2b) — second structural gate, per-kind execution gate, and
// write-ahead undo snapshot in the reconcile handler's action synthesis.
type LogRow = {
  action: string;
  reason: string;
  llm_raw: Record<string, unknown>;
  prev_text: string | null;
  prev_metadata: Record<string, unknown> | null;
};

async function loadLogRows(): Promise<LogRow[]> {
  const db = testDb();
  return (await db.execute(sql`
    SELECT action, reason, llm_raw, prev_text, prev_metadata
    FROM memory_reconciliation_log WHERE user_id = 'self' ORDER BY planned_at
  `)) as unknown as LogRow[];
}

describe('reconcile handler — Q1 score floor downgrades a low-corroboration MERGE', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('MERGE with score below floor → KEEP_BOTH; structurally_corroborated=false AND reason consistent', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${oldMemId}::uuid, ${JSON.stringify({ data: 'old text', user_id: 'self' })}::jsonb),
        (${newMemId}::uuid, ${JSON.stringify({ data: 'new text', user_id: 'self' })}::jsonb)
    `);
    // Low fused score (0.2 < 0.5 floor). kind=preference so the per-kind gate does
    // NOT fire — the downgrade is attributable purely to the score floor (Q1).
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'old text', metadata: { created_ms: 1000 }, score: 0.2 },
    ]);
    const judge = vi.fn(async () => [
      {
        new_index: 0,
        action: 'MERGE',
        old_index: 0,
        confidence: 0.9, // clears the 0.6 confidence gate — only the score floor bites
        reason: 'they overlap',
        merged_text: 'MERGED: should not be written',
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

    const rows = await loadLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('KEEP_BOTH'); // downgraded
    // Lock the observability flag AND action↔reason consistency (A5-1): not just the flag.
    expect(rows[0].llm_raw.structurally_corroborated).toBe(false);
    expect(rows[0].reason).toContain('Low structural corroboration');
    expect(rows[0].reason).toContain('downgraded from MERGE');
    expect(rows[0].reason).toContain('score=0.2');

    // The destructive apply did NOT happen: old row keeps its original text, new
    // row is still present (nothing hard-deleted).
    const oldRows = (await db.execute(sql`
      SELECT payload->>'data' AS data FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${oldMemId}::uuid
    `)) as Array<{ data: string }>;
    expect(oldRows[0].data).toBe('old text');
    const newRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${newMemId}::uuid`,
    )) as unknown[];
    expect(newRows).toHaveLength(1); // new row NOT dropped
  });
});

describe('reconcile handler — Q1b per-kind gate forbids weakness/event MERGE', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('kind=weakness MERGE (even high score) → KEEP_BOTH; reason cites the per-kind guard', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${oldMemId}::uuid, ${JSON.stringify({ data: 'old weakness', user_id: 'self' })}::jsonb),
        (${newMemId}::uuid, ${JSON.stringify({ data: 'new weakness', user_id: 'self' })}::jsonb)
    `);
    // HIGH score (0.95) — the per-kind gate must fire BEFORE / independent of the
    // score floor, closing the high-similarity wrong-MERGE hole the floor cannot.
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'old weakness', metadata: { created_ms: 1000 }, score: 0.95 },
    ]);
    const judge = vi.fn(async () => [
      {
        new_index: 0,
        action: 'MERGE',
        old_index: 0,
        confidence: 0.95,
        reason: 'looks like the same error',
        merged_text: 'MERGED: should not be written',
      },
    ]);
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });
    await handler(
      makeJob({
        memories: [mem(newMemId, 'new weakness', 'weakness', 2000)],
        user_id: 'self',
      }) as never,
    );

    const rows = await loadLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('KEEP_BOTH');
    expect(rows[0].reason).toContain('Per-kind guard');
    expect(rows[0].reason).toContain('kind=weakness');
    expect(rows[0].reason).toContain('downgraded from MERGE');
    // Old weakness row keeps its history (not rewritten).
    const oldRows = (await db.execute(sql`
      SELECT payload->>'data' AS data FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${oldMemId}::uuid
    `)) as Array<{ data: string }>;
    expect(oldRows[0].data).toBe('old weakness');
  });
});

describe('reconcile handler — Q1 score floor passes a well-corroborated MERGE (regression)', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('score ≥ floor + confidence ≥ 0.6 → MERGE executes; structurally_corroborated=true', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${oldMemId}::uuid, ${JSON.stringify({ data: 'old text', user_id: 'self' })}::jsonb),
        (${newMemId}::uuid, ${JSON.stringify({ data: 'new text', user_id: 'self' })}::jsonb)
    `);
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'old text', metadata: { created_ms: 1000 }, score: 0.72 },
    ]);
    const judge = vi.fn(async () => [
      {
        new_index: 0,
        action: 'MERGE',
        old_index: 0,
        confidence: 0.9,
        reason: 'they overlap',
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

    const rows = await loadLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('MERGE'); // NOT downgraded
    expect(rows[0].llm_raw.structurally_corroborated).toBe(true);
    // MERGE actually applied: old row rewritten to merged_text, new row dropped.
    const oldRows = (await db.execute(sql`
      SELECT payload->>'data' AS data FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${oldMemId}::uuid
    `)) as Array<{ data: string }>;
    expect(oldRows[0].data).toBe('MERGED: prefers dark mode and terse feedback');
    const newRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${newMemId}::uuid`,
    )) as unknown[];
    expect(newRows).toHaveLength(0);
  });
});

describe('reconcile handler — Q1 RETRACT_NEW with no candidates skips the floor (m8)', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('empty candidates → gate abstains, logs "floor skipped (no score)", RETRACT executes', async () => {
    const db = testDb();
    const newMemId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload)
      VALUES (${newMemId}::uuid, ${JSON.stringify({ data: 'noise', user_id: 'self' })}::jsonb)
    `);
    // No search candidates → referencedScore undefined → floor skipped.
    const memoryClient = mockMemoryClient([]);
    const judge = vi.fn(async () => [
      { new_index: 0, action: 'RETRACT_NEW', old_index: null, confidence: 0.9, reason: 'noise' },
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = buildMemoryReconcileHandler(db, {
        memoryClient,
        judge: judge as never,
        collectionName: COLLECTION,
      });
      await handler(
        makeJob({ memories: [mem(newMemId, 'noise', 'event', 2000)], user_id: 'self' }) as never,
      );

      const skipLog = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes('score-floor skipped (no candidate score)'),
      );
      expect(skipLog).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }

    const rows = await loadLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('RETRACT_NEW'); // abstained gate → executes
    expect(rows[0].llm_raw.structurally_corroborated).toBe(true);
    const newRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${newMemId}::uuid`,
    )) as unknown[];
    expect(newRows).toHaveLength(0); // noise dropped
  });
});

describe('reconcile handler — F3 RETRACT_NEW keys strictly on the referenced candidate (no max borrow)', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('old_index candidate scoreless → abstains (RETRACT executes), floor skipped, referenced_score null; sibling 0.9 NOT borrowed', async () => {
    const db = testDb();
    const newMemId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const dupId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // referenced candidate (old_index=0), NO score
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload)
      VALUES (${newMemId}::uuid, ${JSON.stringify({ data: 'dup text', user_id: 'self' })}::jsonb)
    `);
    // Candidate 0 = the RETRACT target, carries NO score; candidate 1 carries a HIGH
    // score (0.9). The pre-F3 fallback (oldMem?.score ?? topCandidateScore) would
    // have borrowed candidate 1's 0.9 and passed the floor with a DEFINED score. F3
    // keys strictly on the referenced candidate (undefined) → abstain + m8 skip +
    // referenced_score null, and never borrows the sibling's score.
    const memoryClient = mockMemoryClient([
      { id: dupId, memory: 'the duplicate' /* no score */ },
      { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', memory: 'unrelated but scored', score: 0.9 },
    ]);
    const judge = vi.fn(async () => [
      {
        new_index: 0,
        action: 'RETRACT_NEW',
        old_index: 0,
        confidence: 0.9,
        reason: 'exact duplicate',
      },
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = buildMemoryReconcileHandler(db, {
        memoryClient,
        judge: judge as never,
        collectionName: COLLECTION,
      });
      await handler(
        makeJob({ memories: [mem(newMemId, 'dup text', 'event', 2000)], user_id: 'self' }) as never,
      );
      const skipLog = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes('score-floor skipped (no candidate score)'),
      );
      expect(skipLog).toBeDefined(); // proves it did NOT downgrade on a borrowed max
    } finally {
      warnSpy.mockRestore();
    }

    const rows = await loadLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('RETRACT_NEW'); // abstained (NOT downgraded)
    expect(rows[0].llm_raw.structurally_corroborated).toBe(true);
    expect(rows[0].llm_raw.referenced_score).toBeNull(); // did NOT borrow the sibling 0.9
    const newRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${newMemId}::uuid`,
    )) as unknown[];
    expect(newRows).toHaveLength(0); // retracted
  });
});

describe('reconcile handler — CR-4: out-of-range old_index (LLM hallucination) fail-safes to KEEP_BOTH', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('RETRACT_NEW with old_index=99 (unresolvable) → KEEP_BOTH; new memory NOT deleted', async () => {
    const db = testDb();
    const newMemId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const candId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload)
      VALUES (${newMemId}::uuid, ${JSON.stringify({ data: 'dup text', user_id: 'self' })}::jsonb)
    `);
    // One real candidate (index 0). The judge hallucinates old_index=99 — out of
    // range, so cands[99] is undefined. RETRACT_NEW is NOT in needsOldTarget, so
    // pre-CR-4 this bogus index slipped past badTarget and the new memory could be
    // hard-deleted on the top-score/abstain path. CR-4's invalidOldIndex guard
    // fail-safes it to KEEP_BOTH before any deletion decision.
    const memoryClient = mockMemoryClient([{ id: candId, memory: 'a neighbor', score: 0.9 }]);
    const judge = vi.fn(async () => [
      {
        new_index: 0,
        action: 'RETRACT_NEW',
        old_index: 99,
        confidence: 0.9,
        reason: 'hallucinated index',
      },
    ]);
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });
    await handler(
      makeJob({ memories: [mem(newMemId, 'dup text', 'event', 2000)], user_id: 'self' }) as never,
    );

    const rows = await loadLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('KEEP_BOTH'); // fail-safe downgrade
    expect(rows[0].reason).toContain('out-of-range index downgraded from RETRACT_NEW');
    expect(rows[0].prev_text).toBeNull(); // KEEP_BOTH captures no undo snapshot
    // The new memory row must still exist (NOT retracted on a hallucinated index).
    const newRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${newMemId}::uuid`,
    )) as unknown[];
    expect(newRows).toHaveLength(1);
  });
});

describe('reconcile handler — Q2b write-ahead prev_text/prev_metadata by action', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('SUPERSEDE → prev_text=oldMem.text, prev_metadata=old payload; captured write-ahead', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const oldPayload = { data: 'old canonical', user_id: 'self', kind: 'preference' };
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload)
      VALUES (${oldMemId}::uuid, ${JSON.stringify(oldPayload)}::jsonb)
    `);
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'old canonical', metadata: { created_ms: 1000 }, score: 0.8 },
    ]);
    const judge = vi.fn(async () => [
      { new_index: 0, action: 'SUPERSEDE', old_index: 0, confidence: 0.9, reason: 'newer' },
    ]);
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });
    await handler(
      makeJob({
        memories: [mem(newMemId, 'new canonical', 'preference', 2000)],
        user_id: 'self',
      }) as never,
    );

    const rows = await loadLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('SUPERSEDE');
    expect(rows[0].prev_text).toBe('old canonical');
    // Full payload snapshot (write-ahead: before softSupersede added markers).
    expect(rows[0].prev_metadata).toMatchObject(oldPayload);
    expect(rows[0].prev_metadata).not.toHaveProperty('superseded_by');
  });

  it('MERGE → prev_text=oldMem.text, prev_metadata=old payload BEFORE rewrite', async () => {
    const db = testDb();
    const newMemId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const oldMemId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const oldPayload = { data: 'old mergeable', user_id: 'self' };
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${oldMemId}::uuid, ${JSON.stringify(oldPayload)}::jsonb),
        (${newMemId}::uuid, ${JSON.stringify({ data: 'new mergeable', user_id: 'self' })}::jsonb)
    `);
    const memoryClient = mockMemoryClient([
      { id: oldMemId, memory: 'old mergeable', metadata: { created_ms: 1000 }, score: 0.8 },
    ]);
    const judge = vi.fn(async () => [
      {
        new_index: 0,
        action: 'MERGE',
        old_index: 0,
        confidence: 0.9,
        reason: 'overlap',
        merged_text: 'MERGED text',
      },
    ]);
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });
    await handler(
      makeJob({
        memories: [mem(newMemId, 'new mergeable', 'preference', 2000)],
        user_id: 'self',
      }) as never,
    );

    const rows = await loadLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('MERGE');
    // prev_text = the OLD row's original text (before it was rewritten to MERGED).
    expect(rows[0].prev_text).toBe('old mergeable');
    expect(rows[0].prev_metadata).toMatchObject({ data: 'old mergeable' });
    // Confirm the apply DID overwrite the live row — proving the snapshot pre-dates it.
    const oldRows = (await db.execute(sql`
      SELECT payload->>'data' AS data FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${oldMemId}::uuid
    `)) as Array<{ data: string }>;
    expect(oldRows[0].data).toBe('MERGED text');
  });

  it('RETRACT_NEW → prev_text=newMem.text, prev_metadata=null; KEEP_BOTH → both null', async () => {
    const db = testDb();
    const retractNewId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const keepNewId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${retractNewId}::uuid, ${JSON.stringify({ data: 'dup', user_id: 'self' })}::jsonb),
        (${keepNewId}::uuid, ${JSON.stringify({ data: 'distinct', user_id: 'self' })}::jsonb)
    `);
    const memoryClient = mockMemoryClient([]);
    const judge = vi.fn(async () => [
      { new_index: 0, action: 'RETRACT_NEW', old_index: null, confidence: 0.9, reason: 'dup' },
      { new_index: 1, action: 'KEEP_BOTH', old_index: null, confidence: 0.9, reason: 'distinct' },
    ]);
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: judge as never,
      collectionName: COLLECTION,
    });
    await handler(
      makeJob({
        memories: [
          mem(retractNewId, 'dup text', 'event', 2000),
          mem(keepNewId, 'distinct text', 'event', 2000),
        ],
        user_id: 'self',
      }) as never,
    );

    const rows = await loadLogRows();
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(byAction.RETRACT_NEW.prev_text).toBe('dup text'); // the DISCARDED new text
    expect(byAction.RETRACT_NEW.prev_metadata).toBeNull(); // event-sourced, not captured
    expect(byAction.KEEP_BOTH.prev_text).toBeNull();
    expect(byAction.KEEP_BOTH.prev_metadata).toBeNull();
  });
});

describe('reconcile handler — m7: destructive rows deferred when Mem0 client is unavailable', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('MERGE/RETRACT_NEW left applied_at IS NULL (old row unrewritten); SUPERSEDE still applies', async () => {
    const db = testDb();
    const mergeOld = '11111111-1111-1111-1111-111111111111';
    const mergeNew = '22222222-2222-2222-2222-222222222222';
    const retractNew = '33333333-3333-3333-3333-333333333333';
    const supOld = '44444444-4444-4444-4444-444444444444';
    const supNew = '55555555-5555-5555-5555-555555555555';
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${mergeOld}::uuid, ${JSON.stringify({ data: 'merge old', user_id: 'self' })}::jsonb),
        (${retractNew}::uuid, ${JSON.stringify({ data: 'retract dup', user_id: 'self' })}::jsonb),
        (${supOld}::uuid, ${JSON.stringify({ data: 'sup old', user_id: 'self' })}::jsonb)
    `);
    await insertPlannedRows(db, [
      makePlannedRow({
        user_id: 'self',
        new_memory_id: mergeNew,
        old_memory_id: mergeOld,
        action: 'MERGE',
        reason: 'm',
        llm_raw: { merged_text: 'MERGED', new_created_ms: 2000 },
        // YUK-557 (Q2b/F2): destructive rows carry their undo snapshot.
        prev_text: 'merge old',
      }),
      makePlannedRow({
        user_id: 'self',
        new_memory_id: retractNew,
        old_memory_id: null,
        action: 'RETRACT_NEW',
        reason: 'r',
        llm_raw: {},
        prev_text: 'retract dup',
      }),
      makePlannedRow({
        user_id: 'self',
        new_memory_id: supNew,
        old_memory_id: supOld,
        action: 'SUPERSEDE',
        reason: 's',
        llm_raw: { new_created_ms: 2000 },
        prev_text: 'sup old',
      }),
    ]);

    // Handler with NO injected memoryClient + injected collectionName. An empty
    // batch triggers ONLY the job-start replay (applyPlannedRows). The injected
    // createClient factory throws (CR-1), so getClientLazy() catches → getClient()
    // returns undefined (the m7 path) DETERMINISTICALLY — the branch no longer
    // depends on the shell env lacking ZHIPU/DASHSCOPE keys (a bare
    // createMemoryClient() would succeed on any machine that carries them).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = buildMemoryReconcileHandler(db, {
        judge: vi.fn() as never,
        collectionName: COLLECTION,
        createClient: () => {
          throw new Error('mem0 client unavailable (test)');
        },
      });
      await handler(makeJob({ memories: [], user_id: 'self' }) as never);
    } finally {
      warnSpy.mockRestore();
    }

    // MERGE + RETRACT_NEW rows remain unapplied; SUPERSEDE applied (no client needed).
    const unapplied = await loadUnappliedLog(db, 'self');
    expect(unapplied.map((r) => r.action).sort()).toEqual(['MERGE', 'RETRACT_NEW']);

    // MERGE old row NOT rewritten (rewriteMemoryText was NOT run — whole branch skipped).
    const mergeOldRows = (await db.execute(
      sql`SELECT payload->>'data' AS data FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${mergeOld}::uuid`,
    )) as Array<{ data: string }>;
    expect(mergeOldRows[0].data).toBe('merge old');
    // RETRACT_NEW row NOT deleted.
    const retractRows = (await db.execute(
      sql`SELECT id FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${retractNew}::uuid`,
    )) as unknown[];
    expect(retractRows).toHaveLength(1);
    // SUPERSEDE applied.
    const supRows = (await db.execute(
      sql`SELECT payload->>'superseded_by' AS sb FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${supOld}::uuid`,
    )) as Array<{ sb: string | null }>;
    expect(supRows[0].sb).toBe(supNew);
  });
});

describe('reconcile handler — M1: replay never overwrites the write-ahead prev snapshot', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('MERGE crash after rewrite before markApplied → replay keeps prev_text/prev_metadata original', async () => {
    const db = testDb();
    const oldId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const newId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    // Post-crash state: rewriteMemoryText already ran (old row shows a rewritten
    // value), new row already gone, but markApplied never fired. The write-ahead
    // snapshot was captured BEFORE the rewrite, so it must still be the ORIGINAL.
    const originalPayload = { data: 'original old text', user_id: 'self', kind: 'preference' };
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload)
      VALUES (${oldId}::uuid, ${JSON.stringify({ data: 'rewritten pre-crash', user_id: 'self' })}::jsonb)
    `);
    await insertPlannedRows(db, [
      makePlannedRow({
        user_id: 'self',
        new_memory_id: newId,
        old_memory_id: oldId,
        action: 'MERGE',
        reason: 'overlap',
        llm_raw: { merged_text: 'MERGED FINAL', new_created_ms: 2000 },
        prev_text: 'original old text',
        prev_metadata: originalPayload,
      }),
    ]);

    // Replay via empty-batch handler WITH a client so the MERGE branch runs.
    const memoryClient = mockMemoryClient([]);
    const handler = buildMemoryReconcileHandler(db, {
      memoryClient,
      judge: vi.fn() as never,
      collectionName: COLLECTION,
    });
    await handler(makeJob({ memories: [], user_id: 'self' }) as never);

    expect(await loadUnappliedLog(db, 'self')).toHaveLength(0); // now applied
    // The write-ahead snapshot is UNTOUCHED by apply/replay (captured once at
    // write-ahead; apply never re-captures — the M1 correctness invariant).
    const rows = await loadLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].prev_text).toBe('original old text');
    expect(rows[0].prev_metadata).toMatchObject(originalPayload);
    // The apply DID run (old row rewritten to merged_text), proving the snapshot
    // predates the mutation rather than mirroring the post-merge state.
    const oldRows = (await db.execute(
      sql`SELECT payload->>'data' AS data FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id = ${oldId}::uuid`,
    )) as Array<{ data: string }>;
    expect(oldRows[0].data).toBe('MERGED FINAL');
  });
});
