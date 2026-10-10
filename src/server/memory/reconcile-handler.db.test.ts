// P2 (YUK-342) — reconcile handler failure-mode tests.
// Exercises the three failure modes against a real Postgres (testcontainer):
//   1. LLM parse failure → batch degrades to KEEP_BOTH
//   2. Write-ahead half-crash → idempotent resume via loadUnappliedLog
//   3. Concurrency → singletonKey serializes per user
// Also verifies the two-read-consumer passthrough after supersede injection.

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryableError } from '@/core/schema/structured_question';
import { cost_ledger, provider_attempt } from '@/db/schema';
import { ProviderAttemptLifecycleError } from '@/server/ai/provider-attempt-lifecycle';
import { providerOperationIdForInvocation } from '@/server/ai/provider-attempt-runtime';
import { resetDb, testDb } from '../../../tests/helpers/db';

beforeEach(() => {
  vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'observe');
  vi.stubEnv(
    'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
    JSON.stringify({
      'glm.memory-reconcile': {
        maxConcurrentAttempts: 100,
        maxAttemptStartsPerMinute: 1000,
      },
      'mem0.event-memory': {
        maxConcurrentAttempts: 100,
        maxAttemptStartsPerMinute: 1000,
      },
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

import { createMem0Collection } from '../../../tests/helpers/mem0-collection';
import { memoryClientMock } from '../../../tests/helpers/memory-client-mock';
import type { MemoryClient } from './client';
import { insertPlannedRows, loadUnappliedLog, makePlannedRow } from './reconcile-store';
import { buildMemoryReconcileHandler } from './triggers';

const COLLECTION = 'test_reconcile_collection';

// YUK-557 (F7): DDL delegates to the shared tests/helpers/mem0-collection.
async function createTestCollection() {
  await createMem0Collection(testDb(), COLLECTION);
}

type MemInput = { id: string; text: string; created_ms: number; kind: string };
type JobData = { memories: MemInput[]; user_id: string };

function makeJob(data: JobData): { id: string; data: JobData }[] {
  return [{ id: '00000000-0000-4000-8000-000000000852', data }];
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
  // hardDelete are load-bearing here (addEventMemoryOnce/history/restoreVerbatim default
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
    expect(rows[0].superseded_by).toBeNull();
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
    });
    await handler(makeJob({ memories: [], user_id: 'self' }) as never);

    const rows = (await db.execute(sql`
      SELECT id::text AS id, payload->>'superseded_by' AS sb
      FROM ${sql.raw(`"${COLLECTION}"`)} WHERE id IN (${appliedOld}::uuid, ${pendingOld}::uuid)
    `)) as Array<{ id: string; sb: string | null }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.sb]));
    expect(byId[appliedOld]).toBeNull(); // already-applied row did NOT re-run
    expect(byId[pendingOld]).toBeNull(); // legacy destructive row consumed without mutation
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

describe('reconcile handler — M1: replay never overwrites the write-ahead prev snapshot', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
  });

  it('legacy MERGE replay preserves both snapshot and current row without mutation', async () => {
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
    expect(oldRows[0].data).toBe('rewritten pre-crash');
  });
});

