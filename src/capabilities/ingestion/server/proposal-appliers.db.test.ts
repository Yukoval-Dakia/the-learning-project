// M4-T4 (YUK-319) — block_merge + image_candidate proposal lifecycle 测试，从
// dispatch 壳的 actions.test.ts @ src/server/proposals 等价平移（搬迁不改逻辑）。
// 测试继续从公共 API（acceptAiProposal / dismissAiProposal）进入，以覆盖
// 「壳路由 → 包 applier」整条链。

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedKnowledge } from '@/capabilities/knowledge/public';
import {
  cost_ledger,
  event,
  knowledge,
  proposal_signals,
  question,
  question_block,
  source_document,
} from '@/db/schema';
import { type ProposalInboxRow, listProposalInboxRows } from '@/kernel/proposals/inbox';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { ProviderAttemptLifecycleError } from '@/server/ai/provider-attempt-lifecycle';
import { acceptAiProposal, dismissAiProposal } from '@/server/proposals/actions';
import { backfillQuestionBlockGenesis } from '../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { assertProposalLifecycleResult } from '../../../../tests/helpers/proposal-lifecycle';
import type {
  ImageCandidateAcceptDeps,
  ImageCandidateAcceptResult,
} from './image-candidate-accept';
import type { BlockMergeAcceptResult } from './proposal-appliers';
import { acceptBlockMergeProposal } from './proposal-appliers';

// The production path intentionally uses npm Undici fetch with its npm Agent (YUK-743).
// These DB tests still stub network responses through the existing global-fetch spies;
// the real package pairing is exercised by pinned-fetch.unit.test.ts on Node 24.
vi.mock('./pinned-fetch', async (importOriginal) => {
  const original = await importOriginal<typeof import('./pinned-fetch')>();
  return {
    ...original,
    fetchWithPinnedDispatcher: (...args: Parameters<typeof original.fetchWithPinnedDispatcher>) =>
      (globalThis.fetch as unknown as typeof original.fetchWithPinnedDispatcher)(...args),
  };
});

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
    // Pre-merge the merge block out of draft (e.g. already imported) so
    // mergeQuestions soft-rejects with skipped:not_draft.
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

