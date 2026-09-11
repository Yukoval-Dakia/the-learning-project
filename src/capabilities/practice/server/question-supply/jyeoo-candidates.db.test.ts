// YUK-986 (Supply-Agent/1) — jyeoo-candidates 核心管线行为测试（db 分区）。
//
// 旧 jobs/jyeoo-fetch.db.test.ts 的行为覆盖移植到 tool seam：NDJSON 解析 → 过滤 →
// dedup → 图片本地化/staging → 自包含候选 envelope。变化点（与旧 handler 对照）：
//   - 无 anchor KC / keyword / --dg（producer grade 路线不支持）；band 是 post-filter。
//   - 无 VIP 闸（新 producer 不发 vip 字段；exit-6 分类保留为 belt）。
//   - 不写库（题）：候选 staged 图片资产即期持久化，题面入库在 store_sourced_question。
//   - 预算：事件溯源日租约 pre-flight（producer 40/日硬闸是第二道）。
// spawn 用 fake（构造 NDJSON + 种图片文件到 --images 目录）；db 用真 testcontainer。

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import { event, question, source_asset } from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { memR2 } from '../../../../../tests/helpers/r2';
import {
  type JyeooFetchCandidatesInput,
  canonicalJyeooQuestionHash,
  runJyeooFetchCandidates,
} from './jyeoo-candidates';
import type { SpawnJyeooFn, SpawnJyeooResult } from './jyeoo-spawn';

const db = testDb();

beforeEach(() => resetDb());

const NOW = new Date('2026-09-11T10:00:00Z');

function baseQuestion(overrides: Partial<SourcedQuestionT> = {}): SourcedQuestionT {
  return {
    kind: 'short_answer',
    prompt_md: '已知集合 A={1,2,3}，B={2,3,4}，求 A∩B 的元素个数。',
    reference_md: '【答案】2\n【分析】交集定义。\n【解答】A∩B={2,3}，共 2 个元素。',
    difficulty: 3,
    source_url: 'https://www.jyeoo.com/math2/ques/detail/abc-1',
    source_title: '2025 年某校高二期中卷',
    knowledge_ids: [],
    extract: '集合 A={1,2,3}，B={2,3,4}，求 A∩B 的元素个数。答案：2',
    ...overrides,
  } as SourcedQuestionT;
}

function loomLine(q: SourcedQuestionT, meta: Record<string, unknown> = {}): string {
  return JSON.stringify({
    question: q,
    jyeoo: { id: 'jyeoo-1', subject: 'math2', knowledge_hints: ['集合'], ...meta },
  });
}

function okResult(lines: string[]): SpawnJyeooResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    lines,
    stdoutTruncated: false,
    stderr: '',
    stderrTruncated: false,
  };
}

function fakeSpawn(lines: string[] | ((args: string[]) => Promise<string[]>)): SpawnJyeooFn {
  return async (opts) => {
    const resolved = typeof lines === 'function' ? await lines(opts.args) : lines;
    return okResult(resolved);
  };
}

const INPUT: JyeooFetchCandidatesInput = {
  grade: 11,
  subject: 'math2',
  pages: 2,
  maxPapers: 2,
  sessionMax: 10,
};

