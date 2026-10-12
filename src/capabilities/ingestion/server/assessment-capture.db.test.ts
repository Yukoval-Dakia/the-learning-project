import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { activateSubmissionCandidate } from '@/capabilities/practice/server/judge/evaluate-submission';
import { projectPracticeIssuance } from '@/core/schema/assessment';
import type { FigureRefT } from '@/core/schema/structured_question';
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
  question_revision,
  source_asset,
} from '@/db/schema';
import { issuanceRowToContract, revisionRowToContract } from '@/kernel/records/assessment-issuance';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { captureIngestionOriginal, enrollNativeCapture } from './assessment-capture';
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
  // @invariant security: a mixed student-work capture retains its private original evidence without publishing its student, foreign or unverified figure references
  // @fails-if capture publishes the mixed block's original figures or rewrites/discards its private originals; public figure exclusion or original source/evidence retention fails
  it('keeps one mixed student-work capture private without changing its originals', async () => {
    const db = testDb();
    const input = await fixture();
    const cropBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4DwYMEAoAU7oL9W/sIDEAAAAASUVORK5CYII=',
      'base64',
    );
    const cropDigest = createHash('sha256').update(cropBytes).digest('hex');
    await db.insert(source_asset).values(
      ['capture-page-fig-0', 'foreign-page-fig-0'].map((id) => ({
        id,
        kind: 'image' as const,
        storage_key: `figures/${id}.png`,
        mime_type: 'image/png',
        byte_size: cropBytes.length,
        sha256: cropDigest,
        created_at: now,
      })),
    );
    const figure: FigureRefT = {
      asset_id: 'capture-page-fig-0',
      role: 'diagram',
      source_page_index: 0,
      source_bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      attached_to_index: 'capture-part',
      attach_confidence: 'manual',
    };
    const structured = input.block.structured;
    if (!structured) throw new Error('missing fixture structure');
    const [block] = await db
      .insert(question_block)
      .values({
        ...input.block,
        id: 'mixed-block',
        structured: {
          ...structured,
          student_answer_present: true,
          extraction_evidence: {
            handwriting: [{ text: 'private student answer', bbox: figure.source_bbox }],
          },
        },
        figures: [
          figure,
          { ...figure, asset_id: 'foreign-page-fig-0' },
          { ...figure, asset_id: 'capture-page-fig-1' },
        ],
      })
      .returning();
    const originalAssets = await db.select().from(source_asset).orderBy(source_asset.id);
    const capture = await captureIngestionOriginal(db, { ...input, block });
    if (!capture) throw new Error('missing mixed capture');
    const [capturedQuestion] = await db
      .select()
      .from(question)
      .where(eq(question.id, capture.questionId));
    const [frozen] = await db
      .select({ issuance: assessment_issuance, revision: question_revision })
      .from(assessment_issuance)
      .innerJoin(
        question_revision,
        eq(question_revision.revision_id, assessment_issuance.revision_id),
      )
      .where(eq(assessment_issuance.issuance_id, capture.request.issuance_id));
    const [submission] = await db
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, capture.request.submission_id));
    if (!capturedQuestion || !frozen || !submission)
      throw new Error('missing persisted mixed capture');
    const dto = projectPracticeIssuance(
      revisionRowToContract(frozen.revision),
      issuanceRowToContract(frozen.issuance),
    );
    expect({
      questionFigures: capturedQuestion.figures,
      frozenFigures: frozen.revision.structure.materials.filter((item) => item.kind === 'figure'),
      publicOriginalAssets: dto.materials.filter(
        (item) => item.kind === 'figure' || item.asset_id === 'capture-page',
      ),
      privatePageAssets: submission.group_evidence.map((item) => item.evidence.asset.asset_id),
    }).toEqual({
      questionFigures: [],
      frozenFigures: [],
      publicOriginalAssets: [],
      privatePageAssets: ['capture-page'],
    });
    expect(await db.select().from(question_block).where(eq(question_block.id, block.id))).toEqual([
      block,
    ]);
    expect(await db.select().from(source_asset).orderBy(source_asset.id)).toEqual(originalAssets);
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
});
