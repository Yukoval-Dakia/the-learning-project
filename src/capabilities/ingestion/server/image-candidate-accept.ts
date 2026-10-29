// image_candidate accept fulfillment (ADR-0002).
//
// The only path that turns an image_candidate proposal into a tier-2 question. It runs
// only on explicit user accept and spends exactly one VLM call on one image; the sourcing
// job only writes proposals, so the paid extraction stays user-authorized. An advisory
// lock plus a claim marker makes retries idempotent and blocks concurrent double-spend.
// A failed download/VLM writes an `accept_failed` marker so the user can retry.

import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Agent } from 'undici';

import { aiAgentRef } from '@/ai/task-result';
import {
  type ColdStartBridgeRunTaskFn,
  runColdStartBridge,
} from '@/capabilities/ingestion/server/cold-start-bridge';
import {
  type PinnedFetchResponse,
  fetchWithPinnedDispatcher,
} from '@/capabilities/ingestion/server/pinned-fetch';
import { runVisionExtract } from '@/capabilities/ingestion/server/vision';
import { isTagKnowledgeInvariantError, tagKnowledge } from '@/capabilities/knowledge/public';
import { newId } from '@/core/ids';
// Shared with the client so the literal-host/CIDR rules cannot drift; this module adds
// the throwing wrapper plus DNS-answer and redirect re-validation.
import {
  ipFamily,
  isBlockedHostLiteral,
  isBlockedIpAddress,
  stripIpv6Brackets,
} from '@/core/net/private-host';
import { defaultJudgeKindForQuestion } from '@/core/schema/judge-routing';
import type { ImageCandidateProposalChangeT } from '@/core/schema/proposal';
import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { ai_task_runs, event, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/kernel/proposals/signals';
import { writeCostLedger } from '@/kernel/records/ai-attempt-facts';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { persistImageAsset } from '@/kernel/records/asset-store';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';
import { type R2Client, getR2 } from '@/server/r2';
import { getKnownSubjects } from '@/subjects/profile';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';
import { redactIngestionText } from './privacy-guard';

export interface ImageCandidateAcceptResult {
  kind: 'image_candidate';
  rate_event_id: string;
  source_asset_id: string;
  question_id: string;
  idempotent?: boolean;
}

// Test seams for non-DB side effects, so accept wiring can be asserted without real R2
// or model spend.
export interface ImageCandidateAcceptDeps {
  /**
   * Trusted test/composition seam. A replacement owns the full SSRF invariant (DNS
   * validation, address pinning, redirect checks, byte cap); production leaves it unset.
   */
  fetchImageBytesFn?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** DNS resolver seam. Defaults to node:dns lookup. */
  lookupFn?: LookupFn;
  /** R2 client. Defaults to getR2(). */
  r2?: R2Client;
  /** VisionExtractTask runner. Defaults to the production runner. */
  runTaskFn?: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
  /** Chained source_verify enqueue. */
  enqueueSourceVerify?: (questionIds: string[]) => Promise<void>;
  /** Cost-ledger writer. Defaults to writeCostLedger. */
  writeCostLedgerFn?: typeof writeCostLedger;
  /**
   * Subject-classify seam, used only when the candidate has no knowledge_ids. Defaults to
   * the production runner.
   */
  runColdStartBridgeFn?: ColdStartBridgeRunTaskFn;
  /**
   * Tagging step run when the candidate has no knowledge_ids. Defaults to `tagKnowledge`.
   */
  tagKnowledgeFn?: typeof tagKnowledge;
}

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
// Registered as manual_rescue_only, so reaching it on accept is ADR-0002 compliant.
const IMAGE_EXTRACT_TASK_KIND = 'VisionExtractTask';
// Separate from the text path so per-accept image spend is auditable in isolation.
const COST_LEDGER_TASK_KIND = 'sourcing_image_extract';

// experimental:* events need no schema change. `accept_started` claims an accept;
// `accept_failed` clears the claim after a crash so the user can retry.
const ACCEPT_STARTED_ACTION = 'experimental:image_candidate_accept_started';
const ACCEPT_FAILED_ACTION = 'experimental:image_candidate_accept_failed';
// Must exceed worst-case download + VLM latency so a slow-but-alive accept is not
// reclaimed underneath itself.
const ACCEPT_STALE_MS = 10 * 60 * 1000; // 10 minutes

// AI-written URLs are untrusted even behind the internal-token gate: validate syntax,
// literal hosts, DNS answers, redirects, timeout, size, and MIME before bytes reach R2
// or the VLM.
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

type LookupFn = typeof lookup;

// Learner-safe source-fetch failure contract.
//
// source_url is AI-written, so the raw host / resolved IP / URL must stay in server logs;
// only `details` ({ reason, next_step }) is serialized for UI mapping. Codes and statuses
// are part of the API contract: 400 for non-public destinations, 422 for resolution,
// download, or non-image failures.
export type ImageCandidateSourceFailureReason =
  | 'source_host_nonpublic'
  | 'source_dns_lookup_failed'
  | 'source_dns_no_addresses'
  | 'source_fetch_failed'
  | 'source_not_an_image';

const SOURCE_FAILURE_CONTRACT = {
  source_host_nonpublic: { code: 'validation_error', status: 400 },
  source_dns_lookup_failed: { code: 'extraction_failed', status: 422 },
  source_dns_no_addresses: { code: 'extraction_failed', status: 422 },
  source_fetch_failed: { code: 'extraction_failed', status: 422 },
  source_not_an_image: { code: 'unsupported_media_type', status: 422 },
} as const satisfies Record<ImageCandidateSourceFailureReason, { code: string; status: number }>;

const SOURCE_FAILURE_MESSAGES = {
  source_host_nonpublic:
    '这张图暂时取不到。请换用公开的图片链接，或直接上传图片；现有题目不受影响。',
  source_dns_lookup_failed:
    '这张图暂时取不到（来源网站连不上）。请稍后重试，或直接上传图片；现有题目不受影响。',
  source_dns_no_addresses:
    '这张图暂时取不到（来源网站连不上）。请换用图片链接，或直接上传图片；现有题目不受影响。',
  source_fetch_failed:
    '这张图暂时取不到（来源网站连不上）。请稍后重试，或直接上传图片；现有题目不受影响。',
  // Scanner proposals often point at HTML pages rather than image files.
  source_not_an_image:
    '这个链接没有返回可读取的图片，可能指向了网页。请换用图片链接，或直接上传图片；现有题目不受影响。',
} as const satisfies Record<ImageCandidateSourceFailureReason, string>;

const SOURCE_FAILURE_NEXT_STEP = {
  source_host_nonpublic: 'replace_source_url',
  source_dns_lookup_failed: 'retry_accept',
  source_dns_no_addresses: 'replace_source_url',
  source_fetch_failed: 'retry_accept',
  source_not_an_image: 'replace_source_url',
} as const satisfies Record<
  ImageCandidateSourceFailureReason,
  'retry_accept' | 'replace_source_url'
>;

/**
 * `rawDetail` may contain the host / resolved IP / URL and is logged only, never put into
 * the client-facing ApiError.
 */
function throwSourceFetchFailure(
  reason: ImageCandidateSourceFailureReason,
  rawDetail: string,
): never {
  console.warn(`[image_candidate_accept] source fetch rejected (${reason}):`, rawDetail);
  const contract = SOURCE_FAILURE_CONTRACT[reason];
  throw new ApiError(contract.code, SOURCE_FAILURE_MESSAGES[reason], contract.status, undefined, {
    reason,
    next_step: SOURCE_FAILURE_NEXT_STEP[reason],
  });
}

// Reject URL forms and literal destinations that can never be public image sources;
// hostnames get a second A/AAAA answer check in resolvePublicAddresses.
export function assertPublicHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(
      'validation_error',
      // No raw URL interpolation: the AI-written source_url can embed internal topology.
      // The operator can still see the raw input on the proposal row.
      '这个图片链接无法识别。请换用图片链接，或直接上传图片。',
      400,
    );
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(
      'validation_error',
      '这个图片链接含有登录信息，无法使用。请换用公开的图片链接，或直接上传图片。',
      400,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(
      'validation_error',
      '这个图片链接不支持下载。请换用网页上的图片链接，或直接上传图片。',
      400,
    );
  }
  if (isBlockedHostLiteral(parsed.hostname)) {
    const bareHost = stripIpv6Brackets(parsed.hostname.toLowerCase());
    throwSourceFetchFailure(
      'source_host_nonpublic',
      `blocked literal host ${bareHost} in ${parsed.href}`,
    );
  }
  return parsed;
}

