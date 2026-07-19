// YUK-697 — jyeoo_fetch handler: jyeoo-rs as a first-class DETERMINISTIC supply route.
//
// docs/design/2026-07-18-jyeoo-supply-selection-matching-design.md (whole);
// ~/jyeoo-rs/docs/DESIGN.md (producer contract).
//
// Unlike the SourcingTask handler (an LLM agent that self-reports provenance), this
// handler spawns a DETERMINISTIC scraper (jyeoo-rs), reads its NDJSON, validates each
// line against the SAME SourcedQuestion contract, and reuses the EXACT sourcing INSERT +
// source_verify chain. It is a confirmed forager instance (design §5): fetch → prefilter
// (exact + near dup, against active+draft pool) → draft pool → source_verify chain.
//
// Deterministic guarantees (design + producer contract):
//   - VIP hard-gate: a non-VIP / VIP-expired run produces hole-punched reference_md
//     (semantic-level corruption). The producer patch (docs/design/2026-07-19-yuk697-
//     producer-patch-proposal.md) makes jyeoo-rs exit 6 before emitting; belt-and-
//     suspenders, this handler ALSO fails the whole batch on any per-line vip:false.
//     Either way: NO INSERT before the batch is proven VIP-complete.
//   - Whole-batch discard on any non-zero exit / timeout / truncation (never ingest a
//     partial/mid-crash run).
//   - Dedup identity is CONTENT ONLY (canonical_content_hash + n-gram overlap) — never
//     ID/URL (detail IDs drift, design §5 / producer §9).
//   - Image-dependent questions use jyeoo-rs --images, then local bytes → R2/source_asset
//     → question.figures + internal asset URLs. A missing/invalid local image filters only
//     that question before persistence; no external or temporary URL reaches the DB.
//   - Every draft is INSERTed draft_status='draft' (audit:draft-status hard gate); the
//     chained source_verify promotes draft→active on pass.

import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Job, SendOptions } from 'pg-boss';

import {
  type SourceAssetRow,
  persistImageAsset,
  sha256Hex,
} from '@/capabilities/ingestion/server/persist-image-asset';
import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/core/limits';
import { AgentRef } from '@/core/schema/business';
import type { DifficultyEvidenceT } from '@/core/schema/difficulty-evidence';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { knowledge, question, source_asset } from '@/db/schema';
import {
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '@/server/boss/verify-dispatch-outbox';
import { writeEvent } from '@/server/events/queries';
import { SupplyTraceV1, type SupplyTraceV1T } from '@/server/question-supply/evidence-demand';
import {
  type JyeooFailureClass,
  classifyJyeooExit,
  hasMalformedMarkdownImage,
  markdownImageSources,
  parseJyeooLine,
  rewriteMarkdownImageSources,
} from '@/server/question-supply/jyeoo-loom-adapter';
import { type SpawnJyeooFn, spawnJyeooFetch } from '@/server/question-supply/jyeoo-spawn';
import {
  JYEOO_DEFAULT_PAGES,
  JYEOO_FETCH_ROUTE,
  jyeooBinaryPath,
  jyeooDgTokenForBand,
  jyeooFetchEnabled,
  jyeooSpawnMaxStderrBytes,
  jyeooSpawnMaxStdoutBytes,
  jyeooSpawnTimeoutMs,
} from '@/server/question-supply/jyeoo-supply-config';
import type { DifficultyBand } from '@/server/question-supply/target-discovery';
import { insertSourcedDraft } from '@/server/questions/sourced-draft-insert';
import {
  canonicalQuestionContentHash,
  findExactQuestionDuplicate,
} from '@/server/quiz/content-fingerprint';
import { type R2Client, getR2 } from '@/server/r2';
import { resolveSubjectProfile } from '@/subjects/profile';
import { kindsMatch } from '@/subjects/question-kind';
import { maxNgramOverlap } from './quiz_verify';
import { DEDUP_OVERLAP_THRESHOLD } from './source_verify';
import { matchesWhitelist } from './sourcing';

// Only 'knowledge' + 'manual' — jyeoo_fetch is auto-dispatched by the supply dispatcher
// with trigger 'knowledge' + an anchor knowledge_id. 'manual' mirrors sourcing (best-
// effort resolve; never skips on a free-form ref). No 'learning_item': jyeoo is target-
// driven off a single anchor KC (design §2.1), and the dispatcher only ever sends a KC.
// Deterministic scraper — NOT an LLM agent. `by: 'system'` is the honest provenance
// (aiAgentRef is for tasks with an LLM run + task_run_id; jyeoo_fetch has neither).
const JYEOO_CREATED_BY = AgentRef.parse({ by: 'system', task_kind: 'JyeooFetch' });

export const JYEOO_FETCH_TRIGGERS = ['knowledge', 'manual'] as const;
export type JyeooFetchTrigger = (typeof JYEOO_FETCH_TRIGGERS)[number];

export interface JyeooFetchJobData {
  trigger: JyeooFetchTrigger;
  ref_id: string;
  count?: number;
  knowledge_id?: string;
  kind?: string;
  difficulty_band?: DifficultyBand;
  supply_trace?: SupplyTraceV1T;
}

export const JYEOO_FETCH_DEFAULT_COUNT = 3;

// Pre-INSERT near-dup threshold. Reuses source_verify's DEDUP_OVERLAP_THRESHOLD (0.7)
// deliberately: the same n-gram overlap signal source_verify applies POST-insert against
// the ACTIVE pool, applied HERE pre-insert against the ACTIVE+DRAFT pool (design §5 —
// forager prefilter against active+draft so we never stack a duplicate DRAFT that
// source_verify's active-only dedup can't see).
export const JYEOO_NEAR_DUP_THRESHOLD = DEDUP_OVERLAP_THRESHOLD;

// Bound the per-anchor pool comparison — same LIMIT precedent as source_verify checkDedup.
const NEAR_DUP_POOL_LIMIT = 100;

export type EnqueueSourceVerifyFn = (questionIds: string[], options?: SendOptions) => Promise<void>;

async function defaultEnqueueSourceVerify(
  questionIds: string[],
  options?: SendOptions,
): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('source_verify', { question_ids: questionIds }, options);
}

