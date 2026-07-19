// YUK-729 — the paper/exam submit post-commit note-refine fan-out must inherit the
// YUK-694 MAX_NOTE_REFINE_FANOUT ceiling (the load-bearing paid-job cap) that the
// solo submit path already goes through via collectMasteryRefineTargets. The old
// inline loop iterated ALL question knowledge_ids with an unlimited
// notesForKnowledge query, so a many-KC/many-note question could enqueue an
// unbounded number of paid note_refine jobs from a single paper submit.
//
// enqueueMasteryNoteRefine is spied (in a test env the real trigger short-circuits
// to skipped:test_env and never calls boss.send, so counting DB jobs is not an
// option); collectMasteryRefineTargets + notesForKnowledge run for real against the
// testcontainer, so this pins the actual bounded fan-out submitPaperSlot produces.

import * as noteRefineTriggers from '@/capabilities/notes/server/note-refine-triggers';
import { artifact, knowledge, question } from '@/db/schema';
import { Review } from '@/server/session';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { MAX_NOTE_REFINE_FANOUT } from './note-refine-targets';
import { submitPaperSlot } from './paper-submit';

vi.mock('@/capabilities/notes/server/note-refine-triggers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/capabilities/notes/server/note-refine-triggers')>();
  return {
    ...actual,
    enqueueMasteryNoteRefine: vi.fn(async () => ({
      status: 'enqueued' as const,
      artifact_id: 'stub',
      kind: 'mastery_change' as const,
    })),
  };
});

const enqueueSpy = vi.mocked(noteRefineTriggers.enqueueMasteryNoteRefine);

async function seedKnowledge(id: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain: 'yuwen',
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedNote(id: string, knowledgeId: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'note_atomic',
      title: id,
      knowledge_ids: [knowledgeId],
      generation_status: 'ready',
      intent_source: 'test',
      source: 'test',
      verification_status: 'not_required',
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

async function seedTrueFalseQuestion(id: string, knowledgeIds: string[]): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'true_false',
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
      title: 'YUK-729 fan-out paper',
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

describe('YUK-729 — paper submit note-refine fan-out is bounded by MAX_NOTE_REFINE_FANOUT', () => {
  beforeEach(async () => {
    await resetDb();
    enqueueSpy.mockClear();
  });

  it('caps a many-KC × many-note paper success at MAX_NOTE_REFINE_FANOUT paid jobs', async () => {
    const db = testDb();

    // A question labeled with many KCs, each carrying multiple labeled notes: the
    // unbounded pre-fix loop would have enqueued one paid job per (KC × note) —
    // here 12 × 2 = 24 — instead of the bounded set.
    const kcCount = 12;
    const notesPerKc = 2;
    const knowledgeIds = Array.from({ length: kcCount }, (_, i) => `k_fan_${i}`);
    for (const kid of knowledgeIds) {
      await seedKnowledge(kid);
      for (let n = 0; n < notesPerKc; n++) {
        await seedNote(`note_${kid}_${n}`, kid);
      }
    }
    await seedTrueFalseQuestion('q_fan', knowledgeIds);
    await seedPaper('paper_fan', ['q_fan'], knowledgeIds[0]);

    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_fan' });

    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_fan',
        questionId: 'q_fan',
        answerMd: 'true', // matches reference → success, so the fan-out block runs
        primaryKnowledgeId: knowledgeIds[0],
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(submit.coarseOutcome).toBe('correct');

    // The load-bearing assertion: the fan-out is bounded. With 24 candidate notes
    // the pre-fix inline loop enqueued 24 paid jobs; the shared helper caps it.
    expect(enqueueSpy.mock.calls.length).toBeLessThanOrEqual(MAX_NOTE_REFINE_FANOUT);
    // The fixture guarantees > MAX distinct targets, so the cap binds exactly.
    expect(enqueueSpy.mock.calls.length).toBe(MAX_NOTE_REFINE_FANOUT);

    // Every enqueued target is a distinct artifact id (dedup preserved).
    const enqueuedIds = enqueueSpy.mock.calls.map((c) => c[0].artifactId);
    expect(new Set(enqueuedIds).size).toBe(enqueuedIds.length);
  });
});
