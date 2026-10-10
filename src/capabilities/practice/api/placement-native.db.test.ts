import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import type { ResponseSetT } from '@/core/schema/assessment';
import {
  assessment_issuance,
  assessment_submission,
  event,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { publishPlacementFixture } from '../../../../tests/fixtures/assessment-placement';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import type { SaveSubmissionRequest } from '../server/assessment/submit';
import {
  PlacementQuestionSelectionResponseSchema,
  PlacementSessionCreatedSchema,
} from './placement-contracts';
import { createPlacementQuestionSelection as next } from './placement-next';
import { createPlacementSession as start } from './placement-start';
import { createAttemptResource as submit } from './submit';

const db = testDb();
const request = (body: unknown) =>
  new Request('http://test/api/placement', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(async () => {
  await resetDb();
  setTestConfig({ PLACEMENT_PROBE_ENABLED: true });
});
afterEach(() => {
  resetTestConfig();
  vi.restoreAllMocks();
});
async function seed(id = 'q1', publish = true) {
  const now = new Date();
  const [kc] = await db.select().from(knowledge).where(eq(knowledge.id, 'kc1'));
  if (!kc)
    await db.insert(knowledge).values({
      id: 'kc1',
      name: '变化率',
      domain: 'math',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `在非零分母条件下化简分式。${id}`,
    reference_md: 'fixture answer',
    judge_kind_override: 'exact',
    knowledge_ids: ['kc1'],
    difficulty: 3,
    source: 'manual',
    draft_status: 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  if (publish) await publishPlacementFixture(db, id);
}
async function open() {
  const response = await start(request({ knowledgeIds: ['kc1'] }));
  expect(response.status).toBe(200);
  const session = PlacementSessionCreatedSchema.parse(await response.json());
  if (!session.question) throw new Error('missing placement question');
  return { ...session, question: session.question };
}
type Open = Awaited<ReturnType<typeof open>>;
function original(
  session: Open,
  text = 'fixture answer',
): SaveSubmissionRequest & { submission_id: string } {
  const binding = session.question.assessment;
  const spec = binding.state.practice_dto?.response_spec.slots.find((s) => s.kind !== 'table');
  if (!spec) throw new Error('missing response slot');
  const responseSet: ResponseSetT = {
    entries: [{ slot_id: spec.slot_id, kind: 'text', text_md: text }],
  };
  return {
    issuance_id: binding.issuance_id,
    submission_id: binding.submission_id,
    evaluation_group_id: binding.evaluation_group_id,
    idempotency_key: binding.idempotency_key,
    response_set: responseSet,
    group_evidence: [],
  };
}
async function selection(sessionId: string, body: unknown = {}) {
  const response = await next(request(body), { id: sessionId });
  expect(response.status).toBe(200);
  return PlacementQuestionSelectionResponseSchema.parse(await response.json());
}
async function answer(session: Open, assessment = original(session)) {
  return submit(
    request({
      question_id: session.question.questionId,
      session_id: session.sessionId,
      rating: 'good',
      auto_rate: true,
      response_md: 'observational text',
      latency_ms: 3456,
      referenced_knowledge_ids: [],
      assessment,
    }),
  );
}

describe('placement frozen native workflow', () => {
  it('recovers the identical issuance on concurrent next, refresh and lost selection responses', async () => {
    await seed();
    await seed('q2');
    const session = await open();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => selection(session.sessionId)),
    );
    for (const response of responses) {
      expect(response.done).toBe(false);
      if (response.done) throw new Error('not done');
      expect(response.question).toEqual(session.question);
    }
    expect(await db.select().from(assessment_issuance)).toHaveLength(1);
    await db
      .update(question)
      .set({ prompt_md: 'mutable current text', reference_md: 'changed key' })
      .where(eq(question.id, 'q1'));
    const restored = await selection(session.sessionId);
    if (restored.done) throw new Error('not done');
    expect(restored.question?.assessment.state.practice_dto).toEqual(
      session.question.assessment.state.practice_dto,
    );
    const result = await answer(session);
    expect(result.status).toBe(201);
    expect((await result.json()).status).toBe('effective');
    const nextResponses = await Promise.all([
      selection(session.sessionId),
      selection(session.sessionId),
    ]);
    expect(nextResponses[0]).toEqual(nextResponses[1]);
    expect(nextResponses[0]).toMatchObject({ answeredCount: 1, question: { questionId: 'q2' } });
    expect(await db.select().from(assessment_issuance)).toHaveLength(2);
  });

  it('counts native participation once and preserves once-only theta and FSRS on duplicate commits', async () => {
    await seed();
    const session = await open();
    expect((await answer(session)).status).toBe(201);
    const state1 = {
      mastery: await db.select().from(mastery_state),
      fsrs: await db.select().from(material_fsrs_state),
    };
    expect(state1.mastery.some((row) => row.subject_id === 'kc1' && row.evidence_count === 1)).toBe(
      true,
    );
    expect(state1.fsrs.length).toBeGreaterThan(0);
    expect((await answer(session)).status).toBe(201);
    expect(await db.select().from(mastery_state)).toEqual(state1.mastery);
    expect(await db.select().from(material_fsrs_state)).toEqual(state1.fsrs);
    expect(await db.select().from(assessment_submission)).toHaveLength(1);
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
    ).toHaveLength(1);
    expect(await selection(session.sessionId, { cap: 1 })).toEqual({
      done: true,
      reason: 'cap',
      answeredCount: 1,
    });
  });
});
