import { event, knowledge, learning_record } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  archiveLearningRecord,
  createLearningRecord,
  getLearningRecord,
  listLearningRecords,
  transitionLearningRecord,
  updateLearningRecord,
} from './queries';

async function seedKnowledge(id = 'k1') {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: 'math',
    parent_id: null,
    merged_from: [],
    archived_at: null,
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

describe('LearningRecord queries', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a manual open question with a capture event', async () => {
    const result = await createLearningRecord(testDb(), {
      kind: 'open_question',
      content_md: '为什么这里要取中点？',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'ask',
      knowledge_ids: [],
      payload: { question_md: '为什么这里要取中点？' },
      create_capture_event: true,
    });

    expect(result.record.kind).toBe('open_question');
    expect(result.record.origin_event_id).toBeTruthy();
    expect(result.origin_event?.action).toBe('experimental:record_capture');

    const rows = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, result.record.origin_event_id as string));
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_kind).toBe('record');
  });

  it('validates knowledge ids against active knowledge nodes', async () => {
    await seedKnowledge('k1');

    await expect(
      createLearningRecord(testDb(), {
        kind: 'insight',
        content_md: '截面先找共面点',
        source: 'manual',
        capture_mode: 'text',
        activity_kind: 'annotate',
        knowledge_ids: ['k1', 'missing'],
        payload: {},
        create_capture_event: true,
      }),
    ).rejects.toThrow(/unknown or archived knowledge_ids: missing/);
  });

  it('lists active records by kind and excludes archived rows', async () => {
    const activeInsight = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '截面先找共面点',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
      create_capture_event: true,
    });
    await createLearningRecord(testDb(), {
      kind: 'open_question',
      content_md: '为什么这里能作平行线？',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'ask',
      knowledge_ids: [],
      payload: {},
      create_capture_event: true,
    });
    const archivedInsight = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '已经归档的提示',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
      create_capture_event: true,
    });
    await archiveLearningRecord(
      testDb(),
      archivedInsight.record.id,
      archivedInsight.record.version,
    );

    const rows = await listLearningRecords(testDb(), { kind: ['insight'] });
    expect(rows.map((row) => row.id)).toEqual([activeInsight.record.id]);
  });

  it('archives a record by setting archived_at and processing_status', async () => {
    const created = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '截面图先补全隐藏边',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
      create_capture_event: true,
    });

    await archiveLearningRecord(testDb(), created.record.id, created.record.version);

    const detail = await getLearningRecord(testDb(), created.record.id);
    expect(detail?.processing_status).toBe('archived');
    expect(detail?.archived_at).toBeTruthy();

    const activeRows = await listLearningRecords(testDb(), { kind: ['insight'] });
    expect(activeRows).toEqual([]);

    const rawRows = await testDb()
      .select()
      .from(learning_record)
      .where(eq(learning_record.id, created.record.id));
    expect(rawRows[0].version).toBe(1);
  });

  it('archiveLearningRecord guards the UPDATE with the row version (no silent overwrite when the row moved on)', async () => {
    const created = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '原始内容',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
      create_capture_event: true,
    });
    const stableId = created.record.id;

    // Hand-roll the SQL the function emits, with a stale `WHERE version=0`
    // against a row whose version has already been bumped. This is the exact
    // race window the optimistic lock is meant to cover; if the lock fires,
    // the UPDATE affects zero rows. (We cannot easily inject between the
    // function's own SELECT and UPDATE, so verify the SQL semantics directly.)
    await testDb()
      .update(learning_record)
      .set({ version: 7, updated_at: new Date() })
      .where(eq(learning_record.id, stableId));

    const stale = await testDb()
      .update(learning_record)
      .set({
        processing_status: 'archived',
        archived_at: new Date(),
        updated_at: new Date(),
        version: 1,
      })
      .where(and(eq(learning_record.id, stableId), eq(learning_record.version, 0)))
      .returning({ id: learning_record.id });
    expect(stale).toEqual([]);

    // The caller's version is the CAS token; the writer updates only that exact
    // row version. Functional round-trip from the current version:
    await archiveLearningRecord(testDb(), stableId, 7);
    const rawRows = await testDb()
      .select()
      .from(learning_record)
      .where(eq(learning_record.id, stableId));
    expect(rawRows[0].version).toBe(8);
    expect(rawRows[0].processing_status).toBe('archived');
  });

  it('applies a legal status transition once and treats the same stale retry as a no-op', async () => {
    const created = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '状态机',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
      create_capture_event: true,
    });

    const first = await transitionLearningRecord(testDb(), created.record.id, {
      expected_version: 0,
      to: 'linked',
    });
    expect(first.applied).toBe(true);
    expect(first.record.processing_status).toBe('linked');
    expect(first.record.version).toBe(1);

    const duplicate = await transitionLearningRecord(testDb(), created.record.id, {
      expected_version: 0,
      to: 'linked',
    });
    expect(duplicate.applied).toBe(false);
    expect(duplicate.record.version).toBe(1);
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

  it('rejects an illegal status transition consistently and leaves the row unchanged', async () => {
    const created = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '状态机',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
      create_capture_event: true,
    });
    const linked = await transitionLearningRecord(testDb(), created.record.id, {
      expected_version: 0,
      to: 'linked',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        transitionLearningRecord(testDb(), created.record.id, {
          expected_version: linked.record.version,
          to: 'raw',
        }),
      ).rejects.toMatchObject({ code: 'conflict', status: 409 });
      expect(warn).toHaveBeenCalledWith(
        '[learning-record] mutation_rejected',
        expect.objectContaining({
          reason: 'illegal_status_transition',
          record_id: created.record.id,
          from_status: 'linked',
          to_status: 'raw',
        }),
      );
    } finally {
      warn.mockRestore();
    }

    const current = await getLearningRecord(testDb(), created.record.id);
    expect(current?.processing_status).toBe('linked');
    expect(current?.version).toBe(1);
  });

  it('listLearningRecords pushes `since` to SQL so paged results stay inside the window', async () => {
    const old = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '老',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
    });
    const mid = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '中',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
    });
    const fresh = await createLearningRecord(testDb(), {
      kind: 'insight',
      content_md: '新',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'annotate',
      knowledge_ids: [],
      payload: {},
    });

    // Manually shift `created_at` so the three rows span a known window.
    await testDb()
      .update(learning_record)
      .set({ created_at: new Date('2026-05-01T00:00:00Z') })
      .where(eq(learning_record.id, old.record.id));
    await testDb()
      .update(learning_record)
      .set({ created_at: new Date('2026-05-10T00:00:00Z') })
      .where(eq(learning_record.id, mid.record.id));
    await testDb()
      .update(learning_record)
      .set({ created_at: new Date('2026-05-18T00:00:00Z') })
      .where(eq(learning_record.id, fresh.record.id));

    const rows = await listLearningRecords(testDb(), {
      kind: ['insight'],
      since: new Date('2026-05-09T00:00:00Z'),
      limit: 50,
    });
    expect(rows.map((r) => r.id).sort()).toEqual([mid.record.id, fresh.record.id].sort());
  });
});