export interface RunJyeooFetchParams {
  db: Db;
  trigger: JyeooFetchTrigger;
  refId: string;
  count?: number;
  knowledgeId?: string;
  kind?: string;
  difficultyBand?: DifficultyBand;
  supplyTrace?: SupplyTraceV1T;
  spawnJyeooFn?: SpawnJyeooFn;
  enqueueSourceVerify?: EnqueueSourceVerifyFn;
  /** Test seam; production resolves getR2() lazily only after a localized image is present. */
  r2?: R2Client;
  /** Test-only failure injection after blob/source_asset finalization. */
  afterAssetsPersistedFn?: (context: { canonicalContentHash: string }) => Promise<void>;
}

export type RunJyeooFetchStatus =
  | 'ready'
  | 'skipped:disabled'
  | 'skipped:ref_not_found'
  | 'skipped:subject_unsupported'
  | 'skipped:no_keyword'
  | `failed:${JyeooFailureClass}`;

export interface RunJyeooFetchResult {
  status: RunJyeooFetchStatus;
  question_ids?: string[];
  counts?: JyeooFetchCounts;
}

// Canary counts (P4). Every run emits these on its experimental:jyeoo_fetch event so the
// funnel (requested → fetched → validated → deduped → inserted → verify-enqueued) is
// observable; downstream verified/promoted are read from the chained source_verify
// events keyed by the same question_ids.
interface JyeooFetchCounts {
  requested: number; // desiredCount asked for.
  fetched: number; // non-blank NDJSON lines emitted.
  validated: number; // lines that passed the SourcedQuestion contract.
  invalid: number; // non-blank lines that failed JSON/Zod (dropped, batch still ok on exit 0).
  filtered_image: number; // image question dropped because localization/read validation failed.
  filtered_kind: number; // valid questions dropped for not matching the pinned kind (pre-persist).
  deduped_exact: number; // dropped by canonical_content_hash exact match.
  deduped_near: number; // dropped by n-gram near-dup prefilter (active+draft pool).
  inserted: number; // drafts written (draft_status='draft').
  verify_enqueued: number; // drafts handed to the source_verify chain.
}

interface ResolvedJyeooTrigger {
  knowledgeNode: { id: string; name: string };
  /**
   * The EFFECTIVE subject domain (walks the parent chain for a child KC whose own
   * `domain` is null — the normal knowledge-tree shape). Used to resolve the subject
   * profile; a raw-row read would collapse child KCs onto `general` and falsely skip
   * jyeoo support (mirrors subjectIdForKnowledge / getEffectiveDomain canonical usage).
   */
  effectiveDomain: string | null;
}

