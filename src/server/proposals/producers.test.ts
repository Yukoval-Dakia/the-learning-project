import { resolveSuggestionKind } from '@/core/schema/proposal';
import { event } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { listProposalInboxRows } from './inbox';
import {
  writeArchiveProposal,
  writeBlockMergeProposal,
  writeCompletionProposal,
  writeJudgeRetractionProposal,
  writeLearningItemProposal,
  writeRelearnProposal,
  writeVariantQuestionProposal,
} from './producers';

describe('proposal producer helpers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes the remaining six producer-backed proposal kinds through the shared inbox reader', async () => {
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
    // YUK-358 决定7 — writeNoteUpdateProposal (patch-less note_verify producer)
    // was deleted; the note_update proposal KIND is still produced (with a patch)
    // by writeNoteRefineProposal, exercised in the note-refine tests.
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

  // YUK-202 / BlockAssembly path-B (design 2026-06-02 §1.C + §5) — the
  // writeBlockMergeProposal producer writes a `block_merge` proposal event that
  // flows through the default writer branch (action='experimental:proposal',
  // subject_kind='question_block') and is therefore selectable by proposalWhere()
  // — i.e. it lands in the shared inbox reader. AI never auto-merges; this
  // producer only proposes (S2's acceptBlockMergeProposal runs mergeQuestions on
  // user accept).
  it('writeBlockMergeProposal lands a block_merge proposal in the inbox with the typed change read back', async () => {
    const db = testDb();
    const id = await writeBlockMergeProposal(db, {
      ingestion_session_id: 'sess_1',
      primary_block_id: 'block_a',
      merge_block_ids: ['block_b', 'block_c'],
      confidence: 0.82,
      continuity_signal: 'numbering',
      reason_md: 'question_no continuity: block_b/block_c continue block_a numbering',
    });

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error('expected the block_merge proposal in the inbox');

    expect(row.kind).toBe('block_merge');
    // Default writer branch (no event_override) → experimental:proposal / question_block.
    expect(row.source_action).toBe('experimental:proposal');
    expect(row.target.subject_kind).toBe('question_block');
    expect(row.target.subject_id).toBe('block_a');
    expect(row.actor_ref).toBe('block_assembly');

    if (row.payload.kind !== 'block_merge') throw new Error('expected block_merge payload');
    expect(row.payload.proposed_change).toEqual({
      primary_block_id: 'block_a',
      merge_block_ids: ['block_b', 'block_c'],
      ingestion_session_id: 'sess_1',
      continuity_signal: 'numbering',
      // YUK-202 fork 4a — confidence is persisted for the redraw inbox to sort by.
      confidence: 0.82,
    });
    // §1.C — primary + each merge candidate is an evidence ref for the inbox preview.
    expect(row.payload.evidence_refs).toEqual([
      { kind: 'question', id: 'block_a' },
      { kind: 'question', id: 'block_b' },
      { kind: 'question', id: 'block_c' },
    ]);
    expect(row.payload.cooldown_key).toBe('block_merge:sess_1:block_a:block_b,block_c');
    // YUK-202 — block_merge is a PROACTIVE structural suggestion, NOT a failure-retry
    // (variant_question is the only corrective kind, SK-3). It must NOT carry
    // suggestion_kind:'corrective', else signals.ts early-returns on accept and drops
    // the proposal_signals row / accept_count / cooldown clear for a real production
    // proposal. Guard the resolved kind, not just the absent field.
    expect(row.payload.suggestion_kind).toBeUndefined();
    expect(resolveSuggestionKind(row.payload)).toBe('proactive');
  });

  // §5 dedup (1) — the cooldown_key is derived from the SORTED merge ids, so a
  // duplicate candidate for the same block set (regardless of merge-id ordering)
  // produces the SAME (kind, cooldown_key). writeAiProposal does not hard-suppress
  // a second write (the proposal_signals aggregate keys on (kind, cooldown_key) and
  // intentionally aggregates sibling proposals — signals.ts), so both events land;
  // the shared cooldown_key is what folds them in the inbox cooldown signal.
  it('writeBlockMergeProposal derives a stable cooldown_key from sorted merge ids (dedup key)', async () => {
    const db = testDb();
    const first = await writeBlockMergeProposal(db, {
      ingestion_session_id: 'sess_1',
      primary_block_id: 'block_a',
      merge_block_ids: ['block_b', 'block_c'],
      confidence: 0.7,
      continuity_signal: 'carryover',
      reason_md: 'carryover cue from block_a',
    });
    // Same block set, merge ids in a different order → must collapse to one key.
    const second = await writeBlockMergeProposal(db, {
      ingestion_session_id: 'sess_1',
      primary_block_id: 'block_a',
      merge_block_ids: ['block_c', 'block_b'],
      confidence: 0.7,
      continuity_signal: 'carryover',
      reason_md: 'carryover cue from block_a (re-proposed)',
    });

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    const firstRow = rows.find((r) => r.id === first);
    const secondRow = rows.find((r) => r.id === second);
    if (!firstRow || !secondRow) throw new Error('expected both block_merge proposals');

    expect(firstRow.payload.cooldown_key).toBe('block_merge:sess_1:block_a:block_b,block_c');
    expect(secondRow.payload.cooldown_key).toBe(firstRow.payload.cooldown_key);
  });

  // P5.6 / YUK-178 (AC-2, SK-3) — the variant_question producer is the only
  // structurally-corrective proposal kind: it fires ONLY after a failed attempt,
  // so it hard-sets suggestion_kind:'corrective'. Other producers leave it absent
  // (→ proactive), proving the default-to-proactive contract (ND-SK-1).
  it('variant_question producer hard-sets suggestion_kind:corrective; siblings stay proactive', async () => {
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
    await writeCompletionProposal(db, {
      learning_item_id: 'li_done',
      triggering_signals: ['check_all_passed'],
      reason_md: 'all checks passed',
    });

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    const variant = rows.find((row) => row.kind === 'variant_question');
    const completion = rows.find((row) => row.kind === 'completion');
    if (!variant || !completion) throw new Error('expected variant + completion proposals');

    expect(variant.payload.suggestion_kind).toBe('corrective');
    expect(resolveSuggestionKind(variant.payload)).toBe('corrective');

    // Audited always-proactive maintenance kind — field absent, reader proactive.
    expect(completion.payload.suggestion_kind).toBeUndefined();
    expect(resolveSuggestionKind(completion.payload)).toBe('proactive');
  });
});
