// YUK-986 (Supply-Agent/1) — jyeoo-rs grade-route 候选抓取管线（供给 agent 化的 fetch 核）。
//
// 前身：YUK-697 jobs/jyeoo-fetch.ts（search 路线、锚定单 KC、fetch+insert 一体 handler）。
// 本模块是 `jyeoo_fetch_candidates` DomainTool 与 scripts/jyeoo-backfill.ts 共享的
// DETERMINISTIC fetch 核，与旧 handler 的关键差异：
//
//   - producer 命令从 `search <keyword> --dg` 换成 `grade --grade G --subjects S`（producer
//     经济学：发现免费、内容付费 40 题/日、无法按 KC 定向——见 docs/DESIGN §10 与
//     YUK-985 epic）。锚定 KC / keyword / dg / subject-profile jyeooSupply 全部消失；
//     知识归属延后到 commit（hint 匹配或 agent 提议），本模块只透传 knowledge_hints。
//   - 只产候选，不写 question：候选图片即下载即持久化（R2 + source_asset，provenance
//     origin='jyeoo_staged'）并把 markdown URL 改写为内部 /api/assets/<id>/content——
//     候选必须自包含，agent 之后凭 extraction_hash + candidate 内容调
//     store_sourced_question 提交。未提交候选的 staged 资产由 jyeoo_staged_asset_reap 回收。
//   - dedup 分层：fetch 侧做 in-batch near-dup + 全局 canonical-hash 存在性判定
//     （advisory，terminal-rejected 旧 draft 也保守判重——重复内容本就会被 verify 再拒）；
//     KC-scoped pool near-dup + cross-KC merge 全部在 commit（store-sourced-question.ts），
//     因为只有那时才有 knowledge_ids。
//
// 确定性保证（继承旧 handler 语义）：
//   - 任何非零 exit / 超时 / stdout 截断 ⇒ 整批丢弃，绝不入库半截数据（producer 契约）。
//   - vip:false 行 ⇒ 整批失败（belt：新 producer 不发 vip 字段，此闸对老二进制兜底）。
//   - dedup 身份只看内容（canonical hash + n-gram），不看 detail id / URL。
//   - 图片题：本地字节校验（magic + sharp decode）→ R2/source_asset → 内部 URL；
//     任何外部/临时 URL 都不进候选输出，更不进 DB。

import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { eq, inArray } from 'drizzle-orm';
import {
  type SourceAssetRow,
  lockImageStorageKey,
  persistImageAsset,
  sha256Hex,
} from '@/capabilities/ingestion/public';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/core/limits';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { question, source_asset } from '@/db/schema';
import { type R2Client, getR2 } from '@/server/r2';

// r2 访问单主：practice 内只有本模块直接触达 '@/server/r2'（边界 audit 的
// distinct-file 计数保持基线）。reaper / tools 一律经本模块的转发出口。
export { lockImageStorageKey } from '@/capabilities/ingestion/public';
export type { R2Client as JyeooR2Client } from '@/server/r2';
export { getR2 as resolveJyeooR2 } from '@/server/r2';

import { kindsMatch } from '@/subjects/question-kind';
import { canonicalQuestionContentHash } from '../quiz/content-fingerprint';
import { jyeooBudgetRemaining, jyeooDailyFetchBudget } from './jyeoo-budget';
import {
  type JyeooFailureClass,
  classifyJyeooExit,
  hasMalformedMarkdownImage,
  isForeignSourceHost,
  markdownImageSources,
  parseJyeooLine,
  rewriteMarkdownImageSources,
} from './jyeoo-loom-adapter';
import { type SpawnJyeooFn, spawnJyeooFetch } from './jyeoo-spawn';
import {
  JYEOO_SOURCE_HOST,
  jyeooBinaryPath,
  jyeooSpawnMaxStderrBytes,
  jyeooSpawnMaxStdoutBytes,
  jyeooSpawnTimeoutMs,
} from './jyeoo-supply-config';
import { DEDUP_OVERLAP_THRESHOLD, maxNgramOverlap } from './sourced-dedup';
import type { DifficultyBand } from './target-discovery';

