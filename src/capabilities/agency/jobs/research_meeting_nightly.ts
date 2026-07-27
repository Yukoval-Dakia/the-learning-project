// YUK-406 Phase 0 (关系脑 thin slice) / YUK-440 (A13) — nightly 教研例会
// (research-meeting) propose handler.
//
// Structurally a clone of goal_scope_propose_nightly.ts: a thin candidate-picker +
// dedup gate + a bounded parallel producer batch (NOT an MCP tool-agent loop). The job is
// the SINGLE proposer of conjectures. It does NOT use a DomainTool / MCP server —
// it calls induceConjecture (the Opus self-consistency orchestrator) + writeAiProposal
// directly, exactly like goal_scope calls runGoalScopeAndWrite. Cloning dreaming_nightly
// (an MCP agent loop) would be wrong: that loop's cost-cap only triggers on tool-calls,
// and this deterministic flow never calls MCP tools (a13-design critic #1).
//
// Per run:
//   1. (PRE-LLM, retryable) read recent failures (with their YUK-562 reasoning
//      traces) + per-KC mastery projection + the set of cause×KC keys that
//      already have a PENDING conjecture (dedup);
//   2. deterministic 取证 (gatherConjectureEvidence) → salience-sorted cells;
//   3. (PRE-LLM, retryable) GROUND cells in salience-order batches until K usable
//      cells are found or candidates are exhausted (enrichEvidenceCells, YUK-786):
//      KC name + subject identity + the first-hand attempt evidence (question,
//      the owner's wrong answer, their reasoning trace, the attribution). Without
//      this the LLM sees 7 opaque scalars and can only invent the domain;
//   4. for each grounded top-K cell: induceConjecture (Opus N=3 self-consistency on the anthropic-sub
//      OAuth lane) → one ConjectureDraft + A13 fields → writeAiProposal (propose-only).
//
// Failure asymmetry (D7 / F-1): shared PRE-LLM reads run OUTSIDE the per-cell swallow —
// a throw there is a legit retryable DB fault that propagates to the builder's
// rethrow so pg-boss retries. Candidate-local grounding/image failures refill from
// lower salience; the per-cell LLM half is swallow-safe (one cell's failure logs a
// retryable AI ledger row and continues; partial progress is fine).
//
// ND-5: this job NEVER writes FSRS state. The conjecture is propose-only — the owner
// accepts/edits/rejects in the inbox; scoring + label flips are DEFERRED (PR-2 /
// ADR-0046). The proposal only SNAPSHOTS predicted_p (the claim's bet) +
// baseline_p_at_induction (the number to beat); it does not move any number.

import { type WriteEventInput, writeEvent } from '@/kernel/events';
import type { Job } from 'pg-boss';

import {
  CONJECTURE_RECURRENCE_FLOOR,
  collectConjectureEvidenceAssetRefs,
  conjectureKey,
  gatherConjectureEvidence,
} from '@/capabilities/agency/server/conjecture/evidence';
import type {
  ConjectureEvidenceAssetRef,
  EnrichedEvidenceCell,
  LoadedConjectureEvidenceImage,
} from '@/capabilities/agency/server/conjecture/evidence';
import { enrichEvidenceCells } from '@/capabilities/agency/server/conjecture/evidence-enrichment';
import { writeRetryableAiFailureLedger } from '@/capabilities/knowledge/server/ai_failure_log';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { defaultImageFetch } from '@/server/ai/judges/steps-judge';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { type FailureAttempt, getFailureAttemptsWithReasoningTrace } from '@/server/events/queries';
import { getMasteryProjection } from '@/server/mastery/state';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { type WriteAiProposalInput, writeAiProposal } from '@/server/proposals/writer';
import { resolveSubjectProfile } from '@/subjects/profile';
import { inArray } from 'drizzle-orm';

import { type InduceConjectureResult, induceConjecture } from '@/server/agency/conjecture/induce';
import {
  type ReconcileResult,
  reconcileConjecturePredictions,
} from '@/server/conjectures/reconcile';

