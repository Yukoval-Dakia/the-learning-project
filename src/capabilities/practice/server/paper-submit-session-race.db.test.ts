import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { answer, artifact, assessment_submission, event } from '@/db/schema';
import { seedFrozenSolveQuestion } from '../../../../tests/fixtures/assessment-solve';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createPaperReviewSession } from '../api/paper-session-create';
import { submitNativePaperAttempt } from './assessment/paper-attempt';
import { readPaperAssessmentBinding } from './assessment/paper-issuance';
import { saveResponseDraft } from './assessment/submit';

async function fixture() {
  const db = testDb();
  const q = await seedFrozenSolveQuestion(db);
  const paperId = createId();
  await db.insert(artifact).values({
    id: paperId,
    type: 'tool_quiz',
    title: 'Session race: preserve the original derivation',
    knowledge_ids: [],
    intent_source: 'review_plan',
    source: 'ai_generated',
    tool_kind: 'review_plan',
    tool_state: { question_ids: [q.id] },
    generation_status: 'ready',
    verification_status: 'not_required',
    history: [],
    created_at: new Date(),
    updated_at: new Date(),
    version: 0,
  });
  const { sessionId } = await createPaperReviewSession(paperId);
  const binding = await readPaperAssessmentBinding(db, sessionId);
  if (!binding) throw new Error('paper binding absent');
  const assessment = { ...binding.slots[0], response_set: q.responseSet('a+b') };
  expect(
    await saveResponseDraft(db, {
      ...assessment,
      evaluation_group_ref: assessment.evaluation_group_id,
    }),
  ).toMatchObject({ status: 'saved' });
  return {
    input: { sessionId, paperArtifactId: paperId, questionId: q.id, assessment, answerMd: 'a+b' },
    binding,
  };
}

beforeEach(resetDb);
describe('paper original and capture share the session occurrence lock', () => {
  it('concurrent identical submissions share one original and capture without lock inversion', async () => {
    const db = testDb();
    const { input } = await fixture();
    const results = await Promise.all([
      submitNativePaperAttempt(db, input),
      submitNativePaperAttempt(db, input),
    ]);
    expect(results[0]).toMatchObject({
      answerId: results[1].answerId,
      attemptEventId: results[1].attemptEventId,
    });
    expect(await db.select().from(assessment_submission)).toHaveLength(1);
    expect(await db.select().from(answer)).toHaveLength(1);
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
    ).toHaveLength(1);
  });
});