// 与旧 handler 相同的 pre-persist near-dup 阈值（source_verify 的 0.7 复用）——这里只用于
// in-batch 判定；KC-scoped pool near-dup 在 commit 用同一阈值。
export const JYEOO_NEAR_DUP_THRESHOLD = DEDUP_OVERLAP_THRESHOLD;

/** 可抓取的年级（producer --grade：10 高一 / 11 高二 / 12 高三）。 */
export const JYEOO_GRADES = [10, 11, 12] as const;
export type JyeooGrade = (typeof JYEOO_GRADES)[number];

/**
 * band → 1-5 difficulty 集合的 post-filter（grade 路线无 --dg，过滤从 producer 侧移到
 * loom 侧；映射沿用旧 jyeooDgTokenForBand 的语义：easy≈1-2 / medium≈3 / hard≈4 /
 * difficult≈5）。标定到 logit-b 仍是 design §2.2 声明的后续工作。
 */
export function difficultyInBand(difficulty: number, band: DifficultyBand): boolean {
  switch (band) {
    case 'below':
      return difficulty <= 2;
    case 'near':
      return difficulty === 3;
    case 'above':
      return difficulty === 4;
    case 'stretch':
      return difficulty >= 5;
  }
  const _exhaustive: never = band;
  return _exhaustive;
}

export interface JyeooFetchCandidatesInput {
  grade: JyeooGrade;
  /** producer 学科 id（如 math2）。调用方决定——本模块不再查 subject profile。 */
  subject: string;
  /** 发现侧列表页数（免费、公开）。 */
  pages: number;
  /** 发现侧试卷上限（免费、公开）。 */
  maxPapers: number;
  /** 本次内容拉取上限（付费预算消耗口；会被裁到日预算余额内）。 */
  sessionMax: number;
  /** 可选 kind pin（诊断/格式多样性目标）：不匹配的题过滤丢弃。 */
  kind?: string;
  /** 可选难度带 post-filter。 */
  difficultyBand?: DifficultyBand;
}

export interface JyeooCandidate {
  /** fetch↔commit 关联 id；figures.attached_to_index / structured.id 先指向它，commit 重写为题 id。 */
  candidateId: string;
  /** 图片 URL 已改写为内部 /api/assets/<id>/content 的 SourcedQuestion（自包含、可提交）。 */
  question: SourcedQuestionT;
  /** sha256:<canonical> —— THE dedup key，原样传给 store_sourced_question。 */
  extractionHash: string;
  /** producer meta.knowledge_hints 原样透传（归属在 commit 侧解析）。 */
  knowledgeHints: string[];
  /** jyeoo detail id（仅审计；dedup 永远不看 id）。 */
  sourceId: string | null;
  figures: FigureRefT[] | null;
  imageRefs: string[] | null;
  structured: StructuredQuestionT | null;
  /** 本候选 staged 的 source_asset ids（commit 失败/拒绝时供即时回收；日常由 reaper 兜底）。 */
  stagedAssetIds: string[];
}

export interface JyeooDroppedCandidate {
  sourceUrl: string | null;
  sourceId: string | null;
  reason:
    | 'invalid'
    | 'filtered_url'
    | 'filtered_kind'
    | 'filtered_band'
    | 'filtered_image'
    | 'duplicate_exact'
    | 'near_dup_in_batch';
}

export interface JyeooFetchCandidatesCounts {
  requested: number;
  fetched: number;
  validated: number;
  invalid: number;
  filtered_url: number;
  filtered_kind: number;
  filtered_band: number;
  filtered_image: number;
  deduped_exact: number;
  near_dup_in_batch: number;
  candidates: number;
}

