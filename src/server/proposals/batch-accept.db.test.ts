// 批量确认（proposal batch-accept）DB 测试（db 分区；testcontainer + resetDb）。
// 断言契约：准入集合是 B 档且已确认后仍可经 canonical retract 撤销的 kind；
// 单条失败不回滚他条，重放不写第二条 decision，被拒/未找到的项不写 decision；
// 批量锚持久化 batch_id -> proposal_ids，经锚读回后可走单条 retract 真撤销效果。

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { event, learning_item, question } from '@/db/schema';
import { getCorrectionStatuses, writeEvent } from '@/kernel/events';
import { PROPOSAL_BATCH_ACCEPT_ACTION } from '@/kernel/proposals/batch-confirm';
import { getProposalInboxRow } from '@/kernel/proposals/inbox';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { migrateCanonicalProjections } from '../../../scripts/migrate-canonical-projections';
import { resetDb, testDb } from '../../../tests/helpers/db';
import * as acceptAction from './accept-action';
import { acceptAiProposal } from './accept-action';
import {
  batchAcceptProposals,
  installBatchConfirmEligibility,
  proposalBatchId,
} from './batch-accept';
import { retractAiProposal } from './retract-action';

const NOW = new Date('2026-11-08T00:00:00Z');

async function seedLearningItem(id: string): Promise<void> {
  await testDb()
    .insert(learning_item)
    .values({
      id,
      source: 'manual',
      title: `学习项 ${id}`,
      status: 'pending',
      created_at: NOW,
      updated_at: NOW,
    });
}

async function seedCompletionProposal(proposalId: string, learningItemId: string): Promise<void> {
  await writeAiProposal(testDb(), {
    id: proposalId,
    actor_ref: 'agent:copilot',
    payload: {
      kind: 'completion',
      target: { subject_kind: 'learning_item', subject_id: learningItemId },
      reason_md: 'copilot 判定可以标记完成',
      evidence_refs: [],
      proposed_change: { learning_item_id: learningItemId },
    },
  });
}

