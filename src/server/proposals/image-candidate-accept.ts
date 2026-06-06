// YUK-227 S3 Slice C (题源扩展 Strategy D / ADR-0002) — image_candidate accept
// fulfillment.
//
// This is the SINGLE place that turns an image-type source into a tier-2 SourcedQuestion
// by spending a VLM extraction. It runs ONLY from acceptAiProposal's dispatch on explicit
// user accept (src/server/proposals/actions.ts). There is NO automatic / backend path
// that reaches here — the SourcingTask handler only WRITES the proposal (守 ADR-0002:
// VLM 抽图是用户授权的付费动作). Per accept = exactly ONE VLM call on exactly ONE image
// (the天然 per-accept upper bound), and every accept writes one cost_ledger row.
//
// Flow (mirrors src/server/ingestion/rescue.ts, the ADR-0002 manual-rescue precedent):
//   1. download the image bytes from the proposal's source_url
//   2. persist them to R2 + a source_asset row (the materialized asset)
//   3. run VisionExtractTask (invocation: manual_rescue_only) on the image
//   4. build a web_sourced draft question from the VLM block + persist it
//   5. writeCostLedger(task_kind='sourcing_image_extract') — evidence-first per-call痕
//   6. enqueue source_verify (the existing tier-2 gate promotes draft→active on pass)
//   7. write the accept rate event chained to the proposal
//
// See docs/superpowers/plans/2026-06-06-yuk227-s3-image-reachability.md §2 Slice C + §4.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import { defaultJudgeKindForQuestion } from '@/core/schema/judge-routing';
import type { ImageCandidateProposalChangeT } from '@/core/schema/proposal';
import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { event, question, source_asset } from '@/db/schema';
import { writeCostLedger } from '@/server/ai/log';
import { aiAgentRef } from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import { runVisionExtract } from '@/server/ingestion/vision';
import { type R2Client, getR2 } from '@/server/r2';
import type { ProposalInboxRow } from './inbox';
import { ensureProposalDecisionSignal, recordProposalDecisionSignal } from './signals';

export interface ImageCandidateAcceptResult {
  kind: 'image_candidate';
  rate_event_id: string;
  source_asset_id: string;
  question_id: string;
  idempotent?: boolean;
}

// Seam set so DB tests can stub the network fetch + the VLM call (the only two
// non-DB side effects) and assert the cost-ledger / source_verify wiring runs WITHOUT
// real R2 / real model spend.
export interface ImageCandidateAcceptDeps {
  /** Download the image bytes for the candidate's source_url. */
  fetchImageBytesFn?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** R2 client for persisting the downloaded asset. Defaults to getR2(). */
  r2?: R2Client;
  /** VisionExtractTask runner seam (defaults to the production runner). */
  runTaskFn?: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
  /** Chained source_verify enqueue (DB tests inject a vi.fn()). */
  enqueueSourceVerify?: (questionIds: string[]) => Promise<void>;
  /** Cost-ledger writer seam (defaults to writeCostLedger). */
  writeCostLedgerFn?: typeof writeCostLedger;
}

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
// The VLM task kind that owns image extraction — invocation: 'manual_rescue_only' in the
// registry (the same付费授权 semantics as rescue.ts), so accept reaching it is ADR-0002
// compliant by construction.
const IMAGE_EXTRACT_TASK_KIND = 'VisionExtractTask';
// cost_ledger task_kind for this付费 point (plan §4). Distinct from the SourcingTask text
// path so per-accept image spend is auditable in isolation.
const COST_LEDGER_TASK_KIND = 'sourcing_image_extract';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function defaultFetchImageBytes(
  url: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new ApiError('extraction_failed', `image fetch failed (${res.status}) for ${url}`, 422);
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, mimeType };
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

/**
 * Accept an `image_candidate` proposal: materialize the source image as a tier-2
 * SourcedQuestion via a single, user-authorized VLM extraction.
 *
 * Atomicity follows the acceptBlockMergeProposal precedent: the heavy work (download +
 * VLM + question INSERT) commits first, then the accept rate event. `existingAcceptRate`
 * makes a retry idempotent — a re-accept after a crash finds the rate event already
 * written and re-derives the result without re-spending the VLM.
 */