/** Structural per-run propose cap (top-K salient cells → at most K conjectures). */
export const RESEARCH_MEETING_MAX_CONJECTURES = 3;
/** N self-consistency samples per conjecture (D2 — Opus agreement tally). */
export const RESEARCH_MEETING_SAMPLES = 3;
/** Fail closed instead of silently dropping pixels from unusually image-heavy evidence. */
export const RESEARCH_MEETING_MAX_IMAGES_PER_CELL = 60;
/** Raw bytes across all image occurrences in one cell, checked before any R2 read/base64. */
export const RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL = 24 * 1024 * 1024;
/** Decoded-pixel guard for metadata that carries dimensions. */
export const RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL = 40_000_000;
/** Recency window for the failure scan. */
export const RESEARCH_MEETING_WINDOW_DAYS = 14;
/** actor_ref stamped on the trigger / scan events + each conjecture proposal. */
export const RESEARCH_MEETING_ACTOR = 'research_meeting';

export interface ResearchMeetingResult {
  /** top-K cells inducted this run (== conjectures attempted). */
  considered: number;
  /** conjectures actually proposed (a cell whose induction failed is dropped). */
  conjectures_created: number;
  /**
   * YUK-779 — cells whose induction/write THREW and was swallowed by the per-cell
   * catch below. Invariant: `cells_failed + conjectures_created === considered`.
   *
   * Before this counter existed the swallow was visible only as
   * `considered > conjectures_created`, which the job never asserted on — under a
   * 限流风暴 every cell failed, the job returned `conjectures_created: 0` and still
   * finished `succeeded`, so the DAG node went green and hard downstream ran on
   * stale data.
   */
  cells_failed: number;
  /** pending conjectures already open at run start (the dedup base). */
  pending_before: number;
  /** prior probe outcomes scored + ledger-updated this run (U8 reconcile, A13). */
  reconciled: number;
  /** probe outcomes skipped this run (dangling / malformed / unreadable conjecture ref). */
  reconcile_skipped: number;
  /** total Opus cost across the run's inductions, USD. */
  cost_usd: number;
  /**
   * the run's anchor event id (provenance + scan subject). `''` sentinel when the
   * run early-returned on an empty night (zero top cells → no anchor event written).
   */
  trigger_event_id: string;
}

type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;
type WriteAiProposalFn = (db: Db, input: WriteAiProposalInput) => Promise<string>;
type InduceConjectureFn = typeof induceConjecture;
type GetFailureAttemptsWithTraceFn = typeof getFailureAttemptsWithReasoningTrace;
type GetMasteryProjectionFn = typeof getMasteryProjection;
type EnrichEvidenceCellsFn = typeof enrichEvidenceCells;
type WriteRetryableAiFailureLedgerFn = (db: Db, taskKind: string) => Promise<void>;
type ResolveSubjectProfileFn = typeof resolveSubjectProfile;
type LoadEvidenceImagesFn = (
  db: Db,
  refs: readonly ConjectureEvidenceAssetRef[],
) => Promise<LoadedConjectureEvidenceImage[]>;

interface PreparedConjectureCell {
  cell: EnrichedEvidenceCell;
  evidenceImages: LoadedConjectureEvidenceImage[];
}

export interface ResearchMeetingDeps {
  now?: () => Date;
  /**
   * YUK-786: the trace-bearing LIST reader. The bare `FailureAttempt` projection
   * is unchanged — the YUK-562 reasoning_trace rides in the wrapper alongside it.
   */
  getFailureAttemptsWithTraceFn?: GetFailureAttemptsWithTraceFn;
  getMasteryProjectionFn?: GetMasteryProjectionFn;
  /** YUK-786: PRE-LLM grounding read (KC name + subject + first-hand samples). */
  enrichEvidenceCellsFn?: EnrichEvidenceCellsFn;
  /** dedup base: cause×KC keys with a PENDING conjecture (default reads the inbox). */
  loadKnownConjectureKeysFn?: (db: Db) => Promise<Set<string>>;
  /** injected runner — defaults to the real db-bound runTask. */
  runTaskFn?: TaskTextRunFn;
  induceConjectureFn?: InduceConjectureFn;
  writeAiProposalFn?: WriteAiProposalFn;
  writeEventFn?: WriteEventFn;
  writeRetryableAiFailureLedgerFn?: WriteRetryableAiFailureLedgerFn;
  resolveSubjectProfileFn?: ResolveSubjectProfileFn;
  /** Resolve every referenced asset to real image bytes before multimodal induction. */
  loadEvidenceImagesFn?: LoadEvidenceImagesFn;
  /** U8 (A13): score prior probe outcomes → prediction_score event + typed-ledger. */
  reconcileFn?: (db: Db) => Promise<ReconcileResult>;
}

