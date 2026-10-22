// Nightly 教研例会 (research-meeting) propose handler.
//
// Thin candidate-picker + dedup gate + a bounded parallel producer batch (NOT an MCP
// tool-agent loop). The job is the SINGLE proposer of conjectures: it calls
// induceConjecture (the Opus self-consistency orchestrator) + writeAiProposal directly.
//
// Per run: PRE-LLM reads (recent failures with reasoning traces, per-KC mastery, pending
// cause×KC keys) → deterministic evidence gathering + owner-decision/terminal history gate
// (30-day dismiss cooldown; terminal reopen needs two fresh failures) → prediction-
// accountability re-rank → salience-order grounding (KC name, subject identity, first-hand
// attempt evidence) → per grounded top-K cell induceConjecture → probe package →
// writeAiProposal.
//
// Failure asymmetry: shared PRE-LLM reads run OUTSIDE the per-cell swallow, so a throw is a
// retryable DB fault that propagates. Candidate-local grounding/image failures refill from
// lower salience; ordinary per-cell induction failures are swallowed and counted. Probe
// author/reviewer operational failures escape to pg-boss after recording health, because a
// completion marker would suppress the promised retry.
//
// Propose-only: this job NEVER writes FSRS state. The proposal snapshots predicted_p and
// baseline_p_at_induction; accept/edit remains with the owner.

import { createHash } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import type {
  ConjectureEvidenceAssetRef,
  EnrichedEvidenceCell,
  EvidenceCell,
  LoadedConjectureEvidenceImage,
} from '@/capabilities/agency/server/conjecture/evidence';
import {
  CONJECTURE_RECURRENCE_FLOOR,
  collectConjectureEvidenceAssetRefs,
  conjectureKey,
  gatherConjectureEvidence,
} from '@/capabilities/agency/server/conjecture/evidence';
import { enrichEvidenceCells } from '@/capabilities/agency/server/conjecture/evidence-enrichment';
import {
  type ConjectureHistory,
  type LoadConjectureHistoryFn,
  applyConjectureHistoryGate,
  loadConjectureHistory,
} from '@/capabilities/agency/server/conjecture/history';
import {
  ConjectureInductionOperationalError,
  type ConjectureInductionTaskKind,
  type InduceConjectureResult,
  induceConjecture,
} from '@/capabilities/agency/server/conjecture/induce';
import {
  RESEARCH_MEETING_ACTOR,
  type ResearchMeetingReconciliationDeps,
  reconcileResearchMeetingExecution,
  scheduledEventId,
} from '@/capabilities/agency/server/conjecture/reconciliation-execution';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event, source_asset } from '@/db/schema';
import { type WriteEventInput, writeEvent } from '@/kernel/events';
import { defaultImageFetch } from '@/kernel/judge';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { type WriteAiProposalInput, writeAiProposal } from '@/kernel/proposals/writer';
import type { FailureAttempt } from '@/kernel/read-models/failure-attempts';
import { getFailureAttemptsWithReasoningTrace } from '@/kernel/read-models/failure-attempts';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';
import { type TaskTextRunFn, costUsdToMicroUsd, sumAllKnownCostUsd } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import {
  type PredictionAccountability,
  loadPredictionAccountabilityByKey,
  rankEvidenceCellsByAccountability,
} from '@/server/conjectures/accountability';
import { resolveSubjectProfile } from '@/subjects/profile';
import { writeRetryableAiFailureLedger } from '../server/ai-runtime';

/** Structural per-run propose cap (top-K salient cells → at most K conjectures). */
export const RESEARCH_MEETING_MAX_CONJECTURES = 3;
/** N self-consistency samples per conjecture (Opus agreement tally). */
export const RESEARCH_MEETING_SAMPLES = 3;
/** Fail closed instead of silently dropping pixels from unusually image-heavy evidence. */
export const RESEARCH_MEETING_MAX_IMAGES_PER_CELL = 60;
/** Base64 transport bytes across all self-consistency requests for one cell. */
export const RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL = 24 * 1024 * 1024;
/** Decoded pixels across all self-consistency requests for one cell. */
export const RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL = 40_000_000;
/** Recency window for the failure scan. */
export const RESEARCH_MEETING_WINDOW_DAYS = 14;

export interface ResearchMeetingResult {
  /** top-K cells inducted this run (== conjectures attempted). */
  considered: number;
  /** conjectures actually proposed (a cell whose induction failed is dropped). */
  conjectures_created: number;
  /** grounded induction completed but correctly refused to fabricate a proposal. */
  conjectures_abstained: number;
  /**
   * Cells whose induction THREW and was swallowed by the per-cell catch below.
   * Invariant: `cells_failed + conjectures_created + conjectures_abstained === considered`.
   */
  cells_failed: number;
  /** pending conjectures already open at run start (the dedup base). */
  pending_before: number;
  /** prior probe outcomes scored + ledger-updated this run. */
  reconciled: number;
  /** probe outcomes skipped this run (dangling / malformed / unreadable conjecture ref). */
  reconcile_skipped: number;
  /** total Opus cost across the run's inductions, USD. */
  cost_usd: number | null;
  /**
   * the run's anchor event id (provenance + scan subject). `''` sentinel when the
   * run early-returned on an empty night (zero top cells → no anchor event written).
   */
  trigger_event_id: string;
}

