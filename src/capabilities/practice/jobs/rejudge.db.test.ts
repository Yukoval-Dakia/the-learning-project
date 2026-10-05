import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import * as domainEvents from '@/kernel/events';
import { getQuestionTimeline } from '@/kernel/read-models/question-activity';
import { nativeAppealFixture } from '../../../../tests/fixtures/native-appeal';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createNativeAppeal } from '../server/assessment/appeal';
import { handleRejudge } from './rejudge';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
const reason = '请复核原式：两式相加消去水速，30/2=15 km/h；不能以改写后的题目替代。';
async function appeal(f: Awaited<ReturnType<typeof nativeAppealFixture>>, text = reason) {
  return {
    appeal_event_id: await createNativeAppeal(testDb(), {
      evaluation_id: f.original.evaluation_id,
      reason_md: text,
    }),
  };
}
async function head(groupId: string) {
  return (
    await testDb()
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, groupId))
  )[0];
}
async function theta(kc: string) {
  return (
    await testDb()
      .select()
      .from(mastery_state)
      .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, kc)))
  )[0];
}
async function resolutions(appealId: string) {
  return testDb().select().from(event).where(eq(event.caused_by_event_id, appealId));
}
async function legacyAppeal(prior: string = 'incorrect', resolved = false) {
  const judgeId = createId();
  const appealId = createId();
  await testDb()
    .insert(event)
    .values([
      {
        id: judgeId,
        actor_kind: 'agent',
        actor_ref: 'historical',
        action: 'judge',
        subject_kind: 'event',
        subject_id: 'historical-original',
        outcome: null,
        payload: { coarse_outcome: prior },
      },
      {
        id: appealId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'experimental:appeal_request',
        subject_kind: 'event',
        subject_id: judgeId,
        outcome: null,
        payload: { reason_md: reason },
        caused_by_event_id: judgeId,
      },
      ...(resolved
        ? [
            {
              id: createId(),
              actor_kind: 'agent',
              actor_ref: 'historical',
              action: 'experimental:appeal_upheld',
              subject_kind: 'event',
              subject_id: judgeId,
              outcome: null,
              payload: {},
              caused_by_event_id: appealId,
            },
          ]
        : []),
    ]);
  return { appeal_event_id: appealId };
}

