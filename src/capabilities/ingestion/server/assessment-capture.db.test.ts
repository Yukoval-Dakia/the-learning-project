import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSubmissionCandidate } from '@/capabilities/practice/server/judge/evaluate-submission';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  knowledge,
  learning_record,
  learning_session,
  mastery_state,
  material_fsrs_state,
  question,
  question_block,
  question_group_lifecycle,
  source_asset,
} from '@/db/schema';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { ImportBody } from '../api/import-schema';
import { captureIngestionOriginal, enrollNativeCapture } from './assessment-capture';
import { runAutoEnrollForSession } from './auto-enroll';
import { completeIngestionImport } from './import-completion';
import { revertAutoEnrolledBlock } from './revert-auto-enroll';

const now = new Date('2026-10-05T01:00:00Z');
beforeEach(resetDb);
async function fixture(answer = '42') {
  const db = testDb();
  await db.insert(knowledge).values({
    id: 'capture-kc',
    name: '整数计算',
    domain: 'math',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(source_asset).values({
    id: 'capture-page',
    kind: 'image',
    storage_key: 'offline/page',
    mime_type: 'image/png',
    byte_size: 4096,
    sha256: 'a'.repeat(64),
    created_at: now,
  });
  await db.insert(learning_session).values({
    id: 'capture-session',
    type: 'ingestion',
    status: 'extracted',
    entrypoint: 'vision_paper',
    source_document_id: 'capture-document',
    source_asset_ids: ['capture-page'],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const [block] = await db
    .insert(question_block)
    .values({
      id: 'capture-block',
      ingestion_session_id: 'capture-session',
      extracted_prompt_md:
        'A multi-line calculation:\nGiven 6 groups of 7 objects, find their total.\nKeep the original page for checking the written work.',
      structured: {
        id: 'capture-part',
        role: 'standalone',
        source: 'vlm_structure',
        prompt_text:
          'A multi-line calculation:\nGiven 6 groups of 7 objects, find their total.\nKeep the original page for checking the written work.',
      },
      reference_md: '42',
      wrong_answer_md: answer,
      source_asset_ids: ['capture-page'],
      figures: [],
      image_refs: [],
      status: 'draft',
      extraction_confidence: 1,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .returning();
  return {
    block,
    knowledgeIds: ['capture-kc'],
    difficulty: 3,
    confidence: 1,
    canEnroll: true,
    pageRefs: ['capture-page'],
    now,
  };
}
async function admit(questionId: string) {
  const result = await publishQuestionGroupFromRow(testDb(), {
    rootId: questionId,
    actorRef: 'test:offline-capture-admission',
    now,
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
  });
  expect(result.status).toBe('admission_updated');
}

describe('native ingestion originals and reversible enrollment', () => {
  it('persists a withheld original once with trusted image metadata and no learning effects', async () => {
    const input = await fixture();
    expect(await enrollNativeCapture(testDb(), input)).toBeNull();
    expect(await enrollNativeCapture(testDb(), input)).toBeNull();
    const submissions = await testDb().select().from(assessment_submission);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].response_set.entries).toEqual([
      expect.objectContaining({ text_md: '42' }),
    ]);
    expect(submissions[0].group_evidence).toEqual([
      expect.objectContaining({
        evidence: expect.objectContaining({
          asset: { asset_id: 'capture-page', digest: `sha256:${'a'.repeat(64)}` },
          bytes: 4096,
          mime_type: 'image/png',
        }),
      }),
    ]);
    expect(await testDb().select().from(assessment_issuance)).toHaveLength(1);
    expect(await testDb().select().from(learning_record)).toHaveLength(0);
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    const [block] = await testDb().select().from(question_block);
    expect(block).toMatchObject({
      status: 'draft',
      imported_question_id: null,
      imported_attempt_event_id: null,
    });
    const originals = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({
      outcome: null,
      payload: { response_md: '42', entry: 'ingestion_grading' },
    });
  });

  it('retries against the original revision after a later publication', async () => {
    const input = await fixture();
    const original = await captureIngestionOriginal(testDb(), input);
    if (!original) throw new Error('capture missing');
    const [before] = await testDb().select().from(assessment_submission);
    await testDb()
      .update(question)
      .set({ reference_md: '43' })
      .where(eq(question.id, original.questionId));
    await publishQuestionGroupFromRow(testDb(), {
      rootId: original.questionId,
      actorRef: 'test:later-publication',
      now,
    });
    const [lifecycle] = await testDb().select().from(question_group_lifecycle);
    expect(lifecycle.current_revision_id).not.toBe(before.revision_id);
    const replay = await captureIngestionOriginal(testDb(), input);
    expect(replay?.request).toEqual(original.request);
    expect(await testDb().select().from(assessment_submission)).toEqual([before]);
    expect(await testDb().select().from(assessment_issuance)).toHaveLength(1);
  });

  it('rejects answer pages outside the source block before persisting a capture', async () => {
    const input = await fixture();
    await expect(
      captureIngestionOriginal(testDb(), {
        ...input,
        pageRefs: ['unrelated-page'],
      }),
    ).rejects.toMatchObject({ code: 'capture_asset_mismatch' });
    expect(await testDb().select().from(assessment_submission)).toHaveLength(0);
    expect(await testDb().select().from(question)).toHaveLength(0);
  });

  it('admitted deterministic capture updates theta without FSRS, then retracts atomically and refuses late activation', async () => {
    const input = await fixture();
    const capture = await captureIngestionOriginal(testDb(), input);
    expect(capture).not.toBeNull();
    if (!capture) throw new Error('missing capture');
    await admit(capture.questionId);
    const result = await enrollNativeCapture(testDb(), input);
    expect(await testDb().select().from(evaluation)).toMatchObject([
      { status: 'completed', aggregate: { kind: 'points_total' } },
    ]);
    expect(result).not.toBeNull();
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    const masteryBefore = await testDb().select().from(mastery_state);
    expect(masteryBefore.find((row) => row.subject_id === 'capture-kc')?.evidence_count).toBe(1);
    const [before] = await testDb().select().from(evaluation_effective_head);
    expect(before.effective_evaluation_id).toBeTruthy();
    const [record] = await testDb().select().from(learning_record);
    expect(record).toMatchObject({
      kind: 'worked_example',
      attempt_event_id: result?.attempt_event_id,
    });
    expect(await testDb().select().from(event).where(eq(event.action, 'attempt'))).toHaveLength(0);
    await revertAutoEnrolledBlock(testDb(), {
      blockId: input.block.id,
      sessionId: input.block.ingestion_session_id,
    });
    const masteryAfter = await testDb().select().from(mastery_state);
    expect(masteryAfter.find((row) => row.subject_id === 'capture-kc')?.evidence_count ?? 0).toBe(
      0,
    );
    const [after] = await testDb().select().from(evaluation_effective_head);
    expect(after).toMatchObject({
      effective_evaluation_id: null,
      generation: before.generation + 1,
    });
    const [reverted] = await testDb().select().from(question_block);
    expect(reverted).toMatchObject({
      status: 'draft',
      imported_question_id: null,
      imported_attempt_event_id: null,
    });
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    if (!before.effective_evaluation_id) throw new Error('missing candidate');
    const late = await activateSubmissionCandidate(
      testDb(),
      {
        evaluation_id: before.effective_evaluation_id,
        expected_effective_id: null,
        expected_generation: after.generation,
      },
      { actorRef: 'test:late', allowCapturedOriginal: true },
    );
    expect(late.status).toBe('occurrence_withdrawn');
  });

  it('withdrawal replays a later overlapping capture without restoring the withdrawn evidence', async () => {
    const input = await fixture('43');
    const first = await captureIngestionOriginal(testDb(), input);
    if (!first) throw new Error('missing capture');
    await admit(first.questionId);
    expect(await enrollNativeCapture(testDb(), input)).not.toBeNull();
    const laterAt = new Date(now.getTime() + 86_400_000);
    const [laterBlock] = await testDb()
      .insert(question_block)
      .values({
        ...input.block,
        id: 'later-capture-block',
        wrong_answer_md: '42',
        created_at: laterAt,
        updated_at: laterAt,
      })
      .returning();
    const laterInput = { ...input, block: laterBlock, now: laterAt };
    const second = await captureIngestionOriginal(testDb(), laterInput);
    if (!second) throw new Error('missing later capture');
    await admit(second.questionId);
    expect(await enrollNativeCapture(testDb(), laterInput)).not.toBeNull();
    const before = await testDb().select().from(mastery_state);
    expect(before.find((row) => row.subject_id === 'capture-kc')?.evidence_count).toBe(2);
    await revertAutoEnrolledBlock(testDb(), {
      blockId: input.block.id,
      sessionId: input.block.ingestion_session_id,
    });
    const after = await testDb().select().from(mastery_state);
    expect(after.find((row) => row.subject_id === 'capture-kc')).toMatchObject({
      evidence_count: 1,
      success_count: 1,
    });
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    const receipts = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect(receipts.filter((row) => row.payload.replay_of)).toHaveLength(1);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(2);
  });

  it('a block edit cannot finalize an older captured original', async () => {
    const input = await fixture();
    const captured = await captureIngestionOriginal(testDb(), input);
    if (!captured) throw new Error('missing capture');
    await admit(captured.questionId);
    await testDb()
      .update(question_block)
      .set({ version: 1, wrong_answer_md: 'Revised answer with a different explanation' })
      .where(eq(question_block.id, input.block.id));
    expect(await enrollNativeCapture(testDb(), input)).toBeNull();
    expect(await testDb().select().from(learning_record)).toHaveLength(0);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
  });

  it('an untrusted route decision preserves originals but cannot enroll even after admission', async () => {
    const input = await fixture();
    const captured = await captureIngestionOriginal(testDb(), input);
    if (!captured) throw new Error('missing capture');
    await admit(captured.questionId);
    expect(await enrollNativeCapture(testDb(), { ...input, canEnroll: false })).toBeNull();
    expect(await testDb().select().from(learning_record)).toHaveLength(0);
    const [lifecycle] = await testDb().select().from(question_group_lifecycle);
    expect(lifecycle.scoring_admission_state).toBe('admitted');
    const [q] = await testDb().select().from(question);
    expect(q.draft_status).toBe('draft');
  });
});

describe('auto-enroll native entry routing', () => {
  it('text capture never uses drafted correctness and keeps an unadmitted original for review', async () => {
    const input = await fixture('42');
    const draft = vi.fn();
    const run = () =>
      runAutoEnrollForSession({
        db: testDb(),
        sessionId: input.block.ingestion_session_id,
        subjectId: 'math',
        env: { WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: 'true' },
        tagKnowledgeFn: async () => ({ kind: 'match', knowledge_ids: input.knowledgeIds }),
        runMistakeEnrollFn: draft,
      });
    expect(await run()).toMatchObject({ enrolled: 0, routed_to_review: 1 });
    expect(await run()).toMatchObject({ enrolled: 0, routed_to_review: 1 });
    expect(draft).not.toHaveBeenCalled();
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
    expect(await testDb().select().from(learning_record)).toHaveLength(0);
  });

  it.each(['tencent_ocr', 'glm_ocr'] as const)(
    'photo-only %s work is retained without OCR text or invented grades',
    async (source) => {
      const input = await fixture('');
      await testDb()
        .update(question_block)
        .set({
          structured: {
            id: 'photo-leaf',
            role: 'standalone',
            prompt_text:
              'Read the equation and explain each step. The page contains handwritten working.',
            source,
            ...(source === 'tencent_ocr'
              ? {
                  extraction_evidence: {
                    handwriting: [
                      { text: 'untrusted OCR hint', bbox: { x: 0, y: 0, width: 0.1, height: 0.1 } },
                    ],
                  },
                }
              : {}),
          },
        })
        .where(eq(question_block.id, input.block.id));
      const result = await runAutoEnrollForSession({
        db: testDb(),
        sessionId: input.block.ingestion_session_id,
        subjectId: 'math',
        env: {
          WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: 'true',
          WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED: 'true',
        },
        tagKnowledgeFn: async () => ({ kind: 'match', knowledge_ids: input.knowledgeIds }),
      });
      expect(result).toMatchObject({ enrolled: 0, routed_to_review: 1 });
      const [original] = await testDb().select().from(assessment_submission);
      expect(original.group_evidence[0].evidence.asset.asset_id).toBe('capture-page');
      expect(JSON.stringify(original.response_set)).not.toContain('untrusted OCR hint');
      expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    },
  );
});

describe('human review of captured originals', () => {
  it.each([false, true])(
    'preserves pending originals when human import edited=%s',
    async (edited) => {
      const input = await fixture();
      const captured = await captureIngestionOriginal(testDb(), input);
      if (!captured) throw new Error('missing capture');
      const prompt = input.block.structured?.prompt_text ?? input.block.extracted_prompt_md;
      const result = await completeIngestionImport(
        testDb(),
        input.block.ingestion_session_id,
        ImportBody.parse({
          blocks: [
            {
              block_id: input.block.id,
              source_block_ids: [input.block.id],
              page_spans: [
                { page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' },
              ],
              image_refs: [],
              final_prompt_md: edited ? `${prompt}\nHuman clarification.` : prompt,
              final_reference_md: '42',
              final_wrong_answer_md: '42',
              outcome: 'success',
              knowledge_ids: input.knowledgeIds,
              cause: null,
              difficulty: 3,
              question_kind: 'short_answer',
            },
          ],
        }),
      );
      expect(result.question_ids[0] === captured.questionId).toBe(!edited);
      expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
      const [human] = await testDb().select().from(event).where(eq(event.action, 'attempt'));
      expect(human).toMatchObject({
        outcome: 'success',
        payload: { generated_by: 'ingestion_capture' },
      });
      expect(await enrollNativeCapture(testDb(), input)).toBeNull();
    },
  );
});