/**
 * Pending-conjecture dedup: cause×KC keys that already carry a PENDING conjecture
 * proposal, so the same belief is not re-raised while one is still open. Uses the
 * inbox status derivation (listProposalInboxRows) — a dismissed/accepted conjecture
 * drops out of `pending`, so its evidence can be re-raised if it recurs.
 */
async function defaultLoadKnownConjectureKeys(db: Db): Promise<Set<string>> {
  const rows = await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' });
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.payload.kind === 'conjecture') {
      const change = row.payload.proposed_change;
      keys.add(conjectureKey(change.cause_category, change.knowledge_id));
    }
  }
  return keys;
}

/**
 * Real runner: wrap runTask and INJECT `db` into the ctx that induceConjecture
 * supplies ({ override, outputFormat }). induceConjecture stays db-free (unit
 * testable); the job is the seam that binds db (same role as runGoalScopeAndWrite).
 */
function makeDefaultRunTaskFn(db: Db): TaskTextRunFn {
  return makeRunTaskFn(db);
}

const RUNNER_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

interface EvidenceImageMetadata {
  id: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
}

function decodeUncompressedBmp(bytes: Buffer): {
  data: Buffer;
  width: number;
  height: number;
} {
  if (bytes.length < 54 || bytes.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('invalid BMP header');
  }
  const pixelOffset = bytes.readUInt32LE(10);
  const dibSize = bytes.readUInt32LE(14);
  const width = bytes.readInt32LE(18);
  const signedHeight = bytes.readInt32LE(22);
  const planes = bytes.readUInt16LE(26);
  const bitsPerPixel = bytes.readUInt16LE(28);
  const compression = bytes.readUInt32LE(30);
  if (
    dibSize < 40 ||
    width <= 0 ||
    signedHeight === 0 ||
    planes !== 1 ||
    ![24, 32].includes(bitsPerPixel) ||
    compression !== 0
  ) {
    throw new Error('unsupported BMP encoding');
  }
  const height = Math.abs(signedHeight);
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL) {
    throw new Error('BMP decoded-pixel limit exceeded');
  }
  const rowStride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  if (pixelOffset + rowStride * height > bytes.length) throw new Error('truncated BMP pixels');
  const channelsIn = bitsPerPixel / 8;
  const rgba = Buffer.allocUnsafe(pixels * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = signedHeight > 0 ? height - 1 - y : y;
    const rowStart = pixelOffset + sourceY * rowStride;
    for (let x = 0; x < width; x++) {
      const source = rowStart + x * channelsIn;
      const target = (y * width + x) * 4;
      rgba[target] = bytes[source + 2];
      rgba[target + 1] = bytes[source + 1];
      rgba[target + 2] = bytes[source];
      // BI_RGB 32-bit's fourth byte is reserved rather than a reliable alpha channel.
      rgba[target + 3] = 255;
    }
  }
  return { data: rgba, width, height };
}

