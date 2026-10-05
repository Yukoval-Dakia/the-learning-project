import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import {
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
} from '@/core/schema/intervention';
import {
  assessment_submission,
  evaluation,
  event,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { dispatchNativeAttempt } from '../server/assessment/durable-attempt';
import { loadNativeInterventionDiagnosticVerdict } from '../server/intervention-diagnostics';
import * as evaluationService from '../server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '../server/judge/recorded-model-executor';
import { GET as getQuestionDetail } from './question-detail';
import { QuestionDetailResponseSchema } from './question-solve-contracts';
import { createAttempt } from './submit';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const db = testDb();
  const id = createId();
  const kc = `diagnostic_kc_${id}`;
  const now = new Date();
  await db
    .insert(knowledge)
    .values({ id: kc, name: '顺逆流方程', domain: 'math', created_at: now, updated_at: now });
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: '顺流18、逆流12，列方程求静水船速并解释相加消元。',
    reference_md: 'v+c=18，v-c=12，得v=15 km/h。',
    knowledge_ids: [],
    difficulty: 3,
    version: 0,
    source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
    judge_kind_override: 'multimodal_direct',
    draft_status: 'active',
    metadata: {
      intervention_diagnostic: {
        schema_version: INTERVENTION_CONTRACT_VERSION,
        intervention_id: `intervention_${id}`,
        intervention_version: 1,
        diagnostic_kind: 'immediate',
        knowledge_id: kc,
        due_at: '2026-07-01T00:00:00.000Z',
      },
    },
    created_at: now,
    updated_at: now,
  });
  const issued = await issueSoloFixture(db, id, true);
  const assessment = issued.assessment('v+c=18，v-c=12，两式相加得 v=15 km/h。');
  const execute = vi.fn(
    async (
      input: ModelExecutorRequest,
      _signal: AbortSignal | undefined,
      runId: string,
    ): Promise<ModelUnitOutcomeT> => ({
      kind: 'scored',
      points_awarded: input.unit.points,
      matched: {
        rule_id:
          input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : 'fixture',
        option_ids: [],
      },
      feedback_md: '独立作答，方程和单位正确。',
      confidence: 0.95,
      evidence_citations: [{ slot_id: input.response_slots[0].slot_id, quote: 'v=15 km/h' }],
      run_refs: [runId],
      cost_usd_micros: 100,
    }),
  );
  vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(() =>
    createRecordedModelExecutor(db, execute),
  );
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
          ...extra,
        }),
      }),
    );
  return { id, kc, assessment, execute, submit };
}

