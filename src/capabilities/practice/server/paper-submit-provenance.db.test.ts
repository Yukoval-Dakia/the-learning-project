// YUK-589 (J1) — paper-submit execution-provenance honesty.
//
// execution_provenance is an AUDIT STAMP on the judge event, not a gate on the
// verdict. It must not lie about whether a model ran:
//   - a MODEL-backed route (semantic/steps/multimodal_direct/unit_dimension) whose
//     LLM call FAILED (provider down → coarse_outcome='unsupported', invoked.execution
//     absent) must stamp `historical_unknown`, NOT `deterministic` (a provider timeout
//     masquerading as a no-model deterministic verdict);
//   - a genuinely deterministic route (exact/true_false/keyword — no model ever runs)
//     stays `deterministic`.
//
// The paper path (unlike the solo auto_rate path, which 422s on an unsupported model
// verdict before persisting) records the unsupported judge event, so this is the
// reachable site for the model-route branch of the J1 fix.

import { artifact, event, question } from '@/db/schema';
import { runTask } from '@/server/ai/runner';
import { Review } from '@/server/session';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { submitPaperSlot } from './paper-submit';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(),
}));

async function seedQuestion(
  id: string,
  overrides: Partial<typeof question.$inferInsert>,
): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: '参考答案',
    knowledge_ids: ['kc_prov'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

async function seedPaper(id: string, questionIds: string[], primaryKc: string): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: 'provenance paper',
    knowledge_ids: [primaryKc],
    intent_source: 'review_plan',
    source: 'ai_generated',
    tool_kind: 'review_plan',
    tool_state: {
      question_ids: questionIds,
      sections: [
        {
          knowledge_focus: [primaryKc],
          feedback_policy: 'immediate',
          adaptation_policy: 'none',
          assignments: questionIds.map((qid) => ({
            question_id: qid,
            primary_knowledge_id: primaryKc,
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

async function readJudgeProvenance(
  attemptEventId: string,
): Promise<Record<string, unknown> | undefined> {
  const [judgeEvent] = await testDb()
    .select()
    .from(event)
    .where(and(eq(event.action, 'judge'), eq(event.subject_id, attemptEventId)));
  const payload = judgeEvent?.payload as Record<string, unknown> | undefined;
  return payload?.execution_provenance as Record<string, unknown> | undefined;
}

describe('YUK-589 — paper-submit execution provenance (J1)', () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(runTask).mockReset();
  });

  it('model route whose LLM call FAILED → execution_provenance kind=historical_unknown (not deterministic)', async () => {
    const db = testDb();
    // judge_kind_override='semantic' forces the model-backed route; the mocked
    // runTask rejects → runSemanticJudge returns coarse_outcome='unsupported' with
    // NO execution identity (the LLM call never completed).
    await seedQuestion('pq_sem_fail', { judge_kind_override: 'semantic' });
    await seedPaper('paper_sem_fail', ['pq_sem_fail'], 'kc_prov');
    vi.mocked(runTask).mockRejectedValue(new Error('provider down'));

    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_sem_fail' });
    const result = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_sem_fail',
        questionId: 'pq_sem_fail',
        answerMd: '我的作答',
        primaryKnowledgeId: 'kc_prov',
        secondaryKnowledgeIds: [],
      },
      db,
    );

    expect(result.coarseOutcome).toBe('unsupported');
    const prov = await readJudgeProvenance(result.attemptEventId);
    // The model call failed — an honest audit stamp is historical_unknown, never
    // deterministic (which would claim no model was ever meant to run).
    expect(prov?.kind).toBe('historical_unknown');
  });

  it('genuinely deterministic route (true_false) → execution_provenance kind=deterministic', async () => {
    const db = testDb();
    await seedQuestion('pq_tf', { kind: 'true_false', reference_md: 'true' });
    await seedPaper('paper_tf', ['pq_tf'], 'kc_prov');

    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_tf' });
    const result = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_tf',
        questionId: 'pq_tf',
        answerMd: 'true',
        primaryKnowledgeId: 'kc_prov',
        secondaryKnowledgeIds: [],
      },
      db,
    );

    expect(result.coarseOutcome).toBe('correct');
    const prov = await readJudgeProvenance(result.attemptEventId);
    // No model was ever meant to run for an exact/true_false compare.
    expect(prov?.kind).toBe('deterministic');
    // runTask must never be spent on a deterministic route.
    expect(vi.mocked(runTask)).not.toHaveBeenCalled();
  });

  // YUK-589 (K1) — the CORE fix. unit_dimension is in the MODEL_BACKED set, but on
  // the common path it resolves via the LOCAL accelerator and never calls the LLM.
  // Wave-1 stamped `historical_unknown` off route membership alone (route ∈ model
  // set AND execution absent) — a lie: no model was attempted. The honest stamp is
  // `deterministic`, keyed on the model-attempt signal (modelAttempted:false), NOT
  // route membership.
  it('accelerator-resolved unit_dimension → execution_provenance kind=deterministic (no model attempted)', async () => {
    const db = testDb();
    await seedQuestion('pq_unit_accel', {
      judge_kind_override: 'unit_dimension',
      kind: 'calculation',
      prompt_md: '速度是多少？',
      reference_md: '30 m/s',
      metadata: { reference_value: 30, reference_unit: 'm/s' },
    });
    await seedPaper('paper_unit_accel', ['pq_unit_accel'], 'kc_prov');

    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_unit_accel' });
    const result = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_unit_accel',
        questionId: 'pq_unit_accel',
        // A directly parseable numeric+unit answer → accelerator resolves, no LLM fallback.
        answerMd: '30 m/s',
        primaryKnowledgeId: 'kc_prov',
        secondaryKnowledgeIds: [],
      },
      db,
    );

    expect(result.coarseOutcome).toBe('correct');
    const prov = await readJudgeProvenance(result.attemptEventId);
    expect(prov?.kind).toBe('deterministic');
    // The local accelerator produced the verdict — the LLM was never called.
    expect(vi.mocked(runTask)).not.toHaveBeenCalled();
  });
});
