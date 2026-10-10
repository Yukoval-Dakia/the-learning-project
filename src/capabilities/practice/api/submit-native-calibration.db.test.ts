import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  difficulty_calibration_label,
  evaluation,
  evaluation_effective_head,
  event,
  knowledge,
  practice_stream_item,
  question,
} from '@/db/schema';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import { resetDb, testDb } from '../../../../tests/helpers/db';
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
  await db.insert(question).values({
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
  await db.insert(practice_stream_item).values({
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
    expect(head.effective_evaluation_id).toBeTruthy();
    if (!head.effective_evaluation_id) throw new Error('expected effective evaluation ID');
    const [original] = await testDb()
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, head.effective_evaluation_id));
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
    expect(laterLabels[0].attempt_event_id).toBeTruthy();
    if (!laterLabels[0].attempt_event_id) throw new Error('expected later settlement ID');
    const [laterSettlement] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, laterLabels[0].attempt_event_id));
    expect(laterSettlement.payload).toMatchObject({
      replay_inputs: { difficultyLabelStreamItemId: later.streamId },
    });
  });
});