// Durable completion payload contract: append-only and backward-compatible. Future fields
// must be optional/defaulted so already-committed executions remain readable.
const ResearchMeetingResultSchema = z
  .object({
    considered: z.number().int().nonnegative(),
    conjectures_created: z.number().int().nonnegative(),
    conjectures_abstained: z.number().int().nonnegative(),
    cells_failed: z.number().int().nonnegative(),
    pending_before: z.number().int().nonnegative(),
    reconciled: z.number().int().nonnegative(),
    reconcile_skipped: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative().nullable(),
    // Empty runs have no trigger/scan anchor; the `''` sentinel persists so redelivery
    // can return the exact result.
    trigger_event_id: z.string(),
  })
  .refine(
    (result) =>
      result.conjectures_created + result.conjectures_abstained + result.cells_failed ===
      result.considered,
    { message: 'created + abstained + failed must equal considered' },
  )
  .refine((result) => (result.considered === 0) === (result.trigger_event_id === ''), {
    message: 'empty result and empty trigger_event_id must agree',
  });

type DbLike = Db | Tx;
type WriteAiProposalFn = (db: DbLike, input: WriteAiProposalInput) => Promise<string>;
type RunInTransactionFn = (db: Db, fn: (tx: DbLike) => Promise<void>) => Promise<void>;
type RunWithExecutionLockFn = <T>(db: Db, executionId: string, fn: () => Promise<T>) => Promise<T>;
type LoadCompletedRunResultFn = (
  db: Db,
  executionId: string,
) => Promise<ResearchMeetingResult | null>;
type InduceConjectureFn = typeof induceConjecture;
type GetFailureAttemptsWithTraceFn = typeof getFailureAttemptsWithReasoningTrace;
type GetMasteryProjectionFn = typeof getMasteryProjection;
type EnrichEvidenceCellsFn = typeof enrichEvidenceCells;
type WriteRetryableAiFailureLedgerFn = (
  db: DbLike,
  taskKind: string,
  options?: { throwOnError?: boolean },
) => Promise<void>;
type ResolveSubjectProfileFn = typeof resolveSubjectProfile;
type LoadEvidenceImagesFn = (
  db: Db,
  refs: readonly ConjectureEvidenceAssetRef[],
) => Promise<LoadedConjectureEvidenceImage[]>;
type LoadPredictionAccountabilityFn = (
  db: Db,
  cells: readonly EvidenceCell[],
) => Promise<Map<string, PredictionAccountability>>;

interface PreparedConjectureCell {
  cell: EnrichedEvidenceCell;
  evidenceImages: LoadedConjectureEvidenceImage[];
}

function conjectureCellEventId(
  prefix: 'conjecture_abstained' | 'conjecture_proposal',
  executionId: string,
  cell: EnrichedEvidenceCell,
): string {
  // preparedTopCells contains at most one entry per deterministic cell.key. Hash the
  // stable input, not non-deterministic model output, so a retry cannot create a second
  // event merely by citing a different subset.
  const evidenceKey = [...cell.evidence_event_ids].sort().join('\0');
  const digest = createHash('sha256')
    .update(`${executionId}\0${cell.key}\0${evidenceKey}`)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function conjectureAbstentionEventId(executionId: string, cell: EnrichedEvidenceCell): string {
  return conjectureCellEventId('conjecture_abstained', executionId, cell);
}

function conjectureProposalEventId(executionId: string, cell: EnrichedEvidenceCell): string {
  // A concurrent pg-boss redelivery can pass the completion read while the first worker
  // is still running. The deterministic proposal id makes that race first-write-wins
  // instead of two pending conjectures for one logical cell.
  return conjectureCellEventId('conjecture_proposal', executionId, cell);
}

async function defaultRunWithExecutionLock<T>(
  db: Db,
  executionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Hold one dedicated connection-scoped transaction lock across the whole orchestration.
  // Business reads/writes keep their own short transactions on `db`; this outer
  // transaction owns only the advisory lock. A crash releases it automatically, and a
  // concurrent redelivery blocks here, then observes the first worker's committed
  // completion before model work.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`research_meeting_execution:${executionId}`}, 0))`,
    );
    return fn();
  });
}

async function defaultLoadCompletedRunResult(
  db: Db,
  executionId: string,
): Promise<ResearchMeetingResult | null> {
  const [row] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, scheduledEventId('completion', executionId)))
    .limit(1);
  if (!row) return null;
  const parsed = z.object({ completed_result: ResearchMeetingResultSchema }).safeParse(row.payload);
  if (!parsed.success) {
    // Fail closed: treating this as unfinished would repeat paid model work and
    // business effects, while the first-write-wins completion id cannot replace
    // the corrupt row. Emit schema diagnostics for repair instead.
    console.error('[research_meeting_nightly] committed completion payload is unreadable', {
      execution_id: executionId,
      issues: parsed.error.issues,
    });
    throw new Error(
      `research_meeting_nightly: completion payload is unreadable for execution ${executionId}`,
    );
  }
  return parsed.data.completed_result;
}

function buildCompletionEventInput(
  executionId: string,
  result: ResearchMeetingResult,
  now: Date,
  causedByEventId: string | null,
): WriteEventInput {
  const id = scheduledEventId('completion', executionId);
  return {
    id,
    actor_kind: 'agent',
    actor_ref: RESEARCH_MEETING_ACTOR,
    action: 'experimental:research_meeting_completed',
    subject_kind: 'query',
    subject_id: id,
    outcome: 'success',
    payload: { completed_result: result },
    caused_by_event_id: causedByEventId,
    // Execution bookkeeping only; not a learner fact.
    ingest_at: now,
    created_at: now,
  };
}

