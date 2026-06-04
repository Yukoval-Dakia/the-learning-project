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

import { answer, event, question } from '@/db/schema';
import { artifact } from '@/db/schema';
import { Review } from '@/server/session';
import { and, desc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { autosaveAnswerDraft, countAnsweredSlots, freezeAnswerDraft } from './answer-draft';
import { submitPaperSlot } from './paper-submit';
import { getPracticeList, isJudgementVisibleToUser } from './practice-read';

async function seedQuestion(id: string, reference: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'true_false',
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

async function seedPaper(id: string, questionIds: string[]) {
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
          feedback_policy: 'immediate',
          adaptation_policy: 'none',
          assignments: questionIds.map((qid) => ({
            question_id: qid,
            primary_knowledge_id: 'k1',
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

describe('U5 paper lifecycle — draft/freeze/abandon/reopen/refreeze/rejudge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('full cycle: pos never double-counts, partial index constrains only live drafts', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedQuestion('q2', 'true');
    await seedPaper('paper1', ['q1', 'q2']);

    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper1' });

    // ── 1. DRAFT q1 (autosave). One live draft, no frozen rows, pos=0. ──
    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'tru',
      paperArtifactId: 'paper1',
    });
    // Re-autosave the SAME slot: upsert in place, still one live draft.
    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'true',
      paperArtifactId: 'paper1',
    });
    const liveAfterDraft = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    expect(liveAfterDraft).toHaveLength(1);
    expect(liveAfterDraft[0].submitted_at).toBeNull();
    expect(liveAfterDraft[0].content_md).toBe('true');
    expect(await countAnsweredSlots(db, sessionId)).toBe(0);

    // ── 2. FREEZE q1 via submit (correct answer → attempt success + judge). ──
    const submit1 = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(submit1.coarseOutcome).toBe('correct');
    expect(submit1.visibleToUser).toBe(true);
    // One frozen row for q1; pos=1 (one distinct answered slot).
    const frozen1 = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    expect(frozen1).toHaveLength(1);
    expect(frozen1[0].submitted_at).not.toBeNull();
    expect(frozen1[0].event_id).toBe(submit1.attemptEventId);
    expect(await countAnsweredSlots(db, sessionId)).toBe(1);

    // attempt + independent judge event written, judge chains the attempt.
    const judge1 = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.subject_kind, 'event')));
    expect(judge1).toHaveLength(1);
    expect(judge1[0].subject_id).toBe(submit1.attemptEventId);
    expect(judge1[0].caused_by_event_id).toBe(submit1.attemptEventId);

    // ── 3. ABANDON the session. ──
    await Review.abandonReviewSession(db, sessionId);

    // ── 4. REOPEN (abandoned → started ONLY). ──
    await Review.reopenAbandonedReviewSession(db, sessionId);

    // ── 5. NEW DRAFT on the SAME slot q1 — allowed (old row frozen, excluded
    //       from the partial index). Two rows now: one frozen + one live. ──
    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'false',
      paperArtifactId: 'paper1',
    });
    const afterReopenDraft = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')))
      .orderBy(desc(answer.submitted_at));
    expect(afterReopenDraft).toHaveLength(2);
    const liveRows = afterReopenDraft.filter((r) => r.submitted_at === null);
    expect(liveRows).toHaveLength(1); // partial index allows exactly one live draft
    // pos still 1 — the new live draft is NOT submitted yet.
    expect(await countAnsweredSlots(db, sessionId)).toBe(1);

    // ── 6. RE-FREEZE / RE-JUDGE q1 (now wrong answer → incorrect). ──
    const submit2 = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'false',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(submit2.coarseOutcome).toBe('incorrect');
    // Two frozen rows for q1 now (append-only history), but pos = 1 (DISTINCT
    // slot) — NOT 2. This is the core anti-double-count assertion.
    const frozenAfterReJudge = await db
      .select()
      .from(answer)
      .where(and(eq(answer.session_id, sessionId), eq(answer.question_id, 'q1')));
    const frozenCount = frozenAfterReJudge.filter((r) => r.submitted_at !== null).length;
    expect(frozenCount).toBe(2);
    expect(await countAnsweredSlots(db, sessionId)).toBe(1); // NOT 2

    // Two judge events for q1's two attempts (rejudge = new event, D6). The
    // read layer takes newest-per-attempt; the practice-list right/wrong takes
    // newest-attempt-per-slot.
    const allJudges = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.subject_kind, 'event')));
    expect(allJudges).toHaveLength(2);

    // ── 7. Practice list aggregation: pos=1 (q1 answered once distinct),
    //       right/wrong from NEWEST attempt per slot → q1 latest is incorrect. ──
    const practice = await getPracticeList(db);
    const paper = practice.papers.find((p) => p.artifact_id === 'paper1');
    expect(paper).toBeDefined();
    expect(paper?.source).toBe('coach'); // review_plan → Coach 排期
    expect(paper?.total_slots).toBe(2);
    expect(paper?.session?.pos).toBe(1); // distinct answered slot
    expect(paper?.session?.wrong).toBe(1); // newest q1 attempt is incorrect
    expect(paper?.session?.right).toBe(0);
  });

  it('partial index rejects a second live draft on the same slot (DB-level guard)', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper1' });

    await autosaveAnswerDraft(db, {
      sessionId,
      questionId: 'q1',
      inputKind: 'text',
      contentMd: 'a',
      paperArtifactId: 'paper1',
    });
    // A raw INSERT bypassing the upsert helper must collide on answer_draft_slot_uk.
    await expect(
      db.insert(answer).values({
        id: 'forced_dup',
        question_id: 'q1',
        input_kind: 'text',
        content_md: 'b',
        image_refs: [],
        tags: [],
        submitted_at: null,
        session_id: sessionId,
        part_ref: null,
        autosaved_at: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('hidden judgement (feedback_policy=judge_now_show_later) is buffered until completion', async () => {
    const db = testDb();
    await seedQuestion('q1', 'true');
    await seedPaper('paper1', ['q1']);
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper1' });

    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper1',
        questionId: 'q1',
        answerMd: 'true',
        primaryKnowledgeId: 'k1',
        feedbackPolicy: 'judge_now_show_later',
      },
      db,
    );
    expect(submit.visibleToUser).toBe(false);

    // The judge event carries visible_to_user:false.
    const judge = (
      await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'judge'), eq(event.subject_kind, 'event')))
    )[0];
    const payload = judge.payload as { visible_to_user?: boolean };
    expect(payload.visible_to_user).toBe(false);

    // Derived visibility (§4.9):
    // started session → hidden to user, always visible to Coach.
    expect(isJudgementVisibleToUser({ visibleToUser: false, sessionStatus: 'started' })).toBe(
      false,
    );
    // abandoned does NOT reveal.
    expect(isJudgementVisibleToUser({ visibleToUser: false, sessionStatus: 'abandoned' })).toBe(
      false,
    );
    // completed reveals.
    expect(isJudgementVisibleToUser({ visibleToUser: false, sessionStatus: 'completed' })).toBe(
      true,
    );
    // an immediately-visible judgement (undefined) is always visible.
    expect(isJudgementVisibleToUser({ visibleToUser: undefined, sessionStatus: 'started' })).toBe(
      true,
    );
  });
});