/**
 * Resolve the anchor knowledge node. jyeoo is target-driven off ONE anchor KC (design
 * §2.1); an archived node is treated as missing (mirrors sourcing's guard — never mount
 * new material/FSRS onto a dead node). The explicit knowledge_id anchor (from the 找题
 * 次序) wins over the free-form refId, exactly like sourcing's F2 branch.
 */
async function resolveAnchor(
  db: Db,
  trigger: JyeooFetchTrigger,
  refId: string,
  knowledgeId?: string,
): Promise<ResolvedJyeooTrigger | null> {
  const lookupId = knowledgeId ?? (trigger === 'knowledge' || trigger === 'manual' ? refId : null);
  if (!lookupId) return null;
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
    .from(knowledge)
    .where(and(eq(knowledge.id, lookupId), isNull(knowledge.archived_at)))
    .limit(1);
  const k = rows[0];
  if (!k) return null;
  // Effective domain climbs the parent chain (child KCs carry domain=null). getEffectiveDomain
  // THROWS on a resolution failure (node missing / root-domain invariant) — fall back to the
  // raw row domain so an edge case degrades to general rather than crashing the job.
  let effectiveDomain: string | null = k.domain;
  try {
    effectiveDomain = await getEffectiveDomain(db, k.id);
  } catch (err) {
    console.warn('[jyeoo_fetch] effective-domain walk failed; using raw row domain:', err);
  }
  return { knowledgeNode: { id: k.id, name: k.name }, effectiveDomain };
}

/** Pull existing active+draft prompts sharing the anchor KC for the near-dup prefilter. */
async function fetchNearDupPool(
  db: Db,
  anchorKid: string,
): Promise<Array<{ id: string; prompt_md: string }>> {
  return (
    db
      .select({ id: question.id, prompt_md: question.prompt_md })
      .from(question)
      // Include DRAFTS (no notDraftPredicate): the forager prefilter must catch a
      // duplicate we (or a prior run) already staged as a draft, which source_verify's
      // active-only dedup would miss (design §5).
      .where(sql`${question.knowledge_ids} @> ${JSON.stringify([anchorKid])}::jsonb`)
      // Newest-first so a bounded LIMIT samples the most recently written rows (the most
      // likely near-dup comparison set) deterministically — a LIMIT with no ORDER BY is an
      // arbitrary sample that could miss a near-duplicate when a KC has >LIMIT questions.
      .orderBy(desc(question.created_at))
      .limit(NEAR_DUP_POOL_LIMIT)
  );
}

const emptyCounts = (requested: number): JyeooFetchCounts => ({
  requested,
  fetched: 0,
  validated: 0,
  invalid: 0,
  filtered_image: 0,
  filtered_kind: 0,
  deduped_exact: 0,
  deduped_near: 0,
  inserted: 0,
  verify_enqueued: 0,
});

interface LocalizedImage {
  source: string;
  bytes: Uint8Array;
  mime: string;
  sha256: string;
}

interface LoadedQuestionImages {
  images: LocalizedImage[];
  attachedSources: Set<string>;
}

interface PersistedQuestionImages {
  q: SourcedQuestionT;
  figures: FigureRefT[];
  imageRefs: string[];
  structured: StructuredQuestionT;
  assets: SourceAssetRow[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function loadLocalizedQuestionImages(
  q: SourcedQuestionT,
  imageDir: string,
): Promise<LoadedQuestionImages | null> {
  const markdownFields = [q.prompt_md, ...(q.choices_md ?? []), q.reference_md ?? ''];
  if (markdownFields.some((markdown) => hasMalformedMarkdownImage(markdown))) {
    console.warn('[jyeoo_fetch] malformed markdown image; filtering question');
    return null;
  }
  const attachedSources = new Set(
    unique([
      ...markdownImageSources(q.prompt_md),
      ...(q.choices_md ?? []).flatMap((choice) => markdownImageSources(choice)),
    ]),
  );
  const allSources = unique([...attachedSources, ...markdownImageSources(q.reference_md)]);
  if (allSources.length === 0) return { images: [], attachedSources };

  const root = await realpath(resolve(imageDir));
  const images: LocalizedImage[] = [];
  for (const source of allSources) {
    if (!isAbsolute(source)) {
      console.warn('[jyeoo_fetch] image was not localized under the run directory:', source);
      return null;
    }
    try {
      // Resolve symlinks before the containment check. A lexical `/run/link.png` can point
      // outside the per-run directory and must not become an arbitrary-file read primitive.
      const path = await realpath(resolve(source));
      const pathFromRoot = relative(root, path);
      if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
        console.warn('[jyeoo_fetch] image realpath escaped the run directory:', source);
        return null;
      }
      const info = await stat(path);
      if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_UPLOAD_BYTES) {
        console.warn('[jyeoo_fetch] localized image failed file/size validation:', source);
        return null;
      }
      const file = await readFile(path);
      const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
      const mime = detectImageMime(bytes);
      if (mime === null) {
        console.warn('[jyeoo_fetch] localized image failed size/mime validation:', source);
        return null;
      }
      // Magic bytes alone accept truncated files. Decode metadata so verification never
      // receives a nominal PNG/JPEG/GIF/WebP that the model/runtime cannot actually read.
      const { default: sharp } = await import('sharp');
      const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
      const expectedFormat = {
        'image/png': 'png',
        'image/jpeg': 'jpeg',
        'image/gif': 'gif',
        'image/webp': 'webp',
      }[mime];
      if (!metadata.width || !metadata.height || metadata.format !== expectedFormat) {
        console.warn('[jyeoo_fetch] localized image failed decode validation:', source);
        return null;
      }
      images.push({ source, bytes, mime, sha256: await sha256Hex(bytes) });
    } catch (err) {
      console.warn('[jyeoo_fetch] localized image unavailable; filtering question:', source, err);
      return null;
    }
  }
  return { images, attachedSources };
}