describe('native appeal worker', () => {
  it('activates a new candidate from the original and exposes the corrected effective truth', async () => {
    const f = await nativeAppealFixture(testDb());
    const originals = await testDb().select().from(assessment_submission);
    const job = await appeal(f);
    f.setPoints(1);
    const result = await handleRejudge(testDb(), job);
    expect(result.status).toBe('reassessed');
    if (result.status !== 'reassessed') throw new Error(result.status);
    expect(result.effect).toBe('applied');
    expect(await head(f.original.evaluation_group_id)).toMatchObject({
      effective_evaluation_id: result.evaluation_id,
      generation: 2,
    });
    const [candidate] = await testDb()
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, result.evaluation_id));
    expect(candidate).toMatchObject({
      submission_id: f.original.submission_id,
      aggregate: { kind: 'points_total', points: 1 },
      provenance: {
        source: 'automatic',
        review_context: {
          appeal_event_id: job.appeal_event_id,
          prior_evaluation_id: f.original.evaluation_id,
          reason_md: reason,
        },
      },
    });
    expect(candidate.run_refs).toHaveLength(1);
    expect(candidate.run_refs).not.toEqual(f.original.run_refs);
    expect(await testDb().select().from(assessment_submission)).toEqual(originals);
    expect(
      await testDb()
        .select()
        .from(evaluation)
        .where(eq(evaluation.evaluation_id, f.original.evaluation_id)),
    ).toEqual([f.original]);
    expect(await getQuestionTimeline(testDb(), f.questionId)).toMatchObject([
      {
        event_id: f.attemptId,
        outcome: 'success',
        assessment: {
          original_evaluation_id: f.original.evaluation_id,
          effective_evaluation_id: result.evaluation_id,
        },
      },
    ]);
    expect(await resolutions(job.appeal_event_id)).toMatchObject([
      {
        action: 'experimental:assessment_appeal_resolution',
        payload: { disposition: 'effective', evaluation_id: result.evaluation_id },
      },
    ]);
    expect(await theta(f.knowledgeId)).toMatchObject({
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
    });
  });

  it('retains deterministic execution with no model call and a new immutable review candidate', async () => {
    const f = await nativeAppealFixture(testDb(), { model: false });
    const result = await handleRejudge(testDb(), await appeal(f));
    expect(result.status).toBe('reassessed');
    expect(f.execute).not.toHaveBeenCalled();
    const candidates = await testDb().select().from(evaluation);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.run_refs.length === 0)).toBe(true);
    expect(await theta(f.knowledgeId)).toMatchObject({ evidence_count: 1, fail_count: 1 });
  });

  it('records an unchanged score as an actual reviewed candidate without duplicating learning', async () => {
    const f = await nativeAppealFixture(testDb());
    const result = await handleRejudge(testDb(), await appeal(f));
    expect(result.status).toBe('reassessed');
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await theta(f.knowledgeId)).toMatchObject({ evidence_count: 1, fail_count: 1 });
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { state: { reps: 1 } },
    ]);
  });

  it('uses the frozen prompt, rule, responses, and targets after current diagnostic-like metadata changes', async () => {
    const f = await nativeAppealFixture(testDb());
    const originalInput = f.execute.mock.calls[0][0];
    const job = await appeal(f);
    await testDb()
      .update(question)
      .set({
        prompt_md: 'MUTATED PROMPT',
        reference_md: 'MUTATED REFERENCE',
        judge_kind_override: 'multimodal_direct',
        knowledge_ids: ['other-kc'],
        difficulty: 5,
        metadata: { intervention_diagnostic: { intervention_id: 'different-intervention' } },
      })
      .where(eq(question.id, f.questionId));
    f.setPoints(1);
    await handleRejudge(testDb(), job);
    const input = f.execute.mock.calls[1][0];
    expect(input).toMatchObject({
      question_parts: originalInput.question_parts,
      response_slots: originalInput.response_slots,
      slot_responses: originalInput.slot_responses,
      unit: originalInput.unit,
      materials: originalInput.materials,
      review_context: { reason_md: reason },
    });
    expect(JSON.stringify(input)).not.toContain('MUTATED');
    expect(await theta(f.knowledgeId)).toMatchObject({ evidence_count: 1, success_count: 1 });
    expect(await theta('other-kc')).toBeUndefined();
  });

  it('replays a resolved appeal without evaluating again', async () => {
    const f = await nativeAppealFixture(testDb());
    const job = await appeal(f);
    await handleRejudge(testDb(), job);
    expect(await handleRejudge(testDb(), job)).toEqual({
      status: 'skipped',
      reason: 'already_resolved',
    });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await resolutions(job.appeal_event_id)).toHaveLength(1);
  });

  it('serializes concurrent delivery into one candidate, head, receipt, and learning occurrence', async () => {
    const f = await nativeAppealFixture(testDb());
    const job = await appeal(f);
    f.setPoints(1);
    await Promise.all([handleRejudge(testDb(), job), handleRejudge(testDb(), job)]);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await testDb().select().from(evaluation)).toHaveLength(2);
    expect(await resolutions(job.appeal_event_id)).toHaveLength(1);
    expect(await head(f.original.evaluation_group_id)).toMatchObject({ generation: 2 });
    expect(await theta(f.knowledgeId)).toMatchObject({ evidence_count: 1, success_count: 1 });
  });

  it('regrades a real paper occurrence and preserves its single card and answer', async () => {
    const f = await nativeAppealFixture(testDb(), { paper: true });
    f.setPoints(1);
    expect(await handleRejudge(testDb(), await appeal(f))).toMatchObject({
      status: 'reassessed',
      effect: 'applied',
    });
    expect(await theta(f.knowledgeId)).toMatchObject({
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
    });
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { state: { reps: 1 } },
    ]);
    expect(await getQuestionTimeline(testDb(), f.questionId)).toHaveLength(1);
  });

  it('preserves explicit user FSRS byte for byte while correcting automatic theta', async () => {
    const f = await nativeAppealFixture(testDb(), { userRating: 'hard' });
    const before = await testDb().select().from(material_fsrs_state);
    f.setPoints(1);
    await handleRejudge(testDb(), await appeal(f));
    expect(await testDb().select().from(material_fsrs_state)).toEqual(before);
    expect(await theta(f.knowledgeId)).toMatchObject({
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
    });
  });

  it('replaces automatic solo learning instead of appending a second occurrence', async () => {
    const f = await nativeAppealFixture(testDb());
    expect(await theta(f.knowledgeId)).toMatchObject({ evidence_count: 1, fail_count: 1 });
    f.setPoints(1);
    await handleRejudge(testDb(), await appeal(f));
    expect(await theta(f.knowledgeId)).toMatchObject({
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
    });
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { state: { reps: 1 } },
    ]);
  });

  it('abstains on unlocalized partial credit, then creates one success observation on full credit', async () => {
    const f = await nativeAppealFixture(testDb(), { points: 0.5 });
    expect(await theta(f.knowledgeId)).toBeUndefined();
    f.setPoints(1);
    await handleRejudge(testDb(), await appeal(f));
    expect(await theta(f.knowledgeId)).toMatchObject({
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
    });
  });

  it('replays later native occurrences in order when an earlier answer is corrected', async () => {
    const first = await nativeAppealFixture(testDb(), { now: new Date('2026-10-01T08:00:00Z') });
    const job = await appeal(first);
    const later = await nativeAppealFixture(testDb(), {
      points: 1,
      knowledgeId: first.knowledgeId,
      now: new Date('2026-10-02T08:00:00Z'),
    });
    expect(await theta(first.knowledgeId)).toMatchObject({
      evidence_count: 2,
      success_count: 1,
      fail_count: 1,
    });
    expect(await handleRejudge(testDb(), job)).toMatchObject({
      status: 'reassessed',
      effect: 'applied',
    });
    expect(await theta(first.knowledgeId)).toMatchObject({
      evidence_count: 2,
      success_count: 2,
      fail_count: 0,
      last_outcome_at: new Date('2026-10-02T08:00:00Z'),
    });
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { state: { reps: 2 } },
    ]);
    expect(await head(later.original.evaluation_group_id)).toMatchObject({
      effective_evaluation_id: later.original.evaluation_id,
      generation: 1,
    });
  });

  it('preserves untracked later theta movement and records an explicit replay requirement', async () => {
    const f = await nativeAppealFixture(testDb());
    await testDb()
      .update(mastery_state)
      .set({ theta_hat: 7, evidence_count: 20, last_outcome_at: new Date(Date.now() + 60_000) })
      .where(eq(mastery_state.subject_id, f.knowledgeId));
    const before = await theta(f.knowledgeId);
    f.setPoints(1);
    expect(await handleRejudge(testDb(), await appeal(f))).toMatchObject({
      status: 'reassessed',
      effect: 'failed_pending',
    });
    expect(await theta(f.knowledgeId)).toEqual(before);
    const receipts = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    expect(receipts.some((r) => r.payload.effect === 'replay_required')).toBe(true);
  });

  it.each(['incorrect', 'unsupported', 'unknown'])(
    'holds legacy %s without checkpoints, scores, or learning writes',
    async (prior) => {
      const job = await legacyAppeal(prior);
      expect(await handleRejudge(testDb(), job)).toEqual({
        status: 'held',
        ...job,
        reason: 'historical_unknown',
      });
      expect(await handleRejudge(testDb(), job)).toMatchObject({
        status: 'skipped',
        reason: 'already_resolved',
      });
      expect(await resolutions(job.appeal_event_id)).toMatchObject([
        { payload: { disposition: 'historical_unknown' } },
      ]);
      expect(await testDb().select().from(evaluation)).toHaveLength(0);
      expect(await testDb().select().from(mastery_state)).toHaveLength(0);
      expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
    },
  );

  it('recognizes historical completed resolutions and serializes historical held receipts', async () => {
    const done = await legacyAppeal('correct', true);
    expect(await handleRejudge(testDb(), done)).toMatchObject({
      status: 'skipped',
      reason: 'already_resolved',
    });
    const pending = await legacyAppeal();
    const results = await Promise.all([
      handleRejudge(testDb(), pending),
      handleRejudge(testDb(), pending),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['held', 'skipped']);
    expect(await resolutions(pending.appeal_event_id)).toHaveLength(1);
  });

  it('holds unavailable model review without claiming the old score was upheld or retrying the model', async () => {
    const f = await nativeAppealFixture(testDb());
    const job = await appeal(f);
    f.execute.mockResolvedValue({
      kind: 'pending',
      pending: { reason: 'unjudgeable', detail: '原图证据不足' },
      run_refs: [],
      cost_usd_micros: 0,
    });
    expect(await handleRejudge(testDb(), job)).toMatchObject({
      status: 'held',
      reason: 'review_required',
    });
    expect(await head(f.original.evaluation_group_id)).toMatchObject({
      effective_evaluation_id: f.original.evaluation_id,
      generation: 1,
    });
    await handleRejudge(testDb(), job);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await theta(f.knowledgeId)).toMatchObject({ evidence_count: 1, fail_count: 1 });
  });

  it('rolls back head, theta, and receipt atomically and retries with the sealed model result', async () => {
    const f = await nativeAppealFixture(testDb());
    const job = await appeal(f);
    f.setPoints(1);
    const beforeHead = await head(f.original.evaluation_group_id);
    const beforeTheta = await theta(f.knowledgeId);
    const beforeCards = await testDb().select().from(material_fsrs_state);
    const write = domainEvents.writeEvent;
    const spy = vi.spyOn(domainEvents, 'writeEvent').mockImplementation(async (...args) => {
      if (args[1].action === 'experimental:assessment_appeal_resolution')
        throw new Error('transient receipt failure');
      return write(...args);
    });
    await expect(handleRejudge(testDb(), job)).rejects.toThrow('transient receipt failure');
    expect(await head(f.original.evaluation_group_id)).toEqual(beforeHead);
    expect(await theta(f.knowledgeId)).toEqual(beforeTheta);
    expect(await testDb().select().from(material_fsrs_state)).toEqual(beforeCards);
    expect(await resolutions(job.appeal_event_id)).toHaveLength(0);
    spy.mockRestore();
    expect(await handleRejudge(testDb(), job)).toMatchObject({
      status: 'reassessed',
      effect: 'applied',
    });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await resolutions(job.appeal_event_id)).toHaveLength(1);
  });

  it('does not recreate a renamed KC or overwrite the merge winner during regrade', async () => {
    const f = await nativeAppealFixture(testDb());
    const winner = `winner_${createId()}`;
    const now = new Date();
    await testDb()
      .insert(knowledge)
      .values({
        id: winner,
        name: '合并后的知识',
        domain: 'math',
        merged_from: [f.knowledgeId],
        created_at: now,
        updated_at: now,
      });
    await testDb()
      .update(mastery_state)
      .set({ subject_id: winner })
      .where(eq(mastery_state.subject_id, f.knowledgeId));
    const before = await theta(winner);
    f.setPoints(1);
    expect(await handleRejudge(testDb(), await appeal(f))).toMatchObject({
      status: 'reassessed',
      effect: 'failed_pending',
    });
    expect(await theta(winner)).toEqual(before);
    expect(await theta(f.knowledgeId)).toBeUndefined();
  });

  it('holds a competing stale appeal before another model execution', async () => {
    const f = await nativeAppealFixture(testDb());
    const first = await appeal(f);
    const second = await appeal(f, '第二个独立申诉');
    f.setPoints(1);
    await handleRejudge(testDb(), first);
    expect(await handleRejudge(testDb(), second)).toMatchObject({
      status: 'held',
      reason: 'stale_head',
    });
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
});