export interface JyeooBudgetView {
  dailyBudget: number;
  remainingBefore: number;
  remainingAfter: number;
}

export type JyeooFetchCandidatesResult =
  | {
      status: 'ok';
      runId: string;
      candidates: JyeooCandidate[];
      dropped: JyeooDroppedCandidate[];
      counts: JyeooFetchCandidatesCounts;
      budget: JyeooBudgetView;
    }
  | { status: 'budget_exhausted'; budget: JyeooBudgetView }
  | {
      status: 'failed';
      failureClass: JyeooFailureClass;
      detail: string;
      retryable: boolean;
      counts: JyeooFetchCandidatesCounts;
      budget: JyeooBudgetView;
    };

export interface RunJyeooFetchCandidatesParams {
  db: Db;
  input: JyeooFetchCandidatesInput;
  spawnJyeooFn?: SpawnJyeooFn;
  /**
   * r2 惰性解析器：仅当存活候选带图时调用一次。caller（DomainTool / CLI）负责注入
   * （本目录不得持 '@/server/' 运行时边，见 ownership.unit.test.ts）。
   */
  resolveR2?: () => R2Client;
  now?: Date;
}

// ── image pipeline（自旧 handler 迁移，语义不变） ─────────────────────────────

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
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  return null;
}

async function loadLocalizedQuestionImages(
  q: SourcedQuestionT,
  imageDir: string,
): Promise<LoadedQuestionImages | null> {
  const markdownFields = [q.prompt_md, ...(q.choices_md ?? []), q.reference_md ?? ''];
  if (markdownFields.some((markdown) => hasMalformedMarkdownImage(markdown))) {
    console.warn('[jyeoo_candidates] malformed markdown image; filtering question');
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
      console.warn('[jyeoo_candidates] image was not localized under the run directory:', source);
      return null;
    }
    try {
      // Resolve symlinks before the containment check. A lexical `/run/link.png` can point
      // outside the per-run directory and must not become an arbitrary-file read primitive.
      const path = await realpath(resolve(source));
      const pathFromRoot = relative(root, path);
      if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
        console.warn('[jyeoo_candidates] image realpath escaped the run directory:', source);
        return null;
      }
      const info = await stat(path);
      if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_UPLOAD_BYTES) {
        console.warn('[jyeoo_candidates] localized image failed file/size validation:', source);
        return null;
      }
      const file = await readFile(path);
      const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
      const mime = detectImageMime(bytes);
      if (mime === null) {
        console.warn('[jyeoo_candidates] localized image failed size/mime validation:', source);
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
        console.warn('[jyeoo_candidates] localized image failed decode validation:', source);
        return null;
      }
      images.push({ source, bytes, mime, sha256: await sha256Hex(bytes) });
    } catch (err) {
      console.warn(
        '[jyeoo_candidates] localized image unavailable; filtering question:',
        source,
        err,
      );
      return null;
    }
  }
  return { images, attachedSources };
}

export async function canonicalJyeooQuestionHash(
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
  candidateId: string,
  fetchRunId: string,
): Promise<PersistedQuestionImages> {
  const replacements = new Map<string, string>();
  const assetIdsBySource = new Map<string, string>();
  const assets: SourceAssetRow[] = [];
  try {
    for (const image of loaded.images) {
      const asset = await persistImageAsset(db, r2, {
        bytes: image.bytes,
        mime: image.mime,
        provenance: { origin: 'jyeoo_staged', fetch_run_id: fetchRunId },
        compensatePutOnInsertFailure: true,
      });
      assets.push(asset);
      replacements.set(image.source, `/api/assets/${encodeURIComponent(asset.id)}/content`);
      assetIdsBySource.set(image.source, asset.id);
    }
  } catch (err) {
    await cleanupStagedAssets(db, assets, r2);
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
    // candidate id 占位；store_sourced_question commit 时重写为真实 question id。
    attached_to_index: candidateId,
    attach_confidence: 'high',
  }));
  const structured: StructuredQuestionT = {
    id: candidateId,
    role: 'standalone',
    prompt_text: qWithInternalUrls.prompt_md,
    ...(qWithInternalUrls.reference_md ? { answers: [qWithInternalUrls.reference_md] } : {}),
  };
  return { q: qWithInternalUrls, figures, imageRefs, structured, assets };
}

