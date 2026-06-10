/**
 * Tests for enrollCapturedBlock — T-OC slice 1 generalized capture (YUK-145).
 *
 * Verifies the OC-3 routing table:
 *   - failure    → attempt(outcome='failure')   + learning_record(kind='mistake')
 *   - success    → attempt(outcome='success')   + learning_record(kind='worked_example')
 *   - partial    → attempt(outcome='partial')   + learning_record(kind='worked_example')
 *   - unanswered → NO attempt event             + learning_record(kind='open_question')
 *
 * And the ADR-0024 FSRS-semantics decision: a success capture writes NO
 * `review` event (FSRS schedule is never advanced from a capture).
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, knowledge, learning_record, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type EnrollOutcome, enrollCapturedBlock } from './enroll';

async function seedQuestion(db: ReturnType<typeof testDb>, knowledgeId: string): Promise<string> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: knowledgeId,
    name: `K-${knowledgeId}`,
    domain: 'wenyan',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const questionId = createId();
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: 'Q prompt',
    reference_md: null,
    knowledge_ids: [knowledgeId],
    difficulty: 3,
    source: 'vision_single',
    variant_depth: 0,
    figures: [],
    image_refs: ['asset_1'],
    structured: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return questionId;
}

function baseInput(questionId: string, outcome: EnrollOutcome) {
  return {
    questionId,
    outcome,
    answerMd: outcome === 'unanswered' ? '' : 'student answer',
    answerImageRefs: ['asset_ans'],
    knowledgeIds: ['k1'],
    imageRefs: ['asset_1'],
    captureMode: 'image' as const,
    sourceDocumentId: createId(),
    now: new Date(),
  };
}

describe('enrollCapturedBlock', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('failure → attempt(failure) + record(mistake), needsAttribution=true', async () => {
    const db = testDb();
    const questionId = await seedQuestion(db, 'k1');

    const result = await db.transaction((tx) =>
      enrollCapturedBlock(tx, baseInput(questionId, 'failure')),
    );

    expect(result.attemptEventId).not.toBeNull();
    expect(result.needsAttribution).toBe(true);

    const attempt = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.subject_id, questionId)));
    expect(attempt).toHaveLength(1);
    expect(attempt[0].id).toBe(result.attemptEventId);
    expect(attempt[0].subject_kind).toBe('question');
    expect(attempt[0].outcome).toBe('failure');
    expect((attempt[0].payload as Record<string, unknown>).generated_by).toBe('ingestion_capture');

    const record = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.id, result.recordId));
    expect(record[0].kind).toBe('mistake');
    expect(record[0].activity_kind).toBe('attempt');
    expect(record[0].attempt_event_id).toBe(result.attemptEventId);
    expect((record[0].payload as Record<string, unknown>).wrong_answer_md).toBe('student answer');
  });

  it('success → attempt(success) + record(worked_example), positive mastery evidence', async () => {
    const db = testDb();
    const questionId = await seedQuestion(db, 'k1');

    const result = await db.transaction((tx) =>
      enrollCapturedBlock(tx, baseInput(questionId, 'success')),
    );

    expect(result.attemptEventId).not.toBeNull();
    expect(result.needsAttribution).toBe(false);

    const attempt = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.subject_id, questionId)));
    expect(attempt).toHaveLength(1);
    expect(attempt[0].id).toBe(result.attemptEventId);
    expect(attempt[0].outcome).toBe('success');
    // referenced_knowledge_ids feeds the knowledge_mastery view (ADR-0012)
    expect((attempt[0].payload as Record<string, unknown>).referenced_knowledge_ids).toEqual([
      'k1',
    ]);

    const record = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.id, result.recordId));
    expect(record[0].kind).toBe('worked_example');
    expect(record[0].attempt_event_id).toBe(result.attemptEventId);
  });

  it('success writes NO review event — FSRS schedule is not advanced (ADR-0024)', async () => {
    const db = testDb();
    const questionId = await seedQuestion(db, 'k1');

    await db.transaction((tx) => enrollCapturedBlock(tx, baseInput(questionId, 'success')));

    const reviewEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, questionId)));
    expect(reviewEvents).toHaveLength(0);
  });

  it('partial → attempt(partial) + record(worked_example)', async () => {
    const db = testDb();
    const questionId = await seedQuestion(db, 'k1');

    const result = await db.transaction((tx) =>
      enrollCapturedBlock(tx, baseInput(questionId, 'partial')),
    );

    const attempt = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.subject_id, questionId)));
    expect(attempt).toHaveLength(1);
    expect(attempt[0].id).toBe(result.attemptEventId);
    expect(attempt[0].outcome).toBe('partial');
    const record = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.id, result.recordId));
    expect(record[0].kind).toBe('worked_example');
    expect(result.needsAttribution).toBe(false);
  });

  it('unanswered → NO attempt event; record(open_question) item-bank capture', async () => {
    const db = testDb();
    const questionId = await seedQuestion(db, 'k1');

    const result = await db.transaction((tx) =>
      enrollCapturedBlock(tx, baseInput(questionId, 'unanswered')),
    );

    expect(result.attemptEventId).toBeNull();
    expect(result.needsAttribution).toBe(false);

    // No attempt event on the question
    const attempts = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.subject_id, questionId)));
    expect(attempts).toHaveLength(0);

    // A capture provenance event was written (OC-5 evidence-first)
    const captureEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:record_capture'));
    expect(captureEvents).toHaveLength(1);
    expect(captureEvents[0].subject_kind).toBe('record');
    expect((captureEvents[0].payload as Record<string, unknown>).generated_by).toBe(
      'ingestion_capture',
    );

    const record = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.id, result.recordId));
    expect(record[0].kind).toBe('open_question');
    expect(record[0].attempt_event_id).toBeNull();
    expect(record[0].question_id).toBe(questionId);
    expect(record[0].origin_event_id).toBe(captureEvents[0].id);
  });

  // T-OC slice 3 (YUK-145, OC-5): the auto-enroll path passes
  // generatedBy='workflow_judge' so its events are distinguishable from
  // user-reviewed ('ingestion_capture') captures. See ADR-0026.
  it("generatedBy='workflow_judge' lands in the attempt event payload (slice 3)", async () => {
    const db = testDb();
    const questionId = await seedQuestion(db, 'k1');

    const result = await db.transaction((tx) =>
      enrollCapturedBlock(tx, {
        ...baseInput(questionId, 'success'),
        generatedBy: 'workflow_judge',
      }),
    );

    const attempt = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.subject_id, questionId)));
    expect(attempt).toHaveLength(1);
    expect((attempt[0].payload as Record<string, unknown>).generated_by).toBe('workflow_judge');

    const record = await db
      .select()
      .from(learning_record)
      .where(eq(learning_record.id, result.recordId));
    expect((record[0].payload as Record<string, unknown>).generated_by).toBe('workflow_judge');
  });

  it("generatedBy='workflow_judge' marks the unanswered capture provenance event (slice 3)", async () => {
    const db = testDb();
    const questionId = await seedQuestion(db, 'k1');

    await db.transaction((tx) =>
      enrollCapturedBlock(tx, {
        ...baseInput(questionId, 'unanswered'),
        generatedBy: 'workflow_judge',
      }),
    );

    const captureEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:record_capture'));
    expect(captureEvents).toHaveLength(1);
    expect((captureEvents[0].payload as Record<string, unknown>).generated_by).toBe(
      'workflow_judge',
    );
  });

  it("default provenance stays 'ingestion_capture' when generatedBy is omitted", async () => {
    const db = testDb();
    const questionId = await seedQuestion(db, 'k1');

    const result = await db.transaction((tx) =>
      enrollCapturedBlock(tx, baseInput(questionId, 'success')),
    );

    const attempt = await db
      .select()
      .from(event)
      .where(eq(event.id, result.attemptEventId as string));
    expect((attempt[0].payload as Record<string, unknown>).generated_by).toBe('ingestion_capture');
  });
});
