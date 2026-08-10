import { event } from '@/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memoryReconcileJobId, recoverMemoryReconcileHandoffs } from './memory-reconcile-handoff';
import {
  persistRecoveryCursor,
  readLatestRecoveryCursor,
} from './memory-reconcile-handoff-cursor-store';
import {
  MEMORY_RECONCILE_HANDOFF_ACTION,
  claimMemoryIngest,
  persistIngestCompleted,
} from './memory-reconcile-handoff-store';

type CandidateFixture = {
  readonly sourceId: string;
  readonly jobId: string;
  readonly dispatchSeq: string;
  readonly eventId: string;
};

function deterministicSendId(options: object): string | null {
  return 'id' in options && typeof options.id === 'string' ? options.id : null;
}

async function seedCandidates(count: number): Promise<readonly CandidateFixture[]> {
  const db = testDb();
  const jobIds = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    const sourceId = `cursor-${index.toString().padStart(3, '0')}`;
    const memory = {
      id: `memory-${sourceId}`,
      text: `fact ${index}`,
      created_ms: index,
      kind: 'event',
    };
    await claimMemoryIngest(db, sourceId);
    await persistIngestCompleted(db, {
      sourceEventId: sourceId,
      resolution: 'provider_result',
      memories: [memory],
      persistIntents: true,
    });
    jobIds.set(sourceId, memoryReconcileJobId(sourceId, [memory]));
  }
  const rows = await db
    .select({
      sourceId: event.subject_id,
      dispatchSeq: sql<string>`${event.dispatch_seq}::text`,
      eventId: event.id,
    })
    .from(event)
    .where(
      and(
        eq(event.action, MEMORY_RECONCILE_HANDOFF_ACTION),
        eq(sql<string>`${event.payload} ->> 'handoff_kind'`, 'ingest_completed'),
      ),
    )
    .orderBy(asc(event.dispatch_seq), asc(event.id));
  return rows.map((row) => {
    const jobId = jobIds.get(row.sourceId);
    if (!jobId) throw new Error(`missing seeded job id for ${row.sourceId}`);
    return { ...row, jobId };
  });
}