async function canonicalJyeooQuestionHash(
  q: SourcedQuestionT,
  loaded: LoadedQuestionImages,
): Promise<string> {
  if (loaded.images.length === 0) {
    return canonicalQuestionContentHash({
      promptMd: q.prompt_md,
      referenceMd: q.reference_md,
      choicesMd: q.choices_md,
      rubricJson: q.rubric_json,
    });
  }
  const neutral = new Map(loaded.images.map((image) => [image.source, 'IMAGE']));
  const canonicalTextHash = canonicalQuestionContentHash({
    promptMd: rewriteMarkdownImageSources(q.prompt_md, neutral),
    referenceMd: rewriteMarkdownImageSources(q.reference_md, neutral),
    choicesMd: q.choices_md?.map((choice) => rewriteMarkdownImageSources(choice, neutral)),
    rubricJson: q.rubric_json,
  });
  const digestBySource = new Map(loaded.images.map((image) => [image.source, image.sha256]));
  // Keep slot order (prompt → choices → reference). Same alt/text with different pixels
  // is a different question; swapping two figures is also a different question.
  const imageSlots = [
    ...markdownImageSources(q.prompt_md),
    ...(q.choices_md ?? []).flatMap((choice) => markdownImageSources(choice)),
    ...markdownImageSources(q.reference_md),
  ].map((source) => digestBySource.get(source));
  return sha256Hex(new TextEncoder().encode(JSON.stringify({ canonicalTextHash, imageSlots })));
}

async function persistQuestionImages(
  db: Db,
  r2: R2Client,
  q: SourcedQuestionT,
  loaded: LoadedQuestionImages,
  questionId: string,
): Promise<PersistedQuestionImages> {
  const replacements = new Map<string, string>();
  const assetIdsBySource = new Map<string, string>();
  const assets: SourceAssetRow[] = [];
  try {
    for (const image of loaded.images) {
      const asset = await persistImageAsset(db, r2, {
        bytes: image.bytes,
        mime: image.mime,
        compensatePutOnInsertFailure: true,
      });
      assets.push(asset);
      replacements.set(image.source, `/api/assets/${encodeURIComponent(asset.id)}/content`);
      assetIdsBySource.set(image.source, asset.id);
    }
  } catch (err) {
    await cleanupQuestionAssets(db, r2, assets);
    throw err;
  }

  const qWithInternalUrls: SourcedQuestionT = {
    ...q,
    prompt_md: rewriteMarkdownImageSources(q.prompt_md, replacements),
    reference_md: rewriteMarkdownImageSources(q.reference_md, replacements),
    choices_md: q.choices_md?.map((choice) => rewriteMarkdownImageSources(choice, replacements)),
  };
  const imageRefs = [...loaded.attachedSources]
    .map((source) => assetIdsBySource.get(source))
    .filter((id): id is string => id !== undefined);
  const figures: FigureRefT[] = imageRefs.map((assetId) => ({
    asset_id: assetId,
    role: 'diagram',
    source_page_index: 0,
    source_bbox: { x: 0, y: 0, width: 1, height: 1 },
    attached_to_index: questionId,
    attach_confidence: 'high',
  }));
  const structured: StructuredQuestionT = {
    id: questionId,
    role: 'standalone',
    prompt_text: qWithInternalUrls.prompt_md,
    ...(qWithInternalUrls.reference_md ? { answers: [qWithInternalUrls.reference_md] } : {}),
  };
  return { q: qWithInternalUrls, figures, imageRefs, structured, assets };
}