function isOperationalAbstain(result: InduceConjectureResult): boolean {
  // The collapsed reason is intentionally conservative on a three-way tie and
  // can become no_semantic_consensus for {proposal:1, invalid:1, failed:1}.
  // Classify health from the uncollapsed vote ledger instead: a strict majority
  // of operational losses means the cell failed even if its display reason tied.
  return (
    result.outcome === 'abstain' && result.votes.invalid + result.votes.failed > result.samples / 2
  );
}

export interface ResearchMeetingDeps extends ResearchMeetingReconciliationDeps {
  now?: () => Date;
  /**
   * Stable for retries of one scheduled pg-boss execution, distinct for the next
   * schedule. The real handler supplies `job.id`; direct callers get a fresh id.
   */
  executionId?: string;
  /** Trace-bearing failure reader; the reasoning_trace rides in the wrapper. */
  getFailureAttemptsWithTraceFn?: GetFailureAttemptsWithTraceFn;
  getMasteryProjectionFn?: GetMasteryProjectionFn;
  /** PRE-LLM grounding read (KC name + subject + first-hand samples). */
  enrichEvidenceCellsFn?: EnrichEvidenceCellsFn;
  /** First dedup base: cause×KC keys with a PENDING conjecture. */
  loadKnownConjectureKeysFn?: (db: Db) => Promise<Set<string>>;
  /** Owner decisions + terminal lifecycle for tonight's candidate identities. */
  loadConjectureHistoryFn?: LoadConjectureHistoryFn;
  /** Correction-aware score history folded by cause×KC identity. */
  loadPredictionAccountabilityFn?: LoadPredictionAccountabilityFn;
  /** injected runner — defaults to the real db-bound runTask. */
  runTaskFn?: TaskTextRunFn;
  induceConjectureFn?: InduceConjectureFn;
  writeAiProposalFn?: WriteAiProposalFn;
  /** Atomic durable boundary for trigger + per-cell outcomes/health + scan + completion. */
  runInTransactionFn?: RunInTransactionFn;
  /** Serialize every delivery of one stable pg-boss execution id before any work. */
  runWithExecutionLockFn?: RunWithExecutionLockFn;
  /** Redelivery guard: a committed completion means this logical execution is complete. */
  loadCompletedRunResultFn?: LoadCompletedRunResultFn;
  writeRetryableAiFailureLedgerFn?: WriteRetryableAiFailureLedgerFn;
  resolveSubjectProfileFn?: ResolveSubjectProfileFn;
  /** Resolve every referenced asset to real image bytes before multimodal induction. */
  loadEvidenceImagesFn?: LoadEvidenceImagesFn;
}

/** Pending-conjecture dedup before the owner-decision/terminal history gate. */
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
 * induceConjecture stays db-free; this seam binds `db` into the ctx it supplies
 * ({ override, modelBinding }).
 */
function makeDefaultRunTaskFn(db: Db): TaskTextRunFn {
  return makeRunTaskFn(db);
}

const RUNNER_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TRANSCODABLE_IMAGE_MIME_TYPES = new Set(['image/bmp']);

