// YUK-471 Wave 0 (ADR-0044 §3) — paper attempt-tx state_snapshot append (test 11).
//
// Mirrors submit-snapshot.db.test.ts on the PAPER path (submitPaperSlot). Uses the
// deterministic `exact`/`true_false` judge (no LLM / runTask mock). Asserts:
//   - exactly one experimental:state_snapshot per paper slot attempt, anchored to
//     the attempt event;
//   - θ̂ snapshot before/after bracket the LIVE mastery_state transition (cold-start
//     → before null);
//   - ingest_at non-null at INSERT (HARD REQ 2 — skips the memory outbox).
//
// ANTI-TAUTOLOGY (w0-PLAN §6.8): `after` is read from the live mastery_state row
//   (independent oracle), never trusted from the snapshot payload.

import { StateSnapshotExperimental } from '@/core/schema/event/state-snapshot';
import { artifact, event, mastery_state, question } from '@/db/schema';
import { getFsrsState } from '@/server/fsrs/state';
import { getMasteryState } from '@/server/mastery/state';
import { Review } from '@/server/session';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { submitPaperSlot } from './paper-submit';

async function seedQuestion(id: string, reference: string, knowledgeIds: string[]) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'true_false',
    prompt_md: `Prompt ${id}`,
    reference_md: reference,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    created_at: now,
    updated_at: now,
  });
}

async function seedQuestionWithOverride(
  id: string,
  reference: string,
  knowledgeIds: string[],
  judgeKindOverride: string,
) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: reference,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    judge_kind_override: judgeKindOverride,
    created_at: now,
    updated_at: now,
  });
}