async function cleanupQuestionAssets(
  db: Db,
  r2: R2Client,
  assets: readonly SourceAssetRow[],
): Promise<void> {
  if (assets.length === 0) return;
  const ownedIds = new Set(assets.map((asset) => asset.id));
  for (const storageKey of new Set(assets.map((asset) => asset.storage_key))) {
    const owners = await db
      .select({ id: source_asset.id })
      .from(source_asset)
      .where(eq(source_asset.storage_key, storageKey));
    // Delete the blob before its last rows. If R2 deletion fails, the source_asset rows
    // remain as durable owners and the failure is visible/retriable rather than becoming a
    // naked object. Shared content-addressed blobs stay in place for their other owners.
    if (owners.every((owner) => ownedIds.has(owner.id))) await r2.delete(storageKey);
  }
  await db.delete(source_asset).where(inArray(source_asset.id, [...ownedIds]));
}

export async function runJyeooFetch(params: RunJyeooFetchParams): Promise<RunJyeooFetchResult> {
  const { db, trigger, refId } = params;
  const count = params.count ?? JYEOO_FETCH_DEFAULT_COUNT;
  const spawnJyeoo = params.spawnJyeooFn ?? spawnJyeooFetch;
  const enqueueSourceVerify = params.enqueueSourceVerify ?? defaultEnqueueSourceVerify;

  // Kill-switch defense (P4). The dispatcher already skips jyeoo_fetch when disabled;
  // this guards a job that reached the queue before the flag flipped.
  if (!jyeooFetchEnabled()) return { status: 'skipped:disabled' };

  const resolved = await resolveAnchor(db, trigger, refId, params.knowledgeId);
  if (!resolved) return { status: 'skipped:ref_not_found' };

  const subjectProfile = resolveSubjectProfile(resolved.effectiveDomain);
  const jyeooSubject = subjectProfile.jyeooSupply?.subject ?? null;
  if (!jyeooSubject) return { status: 'skipped:subject_unsupported' };

  const keyword = resolved.knowledgeNode.name?.trim();
  if (!keyword) return { status: 'skipped:no_keyword' };

  const anchorKid = resolved.knowledgeNode.id;
  const whitelist = (subjectProfile.sourceWhitelist ?? []) as string[];
  const dg = jyeooDgTokenForBand(params.difficultyBand ?? 'near');
  const triggerEventId = `jyeoo_fetch_trigger_${createId()}`;
  const counts = emptyCounts(count);
  const imageDir = await mkdtemp(join(tmpdir(), 'loom-jyeoo-'));

  const args = [
    'search',
    keyword,
    '--subject',
    jyeooSubject,
    '--pages',
    String(JYEOO_DEFAULT_PAGES),
    '--dg',
    dg,
    '--emit',
    'loom',
    '--images',
    imageDir,
  ];

  let failureStage: 'producer' | 'persist' | 'event' | 'dispatch' = 'producer';
  try {
    // ── spawn the deterministic producer (bounded stdout/stderr + timeout) ──────
    let spawnResult: Awaited<ReturnType<SpawnJyeooFn>>;
    try {
      spawnResult = await spawnJyeoo({
        binaryPath: jyeooBinaryPath(),
        args,
        timeoutMs: jyeooSpawnTimeoutMs(),
        maxStdoutBytes: jyeooSpawnMaxStdoutBytes(),
        maxStderrBytes: jyeooSpawnMaxStderrBytes(),
      });
    } catch (spawnErr) {
      // OS-level spawn failure (ENOENT etc.) — terminal 'spawn' class, no INSERT.
      return finishFailure({
        db,
        triggerEventId,
        params,
        counts,
        failureClass: 'spawn',
        detail: `spawn failed: ${(spawnErr as Error).message}`,
        retryable: false,
      });
    }

    // ── classify exit: any non-zero / timeout / truncation ⇒ discard whole batch ─
    const classification = classifyJyeooExit(spawnResult);
    const truncated = spawnResult.stdoutTruncated;
    if (classification.failure !== null || truncated) {
      const failureClass: JyeooFailureClass = classification.failure ?? 'unknown';
      const retryable = classification.failure !== null ? classification.retryable : false;
      return finishFailure({
        db,
        triggerEventId,
        params,
        counts,
        failureClass,
        detail: truncated
          ? `stdout exceeded ${jyeooSpawnMaxStdoutBytes()} bytes; batch discarded (possible mid-stream truncation)`
          : `jyeoo-rs exit ${spawnResult.exitCode}${spawnResult.signal ? ` signal ${spawnResult.signal}` : ''}: ${stderrTail(spawnResult.stderr)}`,
        retryable,
      });
    }

    // ── parse NDJSON lines ─────────────────────────────────────────────────────
    const validQuestions: SourcedQuestionT[] = [];
    let vipViolation = false;
    for (const line of spawnResult.lines) {
      const parsed = parseJyeooLine(line);
      if (!parsed.ok) {
        // A blank line is a skip (trailing newline); a non-blank invalid line counts as
        // both fetched and invalid but is dropped (one bad line must not sink the batch).
        if (parsed.reason !== 'blank') {
          counts.invalid += 1;
          counts.fetched += 1;
        }
        continue;
      }
      counts.fetched += 1;
      counts.validated += 1;
      // VIP belt (design §5): a per-line vip:false means the producer served a hole-
      // punched detail template. Fail the WHOLE batch before any INSERT.
      if (parsed.jyeoo.vip === false) vipViolation = true;
      validQuestions.push(parsed.question);
    }

    if (vipViolation) {
      return finishFailure({
        db,
        triggerEventId,
        params,
        counts,
        failureClass: 'vip',
        detail:
          'producer emitted a non-VIP (vip:false) line; whole batch discarded (VIP expiry ⇒ hole-punched reference_md must not be ingested)',
        retryable: false,
      });
    }

    // ── pre-persist filter: pinned-kind mismatch ────────────────────────────────
    // The dispatcher may pin a kind (diagnostic / format-diversity / calibration targets,
    // e.g. `choice`). The producer only INFERS kind, so — mirroring the sourcing path's
    // params.kind enforcement — drop any question whose kind does not match the pin BEFORE
    // INSERT (kindsMatch normalizes both to canonical, so `single_choice` matches `choice`).
    // Otherwise a wrong-kind draft would pass source_verify while leaving the gap unfilled.
    const candidateQuestions: SourcedQuestionT[] = [];
    for (const q of validQuestions) {
      if (params.kind && !kindsMatch(q.kind, params.kind)) {
        counts.filtered_kind += 1;
        continue;
      }
      candidateQuestions.push(q);
    }

    // ── near-dup prefilter (active+draft pool + in-batch) ──────────────────────
    const now = new Date();
    const poolPrompts = (await fetchNearDupPool(db, anchorKid)).map((r) => r.prompt_md);
    const batchPrompts: string[] = [];
    const questionIds: string[] = [];
    const difficultyEvidenceByQuestion: Array<{
      question_id: string;
      evidence: DifficultyEvidenceT;
    }> = [];

    failureStage = 'persist';
    let imageR2 = params.r2;
    for (const q of candidateQuestions) {
      if (questionIds.length >= count) break; // respect desiredCount — don't over-supply.

      const loadedImages = await loadLocalizedQuestionImages(q, imageDir);
      if (loadedImages === null) {
        counts.filtered_image += 1;
        continue;
      }
      if (loadedImages.images.length > 0 && imageR2 === undefined) {
        try {
          imageR2 = getR2();
        } catch (err) {
          // Credentials are intentionally lazy: a missing R2 config filters this image question
          // but never blocks pure-text candidates from the same producer batch.
          console.warn('[jyeoo_fetch] R2 unavailable; filtering image question:', err);
          counts.filtered_image += 1;
          continue;
        }
      }

      // Near-dup (content n-gram) against active+draft pool + already-staged batch.
      const nearOverlap = maxNgramOverlap(q.prompt_md, [...poolPrompts, ...batchPrompts]);
      if (nearOverlap >= JYEOO_NEAR_DUP_THRESHOLD) {
        counts.deduped_near += 1;
        continue;
      }

      // Exact-dup (canonical content hash) — its canonicalizer preserves image alt/presence while
      // excluding transport URLs, so random temp paths and internal asset ids share one identity.
      const canonicalContentHash = await canonicalJyeooQuestionHash(q, loadedImages);
      const existingDuplicate = await findExactQuestionDuplicate(db, canonicalContentHash);
      if (existingDuplicate) {
        counts.deduped_exact += 1;
        continue;
      }
      // jyeoo-rs computes extraction_hash after --images localization, so an image question's
      // producer hash contains this run's random temp path. Replace only that unstable provenance
      // value with Loom's URL-insensitive canonical hash; text-question provenance stays verbatim.
      const id = createId();
      let media: PersistedQuestionImages | null = null;
      let persisted: Awaited<ReturnType<typeof insertSourcedDraft>>;
      try {
        media =
          loadedImages.images.length > 0
            ? await persistQuestionImages(db, imageR2 as R2Client, q, loadedImages, id)
            : null;
        if (media && params.afterAssetsPersistedFn) {
          await params.afterAssetsPersistedFn({ canonicalContentHash });
        }
        const persistedQuestion = media?.q ?? q;
        const qForInsert =
          loadedImages.images.length > 0
            ? { ...persistedQuestion, extraction_hash: `sha256:${canonicalContentHash}` }
            : persistedQuestion;
        persisted = await db.transaction(async (tx) => {
          // Reserve the canonical hash and materialize all question-owned references atomically.
          // Image blobs/source_asset rows are staged immediately before this transaction. A
          // rollback or canonical race runs ref-aware compensation below before the job retries.
          const inserted = await insertSourcedDraft(tx, {
            id,
            q: qForInsert,
            knowledgeIds: [anchorKid],
            sourceRoute: JYEOO_FETCH_ROUTE,
            createdBy: JYEOO_CREATED_BY,
            whitelistMatch: matchesWhitelist(q.source_url, whitelist),
            fetchedAt: now.toISOString(),
            canonicalContentHash,
            supplyTrace: params.supplyTrace,
            now,
          });
          if (inserted.status === 'raced_duplicate') return inserted;

          if (media) {
            await tx
              .update(question)
              .set({
                // Jyeoo image questions are holistic visual prompts. The shared route supports this
                // capability for math, but choices normally short-circuit to exact before image
                // auto-routing, so persist the explicit route rather than silently ignoring figures.
                ...(media.imageRefs.length > 0
                  ? { judge_kind_override: 'multimodal_direct' as const }
                  : {}),
                figures: media.figures,
                image_refs: media.imageRefs,
                structured: media.structured,
                metadata: sql`${question.metadata} || ${JSON.stringify({ prompt_image_refs: media.imageRefs })}::jsonb`,
                updated_at: now,
              })
              .where(eq(question.id, id));
          }
          await writeVerifyDispatchIntent(tx, {
            questionId: id,
            verifier: 'source_verify',
            supplyTrace: inserted.supplyTrace,
            createdAt: now,
          });
          return inserted;
        });
      } catch (err) {
        if (media) await cleanupQuestionAssets(db, imageR2 as R2Client, media.assets);
        throw err;
      }
      if (persisted.status === 'raced_duplicate') {
        if (media) await cleanupQuestionAssets(db, imageR2 as R2Client, media.assets);
        counts.deduped_exact += 1;
        continue;
      }
      questionIds.push(id);
      batchPrompts.push(q.prompt_md);
      difficultyEvidenceByQuestion.push({
        question_id: id,
        evidence: persisted.difficultyEvidence,
      });
    }
    counts.inserted = questionIds.length;

    // ── chain source_verify FIRST (best-effort; drafts + intents are durable) ────
    // Dispatch before the canary event so counts.verify_enqueued records the real funnel.
    if (questionIds.length > 0) {
      failureStage = 'dispatch';
      const dispatchResult = await dispatchPendingVerifyIntents(db, {
        questionIds,
        enqueue: async (verifier, ids, options) => {
          if (verifier !== 'source_verify') {
            throw new Error(`jyeoo_fetch outbox received unexpected verifier '${verifier}'`);
          }
          await enqueueSourceVerify(ids, options);
        },
      });
      counts.verify_enqueued = questionIds.length - dispatchResult.failed;
      if (dispatchResult.failed > 0) {
        console.error(
          '[jyeoo_fetch] source_verify enqueue failed; durable intents left for recovery:',
          questionIds,
        );
      }
    }

    // ── canary success event (after dispatch so verify_enqueued is accurate) ────
    failureStage = 'event';
    await writeEvent(db, {
      id: createId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'jyeoo_fetch',
      action: 'experimental:jyeoo_fetch',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        trigger,
        ref_id: refId,
        knowledge_id: anchorKid,
        jyeoo_subject: jyeooSubject,
        dg,
        question_ids: questionIds,
        counts,
        difficulty_evidence: difficultyEvidenceByQuestion,
        ...(params.supplyTrace ? { supply_trace: params.supplyTrace } : {}),
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    return { status: 'ready', question_ids: questionIds, counts };
  } catch (err) {
    // Unexpected (persist/event/dispatch) failure — write a failure event + re-throw so
    // pg-boss retries (transient DB errors). Producer-classified failures never reach
    // here (they return via finishFailure above).
    try {
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'jyeoo_fetch',
        action: 'experimental:jyeoo_fetch',
        subject_kind: 'query',
        subject_id: triggerEventId,
        outcome: 'failure',
        payload: {
          trigger,
          ref_id: refId,
          error: String((err as Error).message ?? err),
          failure_stage: failureStage,
          counts,
          ...(params.supplyTrace ? { supply_trace: params.supplyTrace } : {}),
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });
    } catch (cleanupErr) {
      console.error('[jyeoo_fetch] catch-block cleanup failed for', refId, cleanupErr);
    }
    throw err;
  } finally {
    await rm(imageDir, { recursive: true, force: true }).catch((err) => {
      console.warn('[jyeoo_fetch] failed to remove image temp directory:', imageDir, err);
    });
  }
}

/** Truncate a stderr tail for the failure event (bounded — the full stderr is already capped). */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= 500) return trimmed;
  return `…${trimmed.slice(-500)}`;
}

