import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import {
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
} from '@/core/schema/intervention';
import { assessment_submission, knowledge, question } from '@/db/schema';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import * as evaluationService from '../server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '../server/judge/recorded-model-executor';
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
});
