// M4-T4 (YUK-319) — block_merge proposal lifecycle 测试，从
// dispatch 壳的 actions.test.ts @ src/server/proposals 等价平移（搬迁不改逻辑）。
// 测试继续从公共 API（acceptAiProposal / dismissAiProposal）进入，以覆盖
// 「壳路由 → 包 applier」整条链。

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, proposal_signals, question, question_block, source_document } from '@/db/schema';
import {
  type ProposalInboxRow,
  getProposalInboxRow,
  listProposalInboxRows,
} from '@/kernel/proposals/inbox';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { acceptAiProposal } from '@/server/proposals/actions';
import { backfillQuestionBlockGenesis } from '../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { assertProposalLifecycleResult } from '../../../../tests/helpers/proposal-lifecycle';
import type { BlockMergeAcceptResult } from './proposal-appliers';
import { acceptBlockMergeProposal } from './proposal-appliers';

// YUK-202 / BlockAssembly path-B (design 2026-06-02 §4) — accept a block_merge
// proposal end-to-end: it reuses the YUK-195 `mergeQuestions` primitive (the
// merge runs ONLY here, on user accept — §5 no auto-merge), writes the accept
// rate event, is idempotent on a second accept, and goes stale (no rate event)
// when a block left draft before accept.
describe('block_merge proposal lifecycle', () => {
  let blockOrdinal = 0;
  beforeEach(async () => {
    blockOrdinal = 0;
    await resetDb();
  });

  // Mirror the YUK-195 fixture: a draft question_block with a structured tree in
  // a given ingestion session (mergeQuestions requires draft + same-session +
  // structured). YUK-1404 additionally requires learner-admission provenance:
  // same canonical source_document + non-placeholder page_spans — seeded here.

  async function seedSourceDocument(id = 'doc-1'): Promise<string> {
    const now = new Date();
    await testDb().insert(source_document).values({
      id,
      source_asset_ids: [],
      provenance: {},
      created_at: now,
      updated_at: now,
    });
    return id;
  }

  async function seedDraftBlock(opts: {
    sessionId: string;
    nodeId: string;
    promptText: string;
    status?: string;
    documentId?: string;
    pageIndex?: number;
    questionNo?: string;
  }): Promise<string> {
    const db = testDb();
    const blockId = createId();
    const now = new Date();
    const ordinal = blockOrdinal;
    blockOrdinal += 1;
    await db.insert(question_block).values({
      id: blockId,
      ingestion_session_id: opts.sessionId,
      source_document_id: opts.documentId ?? 'doc-1',
      source_asset_ids: [],
      page_spans:
        opts.pageIndex !== undefined
          ? [{ page_index: opts.pageIndex, bbox: { x: 0, y: 0, width: 1, height: 1 } }]
          : [],
      structured: {
        id: opts.nodeId,
        role: 'standalone',
        prompt_text: opts.promptText,
        ...(opts.questionNo ? { question_no: opts.questionNo } : {}),
      },
      figures: [],
      layout_quality: 'structured',
      image_refs: [],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 1,
      status: opts.status ?? 'draft',
      knowledge_hint: null,
      merged_from_block_ids: [],
      imported_question_id: null,
      imported_attempt_event_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
      ordinal,
    });
    await backfillQuestionBlockGenesis(db, now);
    return blockId;
  }

  async function readBlock(blockId: string) {
    return (
      await testDb().select().from(question_block).where(eq(question_block.id, blockId)).limit(1)
    )[0];
  }

  async function seedBlockMergeProposal(opts: {
    proposalId: string;
    sessionId: string;
    primaryBlockId: string;
    mergeBlockIds: string[];
  }): Promise<void> {
    await writeAiProposal(testDb(), {
      id: opts.proposalId,
      payload: {
        kind: 'block_merge',
        target: { subject_kind: 'question_block', subject_id: opts.primaryBlockId },
        reason_md: '连续编号，承接前题',
        evidence_refs: [],
        proposed_change: {
          primary_block_id: opts.primaryBlockId,
          merge_block_ids: opts.mergeBlockIds,
          ingestion_session_id: opts.sessionId,
          continuity_signal: 'numbering',
        },
        cooldown_key: `block_merge:${opts.sessionId}:${opts.primaryBlockId}:${opts.mergeBlockIds.join(',')}`,
      },
    });
  }

  it('accept runs mergeQuestions, absorbs merge blocks, and writes an accept rate event', async () => {
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      pageIndex: 2,
    });
    const m2 = await seedDraftBlock({
      sessionId,
      nodeId: 'm2',
      promptText: 'merge2',
      pageIndex: 3,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_p1',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1, m2],
    });

    const result = await acceptAiProposal(db, 'block_merge_p1', { confirm_lossy: true });

    expect(result.kind).toBe('block_merge');
    assertProposalLifecycleResult<BlockMergeAcceptResult>(result, 'block_merge');
    expect(result).toMatchObject({
      kind: 'block_merge',
      primary_block_id: primary,
      merged_count: 2,
    });
    expect(result.rate_event_id).toBeTruthy();
    expect(result.stale).toBeUndefined();

    // (a) mergeQuestions ran: primary absorbed the merge blocks (stem + grown
    // sub_questions, in caller order) and the merge blocks flipped to 'ignored'.
    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.structured?.role).toBe('stem');
    expect(primaryBlock.structured?.sub_questions?.map((s) => s.id)).toEqual(['p', 'm1', 'm2']);
    expect(primaryBlock.merged_from_block_ids).toEqual([m1, m2]);
    expect((await readBlock(m1)).status).toBe('ignored');
    expect((await readBlock(m2)).status).toBe('ignored');

    // (b) exactly one accept rate event chained to the proposal.
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_p1')));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].id).toBe(result.rate_event_id);
    expect(rateRows[0].payload).toMatchObject({
      rating: 'accept',
      primary_block_id: primary,
      merged_block_ids: [m1, m2],
    });
  });

  it('reports the EFFECTIVE merged set when the payload has duplicate or primary ids', async () => {
    // A hallucinating producer can emit merge_block_ids with a duplicate or the
    // primary id (the schema does not refine for uniqueness/exclude-primary).
    // mergeQuestions dedups + strips the primary before merging; merged_count and
    // the rate event's merged_block_ids must match what was ACTUALLY merged
    // (= the block's merged_from_block_ids), not the raw payload.
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      pageIndex: 2,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_dup',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1, m1, primary], // duplicate + the primary itself
    });

    const result = await acceptAiProposal(db, 'block_merge_dup', { confirm_lossy: true });
    assertProposalLifecycleResult<BlockMergeAcceptResult>(result, 'block_merge');
    // effective set = [m1]; NOT 3.
    expect(result.merged_count).toBe(1);
    expect(result.stale).toBeUndefined();

    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.merged_from_block_ids).toEqual([m1]);
    expect((await readBlock(m1)).status).toBe('ignored');

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_dup')));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({ merged_block_ids: [m1] });
  });

  it('a second accept is idempotent: no double-merge, no second rate event', async () => {
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      pageIndex: 2,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_idem',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    const first = await acceptAiProposal(db, 'block_merge_idem', { confirm_lossy: true });
    expect(first.kind).toBe('block_merge');
    assertProposalLifecycleResult<BlockMergeAcceptResult>(first, 'block_merge');
    expect(first.merged_count).toBe(1);

    // The completed-accept replay needs NO renewed confirmation (the merge
    // already happened; there is nothing left to confirm).
    const second = await acceptAiProposal(db, 'block_merge_idem');
    expect(second).toMatchObject({
      kind: 'block_merge',
      idempotent: true,
      primary_block_id: primary,
      rate_event_id: first.rate_event_id,
    });

    // No double-merge: merged_from_block_ids stays single, version is the single
    // merge's bump (not two), and only one rate event exists.
    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.merged_from_block_ids).toEqual([m1]);
    expect(primaryBlock.version).toBe(1);

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_idem')));
    expect(rateRows).toHaveLength(1);

    // Acceptance signal stays consistent across the idempotent re-accept.
    const signals = await db
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'block_merge'));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ accept_count: 1, dismiss_count: 0 });
  });

  it('returns stale with no rate event when a merge block is no longer draft', async () => {
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    // Pre-merge the merge block out of draft (e.g. already imported): the
    // preflight admission's not_draft arm (and, in a race, mergeQuestions'
    // own skipped:not_draft guard) both answer the same soft-stale shape.
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      status: 'imported',
      pageIndex: 2,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_stale',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    const result = await acceptAiProposal(db, 'block_merge_stale', { confirm_lossy: true });

    expect(result).toMatchObject({
      kind: 'block_merge',
      primary_block_id: primary,
      stale: true,
      skip_reason: 'skipped:not_draft',
    });
    assertProposalLifecycleResult<BlockMergeAcceptResult>(result, 'block_merge');
    expect(result.rate_event_id).toBeUndefined();

    // No mutation: primary stays its own standalone, merge block untouched.
    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.structured?.role).toBe('standalone');
    expect(primaryBlock.merged_from_block_ids).toEqual([]);
    expect(primaryBlock.version).toBe(0);
    expect((await readBlock(m1)).status).toBe('imported');

    // No rate event written for a stale proposal.
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_stale')));
    expect(rateRows).toHaveLength(0);
  });

  // ── YUK-1404 merge-admission invariants (irreversible loss / confirmation) ──

  it('rejects a new accept without confirm_lossy: no mutation, no rate, no signal', async () => {
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      pageIndex: 2,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_noconfirm',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    await expect(acceptAiProposal(db, 'block_merge_noconfirm')).rejects.toMatchObject({
      code: 'confirm_required',
      status: 409,
      message: '合并后无法撤销',
      details: { affected_block_count: 2 },
    });

    // Zero side effects on the blocks, the rate stream, and the decision signal.
    expect((await readBlock(primary)).merged_from_block_ids).toEqual([]);
    expect((await readBlock(primary)).status).toBe('draft');
    expect((await readBlock(m1)).status).toBe('draft');
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_noconfirm')));
    expect(rateRows).toHaveLength(0);
    const signals = await db
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'block_merge'));
    expect(signals).toHaveLength(0);
  });

  it('rejects a misplaced confirm_lossy on a non-accept decision', async () => {
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      pageIndex: 2,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_misplaced',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    await expect(
      acceptAiProposal(db, 'block_merge_misplaced', {
        decision: 'reverse',
        confirm_lossy: true,
      } as never),
    ).rejects.toMatchObject({ code: 'validation_error', status: 400 });
    expect((await readBlock(m1)).status).toBe('draft');
  });

  it('hides an inadmissible proposal from the learner inbox and rejects its accept (multi-paper conflict)', async () => {
    // The TEST-event shape: two blocks carrying the SAME question number on
    // adjacent pages of one upload batch (different papers) — the AI's
    // numbering signal proposed the merge but stored facts prove a
    // different-question conflict. The event stays stored; it is never
    // learner-visible and can never be accepted.
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: '第1题。',
      pageIndex: 1,
      questionNo: '1',
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: '第1题（另一卷）。',
      pageIndex: 2,
      questionNo: '1',
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_conflict',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    const visible = await listProposalInboxRows(db, { status: 'pending' });
    expect(visible.some((row) => row.id === 'block_merge_conflict')).toBe(false);
    // …yet the stored event still occupies the internal pending set.
    const raw = await listProposalInboxRows(db, {
      status: 'pending',
      includeInadmissibleBlockMerges: true,
    });
    expect(raw.some((row) => row.id === 'block_merge_conflict')).toBe(true);

    // The shared accept boundary sees the proposal as invisible → 404.
    await expect(
      acceptAiProposal(db, 'block_merge_conflict', { confirm_lossy: true }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_conflict')));
    expect(rateRows).toHaveLength(0);
  });

  // ── YUK-1404 draft-status admission (irreversible-loss class: a non-draft
  // chain can never be re-merged — it must be invisible to the learner and can
  // never produce an acceptance event) ──

  it('hides a non-draft chain from the learner inbox yet answers its accept with soft stale', async () => {
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      status: 'imported',
      pageIndex: 2,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_nondraft',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    // Hidden from the learner list (the shared read rule now consults status)
    // …yet the stored event still occupies the internal pending set.
    const visible = await listProposalInboxRows(db, { status: 'pending' });
    expect(visible.some((row) => row.id === 'block_merge_nondraft')).toBe(false);
    const raw = await listProposalInboxRows(db, {
      status: 'pending',
      includeInadmissibleBlockMerges: true,
    });
    expect(raw.some((row) => row.id === 'block_merge_nondraft')).toBe(true);

    // The single-row decision lane still resolves the row — the soft-stale
    // answer rides on it — and the public accept returns stale, never
    // 409/500: no rate event, no signal, proposal stays pending.
    expect(await getProposalInboxRow(db, 'block_merge_nondraft')).not.toBeNull();
    const result = await acceptAiProposal(db, 'block_merge_nondraft', { confirm_lossy: true });
    expect(result).toMatchObject({
      kind: 'block_merge',
      primary_block_id: primary,
      stale: true,
      skip_reason: 'skipped:not_draft',
    });
    assertProposalLifecycleResult<BlockMergeAcceptResult>(result, 'block_merge');
    expect(result.rate_event_id).toBeUndefined();

    // Zero side effects: no block mutation, no acceptance event, no signal,
    // and no false resolve — the proposal is still pending afterwards.
    expect((await readBlock(primary)).merged_from_block_ids).toEqual([]);
    expect((await readBlock(primary)).version).toBe(0);
    expect((await readBlock(m1)).status).toBe('imported');
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_nondraft')));
    expect(rateRows).toHaveLength(0);
    const signals = await db
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'block_merge'));
    expect(signals).toHaveLength(0);
    expect((await getProposalInboxRow(db, 'block_merge_nondraft'))?.status).toBe('pending');
  });

  it('delivers soft stale when blocks leave draft between the inbox read and the accept (race window)', async () => {
    // The row was loaded while the chain was still eligible, then a
    // referenced block left draft before the accept's preflight re-read. The
    // preflight's not_draft arm must answer the SAME soft-stale shape the
    // locked in-tx re-check produces for the preflight→lock race — never a
    // 500, and never a lossy-confirmation demand for a no-op (the stale
    // answer needs no confirm_lossy).
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      pageIndex: 2,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_race',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    // Load the row while the chain is still eligible (the read passes)…
    const row = await getProposalInboxRow(db, 'block_merge_race');
    if (!row) throw new Error('block_merge_race row must resolve while eligible');
    // …then the world changes under it.
    await db.update(question_block).set({ status: 'merged' }).where(eq(question_block.id, m1));

    const result = await acceptBlockMergeProposal(db, 'block_merge_race', row, {
      decision: 'accept',
    });
    expect(result).toMatchObject({
      kind: 'block_merge',
      primary_block_id: primary,
      stale: true,
      skip_reason: 'skipped:not_draft',
    });
    expect(result.rate_event_id).toBeUndefined();

    expect((await readBlock(primary)).merged_from_block_ids).toEqual([]);
    expect((await readBlock(primary)).version).toBe(0);
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_race')));
    expect(rateRows).toHaveLength(0);
  });

  it('fails closed at the shared applier boundary even when the inbox is bypassed', async () => {
    // A caller that constructs the applier input directly (skipping the inbox
    // read rule) still hits the authoritative admission proof BEFORE any merge.
    const db = testDb();
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: '第1题。',
      pageIndex: 1,
      questionNo: '1',
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: '第1题。',
      pageIndex: 2,
      questionNo: '1',
    });
    const proposalRow = {
      id: 'block_merge_direct',
      kind: 'block_merge',
      target: { subject_kind: 'question_block', subject_id: primary },
      payload: {
        kind: 'block_merge',
        target: { subject_kind: 'question_block', subject_id: primary },
        reason_md: '题号相同',
        evidence_refs: [],
        proposed_change: {
          primary_block_id: primary,
          merge_block_ids: [m1],
          ingestion_session_id: sessionId,
        },
      },
      status: 'pending',
      proposed_at: new Date(),
      decided_at: null,
      actor_ref: 'agent',
      task_run_id: null,
      cost_micro_usd: null,
      source_action: 'experimental:proposal',
      source_subject_kind: 'event',
      signals: null,
      presentation: null,
    } as unknown as ProposalInboxRow;
    await expect(
      acceptBlockMergeProposal(db, 'block_merge_direct', proposalRow, { confirm_lossy: true }),
    ).rejects.toMatchObject({ code: 'merge_inadmissible', status: 409 });
    expect((await readBlock(m1)).status).toBe('draft');
    expect((await readBlock(primary)).merged_from_block_ids).toEqual([]);
  });
});