async function seedPaper(id: string, questionIds: string[], primaryKc: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: 'snapshot paper',
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

describe('YUK-471 W0 — paper submit appends experimental:state_snapshot (test 11)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('appends exactly one state_snapshot per paper slot, θ̂ before/after bracket the live transition', async () => {
    const db = testDb();
    await seedQuestion('pq1', 'true', ['kc_paper']);
    await seedPaper('paper_snap', ['pq1'], 'kc_paper');

    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_snap' });

    // cold-start precondition: no prior mastery_state row.
    expect(await getMasteryState(db, 'kc_paper')).toBeNull();

    const result = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_snap',
        questionId: 'pq1',
        answerMd: 'true', // exact-match the reference → correct → θ̂ rises
        primaryKnowledgeId: 'kc_paper',
        secondaryKnowledgeIds: [],
      },
      db,
    );
    const attemptEventId = result.attemptEventId;

    // exactly one snapshot, anchored to the attempt event.
    const snaps = await db
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:state_snapshot'), eq(event.subject_id, attemptEventId)),
      );
    expect(snaps).toHaveLength(1);
    const snap = snaps[0];
    expect(snap.subject_kind).toBe('event');
    expect(snap.caused_by_event_id).toBe(attemptEventId);
    expect(snap.actor_kind).toBe('system');
    // HARD REQ 2 — skips the outbox.
    expect(snap.ingest_at).not.toBeNull();

    // ORACLE: the live mastery_state posterior (independent of the snapshot payload).
    const live = await getMasteryState(db, 'kc_paper');
    expect(live).not.toBeNull();
    const livePosterior = (live as { theta_hat: number }).theta_hat;
    expect(livePosterior).toBeGreaterThan(0); // correct → rose off cold-start 0

    const payload = StateSnapshotExperimental.parse({
      actor_kind: snap.actor_kind,
      actor_ref: snap.actor_ref,
      action: snap.action,
      subject_kind: snap.subject_kind,
      subject_id: snap.subject_id,
      outcome: snap.outcome,
      payload: snap.payload,
      caused_by_event_id: snap.caused_by_event_id ?? undefined,
    }).payload;
    expect(payload.attempt_event_id).toBe(attemptEventId);
    const theta = payload.theta_snapshots.find((t) => t.kc_id === 'kc_paper');
    expect(theta).toBeDefined();
    // cold-start → before null (preserves null≠0); after == live posterior oracle.
    // 8 digits: jsonb double round-trip delta (~1e-8) vs the live row; still brackets
    // the EXACT transition (before/after from independent oracles, not tautological).
    expect(theta?.before).toBeNull();
    expect(theta?.after).toBeCloseTo(livePosterior, 6);
  });

  // YUK-471 W0 invariant — the MEDIUM gap the driver just fixed: on the PAPER
  // path a NON-photo `unsupported` answer (judge route unregistered / semantic
  // provider call failed) maps to FSRS rating 'again' → scheduleReview runs →
  // material_fsrs_state is overwritten at (c). The OLD code skipped the
  // state_snapshot for unsupported (the θ̂+snapshot block was gated
  // `coarseOutcome !== 'unsupported'`); the fix lifted the snapshot to a single
  // (e) append point gated on `(fsrsWrote || thetaSnapshots.length > 0)`, so this
  // path now writes a snapshot with theta_snapshots: [] (θ̂ correctly skipped per
  // SF-3) + fsrs_snapshots: [<the FSRS transition>]. This test locks that
  // invariant: every imperative material_fsrs_state overwrite on the paper path
  // is snapshot-bracketed, even when θ̂ is skipped.
  //
  // DETERMINISTIC TRIGGER (no LLM / no mock): seed a short_answer question with
  // `judge_kind_override: 'rubric'`. route-resolve.ts:121 honours the override →
  // resolvedRoute === 'rubric'. 'rubric' is NOT in RUNNABLE_ROUTES
  // (question-contract.ts:17), so JudgeInvoker.dispatch short-circuits to
  // unsupportedResult (invoker.ts:148) → coarse_outcome='unsupported' WITHOUT
  // any LLM call. The answer is plain text (non-photo) so photoOnlyUnsupported
  // stays false → the (c) FSRS gate fires (rating 'again') → fsrsWrote=true →
  // the (e) snapshot append fires, while (d) θ̂ is skipped (coarseOutcome ===
  // 'unsupported', SF-3).
  it('non-photo unsupported answer still snapshot-brackets the FSRS overwrite (θ̂ skipped per SF-3)', async () => {
    const db = testDb();
    // judge_kind_override='rubric' → route 'rubric' → not runnable → unsupported, no LLM.
    await seedQuestionWithOverride('pq_unsup', 'anything', ['kc_unsup'], 'rubric');
    await seedPaper('paper_unsup', ['pq_unsup'], 'kc_unsup');

    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_unsup' });

    // cold-start preconditions: no prior FSRS nor mastery state for the slot's KC.
    expect(await getFsrsState(db, 'knowledge', 'kc_unsup')).toBeNull();
    expect(await getMasteryState(db, 'kc_unsup')).toBeNull();

    const result = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_unsup',
        questionId: 'pq_unsup',
        answerMd: 'a normal text answer', // NON-photo → photoOnlyUnsupported stays false
        primaryKnowledgeId: 'kc_unsup',
        secondaryKnowledgeIds: [],
      },
      db,
    );
    const attemptEventId = result.attemptEventId;

    // (1) coarseOutcome is unsupported (observable via the returned result + the
    // persisted attempt maps it to failure). This is the path whose FSRS
    // overwrite must be bracketed.
    expect(result.coarseOutcome).toBe('unsupported');

    // (2) material_fsrs_state row for the slot's subject WAS overwritten — the
    // imperative write that must be bracketed. Oracle: the live row exists
    // (cold-start → written) and pins this attempt as its last review.
    const liveFsrs = await getFsrsState(db, 'knowledge', 'kc_unsup');
    expect(liveFsrs).not.toBeNull();
    if (!liveFsrs) throw new Error('liveFsrs should exist after the unsupported attempt');
    expect(liveFsrs.last_review_event_id).toBe(attemptEventId);

    // (3) exactly ONE experimental:state_snapshot anchored to the attempt event.
    const snaps = await db
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:state_snapshot'), eq(event.subject_id, attemptEventId)),
      );
    expect(snaps).toHaveLength(1);
    const snap = snaps[0];
    expect(snap.subject_kind).toBe('event');
    expect(snap.subject_id).toBe(attemptEventId);
    expect(snap.caused_by_event_id).toBe(attemptEventId);
    expect(snap.actor_kind).toBe('system');

    // (6) HARD REQ 2 — skips the memory outbox.
    expect(snap.ingest_at).not.toBeNull();

    const payload = StateSnapshotExperimental.parse({
      actor_kind: snap.actor_kind,
      actor_ref: snap.actor_ref,
      action: snap.action,
      subject_kind: snap.subject_kind,
      subject_id: snap.subject_id,
      outcome: snap.outcome,
      payload: snap.payload,
      caused_by_event_id: snap.caused_by_event_id ?? undefined,
    }).payload;
    expect(payload.attempt_event_id).toBe(attemptEventId);

    // (4) θ̂ skipped on unsupported (SF-3: don't penalize p(L) for an ungradeable
    // answer) — theta_snapshots is EMPTY, and the live mastery_state row was
    // never created.
    expect(payload.theta_snapshots).toEqual([]);
    expect(await getMasteryState(db, 'kc_unsup')).toBeNull();

    // (5) fsrs_snapshots brackets the EXACT FSRS transition. length 1; `before`
    // is null (cold-start); `after` matches the LIVE material_fsrs_state row
    // (independent oracle — NOT read from the payload; anti-tautology).
    expect(payload.fsrs_snapshots).toHaveLength(1);
    const fsrsSnap = payload.fsrs_snapshots[0];
    expect(fsrsSnap.subject_kind).toBe('knowledge');
    expect(fsrsSnap.subject_id).toBe('kc_unsup');
    expect(fsrsSnap.before).toBeNull(); // cold-start → revert would DELETE the row
    // `after` is jsonb-roundtripped; compare the load-bearing FSRS Card scalars
    // against the live row (independent oracle), not against the payload itself.
    expect(fsrsSnap.after.stability).toBe(liveFsrs?.state.stability);
    expect(fsrsSnap.after.difficulty).toBe(liveFsrs?.state.difficulty);
    expect(fsrsSnap.after.reps).toBe(liveFsrs?.state.reps);
    // `due` is jsonb-roundtripped; normalize both sides through Date and compare
    // the epoch ms (the live row's state.due may be a raw string/number from the
    // jsonb cast, not a Date instance — coerce both for an apples-to-apples compare).
    expect(new Date(fsrsSnap.after.due).getTime()).toBe(new Date(liveFsrs.state.due).getTime());
  });
});
