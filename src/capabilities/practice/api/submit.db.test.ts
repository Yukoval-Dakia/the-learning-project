// YUK-1047: real issued originals replace retired flat-answer/supplied-judge execution.
// Diagnostic lifecycle and calibration are exercised in the adjacent native suites.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import {
  assessment_submission,
  evaluation,
  event,
  item_family_calibration,
  mastery_state,
  material_fsrs_state,
} from '@/db/schema';
import * as piExecutor from '@/server/assessment/runtime';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import {
  handwritingFixture,
  nativeHttpRequest,
  nativeSoloHttpFixture,
} from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedAttempt, seedUserCause } from '../../../../tests/helpers/event-seed';
import * as evaluationService from '../server/judge/evaluate-submission';
import { MASTERY_PROGRESS_ACTION } from '../server/mastery-progress-signal';
import { AttemptResponseSchema, MAX_REVIEW_RESPONSE_CHARS } from './contracts';
import { POST, createAttempt, createAttemptResource } from './submit';

beforeEach(async () => {
  await resetDb();
  __resetRateLimitForTests();
  resetTestConfig();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetTestConfig();
});
const send = (body: unknown) => createAttempt(nativeHttpRequest(body));
const events = (action: string) => testDb().select().from(event).where(eq(event.action, action));
const cards = () => testDb().select().from(material_fsrs_state);
const candidates = () => testDb().select().from(evaluation);
const originals = () => testDb().select().from(assessment_submission);

async function parsed(response: Response) {
  expect(response.status).toBe(200);
  return AttemptResponseSchema.parse(await response.json());
}

