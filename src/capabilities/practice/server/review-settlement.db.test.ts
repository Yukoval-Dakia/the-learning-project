import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@/core/ids';
import { artifact, event, mastery_state, material_fsrs_state, question } from '@/db/schema';
import { Review } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { CreateAttemptBodySchema } from '../api/contracts';
import type { JudgedSubmit, ValidatedSubmit } from '../api/submit';
import { normalizeReviewSubmitActivityRef } from './activity-ref';
import { loadQuestionWithAttemptSnapshot } from './question-evidence-snapshot';
import { settleInlineSoloReview, settlePaperSlotReview } from './review-settlement';

async function seedQuestion(id: string, knowledgeIds: string[] = ['kc_contract']) {
  const now = new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      prompt_md: `Prompt for ${id}`,
      kind: 'true_false',
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

async function validated(questionId: string): Promise<ValidatedSubmit> {
  const body = CreateAttemptBodySchema.parse({
    question_id: questionId,
    rating: 'good',
    response_md: 'true',
    auto_rate: false,
  });
  const [q] = await testDb().select().from(question).where(eq(question.id, questionId));
  return {
    body,
    now: new Date(),
    questionId,
    activityRef: normalizeReviewSubmitActivityRef(body).activity_ref,
    q,
  };
}

function manualJudged(): JudgedSubmit {
  return {
    judgeResult: null,
    judgeRoute: null,
    judgeTelemetry: null,
    executionProvenance: null,
    suggestedRating: null,
    finalRating: 'good',
    adviceCauseCategory: null,
    adviceSubjectProfile: null,
  };
}

async function seedPaper(id: string, questionId: string) {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'tool_quiz',
      title: 'settlement contract paper',
      knowledge_ids: ['kc_contract'],
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: {
        question_ids: [questionId],
        sections: [
          {
            knowledge_focus: ['kc_contract'],
            feedback_policy: 'immediate',
            adaptation_policy: 'none',
            assignments: [
              {
                question_id: questionId,
                primary_knowledge_id: 'kc_contract',
                secondary_knowledge_ids: [],
                selection_reason: 'contract test',
                review_profile_snapshot: {},
              },
            ],
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

describe('sealed review settlement commands', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inline owns FSRS, theta, sibling snapshots, and the success signal as one effect', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);

    const receipt = await settleInlineSoloReview(db, {
      validated: await validated(questionId),
      judged: manualJudged(),
    });

    expect(receipt.effect).toBe('applied');
    expect(await db.select().from(material_fsrs_state)).toHaveLength(1);
    expect(await db.select().from(mastery_state)).toHaveLength(1);
    const snapshots = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:state_snapshot'),
          eq(event.subject_id, receipt.attemptEventId),
        ),
      );
    expect(snapshots.map((row) => row.id).sort()).toEqual([
      `${receipt.attemptEventId}:snapshot:fsrs`,
      `${receipt.attemptEventId}:snapshot:theta`,
    ]);
    const progress = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:mastery_progress'),
          eq(event.caused_by_event_id, receipt.attemptEventId),
        ),
      );
    expect(progress).toHaveLength(1);
  });

  it('paper ungraded freezes once, replays by content, and never mutates learning state', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    const paperId = `paper_${newId()}`;
    await seedQuestion(questionId);
    await seedPaper(paperId, questionId);
    const { sessionId } = await Review.startReviewSession(db, { artifactId: paperId });
    const loaded = await loadQuestionWithAttemptSnapshot(db, questionId);
    const command = {
      paper: {
        sessionId,
        artifactId: paperId,
        partRef: null,
        feedbackPolicy: 'immediate',
      },
      answerSnapshot: {
        markdown: '',
        imageRefs: ['asset://handwriting'],
        question: loaded.question_snapshot,
      },
      question: loaded.question,
      knowledge: {
        primaryId: 'kc_contract',
        secondaryIds: [],
      },
      judgement: {
        kind: 'ungraded' as const,
        reason: 'photo_only_unsupported' as const,
      },
      submittedAt: new Date(),
    };

    const first = await settlePaperSlotReview(db, command);
    const second = await settlePaperSlotReview(db, { ...command, submittedAt: new Date() });

    expect(first).toMatchObject({ effect: 'ungraded', replayed: false });
    expect(second).toMatchObject({
      effect: 'ungraded',
      replayed: true,
      attemptEventId: first.attemptEventId,
      answerId: first.answerId,
    });
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
    expect(await db.select().from(mastery_state)).toHaveLength(0);
    const attemptRows = await db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.subject_id, questionId)));
    expect(attemptRows).toHaveLength(1);
    const derived = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.caused_by_event_id, first.attemptEventId));
    expect(derived).toHaveLength(0);
  });
});