function base64TransportBytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

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
  let totalTransportBytes = 0;
  let totalPixels = 0;
  for (const ref of refs) {
    const row = byId.get(ref.asset_id) as EvidenceImageMetadata;
    if (
      !RUNNER_IMAGE_MIME_TYPES.has(row.mime_type) &&
      !TRANSCODABLE_IMAGE_MIME_TYPES.has(row.mime_type)
    ) {
      throw new Error(
        `conjecture evidence asset ${ref.asset_id} has unsupported MIME: ${row.mime_type}`,
      );
    }
    if (!RUNNER_IMAGE_MIME_TYPES.has(row.mime_type)) transcodeAssetIds.add(ref.asset_id);
    loadableRefs.push(ref);
    // One R2 object recurring across attempts is still one byte/pixel allocation.
    // Occurrence refs stay expanded for semantic ordering, but safety accounting follows
    // unique assets.
    if (!countedAssetIds.has(ref.asset_id)) {
      countedAssetIds.add(ref.asset_id);
      // Each unique image block is sent once per self-consistency request.
      totalTransportBytes += base64TransportBytes(row.byte_size) * RESEARCH_MEETING_SAMPLES;
      if (row.width !== null && row.height !== null) {
        if (
          !Number.isInteger(row.width) ||
          !Number.isInteger(row.height) ||
          row.width <= 0 ||
          row.height <= 0
        ) {
          throw new Error(
            `conjecture evidence asset ${ref.asset_id} has invalid dimensions: ${row.width}x${row.height}`,
          );
        }
        if (row.width > RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL / row.height) {
          throw new Error(
            `conjecture evidence asset ${ref.asset_id} has more pixels than the safety limit`,
          );
        }
        totalPixels += row.width * row.height * RESEARCH_MEETING_SAMPLES;
      }
    }
  }
  if (totalTransportBytes > RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL) {
    throw new Error(
      `conjecture evidence images total ${totalTransportBytes} base64 bytes; max is ${RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL}`,
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
  // Download/base64 each R2 object once; the same diagram can recur across attempts.
  const uniqueAssetIds = [...new Set(loadableRefs.map((ref) => ref.asset_id))];
  const fetched = await imageFetchFn(uniqueAssetIds, db);
  // `defaultImageFetch` preserves input order but skips missing DB/R2 rows. A partial
  // packet would let the model compare text against the wrong image index, so fail the
  // cell rather than guessing which asset was absent.
  if (fetched.length !== uniqueAssetIds.length) {
    throw new Error(
      `conjecture evidence image load incomplete: expected ${uniqueAssetIds.length}, got ${fetched.length}`,
    );
  }
  const metadataById = new Map(metadata.map((row) => [row.id, row]));
  const transcodeIds = new Set(transcodeAssetIds);
  const fetchedByAssetId = new Map<string, { data: string; mediaType: string }>();
  let sharpModule: typeof import('sharp') | null = null;
  let actualTransportBytes = 0;
  let actualPixels = 0;
  for (const [index, assetId] of uniqueAssetIds.entries()) {
    const image = fetched[index];
    const expected = metadataById.get(assetId);
    if (!expected || image.mediaType !== expected.mime_type) {
      throw new Error(`conjecture evidence image MIME changed after preflight for ${assetId}`);
    }
    const sourceBytes = Buffer.from(image.data, 'base64');
    let prepared: { data: string; mediaType: string };
    let decodedPixels: number;
    if (transcodeIds.has(assetId)) {
      sharpModule ??= await import('sharp');
      const bmp = image.mediaType === 'image/bmp' ? decodeUncompressedBmp(sourceBytes) : undefined;
      if (
        bmp !== undefined &&
        ((expected.width !== null && expected.width !== bmp.width) ||
          (expected.height !== null && expected.height !== bmp.height))
      ) {
        throw new Error(
          `conjecture evidence BMP dimensions changed after preflight for ${assetId}`,
        );
      }
      if (bmp === undefined) {
        throw new Error(`conjecture evidence image decoder missing for ${assetId}`);
      }
      const png = await sharpModule
        .default(bmp.data, {
          raw: { width: bmp.width, height: bmp.height, channels: 4 },
        })
        .png()
        .toBuffer();
      decodedPixels = bmp.width * bmp.height;
      prepared = {
        data: png.toString('base64'),
        mediaType: 'image/png',
      };
    } else {
      if (!RUNNER_IMAGE_MIME_TYPES.has(image.mediaType)) {
        throw new Error(`conjecture evidence image MIME unsupported for ${assetId}`);
      }
      sharpModule ??= await import('sharp');
      const decoded = await sharpModule
        .default(sourceBytes, {
          animated: true,
          failOn: 'error',
          limitInputPixels: RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL,
        })
        .metadata();
      const width = decoded.width;
      const height = decoded.pageHeight ?? decoded.height;
      const pages = decoded.pages ?? 1;
      if (
        width === undefined ||
        height === undefined ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        !Number.isInteger(pages) ||
        width <= 0 ||
        height <= 0 ||
        pages <= 0
      ) {
        throw new Error(`conjecture evidence image dimensions unreadable for ${assetId}`);
      }
      decodedPixels = width * height * pages;
      prepared = image;
    }
    actualTransportBytes += Buffer.byteLength(prepared.data, 'utf8') * RESEARCH_MEETING_SAMPLES;
    actualPixels += decodedPixels * RESEARCH_MEETING_SAMPLES;
    if (actualTransportBytes > RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL) {
      throw new Error(
        `conjecture evidence images total ${actualTransportBytes} actual base64 bytes; max is ${RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL}`,
      );
    }
    if (actualPixels > RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL) {
      throw new Error(
        `conjecture evidence images total ${actualPixels} actual pixels; max is ${RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL}`,
      );
    }
    fetchedByAssetId.set(assetId, prepared);
  }
  return uniqueAssetIds.map((assetId) => {
    const image = fetchedByAssetId.get(assetId);
    if (!image) throw new Error(`conjecture evidence prepared image missing ${assetId}`);
    return {
      asset_id: assetId,
      occurrences: loadableRefs
        .filter((ref) => ref.asset_id === assetId)
        .map(({ attempt_event_id, source }) => ({ attempt_event_id, source })),
      ...image,
    };
  });
}

/** Assemble the propose-only conjecture payload (deterministic cell facts + LLM draft). */
function buildConjectureProposalInput(
  cell: EnrichedEvidenceCell,
  induced: Extract<InduceConjectureResult, { outcome: 'proposal' }>,
  triggerEventId: string,
  proposalEventId: string,
): WriteAiProposalInput {
  const draft = induced.draft;
  // Conjecture proposals intentionally remain outbox-eligible: unlike probe/scan
  // bookkeeping this is a durable, evidence-backed belief about the learner, so
  // writeAiProposal gets no ingest_at opt-out. Owner accept/edit is the later
  // calibration boundary.
  return {
    id: proposalEventId,
    actor_ref: RESEARCH_MEETING_ACTOR,
    outcome: 'partial',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: cell.knowledge_id },
      // The 2nd-person belief IS the card's reason — shown whole, never truncated.
      reason_md: draft.claim_md,
      // Provenance reuses the attempt event ids (no separate misconception store).
      evidence_refs: draft.evidence_event_ids.map((id) => ({ kind: 'event' as const, id })),
      proposed_change: {
        claim_md: draft.claim_md,
        // Deterministic cell facts win over the LLM echo (cause/recurrence are the
        // ground truth the evidence_refs back).
        knowledge_id: cell.knowledge_id,
        cause_category: cell.cause_category,
        confidence: induced.confidence, // internal sort only — NEVER rendered as a number
        recurrence_count: cell.recurrence_count,
        probe_md: draft.probe_md,
        followup_probe_md: draft.followup_probe_md,
        // Single-writer judge gold reference flows draft → proposal change →
        // acceptConjectureProposal → serveProbeOnce.referenceMd.
        probe_reference_md: draft.probe_reference_md,
        followup_probe_reference_md: draft.followup_probe_reference_md,
        diagnostic_spec: draft.diagnostic_spec,
        probe_spec: draft.probe_spec,
        followup_probe_spec: draft.followup_probe_spec,
        probe_quality: draft.probe_quality,
        discriminating: draft.discriminating,
        corrected_by_owner: false,
        // The falsifiable bet + the number it must later beat.
        predicted_p: draft.predicted_p,
        baseline_p_at_induction: cell.baseline_p ?? 0.5, // 0.5 = cold-start neutral
      },
      cooldown_key: `conjecture:${cell.key}`,
    },
    caused_by_event_id: triggerEventId,
    // Keep the scalar correlation column for the primary sample; the payload retains
    // the complete self-consistency evidence trail.
    event_override: {
      action: 'experimental:proposal',
      subject_kind: 'mind_model',
      subject_id: cell.knowledge_id,
      payload: {
        induction_task_run_ids: induced.task_run_ids,
        probe_quality_attempts: induced.probe_quality_attempts,
      },
    },
    // Scalar correlation points at the author run that produced the verified package;
    // the payload retains induction, grouping, author, and reviewer provenance.
    task_run_id: induced.primary_task_run_id,
    cost_usd: induced.cost_usd,
  };
}

