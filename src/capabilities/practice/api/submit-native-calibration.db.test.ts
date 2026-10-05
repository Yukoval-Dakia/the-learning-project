import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  difficulty_calibration_label,
  evaluation,
  evaluation_effective_head,
  event,
  item_family_calibration,
  knowledge,
  mastery_state,
  material_fsrs_state,
  practice_stream_item,
  question,
} from '@/db/schema';
import * as recalibration from '@/server/mastery/recalibration';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { recordAssistanceExposure } from '../server/assessment/assistance';
import {
  activateSubmissionCandidate,
  evaluateSubmission,
} from '../server/judge/evaluate-submission';
import { recordSelectionObservation } from '../server/selection-observations';
import { createAttempt } from './submit';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
async function fixture(knowledgeId = `kc_${createId()}`) {
  const db = testDb();
  const id = createId();
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id: knowledgeId,
      name: '坡度与流速',
      domain: 'physics',
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
  await db
    .insert(question)
    .values({
      id,
      kind: 'choice',
      prompt_md: '水量和坡面相同，哪项反映实验控制变量？',
      reference_md: 'A',
      choices_md: ['固定水量，只改变坡度', '同时改变水量和坡度'],
      knowledge_ids: [knowledgeId],
      difficulty: 3,
      source: 'manual',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  const streamId = `stream_${id}`;
  await db
    .insert(practice_stream_item)
    .values({
      id: streamId,
      date: '2026-10-04',
      position: 0,
      item_kind: 'question',
      ref_id: id,
      source: 'decay',
      status: 'in_progress',
      reasoning: 'native calibration fixture',
      added_by: 'composer_live',
      signals: {},
      created_at: now,
      updated_at: now,
    });
  await recordSelectionObservation(db, {
    date: '2026-10-04',
    streamItemId: streamId,
    refKind: 'question',
    refId: id,
    policy: 'softmax_mfi',
    selected: true,
    inclusionProbability: 0.3,
    signals: {},
  });
  const issued = await issueSoloFixture(db, id);
  const assessment = issued.assessment('A');
  const submit = (extra: Record<string, unknown> = {}) =>
    createAttempt(
      new Request('http://local/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: id,
          rating: 'good',
          auto_rate: true,
          assessment,
          stream_item_id: streamId,
          ...extra,
        }),
      }),
    );
  const labels = () =>
    db
      .select()
      .from(difficulty_calibration_label)
      .where(eq(difficulty_calibration_label.question_id, id));
  return { id, knowledgeId, streamId, issued, assessment, submit, labels };
}

