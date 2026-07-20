// M2 (YUK-316, D15) — 申诉自动重判链 E2E：appeal API 写事件 → handler 重跑
// （mock judgeFn）→ 改判（新 judge + CorrectEvent supersede 直接生效，经
// effective-truth 断言）/ 维持（appeal_upheld 留痕）/ 幂等跳过。
// FSRS 刻意不在 handler 内重写（设计稿语义：评级是用户确认动作）——见 rejudge.ts 头注。

import type { ThetaRowSnapshotT } from '@/core/schema/event/state-snapshot';
import { event, knowledge, mastery_state, question } from '@/db/schema';
import type { JudgeAnswerResult } from '@/server/ai/judges/question-contract';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueHubAutoSync } = vi.hoisted(() => ({
  enqueueHubAutoSync: vi.fn(async () => undefined),
}));
vi.mock('@/server/boss/hub-auto-sync-enqueue', () => ({ enqueueHubAutoSync }));
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { writeAttemptSnapshotBrackets } from '../../practice/server/attempt-snapshot';
import { POST as appealPost } from '../api/appeal';
import { getEffectiveTruth } from '../server/effective-truth';
import { type RejudgeDeps, handleRejudge } from './rejudge';

function mockJudge(outcome: 'correct' | 'partial' | 'incorrect', feedback: string) {
  const base = {
    score_meaning: 'correctness' as const,
    confidence: 0.8,
    capability_ref: { id: 'semantic', version: '1.0.0' },
    feedback_md: feedback,
    evidence_json: {},
  };
  // JudgeResultV2 是按 coarse_outcome 判别的 union——逐分支构造字面量。
  const result =
    outcome === 'correct'
      ? { ...base, coarse_outcome: 'correct' as const, score: 0.9 }
      : outcome === 'partial'
        ? { ...base, coarse_outcome: 'partial' as const, score: 0.5 }
        : { ...base, coarse_outcome: 'incorrect' as const, score: 0 as const };
  return async (): Promise<JudgeAnswerResult> => ({ route: 'semantic', result });
}

// YUK-561 S4 — rich verbatim θ̂ `before` for the seeded snapshot bracket.
function richBefore(theta_hat: number): ThetaRowSnapshotT {
  return {
    theta_hat,
    evidence_count: 2,
    success_count: 1,
    fail_count: 1,
    theta_precision: 3,
    last_theta_delta: 0.1,
    last_outcome_at: new Date('2026-06-01T00:00:00Z'),
    rt_correct_ms: null,
    theta_grid_json: null,
  };
}

async function readTheta(kcId: string): Promise<number | null> {
  const rows = await testDb()
    .select({ theta: mastery_state.theta_hat })
    .from(mastery_state)
    .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, kcId)))
    .limit(1);
  return rows[0]?.theta ?? null;
}

async function readReprojectMarkers(appealEventId: string) {
  const rows = await testDb()
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:reproject_deferred'),
        eq(event.caused_by_event_id, appealEventId),
      ),
    );
  return rows.map((r) => r.payload as Record<string, unknown>);
}

