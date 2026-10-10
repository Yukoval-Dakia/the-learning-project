// YUK-986 (Supply-Agent/1) — store_sourced_question commit tool db 测试。
//
// 锁死 commit 权威边界（agent 永远不在正确性路径上）：
//   dead knowledge / foreign-host / exact-dup merge / KC-scoped near-dup / insert+verify 链。
// YUK-990 增补图题 commit 全路径：figures.attached_to_index / structured.id 占位重写、
//   judge_kind_override='multimodal_direct'（选择支会短路图片 auto-route）、
//   拒绝路径 staged 资产即时清理（cleanupStagedForRejected）、raced_merged 竞态补偿。
// enqueueSourceVerify 注入 fake（不依赖真 pg-boss）；staged 资产用 memR2 + 真 source_asset。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { knowledge, question, source_asset } from '@/db/schema';
import type { R2Client } from '@/server/r2';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { memR2 } from '../../../../../tests/helpers/r2';
import { canonicalJyeooQuestionHash } from '../question-supply/jyeoo-candidates';
import {
  type StoreSourcedQuestionDeps,
  executeStoreSourcedQuestion,
} from './store-sourced-question';

// cleanupStagedForRejected → cleanupStagedAssets 的 r2 走默认参数 getR2()（无注入 seam）。
// mock '@/server/r2' 让测试注入 memR2 从而断言 R2 对象回收；未设置时保持与生产缺 env
// 相同的抛错行为（调用方 catch 后降级给 reaper）。本文件只有 staged_asset_ids 非空的
// 用例会触达 getR2()，既有用例（staged_asset_ids=[]）早退、不受影响。
const stagedR2 = vi.hoisted(() => ({ client: null as R2Client | null }));
vi.mock('@/server/r2', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/server/r2')>();
  return {
    ...mod,
    getR2: () => {
      if (!stagedR2.client) throw new Error('R2 env not configured (test stub)');
      return stagedR2.client;
    },
  };
});

const db = testDb();

beforeEach(() => resetDb());

const NOW = new Date('2026-09-01T00:00:00Z');

async function seedTree(): Promise<void> {
  await db.insert(knowledge).values([
    {
      id: 'math-root',
      name: '数学',
      domain: 'math',
      parent_id: null,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-sets',
      name: '集合',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-dead',
      name: '已归档',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
      archived_at: NOW,
    },
  ]);
}

function sourced(overrides: Partial<SourcedQuestionT> = {}): SourcedQuestionT {
  return {
    kind: 'short_answer',
    prompt_md: '已知集合 A={1,2,3}，B={2,3,4}，求 A∩B。',
    reference_md: '【答案】{2,3}\n【分析】交集。\n【解答】A∩B={2,3}。',
    difficulty: 3,
    source_url: 'https://www.jyeoo.com/math2/ques/detail/x-1',
    source_title: '2025 某校卷',
    knowledge_ids: [],
    extract: '已知集合 A={1,2,3}，B={2,3,4}，求 A∩B。答案：{2,3}',
    ...overrides,
  } as SourcedQuestionT;
}

async function candidateOf(
  q: SourcedQuestionT,
  overrides: Record<string, unknown> = {},
): Promise<Parameters<typeof executeStoreSourcedQuestion>[1]['candidate']> {
  return {
    candidate_id: 'cand-test-1',
    question: q,
    extraction_hash: `sha256:${await canonicalJyeooQuestionHash(q, { images: [], attachedSources: new Set() })}`,
    knowledge_hints: ['集合'],
    source_id: 'jyeoo-1',
    figures: null,
    image_refs: null,
    structured: null,
    staged_asset_ids: [],
    ...overrides,
  } as Parameters<typeof executeStoreSourcedQuestion>[1]['candidate'];
}

function inputOf(
  candidate: Awaited<ReturnType<typeof candidateOf>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    source_route: 'jyeoo_fetch' as const,
    candidate,
    knowledge_ids: ['kc-sets'],
    attribution_state: 'matched' as const,
    subject_id: 'math',
    ...overrides,
  };
}

function fakeEnqueue(captured: string[][]): StoreSourcedQuestionDeps {
  return {
    enqueueSourceVerify: async (ids) => {
      captured.push(ids);
    },
  };
}

