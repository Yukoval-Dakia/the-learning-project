import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLearningRecord,
  getLearningRecord,
  transitionLearningRecords,
  updateLearningRecord,
} from '@/kernel/records/queries';
import { resetDb, testDb } from '../../../tests/helpers/db';

describe('LearningRecord queries', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('allows exactly one concurrent writer and reports the stale CAS rejection', async () => {
    const created = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '原始',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
      create_capture_event: true,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const results = await Promise.allSettled([
        updateLearningRecord(testDb(), created.record.id, {
          version: 0,
          content_md: 'writer-a',
        }),
        updateLearningRecord(testDb(), created.record.id, {
          version: 0,
          content_md: 'writer-b',
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { code: 'conflict', status: 409 },
      });

      const current = await getLearningRecord(testDb(), created.record.id);
      expect(current?.version).toBe(1);
      expect(['writer-a', 'writer-b']).toContain(current?.content_md);
      expect(warn).toHaveBeenCalledWith(
        '[learning-record] mutation_rejected',
        expect.objectContaining({
          reason: 'stale_version',
          record_id: created.record.id,
          expected_version: 0,
          current_version: 1,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('retries a batch CAS race without exposing a partially committed failure', async () => {
    const first = await createLearningRecord(testDb(), {
      id: 'batch-race-a',
      kind: 'insight',
      content_md: 'first',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
    });
    const raced = await createLearningRecord(testDb(), {
      id: 'batch-race-z',
      kind: 'insight',
      content_md: 'before race',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
    });

    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL not set');
    const holder = postgres(url, { max: 1 });
    let releaseLock: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let signalAcquired: () => void = () => {};
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const holdLock = holder.begin(async (connection) => {
      await connection`select id from learning_record where id = ${first.record.id} for update`;
      signalAcquired();
      await released;
    });

    try {
      await acquired;
      const batch = transitionLearningRecords(
        testDb(),
        [first.record.id, raced.record.id],
        ['raw'],
        'linked',
      );

      const deadline = Date.now() + 5_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const rows = await testDb().execute<{ blocked: boolean }>(sql`
          select exists (
            select 1
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
          ) as blocked
        `);
        if (rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);

      await updateLearningRecord(testDb(), raced.record.id, {
        version: raced.record.version,
        content_md: 'concurrent writer won first',
      });
      releaseLock();
      await holdLock;

      await expect(batch).resolves.toBe(2);
      const current = await getLearningRecord(testDb(), raced.record.id);
      expect(current).toMatchObject({
        content_md: 'concurrent writer won first',
        processing_status: 'linked',
        version: 2,
      });
    } finally {
      releaseLock();
      await holdLock.catch(() => undefined);
      await holder.end({ timeout: 5 });
    }
  });
});