// YUK-227 S3 Slice C (ADR-0002) — image_candidate accept = the SINGLE VLM 抽图 trigger.
describe('image_candidate accept (YUK-227 S3 Slice C)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // A VisionExtractTask output (parseVisionOutput shape) — one block.
  const VLM_OUTPUT = JSON.stringify({
    blocks: [
      {
        extracted_prompt_md: '请翻译「学而时习之，不亦说乎」。',
        reference_md: '学习并按时温习它，不也很愉快吗？',
        wrong_answer_md: null,
        page_index: 0,
        bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.4 },
        role: 'prompt',
        visual_complexity: 'low',
        extraction_confidence: 0.9,
        knowledge_hint: null,
      },
    ],
  });

  const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

  async function seedImageCandidateProposal(
    id: string,
    overrides: { source_url?: string; knowledge_ids?: string[] } = {},
  ): Promise<void> {
    const db = testDb();
    const sourceUrl = overrides.source_url ?? 'https://example.edu/wenyan/scan.png';
    await writeAiProposal(db, {
      id,
      actor_ref: 'sourcing',
      outcome: 'partial',
      payload: {
        kind: 'image_candidate',
        target: { subject_kind: 'source_asset', subject_id: null },
        reason_md: '该页题干在图片里，tavily_extract 抽不出文本。',
        evidence_refs: [],
        proposed_change: {
          source_url: sourceUrl,
          source_title: '论语·学而 扫描卷',
          summary_md: '图片型源：题干为扫描图片。',
          // FIX-3 — the sourcing-resolved knowledge node carried for accept attribution.
          ...(overrides.knowledge_ids ? { knowledge_ids: overrides.knowledge_ids } : {}),
        },
        cooldown_key: `image_candidate:${sourceUrl}`,
      },
    });
  }

  function imageCandidateDeps(
    overrides: {
      runTaskFn?: ReturnType<typeof vi.fn>;
      enqueueSourceVerify?: ReturnType<typeof vi.fn>;
      writeCostLedgerFn?: ReturnType<typeof vi.fn>;
      fetchImageBytesFn?: ReturnType<typeof vi.fn>;
      runColdStartBridgeFn?: ReturnType<typeof vi.fn>;
      r2?: { put: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    } = {},
  ) {
    const runTaskFn =
      overrides.runTaskFn ??
      vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({ text: VLM_OUTPUT }));
    // YUK-478 — these legacy fixtures carry NO knowledge_ids, so the accept path would
    // otherwise invoke the cold-start bridge (which would attempt a REAL model call). The
    // default stub THROWS, so the bridge's best-effort catch fires and the question stays
    // an un-attributed 'draft' — preserving the pre-YUK-478 behaviour these tests assert
    // WITHOUT a real LLM call. The dedicated cold-start test below injects a SUCCESS stub.
    const runColdStartBridgeFn =
      overrides.runColdStartBridgeFn ??
      vi.fn(async (_k: string, _i: unknown, _c: unknown) => {
        throw new Error('cold-start bridge not stubbed for this legacy fixture');
      });
    const enqueueSourceVerify = overrides.enqueueSourceVerify ?? vi.fn(async () => {});
    const r2 = overrides.r2 ?? { put: vi.fn(async () => {}), get: vi.fn(async () => null) };
    const fetchImageBytesFn =
      overrides.fetchImageBytesFn ??
      vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png' }));
    // vitest 4 widened `vi.fn()` to `Mock<Procedure | Constructable>` (it now also
    // carries a `new` signature), so a bare mock no longer narrows to the plain
    // function shapes on ImageCandidateAcceptDeps. Cast each seam mock to its
    // interface field type when wiring `deps` — the mocks are structurally valid
    // callables, so this only pins the static type; runtime behavior is unchanged.
    // (The returned top-level mocks stay `Mock` so tests can still assert on them.)
    const deps: ImageCandidateAcceptDeps = {
      runTaskFn: runTaskFn as unknown as ImageCandidateAcceptDeps['runTaskFn'],
      enqueueSourceVerify:
        enqueueSourceVerify as unknown as ImageCandidateAcceptDeps['enqueueSourceVerify'],
      r2: r2 as never,
      fetchImageBytesFn:
        fetchImageBytesFn as unknown as ImageCandidateAcceptDeps['fetchImageBytesFn'],
      runColdStartBridgeFn:
        runColdStartBridgeFn as unknown as ImageCandidateAcceptDeps['runColdStartBridgeFn'],
      ...(overrides.writeCostLedgerFn
        ? {
            writeCostLedgerFn:
              overrides.writeCostLedgerFn as unknown as ImageCandidateAcceptDeps['writeCostLedgerFn'],
          }
        : {}),
    };
    return {
      runTaskFn,
      enqueueSourceVerify,
      r2,
      fetchImageBytesFn,
      runColdStartBridgeFn,
      deps,
    };
  }

  it('cost gate: per accept = exactly one VLM call, no batch/auto path (re-accept does NOT re-spend)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_idem');
    const { deps, runTaskFn } = imageCandidateDeps();

    const first = await acceptAiProposal(db, 'img_cand_idem', { imageCandidateDeps: deps });
    // Second accept is idempotent: no second VLM call, no second question, no second ledger row.
    const second = await acceptAiProposal(db, 'img_cand_idem', { imageCandidateDeps: deps });

    expect(runTaskFn).toHaveBeenCalledTimes(1); // still ONE — re-accept did not re-spend.
    assertProposalLifecycleResult<ImageCandidateAcceptResult>(second, 'image_candidate');
    expect(second.idempotent).toBe(true);
    if (first.kind === 'image_candidate') {
      expect(second.question_id).toBe(first.question_id);
    }

    const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(1);
    const ledger = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'sourcing_image_extract'));
    expect(ledger).toHaveLength(1);
  });

  // FIX-7 — a private/loopback host is rejected before any network call (the AI-written URL
  // is untrusted). We assert via the real defaultFetchImageBytes path.
  it('rejects a private/loopback source_url before fetching (FIX-7 SSRF guard)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_ssrf', {
      source_url: 'http://169.254.169.254/latest/meta-data/',
    });
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_ssrf', {
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      // Never even reached fetch.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(runTaskFn).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects a public hostname when DNS resolves it to a private address (YUK-688)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_dns_ssrf', {
      source_url: 'https://images.example.edu/wenyan/scan.png',
    });
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const lookupFn = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_dns_ssrf', {
          imageCandidateDeps: {
            runTaskFn,
            lookupFn: lookupFn as unknown as ImageCandidateAcceptDeps['lookupFn'],
            r2: { put: vi.fn(), get: vi.fn() } as never,
          },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      expect(lookupFn).toHaveBeenCalledWith('images.example.edu', {
        all: true,
        verbatim: true,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(runTaskFn).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // FIX-5 — a concurrent second accept while the first is in flight is rejected with 409
  // (accept in progress) and does NOT spend a second VLM call. We model concurrency by
  // making the first accept's VLM hang until we have fired the second accept.
  it('blocks a concurrent second accept (409 in progress), no double VLM spend (FIX-5)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_concurrent');

    let releaseFirstVlm: () => void = () => {};
    const firstVlmGate = new Promise<void>((resolve) => {
      releaseFirstVlm = resolve;
    });
    let secondHasStarted: () => void = () => {};
    const secondStartedGate = new Promise<void>((resolve) => {
      secondHasStarted = resolve;
    });

    const firstRunTaskFn = vi.fn(async () => {
      // Signal that the first accept is now mid-VLM, then wait for the test to let it finish.
      secondHasStarted();
      await firstVlmGate;
      return { text: VLM_OUTPUT };
    });
    const secondRunTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));

    const { deps: firstDeps } = imageCandidateDeps({ runTaskFn: firstRunTaskFn });
    const { deps: secondDeps } = imageCandidateDeps({ runTaskFn: secondRunTaskFn });

    const firstPromise = acceptAiProposal(db, 'img_cand_concurrent', {
      imageCandidateDeps: firstDeps,
    });
    // Wait until the first accept has claimed + entered the VLM, then fire the second.
    await secondStartedGate;
    const secondResult = await acceptAiProposal(db, 'img_cand_concurrent', {
      imageCandidateDeps: secondDeps,
    }).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    releaseFirstVlm();
    await firstPromise;

    // The second accept saw the live claim and was rejected; it never spent a VLM call.
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect((secondResult.e as { code?: string }).code).toBe('conflict');
    }
    expect(secondRunTaskFn).not.toHaveBeenCalled();
    expect(firstRunTaskFn).toHaveBeenCalledTimes(1);
    // Exactly one question + one ledger row.
    const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(1);
    const ledger = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'sourcing_image_extract'));
    expect(ledger).toHaveLength(1);
  });

  // FIX-5 — after a failed accept (VLM throws), the claim is cleared so a retry can run
  // (it is NOT permanently wedged "in progress").
  it('allows a retry after a failed accept (claim cleared on failure) (FIX-5)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_retry');

    const failingRunTaskFn = vi.fn(async () => {
      throw new Error('VLM boom');
    });
    const { deps: failDeps } = imageCandidateDeps({ runTaskFn: failingRunTaskFn });
    await expect(
      acceptAiProposal(db, 'img_cand_retry', { imageCandidateDeps: failDeps }),
    ).rejects.toThrow(/VLM boom/);

    // No question was created by the failed attempt.
    let questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(0);

    // Retry with a working VLM — the claim was cleared, so this is NOT a 409.
    const { deps: okDeps, runTaskFn } = imageCandidateDeps();
    const result = await acceptAiProposal(db, 'img_cand_retry', { imageCandidateDeps: okDeps });
    expect(result.kind).toBe('image_candidate');
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(1);
  });

  // FIX-R2-1 — a redirect to a private host must be rejected by re-running the SSRF guard
  // on the redirect target; the VLM is never reached. We exercise the real
  // defaultFetchImageBytes with a manual-redirect fetch stub.
  it('rejects a redirect to a private host before the VLM (FIX-R2-1 redirect SSRF)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_redirect', {
      source_url: 'https://example.edu/wenyan/redirect.png',
    });
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    // First hop = a legal 302 → Location pointing at the cloud metadata endpoint.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_redirect', {
          imageCandidateDeps: {
            runTaskFn,
            lookupFn: publicLookup as unknown as ImageCandidateAcceptDeps['lookupFn'],
            r2: { put: vi.fn(), get: vi.fn() } as never,
          },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      // The first hop fetched, but the redirect target was rejected before a second fetch.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // The VLM never ran — no money burned via the redirect bypass.
      expect(runTaskFn).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // FIX-R2-7 — a normal domain that happens to start with fc/fd/fe (fdic.gov,
  // fcdn.example.com) must NOT be mis-flagged as an IPv6 private host. fdic.gov passes the
  // guard and reaches fetch; an actual IPv6 unique-local literal [fd00::1] is still
  // rejected before any network call.
  it('does not mis-reject fc/fd-prefixed domains; still rejects IPv6 literals (FIX-R2-7)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_fdic', {
      source_url: 'https://fdic.gov/exam/q.png',
    });
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    // A tiny valid image response so the accept proceeds past fetch (we only need to prove
    // the guard let fdic.gov through — fetch WAS called).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    try {
      // Build deps WITHOUT fetchImageBytesFn so the REAL defaultFetchImageBytes (and its
      // SSRF guard) runs against the fetch stub.
      const result = await acceptAiProposal(db, 'img_cand_fdic', {
        imageCandidateDeps: {
          runTaskFn,
          lookupFn: publicLookup as unknown as ImageCandidateAcceptDeps['lookupFn'],
          enqueueSourceVerify: vi.fn(async () => {}),
          r2: { put: vi.fn(async () => {}), get: vi.fn(async () => null) } as never,
        },
      });
      expect(result.kind).toBe('image_candidate');
      // fdic.gov passed the SSRF guard → fetch was actually called.
      expect(fetchSpy).toHaveBeenCalled();
      expect((fetchSpy.mock.calls[0]?.[1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }

    // An IPv6 unique-local literal is still rejected before any network call.
    await seedImageCandidateProposal('img_cand_ipv6', {
      source_url: 'http://[fd00::1]/x.png',
    });
    const ipv6RunTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const ipv6FetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_ipv6', {
          imageCandidateDeps: {
            runTaskFn: ipv6RunTaskFn,
            r2: { put: vi.fn(), get: vi.fn() } as never,
          },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      expect(ipv6FetchSpy).not.toHaveBeenCalled();
      expect(ipv6RunTaskFn).not.toHaveBeenCalled();
    } finally {
      ipv6FetchSpy.mockRestore();
    }
  });

  it('rejects IPv4-mapped IPv6 literals and CGNAT DNS answers before socket connect', async () => {
    const db = testDb();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await seedImageCandidateProposal('img_cand_mapped_ipv6', {
        source_url: 'http://[::ffff:7f00:1]/metadata.png',
      });
      await expect(
        acceptAiProposal(db, 'img_cand_mapped_ipv6', {
          imageCandidateDeps: {
            runTaskFn: vi.fn(async () => ({ text: VLM_OUTPUT })),
            r2: { put: vi.fn(), get: vi.fn() } as never,
          },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });

      await seedImageCandidateProposal('img_cand_nat64_metadata', {
        source_url: 'http://[64:ff9b::a9fe:a9fe]/latest/meta-data.png',
      });
      await expect(
        acceptAiProposal(db, 'img_cand_nat64_metadata', {
          imageCandidateDeps: {
            runTaskFn: vi.fn(async () => ({ text: VLM_OUTPUT })),
            r2: { put: vi.fn(), get: vi.fn() } as never,
          },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });

      await seedImageCandidateProposal('img_cand_cgnat', {
        source_url: 'https://images.example.edu/internal.png',
      });
      const cgnatLookup = vi.fn(async () => [{ address: '100.64.0.1', family: 4 }]);
      await expect(
        acceptAiProposal(db, 'img_cand_cgnat', {
          imageCandidateDeps: {
            runTaskFn: vi.fn(async () => ({ text: VLM_OUTPUT })),
            lookupFn: cgnatLookup as unknown as ImageCandidateAcceptDeps['lookupFn'],
            r2: { put: vi.fn(), get: vi.fn() } as never,
          },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // FIX-R2-3 — the user dismisses the proposal WHILE the accept's VLM is in flight. The
  // terminal tx re-checks the rate event under the lock and aborts with 409, writing NO
  // question and NO accept rate (the dismiss veto is preserved).
  it('aborts (409) when the proposal is dismissed during accept; no question written (FIX-R2-3)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_veto');

    let releaseVlm: () => void = () => {};
    const vlmGate = new Promise<void>((resolve) => {
      releaseVlm = resolve;
    });
    let vlmStarted: () => void = () => {};
    const vlmStartedGate = new Promise<void>((resolve) => {
      vlmStarted = resolve;
    });
    const runTaskFn = vi.fn(async () => {
      vlmStarted();
      await vlmGate;
      return { text: VLM_OUTPUT };
    });
    const { deps } = imageCandidateDeps({ runTaskFn });

    const acceptPromise = acceptAiProposal(db, 'img_cand_veto', { imageCandidateDeps: deps }).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    // Wait until the accept is mid-VLM, then dismiss the proposal (the user's veto lands a
    // non-accept terminal rate event).
    await vlmStartedGate;
    await dismissAiProposal(db, 'img_cand_veto');
    releaseVlm();
    const outcome = await acceptPromise;

    // The accept aborted with 409 — the veto was NOT overwritten.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.e as { code?: string }).code).toBe('conflict');
    }
    // No web_sourced question was written.
    const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(0);
    // The only rate event chained to the proposal is the dismiss (no accept rate).
    const rates = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'img_cand_veto')));
    expect(rates).toHaveLength(1);
    expect((rates[0].payload as { rating?: string }).rating).toBe('dismiss');
  });
});

