// YUK-459 — paper/exam submit path must, on a graded SUCCESS, fire the same
// mastery-change signals the solo review path does (ADR-0040 决定2): emit the
// `experimental:mastery_progress` p(L)/Δθ̂ 埋点 + enqueue the mastery_change
// note-refine trigger. Previously paper-submit did NEITHER (solo-only), leaving
// paper attempts a dead line for note refinement. Mirrors submit.db.test.ts:208.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMasteryProgressNoteRefineDelivery } from '@/capabilities/notes/server/mastery-progress-subscription';
import { MASTERY_PROGRESS_ACTION } from '@/capabilities/practice/server/mastery-progress-signal';
import {
  artifact,
  event,
  event_subscription_checkpoint,
  event_subscription_delivery,
  knowledge,
  mastery_state,
  question,
} from '@/db/schema';
import {
  paperFixtureAssessment,
  startFrozenPaperFixture,
  submitPaperFixture as submitPaperSlot,
} from '../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { prepareFormalAttemptSubmission } from './assessment/attempt';

async function seedKnowledge(id: string, domain = 'yuwen'): Promise<void> {
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
      judge_kind_override: 'exact',
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
    await seedKnowledge('k_pmp', 'yuwen');
    await seedTrueFalseQuestion('q_pmp', ['k_pmp']);
    await seedPaper('paper_pmp', ['q_pmp'], 'k_pmp');
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_pmp');

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
    // Replaying the accepted answer is not another mastery observation.
    await submitPaperSlot(
      { sessionId, paperArtifactId: 'paper_pmp', questionId: 'q_pmp', answerMd: 'true' },
      db,
    );
    expect(
      await db.select().from(event).where(eq(event.action, MASTERY_PROGRESS_ACTION)),
    ).toHaveLength(1);
    await db
      .insert(artifact)
      .values({
        id: 'note_native_mastery',
        type: 'note_atomic',
        title: '判断命题笔记',
        knowledge_ids: ['k_pmp'],
        generation_status: 'ready',
        intent_source: 'test',
        source: 'test',
        verification_status: 'not_required',
        created_at: new Date(),
        updated_at: new Date(),
      });
    await db
      .insert(event_subscription_checkpoint)
      .values({
        subscriber_id: 'notes.mastery-progress-note-refine',
        subscriber_version: 1,
        declaration_hash: 'test-native',
        status: 'active',
        next_delivery_seq: 2,
        bootstrapped_at: new Date(),
        activated_at: new Date(),
      });
    await db
      .insert(event_subscription_delivery)
      .values({
        subscriber_id: 'notes.mastery-progress-note-refine',
        subscriber_version: 1,
        source_event_id: mpEvents[0].id,
        source_dispatch_seq: mpEvents[0].dispatch_seq,
        delivery_seq: 1,
        status: 'pending',
      });
    const bossSend = vi.fn(async () => 'native-note-refine-job');
    const delivery = {
      subscriberId: 'notes.mastery-progress-note-refine',
      subscriberVersion: 1,
      deliverySeq: '1',
      sourceEventId: mpEvents[0].id,
    };
    expect(await handleMasteryProgressNoteRefineDelivery(db, delivery, { bossSend })).toMatchObject(
      {
        status: 'succeeded',
        detail: { enqueued: 1, attempt_event_id: submit.attemptEventId },
      },
    );
    expect(await handleMasteryProgressNoteRefineDelivery(db, delivery, { bossSend })).toMatchObject(
      {
        status: 'succeeded',
        detail: { alreadyProcessed: 1 },
      },
    );
    expect(bossSend).toHaveBeenCalledTimes(1);
  });

  it('observes a late result at its original learning position and does not emit for replayed neighbors', async () => {
    const db = testDb();
    await seedKnowledge('k_ordered', 'yuwen');
    await seedTrueFalseQuestion('q_early', ['k_ordered']);
    await seedTrueFalseQuestion('q_later', ['k_ordered']);
    await seedPaper('paper_early', ['q_early'], 'k_ordered');
    await seedPaper('paper_later', ['q_later'], 'k_ordered');
    const early = await startFrozenPaperFixture(db, 'paper_early');
    const earlyAssessment = await paperFixtureAssessment(db, early.sessionId, 'q_early', 'true');
    await prepareFormalAttemptSubmission(db, 'paper_submit', 'q_early', earlyAssessment);
    const later = await startFrozenPaperFixture(db, 'paper_later');
    await submitPaperSlot(
      {
        sessionId: later.sessionId,
        paperArtifactId: 'paper_later',
        questionId: 'q_later',
        answerMd: 'true',
      },
      db,
    );
    const completed = await submitPaperSlot(
      {
        sessionId: early.sessionId,
        paperArtifactId: 'paper_early',
        questionId: 'q_early',
        answerMd: 'true',
        assessment: earlyAssessment,
      },
      db,
    );
    const signals = await db.select().from(event).where(eq(event.action, MASTERY_PROGRESS_ACTION));
    expect(signals).toHaveLength(2);
    const ownSignal = signals.find(
      (row) => row.payload.attempt_event_id === completed.attemptEventId,
    );
    expect(ownSignal).toBeDefined();
    const settlements = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    const ownSettlement = settlements.find(
      (row) => row.payload.evaluation_id === completed.evaluationId,
    );
    expect(ownSettlement).toBeDefined();
    const [snapshot] = await db
      .select()
      .from(event)
      .where(eq(event.id, `${ownSettlement!.id}:snapshot:theta`));
    const transitions = snapshot.payload.theta_snapshots as Array<{
      kc_id: string;
      before: number | null;
      after: number;
    }>;
    const transition = transitions.find((row) => row.kc_id === 'k_ordered');
    expect(transition).toBeDefined();
    expect(ownSignal!.payload.theta_delta).toBeCloseTo(
      transition!.after - (transition!.before ?? 0),
      6,
    );
    const [state] = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k_ordered'));
    expect(state.evidence_count).toBe(2);
    expect(state.last_theta_delta).not.toBeCloseTo(ownSignal!.payload.theta_delta as number, 6);
  });

  it('does NOT emit mastery_progress on a failed paper answer (gate = success, mirror solo)', async () => {
    const db = testDb();
    await seedKnowledge('k_pmp_fail', 'yuwen');
    await seedTrueFalseQuestion('q_pmp_fail', ['k_pmp_fail']);
    await seedPaper('paper_pmp_fail', ['q_pmp_fail'], 'k_pmp_fail');
    const { sessionId } = await startFrozenPaperFixture(db, 'paper_pmp_fail');

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
    expect(submit.coarseOutcome).toBe('incorrect');

    const mpEvents = await db.select().from(event).where(eq(event.action, MASTERY_PROGRESS_ACTION));
    expect(mpEvents).toHaveLength(0);
  });
});
