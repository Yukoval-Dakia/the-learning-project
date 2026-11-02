// Native boundary regressions replacing tests of the old solo/paper settlement writer.
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/core/ids';
import {
  artifact,
  assessment_submission,
  event,
  mastery_state,
  material_fsrs_state,
} from '@/db/schema';
import {
  paperFixtureAssessment,
  startFrozenPaperFixture,
  submitPaperFixture,
} from '../../../../tests/fixtures/assessment-paper';
import {
  handwritingFixture,
  nativeSoloHttpFixture,
} from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { commitFormalAttempt } from './assessment/attempt';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
async function paperFor(questionId: string, knowledgeIds: string[]) {
  const id = newId();
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'tool_quiz',
      title: 'native settlement boundary paper',
      knowledge_ids: knowledgeIds,
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: {
        question_ids: [questionId],
        sections: [
          {
            knowledge_focus: knowledgeIds,
            feedback_policy: 'immediate',
            adaptation_policy: 'none',
            assignments: [
              {
                question_id: questionId,
                primary_knowledge_id: knowledgeIds[0],
                secondary_knowledge_ids: knowledgeIds.slice(1),
                selection_reason: 'frozen boundary fixture',
                review_profile_snapshot: {},
              },
            ],
          },
        ],
      },
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
  const { sessionId } = await startFrozenPaperFixture(testDb(), id);
  return { paperArtifactId: id, sessionId, questionId, answerMd: 'A' };
}

describe('native settlement boundaries', () => {
  it('owns FSRS, theta, independent snapshots and progress in one effective settlement', async () => {
    const db = testDb();
    const f = await nativeSoloHttpFixture(db);
    const receipt = await commitFormalAttempt(db, 'solo_submit', f.id, f.assessment);
    if (receipt.status !== 'effective') throw new Error('automatic original did not settle');
    expect(receipt.activation.effect).toBe('applied');
    expect(await db.select().from(material_fsrs_state)).toHaveLength(1);
    expect(
      await db.select().from(mastery_state).where(eq(mastery_state.subject_kind, 'knowledge')),
    ).toHaveLength(1);
    const [settlement] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_settlement'));
    const snapshots = await db
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'experimental:state_snapshot'), eq(event.subject_id, settlement.id)),
      );
    expect(snapshots.map((row) => row.id).sort()).toEqual([
      `${settlement.id}:snapshot:fsrs`,
      `${settlement.id}:snapshot:theta`,
    ]);
    expect(
      await db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:mastery_progress'),
            eq(event.caused_by_event_id, receipt.attempt_id),
          ),
        ),
    ).toHaveLength(1);
  });

  it('holds photo-only deterministic paper work, retains one original and rejects changed retries', async () => {
    const db = testDb();
    const f = await nativeSoloHttpFixture(db);
    const paper = await paperFor(f.id, f.knowledgeIds);
    const photo = await handwritingFixture(db);
    const assessment = {
      ...(await paperFixtureAssessment(db, paper.sessionId, f.id, '')),
      group_evidence: [photo],
    };
    const first = await submitPaperFixture({ ...paper, answerMd: '', assessment }, db);
    expect(first).toMatchObject({ status: 'review_required', coarseOutcome: 'unsupported' });
    const replay = await submitPaperFixture({ ...paper, answerMd: '', assessment }, db);
    expect(replay).toMatchObject({
      attemptEventId: first.attemptEventId,
      answerId: first.answerId,
    });
    const changed = await paperFixtureAssessment(db, paper.sessionId, f.id, 'A');
    await expect(submitPaperFixture({ ...paper, assessment: changed }, db)).rejects.toMatchObject({
      status: 409,
    });
    expect(await db.select().from(assessment_submission)).toMatchObject([
      { group_evidence: [photo] },
    ]);
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_attempt')),
    ).toHaveLength(1);
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
    expect(await db.select().from(mastery_state)).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
