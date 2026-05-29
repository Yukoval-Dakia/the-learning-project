import { event } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { listProposalInboxRows } from './inbox';
import {
  writeArchiveProposal,
  writeCompletionProposal,
  writeJudgeRetractionProposal,
  writeLearningItemProposal,
  writeNoteUpdateProposal,
  writeRelearnProposal,
  writeVariantQuestionProposal,
} from './producers';

describe('proposal producer helpers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes the remaining seven producer-backed proposal kinds through the shared inbox reader', async () => {
    const db = testDb();
    await writeVariantQuestionProposal(db, {
      source_question_id: 'q1',
      source_attempt_event_id: 'attempt_1',
      prompt_md: 'variant prompt',
      reference_md: 'variant reference',
      difficulty: 3,
      knowledge_ids: ['k1'],
      parent_variant_id: 'q1',
      root_question_id: 'q1',
      variant_depth: 1,
      reason_md: 'targets the same cause',
    });
    await writeNoteUpdateProposal(db, {
      artifact_id: 'artifact_1',
      verification_event_id: 'verify_1',
      summary_md: 'needs a fix',
      issues: [{ block_id: 'b1', suggested_fix_md: 'tighten the example' }],
      reason_md: 'verifier found a factuality issue',
    });
    await writeLearningItemProposal(db, {
      topic: '虚词',
      knowledge_node: { id: 'k1', name: '虚词' },
      hub: { title: '虚词总览', summary_md: 'overview' },
      atomics: [{ knowledge_id: 'k1', title: '之', one_line_intent: 'distinguish usages' }],
      reason_md: 'user asked to learn this topic',
    });
    await writeCompletionProposal(db, {
      learning_item_id: 'li_done',
      triggering_signals: ['check_all_passed'],
      reason_md: 'all checks passed',
    });
    await writeRelearnProposal(db, {
      learning_item_id: 'li_relearn',
      current_mastery: 0.42,
      peak_mastery: 0.91,
      days_since_done: 21,
      reason_md: 'mastery decayed after completion',
    });
    await writeArchiveProposal(db, {
      target_subject_kind: 'learning_item',
      target_subject_id: 'li_archive',
      proposed_change: { status: 'archived', archived_reason: 'maintenance' },
      reason_md: 'stale item should leave the active queue',
    });
    await db.insert(event).values({
      id: 'judge_1',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'judge_runner',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'attempt_1',
      outcome: 'success',
      payload: { coarse_outcome: 'partial' },
      caused_by_event_id: 'attempt_1',
      created_at: new Date(),
    });
    await writeJudgeRetractionProposal(db, {
      judge_event_id: 'judge_1',
      appeal_event_id: 'appeal_1',
      reason_md: 'learner appeal shows the judge was wrong',
    });

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows.map((row) => row.kind).sort()).toEqual(
      [
        'archive',
        'completion',
        'judge_retraction',
        'learning_item',
        'note_update',
        'relearn',
        'variant_question',
      ].sort(),
    );
    expect(rows.every((row) => row.payload.cooldown_key)).toBe(true);
  });

  it('rejects judge_retraction evidence refs that do not point to judge events', async () => {
    const db = testDb();
    await db.insert(event).values({
      id: 'attempt_1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'partial',
      payload: { answer: 'x' },
      caused_by_event_id: null,
      created_at: new Date(),
    });

    await expect(
      writeJudgeRetractionProposal(db, {
        judge_event_id: 'attempt_1',
        reason_md: 'attempt is not a judge event',
      }),
    ).rejects.toMatchObject({
      code: 'evidence_ref_must_be_judge_event',
      status: 422,
    });
  });

  it('preserves the learning intent legacy action when requested', async () => {
    const db = testDb();
    const id = await writeLearningItemProposal(db, {
      topic: '虚词',
      knowledge_node: { id: 'k1', name: '虚词' },
      hub: { title: '虚词总览', summary_md: 'overview' },
      atomics: [{ knowledge_id: 'k1', title: '之', one_line_intent: 'distinguish usages' }],
      reason_md: 'user asked to learn this topic',
      legacy_subject_id: 'artifact_synthetic',
      legacy_event_payload: {
        topic: '虚词',
        knowledge_node_id: 'k1',
        knowledge_node: { id: 'k1', name: '虚词', domain: 'wenyan' },
        hub: { title: '虚词总览', summary_md: 'overview' },
        atomics: [{ knowledge_id: 'k1', title: '之', one_line_intent: 'distinguish usages' }],
      },
    });

    const row = (await db.select().from(event).where(eq(event.id, id)))[0];
    expect(row.action).toBe('experimental:propose_learning_intent');
    expect(row.subject_kind).toBe('artifact');
    expect((row.payload as { ai_proposal?: { kind?: string } }).ai_proposal?.kind).toBe(
      'learning_item',
    );
  });
});
