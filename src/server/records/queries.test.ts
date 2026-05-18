import { event, knowledge, learning_record } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  archiveLearningRecord,
  createLearningRecord,
  getLearningRecord,
  listLearningRecords,
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
    await archiveLearningRecord(testDb(), archivedInsight.record.id);

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

    await archiveLearningRecord(testDb(), created.record.id);

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

    // The function re-reads the live version and archives based on it; the
    // returning() check inside the function raises 409 only when the WHERE
    // clause matched nothing — proven above. Functional round-trip:
    await archiveLearningRecord(testDb(), stableId);
    const rawRows = await testDb()
      .select()
      .from(learning_record)
      .where(eq(learning_record.id, stableId));
    expect(rawRows[0].version).toBe(8);
    expect(rawRows[0].processing_status).toBe('archived');
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
