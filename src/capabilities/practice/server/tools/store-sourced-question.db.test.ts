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
import { event, knowledge, question, source_asset } from '@/db/schema';
import { VERIFY_DISPATCH_INTENT_ACTION } from '@/server/boss/verify-dispatch-outbox';
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

describe('executeStoreSourcedQuestion — insert path', () => {
  it('inserts a draft with provenance, metadata extras, canonical hash, and verify chain', async () => {
    await seedTree();
    const dispatched: string[][] = [];
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(sourced())),
      fakeEnqueue(dispatched),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;
    expect(output.verify_enqueued).toBe(true);
    expect(dispatched).toEqual([[output.question_id]]);

    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    expect(row?.draft_status).toBe('draft');
    expect(row?.source).toBe('web_sourced');
    expect(row?.knowledge_ids).toEqual(['kc-sets']);
    expect(row?.canonical_content_hash).toMatch(/^[0-9a-f]{64}$/);
    const metadata = row?.metadata as Record<string, unknown>;
    expect(metadata.knowledge_hints).toEqual(['集合']);
    expect(metadata.attribution_state).toBe('matched');
    expect((metadata.jyeoo as { candidate_id?: string }).candidate_id).toBe('cand-test-1');
    // insertSourcedDraft 的 web_sourced provenance 不得被 extras 覆盖。
    expect(metadata.web_sourced).toBeTruthy();

    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, VERIFY_DISPATCH_INTENT_ACTION));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const canary = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:store_sourced_question'));
    expect(canary).toHaveLength(1);
  });

  // YUK-1005 — seam-level regression: MathJye choice markup must be normalized at
  // insertSourcedDraft so stored rows never leak jyeoo table/sprite HTML.
  it('sanitizes MathJye choice markup at the ingest seam and flags the row', async () => {
    await seedTree();
    const mathJyeRadical =
      '<span dealflag="1" class="MathJye" mathtag="math">' +
      '<table cellspacing="-1" cellpadding="-1"><tr>' +
      '<td style="font-size: 0px"><div hassize="7">' +
      '<div style="width:6px;background: url(\'http://img.jyeoo.net/images/formula/part/8730U.png\') repeat-y; height: 1px;overflow: hidden" muststretch="v"></div>' +
      '<div style="width:6px;background: url(\'http://img.jyeoo.net/images/formula/part/8730D.png\') no-repeat; height: 7px; overflow: hidden"></div>' +
      '</div></td>' +
      '<td style="padding:0;padding-left: 2px; border-top: 1px solid black;line-height:normal;padding-top:1px">ab</td>' +
      '</tr></table></span>';
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(
        await candidateOf(
          sourced({
            kind: 'choice',
            prompt_md: '已知a&gt;0，b&gt;0，若a+b=4，则（　　）',
            reference_md: '【答案】B',
            choices_md: [
              'A．a<sup>2</sup>+b<sup>2</sup>有最小值',
              `B．${mathJyeRadical}有最小值`,
              'C．ab有最大值',
              'D．a+b有最大值',
            ],
          }),
        ),
      ),
      fakeEnqueue([]),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;

    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    if (!row) throw new Error('sanitized row missing');
    expect(row.prompt_md).toBe('已知a>0，b>0，若a+b=4，则（　　）');
    expect(row.choices_md).toEqual([
      'A．a²+b²有最小值',
      'B．$\\sqrt{ab}$有最小值',
      'C．ab有最大值',
      'D．a+b有最大值',
    ]);
    expect(JSON.stringify(row.choices_md)).not.toMatch(/MathJye|img\.jyeoo\.net|<table|<sup/);
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.sourced_markup_sanitized).toBe(true);
    // Raw producer markup stays recoverable in provenance, not learner fields.
    expect(String(metadata.web_sourced)).toBeTruthy();
  });

  it('leaves clean markdown unflagged when nothing needed sanitizing', async () => {
    await seedTree();
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(sourced())),
      fakeEnqueue([]),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;
    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    if (!row) throw new Error('row missing');
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.sourced_markup_sanitized).toBeUndefined();
  });

  it('sourcing_web route: skips the jyeoo host gate and stamps web-route provenance', async () => {
    await seedTree();
    const webCandidate = await candidateOf({
      ...sourced(),
      source_url: 'https://mathworld.example.com/sets-101',
      source_title: 'Sets 101',
    });
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(webCandidate, { source_route: 'sourcing_web' }),
      fakeEnqueue([]),
    );
    // 非 jyeoo.com host 在 sourcing_web 路由下不得被 foreign_host 拒（接地靠 whitelist_match）。
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;

    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    if (!row) throw new Error('web-route row missing');
    expect(row.source).toBe('web_sourced');
    expect((row.created_by as { task_kind?: string }).task_kind).toBe('SourcingTask');
    const metadata = row.metadata as Record<string, unknown>;
    expect((metadata.sourcing as { candidate_id?: string }).candidate_id).toBe('cand-test-1');
    expect(metadata.jyeoo).toBeUndefined();
    // insertSourcedDraft 的 tier-2 核心 provenance 不变。
    expect(metadata.web_sourced).toBeTruthy();

    const canary = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:store_sourced_question'));
    expect(canary).toHaveLength(1);
    const canaryRow = canary[0];
    if (!canaryRow) throw new Error('web-route canary missing');
    expect((canaryRow.payload as { source_route?: string }).source_route).toBe('sourcing_web');
  });

  it('jyeoo_fetch route: foreign host still rejected after route parameterization', async () => {
    await seedTree();
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf({ ...sourced(), source_url: 'https://evil.example.com/x' }), {
        source_route: 'jyeoo_fetch',
      }),
      fakeEnqueue([]),
    );
    expect(output.status).toBe('rejected');
    if (output.status !== 'rejected') return;
    expect(output.reason).toBe('foreign_host');
  });

  it('coarse attribution is recorded verbatim', async () => {
    await seedTree();
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(sourced()), {
        knowledge_ids: ['math-root'],
        attribution_state: 'coarse',
      }),
      fakeEnqueue([]),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;
    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    expect((row?.metadata as Record<string, unknown>).attribution_state).toBe('coarse');
    expect(row?.knowledge_ids).toEqual(['math-root']);
  });

  // YUK-1003 — 生产事故形态：7 条 web_sourced computation 行被 producer 标
  // judge_kind_override='exact'，但 reference_md 是纯解题过程（多段落 LaTeX 推导，
  // 无裸答案头）——exact 是逐字比较契约，这种行结构上不可能判对。写路径必须把
  // 该 override 降级为派生路由，并在 metadata 留痕。
  it('demotes an unwinnable exact override on a non-choice row to the derived route', async () => {
    await seedTree();
    const q = sourced({
      kind: 'computation',
      judge_kind_override: 'exact',
      // 生产真实形态（脱敏等构）：纯多段落解题过程，无裸答案头
      reference_md:
        '设事件 H：患病，事件 E：检测阳性。\n\n已知：$P(H)=0.001$，$P(E|H)=0.99$，$P(E|\\bar{H})=0.02$。\n\n由全概率公式：\n$$P(E)=P(E|H)P(H)+P(E|\\bar{H})P(\\bar{H})$$',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '结果正确' }],
        keywords: ['0.0209', '贝叶斯'],
        required_points: [],
      },
    });
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(q)),
      fakeEnqueue([]),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;

    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    // computation + rubric keywords → 派生路由 'keyword'（而非语义不可胜的 exact）。
    expect(row?.judge_kind_override).toBe('keyword');
    const metadata = row?.metadata as Record<string, unknown>;
    expect(metadata.judge_kind_override_demoted).toEqual({
      declared: 'exact',
      applied: 'keyword',
      reason: 'reference_not_exact_capable',
    });
  });

  it('keeps an exact override when the reference resolves to a bare-answer head', async () => {
    await seedTree();
    const q = sourced({
      kind: 'computation',
      judge_kind_override: 'exact',
      // 裸最终答案 + 分段解析尾——exact 成立，judge 比对提取出的 head。
      reference_md: 'E(X)=2.7，Var(X)=0.81\n\n解析：由分布列逐项求和即得，过程从略。',
    });
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(q)),
      fakeEnqueue([]),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;

    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    expect(row?.judge_kind_override).toBe('exact');
    const metadata = row?.metadata as Record<string, unknown>;
    expect(metadata.judge_kind_override_demoted).toBeUndefined();
  });

  it('keeps exact on choice rows — choices drive the route regardless of 解析 tails', async () => {
    await seedTree();
    const q = sourced({
      kind: 'choice',
      judge_kind_override: 'exact',
      choices_md: ['F_X+F_Y', 'F_X·F_Y−F_X·F_Y', 'F_X·F_Y', '1−F_X·F_Y'],
      // 生产真实形态：「（C）选项原文 + 解析尾」——choice 行的 exact 由选项索引
      // 判定（YUK-1003 parser 修复后 "（C）" 前缀可解析），不触发降级。
      reference_md: '（C）F_X·F_Y\n\n解析：设 Z=max{X,Y}，由独立性得 F_Z=F_X·F_Y。',
    });
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(q)),
      fakeEnqueue([]),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;

    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    expect(row?.judge_kind_override).toBe('exact');
    const metadata = row?.metadata as Record<string, unknown>;
    expect(metadata.judge_kind_override_demoted).toBeUndefined();
  });
});

