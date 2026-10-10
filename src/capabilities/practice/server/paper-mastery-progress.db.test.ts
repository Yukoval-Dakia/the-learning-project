// YUK-459 — paper/exam submit path must, on a graded SUCCESS, fire the same
// mastery-change signals the solo review path does (ADR-0040 决定2): emit the
// `experimental:mastery_progress` p(L)/Δθ̂ 埋点 + enqueue the mastery_change
// note-refine trigger. Previously paper-submit did NEITHER (solo-only), leaving
// paper attempts a dead line for note refinement. Mirrors submit.db.test.ts:208.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { MASTERY_PROGRESS_ACTION } from '@/capabilities/practice/server/mastery-progress-signal';
import { artifact, event, knowledge, mastery_state, question } from '@/db/schema';
import {
  paperFixtureAssessment,
  startFrozenPaperFixture,
  submitPaperFixture as submitPaperSlot,
} from '../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { prepareFormalAttemptSubmission } from './assessment/attempt';

async function seedKnowledge(id: string, domain = 'yuwen'): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedTrueFalseQuestion(id: string, knowledgeIds: string[]): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'true_false',
      judge_kind_override: 'exact',
      prompt_md: `Prompt ${id}`,
      reference_md: 'true',
      knowledge_ids: knowledgeIds,
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      version: 0,
      created_at: now,
      updated_at: now,
    });
}

async function seedPaper(id: string, questionIds: string[], focusKid: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'tool_quiz',
      title: 'YUK-459 paper',
      knowledge_ids: [focusKid],
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: {
        question_ids: questionIds,
        sections: [
          {
            knowledge_focus: [focusKid],
            feedback_policy: 'immediate',
            adaptation_policy: 'none',
            assignments: questionIds.map((qid) => ({
              question_id: qid,
              primary_knowledge_id: focusKid,
              secondary_knowledge_ids: [],
              selection_reason: 'test',
              review_profile_snapshot: {},
            })),
          },
        ],
      } as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

describe('YUK-459 — paper submit fires mastery-change signals on success', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('observes a late result at its original learning position and does not emit for replayed neighbors', async () => {
    const db = testDb();
    await seedKnowledge('k_ordered', 'yuwen');
    await seedTrueFalseQuestion('q_early', ['k_ordered']);
    await seedTrueFalseQuestion('q_later', ['k_ordered']);
    await seedPaper('paper_early', ['q_early'], 'k_ordered');
    await seedPaper('paper_later', ['q_later'], 'k_ordered');
    const early = await startFrozenPaperFixture(db, 'paper_early');
    const earlyAssessment = await paperFixtureAssessment(db, early.sessionId, 'q_early', 'true');
    await prepareFormalAttemptSubmission(db, 'paper_submit', 'q_early', earlyAssessment);
    const later = await startFrozenPaperFixture(db, 'paper_later');
    await submitPaperSlot(
      {
        sessionId: later.sessionId,
        paperArtifactId: 'paper_later',
        questionId: 'q_later',
        answerMd: 'true',
      },
      db,
    );
    const completed = await submitPaperSlot(
      {
        sessionId: early.sessionId,
        paperArtifactId: 'paper_early',
        questionId: 'q_early',
        answerMd: 'true',
        assessment: earlyAssessment,
      },
      db,
    );
    const signals = await db.select().from(event).where(eq(event.action, MASTERY_PROGRESS_ACTION));
    expect(signals).toHaveLength(2);
    const ownSignal = signals.find(
      (row) => row.payload.attempt_event_id === completed.attemptEventId,
    );
    expect(ownSignal).toBeDefined();
    if (!ownSignal) throw new Error('expected ownSignal');
    const settlements = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    const ownSettlement = settlements.find(
      (row) => row.payload.evaluation_id === completed.evaluationId,
    );
    expect(ownSettlement).toBeDefined();
    if (!ownSettlement) throw new Error('expected ownSettlement');
    const [snapshot] = await db
      .select()
      .from(event)
      .where(eq(event.id, `${ownSettlement.id}:snapshot:theta`));
    const transitions = snapshot.payload.theta_snapshots as Array<{
      kc_id: string;
      before: number | null;
      after: number;
    }>;
    const transition = transitions.find((row) => row.kc_id === 'k_ordered');
    expect(transition).toBeDefined();
    if (!transition) throw new Error('expected transition');
    expect(ownSignal.payload.theta_delta).toBeCloseTo(
      transition.after - (transition.before ?? 0),
      6,
    );
    const [state] = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k_ordered'));
    expect(state.evidence_count).toBe(2);
    expect(state.last_theta_delta).not.toBeCloseTo(ownSignal.payload.theta_delta as number, 6);
  });
});
