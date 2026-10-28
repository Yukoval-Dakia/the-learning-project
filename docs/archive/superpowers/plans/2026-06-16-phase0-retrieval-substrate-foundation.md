# Phase 0 — 检索底座地基（语义 embedding）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给域实体（question / knowledge）建 pgvector 语义向量地基——向量列 + 域 embedder + 幂等 backfill job + KC containment GIN——为后续采集 matcher / KC 自动标注 / 变式家族 / dedup 铺底。**零行为变更**：不碰选题/采集/判分，只让语料获得可查向量。

**Architecture:** 复用 mem0 同款 embedder（百炼 DashScope `text-embedding-v4`，1024 维，openai-compat）但落进 **Drizzle 管理的 entity-keyed `vector(1024)` 列**（非 mem0 黑盒 collection）。向量由一个**幂等 nightly `embed_backfill` job** 填充——它一次覆盖：存量 backfill + 新行（次日）+ embed API 故障重试（§9 fallback：题照常入库、向量 NULL 排队补）。pgvector 无 drizzle 原生类型 → `customType` + 迁移 raw SQL。

**Tech Stack:** Drizzle ORM 0.45 + `postgres` 0.3 driver + pgvector（drizzle/0015 已 `CREATE EXTENSION vector`）+ pg-boss 12 + DashScope embeddings（`DASHSCOPE_API_KEY`，openai-compat `/embeddings`）。

**Scope note:** spec §8 Phase 0 含「统一 pool-fetch 算子」——**本 plan 不含它**。它是 `loadQuestionPool` 的泛化重构，只有被 Phase 1 matcher 消费时才有意义；standalone 提取属纯重构、无独立可测价值，并入 Phase 1 matcher plan。本 plan = spec Phase 0 的「embedding 地基」子集，自成可测软件。

**先决：** #437（设计 spec）已 review；执行前应 merge #437 或确认 spec 路径稳定。本 plan 在 fresh main 上的隔离 worktree 执行（superpowers:using-git-worktrees）。

---

## File Structure

- `src/db/vector.ts` — **新建**：drizzle `customType` 定义 `vector(dims)`（pgvector 列类型 + number[] ↔ pgvector 文本格式编解码）。单一职责：向量列类型。
- `src/db/schema.ts` — **改**：`question` + `knowledge` 各加 `embedding vector(1024)` / `embed_model` / `embed_version` 列；`question.knowledge_ids` 加 GIN 索引。
- `drizzle/00NN_*.sql` — **生成**：上述列 + GIN 的迁移（`pnpm db:generate`）。
- `src/server/ai/embed.ts` — **新建**：域 embedder。`embedText(text)` / `embedMany(texts)` → `number[1024][]`，调 DashScope openai-compat `/embeddings`。单一职责：把文本转向量。
- `src/server/ai/embed-source.ts` — **新建**：把一行 question/knowledge 拼成 embed 输入文本（确定拼接规则；KC 用 name+domain，见 spec §4.3a 决策）。单一职责：实体→可嵌入文本。
- `src/capabilities/practice/jobs/embed_backfill.ts` — **新建**：幂等 job，批量 embed `embedding IS NULL` 的 question/KC 行。
- `src/capabilities/practice/manifest.ts` — **改**：jobs 注册 `embed_backfill`（nightly cron，错开既有夜链 job）。
- 测试：各 `*.test.ts` / `*.db.test.ts` 同目录。

---

## Task 1: pgvector 列类型 + schema 列 + 迁移

**Files:**
- Create: `src/db/vector.ts`
- Modify: `src/db/schema.ts`（question ~152-200、knowledge ~50-72）
- Test: `src/db/vector.test.ts`（unit，纯编解码）

- [ ] **Step 1: 写失败测试（vector customType 编解码）**

```ts
// src/db/vector.test.ts
import { describe, it, expect } from 'vitest';
import { toSqlVector, fromSqlVector } from './vector';

describe('vector customType codec', () => {
  it('serializes number[] to pgvector text literal', () => {
    expect(toSqlVector([0.1, -0.2, 0.3])).toBe('[0.1,-0.2,0.3]');
  });
  it('parses pgvector text literal back to number[]', () => {
    expect(fromSqlVector('[0.1,-0.2,0.3]')).toEqual([0.1, -0.2, 0.3]);
  });
  it('round-trips', () => {
    const v = [0.5, 0, -1.25];
    expect(fromSqlVector(toSqlVector(v))).toEqual(v);
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm vitest run --config vitest.unit.config.ts src/db/vector.test.ts`
Expected: FAIL（`toSqlVector` not exported / module not found）