export function planConjectureEvidenceImageLoad(
  refs: readonly ConjectureEvidenceAssetRef[],
  metadata: readonly EvidenceImageMetadata[],
): {
  loadableRefs: ConjectureEvidenceAssetRef[];
  transcodeAssetIds: string[];
} {
  const byId = new Map(metadata.map((row) => [row.id, row]));
  const missing = [...new Set(refs.map((ref) => ref.asset_id))].filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`conjecture evidence image metadata missing: ${missing.join(', ')}`);
  }

  const loadableRefs: ConjectureEvidenceAssetRef[] = [];
  const transcodeAssetIds = new Set<string>();
  const countedAssetIds = new Set<string>();
  let totalBytes = 0;
  let totalPixels = 0;
  for (const ref of refs) {
    const row = byId.get(ref.asset_id) as EvidenceImageMetadata;
    if (!row.mime_type.startsWith('image/')) {
      throw new Error(
        `conjecture evidence asset ${ref.asset_id} is not an image: ${row.mime_type}`,
      );
    }
    if (!RUNNER_IMAGE_MIME_TYPES.has(row.mime_type)) transcodeAssetIds.add(ref.asset_id);
    loadableRefs.push(ref);
    // One R2 object recurring across attempts is still one byte/pixel allocation. Occurrence
    // refs remain expanded for semantic ordering, but safety accounting follows unique assets.
    if (!countedAssetIds.has(ref.asset_id)) {
      countedAssetIds.add(ref.asset_id);
      totalBytes += row.byte_size;
      if (row.width !== null && row.height !== null) totalPixels += row.width * row.height;
    }
  }
  if (totalBytes > RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL) {
    throw new Error(
      `conjecture evidence images total ${totalBytes} bytes; max is ${RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL}`,
    );
  }
  if (totalPixels > RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL) {
    throw new Error(
      `conjecture evidence images total ${totalPixels} pixels; max is ${RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL}`,
    );
  }
  return { loadableRefs, transcodeAssetIds: [...transcodeAssetIds] };
}

export async function defaultLoadEvidenceImages(
  db: Db,
  refs: readonly ConjectureEvidenceAssetRef[],
  imageFetchFn: typeof defaultImageFetch = defaultImageFetch,
): Promise<LoadedConjectureEvidenceImage[]> {
  if (refs.length === 0) return [];
  if (refs.length > RESEARCH_MEETING_MAX_IMAGES_PER_CELL) {
    throw new Error(
      `conjecture evidence has ${refs.length} images; max is ${RESEARCH_MEETING_MAX_IMAGES_PER_CELL}`,
    );
  }
  const assetIds = [...new Set(refs.map((ref) => ref.asset_id))];
  const metadata = await db
    .select({
      id: source_asset.id,
      mime_type: source_asset.mime_type,
      byte_size: source_asset.byte_size,
      width: source_asset.width,
      height: source_asset.height,
    })
    .from(source_asset)
    .where(inArray(source_asset.id, assetIds));
  const { loadableRefs, transcodeAssetIds } = planConjectureEvidenceImageLoad(refs, metadata);
  if (loadableRefs.length === 0) return [];
  // Download/base64 each R2 object once, then expand it back to occurrence order. The same
  // diagram can recur in several attempts without paying N identical reads.
  const uniqueAssetIds = [...new Set(loadableRefs.map((ref) => ref.asset_id))];
  const fetched = await imageFetchFn(uniqueAssetIds, db);
  // `defaultImageFetch` preserves input order but skips missing DB/R2 rows.
  // A partial packet would let the model compare text against the wrong image index, so fail
  // the cell rather than guessing which asset was absent.
  if (fetched.length !== uniqueAssetIds.length) {
    throw new Error(
      `conjecture evidence image load incomplete: expected ${uniqueAssetIds.length}, got ${fetched.length}`,
    );
  }
  const metadataById = new Map(metadata.map((row) => [row.id, row]));
  const transcodeIds = new Set(transcodeAssetIds);
  const fetchedByAssetId = new Map<string, { data: string; mediaType: string }>();
  let sharpModule: typeof import('sharp') | null = null;
  for (const [index, assetId] of uniqueAssetIds.entries()) {
    const image = fetched[index];
    const expectedMime = metadataById.get(assetId)?.mime_type;
    if (image.mediaType !== expectedMime) {
      throw new Error(`conjecture evidence image MIME changed after preflight for ${assetId}`);
    }
    if (transcodeIds.has(assetId)) {
      sharpModule ??= await import('sharp');
      const sourceBytes = Buffer.from(image.data, 'base64');
      const bmp = image.mediaType === 'image/bmp' ? decodeUncompressedBmp(sourceBytes) : undefined;
      const expected = metadataById.get(assetId);
      if (
        bmp !== undefined &&
        ((expected?.width !== null && expected?.width !== bmp.width) ||
          (expected?.height !== null && expected?.height !== bmp.height))
      ) {
        throw new Error(
          `conjecture evidence BMP dimensions changed after preflight for ${assetId}`,
        );
      }
      const png =
        bmp === undefined
          ? await sharpModule.default(sourceBytes, { failOn: 'error' }).png().toBuffer()
          : await sharpModule
              .default(bmp.data, {
                raw: { width: bmp.width, height: bmp.height, channels: 4 },
              })
              .png()
              .toBuffer();
      fetchedByAssetId.set(assetId, {
        data: png.toString('base64'),
        mediaType: 'image/png',
      });
      continue;
    }
    if (!RUNNER_IMAGE_MIME_TYPES.has(image.mediaType)) {
      throw new Error(`conjecture evidence image MIME unsupported for ${assetId}`);
    }
    fetchedByAssetId.set(assetId, image);
  }
  return loadableRefs.map((ref) => {
    const image = fetchedByAssetId.get(ref.asset_id);
    if (!image) throw new Error(`conjecture evidence image expansion missing ${ref.asset_id}`);
    return { ...ref, ...image };
  });
}