describe('executeStoreSourcedQuestion — deterministic rejections', () => {
  it('rejects dead knowledge nodes before any insert', async () => {
    await seedTree();
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(sourced()), { knowledge_ids: ['kc-sets', 'kc-dead'] }),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'dead_knowledge_node' });
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(0);
  });

  it('rejects foreign-host source_url (never trusts the caller)', async () => {
    await seedTree();
    const foreign = sourced({
      source_url: 'https://evil.example.com/x',
      extract: 'https://evil.example.com/x',
    });
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(foreign)),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'foreign_host' });
  });

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

  it('rejects near-duplicates against the KC-scoped active+draft pool', async () => {
    await seedTree();
    await db.insert(question).values({
      id: 'q-near',
      kind: 'short_answer',
      prompt_md: '已知集合 A={1,2,3}，B={2,3,4}，求 A∩B。',
      reference_md: '【答案】{2,3}',
      knowledge_ids: ['kc-sets'],
      difficulty: 3,
      source: 'quiz_gen',
      metadata: null as never,
      draft_status: null,
      variant_depth: 0,
      canonical_content_hash: 'f'.repeat(64),
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });

    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(sourced())),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'near_dup' });
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
  it('rewrites figure/structured placeholder ids, forces multimodal_direct, keeps staged assets', async () => {
    await seedTree();
    const r2 = memR2();
    stagedR2.client = r2;
    await seedStagedAsset(r2, IMG_ASSET_ID);

    // 同 KC、同文字的既有题：图题按设计跳过文本 n-gram near-dup（hasImages 短路，
    // 文字相同不代表题相同——像素不同就是不同题），本候选必须仍然 inserted。
    // canonical hash 必须不同，否则 pre-check 会先走 exact-dup merge。
    const q = imageSourced();
    await db.insert(question).values({
      id: 'q-same-wording',
      kind: 'choice',
      prompt_md: q.prompt_md,
      reference_md: q.reference_md,
      choices_md: q.choices_md,
      knowledge_ids: ['kc-sets'],
      difficulty: 3,
      source: 'quiz_gen',
      metadata: null as never,
      draft_status: null,
      variant_depth: 0,
      canonical_content_hash: 'e'.repeat(64),
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });

    const media = imageMedia('cand-img-1');
    const candidate = await candidateOf(q, {
      candidate_id: 'cand-img-1',
      extraction_hash: await imageExtractionHash(q),
      ...media,
      staged_asset_ids: [IMG_ASSET_ID],
    });
    const dispatched: string[][] = [];
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(candidate),
      fakeEnqueue(dispatched),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;
    expect(output.verify_enqueued).toBe(true);
    expect(dispatched).toEqual([[output.question_id]]);

    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    if (!row) throw new Error('image question row missing');
    // 图片 commit 分支：judge_kind_override 从 'exact'（choice 的 defaultJudgeKind）被
    // 强写为 'multimodal_direct'——选择支会短路图片 auto-route，必须显式路由。
    expect(row.judge_kind_override).toBe('multimodal_direct');
    // candidate_id 占位 → question id 重写（figures.attached_to_index + structured.id）。
    expect(row.figures).toHaveLength(1);
    expect(row.figures[0]?.attached_to_index).toBe(output.question_id);
    expect(row.figures[0]?.attached_to_index).not.toBe('cand-img-1');
    expect(row.figures[0]?.asset_id).toBe(IMG_ASSET_ID);
    expect(row.figures[0]?.attach_confidence).toBe('high');
    expect(row.structured?.id).toBe(output.question_id);
    expect(row.structured?.options).toHaveLength(4);
    expect(row.structured?.answers).toEqual(['B']);
    expect(row.image_refs).toEqual([IMG_ASSET_ID]);
    expect(row.choices_md).toEqual(['A. 2', 'B. 3', 'C. 4', 'D. 5']);
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.prompt_image_refs).toEqual([IMG_ASSET_ID]);
    expect((metadata.jyeoo as { candidate_id?: string }).candidate_id).toBe('cand-img-1');

    // commit 成功的 staged 资产转正归题：行与 R2 对象都保留（reaper 另有引用检查兜底）。
    const assets = await db.select().from(source_asset).where(eq(source_asset.id, IMG_ASSET_ID));
    expect(assets).toHaveLength(1);
    expect(r2._store.size).toBe(1);
  });

  it('degrades to metadata-only link when the image candidate lacks structured/figures', async () => {
    // 图片链接写入需要 image_refs + figures + structured 四者齐备（hasImages 只看
    // image_refs 长度）。缺 structured 的畸形候选仍插入，但只合入 metadata extras——
    // 不写 figures/structured 列，也不强写 multimodal_direct（保留 insert 的默认路由）。
    await seedTree();
    const r2 = memR2();
    stagedR2.client = r2;
    await seedStagedAsset(r2, IMG_ASSET_ID);

    const q = imageSourced();
    const candidate = await candidateOf(q, {
      candidate_id: 'cand-img-partial',
      extraction_hash: await imageExtractionHash(q),
      figures: null,
      image_refs: [IMG_ASSET_ID],
      structured: null,
      staged_asset_ids: [IMG_ASSET_ID],
    });
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(candidate),
      fakeEnqueue([]),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;

    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    if (!row) throw new Error('partial-image question row missing');
    // else 分支：无 override 强写——choice 保留 insertSourcedDraft 的默认 'exact'。
    expect(row.judge_kind_override).toBe('exact');
    expect(row.figures).toEqual([]);
    expect(row.structured).toBeNull();
    expect(row.image_refs).toEqual([]);
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.prompt_image_refs).toEqual([IMG_ASSET_ID]);
  });

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