describe('executeStoreSourcedQuestion — deterministic rejections', () => {
  it('merges exact duplicates into the existing row (KC union) without a new insert', async () => {
    await seedTree();
    const q = sourced();
    const hash = await canonicalJyeooQuestionHash(q, { images: [], attachedSources: new Set() });
    await db.insert(question).values({
      id: 'q-existing',
      kind: 'short_answer',
      prompt_md: q.prompt_md,
      reference_md: q.reference_md,
      knowledge_ids: ['math-root'],
      difficulty: 3,
      source: 'jyeoo',
      metadata: null as never,
      draft_status: null,
      variant_depth: 0,
      canonical_content_hash: hash,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });

    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(q)),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'duplicate_exact' });
    if (output.status !== 'rejected') return;
    expect(output.existing_question_id).toBe('q-existing');
    const [existing] = await db.select().from(question).where(eq(question.id, 'q-existing'));
    expect(new Set(existing?.knowledge_ids)).toEqual(new Set(['math-root', 'kc-sets']));
    const all = await db.select().from(question);
    expect(all).toHaveLength(1);
  });
});

// ── 图题 commit（YUK-990）───────────────────────────────────────────────────
//
// fetch 核（jyeoo-candidates.ts persistQuestionImages）把候选图片即期持久化为
// source_asset(origin='jyeoo_staged') + R2 对象，并把 prompt_md 的 markdown 图片
// URL 改写为内部 /api/assets/<id>/content；figures.attached_to_index 与
// structured.id 先写 candidate_id 占位，commit 时由本工具重写为真实 question id。
// 以下测试直接用该产物形态构造 candidate（不跑 fetch 核）。

const IMG_ASSET_ID = 'asset-img-1';
const IMG_URL = `/api/assets/${IMG_ASSET_ID}/content`;
const IMG_SHA256 = 'a'.repeat(64);

/** 生产形态的图题候选题面：选择题 + 已改写为内部 asset URL 的 markdown 图。 */
function imageSourced(overrides: Partial<SourcedQuestionT> = {}): SourcedQuestionT {
  return {
    kind: 'choice',
    prompt_md: `如图，![](${IMG_URL})所示的几何图形中，阴影部分的面积是多少？`,
    reference_md: '【答案】B\n【分析】由图可知阴影部分为半圆。\n【解答】S=πr²/2=3。',
    choices_md: ['A. 2', 'B. 3', 'C. 4', 'D. 5'],
    difficulty: 3,
    source_url: 'https://www.jyeoo.com/math2/ques/detail/img-1',
    source_title: '2025 某校卷·图题',
    knowledge_ids: [],
    extract: '如图几何图形，阴影部分面积。答案：B。S=πr²/2=3',
    ...overrides,
  } as SourcedQuestionT;
}

/** fetch 核的 image-aware canonical hash（URL → 'IMAGE' 归一 + 像素 digest 进身份）。 */
async function imageExtractionHash(q: SourcedQuestionT): Promise<string> {
  const hash = await canonicalJyeooQuestionHash(q, {
    images: [
      {
        source: IMG_URL,
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        mime: 'image/png',
        sha256: IMG_SHA256,
      },
    ],
    attachedSources: new Set([IMG_URL]),
  });
  return `sha256:${hash}`;
}

/** candidate_id 占位的图片附件三件套——commit 必须把占位重写为 question id。 */
function imageMedia(candidateId: string): {
  figures: FigureRefT[];
  image_refs: string[];
  structured: StructuredQuestionT;
} {
  return {
    figures: [
      {
        asset_id: IMG_ASSET_ID,
        role: 'diagram',
        source_page_index: 0,
        source_bbox: { x: 0, y: 0, width: 1, height: 1 },
        attached_to_index: candidateId,
        attach_confidence: 'high',
      },
    ],
    image_refs: [IMG_ASSET_ID],
    structured: {
      id: candidateId,
      role: 'standalone',
      prompt_text: `如图，![](${IMG_URL})所示的几何图形中，阴影部分的面积是多少？`,
      options: [
        { label: 'A', text: '2' },
        { label: 'B', text: '3' },
        { label: 'C', text: '4' },
        { label: 'D', text: '5' },
      ],
      answers: ['B'],
    },
  };
}

