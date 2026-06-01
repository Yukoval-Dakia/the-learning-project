import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MistakeEnrollOutputT } from '@/core/schema/mistake_enroll';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import {
  event,
  knowledge,
  learning_record,
  learning_session,
  question,
  question_block,
} from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { runAutoEnrollForSession } from './auto-enroll';
import { revertAutoEnrolledBlock } from './revert-auto-enroll';

const FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED';

const highConfidenceTagging = async () => ({
  suggestions: [{ knowledge_id: 'k1', confidence: 0.95, reasoning: 'ok' }],
  overall_confidence: 0.95,
  reasoning: 'high',
});

const FAILURE_DRAFT: MistakeEnrollOutputT = {
  wrong_answer: 'failure',
  question_type: 'computation',
  difficulty: 3,
  cause: {
    primary_category: 'other',
    secondary_categories: [],
    analysis_md: 'drafted',
    confidence: 0.7,
  },
  overall_confidence: 0.66,
  reasoning: 'wrong',
};

function structured(prompt: string): StructuredQuestionT {
  return { id: createId(), role: 'standalone', prompt_text: prompt, source: 'vlm_structure' };
}

/** Seed a session + one answered draft block, then auto-enroll it (flag ON). */
async function seedAndAutoEnroll(
  db: ReturnType<typeof testDb>,
  draft: MistakeEnrollOutputT | 'unanswered',
): Promise<{ sessionId: string; blockId: string }> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'k1',
    name: '虚词',
    domain: 'wenyan',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const sessionId = createId();
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    status: 'extracted',
    source_document_id: createId(),
    source_asset_ids: ['asset_1'],
    entrypoint: 'vision_paper',
    warnings: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const blockId = createId();
  await db.insert(question_block).values({
    id: blockId,
    ingestion_session_id: sessionId,
    source_document_id: null,
    source_asset_ids: ['asset_1'],
    page_spans: [],
    structured: structured('下列句中「之」的用法'),
    reference_md: '参考',
    // 'unanswered' case: no captured answer → enroll stays unanswered.
    wrong_answer_md: draft === 'unanswered' ? null : '学生错答',
    figures: [],
    layout_quality: 'structured',
    image_refs: ['asset_1'],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 1,
    status: 'draft',
    knowledge_hint: '之',
    merged_from_block_ids: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });

  const result = await runAutoEnrollForSession({
    db,
    sessionId,
    subjectId: 'wenyan',
    env: { [FLAG]: 'true' },
    runTaggingFn: highConfidenceTagging,
    runMistakeEnrollFn: draft === 'unanswered' ? undefined : vi.fn(async () => draft),
  });
  expect(result.enrolled).toBe(1);
  return { sessionId, blockId };
}

describe('revertAutoEnrolledBlock', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('retracts a failure auto-enrollment: retract event + archived record + reset block + question kept', async () => {
    const db = testDb();
    const { blockId } = await seedAndAutoEnroll(db, FAILURE_DRAFT);

    // Precondition: block is auto_enrolled, an attempt + mistake record exist.
    const [before] = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(before.status).toBe('auto_enrolled');
    const attempt = (await db.select().from(event).where(eq(event.action, 'attempt')))[0];

    const res = await revertAutoEnrolledBlock(db, { blockId });

    // A CorrectEvent(retract) targets the attempt event.
    expect(res.retractedEventId).toBe(attempt.id);
    const [retract] = await db.select().from(event).where(eq(event.id, res.retractEventId));
    expect(retract.action).toBe('correct');
    expect(retract.subject_kind).toBe('event');
    expect(retract.subject_id).toBe(attempt.id);
    expect((retract.payload as { correction_kind?: string }).correction_kind).toBe('retract');

    // Record archived (not deleted).
    const [rec] = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.id, res.recordId));
    expect(rec.archived_at).not.toBeNull();

    // Block reset to draft, imported_* cleared.
    const [after] = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(after.status).toBe('draft');
    expect(after.imported_question_id).toBeNull();
    expect(after.imported_attempt_event_id).toBeNull();

    // Question row preserved (evidence-first, reusable).
    const q = await db.select().from(question).where(eq(question.id, res.questionId));
    expect(q).toHaveLength(1);
  });

  it('retracts an unanswered auto-enrollment against its capture event', async () => {
    const db = testDb();
    const { blockId } = await seedAndAutoEnroll(db, 'unanswered');

    const capture = (
      await db.select().from(event).where(eq(event.action, 'experimental:record_capture'))
    )[0];

    const res = await revertAutoEnrolledBlock(db, { blockId });

    expect(res.retractedEventId).toBe(capture.id);
    const [after] = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(after.status).toBe('draft');
    // No active record remains for the question.
    const active = await db
      .select()
      .from(learning_record)
      .where(
        and(eq(learning_record.question_id, res.questionId), isNull(learning_record.archived_at)),
      );
    expect(active).toHaveLength(0);
  });

  it('rejects reverting a non-auto_enrolled block (409)', async () => {
    const db = testDb();
    const now = new Date();
    const sessionId = createId();
    await db.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      status: 'extracted',
      source_document_id: createId(),
      source_asset_ids: [],
      entrypoint: 'vision_paper',
      warnings: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const blockId = createId();
    await db.insert(question_block).values({
      id: blockId,
      ingestion_session_id: sessionId,
      source_document_id: null,
      source_asset_ids: [],
      page_spans: [],
      structured: structured('q'),
      figures: [],
      layout_quality: 'structured',
      image_refs: [],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 1,
      status: 'draft', // not auto_enrolled
      knowledge_hint: null,
      merged_from_block_ids: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    await expect(revertAutoEnrolledBlock(db, { blockId })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects reverting a missing block (404)', async () => {
    const db = testDb();
    await expect(revertAutoEnrolledBlock(db, { blockId: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