interface FinishFailureArgs {
  db: Db;
  triggerEventId: string;
  params: RunJyeooFetchParams;
  counts: JyeooFetchCounts;
  failureClass: JyeooFailureClass;
  detail: string;
  retryable: boolean;
}

/**
 * Record a producer-classified failure (NO INSERT happened) + either return a terminal
 * failed status or throw for retry. Terminal classes (auth/vip/args/parse/spawn/unknown)
 * return — retrying won't help until a human/producer fixes the cookie/VIP/binary.
 * Retryable classes (network/timeout) throw so pg-boss redelivers.
 */
async function finishFailure(args: FinishFailureArgs): Promise<RunJyeooFetchResult> {
  const { db, triggerEventId, params, counts, failureClass, detail, retryable } = args;
  await writeEvent(db, {
    id: createId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'jyeoo_fetch',
    action: 'experimental:jyeoo_fetch',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: 'failure',
    payload: {
      trigger: params.trigger,
      ref_id: params.refId,
      failure_class: failureClass,
      failure_detail: detail,
      counts,
      ...(params.supplyTrace ? { supply_trace: params.supplyTrace } : {}),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
  if (retryable) {
    throw new Error(`jyeoo_fetch producer failure (${failureClass}, retryable): ${detail}`);
  }
  return { status: `failed:${failureClass}`, counts };
}

export function buildJyeooFetchHandler(
  db: Db,
  deps: {
    spawnJyeooFn?: SpawnJyeooFn;
    enqueueSourceVerify?: EnqueueSourceVerifyFn;
    r2?: R2Client;
  } = {},
): (jobs: Job<JyeooFetchJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data;
      if (!data?.trigger || !data?.ref_id) {
        console.warn('[jyeoo_fetch] job missing trigger/ref_id', job.id);
        continue;
      }
      // supply_trace is best-effort provenance — parse at the trust boundary with
      // safeParse so a malformed payload drops the trace instead of throwing before the
      // handler's failure-bottom can emit a structured event.
      let supplyTrace: SupplyTraceV1T | undefined;
      if (data.supply_trace) {
        const parsed = SupplyTraceV1.safeParse(data.supply_trace);
        if (parsed.success) supplyTrace = parsed.data;
        else console.warn('[jyeoo_fetch] ignoring malformed supply_trace in job data', job.id);
      }
      const result = await runJyeooFetch({
        db,
        trigger: data.trigger,
        refId: data.ref_id,
        count: data.count,
        ...(data.knowledge_id ? { knowledgeId: data.knowledge_id } : {}),
        ...(data.kind ? { kind: data.kind } : {}),
        ...(data.difficulty_band ? { difficultyBand: data.difficulty_band } : {}),
        ...(supplyTrace ? { supplyTrace } : {}),
        spawnJyeooFn: deps.spawnJyeooFn,
        enqueueSourceVerify: deps.enqueueSourceVerify,
        r2: deps.r2,
      });
      console.log(`[jyeoo_fetch] ${data.trigger}:${data.ref_id} -> ${result.status}`);
    }
  };
}
