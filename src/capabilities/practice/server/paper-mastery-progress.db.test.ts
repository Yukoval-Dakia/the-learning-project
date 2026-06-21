// YUK-459 — paper/exam submit path must, on a graded SUCCESS, fire the same
// mastery-change signals the solo review path does (ADR-0040 决定2): emit the
// `experimental:mastery_progress` p(L)/Δθ̂ 埋点 + enqueue the mastery_change
// note-refine trigger. Previously paper-submit did NEITHER (solo-only), leaving
// paper attempts a dead line for note refinement. Mirrors submit.db.test.ts:208.

import { MASTERY_PROGRESS_ACTION } from '@/capabilities/notes/server/mastery-progress-signal';
import { artifact, event, knowledge, mastery_state, question } from '@/db/schema';
import { Review } from '@/server/session';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { submitPaperSlot } from './paper-submit';

async function seedKnowledge(id: string, domain = 'wenyan'): Promise<void> {
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

  it('emits experimental:mastery_progress carrying the real Δθ̂ on a graded paper success', async () => {
    const db = testDb();
    await seedKnowledge('k_pmp', 'wenyan');
    await seedTrueFalseQuestion('q_pmp', ['k_pmp']);
    await seedPaper('paper_pmp', ['q_pmp'], 'k_pmp');
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_pmp' });

    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_pmp',
        questionId: 'q_pmp',
        answerMd: 'true', // matches reference → success
        primaryKnowledgeId: 'k_pmp',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(submit.coarseOutcome).toBe('correct');

    // mastery_state has the freshly-written Δθ̂ (success → θ̂ rose above 0).
    const stateRows = await db
      .select()
      .from(mastery_state)
      .where(
        and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, 'k_pmp')),
      );
    expect(stateRows).toHaveLength(1);
    const realDelta = stateRows[0].last_theta_delta as number;
    expect(realDelta).toBeGreaterThan(0);

    const mpEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, MASTERY_PROGRESS_ACTION), eq(event.subject_id, 'k_pmp')));
    expect(mpEvents).toHaveLength(1);
    const payload = mpEvents[0].payload as Record<string, unknown>;
    expect(payload.theta_delta).toBeCloseTo(realDelta, 5);
    expect(payload.question_id).toBe('q_pmp');
    // RED LINE: observation only — no judging semantics (mirror solo).
    expect(mpEvents[0].outcome).toBeNull();
  });

  it('does NOT emit mastery_progress on a failed paper answer (gate = success, mirror solo)', async () => {
    const db = testDb();
    await seedKnowledge('k_pmp_fail', 'wenyan');
    await seedTrueFalseQuestion('q_pmp_fail', ['k_pmp_fail']);
    await seedPaper('paper_pmp_fail', ['q_pmp_fail'], 'k_pmp_fail');
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_pmp_fail' });

    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_pmp_fail',
        questionId: 'q_pmp_fail',
        answerMd: 'false', // != reference 'true' → failure
        primaryKnowledgeId: 'k_pmp_fail',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(submit.coarseOutcome).not.toBe('correct');

    const mpEvents = await db.select().from(event).where(eq(event.action, MASTERY_PROGRESS_ACTION));
    expect(mpEvents).toHaveLength(0);
  });
});
