import { FsrsStateSchema } from '@/core/schema/event/blocks';
// U5 (YUK-203) — end-to-end paper lifecycle DB test (Cross §11 highest single
// risk: the append-only frozen-rows × derived read-layer consistency).
//
// Covers the FULL cycle the Cross-统合 verdict points at:
//   draft → freeze(submit) → abandon → reopen(abandoned→started) → new draft →
//   re-freeze → re-judge
// and asserts, at each step:
//   - pos (COUNT DISTINCT slot WHERE submitted) does NOT double-count after a
//     reopen→resubmit (the append-only history would render "5/4" under a raw
//     COUNT);
//   - the partial unique index constrains ONLY the live draft (frozen rows are
//     append-only history);
//   - derived visibility (user-facing vs Coach-facing) is correct each step.
//
// Uses the deterministic `exact` judge (true_false question matched against
// reference_md) — no LLM / runTask mock needed.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Review from '@/capabilities/practice/session/server/review-session-lifecycle';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import {
  answer,
  artifact,
  assessment_issuance,
  evaluation,
  material_fsrs_state,
  question,
} from '@/db/schema';
import {
  publishPaperModelFixture,
  reopenFrozenPaperFixture,
  startFrozenPaperFixture,
  startHistoricalPaperFixture,
  submitPaperFixture as submitPaperSlot,
} from '../../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import * as evaluationService from '../../server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '../../server/judge/recorded-model-executor';
import { autosaveAnswerDraft, freezeAnswerDraft } from './answer-draft';
import { readPaperAssessmentBinding } from './assessment/paper-issuance';
import { getPaperDetail } from './paper-detail';

async function seedQuestion(id: string, reference: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'true_false',
    judge_kind_override: 'exact',
    prompt_md: `Prompt ${id}`,
    reference_md: reference,
    knowledge_ids: ['k1'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    created_at: now,
    updated_at: now,
  });
}