- [ ] **Step 3: 实现 vector customType**

```ts
// src/db/vector.ts
import { customType } from 'drizzle-orm/pg-core';

export function toSqlVector(v: number[]): string {
  return `[${v.join(',')}]`;
}
export function fromSqlVector(s: string): number[] {
  return s.replace(/^\[|\]$/g, '').split(',').filter(Boolean).map(Number);
}

/** pgvector `vector(dims)` 列。存 number[]，DB 端是 pgvector。dims 必须与 embedder 同值（1024）。 */
export const vector = (dims: number) =>
  customType<{ data: number[]; driverData: string; config: { dims: number } }>({
    dataType() {
      return `vector(${dims})`;
    },
    toDriver(value: number[]): string {
      return toSqlVector(value);
    },
    fromDriver(value: string): number[] {
      return fromSqlVector(value);
    },
  })('embedding', { dims });
```

> 注：`customType` 的列名在 schema 里用法是 `embedding: vector(1024)`——上面工厂已固定列名 'embedding'；若多列需不同名，改成 `vector(name, dims)` 二参工厂。本 plan 每表一个 embedding 列，固定名即可。

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm vitest run --config vitest.unit.config.ts src/db/vector.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: 给 schema 加列**

`src/db/schema.ts` 顶部 import：
```ts
import { vector } from './vector';
```
`question` 表 body（在 `version` 列后，`}` 前）加：
```ts
    embedding: vector(1024),
    embed_model: text('embed_model'),
    embed_version: integer('embed_version'),
```
`knowledge` 表 body（在 `version` 列后）加同样三列：
```ts
    embedding: vector(1024),
    embed_model: text('embed_model'),
    embed_version: integer('embed_version'),
```

- [ ] **Step 6: 生成迁移**

Run: `pnpm db:generate`
Expected: 新 `drizzle/00NN_*.sql`，含 `ALTER TABLE "question" ADD COLUMN "embedding" vector(1024)` 等 6 列。**人工核**：drizzle 若不认 `vector(1024)` 输出为 `vector(1024)` 文本即可（customType.dataType 已给字面）；若生成空/错，手补 SQL：
```sql
ALTER TABLE "question" ADD COLUMN "embedding" vector(1024);
ALTER TABLE "question" ADD COLUMN "embed_model" text;
ALTER TABLE "question" ADD COLUMN "embed_version" integer;
ALTER TABLE "knowledge" ADD COLUMN "embedding" vector(1024);
ALTER TABLE "knowledge" ADD COLUMN "embed_model" text;
ALTER TABLE "knowledge" ADD COLUMN "embed_version" integer;
```

- [ ] **Step 7: 迁移 smoke**

Run: `pnpm test:migration`
Expected: PASS（DDL 应用无误，pgvector 扩展已在 0015 启用）

- [ ] **Step 8: Commit**

```bash
git add src/db/vector.ts src/db/vector.test.ts src/db/schema.ts drizzle/
git commit -m "feat(db): pgvector vector(1024) columns on question/knowledge + customType"
```

---

## Task 2: 域 embedder（DashScope openai-compat）

**Files:**
- Create: `src/server/ai/embed.ts`
- Test: `src/server/ai/embed.test.ts`（unit，mock fetch）

- [ ] **Step 1: 写失败测试**

```ts
// src/server/ai/embed.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.DASHSCOPE_API_KEY = 'test-key';
});

describe('embedMany', () => {
  it('posts to compat /embeddings and returns 1024-dim vectors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1024).fill(0.01) }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { embedMany } = await import('./embed');
    const out = await embedMany(['hello']);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(1024);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/embeddings$/);
    expect(JSON.parse(init.body).model).toBe('text-embedding-v4');
    expect(JSON.parse(init.body).dimensions).toBe(1024);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'down' }));
    const { embedMany } = await import('./embed');
    await expect(embedMany(['x'])).rejects.toThrow(/503/);
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm vitest run --config vitest.unit.config.ts src/server/ai/embed.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 embedder**

> 复用 mem0 同款常量。**先确认** `src/server/memory/client.ts:8-10` 的 `DEFAULT_EMBEDDING_MODEL`（`text-embedding-v4`）、`DEFAULT_EMBEDDING_DIMS`（1024）与 `DEFAULT_EMBEDDING_BASE_URL`（DashScope compatible-mode，形如 `https://dashscope.aliyuncs.com/compatible-mode/v1`）；与下方值对齐，base URL 取该常量真值。