describe('native attempt HTTP contract', () => {
  it.each([
    { rating: 'easy' },
    { response_md: 'x'.repeat(MAX_REVIEW_RESPONSE_CHARS + 1) },
    { latency_ms: -1 },
    { latency_ms: 3_600_001 },
    { self_confidence: 6 },
    { self_confidence: 1.5 },
    { judge_result_v2: { coarse_outcome: 'correct' } },
  ])('rejects malformed capture before accepting an original: %j', async (invalid) => {
    const f = await nativeSoloHttpFixture(testDb());
    expect((await send(f.body(invalid))).status).toBe(400);
    expect(await originals()).toHaveLength(0);
    expect(await cards()).toHaveLength(0);
  });

  it('requires an identity and rejects conflicting or unsupported activity references', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    for (const extra of [
      { question_id: undefined },
      { activity_ref: { kind: 'knowledge', id: 'kc' } },
      { activity_ref: { kind: 'question', id: 'different' } },
    ])
      expect((await send(f.body(extra))).status).toBe(400);
    expect(await originals()).toHaveLength(0);
  });

  it('returns 404 for an unknown question without creating an original', async () => {
    expect((await send({ question_id: 'missing', rating: 'good' })).status).toBe(404);
    expect(await originals()).toHaveLength(0);
  });

  it.each([true, false])(
    'rejects the retired flat submission, auto_rate=%s, without learning writes',
    async (autoRate) => {
      const f = await nativeSoloHttpFixture(testDb());
      const response = await send(
        f.body({
          assessment: undefined,
          auto_rate: autoRate,
          response_md: 'A',
          answer_image_refs: ['legacy-photo'],
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'historical_unknown' });
      expect(await originals()).toHaveLength(0);
      expect(await candidates()).toHaveLength(0);
      expect(await cards()).toHaveLength(0);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it('canonical creation returns 201 and a Location for the immutable native occurrence', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const response = await createAttemptResource(nativeHttpRequest(f.body()));
    expect(response.status).toBe(201);
    const body = AttemptResponseSchema.parse(await response.json());
    expect(response.headers.get('Location')).toBe(`/api/events/${body.review_event.id}`);
    expect(await events('experimental:assessment_attempt')).toMatchObject([
      { id: body.review_event.id, outcome: null },
    ]);
    expect(await events('review')).toHaveLength(0);
    expect(await events('judge')).toHaveLength(0);
  });

  it('the deprecated URL delegates to the same native writer and marks deprecation', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const response = await POST(nativeHttpRequest(f.body()));
    expect(response.status).toBe(200);
    expect(response.headers.get('Deprecation')).toBeTruthy();
    expect(await events('experimental:assessment_attempt')).toHaveLength(1);
  });

  it('accepts activity_ref as the primary identity with the original issuance', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    await parsed(
      await send(f.body({ question_id: undefined, activity_ref: { kind: 'question', id: f.id } })),
    );
    expect(await events('experimental:assessment_attempt')).toMatchObject([{ subject_id: f.id }]);
  });

  it('preserves optional observation bytes once while grading only the ResponseSet', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    await parsed(
      await send(
        f.body({
          response_md: '观察文本不是实际选项',
          reasoning_trace: '先固定水量\n再比较不同坡度',
          self_confidence: 2,
          latency_ms: 1234,
          part_ref: 'display-part',
        }),
      ),
    );
    const original = await events('experimental:assessment_attempt');
    expect(original).toMatchObject([
      {
        payload: {
          response_md: '观察文本不是实际选项',
          reasoning_trace: '先固定水量\n再比较不同坡度',
          self_confidence: 2,
          duration_ms: 1234,
          part_ref: 'display-part',
        },
      },
    ]);
    await parsed(await send(f.body({ response_md: '重试改写', latency_ms: 999 })));
    expect(await events('experimental:assessment_attempt')).toEqual(original);
  });

  it('accepts native answers without flat text and keeps omitted observation fields absent', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const body = await parsed(await send(f.body()));
    expect(body.judge).toMatchObject({ coarse_outcome: 'correct' });
    const [original] = await events('experimental:assessment_attempt');
    expect(original.payload.response_md).toBeNull();
    expect(original.payload).not.toHaveProperty('duration_ms');
    expect(original.payload).not.toHaveProperty('self_confidence');
    expect(original.payload).not.toHaveProperty('reasoning_trace');
  });

  it.each([
    { answer: 'A', verdict: 'correct', rating: 'good', progress: 1 },
    { answer: 'B', verdict: 'incorrect', rating: 'again', progress: 0 },
  ])(
    'grades $answer with deterministic provenance and independent learning effects',
    async ({ answer, verdict, rating, progress }) => {
      const f = await nativeSoloHttpFixture(testDb());
      const body = await parsed(await send(f.body({ assessment: f.issued.assessment(answer) })));
      expect(body.judge).toMatchObject({
        route: 'evaluate_submission',
        coarse_outcome: verdict,
        suggested_rating: rating,
        judge_event_id: null,
      });
      expect(await candidates()).toMatchObject([
        { run_refs: [], provenance: { source: 'automatic', assisted: false } },
      ]);
      expect(f.execute).not.toHaveBeenCalled();
      expect(await cards()).toMatchObject([
        { subject_kind: 'knowledge', subject_id: f.knowledgeIds[0], state: { reps: 1 } },
      ]);
      const [mastery] = await testDb()
        .select()
        .from(mastery_state)
        .where(eq(mastery_state.subject_id, f.knowledgeIds[0]));
      expect(verdict === 'correct' ? mastery.theta_hat > 0 : mastery.theta_hat < 0).toBe(true);
      expect(await events(MASTERY_PROGRESS_ACTION)).toHaveLength(progress);
      expect(await events('experimental:prereq_risk')).toHaveLength(0);
      expect(await events('experimental:user_cause')).toHaveLength(0);
    },
  );

  it('explicit rating wins scheduling without replacing an automatic correct verdict', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const body = await parsed(await send(f.body({ auto_rate: false, rating: 'again' })));
    expect(body.judge).toMatchObject({
      coarse_outcome: 'correct',
      suggested_rating: 'good',
      auto_rated: false,
    });
    expect(await events('experimental:assessment_settlement')).toMatchObject([
      {
        payload: {
          rating: 'again',
          rating_source: 'user',
          theta_decision: { applied: true, outcome: 1 },
        },
      },
    ]);
    expect(await testDb().select().from(item_family_calibration)).toMatchObject([
      { evidence_count: 1 },
    ]);
  });

  it.each(['again', 'hard', 'good'])(
    'explicit self-report %s schedules without inventing scores or model work',
    async (rating) => {
      const f = await nativeSoloHttpFixture(testDb(), { model: true });
      const body = await parsed(
        await send(
          f.body({
            assessment: f.issued.assessment(''),
            self_report: true,
            auto_rate: false,
            rating,
          }),
        ),
      );
      expect(body.judge).toBeNull();
      expect(f.execute).not.toHaveBeenCalled();
      expect(await events('experimental:assessment_settlement')).toMatchObject([
        { payload: { rating, rating_source: 'user', theta_decision: { applied: false } } },
      ]);
      expect(await testDb().select().from(mastery_state)).toHaveLength(0);
      expect(await testDb().select().from(item_family_calibration)).toHaveLength(0);
      expect(await cards()).toHaveLength(1);
    },
  );

  it('self-report cannot infer an explicit scheduling choice from auto_rate', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    expect((await send(f.body({ self_report: true, auto_rate: true }))).status).toBe(400);
    expect(await cards()).toHaveLength(0);
  });

  it('schedules all frozen KC targets and ignores client-supplied extra or disjoint references', async () => {
    for (const refs of [['kc-a', 'unrelated'], ['unrelated']]) {
      await resetDb();
      const f = await nativeSoloHttpFixture(testDb(), { knowledgeIds: ['kc-a', 'kc-b'] });
      await parsed(await send(f.body({ referenced_knowledge_ids: refs })));
      expect((await cards()).map((row) => row.subject_id).sort()).toEqual(['kc-a', 'kc-b']);
    }
  });

  it('uses a question card when the original has no KC targets', async () => {
    const f = await nativeSoloHttpFixture(testDb(), { knowledgeIds: [] });
    await parsed(await send(f.body()));
    expect(await cards()).toMatchObject([{ subject_kind: 'question', subject_id: f.id }]);
  });

  it('round-trips stored ISO FSRS dates and upserts across independent originals', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    await parsed(await send(f.body()));
    const [first] = await cards();
    expect(first.state.last_review).toEqual(expect.any(String));
    const issuedAgain = await issueSoloFixture(testDb(), f.id);
    await parsed(await send(f.body({ assessment: issuedAgain.assessment('B') })));
    const [second] = await cards();
    expect(second.id).toBe(first.id);
    expect(second.state.reps).toBe(2);
    expect(second.last_review_event_id).not.toBe(first.last_review_event_id);
    expect(await originals()).toHaveLength(2);
  });

  it('concurrent retries share the original, effective candidate and one FSRS update', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const responses = await Promise.all([send(f.body()), send(f.body())]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await originals()).toHaveLength(1);
    expect(await candidates()).toHaveLength(1);
    expect(await cards()).toMatchObject([{ state: { reps: 1 } }]);
    expect(await events(MASTERY_PROGRESS_ACTION)).toHaveLength(1);
  });

  it('rejects changed answer bytes under the accepted identity', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    await parsed(await send(f.body()));
    const before = await originals();
    expect((await send(f.body({ assessment: f.issued.assessment('B') }))).status).toBe(409);
    expect(await originals()).toEqual(before);
    expect(await cards()).toMatchObject([{ state: { reps: 1 } }]);
  });

  it('deterministic evaluation does not spend the paid-model rate budget', async () => {
    setTestConfig({ AI_RATE_LIMIT_MAX: 1, AI_RATE_LIMIT_WINDOW_MS: 60_000 });
    for (let i = 0; i < 2; i++) {
      const f = await nativeSoloHttpFixture(testDb(), { knowledgeIds: [] });
      await parsed(await send(f.body()));
      expect(f.execute).not.toHaveBeenCalled();
    }
  });

  it('rejects paid-model admission with 429 before any execution claim and allows a later original retry', async () => {
    setTestConfig({ AI_RATE_LIMIT_MAX: 1, AI_RATE_LIMIT_WINDOW_MS: 60_000 });
    const first = await nativeSoloHttpFixture(testDb(), { model: true });
    const blocked = await nativeSoloHttpFixture(testDb(), { model: true });
    vi.mocked(evaluationService.createFormalModelExecutor).mockRestore();
    const driver = vi
      .spyOn(piExecutor, 'createPiModelExecutor')
      .mockImplementation(
        (options) => (input, signal) =>
          first.execute(input, signal, options.taskRunId ?? 'offline-run'),
      );
    await parsed(await send(first.body()));
    await parsed(await send(first.body())); // sealed retries do not consume another token
    expect(driver.mock.calls[0][0].taskRunId).toMatch(/^assessment_/);
    const response = await send(blocked.body());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(driver).toHaveBeenCalledOnce();
    expect(await originals()).toHaveLength(2);
    expect(await candidates()).toHaveLength(1);
    expect(await events('experimental:assessment_model_claim')).toHaveLength(1);
    expect(await events('experimental:assessment_model_result')).toHaveLength(1);
    __resetRateLimitForTests();
    await parsed(await send(blocked.body()));
    expect(driver).toHaveBeenCalledTimes(2);
    expect(await originals()).toHaveLength(2);
    expect(await candidates()).toHaveLength(2);
  });

  it.each([undefined, 'tampered-preview-token', 'obsolete-signed-format'])(
    'never treats supplied legacy advice/token %s as the authoritative score',
    async (token) => {
      const f = await nativeSoloHttpFixture(testDb());
      const body = await parsed(
        await send(
          f.body({
            assessment: f.issued.assessment('B'),
            judge_provenance_token: token,
            judge_task_run_id: 'client-claimed-run',
            judge_result_v2: {
              coarse_outcome: 'correct',
              score: 1,
              score_meaning: 'correctness',
              confidence: 1,
              capability_ref: { id: 'steps', version: 'client-version' },
              feedback_md: '客户端建议不能替代冻结原答',
              evidence_json: {},
            },
          }),
        ),
      );
      expect(body.judge).toMatchObject({ coarse_outcome: 'incorrect', suggested_rating: 'again' });
      expect(await candidates()).toMatchObject([
        { run_refs: [], provenance: { source: 'automatic' } },
      ]);
      expect(await events('judge')).toHaveLength(0);
    },
  );

  it.each([
    { points: 1, verdict: 'correct', rating: 'good' },
    { points: 0.5, verdict: 'partial', rating: 'hard' },
    { points: 0, verdict: 'incorrect', rating: 'again' },
  ])(
    'records actual model evidence for $verdict once across retries',
    async ({ points, verdict, rating }) => {
      const f = await nativeSoloHttpFixture(testDb(), { model: true, points });
      const body = await parsed(await send(f.body()));
      expect(body.judge).toMatchObject({ coarse_outcome: verdict, suggested_rating: rating });
      const [candidate] = await candidates();
      expect(candidate.run_refs).toHaveLength(1);
      expect(candidate.provenance).toMatchObject({ source: 'automatic', assisted: false });
      await parsed(await send(f.body()));
      expect(f.execute).toHaveBeenCalledOnce();
      expect(await cards()).toMatchObject([{ state: { reps: 1 } }]);
    },
  );

  it.each(['pending', 'throw'] as const)(
    'holds model %s while preserving the original and sealed execution, without automatic repayment',
    async (outcome) => {
      const f = await nativeSoloHttpFixture(testDb(), { model: true });
      f.setOutcome(outcome);
      const body = await parsed(await send(f.body()));
      expect(body).toMatchObject({
        status: 'review_required',
        judge: { coarse_outcome: 'unsupported', suggested_rating: null },
      });
      expect(await originals()).toHaveLength(1);
      expect(await cards()).toHaveLength(0);
      await parsed(await send(f.body()));
      expect(f.execute).toHaveBeenCalledOnce();
    },
  );

  it.each(['carelessness', 'conceptual_error'])(
    'prior %s cannot silently overwrite an explicit scheduling rating',
    async (category) => {
      const f = await nativeSoloHttpFixture(testDb(), { model: true, points: 0.5 });
      const attemptId = `prior_${f.id}`;
      await seedAttempt({
        id: attemptId,
        question_id: f.id,
        knowledge_ids: f.knowledgeIds,
        outcome: 'failure',
        created_at: new Date(Date.now() - 60_000),
      });
      await seedUserCause({ attempt_event_id: attemptId, primary_category: category });
      const priorCauses = await events('experimental:user_cause');
      await parsed(await send(f.body({ auto_rate: false, rating: 'hard' })));
      expect(await events('experimental:assessment_settlement')).toMatchObject([
        { payload: { rating: 'hard', rating_source: 'user' } },
      ]);
      expect(await events('experimental:user_cause')).toEqual(priorCauses);
    },
  );

  it.each([true, false])(
    'keeps photo-only originals with model=%s and never substitutes observation text',
    async (model) => {
      const f = await nativeSoloHttpFixture(testDb(), { model });
      const photo = await handwritingFixture(testDb());
      const assessment = { ...f.issued.assessment(''), group_evidence: [photo] };
      const body = await parsed(
        await send(
          f.body({
            assessment,
            response_md: '这只是观察文本',
            answer_image_refs: ['not-the-original'],
          }),
        ),
      );
      expect(body).toMatchObject({
        status: model ? 'effective' : 'review_required',
        judge: { coarse_outcome: model ? 'correct' : 'unsupported' },
      });
      expect(await originals()).toMatchObject([{ group_evidence: [photo] }]);
      if (model)
        expect(f.execute.mock.calls[0][0]).toMatchObject({
          group_evidence: [photo],
          slot_responses: [{ text_md: '' }],
        });
      else {
        expect(f.execute).not.toHaveBeenCalled();
        expect(await cards()).toHaveLength(0);
        const self = await parsed(
          await send(f.body({ assessment, self_report: true, auto_rate: false, rating: 'hard' })),
        );
        expect(self.judge).toBeNull();
        expect(await cards()).toMatchObject([{ state: { reps: 1 } }]);
      }
    },
  );

  it('a blank issued response follows the frozen blank policy without a model call', async () => {
    const f = await nativeSoloHttpFixture(testDb());
    const body = await parsed(await send(f.body({ assessment: f.issued.assessment('') })));
    expect(body.judge).toMatchObject({ coarse_outcome: 'incorrect' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(await candidates()).toMatchObject([
      { unit_results: [{ scored_because: 'blank_marked_zero' }] },
    ]);
  });
});