/** staged 资产种子：真 source_asset 行 + memR2 对象（与 fetch 核 persistImageAsset 同形态）。 */
async function seedStagedAsset(
  r2: ReturnType<typeof memR2>,
  id: string,
): Promise<{ id: string; storageKey: string }> {
  const storageKey = `assets/${id}`;
  await db.insert(source_asset).values({
    id,
    kind: 'image',
    storage_key: storageKey,
    mime_type: 'image/png',
    byte_size: 4,
    sha256: IMG_SHA256,
    provenance: { origin: 'jyeoo_staged', fetch_run_id: 'run-test' },
    created_at: NOW,
  });
  r2._store.set(storageKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  return { id, storageKey };
}

/**
 * 确定性复现 canonical-hash 并发 race：execute 的 db.transaction 调用序固定为
 *   #1 = exact-dup 预检 tx（此刻冲突行尚不存在 → peek 必然 miss → 返回 null）；
 *   #2 = insert+链接+verify-intent tx。
 * 在 #2 的 callback 执行前用原 db 提交一条同 hash 的 winner 行，等价于「预检 miss
 * 之后、本 tx INSERT 之前另一并发插入已提交获胜」——insertSourcedDraft 的
 * ON CONFLICT DO NOTHING 因而空返回，走真实的 raced_merged 合并路径。
 * （若实现在预检之前新增 transaction 调用，本注入会错位并被测试失败暴露。）
 */
function injectHashConflictOnInsertTx(db: Db, inject: () => Promise<unknown>): Db {
  let txCalls = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return (cb: (tx: Tx) => Promise<unknown>) => {
          txCalls += 1;
          const shouldInject = txCalls === 2;
          return target.transaction(async (tx) => {
            if (shouldInject) await inject();
            return cb(tx);
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('executeStoreSourcedQuestion — image candidate commit', () => {
  it('rejected duplicate_exact reclaims the candidate staged assets (row + R2 object)', async () => {
    await seedTree();
    const r2 = memR2();
    stagedR2.client = r2;
    await seedStagedAsset(r2, IMG_ASSET_ID);

    const q = imageSourced();
    const hash = (await imageExtractionHash(q)).slice('sha256:'.length);
    await db.insert(question).values({
      id: 'q-existing',
      kind: 'choice',
      prompt_md: q.prompt_md,
      reference_md: q.reference_md,
      choices_md: q.choices_md,
      knowledge_ids: ['math-root'],
      difficulty: 3,
      source: 'jyeoo',
      metadata: null as never,
      draft_status: null,
      variant_depth: 0,
      canonical_content_hash: hash,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });

    const media = imageMedia('cand-img-dup');
    const candidate = await candidateOf(q, {
      candidate_id: 'cand-img-dup',
      extraction_hash: `sha256:${hash}`,
      ...media,
      staged_asset_ids: [IMG_ASSET_ID],
    });
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(candidate),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'duplicate_exact' });
    if (output.status !== 'rejected') return;
    expect(output.existing_question_id).toBe('q-existing');

    // pre-check merge 拒绝路径调 cleanupStagedForRejected：staged source_asset 行 +
    // R2 对象即时回收（不等 24h reaper）。
    expect(await db.select().from(source_asset)).toHaveLength(0);
    expect(r2._store.size).toBe(0);
    const [existing] = await db.select().from(question).where(eq(question.id, 'q-existing'));
    expect(new Set(existing?.knowledge_ids)).toEqual(new Set(['math-root', 'kc-sets']));
    const all = await db.select().from(question);
    expect(all).toHaveLength(1);
  });

  it('raced_merged: canonical-hash race loser merges into the winner and reclaims staged assets', async () => {
    await seedTree();
    const r2 = memR2();
    stagedR2.client = r2;
    await seedStagedAsset(r2, IMG_ASSET_ID);

    const q = imageSourced();
    const hash = (await imageExtractionHash(q)).slice('sha256:'.length);
    const media = imageMedia('cand-img-race');
    const candidate = await candidateOf(q, {
      candidate_id: 'cand-img-race',
      extraction_hash: `sha256:${hash}`,
      ...media,
      staged_asset_ids: [IMG_ASSET_ID],
    });

    // winner 在 insert tx 内、本候选 INSERT 之前提交（模拟并发插入获胜）。
    const racyDb = injectHashConflictOnInsertTx(db, async () => {
      await db.insert(question).values({
        id: 'q-race-winner',
        kind: 'choice',
        prompt_md: q.prompt_md,
        reference_md: q.reference_md,
        choices_md: q.choices_md,
        knowledge_ids: ['math-root'],
        difficulty: 3,
        source: 'web_sourced',
        metadata: null as never,
        draft_status: 'draft',
        variant_depth: 0,
        canonical_content_hash: hash,
        created_at: NOW,
        updated_at: NOW,
        version: 0,
      });
    });

    const output = await executeStoreSourcedQuestion(
      { db: racyDb, taskRunId: 'test-run' },
      inputOf(candidate),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'duplicate_exact' });
    if (output.status !== 'rejected') return;
    expect(output.existing_question_id).toBe('q-race-winner');
    expect(output.detail).toContain('并发 canonical race');

    // 竞态补偿：不产生孤儿题行，目标 KC 并入 winner（YUK-720 cross-KC merge）；
    // 本候选的 staged 资产即时回收。
    const all = await db.select().from(question);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('q-race-winner');
    expect(new Set(all[0]?.knowledge_ids)).toEqual(new Set(['math-root', 'kc-sets']));
    expect(await db.select().from(source_asset)).toHaveLength(0);
    expect(r2._store.size).toBe(0);
  });
});