async function seedPaper(
  id: string,
  questionIds: string[],
  partRefs: string[] = [],
  feedbackPolicy = 'immediate',
) {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: '测试卷',
    knowledge_ids: ['k1'],
    intent_source: 'review_plan',
    source: 'ai_generated',
    tool_kind: 'review_plan',
    tool_state: {
      question_ids: questionIds,
      sections: [
        {
          knowledge_focus: ['k1'],
          feedback_policy: feedbackPolicy,
          adaptation_policy: 'none',
          assignments: questionIds.flatMap((qid) =>
            (partRefs.length ? partRefs : [null]).map((part_ref) => ({
              ...(part_ref ? { part_ref } : {}),
              question_id: qid,
              primary_knowledge_id: 'k1',
              secondary_knowledge_ids: [],
              selection_reason: 'test',
              review_profile_snapshot: {},
            })),
          ),
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

function scored(input: ModelExecutorRequest, runId: string, points = 1): ModelUnitOutcomeT {
  return {
    kind: 'scored',
    points_awarded: points,
    confidence: 0.95,
    matched: {
      rule_id:
        input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : undefined,
      option_ids: [],
    },
    evidence_citations: input.group_evidence.length
      ? [{ evidence_id: input.group_evidence[0].evidence.evidence_id }]
      : [{ slot_id: input.slot_responses[0].slot_id }],
    run_refs: [runId],
    cost_usd_micros: 80,
  };
}

function installExecutor(db: Db, execute: Parameters<typeof createRecordedModelExecutor>[1]) {
  return vi
    .spyOn(evaluationService, 'createFormalModelExecutor')
    .mockImplementation(() => createRecordedModelExecutor(db, execute));
}

async function modelPaper() {
  const db = testDb();
  await seedQuestion('q1', '必须列出方程、解释消元并保留速度单位。');
  await db.update(question).set({ judge_kind_override: 'semantic' }).where(eq(question.id, 'q1'));
  await publishPaperModelFixture(db, 'q1');
  await seedPaper('paper1', ['q1']);
  const { sessionId } = await startHistoricalPaperFixture(db, 'paper1');
  return {
    db,
    input: {
      sessionId,
      paperArtifactId: 'paper1',
      questionId: 'q1',
      answerMd: 'v+c=18，v-c=12，得2v=30，静水船速15 km/h。',
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('U5 paper lifecycle — draft/freeze/abandon/reopen/refreeze/rejudge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── issue #1: freeze UPDATE guarded by isNull(submitted_at) ─────────────────
  it('fix #1: freeze does not overwrite an already-frozen row (concurrent freeze guard)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await startFrozenPaperFixture(db, 'paper1');

    // Autosave a draft, then freeze it (simulates normal submit path).
    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'first draft',
      paperArtifactId: 'paper1',
    });
    const { answerId: frozenId } = await freezeAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'first answer',
      imageRefs: [],
      paperArtifactId: 'paper1',
      eventId: 'evt_first',
    });

    // Simulate a stale "concurrent" freeze arriving after the row is already frozen:
    // call freezeAnswerDraft again with the same slot. The guard (isNull check)
    // means no live draft is found; a NEW frozen row is inserted (no overwrite).
    const { answerId: secondId } = await freezeAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'second attempt',
      imageRefs: [],
      paperArtifactId: 'paper1',
      eventId: 'evt_second',
    });

    // Two distinct frozen rows — append-only, neither overwrote the other.
    expect(frozenId).not.toBe(secondId);

    // First frozen row retains its original content unchanged.
    const rows = await db.select().from(answer).where(eq(answer.id, frozenId));
    expect(rows[0].content_md).toBe('first answer');
    expect(rows[0].event_id).toBe('evt_first');
  });

  // @invariant concurrency: Concurrent paper requests produce one durable execution and one learning receipt
  // @fails-if concurrent callers charge twice or apply the accepted learning effect twice
  it('YUK-695: concurrent model requests share one durable execution and one accepted receipt', async () => {
    const { db, input } = await modelPaper();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(
      async (request: ModelExecutorRequest, _signal: AbortSignal | undefined, runId: string) => {
        await gate;
        return scored(request, runId);
      },
    );
    installExecutor(db, execute);
    const first = submitPaperSlot(input, db);
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      const second = submitPaperSlot(input, db);
      release();
      const results = await Promise.all([first, second]);
      expect(results[0]).toMatchObject({ coarseOutcome: 'correct' });
      expect(results[1]).toEqual(results[0]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await db.select().from(evaluation)).toHaveLength(1);
      expect(
        FsrsStateSchema.parse((await db.select().from(material_fsrs_state))[0].state).reps,
      ).toBe(1);
    } finally {
      release();
      await first;
    }
  });

  // ── YUK-1445: mixed papers stay openable — gate-refused slots are typed-withheld ──
  // @invariant grading: a mixed paper issues only gate-admitted slots — the refused slot never gains a learner-facing issuance row, and reopen never re-asks the gate into serving it
  // @fails-if make paper opening ignore per-slot serving decisions or issue-then-mask; the assessment_issuance row count or the typed withheld_slots reason assertions fail
  it('YUK-1445: mixed paper opens servable slots and lists gate-refused slots as typed withheld', async () => {
    const db = testDb();
    await seedQuestion('q_ok', 'true');
    await seedQuestion('q_model', '必须列出方程、解释消元并保留速度单位。');
    await db
      .update(question)
      .set({ judge_kind_override: 'semantic' })
      .where(eq(question.id, 'q_model'));
    await publishPaperModelFixture(db, 'q_model');
    await seedPaper('paper_mixed', ['q_ok', 'q_model']);

    const opened = await startFrozenPaperFixture(db, 'paper_mixed');
    const binding = await readPaperAssessmentBinding(db, opened.sessionId);
    expect(binding?.slots.map((slot) => slot.question_id)).toEqual(['q_ok']);
    expect(binding?.withheld_slots).toEqual([
      {
        question_id: 'q_model',
        part_ref: null,
        section_index: 0,
        reason: 'model_admission_unavailable',
      },
    ]);
    // The withheld slot has no learner-facing issuance row at all.
    expect(await db.select().from(assessment_issuance)).toHaveLength(1);

    const detail = await getPaperDetail(db, 'paper_mixed');
    expect(
      detail?.sections.flatMap((section) => section.slots).map((slot) => slot.question_id),
    ).toEqual(['q_ok']);
    expect(detail?.withheld_assessments).toEqual([
      {
        issuance_id: null,
        question_id: 'q_model',
        part_ref: null,
        reason: 'model_admission_unavailable',
      },
    ]);

    // Reopening an active session is idempotent: same session, no new issuance.
    const again = await startFrozenPaperFixture(db, 'paper_mixed');
    expect(again).toEqual({ sessionId: opened.sessionId, created: false });
    expect(await db.select().from(assessment_issuance)).toHaveLength(1);

    // Abandon → reopen is a fresh occurrence: a new binding + new issuance for
    // the servable slot; the gate-refused slot stays withheld, never issued.
    await Review.abandonReviewSession(db, opened.sessionId);
    await reopenFrozenPaperFixture(db, opened.sessionId);
    const reopened = await readPaperAssessmentBinding(db, opened.sessionId);
    expect(reopened?.slots.map((slot) => slot.question_id)).toEqual(['q_ok']);
    expect(reopened?.withheld_slots).toEqual(binding?.withheld_slots);
    expect(reopened?.slots[0]?.issuance_id).not.toBe(binding?.slots[0]?.issuance_id);
    expect(await db.select().from(assessment_issuance)).toHaveLength(2);
  });
});