describe('native diagnostic HTTP submission', () => {
  it('accepts the original ResponseSet without requiring a duplicate flat text field', async () => {
    const f = await fixture();
    const response = await f.submit();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'effective' });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
  });

  it('replays an accepted one-shot original without another model execution', async () => {
    const f = await fixture();
    const first = await f.submit({ response_md: '原答观察文本' });
    expect(first.status).toBe(200);
    const original = await first.json();
    const response = await f.submit({ response_md: '重试不能改原件' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review_event: original.review_event,
      assessment: {
        submission_id: original.assessment.submission_id,
        candidate_id: original.assessment.candidate_id,
      },
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
  });

  it('recovers the accepted native outbox through HTTP while its one-shot claim is retained', async () => {
    const f = await fixture();
    const send = vi.fn().mockResolvedValue('offline-job');
    const runId = await dispatchNativeAttempt(
      testDb(),
      f.id,
      f.assessment,
      {
        enabled: true,
        capture: {},
        requireUnassistedModelEvidence: true,
      },
      { checkRateLimit: () => 1, boss: { send } },
    );
    await testDb().update(question).set({ draft_status: 'draft' }).where(eq(question.id, f.id));
    for (let retry = 0; retry < 2; retry++) {
      const response = await f.submit();
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ run_id: runId, verdict: 'pending' });
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
  });

  it('preserves the diagnostic question card without scheduling its metadata KC or changing theta', async () => {
    const f = await fixture();
    expect((await f.submit({ response_md: '原答' })).status).toBe(200);
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    expect(await testDb().select().from(material_fsrs_state)).toMatchObject([
      { subject_kind: 'question', subject_id: f.id, state: { reps: 1 } },
    ]);
  });

  it('recovers the committed native verdict through the actual practice detail schema', async () => {
    const f = await fixture();
    const response = await f.submit();
    const original = await response.json();
    expect(response.status).toBe(200);
    const detail = await getQuestionDetail(
      new Request(`http://local/api/questions/${f.id}?surface=practice`),
      { id: f.id },
    );
    expect(detail.status).toBe(200);
    const body = QuestionDetailResponseSchema.parse(await detail.json());
    expect(body.committed_attempt).toMatchObject({
      review_event: { id: original.review_event.id },
      judge: {
        route: 'evaluate_submission',
        coarse_outcome: 'correct',
        judge_event_id: null,
        evaluation_id: original.assessment.candidate_id,
      },
    });
    expect(body.reference_md).toBeNull();
    expect(body.metadata).toEqual({});
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('binds the diagnostic consumer to original metadata after current-row edits', async () => {
    const f = await fixture();
    const original = await (await f.submit()).json();
    const before = await loadNativeInterventionDiagnosticVerdict(
      testDb(),
      original.review_event.id,
    );
    expect(before?.metadata.intervention_id).toBe(`intervention_${f.id}`);
    await testDb()
      .update(question)
      .set({
        metadata: {
          intervention_diagnostic: {
            schema_version: INTERVENTION_CONTRACT_VERSION,
            intervention_id: 'unrelated-intervention',
            intervention_version: 88,
            diagnostic_kind: 'transfer',
            knowledge_id: 'other-kc',
            due_at: '2026-07-01T00:00:00.000Z',
          },
        },
      })
      .where(eq(question.id, f.id));
    const after = await loadNativeInterventionDiagnosticVerdict(testDb(), original.review_event.id);
    expect(after?.metadata).toEqual(before?.metadata);
    expect(after?.activation.id).toBe(before?.activation.id);
  });

  it('permits only one original during concurrent different-key submissions', async () => {
    const f = await fixture();
    const responses = await Promise.all([
      f.submit(),
      f.submit({
        assessment: {
          ...f.assessment,
          evaluation_group_id: 'competitor',
          idempotency_key: 'competitor',
        },
      }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
  });

  it('holds unavailable model evidence and fences new originals without retrying the sealed call', async () => {
    const f = await fixture();
    f.execute.mockResolvedValue({
      kind: 'pending',
      pending: { reason: 'insufficient_evidence', detail: '手写证据不完整' },
      run_refs: [],
      cost_usd_micros: 0,
    });
    expect((await f.submit()).status).toBe(422);
    expect(
      (await testDb().select().from(question).where(eq(question.id, f.id)))[0].draft_status,
    ).toBe('draft');
    expect(
      (
        await f.submit({
          assessment: {
            ...f.assessment,
            evaluation_group_id: 'different-original',
            idempotency_key: 'different-key',
          },
        })
      ).status,
    ).toBe(409);
    expect((await f.submit()).status).toBe(422);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(
      await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:assessment_activation')),
    ).toHaveLength(0);
  });

  it('rejects a future diagnostic before capture or model execution', async () => {
    const f = await fixture();
    const [row] = await testDb().select().from(question).where(eq(question.id, f.id));
    await testDb()
      .update(question)
      .set({
        metadata: {
          intervention_diagnostic: {
            ...(row.metadata?.intervention_diagnostic as Record<string, unknown>),
            due_at: new Date(Date.now() + 86400000).toISOString(),
          },
        },
      })
      .where(eq(question.id, f.id));
    expect((await f.submit()).status).toBe(409);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await testDb().select().from(assessment_submission)).toHaveLength(0);
  });

  it('rejects a second answer identity after one-shot acceptance', async () => {
    const f = await fixture();
    expect((await f.submit({ response_md: '原答' })).status).toBe(200);
    const response = await f.submit({
      response_md: '再次作答',
      assessment: {
        ...f.assessment,
        idempotency_key: 'another-attempt',
        evaluation_group_id: 'another-group',
      },
    });
    expect(response.status).toBe(409);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await testDb().select().from(assessment_submission)).toHaveLength(1);
  });

  it('rejects changed original bytes on the accepted identity without freeing its claim', async () => {
    const f = await fixture();
    expect((await f.submit({ response_md: '原答' })).status).toBe(200);
    const response = await f.submit({
      response_md: '改答',
      assessment: {
        ...f.assessment,
        response_set: {
          entries: [
            {
              slot_id: f.assessment.response_set.entries[0].slot_id,
              kind: 'open',
              text_md: '改成10',
              evidence: [],
            },
          ],
        },
      },
    });
    expect(response.status).toBe(409);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(
      (await testDb().select().from(question).where(eq(question.id, f.id)))[0].draft_status,
    ).toBe('draft');
  });

  it('rejects blank native input even when observational flat text is nonempty', async () => {
    const f = await fixture();
    const response = await f.submit({
      response_md: '这不是评分原答',
      assessment: { ...f.assessment, response_set: { entries: [] } },
    });
    expect(response.status).toBe(400);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await testDb().select().from(evaluation)).toHaveLength(0);
    expect(
      await testDb()
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:assessment_attempt')),
    ).toHaveLength(0);
  });
});