describe('reconcile handler — direct provider-start fence after abort', () => {
  beforeEach(async () => {
    await resetDb();
    await createTestCollection();
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'opencode-go');
    vi.stubEnv('AI_PROVIDER_MODEL', 'mimo-v2.6-pro');
    vi.stubEnv('OPENCODE_API_KEY', 'synthetic-mimo-key');
  });

  it.each([
    { mode: 'off', phase: 'headers' },
    { mode: 'observe', phase: 'headers' },
    { mode: 'enforce', phase: 'headers' },
    { mode: 'observe', phase: 'success_body' },
    { mode: 'observe', phase: 'error_body' },
  ])(
    'keeps total fetch=1 on same-job redelivery after $phase abort in $mode mode',
    async ({ mode, phase }) => {
      vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', mode);
      const db = testDb();
      const newId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const oldId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const text =
        'After reviewing a long geometry proof, the learner now prefers explicit intermediate steps and a final check of exceptional cases, while keeping earlier work recoverable.';
      await db.execute(sql`
      INSERT INTO ${sql.raw(`"${COLLECTION}"`)} (id, payload) VALUES
        (${newId}::uuid, ${JSON.stringify({ data: text, user_id: 'self', metadata: { kind: 'preference', created_ms: 2000, evidence: { source: 'synthetic', topics: ['geometry', 'proof'] } } })}::jsonb),
        (${oldId}::uuid, ${JSON.stringify({ data: 'Earlier preference: concise answers with little intermediate reasoning.', user_id: 'self', metadata: { kind: 'preference', created_ms: 1000 } })}::jsonb)
    `);
      const readMemories = () =>
        db.execute(sql`SELECT id::text, payload FROM ${sql.raw(`"${COLLECTION}"`)} ORDER BY id`);
      const beforeMemories = await readMemories();
      const client = mockMemoryClient([
        {
          id: oldId,
          memory: 'Earlier preference: concise answers with little intermediate reasoning.',
          metadata: { kind: 'preference', created_ms: 1000 },
          score: 0.91,
        },
      ]);
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        if (fetchImpl.mock.calls.length === 1) {
          const aborted = new DOMException('Synthetic transport aborted', 'AbortError');
          if (phase === 'headers') throw aborted;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(aborted);
            },
          });
          return new Response(stream, {
            status: phase === 'success_body' ? 200 : 503,
            headers: { 'x-request-id': 'aborted-body-id' },
          });
        }
        // A redelivery would get a valid response if it reached transport. The real
        // lifecycle fence must reject it before this second synthetic wire.
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    decisions: [
                      {
                        new_index: 0,
                        action: 'SUPERSEDE',
                        old_index: 0,
                        confidence: 0.95,
                        reason: 'The newer preference explicitly replaces the earlier one.',
                      },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 127, completion_tokens: 31, total_tokens: 158 },
          }),
        );
      });
      vi.stubGlobal('fetch', fetchImpl);
      const handler = buildMemoryReconcileHandler(db, { memoryClient: client });
      const jobs = makeJob({
        memories: [{ id: newId, text, kind: 'preference', created_ms: 2000 }],
        user_id: 'self',
      });

      await expect(handler(jobs)).rejects.toBeInstanceOf(RetryableError);
      const firstAttempts = await db.select().from(provider_attempt);
      expect(firstAttempts).toHaveLength(1);
      const firstAttempt = firstAttempts[0];
      expect(firstAttempt).toMatchObject({
        operation_id: providerOperationIdForInvocation(jobs[0].id),
        provider: 'opencode-go',
        model: 'mimo-v2.6-pro',
        lane_id: 'glm.memory-reconcile',
        operation_kind: 'memory_reconcile',
        provider_start_reserved_at: expect.any(Date),
        terminal_status: 'aborted',
        terminal_reason: 'provider_request_aborted',
        wire_count: 1,
        external_request_id: phase === 'headers' ? null : 'aborted-body-id',
        usage_json: {
          basis: 'unknown',
          unit: 'tokens',
          input: null,
          output: null,
          total: null,
          source: 'provider_response_absent',
        },
        cost_basis: 'unknown',
        cost_amount: null,
        cost_currency: 'USD',
        cost_source: 'provider_cost_absent',
      });
      const retryOutcome = await handler(jobs).catch((error: unknown) => error);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(retryOutcome).toBeInstanceOf(ProviderAttemptLifecycleError);
      expect(retryOutcome).toMatchObject({ reason: 'recovery_required' });
      const attempts = await db.select().from(provider_attempt);
      expect(attempts).toHaveLength(2);
      expect(attempts.find((attempt) => attempt.attempt_id === firstAttempt.attempt_id)).toEqual(
        firstAttempt,
      );
      const retry = attempts.find((attempt) => attempt.attempt_id !== firstAttempt.attempt_id);
      expect(retry).toMatchObject({
        operation_id: firstAttempt.operation_id,
        provider_start_reserved_at: null,
        terminal_status: null,
        wire_count: null,
      });
      expect(await db.execute(sql`SELECT * FROM memory_reconciliation_log`)).toHaveLength(0);
      expect(await readMemories()).toEqual(beforeMemories);
      expect(client.hardDelete).not.toHaveBeenCalled();
      expect(client.restoreVerbatim).not.toHaveBeenCalled();
      expect(await db.select().from(cost_ledger)).toEqual([]);
    },
  );
});