describe('native HTTP calibration follows automatic evidence', () => {
  it.each([
    { answer: 'A', outcome: 1 },
    { answer: 'B', outcome: 0 },
  ])(
    'records $answer with its stream probability once, bound to the reversible settlement',
    async ({ answer, outcome }) => {
      const f = await fixture();
      const assessment = f.issued.assessment(answer);
      const response = await f.submit({ assessment });
      expect(response.status).toBe(200);
      const body = await response.json();
      const labels = await f.labels();
      expect(labels).toHaveLength(1);
      expect(labels[0]).toMatchObject({ outcome, inclusion_probability: 0.3 });
      expect(Number.isFinite(labels[0].b_label)).toBe(true);
      const [settlement] = await testDb()
        .select()
        .from(event)
        .where(eq(event.id, labels[0].attempt_event_id!));
      expect(settlement.action).toBe('experimental:assessment_settlement');
      expect(settlement.payload).toMatchObject({
        replay_inputs: { difficultyLabelStreamItemId: f.streamId },
      });
      const [original] = await testDb()
        .select()
        .from(event)
        .where(eq(event.id, body.review_event.id));
      expect(original.payload.stream_item_id).toBe(f.streamId);
      expect(
        (await f.submit({ assessment, stream_item_id: 'retry-must-not-rewrite-original' })).status,
      ).toBe(200);
      expect(await f.labels()).toEqual(labels);
      expect(await testDb().select().from(item_family_calibration)).toMatchObject([
        { evidence_count: 1 },
      ]);
    },
  );

  it('keeps the automatic calibration outcome independent of the explicit FSRS rating', async () => {
    const f = await fixture();
    expect((await f.submit({ auto_rate: false, rating: 'again' })).status).toBe(200);
    expect(await f.labels()).toMatchObject([{ outcome: 1 }]);
    const [mastery] = await testDb()
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, f.knowledgeId));
    expect(mastery.theta_hat).toBeGreaterThan(0);
    const [card] = await testDb().select().from(material_fsrs_state);
    const [settlement] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, card.last_review_event_id!));
    expect(settlement.payload).toMatchObject({ rating: 'again', rating_source: 'user' });
  });

  it.each(['self_report', 'assisted'] as const)('does not calibrate %s evidence', async (mode) => {
    const f = await fixture();
    if (mode === 'assisted')
      await recordAssistanceExposure(testDb(), {
        issuanceId: f.assessment.issuance_id,
        questionId: f.id,
        kind: 'hint',
        impact: 'answer_help',
        contentDigest: `sha256:${'a'.repeat(64)}`,
      });
    expect(
      (await f.submit({ auto_rate: false, self_report: mode === 'self_report', rating: 'good' }))
        .status,
    ).toBe(200);
    expect(await f.labels()).toHaveLength(0);
    expect(await testDb().select().from(item_family_calibration)).toHaveLength(0);
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(1);
  });

  it.each(['absent', 'wrong_question'] as const)(
    'does not borrow a probability from an %s stream slot',
    async (mode) => {
      const f = await fixture();
      const other = mode === 'wrong_question' ? await fixture() : null;
      expect((await f.submit({ stream_item_id: other?.streamId ?? undefined })).status).toBe(200);
      expect(await f.labels()).toHaveLength(0);
    },
  );

  it('isolates a real label SQL failure from the original, theta, FSRS and family transaction', async () => {
    const f = await fixture();
    const labelWriter = vi
      .spyOn(recalibration, 'recordDifficultyCalibrationLabel')
      .mockImplementation(async (tx) => {
        // A PostgreSQL error aborts the savepoint unless this optional write is isolated.
        await tx.execute(sql`SELECT 1 / 0`);
      });
    const response = await f.submit();
    expect(response.status).toBe(200);
    expect(labelWriter).toHaveBeenCalledOnce();
    expect(await f.labels()).toHaveLength(0);
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(1);
    expect(
      await testDb()
        .select()
        .from(mastery_state)
        .where(eq(mastery_state.subject_id, f.knowledgeId)),
    ).toHaveLength(1);
    expect(await testDb().select().from(item_family_calibration)).toMatchObject([
      { evidence_count: 1 },
    ]);
    expect(
      await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:assessment_attempt')),
    ).toHaveLength(1);
  });

  it('removes the old label on manual replacement and replays a later automatic occurrence with its own stream identity', async () => {
    const first = await fixture();
    expect((await first.submit()).status).toBe(200);
    const later = await fixture(first.knowledgeId);
    expect((await later.submit()).status).toBe(200);
    const originalLaterLabels = await later.labels();
    expect(originalLaterLabels).toHaveLength(1);
    const [head] = await testDb()
      .select()
      .from(evaluation_effective_head)
      .where(
        eq(evaluation_effective_head.evaluation_group_id, first.assessment.evaluation_group_id),
      );
    const [original] = await testDb()
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, head.effective_evaluation_id!));
    const manual = await evaluateSubmission(testDb(), {
      submission_id: original.submission_id,
      evaluation_group_id: original.evaluation_group_id,
      evaluation_key: 'owner-replacement',
      mode: 'manual_assert',
      provenance: { source: 'manual', assisted: false },
      asserted_unit_results: original.unit_results.map((unit) => ({
        scoring_unit_id: unit.scoring_unit_id,
        status: 'scored',
        points_awarded: 0,
        scored_because: 'response',
        evidence_citations: [],
      })),
    });
    expect(
      await activateSubmissionCandidate(
        testDb(),
        {
          evaluation_id: manual.record.evaluation_id,
          expected_effective_id: head.effective_evaluation_id,
          expected_generation: head.generation,
        },
        { actorRef: 'test:manual' },
      ),
    ).toMatchObject({ status: 'activated', effect: 'applied' });
    expect(await first.labels()).toHaveLength(0);
    const laterLabels = await later.labels();
    expect(laterLabels).toHaveLength(1);
    expect(laterLabels[0]).toMatchObject({ outcome: 1, inclusion_probability: 0.3 });
    expect(laterLabels[0].attempt_event_id).not.toBe(originalLaterLabels[0].attempt_event_id);
    const [laterSettlement] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, laterLabels[0].attempt_event_id!));
    expect(laterSettlement.payload).toMatchObject({
      replay_inputs: { difficultyLabelStreamItemId: later.streamId },
    });
  });
});
