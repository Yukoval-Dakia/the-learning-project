import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { installPracticeHost } from '@/capabilities/practice/public';
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
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runAutoEnrollForSession } from './auto-enroll';
import { enrollCapturedBlock } from './enroll';
import { revertAutoEnrolledBlock } from './revert-auto-enroll';

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
    domain: 'yuwen',
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

  // Preserve regression coverage for historical pre-native auto-enroll rows.
  if (draft !== 'unanswered') {
    await db.transaction(async (tx) => {
      const qid = createId();
      await tx.insert(question).values({
        id: qid,
        kind: 'short_answer',
        prompt_md: 'Historical captured prompt',
        reference_md: '参考',
        source: 'vision_paper',
        knowledge_ids: ['k1'],
        difficulty: 3,
        created_at: now,
        updated_at: now,
        version: 0,
      });
      const captured = await enrollCapturedBlock(tx, {
        questionId: qid,
        outcome: 'failure',
        answerMd: '学生错答',
        answerImageRefs: [],
        imageRefs: ['asset_1'],
        knowledgeIds: ['k1'],
        captureMode: 'image',
        sourceDocumentId: '',
        now,
        generatedBy: 'workflow_judge',
      });
      await tx
        .update(question_block)
        .set({
          status: 'auto_enrolled',
          imported_question_id: qid,
          imported_attempt_event_id: captured.attemptEventId,
        })
        .where(eq(question_block.id, blockId));
    });
    return { sessionId, blockId };
  }
  const result = await runAutoEnrollForSession({
    db,
    sessionId,
    subjectId: 'yuwen',
    // P3 (YUK-489): the ENROLL path tags via the unified `tagKnowledge` (embedding
    // match-or-propose); inject a stub that MATCHes the seeded KC so no real embedding
    // model is called.
    tagKnowledgeFn: async () => ({ kind: 'match' as const, knowledge_ids: ['k1'] }),
  });
  expect(result.enrolled).toBe(1);
  return { sessionId, blockId };
}

describe('revertAutoEnrolledBlock', () => {
  beforeAll(installPracticeHost);
  beforeEach(async () => {
    await resetDb();
  });

  it('retracts a failure auto-enrollment: retract event + archived record + reset block + question kept', async () => {
    const db = testDb();
    const { sessionId, blockId } = await seedAndAutoEnroll(db, FAILURE_DRAFT);

    // Precondition: block is auto_enrolled, an attempt + mistake record exist.
    const [before] = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(before.status).toBe('auto_enrolled');
    const attempt = (await db.select().from(event).where(eq(event.action, 'attempt')))[0];

    const res = await revertAutoEnrolledBlock(db, { blockId, sessionId });

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
});