type ResolvedAddress = { address: string; family: 4 | 6 };
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

export async function resolvePublicAddresses(
  parsed: URL,
  lookupFn: LookupFn,
): Promise<ResolvedAddress[]> {
  const bareHost = stripIpv6Brackets(parsed.hostname);
  const literalFamily = ipFamily(bareHost);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isBlockedIpAddress(bareHost)) {
      throwSourceFetchFailure('source_host_nonpublic', `blocked literal IP host ${bareHost}`);
    }
    return [{ address: bareHost, family: literalFamily }];
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await Promise.race([
      lookupFn(bareHost, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS lookup timed out')), DNS_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    // node:dns errors embed the hostname; keep err out of the learner-safe message.
    throwSourceFetchFailure(
      'source_dns_lookup_failed',
      `lookup ${bareHost}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (answers.length === 0) {
    throwSourceFetchFailure('source_dns_no_addresses', `no A/AAAA answers for ${bareHost}`);
  }
  const invalid = answers.find(
    (answer) => (answer.family !== 4 && answer.family !== 6) || isBlockedIpAddress(answer.address),
  );
  if (invalid) {
    // Fake-IP resolvers answering from 198.18.0.0/15 land here; do not allowlist them.
    throwSourceFetchFailure(
      'source_host_nonpublic',
      `${bareHost} answer ${invalid.address} (family ${invalid.family}) is non-public`,
    );
  }
  return answers as ResolvedAddress[];
}

function createPinnedLookup(answers: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = typeof options.family === 'number' ? options.family : 0;
    const candidates = answers.filter(
      (answer) => requestedFamily === 0 || answer.family === requestedFamily,
    );
    if (candidates.length === 0) {
      const err = Object.assign(new Error('no prevalidated address for requested family'), {
        code: 'ENOTFOUND',
      });
      callback(err, '', 0);
      return;
    }
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  };
}

// Redirects are followed manually and re-validated per hop; automatic follow would let a
// URL that passed assertPublicHttpUrl redirect to an internal host. The cap stops loops.
const MAX_REDIRECTS = 3;

async function readBoundedResponseBody(res: PinnedFetchResponse): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new ApiError(
        'payload_too_large',
        // Sizes are safe to show; the source URL is not.
        '这张图超过了 10 MB，暂时无法获取。请压缩后上传，或换一张图片。',
        413,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function defaultFetchImageBytes(
  url: string,
  lookupFn: LookupFn = lookup,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = assertPublicHttpUrl(currentUrl);
    const approvedAddresses = await resolvePublicAddresses(parsed, lookupFn);
    const dispatcher = new Agent({
      connect: {
        lookup: createPinnedLookup(approvedAddresses),
        // Race/fall back across vetted A/AAAA answers without another DNS lookup.
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 250,
      },
    });
    try {
      // Keep the original hostname for Host/TLS SNI while the connector is pinned to
      // the validated answers, closing the DNS-rebinding gap before socket connect.
      const res = await fetchWithPinnedDispatcher(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        dispatcher,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) {
          throwSourceFetchFailure(
            'source_fetch_failed',
            `${res.status} redirect without Location at ${currentUrl}`,
          );
        }
        if (hop === MAX_REDIRECTS) {
          throwSourceFetchFailure(
            'source_fetch_failed',
            `exceeded ${MAX_REDIRECTS} redirects from ${url}`,
          );
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throwSourceFetchFailure('source_fetch_failed', `HTTP ${res.status} for ${url}`);
      }

      const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!mimeType.startsWith('image/')) {
        await res.body?.cancel();
        throwSourceFetchFailure(
          'source_not_an_image',
          `non-image Content-Type '${mimeType || '(none)'}' at ${url}`,
        );
      }
      if (!ALLOWED_IMAGE_MIME.has(mimeType)) {
        await res.body?.cancel();
        throwSourceFetchFailure(
          'source_not_an_image',
          `unsupported image Content-Type '${mimeType}' (supported: ${[...ALLOWED_IMAGE_MIME].join(', ')}) at ${url}`,
        );
      }
      const declaredLength = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
        await res.body?.cancel();
        throw new ApiError(
          'payload_too_large',
          '这张图超过了 10 MB，暂时无法获取。请压缩后上传，或换一张图片。',
          413,
        );
      }
      return { bytes: await readBoundedResponseBody(res), mimeType };
    } catch (err) {
      // Transport failures carry no ApiError and would otherwise surface as a 500; map
      // them onto the typed source_fetch_failed contract. Guard errors pass through.
      if (err instanceof ApiError) throw err;
      throwSourceFetchFailure(
        'source_fetch_failed',
        `transport error at ${currentUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Cleanup must not replace the error that explains the failed accept.
      await dispatcher.close().catch((err) => {
        console.warn('[image_candidate_accept] failed to close pinned dispatcher', err);
      });
    }
  }
  throwSourceFetchFailure('source_fetch_failed', `no terminal response for ${url}`);
}

/**
 * Claims an accept under a transaction-scoped advisory lock on the proposal id.
 * Returns the committed rate for an idempotent retry, claims the accept for a fresh or
 * stale caller, and throws 409 when the proposal has another terminal decision or a
 * live concurrent claim.
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

    // Re-check under the lock so an accept that finished while waiting is visible.
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

    // No rate yet: a claim is live when it is newer than any clearing failure and still
    // inside the stale window.
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
      // A live claim means another accept is in flight; reject to avoid double-spend.
      if (!clearedAfter && !stale) {
        throw new ApiError(
          'conflict',
          `image_candidate accept for ${proposalId} is already in progress`,
          409,
        );
      }
      // Cleared or stale claim: fall through and reclaim.
    }

    // Insert under the lock so two claimers cannot both insert a marker.
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

/** Clears the claim after a failure so the user can retry. Best-effort. */
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
 * Re-derives the result from a committed accept rate. Missing ids mean corrupted state:
 * the rows and the rate commit together, so an empty id must not look like success.
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
 * Accepts an `image_candidate` proposal by materializing one user-authorized VLM
 * extraction as a tier-2 question. The question insert and accept rate commit in one
 * transaction; the claim keeps retries idempotent and blocks concurrent double-spend.
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
  // Idempotent retries re-derive; a live claim or other decision throws 409.
  const claim = await claimAccept(db, proposalId, proposal, claimNow);
  if (claim.decision === 'idempotent') {
    return idempotentResultFromRate(claim.rate, proposalId);
  }

  try {
    const fetchImageBytes =
      deps.fetchImageBytesFn ?? ((sourceUrl) => defaultFetchImageBytes(sourceUrl, deps.lookupFn));
    const r2 = deps.r2 ?? getR2();
    const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
    const writeCostLedgerFn = deps.writeCostLedgerFn ?? writeCostLedger;

    const { bytes, mimeType } = await fetchImageBytes(change.source_url);
    if (bytes.byteLength === 0) {
      throwSourceFetchFailure('source_fetch_failed', `0 bytes from ${change.source_url}`);
    }
    const resolvedMime = ALLOWED_IMAGE_MIME.has(mimeType) ? mimeType : 'image/png';
    const sourceAsset = await persistImageAsset(db, r2, {
      bytes,
      mime: resolvedMime,
      provenance: { image_candidate_source_url: change.source_url },
      compensatePutOnInsertFailure: true,
    });
    const sourceAssetId = sourceAsset.id;
    const now = new Date();

    // One VLM extraction on one image: the paid point of an accept. Pass a real ctx so
    // runTask writes its own ai_task_runs + cost_ledger audit rows.
    let visionTaskRunId: string | null = null;
    // Keep the raw VLM text, not promptMd, so source_verify's n-gram overlap is not the
    // question grounded against itself. It comes from the same single call.
    let visionRawText = '';
    const vision = await runVisionExtract({
      assetId: sourceAssetId,
      mimeType: resolvedMime,
      imageBytes: bytes.buffer as ArrayBuffer,
      pageIndex: 0,
      runTaskFn: async (_kind, input, ctx) => {
        // The production runner has db bound; test seams may ignore the context.
        const realCtx = ctx && typeof ctx === 'object' ? { ...ctx } : {};
        const out = await runTaskFn(IMAGE_EXTRACT_TASK_KIND, input, realCtx);
        // Production results carry task_run_id; capture it so the ledger row links the run.
        const maybeRunId = (out as { task_run_id?: unknown }).task_run_id;
        if (typeof maybeRunId === 'string') visionTaskRunId = maybeRunId;
        if (typeof out.text === 'string') visionRawText = out.text;
        return out;
      },
    });
    const block = vision.blocks[0];
    if (!block) {
      throw new ApiError('extraction_failed', 'VLM returned 0 blocks for image_candidate', 422);
    }

    // The correlation row is zero-cost by design: runTask already wrote the real spend.
    // Duplicating it here would double-count the extraction in every cost aggregate. The
    // real numbers stay recoverable by joining the VisionExtractTask row on task_run_id.
    // provider/model still come from ai_task_runs, or 'unknown' when absent.
    let ledgerProvider = 'unknown';
    let ledgerModel = 'unknown';
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
      }
    } else {
      // Production should always have a run id; log the anomaly. The zero row cannot
      // corrupt cost aggregates.
      console.warn(
        '[image_candidate_accept] no VisionExtractTask task_run_id for accept of',
        proposalId,
        '— correlation ledger row will not link a real run',
      );
    }

    const promptMd = block.extracted_prompt_md;
    // The OCR-extracted answer only; reference generation is out of scope here.
    const referenceMd = block.reference_md ?? '';
    // aiAgentRef only reads task_run_id, but TaskTextResult requires text.
    const result = { text: '', task_run_id: `image_candidate_accept_${proposalId}` };
    // Human-confirmed ids must win; only an empty set falls back to tagging below.
    let knowledgeIds = change.knowledge_ids ?? [];

    // When ids are empty, classify the subject once and reuse the bridge's KC name for
    // tagKnowledge, so match-or-propose gets the right subject root without a second model
    // call. The proposal carries no subject signal. This runs outside the terminal tx:
    // no model call inside a DB transaction.
    if (knowledgeIds.length === 0) {
      try {
        const bridge = await runColdStartBridge({
          db,
          questionMd: promptMd,
          // A non-empty placeholder forces the bridge's ECHO path; its reference is unused.
          existingReferenceMd: '(reference answer not needed for tagging)',
          knowledgeHint: block.knowledge_hint,
          knownSubjects: getKnownSubjects(),
          runTaskFn: deps.runColdStartBridgeFn,
        });
        const subjectRootId = `seed:${bridge.subject_id}:root`;
        const tagKnowledgeFn = deps.tagKnowledgeFn ?? tagKnowledge;
        const tag = await tagKnowledgeFn(
          {
            db,
            providerAttempt: {
              db,
              caller: 'api',
              deadlineAt: new Date(Date.now() + 20_000),
              operationAnchor: proposalId,
            },
            // Reuse the classified name; no second model call. Run provenance rides
            // along for the tag audit event (YUK-1604).
            nameKcFn: async () => ({
              kc_name: bridge.kc_name,
              ...(bridge.task_run_id !== undefined ? { task_run_id: bridge.task_run_id } : {}),
              ...(bridge.cost_usd !== undefined ? { cost_usd: bridge.cost_usd } : {}),
            }),
          },
          {
            // Redact identifiers at the model boundary. This path owns no ingestion
            // session, so its audit events keep session_id null.
            questionText: redactIngestionText(promptMd).text,
            knowledgeHint: block.knowledge_hint
              ? redactIngestionText(block.knowledge_hint).text
              : block.knowledge_hint,
            subjectRootId,
            sourceRef: { kind: 'image_candidate_proposal', id: proposalId },
          },
        );
        // tagKnowledge already committed any PROPOSE KC in its own tx; attribute only.
        knowledgeIds = tag.knowledge_ids;
      } catch (bridgeErr) {
        if (isTagKnowledgeInvariantError(bridgeErr)) throw bridgeErr;
        // Best-effort: a provider outage, unparseable output, or missing seed root must
        // not lose the upload. Persist an un-attributed draft, which the structural gate
        // below keeps out of the active pool.
        console.error(
          '[image_candidate_accept] subject-classify/tagKnowledge failed; persisting un-attributed draft for',
          proposalId,
          bridgeErr,
        );
      }
    }
    // The raw output both keeps the overlap non-identity and carries the reference /
    // confidence context. single_source_grounding makes the limitation explicit so
    // source_verify runs the independent multimodal re-check and can demote the draft.
    const extractRaw = visionRawText.trim().length > 0 ? visionRawText : promptMd;
    const webSourced: WebSourcedProvenanceT = {
      url: change.source_url,
      title: change.source_title,
      fetched_at: now.toISOString(),
      // No profile context at accept time; the verify gate is not relaxed.
      whitelist_match: false,
      extract: extractRaw,
    };
    // Honour a kind constraint carried on the proposal, normalized through the canonical
    // question-kind vocabulary. Unknown or absent kinds fall back to short_answer.
    const requestedKind = change.requested_kind
      ? normalizeToCanonicalKind(change.requested_kind)
      : null;
    const resolvedKind = requestedKind ?? 'short_answer';
    // A single image block has no structured choices, so default to a semantic judge.
    const draftQuestion = {
      kind: resolvedKind,
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
      // The claim does not freeze the inbox: the user may have dismissed or retracted
      // during the VLM call. Re-read under the lock and abort with 409, writing nothing,
      // so a later terminal decision is never overwritten. This is a user decision, not a
      // crash, so the caller does not write an accept_failed marker.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`image_candidate_accept:${proposalId}`}, 0))`,
      );
      const terminalRateRows = await tx
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
        .limit(1);
      const terminalRate = terminalRateRows[0];
      if (terminalRate) {
        const terminalRating = (terminalRate.payload as { rating?: string }).rating;
        throw new ApiError(
          'conflict',
          `image_candidate proposal ${proposalId} was ${terminalRating ?? 'decided'} (dismissed/retracted) during accept; the VLM extraction is discarded`,
          409,
        );
      }

      // KC attribution was resolved pre-tx. A PROPOSE KC committed before this tx can be
      // orphaned by a rollback; that is benign because it stays a valid leaf under the
      // subject root and dedup-on-maintenance reconciles it. The VLM spend is likewise
      // already irreversible.

      // Structural verify → promote to active. A question is sound with a non-empty
      // prompt, a valid kind, and at least one live KC; archived ids keep it draft.
      // FSRS enrollment waits for the first answer, so only draft_status is set here.
      let liveKnowledgeCount = 0;
      if (knowledgeIds.length > 0) {
        const liveKnowledge = await tx
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(inArray(knowledge.id, knowledgeIds), isNull(knowledge.archived_at)));
        liveKnowledgeCount = liveKnowledge.length;
      }
      const structurallyVerified =
        promptMd.trim().length > 0 &&
        Boolean(resolvedKind) &&
        liveKnowledgeCount === knowledgeIds.length &&
        liveKnowledgeCount > 0;
      const draftStatus = structurallyVerified ? 'active' : 'draft';

      await tx.insert(question).values(
        withAnswerClass({
          id: questionId,
          kind: draftQuestion.kind,
          source: 'web_sourced',
          prompt_md: promptMd,
          reference_md: referenceMd || null,
          judge_kind_override: judgeKind,
          // Sourcing-resolved ids or the child KC created just above.
          knowledge_ids: knowledgeIds,
          difficulty: draftQuestion.difficulty,
          // URL source_ref makes deriveSourceTier land at tier 2, as on the text path.
          source_ref: change.source_url,
          // source_verify still runs as the deeper grounding gate; this only removes the
          // inbox wall so the upload is immediately placement-selectable.
          draft_status: draftStatus,
          created_by: aiAgentRef(IMAGE_EXTRACT_TASK_KIND, result),
          metadata: {
            web_sourced: webSourced,
            source_ref_kind: 'url',
            // Evidence trail: which asset + proposal this question came from.
            image_candidate_source_asset_id: sourceAssetId,
            image_candidate_proposal_id: proposalId,
            // Prompt and extract share one VLM call, so the n-gram overlap is weak.
            // source_verify reads this flag and performs the independent image re-check.
            single_source_grounding: true,
          },
          created_at: now,
          updated_at: now,
        }),
      );

      // Mint the first revision in the same transaction. Withheld admission covers
      // questions that are structurally gradable but not yet grounded; source_verify
      // promotes them, and pre-promote active is pool visibility, not scoring admission.
      await publishQuestionGroupFromRow(tx, {
        rootId: questionId,
        actorRef: 'image-candidate-accept:question',
        now,
      });

      // One zero-cost correlation row per accept, queryable in isolation. The real spend
      // lives on the VisionExtractTask row, joined via task_run_id.
      await writeCostLedgerFn(tx, {
        task_run_id: visionTaskRunId ?? result.task_run_id,
        task_kind: COST_LEDGER_TASK_KIND,
        provider: ledgerProvider,
        model: ledgerModel,
        cost: 0,
        tokens_in: 0,
        tokens_out: 0,
      });

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

    // Chain verification; best-effort because the draft is already committed.
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
    // A 409 means the user decided during accept, not a crash: do not clear the claim or
    // the proposal loses its terminal state.
    if (err instanceof ApiError && err.status === 409) {
      throw err;
    }
    // Real failure: release the claim so the next attempt can retry immediately.
    await markAcceptFailed(db, proposalId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function defaultEnqueueSourceVerify(questionIds: string[]): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('source_verify', { question_ids: questionIds });
}