/** 删除 staged source_asset 行；R2 对象仅在没有其他 owner 时删（content-addressed 共享）。 */
export async function cleanupStagedAssets(
  db: Db,
  assets: readonly SourceAssetRow[],
  r2: R2Client = getR2(),
): Promise<void> {
  if (assets.length === 0) return;
  const ownedIds = new Set(assets.map((asset) => asset.id));
  const storageKeys = [...new Set(assets.map((asset) => asset.storage_key))].sort();
  await db.transaction(async (tx) => {
    // Lock in lexical order to avoid multi-image deadlocks. persistImageAsset takes the same
    // lock before R2 put, so cleanup cannot race a writer whose owner row is not visible yet.
    for (const storageKey of storageKeys) await lockImageStorageKey(tx, storageKey);
    for (const storageKey of storageKeys) {
      const owners = await tx
        .select({ id: source_asset.id })
        .from(source_asset)
        .where(eq(source_asset.storage_key, storageKey));
      // If deletion fails, the transaction rolls back and durable owner rows remain. Other
      // committed owners keep a shared content-addressed blob in place.
      if (owners.every((owner) => ownedIds.has(owner.id))) await r2.delete(storageKey);
    }
    await tx.delete(source_asset).where(inArray(source_asset.id, [...ownedIds]));
  });
}

// ── fetch 核 ─────────────────────────────────────────────────────────────────

const emptyCounts = (requested: number): JyeooFetchCandidatesCounts => ({
  requested,
  fetched: 0,
  validated: 0,
  invalid: 0,
  filtered_url: 0,
  filtered_kind: 0,
  filtered_band: 0,
  filtered_image: 0,
  deduped_exact: 0,
  near_dup_in_batch: 0,
  candidates: 0,
});

/**
 * 跑一次 grade-route 抓取，返回自包含候选（不写 question）。Budget pre-flight 把
 * sessionMax 裁到日预算余额内；余额为 0 直接 budget_exhausted 短路（不 spawn）。
 * 失败分类与旧 handler 一致（auth/network/timeout/parse/args/spawn/vip/unknown）。
 */
