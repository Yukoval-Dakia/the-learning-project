import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { answer, artifact, assessment_submission, event, learning_session } from '@/db/schema';
import { seedFrozenSolveQuestion } from '../../../../tests/fixtures/assessment-solve';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createPaperReviewSession } from '../api/paper-session-create';
import { submitNativePaperAttempt } from './assessment/paper-attempt';
import { readPaperAssessmentBinding } from './assessment/paper-issuance';
import { getIssuanceState, saveResponseDraft } from './assessment/submit';

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

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
  it.each(['completed', 'abandoned', 'reopened'] as const)(
    '%s wins while submission is waiting: no immutable original or draft loss',
    async (terminal) => {
      const db = testDb();
      const { input, binding } = await fixture();
      const draftBefore = (await getIssuanceState(db, input.assessment.issuance_id)).draft;
      const locked = gate(),
        finishTerminal = gate();
      const terminalWrite = db.transaction(async (tx) => {
        await tx
          .select()
          .from(learning_session)
          .where(eq(learning_session.id, input.sessionId))
          .for('update');
        locked.release();
        await finishTerminal.promise;
        await tx
          .update(learning_session)
          .set(
            terminal === 'reopened'
              ? { status: 'started', started_at: new Date(Date.parse(binding.started_at) + 60_000) }
              : { status: terminal },
          )
          .where(eq(learning_session.id, input.sessionId));
      });
      await locked.promise;
      const submission = submitNativePaperAttempt(db, input).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(
          async () => {
            const waiting = await db.execute(sql`SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%learning_session%' AND pid <> pg_backend_pid()`);
            expect(waiting.length).toBeGreaterThan(0);
          },
          { timeout: 10_000 },
        );
      } finally {
        finishTerminal.release();
        await terminalWrite;
      }
      expect(await submission).toHaveProperty('error');
      expect(await db.select().from(assessment_submission)).toHaveLength(0);
      expect((await getIssuanceState(db, input.assessment.issuance_id)).draft).toEqual(draftBefore);
      expect(await db.select().from(answer)).toHaveLength(0);
      expect(
        await db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
      ).toHaveLength(0);
    },
  );

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

  it('submission wins: capture and immutable original survive completion and accepted-original retry', async () => {
    const db = testDb();
    const { input } = await fixture();
    const accepted = await submitNativePaperAttempt(db, input);
    const originals = await db.select().from(assessment_submission);
    const captures = await db.select().from(answer);
    expect(originals).toHaveLength(1);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ event_id: accepted.attemptEventId, content_md: 'a+b' });
    await db
      .update(learning_session)
      .set({ status: 'completed' })
      .where(eq(learning_session.id, input.sessionId));
    expect(await submitNativePaperAttempt(db, input)).toMatchObject({
      answerId: accepted.answerId,
      attemptEventId: accepted.attemptEventId,
    });
    expect(await db.select().from(assessment_submission)).toEqual(originals);
    expect(await db.select().from(answer)).toEqual(captures);
    expect((await getIssuanceState(db, input.assessment.issuance_id)).draft).toBeNull();
  });
});