// YUK-478 — cold-start upload→placement bridges. On a fresh DB the knowledge tree
// carries ONLY subject-root seed nodes (YUK-477). An uploaded question matches no
// node, so the accept path must: ① LLM-classify the subject + create a child KC under
// seed:<subjectId>:root + tag the question with it, ③ LLM-generate the reference answer
// when OCR extracted none, and ② auto-promote draft→active on structural verify so the
// question is immediately placement-selectable. The LLM is MOCKED throughout.
describe('image_candidate cold-start bridges (YUK-478)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // A VLM output whose block has the PROMPT but NO reference answer (reference_md null) —
  // the cold-start OCR-got-the-prompt-not-the-answer case (bridge ③).
  const VLM_OUTPUT_NO_REF = JSON.stringify({
    blocks: [
      {
        extracted_prompt_md:
          '解方程 x^2 - 5x + 6 = 0。先观察常数项与一次项系数的关系，列出和为五、积为六的两个正整数。\n将二次式写成两个一次式的乘积，再分别令两个因式等于零。检验两个根代回原式均成立，不能只写一个根，也不能在移项时改变常数项的符号。',
        reference_md: null,
        wrong_answer_md: null,
        page_index: 0,
        bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.4 },
        role: 'prompt',
        visual_complexity: 'low',
        extraction_confidence: 0.9,
        knowledge_hint: '一元二次方程',
      },
    ],
  });

  async function seedColdStartProposal(id: string): Promise<void> {
    const db = testDb();
    const sourceUrl = 'https://example.edu/math/quadratic.png';
    // No knowledge_ids on the proposed_change — the cold-start (thin-seed) case.
    await writeAiProposal(db, {
      id,
      actor_ref: 'sourcing',
      outcome: 'partial',
      payload: {
        kind: 'image_candidate',
        target: { subject_kind: 'source_asset', subject_id: null },
        reason_md: '该页题干在图片里，tavily_extract 抽不出文本。',
        evidence_refs: [],
        proposed_change: {
          source_url: sourceUrl,
          source_title: '一元二次方程 扫描卷',
          summary_md: '图片型源：题干为扫描图片，无参考答案。',
        },
        cooldown_key: `image_candidate:${sourceUrl}`,
      },
    });
  }

  function coldStartDeps(bridgeReturn: {
    subject_id: string;
    kc_name: string;
    reference_md: string;
    reasoning?: string;
  }) {
    // The cold-start subject-classify bridge stub (resolves the subject root for tagKnowledge).
    const runColdStartBridgeFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: JSON.stringify({ reasoning: '', ...bridgeReturn }),
    }));
    // P3 (YUK-489): tagKnowledge runs under the resolved subject root. Stub it (no embedding
    // model) so it PROPOSEs — mint an approved child KC named kc_name under the subject root and
    // return its id (mirrors the real tagKnowledge propose path).
    const tagKnowledgeFn = vi.fn(
      async (deps: { db: ReturnType<typeof testDb> }, input: { subjectRootId: string }) => {
        const childId = createId();
        const now = new Date();
        await deps.db.insert(knowledge).values({
          id: childId,
          name: bridgeReturn.kc_name,
          domain: null,
          parent_id: input.subjectRootId,
          merged_from: [],
          proposed_by_ai: true,
          approval_status: 'approved',
          created_at: now,
          updated_at: now,
          version: 0,
        } as typeof knowledge.$inferInsert);
        return {
          kind: 'propose' as const,
          knowledge_ids: [childId],
          kc_name: bridgeReturn.kc_name,
        };
      },
    );
    const deps: ImageCandidateAcceptDeps = {
      runTaskFn: vi.fn(async () => ({ text: VLM_OUTPUT_NO_REF })) as never,
      enqueueSourceVerify: vi.fn(async () => {}) as never,
      r2: { put: vi.fn(async () => {}), get: vi.fn(async () => null) } as never,
      fetchImageBytesFn: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: 'image/png',
      })) as never,
      runColdStartBridgeFn: runColdStartBridgeFn as never,
      tagKnowledgeFn: tagKnowledgeFn as unknown as ImageCandidateAcceptDeps['tagKnowledgeFn'],
    };
    return { deps, runColdStartBridgeFn, tagKnowledgeFn };
  }

  it('bridge failure → un-attributed draft (no KC, stays draft, not placement-selectable) — upload is not lost', async () => {
    const db = testDb();
    await seedKnowledge(db);
    await seedColdStartProposal('img_cand_coldstart_fail');
    const deps: ImageCandidateAcceptDeps = {
      runTaskFn: vi.fn(async () => ({ text: VLM_OUTPUT_NO_REF })) as never,
      enqueueSourceVerify: vi.fn(async () => {}) as never,
      r2: { put: vi.fn(async () => {}), get: vi.fn(async () => null) } as never,
      fetchImageBytesFn: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: 'image/png',
      })) as never,
      // Bridge LLM unavailable → the accept path swallows it and persists un-attributed.
      runColdStartBridgeFn: vi.fn(async () => {
        throw new Error('bridge provider down');
      }) as never,
    };

    const result = await acceptAiProposal(db, 'img_cand_coldstart_fail', {
      imageCandidateDeps: deps,
    });
    assertProposalLifecycleResult<ImageCandidateAcceptResult>(result, 'image_candidate');

    // The question persisted (upload not lost) but un-attributed + still a draft.
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    expect(rows[0].knowledge_ids).toEqual([]);
    expect(rows[0].draft_status).toBe('draft');
    // No child KC was created under any subject root.
    const created = await db
      .select()
      .from(knowledge)
      .where(eq(knowledge.parent_id, 'seed:math:root'));
    expect(created).toHaveLength(0);
  });

  it('tagKnowledge provider-attempt invariant aborts image accept instead of persisting un-attributed', async () => {
    const db = testDb();
    await seedKnowledge(db);
    await seedColdStartProposal('img_cand_invariant');
    const { deps: baseDeps } = coldStartDeps({
      subject_id: 'math',
      kc_name: '一元二次方程求根',
      reference_md: 'x = 2 或 x = 3',
    });
    const invariantError = new ProviderAttemptLifecycleError(
      'identity_collision',
      '00000000-0000-4000-8000-000000000043',
    );
    const deps: ImageCandidateAcceptDeps = {
      ...baseDeps,
      tagKnowledgeFn: async () => {
        throw invariantError;
      },
    };

    await expect(
      acceptAiProposal(db, 'img_cand_invariant', { imageCandidateDeps: deps }),
    ).rejects.toBe(invariantError);
  });
});
