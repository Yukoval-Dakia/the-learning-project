import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { commitFormalAttempt } from '@/capabilities/practice/server/assessment/attempt';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { artifact, evaluation, knowledge, question } from '@/db/schema';
import {
  publishPaperModelFixture,
  startFrozenPaperFixture,
  submitPaperFixture,
} from './assessment-paper';
import { issueSoloFixture } from './assessment-solo';

/** Actual publication, original submission, recorded execution, and learning settlement. */
export async function nativeAppealFixture(
  db: Db,
  options: {
    points?: number;
    model?: boolean;
    userRating?: 'again' | 'hard' | 'good';
    paper?: boolean;
    now?: Date;
    knowledgeId?: string;
  } = {},
) {
  const questionId = `appeal_question_${createId()}`;
  const knowledgeId = options.knowledgeId ?? `appeal_kc_${createId()}`;
  const now = options.now ?? new Date();
  await db
    .insert(knowledge)
    .values({
      id: knowledgeId,
      name: '列方程与消元',
      domain: 'math',
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing();
  await db.insert(question).values({
    id: questionId,
    kind: options.model === false ? 'true_false' : 'short_answer',
    judge_kind_override: options.model === false ? 'exact' : null,
    prompt_md: '顺流18 km/h、逆流12 km/h。列方程求静水船速，并解释相加消元。',
    reference_md: options.model === false ? '正确' : 'v+c=18，v-c=12，相加得v=15 km/h。',
    knowledge_ids: [knowledgeId],
    difficulty: 3,
    source: 'manual',
    version: 0,
    created_at: now,
    updated_at: now,
  });
  let points = options.points ?? 0;
  const execute = vi.fn(
    async (
      input: ModelExecutorRequest,
      _signal: AbortSignal | undefined,
      runId: string,
    ): Promise<ModelUnitOutcomeT> => ({
      kind: 'scored',
      points_awarded: points * (input.unit.points ?? 0),
      matched: {
        rule_id:
          input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : 'fixture',
        option_ids: [],
      },
      feedback_md: points > 0 ? '复核原答：方程和单位成立。' : '原判未认可消元推导。',
      confidence: 0.95,
      evidence_citations: [{ slot_id: input.response_slots[0].slot_id, quote: 'v=15 km/h' }],
      run_refs: [runId],
      cost_usd_micros: 120,
    }),
  );
  vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(() =>
    createRecordedModelExecutor(db, execute),
  );
  const response = options.model === false ? '错误' : 'v+c=18，v-c=12，相加消去水速得 v=15 km/h。';
  let evaluationId: string;
  let attemptId: string;
  if (options.paper) {
    await publishPaperModelFixture(db, questionId);
    const paperId = `appeal_paper_${createId()}`;
    await db.insert(artifact).values({
      id: paperId,
      type: 'tool_quiz',
      title: '申诉原卷',
      knowledge_ids: [knowledgeId],
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: {
        question_ids: [questionId],
        sections: [
          {
            knowledge_focus: [knowledgeId],
            feedback_policy: 'immediate',
            adaptation_policy: 'none',
            assignments: [
              {
                question_id: questionId,
                primary_knowledge_id: knowledgeId,
                secondary_knowledge_ids: [],
                selection_reason: 'test',
                review_profile_snapshot: {},
              },
            ],
          },
        ],
      },
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      version: 0,
      created_at: now,
      updated_at: now,
    });
    const session = await startFrozenPaperFixture(db, paperId);
    const committed = await submitPaperFixture(
      {
        paperArtifactId: paperId,
        sessionId: session.sessionId,
        questionId,
        answerMd: response,
        answerImageRefs: [],
      },
      db,
    );
    attemptId = committed.attemptEventId;
    if (!committed.evaluationId) throw new Error('paper fixture was not evaluated');
    evaluationId = committed.evaluationId;
  } else {
    const issued = await issueSoloFixture(db, questionId, options.model !== false);
    const committed = await commitFormalAttempt(
      db,
      'solo_submit',
      questionId,
      { ...issued.assessment(response), now },
      { userRating: options.userRating },
    );
    evaluationId = committed.candidate.evaluation.record.evaluation_id;
    attemptId = committed.attempt_id;
  }
  const [original] = await db
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, evaluationId));
  return {
    questionId,
    knowledgeId,
    original,
    attemptId,
    execute,
    setPoints: (value: number) => {
      points = value;
    },
  };
}