/** Assemble the propose-only conjecture payload (deterministic cell facts + LLM draft). */
function buildConjectureProposalInput(
  cell: EnrichedEvidenceCell,
  induced: InduceConjectureResult,
  triggerEventId: string,
): WriteAiProposalInput {
  // Memory policy (YUK-515): conjecture proposals intentionally remain outbox-eligible.
  // Unlike probe/scan bookkeeping, this is a durable, evidence-backed belief about the
  // learner that the memory layer should retain. writeAiProposal therefore receives no
  // ingest_at opt-out; owner accept/edit remains the later calibration boundary.
  return {
    actor_ref: RESEARCH_MEETING_ACTOR,
    outcome: 'partial',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: cell.knowledge_id },
      // The 2nd-person belief IS the card's reason — shown whole, never truncated.
      reason_md: induced.draft.claim_md,
      // Provenance reuses the attempt event ids (no separate misconception store).
      evidence_refs: cell.evidence_event_ids.map((id) => ({ kind: 'event' as const, id })),
      proposed_change: {
        claim_md: induced.draft.claim_md,
        // Deterministic cell facts win over the LLM echo (cause/recurrence are the
        // ground truth the evidence_refs back; the draft only restates them).
        knowledge_id: cell.knowledge_id,
        cause_category: cell.cause_category,
        confidence: induced.confidence, // internal sort only — NEVER rendered as a number
        recurrence_count: cell.recurrence_count,
        probe_md: induced.draft.probe_md,
        // conjecture-wire #13 — single-writer judge gold reference flows draft →
        // proposal change → acceptConjectureProposal → serveProbeOnce.referenceMd.
        probe_reference_md: induced.draft.probe_reference_md,
        discriminating: induced.draft.discriminating,
        corrected_by_owner: false,
        // A13 (YUK-440): the falsifiable bet + the number it must later beat.
        predicted_p: induced.draft.predicted_p,
        baseline_p_at_induction: cell.baseline_p ?? 0.5, // 0.5 = cold-start neutral
      },
      cooldown_key: `conjecture:${cell.key}`,
    },
    caused_by_event_id: triggerEventId,
    // Keep the scalar correlation column for the primary sample, and retain the
    // complete self-consistency evidence trail in the proposal event payload.
    event_override: {
      action: 'experimental:proposal',
      subject_kind: 'mind_model',
      subject_id: cell.knowledge_id,
      payload: { induction_task_run_ids: induced.task_run_ids },
    },
    task_run_id: induced.task_run_ids[0] ?? null,
    cost_usd: induced.cost_usd,
  };
}

