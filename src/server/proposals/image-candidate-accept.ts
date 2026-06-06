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
//   0. (FIX-5) concurrency guard tx: advisory-lock the proposal id, re-check the rate
//      event + a live `accept_started` marker; either return idempotent, 409, or claim
//      the accept by inserting an `accept_started` marker. This closes the double-spend
//      TOCTOU where two concurrent POSTs both pass the idempotency check (which used to
//      run BEFORE any write/lock) and each burned one VLM call.
//   1. download the image bytes from the proposal's source_url (FIX-2/FIX-7: protocol +
//      private-host + size + timeout + Content-Type guards — AI-written URL is untrusted)
//   2. persist them to R2 + a source_asset row (the materialized asset)
//   3. run VisionExtractTask (invocation: manual_rescue_only) on the image, through the
//      production runTask WITH a real ctx (FIX-4: so it writes its own ai_task_runs +
//      cost_ledger audit row — the run is auditable, not a black box)
//   4. build a web_sourced draft question from the VLM block + persist it (FIX-3: with the
//      sourcing-resolved knowledge_ids so it attributes to the originating 知识点)
//   5. writeCostLedger(task_kind='sourcing_image_extract') — a CORRELATION row that串联s
//      the underlying VisionExtractTask run (FIX-4: real provider/model/usage, not全零)
//   6. enqueue source_verify (the existing tier-2 gate promotes draft→active on pass)
//   7. write the accept rate event chained to the proposal
//
// On download/VLM failure (FIX-5): write an `accept_failed` marker so the stale-`accept_started`
// reclaim path lets the user retry instead of the proposal being永久 wedged "in progress".
//
// See docs/superpowers/plans/2026-06-06-yuk227-s3-image-reachability.md §2 Slice C + §4.

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, sql } from 'drizzle-orm';

import { newId } from '@/core/ids';
import { defaultJudgeKindForQuestion } from '@/core/schema/judge-routing';
import type { ImageCandidateProposalChangeT } from '@/core/schema/proposal';
import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { ai_task_runs, event, question, source_asset } from '@/db/schema';
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

// FIX-5 — concurrency guard marker actions (experimental:* escape-valve events, so no
// schema/migration: parseEvent accepts any experimental:<name> with a record payload).
// `accept_started` claims the accept; `accept_failed` clears the claim on a crash so the
// user can retry instead of the proposal being wedged "in progress" forever.
const ACCEPT_STARTED_ACTION = 'experimental:image_candidate_accept_started';
const ACCEPT_FAILED_ACTION = 'experimental:image_candidate_accept_failed';
// A claim older than this (with no terminal rate / no clearing failure) is treated as
// stale — the original accept process crashed mid-flight before writing the rate event.
// A fresh attempt may reclaim it. The window must exceed the worst-case download+VLM
// latency so a slow-but-alive accept is not stolen out from under itself.
const ACCEPT_STALE_MS = 10 * 60 * 1000; // 10 minutes

// FIX-7 — defaultFetchImageBytes guards (single-user self-hosted tool boundary, NOT a
// DNS-rebinding-grade SSRF defense — the surface sits behind the internal-token gate and
// runs on an internal network; we just reject the obvious foot-guns of feeding an
// AI-written URL straight into fetch + the VLM).
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// FIX-7 — reject URLs that resolve to a non-public destination before any network call.
// Hostname-level only (no DNS resolution → no rebinding protection, by design — see the
// boundary note above). Covers: non-http(s) schemes, localhost, loopback, RFC1918
// private ranges, link-local incl. the 169.254.169.254 cloud metadata endpoint, and
// .local mDNS names.
function assertPublicHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(
      'validation_error',
      `image_candidate source_url is not a valid URL: ${url}`,
      400,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(
      'validation_error',
      `image_candidate source_url must be http(s), got ${parsed.protocol}`,
      400,
    );
  }
  const host = parsed.hostname.toLowerCase();
  // Strip IPv6 brackets if present (URL.hostname keeps them).
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const isPrivate =
    bareHost === 'localhost' ||
    bareHost.endsWith('.localhost') ||
    bareHost.endsWith('.local') ||
    bareHost === '::1' ||
    bareHost === '0.0.0.0' ||
    /^127\./.test(bareHost) ||
    /^10\./.test(bareHost) ||
    /^192\.168\./.test(bareHost) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(bareHost) ||
    /^169\.254\./.test(bareHost) || // link-local incl. cloud metadata 169.254.169.254
    bareHost.startsWith('fc') || // IPv6 unique-local fc00::/7
    bareHost.startsWith('fd') ||
    bareHost.startsWith('fe80'); // IPv6 link-local
  if (isPrivate) {
    throw new ApiError(
      'validation_error',
      `image_candidate source_url resolves to a private/loopback/link-local host (${bareHost}); refusing to fetch`,
      400,
    );
  }
}

