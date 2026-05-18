import { event, knowledge, learning_record } from '@/db/schema';
import { eq } from 'drizzle-orm';
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
});