export async function acceptImageCandidateProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  deps: ImageCandidateAcceptDeps = {},
): Promise<ImageCandidateAcceptResult> {
  if (proposal.payload.kind !== 'image_candidate') {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} is not an image_candidate proposal (kind=${proposal.payload.kind})`,
      400,
    );
  }
  const change: ImageCandidateProposalChangeT = proposal.payload.proposed_change;

  // Idempotency: an existing accept rate means the VLM already ran; do NOT re-spend.
  // A non-accept prior decision (dismiss/rollback) is a conflict — the caller's
  // status guard normally catches it, but we re-check here so a direct call can't
  // double-spend either.
  const existingRows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
    .limit(1);
  const existingRate = existingRows[0];
  if (existingRate) {
    const rating = (existingRate.payload as { rating?: string }).rating;
    if (rating !== 'accept') {
      throw new ApiError('conflict', `proposal ${proposalId} already decided as ${rating}`, 409);
    }
    await ensureProposalDecisionSignal(db, proposal, 'accept');
    const payload = existingRate.payload as {
      materialized_source_asset_id?: unknown;
      materialized_question_id?: unknown;
    };
    return {
      kind: 'image_candidate',
      rate_event_id: existingRate.id,
      source_asset_id: String(payload.materialized_source_asset_id ?? ''),
      question_id: String(payload.materialized_question_id ?? ''),
      idempotent: true,
    };
  }

  const fetchImageBytes = deps.fetchImageBytesFn ?? defaultFetchImageBytes;
  const r2 = deps.r2 ?? getR2();
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  const writeCostLedgerFn = deps.writeCostLedgerFn ?? writeCostLedger;

  // ── 1+2. download + persist the asset ───────────────────────────────────────
  const { bytes, mimeType } = await fetchImageBytes(change.source_url);
  if (bytes.byteLength === 0) {
    throw new ApiError(
      'extraction_failed',
      `image fetch returned 0 bytes for ${change.source_url}`,
      422,
    );
  }
  const resolvedMime = ALLOWED_IMAGE_MIME.has(mimeType) ? mimeType : 'image/png';
  const sha = await sha256Hex(bytes);
  const storageKey = `assets/${sha}`;
  await r2.put(storageKey, bytes, resolvedMime);

  const sourceAssetId = createId();
  const now = new Date();
  await db.insert(source_asset).values({
    id: sourceAssetId,
    kind: 'image',
    storage_key: storageKey,
    mime_type: resolvedMime,
    byte_size: bytes.byteLength,
    sha256: sha,
    provenance: { image_candidate_source_url: change.source_url },
    created_at: now,
  });

  // ── 3. ONE VLM extraction on ONE image (the per-accept付费 point) ────────────
  const vision = await runVisionExtract({
    assetId: sourceAssetId,
    mimeType: resolvedMime,
    imageBytes: bytes.buffer as ArrayBuffer,
    pageIndex: 0,
    runTaskFn: async (_kind, input, ctx) => runTaskFn(IMAGE_EXTRACT_TASK_KIND, input, ctx),
  });
  const block = vision.blocks[0];
  if (!block) {
    throw new ApiError('extraction_failed', 'VLM returned 0 blocks for image_candidate', 422);
  }

  // ── 4. build a web_sourced draft question from the VLM block ─────────────────
  // The VLM-extracted prompt IS the deterministic-grounding extract: the question text
  // was lifted from this exact image page, so prompt↔extract overlap is total (mirrors
  // the SourcingTask text path where the agent's self-reported extract grounds the URL).
  const promptMd = block.extracted_prompt_md;
  const referenceMd = block.reference_md ?? '';
  // The accept run id correlates the cost_ledger row + the question's created_by.
  // `text` is unused downstream (aiAgentRef only reads task_run_id) but TaskTextResult
  // requires it.
  const result = { text: '', task_run_id: `image_candidate_accept_${proposalId}` };
  const webSourced: WebSourcedProvenanceT = {
    url: change.source_url,
    title: change.source_title,
    fetched_at: now.toISOString(),
    // image_candidate sources have no profile whitelist context at accept time → demoted
    // like every cold-start sourced row (OF-2). The verify gate is NOT relaxed.
    whitelist_match: false,
    extract: promptMd,
  };
  // A VLM-extracted question is short_answer by default with a semantic judge (no
  // structured choices recoverable from a single image block); defaultJudgeKindForQuestion
  // keeps this aligned with the SourcingTask judge-route contract.
  const draftQuestion = {
    kind: 'short_answer' as const,
    prompt_md: promptMd,
    reference_md: referenceMd || null,
    knowledge_ids: [] as string[],
    difficulty: 3,
  };
  const judgeKind = defaultJudgeKindForQuestion({
    ...draftQuestion,
    judge_kind_override: undefined,
    rubric_json: null,
  });

  const questionId = createId();
  const rateEventId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(question).values({
      id: questionId,
      kind: draftQuestion.kind,
      source: 'web_sourced',
      prompt_md: promptMd,
      reference_md: referenceMd || null,
      judge_kind_override: judgeKind,
      knowledge_ids: [],
      difficulty: draftQuestion.difficulty,
      // source_ref = the page URL + source_ref_kind='url' so deriveSourceTier lands tier 2
      // (合约三), identical to the SourcingTask text path.
      source_ref: change.source_url,
      // Option B (R6) — drafts do NOT enter the pool / FSRS until source_verify passes.
      draft_status: 'draft',
      created_by: aiAgentRef(IMAGE_EXTRACT_TASK_KIND, result),
      metadata: {
        web_sourced: webSourced,
        source_ref_kind: 'url',
        // Evidence trail: which asset + proposal this question came from.
        image_candidate_source_asset_id: sourceAssetId,
        image_candidate_proposal_id: proposalId,
      },
      created_at: now,
      updated_at: now,
    });

    // ── 5. cost ledger — one row per accept (one VLM call). ────────────────────
    await writeCostLedgerFn(tx, {
      task_run_id: result.task_run_id,
      task_kind: COST_LEDGER_TASK_KIND,
      provider: 'xiaomi',
      model: 'mimo-v2.5',
      cost: 0,
      tokens_in: 0,
      tokens_out: 0,
    });

    // ── 7. accept rate event chained to the proposal. ──────────────────────────
    await writeEvent(tx, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        rating: 'accept',
        materialized_source_asset_id: sourceAssetId,
        materialized_question_id: questionId,
      },
      caused_by_event_id: proposalId,
      created_at: now,
    });
  });

  await recordProposalDecisionSignal(db, proposal, 'accept');

  // ── 6. chain the verification job (best-effort; the draft is already committed). ──
  const enqueueSourceVerify = deps.enqueueSourceVerify ?? defaultEnqueueSourceVerify;
  try {
    await enqueueSourceVerify([questionId]);
  } catch (enqueueErr) {
    console.error(
      '[image_candidate_accept] source_verify enqueue failed; draft persisted unverified:',
      questionId,
      enqueueErr,
    );
  }

  return {
    kind: 'image_candidate',
    rate_event_id: rateEventId,
    source_asset_id: sourceAssetId,
    question_id: questionId,
  };
}

async function defaultEnqueueSourceVerify(questionIds: string[]): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('source_verify', { question_ids: questionIds });
}
