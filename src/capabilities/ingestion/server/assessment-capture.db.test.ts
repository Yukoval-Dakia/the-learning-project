import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activateSubmissionCandidate } from '@/capabilities/practice/grading/server/judge/evaluate-submission';
import { installPracticeHost } from '@/capabilities/practice/public';
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
  source_document,
} from '@/db/schema';
import { getFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { readNativeMistakeEvidence } from '@/kernel/read-models/native-mistake-evidence';
import { issuanceRowToContract, revisionRowToContract } from '@/kernel/records/assessment-issuance';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createImageR2 } from '../jobs/ingestion-test-support';
import { captureIngestionOriginal, enrollNativeCapture } from './assessment-capture';
import { runRescue } from './rescue';
import { revertAutoEnrolledBlock } from './revert-auto-enroll';

const now = new Date('2026-10-05T01:00:00Z');
beforeAll(installPracticeHost);
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
  await db.insert(source_document).values({
    id: 'capture-document',
    source_asset_ids: ['capture-page'],
    provenance: { usage_policy: { derivation_policy: 'allow' } },
    created_at: now,
    updated_at: now,
    version: 0,
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
  // @invariant security: a mixed student-work capture retains its private original evidence and never publishes its whole page, foreign or unverified figure references; its own verified crop is published carrying a learner-handwriting marker
  // @fails-if capture publishes the whole page, a foreign or unverified figure, or a crop without its marker, drops its own verified crop, or rewrites/discards its private originals
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
    // Learner work no longer withholds the question's own crop; it travels with a marker.
    // The legacy ref states no judgment, so a capture crop reads as 'unknown'.
    expect({
      questionFigures: capturedQuestion.figures,
      frozenFigures: frozen.revision.structure.materials.filter((item) => item.kind === 'figure'),
      publicOriginalAssets: dto.materials.filter(
        (item) => item.kind === 'figure' || item.asset_id === 'capture-page',
      ),
      privatePageAssets: submission.group_evidence.map((item) => item.evidence.asset.asset_id),
    }).toEqual({
      questionFigures: [{ ...figure, contains_learner_handwriting: 'unknown' }],
      frozenFigures: [
        {
          material_id: expect.any(String),
          kind: 'figure',
          asset: { asset_id: 'capture-page-fig-0', digest: `sha256:${cropDigest}` },
          alt_text: 'figure (diagram)',
          contains_learner_handwriting: 'unknown',
        },
      ],
      publicOriginalAssets: [
        {
          material_id: expect.any(String),
          kind: 'figure',
          asset_id: 'capture-page-fig-0',
          alt_text: 'figure (diagram)',
          contains_learner_handwriting: 'unknown',
        },
      ],
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

  // @invariant security: per-question handwriting stays attempt evidence and never becomes the answer key
  // @fails-if the capture writes handwriting into reference/answers, drops the red mark, or the handwriting text fails to reach the response set
  it('keeps per-question handwriting as attempt evidence and out of the answer key', async () => {
    const db = testDb();
    const input = await fixture('');
    const structured = input.block.structured;
    if (!structured) throw new Error('missing fixture structure');
    const [block] = await db
      .insert(question_block)
      .values({
        ...input.block,
        id: 'handwriting-block',
        structured: {
          ...structured,
          student_answer_present: true,
          extraction_evidence: {
            handwriting: [
              {
                text: '7 × 6 = 42',
                bbox: { x: 0.12, y: 0.4, width: 0.3, height: 0.08 },
                red_ink: 'check',
                confidence: 0.9,
              },
            ],
          },
        },
        wrong_answer_md: '',
      })
      .returning();
    const capture = await captureIngestionOriginal(db, { ...input, block });
    if (!capture) throw new Error('missing handwriting capture');
    const [questionRow] = await db
      .select()
      .from(question)
      .where(eq(question.id, capture.questionId));
    expect({
      reference: questionRow?.reference_md,
      answers: questionRow?.structured?.answers,
    }).toEqual({ reference: '42', answers: undefined });
    expect(capture.request.response_set.entries).toMatchObject([
      { kind: 'text', text_md: '7 × 6 = 42' },
    ]);
    const [attempt] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    expect(
      attempt?.payload as {
        response_md?: string;
        ingestion?: { unit_captures?: unknown };
      },
    ).toMatchObject({ response_md: '7 × 6 = 42' });
    expect(
      (
        attempt?.payload as {
          ingestion?: { unit_captures?: unknown };
        }
      )?.ingestion?.unit_captures,
    ).toMatchObject([
      {
        entry_kind: 'text',
        state: 'answered',
        ink: null,
        red_ink_mark: 'check',
        trace: {
          source: 'handwriting_trace_v1',
          bbox: { x: 0.12, y: 0.4, width: 0.3, height: 0.08 },
          confidence: 0.9,
        },
      },
    ]);
    // Capture is evidence only; nothing was graded or committed to mastery.
    expect(await db.select().from(evaluation)).toHaveLength(0);
    expect(await db.select().from(mastery_state)).toHaveLength(0);
  });

  // @invariant security: detected handwriting with no readable per-question trace is explicit unknown, never omitted and never guessed
  // @fails-if the capture records every unit as omitted or fabricates a blank answer for the detected handwriting
  it('records detected handwriting without a trace as unknown rather than omitted', async () => {
    const db = testDb();
    const input = await fixture('');
    const structured = input.block.structured;
    if (!structured) throw new Error('missing fixture structure');
    const [block] = await db
      .insert(question_block)
      .values({
        ...input.block,
        id: 'unknown-handwriting-block',
        structured: { ...structured, student_answer_present: true },
        wrong_answer_md: '',
      })
      .returning();
    const capture = await captureIngestionOriginal(db, { ...input, block });
    if (!capture) throw new Error('missing unknown-handwriting capture');
    const [attempt] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    const unitCaptures = (
      attempt?.payload as { ingestion?: { unit_captures?: Array<{ state: string }> } }
    )?.ingestion?.unit_captures;
    expect(unitCaptures).toMatchObject([{ state: 'unknown' }]);
    expect(unitCaptures?.some((item) => item.state === 'omitted')).toBe(false);
    expect(await db.select().from(evaluation)).toHaveLength(0);
  });

  // @invariant data: a failed handwriting pass is explicit unknown evidence, never the same shape as "no handwriting"
  // @fails-if a trace failure records unit_captures as omitted (or creates a fake answered entry)
  it('records a failed handwriting pass as unknown with its reason', async () => {
    const db = testDb();
    const input = await fixture('');
    const structured = input.block.structured;
    if (!structured) throw new Error('missing fixture structure');
    const [block] = await db
      .insert(question_block)
      .values({
        ...input.block,
        id: 'failed-trace-block',
        structured: {
          ...structured,
          extraction_evidence: {
            handwriting_trace: { status: 'failed', reason: 'provider returned invalid JSON' },
          },
        },
        wrong_answer_md: '',
      })
      .returning();
    const capture = await captureIngestionOriginal(db, { ...input, block });
    if (!capture) throw new Error('missing failed-trace capture');
    const [attempt] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    const unitCaptures = (
      attempt?.payload as {
        ingestion?: { unit_captures?: Array<{ state: string; reason?: string }> };
      }
    )?.ingestion?.unit_captures;
    expect(unitCaptures).toMatchObject([{ state: 'unknown', reason: 'handwriting_trace_failed' }]);
    expect(unitCaptures?.some((item) => item.state === 'omitted')).toBe(false);
    expect(await db.select().from(evaluation)).toHaveLength(0);
  });

  // @invariant security: a whole photographed page never reaches learner-visible attempt evidence
  // @fails-if group evidence hands the learner a source page that may carry another question's handwriting, or the red mark is lost/graduated into a verdict
  it('withholds whole photographed pages from learner-visible attempt evidence', async () => {
    const db = testDb();
    const input = await fixture('43');
    const structured = input.block.structured;
    if (!structured) throw new Error('missing fixture structure');
    const [block] = await db
      .insert(question_block)
      .values({
        ...input.block,
        id: 'privacy-capture-block',
        structured: {
          ...structured,
          student_answer_present: true,
          extraction_evidence: {
            handwriting: [
              {
                text: '43',
                bbox: { x: 0.2, y: 0.5, width: 0.2, height: 0.06 },
                red_ink: 'cross',
              },
            ],
          },
        },
        wrong_answer_md: '',
      })
      .returning();
    const capture = await captureIngestionOriginal(db, { ...input, block });
    if (!capture) throw new Error('missing privacy capture');
    await admit(capture.questionId);
    expect(await enrollNativeCapture(db, { ...input, block })).not.toBeNull();
    const failures = await getFailureAttempts(db, { questionIds: [capture.questionId] });
    expect(failures).toHaveLength(1);
    const evidence = (await readNativeMistakeEvidence(db, failures)).get(
      failures[0]?.attempt_event_id ?? '',
    );
    expect(evidence?.wrong_answer_image_refs).toEqual([]);
    expect(evidence?.wrong_answer_md).toContain('43');
    expect(evidence?.wrong_answer_md).toContain('红笔标记：✗');
  });

  // @invariant data: a failed/absent handwriting pass can be re-run for one block without replacing its question text
  // @fails-if the rescue entry rewrites the prompt/answer key or fails to bump the block version with the new evidence
  it('re-runs handwriting trace for one block through the rescue entry', async () => {
    const db = testDb();
    const input = await fixture('');
    const [before] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, input.block.id));
    const result = await runRescue({
      db,
      r2: (await createImageR2()) as never,
      sessionId: input.block.ingestion_session_id,
      blockId: input.block.id,
      page: 0,
      strategy: 'handwriting_trace',
      runHandwritingTraceFn: async () => ({
        traces: [
          {
            leaf_index: 0,
            text: '42',
            red_mark: 'check',
            red_text: false,
            bbox: { page_index: 0, x: 0.2, y: 0.3, width: 0.2, height: 0.1 },
            confidence: 0.9,
          },
        ],
        unresolved: [],
        warnings: [],
      }),
    });
    expect(result.structured.extraction_evidence?.handwriting?.[0]).toMatchObject({
      text: '42',
      red_ink: 'check',
    });
    const [after] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, input.block.id));
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.extracted_prompt_md).toBe(before?.extracted_prompt_md);
    expect(after?.reference_md).toBe(before?.reference_md);
  });

  type TraceOut = Awaited<
    ReturnType<NonNullable<Parameters<typeof runRescue>[0]['runHandwritingTraceFn']>>
  >;
  const traceRow = (over: Partial<TraceOut['traces'][number]>): TraceOut['traces'][number] => ({
    leaf_index: 0,
    text: 'AB = 5',
    red_mark: 'cross',
    red_text: false,
    bbox: { page_index: 0, x: 0.2, y: 0.3, width: 0.2, height: 0.1 },
    confidence: 0.8,
    ...over,
  });
  // @invariant data: a rescued handwriting trace records only what the learner wrote — an observed-empty answer area is blank, model remarks stay evidence, and a block enrolled mid-call is never rewritten while its paid result is returned
  // @fails-if a no_handwriting leaf is captured as unknown, a model note reaches response_md or is dropped from evidence, or the trace write lands on a block that left draft (or drops paid_result)
  it.each([
    {
      name: 'an answer area the pass saw as empty is captured blank',
      trace: {
        traces: [],
        unresolved: [{ leaf_index: 0, cause: 'no_handwriting' as const, reason: 'no writing' }],
      },
      expectCapture: { response_md: '', unit_captures: [{ state: 'blank' }] },
    },
    {
      name: 'an older output naming the leaf without a cause stays unknown',
      trace: { traces: [], unresolved: [{ leaf_index: 0, reason: 'unreadable' }] },
      expectCapture: { response_md: '', unit_captures: [{ state: 'unknown' }] },
    },
    {
      name: 'the model note stays in evidence and out of the learner answer',
      trace: {
        traces: [traceRow({ note: 'the 7 on the hypotenuse is handwritten' })],
        unresolved: [],
      },
      expectNote: 'the 7 on the hypotenuse is handwritten',
      expectCapture: {
        response_md: 'AB = 5',
        unit_captures: [{ state: 'answered', red_ink_mark: 'cross' }],
      },
    },
    {
      name: 'a block enrolled during the paid call is refused and the trace is returned',
      trace: { traces: [traceRow({})], unresolved: [] },
      enrollDuringCall: true,
    },
  ])('$name', async (row) => {
    const db = testDb();
    const input = await fixture('');
    const [before] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, input.block.id));
    const rescue = runRescue({
      db,
      r2: (await createImageR2()) as never,
      sessionId: input.block.ingestion_session_id,
      blockId: input.block.id,
      page: 0,
      strategy: 'handwriting_trace',
      runHandwritingTraceFn: async () => {
        if (row.enrollDuringCall) {
          await db
            .update(question_block)
            .set({ status: 'auto_enrolled' })
            .where(eq(question_block.id, input.block.id));
        }
        return { ...row.trace, warnings: [], task_run_id: 'trace-run' };
      },
    });
    if (row.enrollDuringCall) {
      const refusal = await rescue.then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal).toMatchObject({
        code: 'block_not_rescuable',
        details: {
          paid_result: {
            task_run_id: 'trace-run',
            structured: { extraction_evidence: { handwriting: [{ text: 'AB = 5' }] } },
          },
        },
      });
      const [after] = await db
        .select()
        .from(question_block)
        .where(eq(question_block.id, input.block.id));
      expect({ version: after?.version, structured: after?.structured }).toEqual({
        version: before?.version,
        structured: before?.structured,
      });
      return;
    }
    await rescue;
    const [block] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, input.block.id));
    if (!block) throw new Error('rescued block missing');
    expect(block.structured?.extraction_evidence?.handwriting?.[0]?.note).toBe(row.expectNote);
    expect(await captureIngestionOriginal(db, { ...input, block })).not.toBeNull();
    const [attempt] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_attempt'));
    const payload = attempt?.payload as {
      response_md?: string;
      ingestion?: { unit_captures?: unknown };
    };
    expect({
      response_md: payload.response_md,
      unit_captures: payload.ingestion?.unit_captures,
    }).toMatchObject(row.expectCapture ?? {});
    expect(await db.select().from(evaluation)).toHaveLength(0);
  });
});
