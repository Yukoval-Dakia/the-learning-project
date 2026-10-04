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

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { StateSnapshotExperimental } from '@/core/schema/event/state-snapshot';
import { artifact, event, mastery_state, question } from '@/db/schema';
import { getFsrsState } from '@/server/fsrs/state';
import { getMasteryState } from '@/server/mastery/state';
import {
  startFrozenPaperFixture,
  submitPaperFixture as submitPaperSlot,
} from '../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../tests/helpers/db';

async function seedQuestion(id: string, reference: string, knowledgeIds: string[]) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'true_false',
    judge_kind_override: 'exact',
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

// YUK-561 S2 — parse the state_snapshot payload for ONE segment (θ̂ / FSRS sibling).
async function snapshotSegment(attemptEventId: string, segment: 'theta' | 'fsrs') {
  const db = testDb();
  const rows = await db
    .select()
    .from(event)
    .where(eq(event.id, `${attemptEventId}:snapshot:${segment}`));
  const snap = rows[0];
  if (!snap) throw new Error(`no ${segment} snapshot for ${attemptEventId}`);
  return {
    row: snap,
    payload: StateSnapshotExperimental.parse({
      actor_kind: snap.actor_kind,
      actor_ref: snap.actor_ref,
      action: snap.action,
      subject_kind: snap.subject_kind,
      subject_id: snap.subject_id,
      outcome: snap.outcome,
      payload: snap.payload,
      caused_by_event_id: snap.caused_by_event_id ?? undefined,
    }).payload,
  };
}

async function readCheckpoint(attemptEventId: string, segment: 'theta' | 'fsrs') {
  const db = testDb();
  const rows = await db
    .select()
    .from(event)
    .where(eq(event.id, `${attemptEventId}:checkpoint:${segment}`));
  return rows[0] ?? null;
}

describe('YUK-471 W0 — paper submit appends experimental:state_snapshot (test 11)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('appends dual-sibling brackets per paper slot; θ̂ snapshot before/after bracket the live transition', async () => {
    const db = testDb();
    await seedQuestion('pq1', 'true', ['kc_paper']);
    await seedPaper('paper_snap', ['pq1'], 'kc_paper');

    const { sessionId } = await startFrozenPaperFixture(db, 'paper_snap');

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
    const settlements = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    const settlement = settlements.find((row) => row.payload.evaluation_id === result.evaluationId);
    expect(settlement).toBeDefined();
    const attemptEventId = settlement!.id;

    // YUK-561 S2 — a graded paper slot moves BOTH axes → two sibling snapshots.
    const snaps = await db
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:state_snapshot'), eq(event.subject_id, attemptEventId)),
      );
    expect(snaps).toHaveLength(2);
    for (const snap of snaps) {
      expect(snap.subject_kind).toBe('event');
      expect(snap.actor_kind).toBe('system');
      expect(snap.ingest_at).not.toBeNull(); // HARD REQ 2 — skips the outbox.
    }

    // θ̂ segment: snapshot hung off its own checkpoint (caused_by chain).
    const thetaCheckpoint = await readCheckpoint(attemptEventId, 'theta');
    expect(thetaCheckpoint).not.toBeNull();
    const { row: thetaRow, payload } = await snapshotSegment(attemptEventId, 'theta');
    expect(thetaRow.caused_by_event_id).toBe(`${attemptEventId}:checkpoint:theta`);
    expect(payload.attempt_event_id).toBe(attemptEventId);
    expect(payload.fsrs_snapshots).toHaveLength(0); // segment isolation

    // ORACLE: the live mastery_state posterior (independent of the snapshot payload).
    const live = await getMasteryState(db, 'kc_paper');
    expect(live).not.toBeNull();
    const livePosterior = (live as { theta_hat: number }).theta_hat;
    expect(livePosterior).toBeGreaterThan(0); // correct → rose off cold-start 0

    const theta = payload.theta_snapshots.find((t) => t.kc_id === 'kc_paper');
    expect(theta).toBeDefined();
    // cold-start → before null (preserves null≠0); after == live posterior oracle.
    expect(theta?.before).toBeNull();
    expect(theta?.after).toBeCloseTo(livePosterior, 6);
  });

  // The native contract never invents an "again" rating from an unsupported
  // automatic evaluation. Only an explicit user choice may write FSRS.
  it('unsupported automatic paper response preserves the original without an inferred FSRS overwrite', async () => {
    const db = testDb();
    await seedQuestionWithOverride('pq_unsup', 'anything', ['kc_unsup'], 'rubric');
    await seedPaper('paper_unsup', ['pq_unsup'], 'kc_unsup');
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_unsup');
    expect(await getFsrsState(db, 'knowledge', 'kc_unsup')).toBeNull();
    expect(await getMasteryState(db, 'kc_unsup')).toBeNull();
    const result = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_unsup',
        questionId: 'pq_unsup',
        answerMd: 'a normal text answer',
      },
      db,
    );
    expect(result).toMatchObject({ coarseOutcome: 'unsupported', status: 'review_required' });
    expect(await getFsrsState(db, 'knowledge', 'kc_unsup')).toBeNull();
    expect(await getMasteryState(db, 'kc_unsup')).toBeNull();
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:state_snapshot')),
    ).toEqual([]);
    expect(await db.select().from(event).where(eq(event.id, result.attemptEventId))).toMatchObject([
      {
        action: 'experimental:assessment_attempt',
        outcome: null,
        payload: { response_md: 'a normal text answer' },
      },
    ]);
  });
});
