// M4-T4 (YUK-319) — block_merge + image_candidate proposal lifecycle 测试，从
// dispatch 壳的 actions.test.ts @ src/server/proposals 等价平移（搬迁不改逻辑）。
// 测试继续从公共 API（acceptAiProposal / dismissAiProposal）进入，以覆盖
// 「壳路由 → 包 applier」整条链。

import { seedKnowledge } from '@/capabilities/knowledge/server/seed';
import { selectNextPlacementItem } from '@/capabilities/practice/server/placement-select';
import { deriveSourceTier } from '@/core/schema/provenance';
import {
  ai_task_runs,
  cost_ledger,
  event,
  knowledge,
  proposal_signals,
  question,
  question_block,
  source_asset,
} from '@/db/schema';
import { acceptAiProposal, dismissAiProposal } from '@/server/proposals/actions';
import { writeAiProposal } from '@/server/proposals/writer';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import type { ImageCandidateAcceptDeps } from './image-candidate-accept';

// YUK-202 / BlockAssembly path-B (design 2026-06-02 §4) — accept a block_merge
// proposal end-to-end: it reuses the YUK-195 `mergeQuestions` primitive (the
// merge runs ONLY here, on user accept — §5 no auto-merge), writes the accept
// rate event, is idempotent on a second accept, and goes stale (no rate event)
// when a block left draft before accept.
describe('block_merge proposal lifecycle', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Mirror the YUK-195 fixture: a draft question_block with a structured tree in
  // a given ingestion session (mergeQuestions requires draft + same-session +
  // structured).
  async function seedDraftBlock(opts: {
    sessionId: string;
    nodeId: string;
    promptText: string;
    status?: string;
  }): Promise<string> {
    const db = testDb();
    const blockId = createId();
    const now = new Date();
    await db.insert(question_block).values({
      id: blockId,
      ingestion_session_id: opts.sessionId,
      source_document_id: null,
      source_asset_ids: [],
      page_spans: [],
      structured: { id: opts.nodeId, role: 'standalone', prompt_text: opts.promptText },
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
    });
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
    const primary = await seedDraftBlock({ sessionId, nodeId: 'p', promptText: 'primary' });
    const m1 = await seedDraftBlock({ sessionId, nodeId: 'm1', promptText: 'merge1' });
    const m2 = await seedDraftBlock({ sessionId, nodeId: 'm2', promptText: 'merge2' });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_p1',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1, m2],
    });

    const result = await acceptAiProposal(db, 'block_merge_p1');

    expect(result.kind).toBe('block_merge');
    if (result.kind !== 'block_merge') throw new Error('expected block_merge result');
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
    const primary = await seedDraftBlock({ sessionId, nodeId: 'p', promptText: 'primary' });
    const m1 = await seedDraftBlock({ sessionId, nodeId: 'm1', promptText: 'merge1' });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_dup',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1, m1, primary], // duplicate + the primary itself
    });

    const result = await acceptAiProposal(db, 'block_merge_dup');
    if (result.kind !== 'block_merge') throw new Error('expected block_merge result');
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
    const primary = await seedDraftBlock({ sessionId, nodeId: 'p', promptText: 'primary' });
    const m1 = await seedDraftBlock({ sessionId, nodeId: 'm1', promptText: 'merge1' });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_idem',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    const first = await acceptAiProposal(db, 'block_merge_idem');
    expect(first.kind).toBe('block_merge');
    if (first.kind !== 'block_merge') throw new Error('expected block_merge result');
    expect(first.merged_count).toBe(1);

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
    const primary = await seedDraftBlock({ sessionId, nodeId: 'p', promptText: 'primary' });
    // Pre-merge the merge block out of draft (e.g. already imported) so
    // mergeQuestions soft-rejects with skipped:not_draft.
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      status: 'imported',
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_stale',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    const result = await acceptAiProposal(db, 'block_merge_stale');

    expect(result).toMatchObject({
      kind: 'block_merge',
      primary_block_id: primary,
      stale: true,
      skip_reason: 'skipped:not_draft',
    });
    if (result.kind !== 'block_merge') throw new Error('expected block_merge result');
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

  it('accept downloads the image, persists a source_asset, runs VLM, and materializes a tier-2 SourcedQuestion', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_1');
    const { deps, runTaskFn, enqueueSourceVerify, r2 } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_1', { imageCandidateDeps: deps });

    expect(result.kind).toBe('image_candidate');
    if (result.kind !== 'image_candidate') throw new Error('unreachable');

    // source_asset persisted (the image was downloaded + put to R2).
    expect(r2.put).toHaveBeenCalledTimes(1);
    const assets = await db
      .select()
      .from(source_asset)
      .where(eq(source_asset.id, result.source_asset_id));
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe('image');
    expect(assets[0].mime_type).toBe('image/png');

    // EXACTLY one VLM call (per-accept upper bound = 1 image).
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0][0]).toBe('VisionExtractTask');

    // A tier-2 web_sourced draft question was created from the VLM block.
    const questions = await db.select().from(question).where(eq(question.id, result.question_id));
    expect(questions).toHaveLength(1);
    const q = questions[0];
    expect(q.source).toBe('web_sourced');
    expect(q.draft_status).toBe('draft');
    expect(q.prompt_md).toBe('请翻译「学而时习之，不亦说乎」。');
    expect(q.source_ref).toBe('https://example.edu/wenyan/scan.png');
    const meta = q.metadata as Record<string, unknown>;
    expect(meta.source_ref_kind).toBe('url');
    expect(meta.image_candidate_source_asset_id).toBe(result.source_asset_id);
    const { tier } = deriveSourceTier({ source: q.source, metadata: meta });
    expect(tier).toBe(2);

    // source_verify enqueued for the new draft.
    expect(enqueueSourceVerify).toHaveBeenCalledWith([result.question_id]);

    // accept rate event chained to the proposal.
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'img_cand_1')));
    expect(rateRows).toHaveLength(1);
    expect((rateRows[0].payload as { rating?: string }).rating).toBe('accept');
  });

  it('correlates the sourcing_image_extract row with the real VisionExtractTask run (zero-valued, no double-count)', async () => {
    // FIX-R2-2: the correlation row must串联 the REAL VisionExtractTask run via
    // task_run_id AND carry the real provider/model, but its cost/tokens are ZERO by
    // design — the VisionExtractTask run already wrote a real cost_ledger row, so a
    // non-zero correlation row would double-count the one extraction in SUM(cost). This
    // test uses a production-shaped seam (returns task_run_id like the real runTask)
    // against a seeded ai_task_runs row and asserts: task_run_id串联 + real provider/model
    // + zero cost/tokens.
    const db = testDb();
    await seedImageCandidateProposal('img_cand_runid');
    await db.insert(ai_task_runs).values({
      id: 'vlm_run_real_1',
      task_kind: 'VisionExtractTask',
      provider: 'xiaomi',
      model: 'mimo-vl-prod',
      input_hash: 'hash_fix4',
      status: 'succeeded',
      started_at: new Date(),
      usage_json: { inputTokens: 1234, outputTokens: 567 },
      cost_usd: 0.0123,
    });
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT, task_run_id: 'vlm_run_real_1' }));
    const { deps } = imageCandidateDeps({ runTaskFn });

    await acceptAiProposal(db, 'img_cand_runid', { imageCandidateDeps: deps });

    const rows = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_run_id, 'vlm_run_real_1'));
    const row = rows.find((r) => r.task_kind === 'sourcing_image_extract');
    expect(row).toBeDefined();
    // task_run_id串联s the real VisionExtractTask run (recover real花费 via JOIN).
    expect(row?.task_run_id).toBe('vlm_run_real_1');
    // provider/model are the real run's (self-describing correlation row).
    expect(row?.provider).toBe('xiaomi');
    expect(row?.model).toBe('mimo-vl-prod');
    // FIX-R2-2 — cost/tokens are ZERO so the correlation row never double-counts the
    // extraction the VisionExtractTask row already recorded.
    expect(row?.cost).toBe(0);
    expect(row?.tokens_in).toBe(0);
    expect(row?.tokens_out).toBe(0);
  });

  it('writes exactly one sourcing_image_extract cost_ledger row per accept (cost 留痕)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_cost');
    const { deps } = imageCandidateDeps();

    await acceptAiProposal(db, 'img_cand_cost', { imageCandidateDeps: deps });

    const ledger = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'sourcing_image_extract'));
    expect(ledger).toHaveLength(1);
  });

  it('cost gate: per accept = exactly one VLM call, no batch/auto path (re-accept does NOT re-spend)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_idem');
    const { deps, runTaskFn } = imageCandidateDeps();

    const first = await acceptAiProposal(db, 'img_cand_idem', { imageCandidateDeps: deps });
    // Second accept is idempotent: no second VLM call, no second question, no second ledger row.
    const second = await acceptAiProposal(db, 'img_cand_idem', { imageCandidateDeps: deps });

    expect(runTaskFn).toHaveBeenCalledTimes(1); // still ONE — re-accept did not re-spend.
    if (second.kind !== 'image_candidate') throw new Error('unreachable');
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

  // FIX-3 — the materialized question is attributed to the sourcing-resolved knowledge
  // node carried on the proposal (text-path parity); an empty/absent set → empty attribution.
  it('attributes the materialized question to the proposal knowledge_ids (FIX-3)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_kids', { knowledge_ids: ['k1', 'k2'] });
    const { deps } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_kids', { imageCandidateDeps: deps });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    expect(rows[0].knowledge_ids).toEqual(['k1', 'k2']);
  });

  it('attributes empty knowledge_ids when the proposal carries none (FIX-3 default)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_nokids');
    const { deps } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_nokids', { imageCandidateDeps: deps });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    expect(rows[0].knowledge_ids).toEqual([]);
  });

  // FIX-2 — a non-image Content-Type must be rejected BEFORE the paid VLM flow. We exercise
  // the real defaultFetchImageBytes by stubbing global fetch to return an HTML page.
  it('rejects a non-image Content-Type before spending the VLM (FIX-2)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_html');
    // No fetchImageBytesFn override → the REAL defaultFetchImageBytes runs.
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>not an image</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_html', {
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
        }),
      ).rejects.toMatchObject({ code: 'unsupported_media_type' });
      // The VLM was never called — no money burned on HTML bytes.
      expect(runTaskFn).not.toHaveBeenCalled();
      // FIX-R2-8 — assert ALL of "No question / ledger / rate" the comment claims.
      const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
      expect(questions).toHaveLength(0);
      // No sourcing_image_extract cost_ledger row (the paid flow never started).
      const ledger = await db
        .select()
        .from(cost_ledger)
        .where(eq(cost_ledger.task_kind, 'sourcing_image_extract'));
      expect(ledger).toHaveLength(0);
      // No accept rate event chained to the proposal (the proposal stays pending).
      const acceptRates = await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'img_cand_html')));
      expect(acceptRates).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
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

  // FIX-7 — an oversized body is rejected (Content-Length pre-check) before the paid flow.
  it('rejects an oversized image via Content-Length before the VLM (FIX-7 size cap)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_big');
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(20 * 1024 * 1024), // 20 MB > 10 MB cap
        },
      }),
    );
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_big', {
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
        }),
      ).rejects.toMatchObject({ code: 'payload_too_large' });
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
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
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
          enqueueSourceVerify: vi.fn(async () => {}),
          r2: { put: vi.fn(async () => {}), get: vi.fn(async () => null) } as never,
        },
      });
      expect(result.kind).toBe('image_candidate');
      // fdic.gov passed the SSRF guard → fetch was actually called.
      expect(fetchSpy).toHaveBeenCalled();
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

  // FIX-R2-4 — an image/* MIME outside the supported set (svg/gif/bmp) is rejected with a
  // 422, NOT silently re-tagged as image/png; the paid VLM flow never starts.
  it('rejects an unsupported image MIME (svg) before the VLM (FIX-R2-4)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_svg');
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<svg></svg>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      }),
    );
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_svg', {
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
        }),
      ).rejects.toMatchObject({ code: 'unsupported_media_type' });
      expect(runTaskFn).not.toHaveBeenCalled();
      const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
      expect(questions).toHaveLength(0);
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

  // FIX-R2-5 — a kind-constrained proposal (requested_kind on the proposed_change)
  // materializes a question of that kind, normalized through the question-kind vocabulary.
  it('materializes the requested_kind (choice) when the proposal carries one (FIX-R2-5)', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'img_cand_choice',
      actor_ref: 'sourcing',
      outcome: 'partial',
      payload: {
        kind: 'image_candidate',
        target: { subject_kind: 'source_asset', subject_id: null },
        reason_md: '图片型源',
        evidence_refs: [],
        proposed_change: {
          source_url: 'https://example.edu/wenyan/choice.png',
          source_title: '选择题扫描卷',
          summary_md: '图片型选择题源。',
          // single_choice is a profile/skill key → normalizes to canonical 'choice'.
          requested_kind: 'single_choice',
        },
        cooldown_key: 'image_candidate:https://example.edu/wenyan/choice.png',
      },
    });
    const { deps } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_choice', { imageCandidateDeps: deps });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    expect(rows[0].kind).toBe('choice');
  });

  // FIX-R2-6 — the stored extract is the RAW VLM output (the full block-serialized text),
  // NOT the final promptMd, so source_verify's overlap is not an identity. The question
  // metadata carries single_source_grounding=true to mark the limitation.
  it('stores the raw VLM output as the extract (not promptMd) + marks single_source_grounding (FIX-R2-6)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_extract');
    const { deps } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_extract', { imageCandidateDeps: deps });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    const meta = rows[0].metadata as {
      web_sourced?: { extract?: string };
      single_source_grounding?: boolean;
    };
    const extract = meta.web_sourced?.extract ?? '';
    const promptMd = rows[0].prompt_md;
    // The extract is the raw VLM JSON (contains the block structure), not just the prompt.
    expect(extract).not.toBe(promptMd);
    expect(extract).toBe(VLM_OUTPUT);
    expect(extract).toContain('extracted_prompt_md');
    expect(meta.single_source_grounding).toBe(true);
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
        extracted_prompt_md: '解方程 x^2 - 5x + 6 = 0。',
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
    const runColdStartBridgeFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: JSON.stringify({ reasoning: '', ...bridgeReturn }),
    }));
    const deps: ImageCandidateAcceptDeps = {
      runTaskFn: vi.fn(async () => ({ text: VLM_OUTPUT_NO_REF })) as never,
      enqueueSourceVerify: vi.fn(async () => {}) as never,
      r2: { put: vi.fn(async () => {}), get: vi.fn(async () => null) } as never,
      fetchImageBytesFn: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: 'image/png',
      })) as never,
      runColdStartBridgeFn: runColdStartBridgeFn as never,
    };
    return { deps, runColdStartBridgeFn };
  }

  it('no-KC-match upload → child KC under subject root + tag + generated reference_md + draft→active + placement-selectable', async () => {
    const db = testDb();
    // Thin seed: only subject-root nodes (seed:<subjectId>:root) exist.
    await seedKnowledge(db);
    await seedColdStartProposal('img_cand_coldstart');

    const { deps, runColdStartBridgeFn } = coldStartDeps({
      subject_id: 'math',
      kc_name: '一元二次方程求根',
      reference_md: 'x = 2 或 x = 3',
    });

    const result = await acceptAiProposal(db, 'img_cand_coldstart', { imageCandidateDeps: deps });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');

    // The bridge ran exactly once (one combined classify+answer LLM pass).
    expect(runColdStartBridgeFn).toHaveBeenCalledTimes(1);

    // ① a child KC was created under the math subject root and the question tagged with it.
    const rootId = 'seed:math:root';
    const children = await db.select().from(knowledge).where(eq(knowledge.parent_id, rootId));
    expect(children).toHaveLength(1);
    const childKc = children[0];
    expect(childKc.name).toBe('一元二次方程求根');
    expect(childKc.approval_status).toBe('approved');
    // domain:null → inherits the subject (math) via the parent chain (effective-domain).
    expect(childKc.domain).toBeNull();

    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    const q = rows[0];
    expect(q.knowledge_ids).toEqual([childKc.id]);

    // ③ the generated reference answer populated reference_md (OCR had none).
    expect(q.reference_md).toBe('x = 2 或 x = 3');

    // ② structural verify (prompt + kind + ≥1 live KC) auto-promoted draft→active.
    expect(q.draft_status).toBe('active');

    // The question is now selectable by placement against the new KC's subgraph.
    const pick = await selectNextPlacementItem(db, { knowledgeIds: [childKc.id] });
    expect(pick).not.toBeNull();
    expect(pick?.questionId).toBe(result.question_id);
  });

  it('echoes the OCR-extracted reference answer (does not regenerate) when one was present', async () => {
    const db = testDb();
    await seedKnowledge(db);
    // A VLM output that DID extract a reference answer.
    const withRef = JSON.stringify({
      blocks: [
        {
          extracted_prompt_md: '解方程 x^2 - 5x + 6 = 0。',
          reference_md: 'x = 2 or x = 3 (OCR original)',
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
    await seedColdStartProposal('img_cand_coldstart_withref');
    // The bridge still classifies the subject (no KC match), but echoes the existing answer.
    const { deps } = coldStartDeps({
      subject_id: 'math',
      kc_name: '一元二次方程求根',
      reference_md: 'x = 2 or x = 3 (OCR original)',
    });
    (deps.runTaskFn as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      text: withRef,
    }));

    const result = await acceptAiProposal(db, 'img_cand_coldstart_withref', {
      imageCandidateDeps: deps,
    });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    // The OCR-extracted reference answer is preserved (the cold-start bridge must not
    // overwrite a real OCR answer with a regenerated one).
    expect(rows[0].reference_md).toBe('x = 2 or x = 3 (OCR original)');
    expect(rows[0].draft_status).toBe('active');
  });

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
    if (result.kind !== 'image_candidate') throw new Error('unreachable');

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
});
