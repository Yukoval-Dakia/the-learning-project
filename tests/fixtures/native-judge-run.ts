import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { dispatchNativeAttempt } from '@/capabilities/practice/server/assessment/durable-attempt';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import type { NativeJudgeRunJobData } from '@/capabilities/practice/server/judge-run-payload';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { issueSoloFixture } from './assessment-solo';

/** Real original/dispatch/worker fixture; only model and queue IO are offline. */
export async function nativeJudgeRunFixture(
  db: Db,
  options: {
    questionId?: string;
    knowledgeIds?: string[];
    now?: Date;
    response?: string;
    requireUnassistedModelEvidence?: boolean;
  } = {},
) {
  const questionId = options.questionId ?? `native_worker_${createId()}`;
  const [existing] = await db.select().from(question).where(eq(question.id, questionId));
  if (!existing) {
    const now = new Date();
    await db
      .insert(question)
      .values({
        id: questionId,
        prompt_md: '顺流18 km/h、逆流12 km/h，列方程说明如何求静水船速。',
        kind: 'short_answer',
        reference_md: 'v+c=18，v-c=12，相加得v=15 km/h。',
        knowledge_ids: options.knowledgeIds ?? [],
        difficulty: 3,
        source: 'manual',
        version: 0,
        created_at: now,
        updated_at: now,
      });
  }
  const issued = await issueSoloFixture(db, questionId, true);
  const request = {
    ...issued.assessment(options.response ?? 'v+c=18，v-c=12，消去水速得v=15 km/h。'),
    now: options.now,
  };
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
      feedback_md: '方程、消元和单位齐全。',
      confidence: 0.95,
      evidence_citations: [{ slot_id: input.response_slots[0].slot_id, quote: 'v=15 km/h' }],
      run_refs: [runId],
      cost_usd_micros: 120,
    }),
  );
  vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(() =>
    createRecordedModelExecutor(db, execute),
  );
  const jobs: NativeJudgeRunJobData[] = [];
  await dispatchNativeAttempt(
    db,
    questionId,
    request,
    {
      enabled: true,
      requireUnassistedModelEvidence: options.requireUnassistedModelEvidence,
      capture: { response_md: '原始观察文本', latency_ms: 456 },
    },
    {
      checkRateLimit: () => 1,
      boss: {
        send: async (_queue, data) => {
          jobs.push(data as NativeJudgeRunJobData);
          return createId();
        },
      },
    },
  );
  if (!jobs[0]) throw new Error('fixture was not dispatched');
  return { questionId, issued, request, execute, job: jobs[0], runId: jobs[0].run_id };
}
