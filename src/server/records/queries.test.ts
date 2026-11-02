import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLearningRecord,
  getLearningRecord,
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
});