export async function runJyeooFetchCandidates(
  params: RunJyeooFetchCandidatesParams,
): Promise<JyeooFetchCandidatesResult> {
  const { db, input } = params;
  const now = params.now ?? new Date();
  const spawnJyeoo = params.spawnJyeooFn ?? spawnJyeooFetch;
  const runId = `jyeoo_candidates_${createId()}`;

  // ── budget pre-flight（事件溯源读数；producer --daily-max 是硬闸兜底） ──────
  const dailyBudget = jyeooDailyFetchBudget();
  const remainingBefore = await jyeooBudgetRemaining(db, now);
  if (remainingBefore <= 0) {
    return {
      status: 'budget_exhausted',
      budget: { dailyBudget, remainingBefore, remainingAfter: remainingBefore },
    };
  }
  const sessionMax = Math.min(input.sessionMax, remainingBefore);
  const counts = emptyCounts(sessionMax);
  const budget: JyeooBudgetView = {
    dailyBudget,
    remainingBefore,
    // 成功路径在返回前用实际 fetched 修正；失败路径保守按 0 消耗。
    remainingAfter: remainingBefore,
  };

  const imageDir = await mkdtemp(join(tmpdir(), 'loom-jyeoo-'));
  const args = [
    'grade',
    '--grade',
    String(input.grade),
    '--subjects',
    input.subject,
    '--pages',
    String(input.pages),
    '--max-papers',
    String(input.maxPapers),
    '--session-max',
    String(sessionMax),
    '--emit',
    'loom',
    '--images',
    imageDir,
  ];

  try {
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
      return {
        status: 'failed',
        failureClass: 'spawn',
        detail: `spawn failed: ${(spawnErr as Error).message}`,
        retryable: false,
        counts,
        budget,
      };
    }

    const classification = classifyJyeooExit(spawnResult);
    if (classification.failure !== null || spawnResult.stdoutTruncated) {
      const failureClass: JyeooFailureClass = classification.failure ?? 'unknown';
      return {
        status: 'failed',
        failureClass,
        detail: spawnResult.stdoutTruncated
          ? `stdout exceeded ${jyeooSpawnMaxStdoutBytes()} bytes; batch discarded (possible mid-stream truncation)`
          : `jyeoo-rs exit ${spawnResult.exitCode}${spawnResult.signal ? ` signal ${spawnResult.signal}` : ''}: ${stderrTail(spawnResult.stderr)}`,
        retryable: classification.failure !== null ? classification.retryable : false,
        counts,
        budget,
      };
    }

    // ── parse NDJSON（vip belt 保留：新 producer 不发 vip 字段则自动失效） ────
    const dropped: JyeooDroppedCandidate[] = [];
    const validQuestions: Array<{ q: SourcedQuestionT; hints: string[]; sourceId: string | null }> =
      [];
    let vipViolation = false;
    for (const line of spawnResult.lines) {
      const parsed = parseJyeooLine(line);
      if (!parsed.ok) {
        if (parsed.reason !== 'blank') {
          counts.invalid += 1;
          counts.fetched += 1;
          dropped.push({ sourceUrl: null, sourceId: null, reason: 'invalid' });
        }
        continue;
      }
      counts.fetched += 1;
      counts.validated += 1;
      if (parsed.jyeoo.vip === false) vipViolation = true;
      validQuestions.push({
        q: parsed.question,
        hints: parsed.jyeoo.knowledge_hints ?? [],
        sourceId: parsed.jyeoo.id ?? null,
      });
    }
    if (vipViolation) {
      return {
        status: 'failed',
        failureClass: 'vip',
        detail:
          'producer emitted a non-VIP (vip:false) line; whole batch discarded (VIP expiry ⇒ hole-punched reference_md must not be ingested)',
        retryable: false,
        counts,
        budget,
      };
    }

    // ── pre-persist filters（foreign host / kind pin / band post-filter） ─────
    const preFiltered: typeof validQuestions = [];
    for (const item of validQuestions) {
      if (isForeignSourceHost(item.q.source_url, JYEOO_SOURCE_HOST)) {
        counts.filtered_url += 1;
        dropped.push({
          sourceUrl: item.q.source_url,
          sourceId: item.sourceId,
          reason: 'filtered_url',
        });
        continue;
      }
      if (input.kind && !kindsMatch(item.q.kind, input.kind)) {
        counts.filtered_kind += 1;
        dropped.push({
          sourceUrl: item.q.source_url,
          sourceId: item.sourceId,
          reason: 'filtered_kind',
        });
        continue;
      }
      if (input.difficultyBand && !difficultyInBand(item.q.difficulty, input.difficultyBand)) {
        counts.filtered_band += 1;
        dropped.push({
          sourceUrl: item.q.source_url,
          sourceId: item.sourceId,
          reason: 'filtered_band',
        });
        continue;
      }
      preFiltered.push(item);
    }

    // ── per-candidate: image load → canonical hash → dup 判定 → stage assets ──
    const batchPrompts: string[] = [];
    const candidates: JyeooCandidate[] = [];
    let imageR2: R2Client | undefined;
    for (const item of preFiltered) {
      const loadedImages = await loadLocalizedQuestionImages(item.q, imageDir);
      if (loadedImages === null) {
        counts.filtered_image += 1;
        dropped.push({
          sourceUrl: item.q.source_url,
          sourceId: item.sourceId,
          reason: 'filtered_image',
        });
        continue;
      }
      if (loadedImages.images.length > 0 && imageR2 === undefined) {
        try {
          imageR2 = (params.resolveR2 ?? getR2)();
        } catch (err) {
          // Credentials are intentionally lazy: a missing R2 config filters this image question
          // but never blocks pure-text candidates from the same producer batch.
          console.warn('[jyeoo_candidates] R2 unavailable; filtering image question:', err);
          counts.filtered_image += 1;
          dropped.push({
            sourceUrl: item.q.source_url,
            sourceId: item.sourceId,
            reason: 'filtered_image',
          });
          continue;
        }
      }

      const canonicalHash = await canonicalJyeooQuestionHash(item.q, loadedImages);

      // 全局 exact-dup（advisory）：任何带同 hash 的 row（含 terminal-rejected draft——
      // 内容相同的题本就会被 verify 再拒，保守判重）都让候选丢弃。commit 侧的
      // mergeExact + ON CONFLICT 仍是权威判定。
      const existing = await db
        .select({ id: question.id })
        .from(question)
        .where(eq(question.canonical_content_hash, canonicalHash))
        .limit(1);
      if (existing.length > 0) {
        counts.deduped_exact += 1;
        dropped.push({
          sourceUrl: item.q.source_url,
          sourceId: item.sourceId,
          reason: 'duplicate_exact',
        });
        continue;
      }

      // in-batch near-dup（text-only；图片题跳过文本 n-gram，靠 image-aware exact hash）。
      if (loadedImages.images.length === 0) {
        const overlap = maxNgramOverlap(item.q.prompt_md, batchPrompts);
        if (overlap >= JYEOO_NEAR_DUP_THRESHOLD) {
          counts.near_dup_in_batch += 1;
          dropped.push({
            sourceUrl: item.q.source_url,
            sourceId: item.sourceId,
            reason: 'near_dup_in_batch',
          });
          continue;
        }
      }

      // 存活候选：stage 图片到 R2 + source_asset（origin='jyeoo_staged'）。
      const candidateId = createId();
      let media: PersistedQuestionImages | null = null;
      if (loadedImages.images.length > 0) {
        media = await persistQuestionImages(
          db,
          imageR2 as R2Client,
          item.q,
          loadedImages,
          candidateId,
          runId,
        );
      }
      const stagedQuestion = media?.q ?? item.q;
      candidates.push({
        candidateId,
        question:
          loadedImages.images.length > 0
            ? // jyeoo-rs 的 extraction_hash 含本次随机 temp 路径（--images 本地化后计算），
              // 用 loom 的 URL 无关 canonical hash 替换这个不稳定 provenance；文本题保持原样。
              { ...stagedQuestion, extraction_hash: `sha256:${canonicalHash}` }
            : stagedQuestion,
        extractionHash: `sha256:${canonicalHash}`,
        knowledgeHints: item.hints,
        sourceId: item.sourceId,
        figures: media?.figures ?? null,
        imageRefs: media?.imageRefs ?? null,
        structured: media?.structured ?? null,
        stagedAssetIds: media?.assets.map((asset) => asset.id) ?? [],
      });
      batchPrompts.push(item.q.prompt_md);
    }
    counts.candidates = candidates.length;
    budget.remainingAfter = Math.max(0, remainingBefore - counts.fetched);

    return { status: 'ok', runId, candidates, dropped, counts, budget };
  } finally {
    await rm(imageDir, { recursive: true, force: true }).catch((err) => {
      console.warn('[jyeoo_candidates] failed to remove image temp directory:', imageDir, err);
    });
  }
}

/** Truncate a stderr tail for the failure detail (bounded — the full stderr is already capped). */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= 500) return trimmed;
  return `…${trimmed.slice(-500)}`;
}