async function runResearchMeetingNightlyClaimed(
  db: Db,
  deps: ResearchMeetingDeps = {},
): Promise<ResearchMeetingResult> {
  const now = deps.now?.() ?? new Date();
  const executionId = deps.executionId;
  if (!executionId) {
    throw new Error('research_meeting_nightly: claimed execution is missing its stable id');
  }
  const getFailureAttemptsWithTraceFn =
    deps.getFailureAttemptsWithTraceFn ?? getFailureAttemptsWithReasoningTrace;
  const getMasteryProjectionFn = deps.getMasteryProjectionFn ?? getMasteryProjection;
  const enrichEvidenceCellsFn = deps.enrichEvidenceCellsFn ?? enrichEvidenceCells;
  const loadKnownConjectureKeysFn =
    deps.loadKnownConjectureKeysFn ?? defaultLoadKnownConjectureKeys;
  const loadConjectureHistoryFn = deps.loadConjectureHistoryFn ?? loadConjectureHistory;
  const loadPredictionAccountabilityFn =
    deps.loadPredictionAccountabilityFn ?? loadPredictionAccountabilityByKey;
  const induceConjectureFn = deps.induceConjectureFn ?? induceConjecture;
  const writeAiProposalFn = deps.writeAiProposalFn ?? writeAiProposal;
  const writeEventFn = deps.writeEventFn ?? writeEvent;
  const runInTransactionFn =
    deps.runInTransactionFn ??
    ((database: Db, fn: (tx: DbLike) => Promise<void>) => database.transaction(fn));
  const loadCompletedRunResultFn = deps.loadCompletedRunResultFn ?? defaultLoadCompletedRunResult;
  const writeRetryableAiFailureLedgerFn =
    deps.writeRetryableAiFailureLedgerFn ?? writeRetryableAiFailureLedger;
  const resolveSubjectProfileFn = deps.resolveSubjectProfileFn ?? resolveSubjectProfile;
  const loadEvidenceImagesFn = deps.loadEvidenceImagesFn ?? defaultLoadEvidenceImages;
  const runTaskFn = deps.runTaskFn ?? makeDefaultRunTaskFn(db);
  const persistCompletionOnly = async (result: ResearchMeetingResult): Promise<void> => {
    await runInTransactionFn(db, async (tx) => {
      await writeEventFn(tx, buildCompletionEventInput(executionId, result, now, null));
    });
  };

  // pg-boss may redeliver after the transaction committed but before completion
  // was acknowledged. Return the committed summary before any reads or model calls;
  // otherwise pending-proposal dedup could refill this execution from lower cells.
  const completedResult = await loadCompletedRunResultFn(db, executionId);
  if (completedResult) return completedResult;

  // ── Reconcile: project PRIOR probe outcomes into the typed ledger.
  // Sequence 1 appends a prediction_score consumed by the accountability ranker; recurrence
  // results append a score-free projection anchor. Runs BEFORE the propose half:
  // deterministic, idempotent (already-scored probes are excluded by the reader), and a
  // throw here is retryable so pg-boss retries the whole job.
  const reconcileResult = await reconcileResearchMeetingExecution(db, executionId, now, deps);
  // Surface the aggregate skip count — a non-zero value flags data-quality drift (dangling /
  // unreadable conjecture refs) that the per-probe console.warn alone makes easy to miss.
  if (reconcileResult.skipped > 0) {
    console.warn('[research_meeting_nightly] reconcile skipped probes', reconcileResult.skipped);
  }

  // ── PRE-LLM reads (OUTSIDE the per-cell swallow — a throw here is retryable) ──
  const since = new Date(now.getTime() - RESEARCH_MEETING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Each failure row is paired with its reasoning trace — the owner's own account of how
  // they thought, and the most load-bearing first-hand evidence for a mind-model claim.
  // Derived from the rows the reader already selects (no extra round-trip).
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

  // ── Deterministic 取证 + accountability upper-bound order ──
  const gatheredCells = gatherConjectureEvidence({
    failures,
    masteryByKnowledgeId,
    knownConjectureKeys,
  });
  const historyByKey =
    gatheredCells.length > 0
      ? await loadConjectureHistoryFn(db, gatheredCells)
      : new Map<string, ConjectureHistory>();
  const historyGate = applyConjectureHistoryGate(gatheredCells, failures, historyByKey, now);
  const accountabilityByKey =
    historyGate.cells.length > 0
      ? await loadPredictionAccountabilityFn(db, historyGate.cells)
      : new Map<string, PredictionAccountability>();
  const cells = rankEvidenceCellsByAccountability(historyGate.cells, accountabilityByKey);

  // Empty-night early return: zero cells means the propose half has nothing to anchor.
  // Skip trigger + scan; persist only the execution completion guard so a redelivery
  // cannot reconcile or discover new work twice.
  // MUST stay AFTER the reconcile call above: settlement is never skipped.
  if (cells.length === 0) {
    const idleResult: ResearchMeetingResult = {
      considered: 0,
      conjectures_created: 0,
      conjectures_abstained: 0,
      cells_failed: 0,
      pending_before: knownConjectureKeys.size,
      reconciled: reconcileResult.reconciled,
      reconcile_skipped: reconcileResult.skipped,
      cost_usd: 0,
      trigger_event_id: '',
    };
    await persistCompletionOnly(idleResult);
    return idleResult;
  }

  // ── PRE-LLM grounding read (still OUTSIDE the per-cell swallow) ──
  // Enrich in bounded salience batches and refill from lower-ranked cells when mutable or
  // missing question context leaves a candidate ungrounded. Raw recurrence is only an
  // UPPER BOUND: after enrichment validates the immutable evidence ids, re-apply
  // accountability to the reproducible count before the final top-K cut.
  const preparedCandidates: PreparedConjectureCell[] = [];
  const reproduciblePriorClaimMdByKey = new Map<string, string>();
  let cellOffset = 0;
  while (cellOffset < cells.length) {
    const batchSize = Math.min(RESEARCH_MEETING_MAX_CONJECTURES, cells.length - cellOffset);
    const batch = cells.slice(cellOffset, cellOffset + batchSize);
    cellOffset += batch.length;
    const enriched = await enrichEvidenceCellsFn(db, {
      cells: batch,
      failures,
      reasoningTraceByAttemptId,
    });
    const reproducibleCells: EnrichedEvidenceCell[] = [];
    for (const cell of enriched) {
      // Recurrence is a claim about reproducible historical context, not the raw attempt
      // tally. Enrichment validates every attempt and keeps all reproducible ids even
      // though prompt text samples are capped.
      const evidenceEventIds = [...new Set(cell.evidence_event_ids)];
      if (evidenceEventIds.length < CONJECTURE_RECURRENCE_FLOOR) continue;
      reproducibleCells.push({
        ...cell,
        recurrence_count: evidenceEventIds.length,
        evidence_event_ids: evidenceEventIds,
      });
    }
    // A terminal conjecture may clear the raw two-fresh-failures gate before enrichment
    // removes a missing/mutated attempt. Re-run the lifecycle gate over only reproducible
    // ids so older pre-terminal evidence cannot substitute for post-terminal failures.
    const reproducibleHistoryGate = applyConjectureHistoryGate(
      reproducibleCells,
      failures,
      historyByKey,
      now,
    );
    for (const [key, priorClaimMd] of reproducibleHistoryGate.priorClaimMdByKey) {
      reproduciblePriorClaimMdByKey.set(key, priorClaimMd);
    }
    const preparedBatch = await Promise.all(
      reproducibleHistoryGate.cells.map(
        async (reproducibleCell): Promise<PreparedConjectureCell | null> => {
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
        },
      ),
    );
    preparedCandidates.push(
      ...preparedBatch.filter(
        (candidate): candidate is PreparedConjectureCell => candidate !== null,
      ),
    );
    if (preparedCandidates.length >= RESEARCH_MEETING_MAX_CONJECTURES) {
      const preparedKeys = new Set(preparedCandidates.map((candidate) => candidate.cell.key));
      // Unprocessed cells retain their raw recurrence count as an upper bound, so this
      // early stop can only enrich an extra batch — never skip a validated top-K cell.
      const bestPossibleTopKeys = rankEvidenceCellsByAccountability<EvidenceCell>(
        [...preparedCandidates.map((candidate) => candidate.cell), ...cells.slice(cellOffset)],
        accountabilityByKey,
      )
        .slice(0, RESEARCH_MEETING_MAX_CONJECTURES)
        .map((candidate) => candidate.key);
      if (bestPossibleTopKeys.every((key) => preparedKeys.has(key))) break;
    }
  }
  const preparedByKey = new Map(
    preparedCandidates.map((candidate) => [candidate.cell.key, candidate] as const),
  );
  const preparedTopCells = rankEvidenceCellsByAccountability(
    preparedCandidates.map((candidate) => candidate.cell),
    accountabilityByKey,
  )
    .slice(0, RESEARCH_MEETING_MAX_CONJECTURES)
    .map((cell) => {
      const prepared = preparedByKey.get(cell.key);
      if (!prepared) {
        throw new Error(`research_meeting_nightly: prepared candidate missing for ${cell.key}`);
      }
      return prepared;
    });
  if (preparedTopCells.length === 0) {
    const ungroundedResult: ResearchMeetingResult = {
      considered: 0,
      conjectures_created: 0,
      conjectures_abstained: 0,
      cells_failed: 0,
      pending_before: knownConjectureKeys.size,
      reconciled: reconcileResult.reconciled,
      reconcile_skipped: reconcileResult.skipped,
      cost_usd: 0,
      trigger_event_id: '',
    };
    await persistCompletionOnly(ungroundedResult);
    return ungroundedResult;
  }

  // Anchor the run (provenance for each proposal + the scan subject). The trigger write
  // joins the result writes and scan in one transaction below; the stable pg-boss
  // execution id keeps every durable fact anchored to the same logical run.
  const triggerEventId = scheduledEventId('trigger', executionId);

  // ── LLM half: independent top cells run in parallel ─────────────────────────
  // Only provider/induction failures are cell-local and swallow-safe. Durable writes
  // happen after all inductions and commit atomically below.
  const cellResults = await Promise.all(
    preparedTopCells.map(
      async ({
        cell,
        evidenceImages,
      }): Promise<{
        cell: EnrichedEvidenceCell;
        induced: InduceConjectureResult | null;
        created: number;
        abstained: number;
        failed: number;
        failed_task_kind: ConjectureInductionTaskKind | null;
        retry_job_error: ConjectureInductionOperationalError | null;
        cost_usd: number | null;
      }> => {
        let induced: InduceConjectureResult;
        const priorClaimMd = reproduciblePriorClaimMdByKey.get(cell.key);
        try {
          induced = await induceConjectureFn({
            cells: [cell],
            evidenceImages,
            samples: RESEARCH_MEETING_SAMPLES,
            runTaskFn,
            ...(priorClaimMd ? { priorClaimMd } : {}),
            // Render the prompt in the cell's OWN subject voice. An untagged KC
            // (subject_id null) stays on the neutral `general` profile; inheriting a
            // concrete subject would steer the claim toward the wrong subject.
            subjectProfile: resolveSubjectProfileFn(cell.subject_id),
          });
        } catch (err) {
          console.error('[research_meeting_nightly] conjecture cell failed', cell.key, err);
          if (
            err instanceof ConjectureInductionOperationalError &&
            (err.taskKind === 'ConjectureProbeAuthorTask' ||
              err.taskKind === 'ConjectureProbeReviewTask')
          ) {
            // Do not persist this execution's completion marker. pg-boss redelivery
            // must revisit the cell after an author/reviewer outage or invalid output.
            await writeRetryableAiFailureLedgerFn(db, err.taskKind);
            return {
              cell,
              induced: null,
              created: 0,
              abstained: 0,
              failed: 1,
              failed_task_kind: err.taskKind,
              retry_job_error: err,
              cost_usd: null,
            };
          }
          // Keep swallowing (one bad cell must not fail the batch) but COUNT it, so the
          // handler can tell "no evidence tonight" from "every cell blew up". Partial
          // sample spend stays in per-call cost_ledger rows; the thrown orchestrator
          // exposes no reliable partial total for this aggregate.
          return {
            cell,
            induced: null,
            created: 0,
            abstained: 0,
            failed: 1,
            failed_task_kind:
              err instanceof ConjectureInductionOperationalError
                ? err.taskKind
                : 'MindModelInductionTask',
            retry_job_error: null,
            cost_usd: null,
          };
        }

        const operationalFailure = isOperationalAbstain(induced);
        return {
          cell,
          induced,
          created: induced.outcome === 'proposal' ? 1 : 0,
          // Evidence-related abstentions and genuine semantic disagreement are
          // successful fail-closed decisions. Invalid output/provider-majority
          // reasons are operational failures and must make an all-bad night stall.
          abstained: induced.outcome === 'abstain' && !operationalFailure ? 1 : 0,
          failed: operationalFailure ? 1 : 0,
          failed_task_kind: operationalFailure ? 'MindModelInductionTask' : null,
          retry_job_error: null,
          cost_usd: induced.cost_usd,
        };
      },
    ),
  );
  const retryJobError = cellResults.find((result) => result.retry_job_error)?.retry_job_error;
  if (retryJobError) {
    // Promise.all has now waited for every sibling cell to settle, but no proposal,
    // scan, or completion fact has been committed for this execution.
    throw retryJobError;
  }
  const created = cellResults.reduce((sum, result) => sum + result.created, 0);
  const abstained = cellResults.reduce((sum, result) => sum + result.abstained, 0);
  const cellsFailed = cellResults.reduce((sum, result) => sum + result.failed, 0);
  const costUsd = sumAllKnownCostUsd(cellResults.map((result) => result.cost_usd));
  if (created + abstained + cellsFailed !== preparedTopCells.length) {
    throw new Error(
      `research_meeting_nightly: result invariant violated: created(${created}) + abstained(${abstained}) + failed(${cellsFailed}) !== considered(${preparedTopCells.length})`,
    );
  }
  const completedResultForWrite: ResearchMeetingResult = {
    considered: preparedTopCells.length,
    conjectures_created: created,
    conjectures_abstained: abstained,
    cells_failed: cellsFailed,
    pending_before: knownConjectureKeys.size,
    reconciled: reconcileResult.reconciled,
    reconcile_skipped: reconcileResult.skipped,
    cost_usd: costUsd,
    trigger_event_id: triggerEventId,
  };

  // Trigger + every successful cell result + scan commit together. A single durable-write
  // failure rolls the whole batch back, so retry-time pending-proposal dedup can never
  // shrink the logical run into a partial scan. Each runTask call already committed its
  // own ai_task_runs + cost_ledger rows; this transaction governs business outcomes only.
  await runInTransactionFn(db, async (tx) => {
    await writeEventFn(tx, {
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

    for (const result of cellResults) {
      if (result.failed > 0) {
        // Operational health rows belong to the same commit boundary as the
        // run facts. A final-write rollback must not orphan/duplicate them.
        if (!result.failed_task_kind) {
          throw new Error('research_meeting_nightly: failed cell is missing task attribution');
        }
        await writeRetryableAiFailureLedgerFn(tx, result.failed_task_kind, { throwOnError: true });
      }
      if (!result.induced) continue;
      const { cell, induced } = result;
      if (induced.outcome === 'abstain') {
        await writeEventFn(tx, {
          // A pg-boss retry reuses job.id and therefore this first-write-wins event; the
          // next scheduled execution has a distinct job.id and keeps its own provenance.
          id: conjectureAbstentionEventId(executionId, cell),
          actor_kind: 'agent',
          actor_ref: RESEARCH_MEETING_ACTOR,
          action: 'experimental:conjecture_abstained',
          subject_kind: 'mind_model',
          subject_id: cell.knowledge_id,
          outcome: isOperationalAbstain(induced) ? 'failure' : 'partial',
          payload: {
            reason_code: induced.draft.reason_code,
            explanation_md: induced.draft.explanation_md ?? null,
            evidence_event_ids: induced.draft.evidence_event_ids,
            input_evidence_event_ids: cell.evidence_event_ids,
            induction_task_run_ids: induced.task_run_ids,
            probe_quality_attempts: induced.probe_quality_attempts,
            votes: induced.votes,
            requested_samples: induced.samples,
          },
          caused_by_event_id: triggerEventId,
          cost_micro_usd: costUsdToMicroUsd(induced.cost_usd),
          // Audit/observability only: an abstention is not a learner fact.
          ingest_at: now,
          created_at: now,
        });
      } else {
        await writeAiProposalFn(
          tx,
          buildConjectureProposalInput(
            cell,
            induced,
            triggerEventId,
            conjectureProposalEventId(executionId, cell),
          ),
        );
      }
    }

    // Observability scan event — NOT cost-bearing: each outcome event already carries its
    // own cost, so a run total here would double-count it.
    await writeEventFn(tx, {
      id: scheduledEventId('scan', executionId),
      actor_kind: 'agent',
      actor_ref: RESEARCH_MEETING_ACTOR,
      action: 'experimental:research_meeting_scan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        considered: preparedTopCells.length,
        conjectures_created: created,
        conjectures_abstained: abstained,
        cells_failed: cellsFailed,
        pending_before: knownConjectureKeys.size,
      },
      caused_by_event_id: triggerEventId,
      cost_micro_usd: null,
      // Aggregate observability only; not evidence about the learner.
      ingest_at: now,
      created_at: now,
    });
    await writeEventFn(
      tx,
      buildCompletionEventInput(executionId, completedResultForWrite, now, triggerEventId),
    );
  });

  return completedResultForWrite;
}

export async function runResearchMeetingNightly(
  db: Db,
  deps: ResearchMeetingDeps = {},
): Promise<ResearchMeetingResult> {
  const executionId = deps.executionId ?? newId();
  const runWithExecutionLockFn = deps.runWithExecutionLockFn ?? defaultRunWithExecutionLock;
  return runWithExecutionLockFn(db, executionId, () =>
    runResearchMeetingNightlyClaimed(db, { ...deps, executionId }),
  );
}

export function buildResearchMeetingNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<JobYieldOutput> {
  // Capability jobs are mounted centrally with batchSize:1
  // (register-capability-jobs.ts); one handler invocation owns exactly one job id.
  return async (jobs) => {
    try {
      const executionId = jobs[0]?.id;
      if (!executionId) {
        throw new Error('research_meeting_nightly: handler invoked without a pg-boss job id');
      }
      const result = await runResearchMeetingNightly(db, {
        executionId,
      });
      console.log('[research_meeting_nightly] result', result);
      // The fallible units are the top-K cells. An empty night returns considered:0 →
      // `idle` (no alarm); every cell failing → `stalled` (loud), and the report rides the
      // job output into the DAG node detail.
      return reportJobYield('research_meeting_nightly', {
        attempted: result.considered,
        // abstain is a successful, fail-closed model decision, not an AI failure.
        succeeded: result.conjectures_created + result.conjectures_abstained,
        failed: result.cells_failed,
      });
    } catch (err) {
      console.error('[research_meeting_nightly] failed', err);
      throw err;
    }
  };
}