// YUK-561 S4 — seed an overturnable attempt with (optionally) a live θ̂ bracket, so the
// rejudge overturn's θ̂ revert path can be exercised end-to-end. Mirrors seedAppealedJudge
// but adds: a live mastery_state row (the θ̂ 'after'), the dual-sibling θ̂ checkpoint bracket
// (via the REAL writer helper — golden shape), and configurable answer action / auto_rate /
// prior outcome / conflict setup.
async function seedOverturnable(opts: {
  answerAction: 'attempt' | 'review';
  // YUK-561 FIX-1 — includes the θ̂-skipped priors (unsupported/unknown): the judge event
  // records this coarse_outcome verbatim, so seeding them exercises the thetaSkippedPrior route.
  priorOutcome: 'correct' | 'partial' | 'incorrect' | 'unsupported' | 'unknown';
  autoRated?: boolean; // solo review payload.judge.auto_rated
  kcId: string;
  thetaBefore: number;
  snapshotAfter?: number; // the θ̂ 'after' the bracket records (default thetaBefore+1)
  liveTheta?: number; // current mastery_state.theta_hat (default = snapshotAfter → guard passes)
  withCheckpoint?: boolean; // default true; false = an OLD attempt with no bracket
  seedMastery?: boolean; // default true; false = the loser KC row is absent (merge-rename seam)
}): Promise<{
  questionId: string;
  attemptEventId: string;
  judgeEventId: string;
  appealEventId: string;
}> {
  const db = testDb();
  const now = new Date();
  const questionId = createId();
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: 'p',
    reference_md: 'r',
    knowledge_ids: [opts.kcId],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });

  const snapshotAfter = opts.snapshotAfter ?? opts.thetaBefore + 1;
  const liveTheta = opts.liveTheta ?? snapshotAfter;

  if (opts.seedMastery !== false) {
    await db.insert(mastery_state).values({
      id: createId(),
      subject_kind: 'knowledge',
      subject_id: opts.kcId,
      theta_hat: liveTheta,
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      last_outcome_at: now,
      updated_at: now,
    });
  }

  const attemptEventId = createId();
  const answerPayload: Record<string, unknown> = { answer_md: 'ans', answer_image_refs: [] };
  if (opts.answerAction === 'review' && opts.autoRated !== undefined) {
    answerPayload.judge = { auto_rated: opts.autoRated };
  }
  await db.insert(event).values({
    id: attemptEventId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: opts.answerAction,
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: answerPayload,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });

  // θ̂ bracket via the REAL writer (golden shape) — unless simulating an old attempt.
  if (opts.withCheckpoint !== false) {
    await db.transaction(async (tx) => {
      await writeAttemptSnapshotBrackets(tx, {
        attemptEventId,
        sessionId: null,
        now,
        thetaSnapshots: [
          { kc_id: opts.kcId, before: richBefore(opts.thetaBefore), after: snapshotAfter },
        ],
        fsrsSnapshots: [],
      });
    });
  }

  const judgeEventId = createId();
  await db.insert(event).values({
    id: judgeEventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'paper_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptEventId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '<seed>',
        confidence: 0.7,
      },
      coarse_outcome: opts.priorOutcome,
      score: 0.4,
      judge_route: 'semantic',
      capability_ref: { id: 'semantic', version: '1.0.0' },
      profile_version: '1.0.0',
    },
    caused_by_event_id: attemptEventId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });

  const res = await appealPost(
    new Request('http://t/api/review/appeal', {
      method: 'POST',
      body: JSON.stringify({ judge_event_id: judgeEventId, reason_md: 'S4 test appeal' }),
    }),
  );
  expect(res.status).toBe(200);
  const { appeal_event_id } = (await res.json()) as { appeal_event_id: string };
  return { questionId, attemptEventId, judgeEventId, appealEventId: appeal_event_id };
}

async function seedAppealedJudge(): Promise<{
  questionId: string;
  attemptEventId: string;
  judgeEventId: string;
  appealEventId: string;
}> {
  const db = testDb();
  const now = new Date();
  const questionId = createId();
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: '翻译：吾妻之美我者，私我也。',
    reference_md: '我的妻子认为我美，是因为偏爱我。',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });

  const attemptEventId = createId();
  await db.insert(event).values({
    id: attemptEventId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: { answer_md: '我妻子觉得我美，是偏爱我。', answer_image_refs: [] },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });

  const judgeEventId = createId();
  await db.insert(event).values({
    id: judgeEventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'paper_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptEventId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '<seed>',
        confidence: 0.7,
      },
      coarse_outcome: 'partial',
      score: 0.5,
      judge_route: 'semantic',
      capability_ref: { id: 'semantic', version: '1.0.0' },
      profile_version: '1.0.0',
    },
    caused_by_event_id: attemptEventId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });

  const res = await appealPost(
    new Request('http://t/api/review/appeal', {
      method: 'POST',
      body: JSON.stringify({
        judge_event_id: judgeEventId,
        reason_md: '「觉得我美」已经含了意动义，判严了。',
      }),
    }),
  );
  expect(res.status).toBe(200);
  const { appeal_event_id } = (await res.json()) as { appeal_event_id: string };
  return { questionId, attemptEventId, judgeEventId, appealEventId: appeal_event_id };
}