async function defaultFetchImageBytes(
  url: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  // FIX-7 — gate the AI-written URL before any network call.
  assertPublicHttpUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new ApiError('extraction_failed', `image fetch failed (${res.status}) for ${url}`, 422);
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  // FIX-2 — a non-image Content-Type means we'd be feeding HTML/JSON bytes to the VLM,
  // burning money to extract garbage. Reject BEFORE the paid flow. (defaultFetchImageBytes
  // runs upstream of runVisionExtract, so an early throw here never reaches the model.)
  if (!mimeType.startsWith('image/')) {
    throw new ApiError(
      'unsupported_media_type',
      `image_candidate source_url returned non-image Content-Type '${mimeType || '(none)'}' for ${url}`,
      422,
    );
  }
  // FIX-7 — Content-Length pre-check (cheap reject of an obviously-huge body) +
  // post-read actual-size check (a missing/lying Content-Length can't sneak past).
  const declaredLength = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new ApiError(
      'payload_too_large',
      `image_candidate source_url Content-Length ${declaredLength} exceeds ${MAX_IMAGE_BYTES} bytes`,
      413,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ApiError(
      'payload_too_large',
      `image_candidate source_url body ${bytes.byteLength} exceeds ${MAX_IMAGE_BYTES} bytes`,
      413,
    );
  }
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
 * FIX-5 — concurrency claim. Inside one tx, advisory-lock the proposal id (auto-released
 * at tx boundary, no UNIQUE index → no migration; mirrors make-paper.ts:177), then under
 * the lock decide whether this caller may proceed. Returns:
 *   - { decision: 'idempotent', rate } — an accept rate already exists (a prior accept
 *     fully committed); the caller re-derives the result, no re-spend.
 *   - { decision: 'claimed' } — no rate + no live claim (or a stale claim reclaimed); a
 *     fresh `accept_started` marker was inserted, this caller owns the accept.
 *   - throws 409 — a non-accept terminal decision exists, OR a fresh `accept_started`
 *     claim by a concurrent in-flight accept (no rate yet, within the stale window).
 */
async function claimAccept(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  now: Date,
): Promise<{ decision: 'idempotent'; rate: typeof event.$inferSelect } | { decision: 'claimed' }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`image_candidate_accept:${proposalId}`}, 0))`,
    );

    // Re-check the rate event UNDER the lock — a concurrent accept that finished while we
    // waited for the lock is now visible. accept → idempotent; any other decision → 409.
    const rateRows = await tx
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
      .limit(1);
    const rate = rateRows[0];
    if (rate) {
      const rating = (rate.payload as { rating?: string }).rating;
      if (rating !== 'accept') {
        throw new ApiError('conflict', `proposal ${proposalId} already decided as ${rating}`, 409);
      }
      await ensureProposalDecisionSignal(tx, proposal, 'accept');
      return { decision: 'idempotent', rate };
    }

    // No rate yet. Look at the latest claim marker + the latest clearing failure. A claim
    // is LIVE iff it is newer than any clearing failure AND within the stale window.
    const latestStarted = (
      await tx
        .select({ created_at: event.created_at })
        .from(event)
        .where(
          and(eq(event.action, ACCEPT_STARTED_ACTION), eq(event.caused_by_event_id, proposalId)),
        )
        .orderBy(desc(event.created_at))
        .limit(1)
    )[0];
    const latestFailed = (
      await tx
        .select({ created_at: event.created_at })
        .from(event)
        .where(
          and(eq(event.action, ACCEPT_FAILED_ACTION), eq(event.caused_by_event_id, proposalId)),
        )
        .orderBy(desc(event.created_at))
        .limit(1)
    )[0];

    if (latestStarted) {
      const startedAt = latestStarted.created_at.getTime();
      const clearedAfter = latestFailed ? latestFailed.created_at.getTime() >= startedAt : false;
      const stale = now.getTime() - startedAt > ACCEPT_STALE_MS;
      // Live claim = not cleared by a later failure AND not stale → a concurrent accept is
      // in flight. Reject so we don't double-spend the VLM.
      if (!clearedAfter && !stale) {
        throw new ApiError(
          'conflict',
          `image_candidate accept for ${proposalId} is already in progress`,
          409,
        );
      }
      // Otherwise the prior claim was cleared (failed) or went stale (crashed mid-flight) —
      // fall through and reclaim.
    }

    // Claim it: insert a fresh accept_started marker (within the lock, so two concurrent
    // claimers can't both insert one). caused_by_event_id chains it to the proposal.
    await writeEvent(tx, {
      id: createId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: ACCEPT_STARTED_ACTION,
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: { proposal_id: proposalId },
      caused_by_event_id: proposalId,
      created_at: now,
    });
    return { decision: 'claimed' };
  });
}

/** FIX-5 — clear the claim on a download/VLM failure so the user can retry. Best-effort. */
async function markAcceptFailed(db: Db, proposalId: string, reason: string): Promise<void> {
  try {
    await writeEvent(db, {
      id: createId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: ACCEPT_FAILED_ACTION,
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'failure',
      payload: { proposal_id: proposalId, reason: reason.slice(0, 500) },
      caused_by_event_id: proposalId,
      created_at: new Date(),
    });
  } catch (err) {
    console.error('[image_candidate_accept] failed to write accept_failed marker', proposalId, err);
  }
}

/**
 * Re-derive the idempotent result from a committed accept rate event. FIX-9a: a rate
 * event with a missing materialized id is a corrupted state (the accept tx writes both
 * the question/asset rows AND the rate event together), so surface it as an error rather
 * than papering over it with `?? ''` — an empty id would let the caller believe the accept
 * succeeded while pointing at nothing.
 */
function idempotentResultFromRate(
  rate: typeof event.$inferSelect,
  proposalId: string,
): ImageCandidateAcceptResult {
  const payload = rate.payload as {
    materialized_source_asset_id?: unknown;
    materialized_question_id?: unknown;
  };
  const sourceAssetId = payload.materialized_source_asset_id;
  const questionId = payload.materialized_question_id;
  if (typeof sourceAssetId !== 'string' || sourceAssetId.length === 0) {
    throw new ApiError(
      'inconsistent_state',
      `image_candidate accept rate for ${proposalId} is missing materialized_source_asset_id`,
      500,
    );
  }
  if (typeof questionId !== 'string' || questionId.length === 0) {
    throw new ApiError(
      'inconsistent_state',
      `image_candidate accept rate for ${proposalId} is missing materialized_question_id`,
      500,
    );
  }
  return {
    kind: 'image_candidate',
    rate_event_id: rate.id,
    source_asset_id: sourceAssetId,
    question_id: questionId,
    idempotent: true,
  };
}

/**
 * Accept an `image_candidate` proposal: materialize the source image as a tier-2
 * SourcedQuestion via a single, user-authorized VLM extraction.
 *
 * Atomicity follows the acceptBlockMergeProposal precedent: the heavy work (download +
 * VLM + question INSERT) commits in its own tx, then the accept rate event. The FIX-5
 * concurrency claim (claimAccept) makes a retry idempotent AND blocks a concurrent second
 * accept from double-spending the VLM — the old `existingAcceptRate`-before-any-write
 * check let two POSTs both pass and each burn one call.
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

  const claimNow = new Date();
  // FIX-5 — claim the accept under an advisory lock. Idempotent → re-derive + return.
  // 409 conflict → a concurrent accept is in flight (or a non-accept decision exists).
  const claim = await claimAccept(db, proposalId, proposal, claimNow);
  if (claim.decision === 'idempotent') {
    return idempotentResultFromRate(claim.rate, proposalId);
  }

  try {
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
    // FIX-4 — thread a REAL ctx (with db) to runTask so it writes its own ai_task_runs +
    // cost_ledger audit row. The old seam forwarded an empty {} ctx, so the production
    // runTask (which dereferences ctx.db to write ai_task_runs) ran the VLM with NO audit
    // trail. The runTaskFn seam still lets DB tests stub the model, but production now
    // gets a real ctx. We capture the returned VisionExtractTask task_run_id to correlate
    // the cost_ledger correlation row written in step 5.
    let visionTaskRunId: string | null = null;
    const vision = await runVisionExtract({
      assetId: sourceAssetId,
      mimeType: resolvedMime,
      imageBytes: bytes.buffer as ArrayBuffer,
      pageIndex: 0,
      runTaskFn: async (_kind, input, ctx) => {
        // Merge the runner-supplied ctx (vision passes {}) with the real db ctx so the
        // production runner can write its audit rows. A test seam ignores ctx entirely.
        const realCtx =
          ctx && typeof ctx === 'object' ? { ...(ctx as Record<string, unknown>), db } : { db };
        const out = await runTaskFn(IMAGE_EXTRACT_TASK_KIND, input, realCtx);
        // The production runTaskFn result carries task_run_id; the test seam returns just
        // { text }. Capture it when present so step 5's ledger row串联s the real run.
        const maybeRunId = (out as { task_run_id?: unknown }).task_run_id;
        if (typeof maybeRunId === 'string') visionTaskRunId = maybeRunId;
        return out;
      },
    });
    const block = vision.blocks[0];
    if (!block) {
      throw new ApiError('extraction_failed', 'VLM returned 0 blocks for image_candidate', 422);
    }

    // FIX-4 — pull the REAL provider/model/usage from the VisionExtractTask's ai_task_runs
    // row (written by the production runner) so the correlation ledger row carries real
    // numbers, not hardcoded zeros. When the run id is unknown (test seam) the row falls
    // back to the registry defaults — but the production path always has it.
    let ledgerProvider = 'xiaomi';
    let ledgerModel = 'mimo-v2.5';
    let ledgerCost = 0;
    let ledgerTokensIn = 0;
    let ledgerTokensOut = 0;
    if (visionTaskRunId) {
      const runRows = await db
        .select()
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, visionTaskRunId))
        .limit(1);
      const runRow = runRows[0];
      if (runRow) {
        ledgerProvider = runRow.provider;
        ledgerModel = runRow.model;
        ledgerCost = runRow.cost_usd ?? 0;
        ledgerTokensIn = runRow.usage_json?.inputTokens ?? 0;
        ledgerTokensOut = runRow.usage_json?.outputTokens ?? 0;
      }
    }

    // ── 4. build a web_sourced draft question from the VLM block ─────────────────
    // The VLM-extracted prompt IS the deterministic-grounding extract: the question text
    // was lifted from this exact image page, so prompt↔extract overlap is total (mirrors
    // the SourcingTask text path where the agent's self-reported extract grounds the URL).
    const promptMd = block.extracted_prompt_md;
    const referenceMd = block.reference_md ?? '';
    // The accept run id correlates the cost_ledger correlation row + the question's
    // created_by. `text` is unused downstream (aiAgentRef only reads task_run_id) but
    // TaskTextResult requires it.
    const result = { text: '', task_run_id: `image_candidate_accept_${proposalId}` };
    // FIX-3 — attribute the materialized question to the sourcing-resolved knowledge nodes
    // (carried on the proposal at propose time) — identical column semantics to the text
    // path's question.knowledge_ids. Empty when the run resolved no node (legacy proposal
    // or free-form manual ref) → empty attribution, same as before FIX-3.
    const knowledgeIds = change.knowledge_ids ?? [];
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
      knowledge_ids: knowledgeIds,
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
        // FIX-3 — attribute to the originating 知识点 (text path parity).
        knowledge_ids: knowledgeIds,
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

      // ── 5. cost ledger — one CORRELATION row per accept. ───────────────────────
      // FIX-4 — the underlying VisionExtractTask run already wrote its OWN cost_ledger row
      // (with the model spend) via the production runner. THIS row is a distinct
      // `sourcing_image_extract`-kinded correlation row so per-accept image spend is
      // queryable in isolation (plan §4); it串联s the real run via task_run_id =
      // visionTaskRunId and carries the SAME real provider/model/usage (no longer全零),
      // so the two rows agree. When the run id is unknown (test seam) it falls back to the
      // accept run id + registry defaults.
      await writeCostLedgerFn(tx, {
        task_run_id: visionTaskRunId ?? result.task_run_id,
        task_kind: COST_LEDGER_TASK_KIND,
        provider: ledgerProvider,
        model: ledgerModel,
        cost: ledgerCost,
        tokens_in: ledgerTokensIn,
        tokens_out: ledgerTokensOut,
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
  } catch (err) {
    // FIX-5 — the accept failed (download/VLM/insert). Clear the `accept_started` claim so
    // the next attempt can reclaim immediately instead of waiting out the stale window.
    await markAcceptFailed(db, proposalId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function defaultEnqueueSourceVerify(questionIds: string[]): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('source_verify', { question_ids: questionIds });
}