describe('runJyeooFetchCandidates — parse + filter pipeline', () => {
  it('returns self-contained candidates with loom canonical hash and passthrough hints', async () => {
    const q = baseQuestion();
    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: fakeSpawn([loomLine(q, { knowledge_hints: ['集合', '运算'] })]),
      now: NOW,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(candidate.extractionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(candidate.extractionHash).toBe(
      `sha256:${await canonicalJyeooQuestionHash(q, { images: [], attachedSources: new Set() })}`,
    );
    expect(candidate.knowledgeHints).toEqual(['集合', '运算']);
    expect(candidate.sourceId).toBe('jyeoo-1');
    expect(candidate.figures).toBeNull();
    expect(candidate.stagedAssetIds).toEqual([]);
    expect(result.counts.fetched).toBe(1);
    expect(result.counts.candidates).toBe(1);
    // 预算视图：成功后 remainingAfter = remainingBefore - fetched。
    expect(result.budget.remainingAfter).toBe(result.budget.remainingBefore - 1);
  });

  it('drops invalid lines without sinking the batch', async () => {
    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: fakeSpawn(['{not json', loomLine(baseQuestion())]),
      now: NOW,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.counts.invalid).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.dropped.map((d) => d.reason)).toContain('invalid');
  });

  it('filters foreign-host sources (extract.url host must be jyeoo)', async () => {
    const foreign = baseQuestion({
      extract: 'https://evil.example.com/x',
      source_url: 'https://evil.example.com/x',
    });
    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: fakeSpawn([loomLine(foreign)]),
      now: NOW,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.candidates).toHaveLength(0);
    expect(result.counts.filtered_url).toBe(1);
  });

  it('kind pin filters non-matching kinds', async () => {
    const result = await runJyeooFetchCandidates({
      db,
      input: { ...INPUT, kind: 'choice' },
      spawnJyeooFn: fakeSpawn([loomLine(baseQuestion())]), // short_answer
      now: NOW,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.counts.filtered_kind).toBe(1);
    expect(result.candidates).toHaveLength(0);
  });

  it('difficulty band post-filter maps below/near/above/stretch onto 1-5 difficulty', async () => {
    const lines = [1, 2, 3, 4, 5].map((d) =>
      loomLine(baseQuestion({ difficulty: d, prompt_md: `难度 ${d} 的集合题，求交集元素个数。` })),
    );
    const near = await runJyeooFetchCandidates({
      db,
      input: { ...INPUT, difficultyBand: 'near' },
      spawnJyeooFn: fakeSpawn(lines),
      now: NOW,
    });
    expect(near.status).toBe('ok');
    if (near.status !== 'ok') return;
    expect(near.candidates.map((c) => c.question.difficulty)).toEqual([3]);
    expect(near.counts.filtered_band).toBe(4);

    const below = await runJyeooFetchCandidates({
      db,
      input: { ...INPUT, difficultyBand: 'below' },
      spawnJyeooFn: fakeSpawn(lines),
      now: NOW,
    });
    expect(below.status).toBe('ok');
    if (below.status !== 'ok') return;
    expect(below.candidates.map((c) => c.question.difficulty).sort()).toEqual([1, 2]);
  });
});

describe('runJyeooFetchCandidates — dedup', () => {
  it('drops exact duplicates already in the pool (canonical hash match)', async () => {
    const q = baseQuestion();
    const hash = await canonicalJyeooQuestionHash(q, { images: [], attachedSources: new Set() });
    const now = new Date('2026-09-01T00:00:00Z');
    await db.insert(question).values({
      id: 'q-existing',
      kind: 'short_answer',
      prompt_md: q.prompt_md,
      reference_md: q.reference_md,
      knowledge_ids: [],
      difficulty: 3,
      source: 'jyeoo',
      metadata: null as never,
      draft_status: null,
      variant_depth: 0,
      canonical_content_hash: hash,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: fakeSpawn([loomLine(q)]),
      now: NOW,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.candidates).toHaveLength(0);
    expect(result.counts.deduped_exact).toBe(1);
    expect(result.dropped[0]?.reason).toBe('duplicate_exact');
  });

  it('drops in-batch near-duplicates (second of two near-identical prompts)', async () => {
    const a = baseQuestion({ prompt_md: '已知函数 f(x)=x²+2x+1，求 f(2) 的值。' });
    const b = baseQuestion({ prompt_md: '已知函数 f(x)=x²+2x+1，求 f(2) 的值！' });
    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: fakeSpawn([loomLine(a), loomLine(b)]),
      now: NOW,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.candidates).toHaveLength(1);
    expect(result.counts.near_dup_in_batch).toBe(1);
  });
});

describe('runJyeooFetchCandidates — image pipeline', () => {
  it('stages images to R2 + source_asset and rewrites prompt to internal URLs', async () => {
    const r2 = memR2();
    const jpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();

    let imageDir = '';
    const spawn: SpawnJyeooFn = async (opts) => {
      const imagesIdx = opts.args.indexOf('--images');
      const dir = opts.args[imagesIdx + 1];
      if (dir === undefined) throw new Error('--images arg missing');
      imageDir = dir;
      const imagePath = join(imageDir, 'fig-0.jpg');
      await writeFile(imagePath, jpeg);
      const q = baseQuestion({
        prompt_md: `如图，![](${imagePath})所示的几何图形，求面积。`,
      });
      return okResult([loomLine(q)]);
    };

    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: spawn,
      resolveR2: () => r2,
      now: NOW,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(candidate.question.prompt_md).toMatch(/\/api\/assets\/[a-z0-9]+\/content/);
    expect(candidate.question.prompt_md).not.toContain(imageDir);
    expect(candidate.imageRefs).toHaveLength(1);
    expect(candidate.figures).toHaveLength(1);
    expect(candidate.figures?.[0]?.attached_to_index).toBe(candidate.candidateId);
    expect(candidate.structured?.id).toBe(candidate.candidateId);
    expect(candidate.stagedAssetIds).toHaveLength(1);
    // staged 资产行 + R2 对象 + provenance 标记（reaper 的回收凭据）。
    const firstStagedId = candidate.stagedAssetIds[0];
    expect(firstStagedId).toBeDefined();
    const [asset] = await db
      .select()
      .from(source_asset)
      .where(eq(source_asset.id, firstStagedId ?? 'missing'));
    expect(asset).toBeTruthy();
    expect((asset?.provenance as { origin?: string }).origin).toBe('jyeoo_staged');
    expect(r2._store.size).toBe(1);
    // 图题的 provenance hash 被 loom canonical 替换（producer hash 含随机 temp 路径，不稳定）。
    expect(candidate.question.extraction_hash).toBe(candidate.extractionHash);
  });

  it('filters image questions when the localized file is missing (never persists external refs)', async () => {
    const q = baseQuestion({ prompt_md: '如图 ![](/nonexistent/fig.jpg) 所示，求面积。' });
    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: fakeSpawn([loomLine(q)]),
      resolveR2: () => memR2(),
      now: NOW,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.candidates).toHaveLength(0);
    expect(result.counts.filtered_image).toBe(1);
  });
});