describe('rejudge job (D15 申诉自动重判)', () => {
  beforeEach(async () => {
    enqueueHubAutoSync.mockClear();
    await resetDb();
  });

  it('改判：新 judge event + CorrectEvent(supersede) 直接生效（effective-truth 断言）', async () => {
    const db = testDb();
    const { judgeEventId, attemptEventId, appealEventId } = await seedAppealedJudge();

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', '你说得对——意动义已含其中，改判：对。') },
    );
    expect(outcome.status).toBe('overturned');
    if (outcome.status !== 'overturned') return;
    expect(outcome.prior_outcome).toBe('partial');
    expect(outcome.new_outcome).toBe('correct');

    // 新 judge event 挂在原作答事件上（newest-wins 锚点），caused_by 申诉。
    const [newJudge] = await db
      .select()
      .from(event)
      .where(eq(event.id, outcome.new_judge_event_id));
    expect(newJudge.action).toBe('judge');
    expect(newJudge.subject_id).toBe(attemptEventId);
    expect(newJudge.caused_by_event_id).toBe(appealEventId);
    expect((newJudge.payload as { coarse_outcome: string }).coarse_outcome).toBe('correct');

    // D15 直接生效：原 judge event 被 supersede（无 proposal 介入）。
    const truth = await getEffectiveTruth(db, judgeEventId);
    expect(truth.terminal_state).toBe('active');
    expect(truth.effective_event_id).toBe(outcome.new_judge_event_id);
    expect(truth.chain[0].state).toBe('superseded');
  });

  it('维持原判：appeal_upheld 留痕（带复核理由），原判定不动', async () => {
    const db = testDb();
    const { judgeEventId, appealEventId } = await seedAppealedJudge();

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('partial', '意动义在译文里确实没有落地，维持部分对。') },
    );
    expect(outcome.status).toBe('upheld');

    const [upheld] = await db
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:appeal_upheld'), eq(event.subject_id, judgeEventId)),
      );
    expect(upheld).toBeTruthy();
    expect((upheld.payload as { rejudge_outcome: string }).rejudge_outcome).toBe('partial');

    const truth = await getEffectiveTruth(db, judgeEventId);
    expect(truth.terminal_state).toBe('active');
    expect(truth.effective_event_id).toBe(judgeEventId);
  });

  it('幂等：同一申诉第二次执行跳过（already_resolved）', async () => {
    const db = testDb();
    const { appealEventId } = await seedAppealedJudge();

    const first = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', '改判。') },
    );
    expect(first.status).toBe('overturned');

    const second = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('incorrect', '不该被调用') },
    );
    expect(second).toEqual({ status: 'skipped', reason: 'already_resolved' });
  });

  it('serializes concurrent delivery so only one overturn commits without a spurious conflict marker', async () => {
    const db = testDb();
    const kcId = createId();
    const { judgeEventId, appealEventId } = await seedOverturnable({
      answerAction: 'attempt',
      priorOutcome: 'incorrect',
      kcId,
      thetaBefore: 0.3,
      snapshotAfter: 1.2,
      liveTheta: 1.2,
    });

    // Hold both workers after their out-of-tx preflight so they enter the write
    // race together. This deterministically exercises the TOCTOU window.
    let judgeCalls = 0;
    let releaseBoth!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const answer = mockJudge('correct', 'concurrent overturn');
    const concurrentJudge: NonNullable<RejudgeDeps['judgeFn']> = async () => {
      judgeCalls += 1;
      if (judgeCalls === 2) releaseBoth();
      await bothEntered;
      return answer();
    };

    const outcomes = await Promise.all([
      handleRejudge(db, { appeal_event_id: appealEventId }, { judgeFn: concurrentJudge }),
      handleRejudge(db, { appeal_event_id: appealEventId }, { judgeFn: concurrentJudge }),
    ]);

    expect(judgeCalls).toBe(2);
    expect(outcomes.map((result) => result.status).sort()).toEqual(['overturned', 'skipped']);
    expect(outcomes.find((result) => result.status === 'skipped')).toEqual({
      status: 'skipped',
      reason: 'already_resolved',
    });

    const committedJudges = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, appealEventId)));
    expect(committedJudges).toHaveLength(1);
    const corrections = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'correct'), eq(event.subject_id, judgeEventId)));
    expect(corrections).toHaveLength(1);
    const markers = await readReprojectMarkers(appealEventId);
    expect(markers).toHaveLength(1);
    expect(markers[0].reason).toBe('reverted');
    expect(await readTheta(kcId)).toBe(0.3);
  });

  // ── YUK-561 S4 — θ̂ revert-on-overturn (the live caller) ──────────────────────

  it('paper overturn (incorrect→correct): θ̂ reverted + reproject_deferred(reapply) + retract', async () => {
    const db = testDb();
    const kcId = createId();
    const { attemptEventId, appealEventId } = await seedOverturnable({
      answerAction: 'attempt', // paper attempt → judge-driven
      priorOutcome: 'incorrect',
      kcId,
      thetaBefore: 0.3,
      snapshotAfter: 1.2,
      liveTheta: 1.2, // guard passes
    });

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', 'ok') },
    );
    expect(outcome.status).toBe('overturned');

    // θ̂ reverted to `before` (0.3), FSRS untouched (no fsrs bracket seeded).
    expect(await readTheta(kcId)).toBe(0.3);

    // happy-path residual marker: reapply / reverted, carrying the answer event id.
    const markers = await readReprojectMarkers(appealEventId);
    expect(markers).toHaveLength(1);
    expect(markers[0].residual).toBe('reapply_correct_outcome');
    expect(markers[0].reason).toBe('reverted');
    expect(markers[0].answer_event_id).toBe(attemptEventId);
    expect(markers[0].prior_outcome).toBe('incorrect');
    expect(markers[0].new_outcome).toBe('correct');

    // retract on the θ̂ snapshot node (segment identity is self-evident from subject_id).
    const retracts = await db
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'correct'), eq(event.subject_id, `${attemptEventId}:snapshot:theta`)),
      );
    expect(retracts).toHaveLength(1);
    expect((retracts[0].payload as { reason_md: string }).reason_md).toContain('appeal:');
  });

  it('solo auto_rate=false overturn (incorrect→correct): NOT judge-driven → no revert, no marker', async () => {
    const db = testDb();
    const kcId = createId();
    const { appealEventId } = await seedOverturnable({
      answerAction: 'review', // solo review
      autoRated: false, // θ̂ came from the user's manual rating, NOT the judge
      priorOutcome: 'incorrect',
      kcId,
      thetaBefore: 0.3,
      liveTheta: 1.2,
    });

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', 'ok') },
    );
    expect(outcome.status).toBe('overturned');
    // θ̂ untouched (reverting a manually-rated θ̂ would be pure pollution).
    expect(await readTheta(kcId)).toBe(1.2);
    // O3 — no θ̂ residual → no marker.
    expect(await readReprojectMarkers(appealEventId)).toHaveLength(0);
  });

  it('solo auto_rate=true overturn (incorrect→correct): judge-driven review limb → θ̂ reverted + marker', async () => {
    // FIX-2 — the review-true branch of judgeDriven (answerEvent.action==='review' &&
    // payload.judge.auto_rated===true). Previously only the auto_rate=false (no-revert)
    // branch was covered; this reddens the true limb: an auto-rated solo review IS
    // judge-driven, so an incorrect→correct overturn (bit flip 0→1) reverts θ̂.
    const db = testDb();
    const kcId = createId();
    const { attemptEventId, appealEventId } = await seedOverturnable({
      answerAction: 'review',
      autoRated: true, // θ̂ came from the JUDGE's suggested rating → judge-driven
      priorOutcome: 'incorrect',
      kcId,
      thetaBefore: 0.3,
      snapshotAfter: 1.2,
      liveTheta: 1.2, // guard passes
    });

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', 'ok') },
    );
    expect(outcome.status).toBe('overturned');

    // θ̂ reverted to `before` (0.3) — the review-true limb ran the revert.
    expect(await readTheta(kcId)).toBe(0.3);

    // One happy-path residual marker (reapply / reverted).
    const markers = await readReprojectMarkers(appealEventId);
    expect(markers).toHaveLength(1);
    expect(markers[0].residual).toBe('reapply_correct_outcome');
    expect(markers[0].reason).toBe('reverted');
    expect(markers[0].answer_event_id).toBe(attemptEventId);
  });

  it('overturn partial→correct (θ̂ bit NOT flipped): no revert, no marker (legal signal kept)', async () => {
    const db = testDb();
    const kcId = createId();
    const { appealEventId } = await seedOverturnable({
      answerAction: 'attempt',
      priorOutcome: 'partial', // bit(partial)=1
      kcId,
      thetaBefore: 0.3,
      liveTheta: 1.2,
    });

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', 'ok') }, // bit(correct)=1 → NOT flipped
    );
    expect(outcome.status).toBe('overturned');
    expect(await readTheta(kcId)).toBe(1.2); // untouched — the θ̂ move was already correct-bit
    expect(await readReprojectMarkers(appealEventId)).toHaveLength(0);
  });

  it('overturn with a later θ̂ movement → conflict → deferred(later_theta_movement), θ̂ not clobbered', async () => {
    const db = testDb();
    const kcId = createId();
    const { appealEventId } = await seedOverturnable({
      answerAction: 'attempt',
      priorOutcome: 'incorrect',
      kcId,
      thetaBefore: 0.3,
      snapshotAfter: 1.2,
      liveTheta: 2.5, // a LATER attempt moved θ̂ off the snapshot.after → conflict
    });

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', 'ok') },
    );
    expect(outcome.status).toBe('overturned');
    // θ̂ NOT clobbered by the refused revert.
    expect(await readTheta(kcId)).toBe(2.5);
    const markers = await readReprojectMarkers(appealEventId);
    expect(markers).toHaveLength(1);
    expect(markers[0].residual).toBe('full_reprojection');
    expect(markers[0].reason).toBe('later_theta_movement');
    expect((markers[0].kc_conflict as { subjectId: string }).subjectId).toBe(kcId);
  });

  it('overturn of an OLD attempt (no checkpoint) → deferred(no_checkpoint), no error flood', async () => {
    const db = testDb();
    const kcId = createId();
    const { appealEventId } = await seedOverturnable({
      answerAction: 'attempt',
      priorOutcome: 'incorrect',
      kcId,
      thetaBefore: 0.3,
      liveTheta: 1.2,
      withCheckpoint: false, // pre-S2 attempt — no bracket
    });

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', 'ok') },
    );
    expect(outcome.status).toBe('overturned'); // NOT a fail-loud error
    const markers = await readReprojectMarkers(appealEventId);
    expect(markers).toHaveLength(1);
    expect(markers[0].residual).toBe('full_reprojection');
    expect(markers[0].reason).toBe('no_checkpoint');
  });

  // FIX-1 (P0) — a θ̂-skipped prior (unsupported/unknown) overturned to a θ̂-meaningful
  // outcome MUST still write a residual marker (spec §Q2b(3)). Pre-FIX-1 the double gate
  // used outcomeBit only: outcomeBit('unsupported')=0 === outcomeBit('incorrect')=0 →
  // shouldRevertTheta=false → line-210 zero-marker return, silently dropping the residual.
  // A θ̂-skipped prior has no theta bracket, so the revert path returns no_checkpoint →
  // full_reprojection marker (symmetric with unsupported→correct/partial).
  for (const skippedPrior of ['unsupported', 'unknown'] as const) {
    it(`overturn ${skippedPrior}→incorrect (θ̂-skipped prior) → deferred(no_checkpoint) marker`, async () => {
      const db = testDb();
      const kcId = createId();
      const { appealEventId } = await seedOverturnable({
        answerAction: 'attempt', // judge-driven (paper attempt)
        priorOutcome: skippedPrior, // θ̂ was skipped → no theta bracket exists
        kcId,
        thetaBefore: 0.3,
        liveTheta: 1.2,
        withCheckpoint: false, // a θ̂-skipped prior never wrote a `${E}:checkpoint:theta`
      });

      const outcome = await handleRejudge(
        db,
        { appeal_event_id: appealEventId },
        { judgeFn: mockJudge('incorrect', 'still wrong — but a θ̂-meaningful verdict now') },
      );
      expect(outcome.status).toBe('overturned');

      // The dropped residual is now visible: exactly one full_reprojection/no_checkpoint marker.
      const markers = await readReprojectMarkers(appealEventId);
      expect(markers).toHaveLength(1);
      expect(markers[0].residual).toBe('full_reprojection');
      expect(markers[0].reason).toBe('no_checkpoint');
      expect(markers[0].prior_outcome).toBe(skippedPrior);
      expect(markers[0].new_outcome).toBe('incorrect');
    });
  }

  it('enqueues hub sync after an outer transaction commits a structural cascade revert', async () => {
    const db = testDb();
    const kcId = createId();
    const { appealEventId } = await seedOverturnable({
      answerAction: 'attempt',
      priorOutcome: 'incorrect',
      kcId,
      thetaBefore: 0.3,
      snapshotAfter: 1.2,
      liveTheta: 1.2,
    });
    const structuralRevert = (async () => ({
      ok: true as const,
      checkpointEventId: 'checkpoint',
      reverted: {
        snapshotsRestored: 0,
        structuralRowsArchived: 1,
        eventLayerCompensated: 0,
        totalNodes: 1,
      },
      compensationEventIds: [],
    })) as RejudgeDeps['orchestrateRevert'];

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', 'ok'), orchestrateRevert: structuralRevert },
    );

    expect(outcome.status).toBe('overturned');
    expect(enqueueHubAutoSync).toHaveBeenCalledTimes(1);
  });

  it('atomicity: a transient revert failure rolls back the WHOLE overturn; retry replays cleanly', async () => {
    const db = testDb();
    const kcId = createId();
    const { appealEventId } = await seedOverturnable({
      answerAction: 'attempt',
      priorOutcome: 'incorrect',
      kcId,
      thetaBefore: 0.3,
      snapshotAfter: 1.2,
      liveTheta: 1.2,
    });

    // Inject a throwing revert (a 40001/timeout/disconnect analog) → the atomic tx must
    // roll back newJudge + correction too (the pre-S4 bug: they'd commit, the guard would
    // then skip on retry, and θ̂ self-heal would be permanently lost + reported success).
    const throwingRevert = (async () => {
      throw new Error('transient DB error');
    }) as RejudgeDeps['orchestrateRevert'];
    await expect(
      handleRejudge(
        db,
        { appeal_event_id: appealEventId },
        { judgeFn: mockJudge('correct', 'ok'), orchestrateRevert: throwingRevert },
      ),
    ).rejects.toThrow();

    // newJudge NOT committed (rolled back) — the idempotency guard finds nothing.
    const newJudges = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, appealEventId)));
    expect(newJudges).toHaveLength(0);
    expect(await readTheta(kcId)).toBe(1.2); // θ̂ unchanged (nothing applied)

    // Retry WITHOUT the injection → full clean replay → success + revert + marker.
    const retry = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', 'ok') },
    );
    expect(retry.status).toBe('overturned');
    expect(await readTheta(kcId)).toBe(0.3); // now reverted
    expect(await readReprojectMarkers(appealEventId)).toHaveLength(1);
  });

  it('overturn after a YUK-543 KC-merge rename → conflict → deferred with merged_into (winner)', async () => {
    const db = testDb();
    const now = new Date();
    const loserKc = createId();
    const winnerKc = createId();
    // The winner absorbed the loser (merged_from ⊇ [loserKc]); the loser's mastery_state
    // row was RENAMED away → the snapshot's loser KC has no live row → conflict.
    await db.insert(knowledge).values({
      id: winnerKc,
      name: 'winner',
      merged_from: [loserKc],
      created_at: now,
      updated_at: now,
    });

    const { appealEventId } = await seedOverturnable({
      answerAction: 'attempt',
      priorOutcome: 'incorrect',
      kcId: loserKc,
      thetaBefore: 0.3,
      snapshotAfter: 1.2,
      seedMastery: false, // loser row absent (renamed into the winner)
    });

    const outcome = await handleRejudge(
      db,
      { appeal_event_id: appealEventId },
      { judgeFn: mockJudge('correct', 'ok') },
    );
    expect(outcome.status).toBe('overturned');
    const markers = await readReprojectMarkers(appealEventId);
    expect(markers).toHaveLength(1);
    expect(markers[0].reason).toBe('later_theta_movement'); // conflict (missing row)
    expect(markers[0].merged_into).toBe(winnerKc); // best-effort locating hint
  });
});