describe('memory reconcile durable recovery cursor', () => {
  beforeEach(resetDb);

  it.each(['observe', 'write'] as const)(
    'does not scan or persist a cursor in %s mode',
    async (mode) => {
      await seedCandidates(1);
      const send = vi.fn(async (_queue: string, _data: object, options: object) =>
        deterministicSendId(options),
      );

      await expect(recoverMemoryReconcileHandoffs(testDb(), { send }, mode)).resolves.toBe(0);

      expect(send).not.toHaveBeenCalled();
      expect(await readLatestRecoveryCursor(testDb())).toBeNull();
    },
  );

  it('appends every A to B to A cursor advancement and reads the newest A', async () => {
    const db = testDb();
    const first = {
      version: 1 as const,
      handoff_kind: 'recovery_cursor' as const,
      after_dispatch_seq: '10',
      after_event_id: 'candidate-a',
    };
    const second = { ...first, after_dispatch_seq: '11', after_event_id: 'candidate-b' };

    await persistRecoveryCursor(db, first);
    await persistRecoveryCursor(db, second);
    await persistRecoveryCursor(db, first);

    const rows = await db
      .select({ payload: event.payload, ingestAt: event.ingest_at })
      .from(event)
      .where(
        and(
          eq(event.action, MEMORY_RECONCILE_HANDOFF_ACTION),
          eq(sql<string>`${event.payload} ->> 'handoff_kind'`, 'recovery_cursor'),
        ),
      )
      .orderBy(asc(event.dispatch_seq), asc(event.id));
    expect(rows.map((row) => row.payload)).toEqual([first, second, first]);
    expect(rows.every((row) => row.ingestAt instanceof Date)).toBe(true);
    expect(await readLatestRecoveryCursor(db)).toEqual(first);
  });

  it('pages adjacent bigint dispatch positions above Number.MAX_SAFE_INTEGER exactly', async () => {
    const db = testDb();
    const fixtures = await seedCandidates(2);
    const first = fixtures[0];
    const second = fixtures[1];
    if (!first || !second) throw new Error('expected two cursor candidates');
    const highFirst = { ...first, dispatchSeq: '9007199254740992' };
    const highSecond = { ...second, dispatchSeq: '9007199254740993' };
    await db.execute(
      sql`UPDATE ${event} SET dispatch_seq = ${highFirst.dispatchSeq}::bigint
        WHERE ${event.id} = ${highFirst.eventId}`,
    );
    await db.execute(
      sql`UPDATE ${event} SET dispatch_seq = ${highSecond.dispatchSeq}::bigint
        WHERE ${event.id} = ${highSecond.eventId}`,
    );
    await persistRecoveryCursor(db, {
      version: 1,
      handoff_kind: 'recovery_cursor',
      after_dispatch_seq: highFirst.dispatchSeq,
      after_event_id: highFirst.eventId,
    });
    const send = vi.fn(async (_queue: string, _data: object, options: object) =>
      deterministicSendId(options),
    );

    await expect(recoverMemoryReconcileHandoffs(db, { send }, 'recover')).resolves.toBe(2);

    expect(send.mock.calls.map((call) => deterministicSendId(call[2]))).toEqual([
      highSecond.jobId,
      highFirst.jobId,
    ]);
    expect(await readLatestRecoveryCursor(db)).toEqual({
      version: 1,
      handoff_kind: 'recovery_cursor',
      after_dispatch_seq: highFirst.dispatchSeq,
      after_event_id: highFirst.eventId,
    });
  });

  it('advances across 200 failures, reaches candidate 201, and wraps without crossing its start', async () => {
    const db = testDb();
    const fixtures = await seedCandidates(201);
    const firstSend = vi.fn(async (_queue: string, _data: object, options: object) => {
      throw new Error(`persistent dispatch failure ${deterministicSendId(options)}`);
    });

    await expect(
      recoverMemoryReconcileHandoffs(db, { send: firstSend }, 'recover'),
    ).rejects.toThrow(/persistent dispatch failure/);

    expect(firstSend).toHaveBeenCalledTimes(200);
    const firstSweepLast = fixtures[199];
    const wrappedSweepLast = fixtures[198];
    if (!firstSweepLast || !wrappedSweepLast) throw new Error('expected 200 seeded candidates');
    const firstCursor = await readLatestRecoveryCursor(db);
    expect(firstCursor).toEqual({
      version: 1,
      handoff_kind: 'recovery_cursor',
      after_dispatch_seq: firstSweepLast.dispatchSeq,
      after_event_id: firstSweepLast.eventId,
    });
    const healthy = fixtures[200];
    if (!healthy) throw new Error('expected candidate 201');
    const secondSend = vi.fn(async (_queue: string, _data: object, options: object) => {
      const id = deterministicSendId(options);
      if (id === healthy.jobId) return id;
      throw new Error(`persistent dispatch failure ${id}`);
    });

    await expect(
      recoverMemoryReconcileHandoffs(db, { send: secondSend }, 'recover'),
    ).rejects.toThrow(/persistent dispatch failure/);

    expect(secondSend).toHaveBeenCalledTimes(200);
    expect(secondSend.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ id: healthy.jobId }));
    expect(
      secondSend.mock.calls.some((call) => deterministicSendId(call[2]) === fixtures[0]?.jobId),
    ).toBe(true);
    const secondCursor = await readLatestRecoveryCursor(db);
    expect(secondCursor).toEqual({
      version: 1,
      handoff_kind: 'recovery_cursor',
      after_dispatch_seq: wrappedSweepLast.dispatchSeq,
      after_event_id: wrappedSweepLast.eventId,
    });
  });

  it('caps successful dispatches at 50 and cursor records never become recovery candidates', async () => {
    const db = testDb();
    const fixtures = await seedCandidates(60);
    const send = vi.fn(async (_queue: string, _data: object, options: object) =>
      deterministicSendId(options),
    );

    await expect(recoverMemoryReconcileHandoffs(db, { send }, 'drain')).resolves.toBe(50);

    expect(send).toHaveBeenCalledTimes(50);
    const firstBatchLast = fixtures[49];
    if (!firstBatchLast) throw new Error('expected 50 seeded candidates');
    expect(await readLatestRecoveryCursor(db)).toEqual({
      version: 1,
      handoff_kind: 'recovery_cursor',
      after_dispatch_seq: firstBatchLast.dispatchSeq,
      after_event_id: firstBatchLast.eventId,
    });
    await expect(recoverMemoryReconcileHandoffs(db, { send }, 'drain')).resolves.toBe(10);
    expect(send).toHaveBeenCalledTimes(60);
    const cursorRows = await db
      .select({ ingestAt: event.ingest_at })
      .from(event)
      .where(
        and(
          eq(event.action, MEMORY_RECONCILE_HANDOFF_ACTION),
          eq(sql<string>`${event.payload} ->> 'handoff_kind'`, 'recovery_cursor'),
        ),
      );
    expect(cursorRows).toHaveLength(2);
    expect(cursorRows.every((row) => row.ingestAt instanceof Date)).toBe(true);
  });
});