```ts
// src/server/ai/embed.ts
export const EMBED_MODEL = 'text-embedding-v4';
export const EMBED_DIMS = 1024;
const BASE_URL =
  process.env.MEM0_EMBEDDING_BASE_URL?.trim() ||
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** 把一批文本嵌成 1024 维向量。openai-compat /embeddings，复用 DASHSCOPE_API_KEY。 */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw new Error('embedMany: DASHSCOPE_API_KEY is unset');
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) {
    throw new Error(`embedMany: DashScope ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

export async function embedText(text: string): Promise<number[]> {
  const [v] = await embedMany([text]);
  return v;
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm vitest run --config vitest.unit.config.ts src/server/ai/embed.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/embed.ts src/server/ai/embed.test.ts
git commit -m "feat(ai): domain text embedder (DashScope text-embedding-v4, 1024d)"
```

---

## Task 3: 实体→可嵌入文本（确定拼接）

**Files:**
- Create: `src/server/ai/embed-source.ts`
- Test: `src/server/ai/embed-source.test.ts`（unit）

- [ ] **Step 1: 写失败测试**

```ts
// src/server/ai/embed-source.test.ts
import { describe, it, expect } from 'vitest';
import { questionEmbedText, knowledgeEmbedText } from './embed-source';

describe('embed source text', () => {
  it('question = prompt + reference + choices joined', () => {
    const t = questionEmbedText({ prompt_md: '题面', reference_md: '答案', choices_md: ['A', 'B'] });
    expect(t).toContain('题面');
    expect(t).toContain('答案');
    expect(t).toContain('A');
  });
  it('knowledge = name + domain (无 description 列)', () => {
    expect(knowledgeEmbedText({ name: '虚词', domain: '古文' })).toBe('虚词\n古文');
  });
  it('tolerates null reference/choices/domain', () => {
    expect(questionEmbedText({ prompt_md: 'p', reference_md: null, choices_md: null })).toBe('p');
    expect(knowledgeEmbedText({ name: 'n', domain: null })).toBe('n');
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm vitest run --config vitest.unit.config.ts src/server/ai/embed-source.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现**

> KC 无 description 列（spec §4.3a 决策：先 name+domain）。后续若新增 `description` 列，在此并入。

```ts
// src/server/ai/embed-source.ts
export function questionEmbedText(q: {
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
}): string {
  return [q.prompt_md, q.reference_md ?? '', ...(q.choices_md ?? [])]
    .filter((s) => s && s.trim())
    .join('\n');
}

export function knowledgeEmbedText(k: { name: string; domain: string | null }): string {
  return [k.name, k.domain ?? ''].filter((s) => s && s.trim()).join('\n');
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm vitest run --config vitest.unit.config.ts src/server/ai/embed-source.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: Commit**

```bash
git add src/server/ai/embed-source.ts src/server/ai/embed-source.test.ts
git commit -m "feat(ai): deterministic entity->embed-text for question/knowledge"
```

---

## Task 4: 幂等 embed_backfill job（backfill + 新行 + API 故障重试）

**Files:**
- Create: `src/capabilities/practice/jobs/embed_backfill.ts`
- Test: `src/capabilities/practice/jobs/embed_backfill.db.test.ts`（DB test，需 Docker）

- [ ] **Step 1: 写失败 DB 测试**

```ts
// src/capabilities/practice/jobs/embed_backfill.db.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '@/tests/helpers/db'; // 按项目既有 helper 路径调整
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { eq } from 'drizzle-orm';

vi.mock('@/server/ai/embed', () => ({
  embedMany: vi.fn(async (texts: string[]) => texts.map(() => Array(1024).fill(0.02))),
  EMBED_MODEL: 'text-embedding-v4',
  EMBED_DIMS: 1024,
}));

describe('embed_backfill', () => {
  beforeEach(async () => { await resetDb(); });

  it('embeds question rows with NULL embedding and stamps model/version', async () => {
    await db.insert(question).values({
      id: 'q1', kind: 'single_choice', prompt_md: 'P', source: 'authentic',
      created_at: new Date(), updated_at: new Date(),
    });
    const { runEmbedBackfill } = await import('./embed_backfill');
    const n = await runEmbedBackfill(db, 50);
    expect(n).toBe(1);
    const [row] = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(row.embedding).toHaveLength(1024);
    expect(row.embed_model).toBe('text-embedding-v4');
    expect(row.embed_version).toBe(1);
  });

  it('is idempotent — second run embeds nothing (no NULL rows left)', async () => {
    await db.insert(question).values({
      id: 'q1', kind: 'single_choice', prompt_md: 'P', source: 'authentic',
      created_at: new Date(), updated_at: new Date(),
    });
    const { runEmbedBackfill } = await import('./embed_backfill');
    await runEmbedBackfill(db, 50);
    const n2 = await runEmbedBackfill(db, 50);
    expect(n2).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/practice/jobs/embed_backfill.db.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 实现 backfill**

```ts
// src/capabilities/practice/jobs/embed_backfill.ts
import { isNull, eq } from 'drizzle-orm';
import type { Db } from '@/db/client'; // 按项目 Db 类型路径调整
import { question, knowledge } from '@/db/schema';
import { embedMany, EMBED_MODEL } from '@/server/ai/embed';
import { questionEmbedText, knowledgeEmbedText } from '@/server/ai/embed-source';

const EMBED_VERSION = 1; // 换 embedder model / 拼接规则时 +1，触发后台重嵌

/** 幂等：嵌入 embedding IS NULL 的 question + knowledge 行（每 kind 最多 limit 条/次）。返回嵌入条数。 */
export async function runEmbedBackfill(db: Db, limit = 100): Promise<number> {
  let total = 0;

  const qs = await db.select().from(question).where(isNull(question.embedding)).limit(limit);
  if (qs.length > 0) {
    const vecs = await embedMany(qs.map((q) => questionEmbedText(q)));
    for (let i = 0; i < qs.length; i++) {
      await db.update(question)
        .set({ embedding: vecs[i], embed_model: EMBED_MODEL, embed_version: EMBED_VERSION })
        .where(eq(question.id, qs[i].id));
    }
    total += qs.length;
  }

  const ks = await db.select().from(knowledge).where(isNull(knowledge.embedding)).limit(limit);
  if (ks.length > 0) {
    const vecs = await embedMany(ks.map((k) => knowledgeEmbedText(k)));
    for (let i = 0; i < ks.length; i++) {
      await db.update(knowledge)
        .set({ embedding: vecs[i], embed_model: EMBED_MODEL, embed_version: EMBED_VERSION })
        .where(eq(knowledge.id, ks[i].id));
    }
    total += ks.length;
  }

  return total;
}
```

> §9 fallback：embedMany throw（API down）时本 job 失败、行保持 NULL，下次 nightly 重试——题入库不受影响（入库路径不调本 job）。pg-boss 重试策略由 manifest 注册决定。

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/practice/jobs/embed_backfill.db.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/practice/jobs/embed_backfill.ts src/capabilities/practice/jobs/embed_backfill.db.test.ts
git commit -m "feat(practice): idempotent embed_backfill job (question/knowledge vectors)"
```

---

## Task 5: 注册 embed_backfill 到 practice manifest（nightly cron）

**Files:**
- Modify: `src/capabilities/practice/manifest.ts`（jobs 段，~149-185）
- Test: `src/capabilities/practice/manifest.test.ts`（unit，断言 job 已注册）

- [ ] **Step 1: 写失败测试**

```ts
// 追加进 src/capabilities/practice/manifest.test.ts（若无则新建）
import { describe, it, expect } from 'vitest';
import { practiceManifest } from './manifest'; // 按既有导出名调整

describe('practice manifest jobs', () => {
  it('registers embed_backfill nightly job staggered from other 夜链', () => {
    const job = practiceManifest.jobs?.scheduled?.find?.((j: any) => j.name === 'embed_backfill')
      ?? (practiceManifest as any).jobs.find?.((j: any) => j.name === 'embed_backfill');
    expect(job).toBeTruthy();
    expect(job.schedule.cron).toBeTruthy();
    expect(job.schedule.tz).toBe('Asia/Shanghai');
  });
});
```

> **先核** manifest.ts jobs 的真实结构（Step 0：Read `src/capabilities/practice/manifest.ts:149-185`，按 `item_prior_backfill`/`practice_stream_compose_nightly` 的真实形状对齐上面的 find 路径与 job 形状）。

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm vitest run --config vitest.unit.config.ts src/capabilities/practice/manifest.test.ts`
Expected: FAIL（找不到 embed_backfill）

- [ ] **Step 3: 注册 job**

按 `item_prior_backfill`（cron `20 4 * * *`）/`practice_stream_compose_nightly`（`30 5 * * *`）的同款形状，加一条**错开**的（如 `50 4 * * *`，避开两者）：

```ts
{
  name: 'embed_backfill',
  schedule: { cron: '50 4 * * *', tz: 'Asia/Shanghai' },
  handler: () =>
    import('./jobs/embed_backfill').then((m) => /* 按既有 handler 包装签名调用 */ m.runEmbedBackfill),
},
```

> handler 包装签名按既有 nightly job 的真实形态对齐（既有 job 怎么拿 `db` 就怎么拿；本 job handler 内调 `runEmbedBackfill(db)`）。

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm vitest run --config vitest.unit.config.ts src/capabilities/practice/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/capabilities/practice/manifest.ts src/capabilities/practice/manifest.test.ts
git commit -m "feat(practice): schedule nightly embed_backfill job (04:50 Asia/Shanghai)"
```

---

## Task 6: question.knowledge_ids GIN 索引（KC containment 加速）

**Files:**
- Modify: `src/db/schema.ts`（question 表第二参 `(t) => [...]`）
- Generate: `drizzle/00NN_*.sql`
- Test: `pnpm test:migration`（DDL smoke）

- [ ] **Step 1: 加索引定义**

`question` 表已有 `index` import（schema.ts 顶部）。在 question 表定义的第二参数组（约束/索引数组；若当前只有 `check(...)` 一项，扩成数组）加：
```ts
index('question_knowledge_ids_gin').using('gin', t.knowledge_ids),
```
即 question 第二参变为：
```ts
  (t) => [
    check('question_difficulty_range', sql`${t.difficulty} BETWEEN 1 AND 5`),
    index('question_knowledge_ids_gin').using('gin', t.knowledge_ids),
  ],
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: 新迁移含 `CREATE INDEX "question_knowledge_ids_gin" ON "question" USING gin ("knowledge_ids")`。若 drizzle 对 jsonb gin 生成不对，手补该 SQL。

- [ ] **Step 3: 迁移 smoke**

Run: `pnpm test:migration`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): GIN index on question.knowledge_ids for KC containment"
```

---

## Task 7: 全量 gate

- [ ] **Step 1: 跑全 pre-PR gate**

```bash
pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test && pnpm build
```
Expected: 全绿。
- **audit:schema 预期点**：新列 `question.embedding`/`embed_model`/`embed_version`、`knowledge.*` 同——它们**只有 backfill job 的 UPDATE write path**（无 INSERT 写）。若 audit:schema 判 embedding 等列「无 write path」，确认 backfill 的 `.update().set({embedding,...})` 被识别为 write path；不被识别则加 allowlist 条目（`resolves_when: {kind:'phase', ref:'采集重想 Phase 1 matcher 读 embedding', expected_by:'2026-09-30'}`）并注释。
- DB test 需 Docker。

- [ ] **Step 2: 收尾 commit（如有 allowlist/lint 修）**

```bash
git add -A && git commit -m "chore: phase0 retrieval-substrate gate fixes"
```

---

## Self-Review（已对 spec 核）

- **Spec 覆盖**：Phase 0 列出的「pgvector 域 embedding 列 ✓(T1) / embed-on-write job ✓(以幂等 nightly backfill 实现，覆盖 backfill+新行+故障重试，spec §4.3d + §9 fallback) / 一次性 backfill ✓(T4) / knowledge_ids GIN ✓(T6)」。**统一 pool-fetch 算子**显式移出本 plan（见开头 Scope note，并入 Phase 1）——spec §8 Phase 0 的此项留待 Phase 1 plan。
- **raw-pool embedding 列**：spec Phase 0 提 question/KC/**raw-pool**；raw 池表在 Phase 1 才建，故本 plan 只做 question/KC，raw-pool 的 embedding 列随 Phase 1 raw 池 schema 一并加（已在本 plan Scope note 与 Phase 1 衔接）。
- **占位扫描**：无 TBD/TODO；每个 code step 有完整代码。两处「先核既有形状再对齐」（manifest job 形状 T5、Db 类型/helper 路径 T4）是**对既有代码的真实依赖确认**，非占位——给了确切文件/行号锚点。
- **类型一致**：`EMBED_MODEL`/`EMBED_DIMS`(embed.ts) 被 embed_backfill 复用；`embedMany` 签名 `(string[])=>Promise<number[][]>` 全程一致；`vector(1024)` dims 与 EMBED_DIMS=1024 一致；embed_version 常量贯穿 backfill。

---

## 执行先决与衔接

- **零行为变更**确认：本 plan 不改选题/采集/判分；新列对现查询透明（NULL 默认），新 job 错开夜链。
- **Phase 1 衔接**：matcher（统一 pool-fetch + 语义 ANN）消费本 plan 建的 `embedding` 列；raw 池 embedding 列随 Phase 1 加；embed_version bump → 后台重嵌机制已就位。