// question_edit declares a retract path but refuses once the edit is applied —
// it is the boundary proof that "declared retract" alone is not undoability.
async function seedQuestionEditProposal(proposalId: string, questionId: string): Promise<void> {
  await testDb()
    .insert(question)
    .values({
      id: questionId,
      kind: 'short_answer',
      prompt_md: '阅读下面文段，回答问题。',
      reference_md: '代词。',
      knowledge_ids: [],
      difficulty: 3,
      source: 'manual',
      draft_status: 'active',
      structured: {
        id: 'n_stem',
        role: 'stem',
        prompt_text: '阅读下面文段，回答问题。',
        sub_questions: [
          {
            id: 'n_short',
            role: 'sub',
            question_no: '1',
            prompt_text: '解释「之」的用法。',
            answers: ['代词。'],
          },
        ],
      } satisfies StructuredQuestionT,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
  await writeAiProposal(testDb(), {
    id: proposalId,
    actor_ref: 'agent:copilot',
    payload: {
      kind: 'question_edit',
      target: { subject_kind: 'question', subject_id: questionId },
      reason_md: 'copilot 提议修订题面',
      evidence_refs: [{ kind: 'question', id: questionId }],
      proposed_change: {
        question_id: questionId,
        edit: { op: 'edit_node_text', node_id: 'n_stem', prompt_text: '题面修订' },
      },
    },
  });
}

async function rateCount(proposalId: string): Promise<number> {
  return (
    await testDb()
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
  ).length;
}

describe('proposal batch confirmation', () => {
  beforeEach(resetDb);
  // @invariant data: replaying a batch-accept writes no second
  // decision, rejected or missing proposals write none, and the durable anchor
  // keeps the accepted set revocable through the canonical single-item retract
  // @fails-if a replay mints another rate event or anchor, a rejected item gains
  // a decision, the anchor loses the accepted ids, or a batch-accepted proposal
  // stops responding to the single retract path
  it('accepts eligible proposals once, rejects the rest, and stays revocable', async () => {
    const db = testDb();
    installBatchConfirmEligibility();
    await seedLearningItem('li_b1');
    await seedLearningItem('li_b2');
    // learning_item mutations run on canonical projections; the fixture models
    // persisted rows entering a migrated deployment. Anchors must land before
    // the proposal events or migration rejects the items' orphaned history.
    await migrateCanonicalProjections(db);
    await seedCompletionProposal('lc_b1', 'li_b1');
    await seedCompletionProposal('lc_b2', 'li_b2');
    // judge_retraction is grading-adjacent and declares no retract — excluded.
    await writeAiProposal(db, {
      id: 'jr_b3',
      actor_ref: 'agent:copilot',
      payload: {
        kind: 'judge_retraction',
        target: { subject_kind: 'evaluation', subject_id: 'ev_x' },
        reason_md: 'copilot 提议纠正判分',
        evidence_refs: [],
        proposed_change: { evaluation_id: 'ev_x' },
      },
    });
    await seedQuestionEditProposal('qe_b4', 'q_batch');
    // qe_b4 accepted through the single path: an already-accepted but
    // non-revocable kind must still read rejected and stay out of the anchor,
    // or revoke-by-set would claim it can undo what the owner refuses to.
    await acceptAiProposal(db, 'qe_b4');

    expect((await getProposalInboxRow(db, 'lc_b1'))?.batch_confirm_eligible).toBe(true);
    expect((await getProposalInboxRow(db, 'jr_b3'))?.batch_confirm_eligible).toBe(false);
    expect((await getProposalInboxRow(db, 'qe_b4'))?.batch_confirm_eligible).toBe(false);

    const ids = ['lc_b1', 'lc_b2', 'jr_b3', 'qe_b4', 'p_missing'];
    const first = await batchAcceptProposals(db, { proposal_ids: ids });
    expect(first.batch_id).toMatch(/^proposal_batch_/);
    expect(first.items).toEqual([
      {
        proposal_id: 'lc_b1',
        kind: 'completion',
        status: 'accepted',
        code: null,
        reason_md: null,
      },
      {
        proposal_id: 'lc_b2',
        kind: 'completion',
        status: 'accepted',
        code: null,
        reason_md: null,
      },
      {
        proposal_id: 'jr_b3',
        kind: 'judge_retraction',
        status: 'rejected',
        code: 'kind_not_batchable',
        reason_md: expect.any(String),
      },
      {
        proposal_id: 'qe_b4',
        kind: 'question_edit',
        status: 'rejected',
        code: 'kind_not_batchable',
        reason_md: expect.any(String),
      },
      {
        proposal_id: 'p_missing',
        kind: 'unknown',
        status: 'failed',
        code: 'proposal_not_found',
        reason_md: expect.any(String),
      },
    ]);
    expect(first.summary).toMatchObject({
      requested: 5,
      accepted: 2,
      already_accepted: 0,
      rejected: 2,
      failed: 1,
    });
    expect(await rateCount('lc_b1')).toBe(1);
    expect(await rateCount('lc_b2')).toBe(1);
    expect(await rateCount('jr_b3')).toBe(0);
    // The single-path accept decision stands; the batch only refuses to claim it.
    expect(await rateCount('qe_b4')).toBe(1);
    expect(await rateCount('p_missing')).toBe(0);
    const [done] = await db.select().from(learning_item).where(eq(learning_item.id, 'li_b1'));
    expect(done.status).toBe('done');

    const replay = await batchAcceptProposals(db, { proposal_ids: ids });
    expect(replay.batch_id).toBe(first.batch_id);
    expect(replay.items.map((entry) => entry.status)).toEqual([
      'already_accepted',
      'already_accepted',
      'rejected',
      'rejected',
      'failed',
    ]);
    expect(await rateCount('lc_b1')).toBe(1);
    expect(await rateCount('lc_b2')).toBe(1);
    expect(await rateCount('jr_b3')).toBe(0);
    expect(await rateCount('qe_b4')).toBe(1);

    const anchors = await db
      .select()
      .from(event)
      .where(eq(event.action, PROPOSAL_BATCH_ACCEPT_ACTION));
    expect(anchors).toHaveLength(2);
    const members = anchors.find((row) => row.payload.stage === 'members');
    const result = anchors.find((row) => row.payload.stage === 'result');
    expect(members).toMatchObject({
      subject_kind: 'proposal_batch',
      subject_id: first.batch_id,
      outcome: 'success',
      payload: { proposal_ids: ids },
    });
    expect(result).toMatchObject({
      subject_kind: 'proposal_batch',
      subject_id: first.batch_id,
      outcome: 'success',
      payload: { proposal_ids: ['lc_b1', 'lc_b2'] },
    });

    // The anchored set revokes through the canonical per-item retract path and
    // the owner applier restores the prior learning state — the confirm was real.
    await retractAiProposal(db, 'lc_b1');
    expect((await getCorrectionStatuses(db, ['lc_b1'])).get('lc_b1')?.state).toBe('retracted');
    const [restored] = await db.select().from(learning_item).where(eq(learning_item.id, 'li_b1'));
    expect(restored.status).toBe('pending');
    // A revoked member keeps its single decision trail — a later batch run still
    // reports it as decided rather than accepting it again.
    const third = await batchAcceptProposals(db, { proposal_ids: ['lc_b1'] });
    expect(third.items).toMatchObject([{ proposal_id: 'lc_b1', status: 'rejected' }]);
    expect(await rateCount('lc_b1')).toBe(1);
  });

  // @invariant data: a run interrupted after committing accepts but before
  // recording the batch result still leaves a recoverable batch — the retry
  // completes the SAME batch id and revoke-by-set works through the canonical
  // single retract path
  // @fails-if a retry reports batch_id=null or mints a second batch, the
  // recovered batch is missing the accepted members, or revoke-by-set loses
  // the canonical retract trail
  it('recovers a batch interrupted between the accepted effect and its result', async () => {
    const db = testDb();
    installBatchConfirmEligibility();
    await seedLearningItem('li_c1');
    await migrateCanonicalProjections(db);
    await seedCompletionProposal('lc_c1', 'li_c1');

    // Crash state: the members anchor persisted before the first effect and
    // the accept committed, but no result anchor exists — exactly what a dead
    // process between the two writes leaves behind.
    const ids = ['lc_c1'];
    const batchId = proposalBatchId(ids);
    await writeEvent(db, {
      id: `evt_${batchId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: PROPOSAL_BATCH_ACCEPT_ACTION,
      subject_kind: 'proposal_batch',
      subject_id: batchId,
      outcome: 'success',
      payload: { version: 2, batch_id: batchId, stage: 'members', proposal_ids: ids },
    });
    await acceptAiProposal(db, 'lc_c1');

    const recovered = await batchAcceptProposals(db, { proposal_ids: ids });
    expect(recovered.batch_id).toBe(batchId);
    expect(recovered.items).toMatchObject([{ proposal_id: 'lc_c1', status: 'already_accepted' }]);
    expect(await rateCount('lc_c1')).toBe(1);

    const anchors = await db
      .select()
      .from(event)
      .where(eq(event.action, PROPOSAL_BATCH_ACCEPT_ACTION));
    expect(anchors).toHaveLength(2);
    const result = anchors.find((row) => row.payload.stage === 'result');
    expect(result).toMatchObject({
      subject_id: batchId,
      payload: { proposal_ids: ['lc_c1'] },
    });

    await retractAiProposal(db, 'lc_c1');
    const [restored] = await db.select().from(learning_item).where(eq(learning_item.id, 'li_c1'));
    expect(restored.status).toBe('pending');
  });

  // @invariant data: batch membership is durable before the first accept is
  // attempted — a run whose accepts all fail still leaves the replayable
  // identity behind instead of recording nothing
  // @fails-if the members anchor is written only after accepts or only when
  // something accepted: a crash between two failed accepts would strand the
  // committed effects of an earlier member with no recoverable set
  it('persists batch membership even when every accept fails', async () => {
    const db = testDb();
    installBatchConfirmEligibility();
    await migrateCanonicalProjections(db);
    // The target learning_item does not exist, so the canonical accept throws
    // before any effect — the request still resolves the full batch identity.
    await seedCompletionProposal('lc_f1', 'li_missing');

    const res = await batchAcceptProposals(db, { proposal_ids: ['lc_f1', 'p_gone'] });
    expect(res.items.map((entry) => entry.status)).toEqual(['failed', 'failed']);
    expect(res.batch_id).toBeNull();
    expect(await rateCount('lc_f1')).toBe(0);

    const anchors = await db
      .select()
      .from(event)
      .where(eq(event.action, PROPOSAL_BATCH_ACCEPT_ACTION));
    const members = anchors.find((row) => row.payload.stage === 'members');
    const result = anchors.find((row) => row.payload.stage === 'result');
    expect(members).toMatchObject({
      subject_id: proposalBatchId(['lc_f1', 'p_gone']),
      payload: { proposal_ids: ['lc_f1', 'p_gone'] },
    });
    // A fully failed batch still closes: revoke-by-set simply has no members.
    expect(result).toMatchObject({
      subject_id: proposalBatchId(['lc_f1', 'p_gone']),
      payload: { proposal_ids: [] },
    });
  });

  // @invariant data: the members anchor is durable before the first accept
  // runs — observed inside the accept itself, so this fails if the anchor
  // write ever moves behind the accept loop
  // @fails-if the first accept finds no members anchor in the event table:
  // a crash inside the first effect would strand committed accepts with no
  // recoverable batch identity
  it('persists the members anchor before the first accept runs', async () => {
    const db = testDb();
    installBatchConfirmEligibility();
    await seedLearningItem('li_o1');
    await migrateCanonicalProjections(db);
    await seedCompletionProposal('lc_o1', 'li_o1');

    // Read the event table at the moment the accept executes — a throw then
    // plays the role of a crashed first effect. If the anchor write moved
    // after the accepts, the table would still be empty here.
    let membersBeforeFirstAccept = false;
    vi.spyOn(acceptAction, 'acceptAiProposal').mockImplementation(async () => {
      const anchors = await db
        .select({ payload: event.payload })
        .from(event)
        .where(eq(event.action, PROPOSAL_BATCH_ACCEPT_ACTION));
      membersBeforeFirstAccept = anchors.some(
        (row) => (row.payload as { stage?: unknown }).stage === 'members',
      );
      throw new Error('simulated crash inside the accept');
    });

    const res = await batchAcceptProposals(db, { proposal_ids: ['lc_o1'] });
    vi.restoreAllMocks();
    expect(res.items.map((entry) => entry.status)).toEqual(['failed']);
    expect(membersBeforeFirstAccept).toBe(true);
  });
});