describe('runJyeooFetchCandidates — failure classification + budget', () => {
  it('maps exit 3 to terminal auth', async () => {
    const spawn: SpawnJyeooFn = async () => ({
      ...okResult([]),
      exitCode: 3,
      stderr: 'token expired',
    });
    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: spawn,
      now: NOW,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failureClass).toBe('auth');
    expect(result.retryable).toBe(false);
  });

  it('maps exit 6 to terminal vip', async () => {
    const spawn: SpawnJyeooFn = async () => ({
      ...okResult([]),
      exitCode: 6,
      stderr: 'vip required',
    });
    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: spawn,
      now: NOW,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failureClass).toBe('vip');
    expect(result.retryable).toBe(false);
  });

  it('maps exit 4 to retryable network', async () => {
    const spawn: SpawnJyeooFn = async () => ({
      ...okResult([]),
      exitCode: 4,
      stderr: 'connection reset',
    });
    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: spawn,
      now: NOW,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failureClass).toBe('network');
    expect(result.retryable).toBe(true);
  });

  it('maps exit 1 to terminal unknown (fail loud)', async () => {
    const spawn: SpawnJyeooFn = async () => ({ ...okResult([]), exitCode: 1, stderr: 'boom' });
    const result = await runJyeooFetchCandidates({
      db,
      input: INPUT,
      spawnJyeooFn: spawn,
      now: NOW,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failureClass).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('refuses pre-flight when the event-sourced daily budget is exhausted (spawn never called)', async () => {
    const dayStart = new Date(Date.UTC(2026, 8, 10, 16, 0, 0)); // 2026-09-11 00:00 Asia/Shanghai
    await db.insert(event).values({
      id: 'evt-budget-seed-1',
      actor_kind: 'agent',
      actor_ref: 'jyeoo_fetch',
      action: 'experimental:jyeoo_fetch',
      subject_kind: 'query',
      subject_id: 'seed-run',
      outcome: 'success',
      task_run_id: 'seed-run',
      payload: { counts: { fetched: 40 } },
      created_at: dayStart,
    });
    let spawnCalled = false;
    const spawn: SpawnJyeooFn = async () => {
      spawnCalled = true;
      return okResult([]);
    };
    const result = await runJyeooFetchCandidates({
      db,
      input: { ...INPUT, sessionMax: 10 },
      spawnJyeooFn: spawn,
      now: NOW,
    });
    expect(result.status).toBe('budget_exhausted');
    expect(spawnCalled).toBe(false);
  });

  it('clips session_max to remaining budget', async () => {
    const dayStart = new Date(Date.UTC(2026, 8, 10, 16, 0, 0));
    await db.insert(event).values({
      id: 'evt-budget-seed-2',
      actor_kind: 'agent',
      actor_ref: 'jyeoo_fetch',
      action: 'experimental:jyeoo_fetch',
      subject_kind: 'query',
      subject_id: 'seed-run',
      outcome: 'success',
      task_run_id: 'seed-run',
      payload: { counts: { fetched: 38 } },
      created_at: dayStart,
    });
    let sessionMaxArg: string | null = null;
    const spawn: SpawnJyeooFn = async (opts) => {
      const idx = opts.args.indexOf('--session-max');
      sessionMaxArg = opts.args[idx + 1] ?? null;
      return okResult([]);
    };
    const result = await runJyeooFetchCandidates({
      db,
      input: { ...INPUT, sessionMax: 10 },
      spawnJyeooFn: spawn,
      now: NOW,
    });
    expect(result.status).toBe('ok');
    expect(sessionMaxArg).toBe('2');
  });
});