export async function runResearchMeetingNightly(
  db: Db,
  deps: ResearchMeetingDeps = {},
): Promise<ResearchMeetingResult> {
  const now = deps.now?.() ?? new Date();
  const getFailureAttemptsWithTraceFn =
    deps.getFailureAttemptsWithTraceFn ?? getFailureAttemptsWithReasoningTrace;
  const getMasteryProjectionFn = deps.getMasteryProjectionFn ?? getMasteryProjection;
  const enrichEvidenceCellsFn = deps.enrichEvidenceCellsFn ?? enrichEvidenceCells;
  const loadKnownConjectureKeysFn =
    deps.loadKnownConjectureKeysFn ?? defaultLoadKnownConjectureKeys;
  const induceConjectureFn = deps.induceConjectureFn ?? induceConjecture;
  const writeAiProposalFn = deps.writeAiProposalFn ?? writeAiProposal;
  const writeEventFn = deps.writeEventFn ?? writeEvent;
  const writeRetryableAiFailureLedgerFn =
    deps.writeRetryableAiFailureLedgerFn ?? writeRetryableAiFailureLedger;
  const resolveSubjectProfileFn = deps.resolveSubjectProfileFn ?? resolveSubjectProfile;
  const loadEvidenceImagesFn = deps.loadEvidenceImagesFn ?? defaultLoadEvidenceImages;
  const runTaskFn = deps.runTaskFn ?? makeDefaultRunTaskFn(db);
  const reconcileFn = deps.reconcileFn ?? ((d: Db) => reconcileConjecturePredictions(d));

  // ── A13 reconcile (U8): score PRIOR probe outcomes against their conjecture's
  // prediction → append LOG-only prediction_score events + advance the typed-ledger
  // (FLIP-inert). Runs BEFORE the propose half: deterministic DB work, idempotent
  // (already-scored probes are excluded by the reader), and a throw here is a legit
  // retryable DB fault that propagates so pg-boss retries the whole job.
  const reconcileResult = await reconcileFn(db);
  // Surface the aggregate skip count — a non-zero value flags data-quality drift (dangling /
  // unreadable conjecture refs) that the per-probe console.warn alone makes easy to miss.
  if (reconcileResult.skipped > 0) {
    console.warn('[research_meeting_nightly] reconcile skipped probes', reconcileResult.skipped);
  }

  // ── PRE-LLM reads (OUTSIDE the per-cell swallow — a throw here is retryable) ──
  const since = new Date(now.getTime() - RESEARCH_MEETING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // YUK-786: same rows as before, each paired with its YUK-562 reasoning_trace —
  // the owner's own account of how they thought, which is the single most
  // load-bearing piece of first-hand evidence for a mind-model claim. Derived
  // from the attempt rows the reader already selects (no extra round-trip).
  const failureRows = await getFailureAttemptsWithTraceFn(db, {
    includeReviewFailures: true,
    since,
  });
  const failures: FailureAttempt[] = failureRows.map((row) => row.failure);
  const reasoningTraceByAttemptId = new Map(
    failureRows.map((row) => [row.failure.attempt_event_id, row.reasoning_trace]),
  );
  const kcIds = [...new Set(failures.flatMap((f) => f.referenced_knowledge_ids))];
  const masteryByKnowledgeId =
    kcIds.length > 0 ? await getMasteryProjectionFn(db, kcIds) : new Map();
  const knownConjectureKeys = await loadKnownConjectureKeysFn(db);

  // ── Deterministic 取证 + grounded top-K salience cap ──
  const cells = gatherConjectureEvidence({ failures, masteryByKnowledgeId, knownConjectureKeys });

  // Empty-night early return (YUK-377 复审 §3.5): zero cells (no recurring failure
  // evidence, or every cell deduped by a pending conjecture) means the propose half has
  // nothing to anchor. Skip the trigger + scan events entirely — even though YUK-515 now
  // opts both out of memory, two empty-run rows would still add useless audit churn.
  // MUST stay AFTER the reconcile call above:
  // the deterministic settlement half is never skipped. Zero external consumers of these
  // events exist (grep-verified 2026-07-06), so skipping them changes no downstream reader.
  if (cells.length === 0) {
    return {
      considered: 0,
      conjectures_created: 0,
      cells_failed: 0,
      pending_before: knownConjectureKeys.size,
      reconciled: reconcileResult.reconciled,
      reconcile_skipped: reconcileResult.skipped,
      cost_usd: 0,
      trigger_event_id: '',
    };
  }

  // ── PRE-LLM grounding read (YUK-786; still OUTSIDE the per-cell swallow) ──
  // Enrich in salience order, at most K cells per read, and refill from lower-ranked cells
  // whenever mutable/missing question context leaves an earlier candidate ungrounded. Taking
  // `cells.slice(0, K)` before this filter lets a permanently invalid high-salience prefix
  // occupy the cap every night and starve valid candidates behind it.
  const preparedTopCells: PreparedConjectureCell[] = [];
  let cellOffset = 0;
  while (preparedTopCells.length < RESEARCH_MEETING_MAX_CONJECTURES && cellOffset < cells.length) {
    const batchSize = RESEARCH_MEETING_MAX_CONJECTURES - preparedTopCells.length;
    const batch = cells.slice(cellOffset, cellOffset + batchSize);
    cellOffset += batch.length;
    const enriched = await enrichEvidenceCellsFn(db, {
      cells: batch,
      failures,
      reasoningTraceByAttemptId,
    });
    const preparedBatch = await Promise.all(
      enriched.map(async (cell): Promise<PreparedConjectureCell | null> => {
        // Recurrence is a claim about reproducible historical context, not the raw attempt tally.
        // Enrichment validates every attempt and keeps all reproducible ids even though prompt
        // text samples are capped. Filtered mutable/missing contexts count toward neither the
        // threshold nor provenance, while a 4+ recurrence is not truncated back to the quote cap.
        const evidenceEventIds = [...new Set(cell.evidence_event_ids)];
        if (evidenceEventIds.length < CONJECTURE_RECURRENCE_FLOOR) return null;
        const reproducibleCell: EnrichedEvidenceCell = {
          ...cell,
          recurrence_count: evidenceEventIds.length,
          evidence_event_ids: evidenceEventIds,
        };
        try {
          const imageRefs = collectConjectureEvidenceAssetRefs(reproducibleCell);
          const evidenceImages = await loadEvidenceImagesFn(db, imageRefs);
          return { cell: reproducibleCell, evidenceImages };
        } catch (err) {
          // A deterministic bad/missing asset must not occupy one of the permanent top-K slots.
          // Continue in salience order so a lower candidate can still be inducted tonight.
          console.error(
            '[research_meeting_nightly] excluding candidate with unloadable evidence images',
            reproducibleCell.key,
            err,
          );
          return null;
        }
      }),
    );
    preparedTopCells.push(
      ...preparedBatch.filter(
        (candidate): candidate is PreparedConjectureCell => candidate !== null,
      ),
    );
  }
  if (preparedTopCells.length === 0) {
    return {
      considered: 0,
      conjectures_created: 0,
      cells_failed: 0,
      pending_before: knownConjectureKeys.size,
      reconciled: reconcileResult.reconciled,
      reconcile_skipped: reconcileResult.skipped,
      cost_usd: 0,
      trigger_event_id: '',
    };
  }

  // Anchor the run (provenance for each proposal + the scan subject).
  const triggerEventId = `research_meeting_${newId()}`;
  await writeEventFn(db, {
    id: triggerEventId,
    actor_kind: 'agent',
    actor_ref: RESEARCH_MEETING_ACTOR,
    action: 'experimental:trigger_research_meeting',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: 'success',
    payload: {
      window_days: RESEARCH_MEETING_WINDOW_DAYS,
      candidate_cells: preparedTopCells.length,
      pending_conjectures: knownConjectureKeys.size,
    },
    // Run anchor/provenance only; keep the event but skip Mem0 + brief regeneration.
    ingest_at: now,
    created_at: now,
  });

  // ── LLM half: independent top cells run in parallel; each cell remains swallow-safe ──
  const cellResults = await Promise.all(
    preparedTopCells.map(
      async ({
        cell,
        evidenceImages,
      }): Promise<{ created: number; failed: number; cost_usd: number }> => {
        let incurredCostUsd = 0;
        try {
          const induced = await induceConjectureFn({
            cells: [cell],
            evidenceImages,
            samples: RESEARCH_MEETING_SAMPLES,
            runTaskFn,
            // YUK-786: render the prompt in the cell's OWN subject voice. An
            // untagged KC (subject_id null) stays on the neutral `general`
            // profile — inheriting a concrete subject would re-introduce exactly
            // the wrong-subject steer this ticket removed from the prompt copy.
            subjectProfile: resolveSubjectProfileFn(cell.subject_id),
          });
          // Count the Opus induction spend immediately — it was incurred regardless of
          // whether the proposal write below succeeds (OCR: don't lose cost on a write throw).
          incurredCostUsd = induced.cost_usd;
          await writeAiProposalFn(db, buildConjectureProposalInput(cell, induced, triggerEventId));
          return { created: 1, failed: 0, cost_usd: incurredCostUsd };
        } catch (err) {
          console.error('[research_meeting_nightly] conjecture cell failed', cell.key, err);
          await writeRetryableAiFailureLedgerFn(db, 'MindModelInductionTask');
          // YUK-779: keep swallowing (one bad cell must not fail the batch) but COUNT it,
          // so the handler can tell "no evidence tonight" from "every cell blew up".
          return { created: 0, failed: 1, cost_usd: incurredCostUsd };
        }
      },
    ),
  );
  const created = cellResults.reduce((sum, result) => sum + result.created, 0);
  const cellsFailed = cellResults.reduce((sum, result) => sum + result.failed, 0);
  const costUsd = cellResults.reduce((sum, result) => sum + result.cost_usd, 0);

  // Observability scan event — NOT cost-bearing: each conjecture proposal event already
  // carries its own cost_micro_usd via writeAiProposal, so summing the run total here would
  // DOUBLE-COUNT the AI spend in the cost ribbon (OCR review). The per-run total is still
  // surfaced via the return value (cost_usd) for the job log.
  await writeEventFn(db, {
    id: `research_meeting_scan_${newId()}`,
    actor_kind: 'agent',
    actor_ref: RESEARCH_MEETING_ACTOR,
    action: 'experimental:research_meeting_scan',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: 'success',
    payload: {
      considered: preparedTopCells.length,
      conjectures_created: created,
      cells_failed: cellsFailed,
      pending_before: knownConjectureKeys.size,
    },
    caused_by_event_id: triggerEventId,
    cost_micro_usd: null,
    // Aggregate observability only; not evidence about the learner.
    ingest_at: now,
    created_at: now,
  });

  return {
    considered: preparedTopCells.length,
    conjectures_created: created,
    cells_failed: cellsFailed,
    pending_before: knownConjectureKeys.size,
    reconciled: reconcileResult.reconciled,
    reconcile_skipped: reconcileResult.skipped,
    cost_usd: costUsd,
    trigger_event_id: triggerEventId,
  };
}

export function buildResearchMeetingNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<JobYieldOutput> {
  return async () => {
    try {
      const result = await runResearchMeetingNightly(db);
      console.log('[research_meeting_nightly] result', result);
      // YUK-779 — the fallible units are the top-K cells. An empty night early-returns
      // with considered:0 → level `idle` (no alarm); a 限流风暴 fails every cell →
      // considered:3 / created:0 → level `stalled` (loud) and the report rides the job
      // output into the DAG node detail.
      return reportJobYield('research_meeting_nightly', {
        attempted: result.considered,
        succeeded: result.conjectures_created,
        failed: result.cells_failed,
      });
    } catch (err) {
      console.error('[research_meeting_nightly] failed', err);
      throw err;
    }
  };
}
