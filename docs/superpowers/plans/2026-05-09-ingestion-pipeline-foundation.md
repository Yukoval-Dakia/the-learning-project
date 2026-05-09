# Phase 1.5 Implementation Plan — Ingestion Pipeline Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把图片从 D1 base64 inline 迁向 R2，落地 `source_asset` / `ingestion_session` / `source_document` / `question_block`（page_spans 多页建模）schema，把 `vision_single` OCR 第一波接通：单/多图上传 → VisionExtractTask 分块 → 用户审核（含手动合并/拆分）→ 入库为 question + mistake，沿用 Sub 3 已建好的 AttributionTask waitUntil pattern。

**Architecture:** 拆 2 个 sub-PR：
- **PR A**：仅 R2 + `source_asset` 一张表 + `/api/assets` + `/record` 改用 asset id。**单一交付：base64 inline 离开 D1**。
- **PR B**：`ingestion_session` + `source_document` + `question_block`(page_spans) + VisionExtractTask 真正接通 + `/ingest` 页（上传 / 审核 / 合并 / 拆分 / 导入）。**单一交付：拍卷子录入闭环**。

**Tech Stack:** Cloudflare Workers + Hono / D1 + Drizzle / R2 / Vercel AI SDK v6 (`@ai-sdk/anthropic` claude-haiku-4-5 multimodal) / React 19 + react-router + TanStack Query / zod。

**Spec reference:** `docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` § Source Layer / § Ingestion Layer / § Block Assembly。

---

## 关键决策（lock）

| 决策 | 选择 | 理由 |
|---|---|---|
| 拆 2 PR | A: R2 + source_asset 一张；B: ingestion 全套 + vision wire | A 单独 ship 后即解决 D1 cell 1MB 风险；B 是真正用户能用的 vision 录入路径 |
| `QuestionBlock` 跨页建模 | `page_spans: Array<{page_index, bbox, role?}>` | 一题一行，跨页不拆表（spec § Block Assembly） |
| 跨页合并 MVP | 用户手动合并按钮（A 路径）；AI auto-merge `BlockAssemblyTask` 推 Phase 2 | 自用频率低（~10-15%），按钮够 |
| `POST /api/ingestion` 同步还是异步 | **同步**（accept asset_ids → run vision sync → return blocks） | 自用 5 图以内，30s worker timeout 够；异步路径推迭代 2 |
| VisionExtractTask 模型 | `claude-haiku-4-5-20251001` 多模态（registry 已注册 `isMultimodal: true`） | 便宜、快；准确率不够再上 sonnet |
| 现有 `prompt_image_refs` API 字段 | 语义换：base64 data URL → `source_asset.id` | 减少接口 break；question.metadata 加 `prompt_image_ref_kind: 'source_asset_id'` 显式标记 |
| 手动 `/record` 流程 | PR A 后保持工作（仅 image upload 路径换） | 不绑死 vision_single；用户文字录入仍 1 步走完 |
| Drop 现有 base64 兜底 | PR A 完成时把 `TOTAL_IMAGE_BYTES_LIMIT` / `MAX_IMAGE_BYTES` 等代码删除 | 不留死路径 |
| ingestion 流程入口 | 新页 `/ingest`（不进主导航；URL 直访 + `/_/inspect` 加 link） | 跟其他录入页一致 |
| 数据迁移 / 清理 | **迁移文件不做 destructive delete**；PR A merge 前先备份 + 人工确认 DB 仅 dummy，才允许手动清空 `mistake/question`；若已有真实数据，先写一次性迁移脚本把现有 data URL 上传到 R2 再更新 refs | 避免 agentic worker 把删除命令当默认步骤执行 |

---

## File Structure

PR A 涉及：

| 路径 | 责任 | 新建/修改 |
|---|---|---|
| `src/db/schema.ts` | + `source_asset` 表 | 改 |
| `src/core/schema/business.ts` | + `SourceAssetKind` enum | 改 |
| `src/core/schema/generated.ts` | + `SourceAssetInsertGenerated` / `SourceAssetSelectGenerated` | 改 |
| `src/core/schema/index.ts` | 导出 `SourceAsset` zod | 改 |
| `src/core/schema/schema.test.ts` | + SourceAsset zod 测试 | 改 |
| `drizzle/0002_*.sql` + `drizzle/meta/0002_snapshot.json` + `drizzle/meta/_journal.json` | drizzle generate 出来 | 新 |
| `workers/wrangler.toml` | + `[[r2_buckets]] binding = "IMAGES"` | 改 |
| `workers/src/types.ts` | + `IMAGES: R2Bucket` | 改 |
| `workers/src/routes/assets.ts` | POST / 上传 → R2.put + insert source_asset | 新 |
| `workers/src/routes/assets.test.ts` | 上传校验 / R2 + D1 写入 | 新 |
| `workers/src/index.ts` | mount `/api/assets` | 改 |
| `workers/src/routes/knowledge.test.ts` | mockEnv 加 `IMAGES` stub | 改 |
| `workers/src/routes/mistakes.ts` | drop `TOTAL_IMAGE_BYTES_LIMIT` 检查；改成 `assertSourceAssetsExist`；`question.metadata.prompt_image_ref_kind = 'source_asset_id'` | 改 |
| `workers/src/routes/mistakes.test.ts` | mockEnv 加 `IMAGES` + `sourceAssetIds`；删 byte cap 测试；加 asset existence 测试 | 改 |
| `src/routes/record.tsx` | drop base64 readAsDataURL；加 `uploadAsset` 先 POST /api/assets 拿 id；提交 mistake 用 id | 改 |

PR B 涉及（在 PR A 之上）：

| 路径 | 责任 | 新建/修改 |
|---|---|---|
| `src/db/schema.ts` | + `source_document` / `ingestion_session` / `question_block` (page_spans) | 改 |
| `src/core/schema/business.ts` | + `IngestionSessionStatus` / `QuestionBlockStatus` / `QuestionBlockRole` / `VisualComplexity` enums | 改 |
| `src/core/schema/generated.ts` + `index.ts` | 导出 zod | 改 |
| `drizzle/0003_*.sql` + meta | 三张新表 | 新 |
| `src/ai/registry.ts` | VisionExtractTask 改具体 prompt（多 block JSON 输出 schema）；保 `isMultimodal: true` `needsToolCall: false` | 改 |
| `workers/src/ai/runner.ts` | `runTask` 支持 AI SDK multimodal `messages` 输入；否则 vision 只会收到 JSON 文本，不会看到图片 | 改 |
| `workers/src/ai/runner.test.ts` | 覆盖 multimodal input 会传 `type: 'image'` content part | 改 |
| `workers/src/ingestion/vision.ts` | `parseVisionOutput` + `runVisionExtract`（从 R2 bytes 构造 VisionExtractTask multimodal input + 解析 N blocks）| 新 |
| `workers/src/ingestion/vision.test.ts` | 解析 + 失败兜底 | 新 |
| `workers/src/routes/ingestion.ts` | POST `/` 创 session + 从 private R2 读 asset bytes + 跑 vision sync；POST `/:id/import` 入库 question + mistake；GET `/:id` (debug 看 session 现状) | 新 |
| `workers/src/routes/ingestion.test.ts` | 全流程 mock vision + DB 写入 | 新 |
| `workers/src/index.ts` | mount `/api/ingestion` | 改 |
| `src/routes/ingest.tsx` | `<IngestSession>` 上传 → 显示提取 blocks → 编辑 / 合并 / 拆分 / 导入 | 新 |
| `src/App.tsx` | mount `/ingest` | 改 |
| `src/routes/inspect.tsx` | + `/ingest` link | 改 |
| `src/routes/record.tsx` | 顶部加 link "图片录入 → /ingest"（提示用户拍卷子走另一条路） | 改 |

---

## VisionExtractTask Output Contract

新 system prompt 约束严格 JSON：

```json
{
  "blocks": [
    {
      "extracted_prompt_md": "string，markdown，可含 LaTeX",
      "reference_md": "string | null（题面有写参考答案/标准答案时填）",
      "wrong_answer_md": "string | null（图上若已有用户错答／批改痕迹，提取它）",
      "page_index": 0,
      "bbox": { "x": 0.1, "y": 0.2, "width": 0.6, "height": 0.3 },
      "role": "prompt | answer_area | continuation",
      "visual_complexity": "low | medium | high",
      "extraction_confidence": 0.0-1.0,
      "knowledge_hint": "string | null"
    }
  ]
}
```

约束：
- 每 page 一张图给 vision，可以输出多个 blocks（一页多题）
- bbox 坐标都是 0-1 归一化（不是像素）
- `extraction_confidence` < 0.5 时审核页高亮
- `knowledge_hint` 是 hint 不是绑定（最终知识点用户在审核页选）

跨页：vision 单图调用每次只看一张图，无法"跨页"。**跨页合并发生在审核页：用户从多个 single-page block 里选 N 个 → 合并按钮 → 客户端 reduce 成一个 block，page_spans 长度 = N**。VisionExtractTask 自身不做跨页推理。

---

## PR A：R2 + source_asset

### Task 1: source_asset schema + 0002 migration

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/core/schema/business.ts`
- Modify: `src/core/schema/generated.ts`
- Modify: `src/core/schema/index.ts`
- Create (by `pnpm db:generate`): `drizzle/0002_*.sql`, `drizzle/meta/0002_snapshot.json`, updated `drizzle/meta/_journal.json`
- Modify: `src/core/schema/schema.test.ts`

- [ ] **Step 1: Add SourceAssetKind enum**

In `src/core/schema/business.ts`, add after `ArtifactType`:

```ts
export const SourceAssetKind = z.enum(['image', 'pdf', 'text', 'web']);
```

- [ ] **Step 2: Add `source_asset` to drizzle schema**

In `src/db/schema.ts`, append after `knowledge`:

```ts
export const source_asset = sqliteTable('source_asset', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  storage_key: text('storage_key').notNull(),
  mime_type: text('mime_type').notNull(),
  byte_size: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  width: integer('width'),
  height: integer('height'),
  provenance: text('provenance', { mode: 'json' }).notNull().default({}),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

- [ ] **Step 3: Generate migration**

```bash
pnpm db:generate
```

Verify the generated `drizzle/0002_*.sql` contains exactly one `CREATE TABLE source_asset` and that `_journal.json` references it.

- [ ] **Step 4: Add zod exports**

In `src/core/schema/generated.ts`, append:

```ts
export const SourceAssetInsertGenerated = createInsertSchema(t.source_asset);
export const SourceAssetSelectGenerated = createSelectSchema(t.source_asset);
```

In `src/core/schema/index.ts`, append:

```ts
// ---------- Source ----------
export const SourceAssetInsert = g.SourceAssetInsertGenerated.extend({ kind: b.SourceAssetKind });
export const SourceAsset = g.SourceAssetSelectGenerated.extend({ kind: b.SourceAssetKind });
export type SourceAssetInsert = z.infer<typeof SourceAssetInsert>;
export type SourceAsset = z.infer<typeof SourceAsset>;
```

(If existing `index.ts` imports look like `import * as g from './generated'` and `import * as b from './business'`, the above works as-is. Otherwise match existing import style.)

- [ ] **Step 5: Add schema test**

Append to `src/core/schema/schema.test.ts`:

```ts
it('SourceAsset accepts image metadata', () => {
  const result = SourceAsset.safeParse({
    id: 'asset_1',
    kind: 'image',
    storage_key: 'images/asset_1.png',
    mime_type: 'image/png',
    byte_size: 123,
    sha256: 'a'.repeat(64),
    width: null,
    height: null,
    provenance: {},
    created_at: new Date(1700000000 * 1000),
  });
  expect(result.success).toBe(true);
});
```

(Add `SourceAsset` to the existing import list at top of file.)

- [ ] **Step 6: Run test**

```bash
pnpm test src/core/schema/schema.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/core/schema/business.ts src/core/schema/generated.ts src/core/schema/index.ts src/core/schema/schema.test.ts drizzle/0002_*.sql drizzle/meta
git commit -m "feat(schema): add source_asset table"
```

---

### Task 2: R2 binding + POST /api/assets

**Files:**
- Modify: `workers/wrangler.toml`
- Modify: `workers/src/types.ts`
- Create: `workers/src/routes/assets.ts`
- Create: `workers/src/routes/assets.test.ts`
- Modify: `workers/src/index.ts`
- Modify: `workers/src/routes/knowledge.test.ts`（mockEnv 加 IMAGES stub）

- [ ] **Step 1: Verify R2 binding in wrangler.toml**

`workers/wrangler.toml` already has an `IMAGES` R2 binding. Do **not** append a second `[[r2_buckets]]` block with the same binding. Verify it remains exactly:

```toml
[[r2_buckets]]
binding = "IMAGES"
bucket_name = "learning-project-images"
preview_bucket_name = "learning-project-images-preview"
```

If the binding is missing in a fresh branch, add the snippet above once. Operator action before production deploy: create `learning-project-images` and `learning-project-images-preview` once.

- [ ] **Step 2: Add R2Bucket type to Bindings**

In `workers/src/types.ts`:

```ts
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export type Bindings = {
  ANTHROPIC_API_KEY: string;
  INTERNAL_TOKEN: string;
  DB: D1Database;
  IMAGES: R2Bucket;
};

export type AppEnv = { Bindings: Bindings };
```

- [ ] **Step 3: Write failing tests**

Create `workers/src/routes/assets.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types';
import { assets } from './assets';

function mockEnv() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const put = vi.fn(async () => null);
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...binds: unknown[]) => {
        calls.push({ sql, binds });
        return { run: async () => ({ success: true, meta: { changes: 1 } }) };
      },
    })),
  } as unknown as D1Database;
  return {
    Bindings: {
      DB: db,
      IMAGES: { put } as unknown as R2Bucket,
      INTERNAL_TOKEN: 't',
      ANTHROPIC_API_KEY: 't',
    },
    executionCtx: {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    calls,
    put,
  };
}

describe('POST /api/assets', () => {
  it('uploads PNG and writes source_asset metadata', async () => {
    const { Bindings, executionCtx, calls, put } = mockEnv();
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'q.png', { type: 'image/png' }));
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asset: { id: string; storage_key: string; mime_type: string; sha256: string } };
    expect(body.asset.id).toBeTruthy();
    expect(body.asset.storage_key).toMatch(/^images\/[a-z0-9]+\.png$/);
    expect(body.asset.mime_type).toBe('image/png');
    expect(body.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(put).toHaveBeenCalledOnce();
    expect(calls.some((c) => /insert into source_asset/i.test(c.sql))).toBe(true);
  });

  it('rejects missing file', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const res = await assets.request('/', { method: 'POST', body: new FormData() }, Bindings, executionCtx);
    expect(res.status).toBe(400);
  });

  it('rejects non-image mime', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const form = new FormData();
    form.set('file', new File(['x'], 'note.txt', { type: 'text/plain' }));
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/unsupported mime_type/);
  });

  it('rejects oversized file', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const big = new Uint8Array(9_000_000);
    const form = new FormData();
    form.set('file', new File([big], 'huge.png', { type: 'image/png' }));
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(400);
  });
});
```

Run:

```bash
pnpm test workers/src/routes/assets.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4: Implement route**

Create `workers/src/routes/assets.ts`:

```ts
import { Hono } from 'hono';
import { createId } from '@paralleldrive/cuid2';
import type { AppEnv } from '../types';

export const assets = new Hono<AppEnv>();

const MAX_UPLOAD_BYTES = 8_000_000;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extFromMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

assets.post('/', async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'validation_error', message: 'file is required' }, 400);
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return c.json({ error: 'validation_error', message: `unsupported mime_type: ${file.type}` }, 400);
  }
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'validation_error', message: `file size must be 1..${MAX_UPLOAD_BYTES}` }, 400);
  }

  const bytes = await file.arrayBuffer();
  const id = createId();
  const storageKey = `images/${id}.${extFromMime(file.type)}`;
  const sha256 = await sha256Hex(bytes);
  const now = Math.floor(Date.now() / 1000);

  await c.env.IMAGES.put(storageKey, bytes, {
    httpMetadata: { contentType: file.type },
    customMetadata: { source_asset_id: id, sha256 },
  });

  await c.env.DB.prepare(
    `insert into source_asset (
      id, kind, storage_key, mime_type, byte_size, sha256, width, height, provenance, created_at
    ) values (?, 'image', ?, ?, ?, ?, null, null, ?, ?)`,
  )
    .bind(
      id,
      storageKey,
      file.type,
      file.size,
      sha256,
      JSON.stringify({ entrypoint: 'manual_record', original_name: file.name }),
      now,
    )
    .run();

  return c.json({
    asset: {
      id,
      kind: 'image' as const,
      storage_key: storageKey,
      mime_type: file.type,
      byte_size: file.size,
      sha256,
    },
  });
});
```

- [ ] **Step 5: Mount route + update existing test mocks**

In `workers/src/index.ts`:

```ts
import { assets } from './routes/assets';
// ... after existing routes:
app.route('/api/assets', assets);
```

In `workers/src/routes/knowledge.test.ts` `mockEnv`, change the returned Bindings to include the IMAGES stub:

```ts
const images = { put: vi.fn(async () => null) } as unknown as R2Bucket;
return {
  Bindings: { DB: db, IMAGES: images, INTERNAL_TOKEN: 'test', ANTHROPIC_API_KEY: 'test' },
  calls,
};
```

(Add `R2Bucket` to the type imports.)

- [ ] **Step 6: Run tests**

```bash
pnpm test workers/src/routes/assets.test.ts workers/src/routes/knowledge.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/wrangler.toml workers/src/types.ts workers/src/routes/assets.ts workers/src/routes/assets.test.ts workers/src/index.ts workers/src/routes/knowledge.test.ts
git commit -m "feat(worker): R2 binding + POST /api/assets upload"
```

---

### Task 3: mistakes route — drop byte cap, validate asset existence

**Files:**
- Modify: `workers/src/routes/mistakes.ts`
- Modify: `workers/src/routes/mistakes.test.ts`

- [ ] **Step 1: Update test mock to support source_asset existence + IMAGES stub**

In `workers/src/routes/mistakes.test.ts` `mockEnv`, add `sourceAssetIds?: string[]` to opts. In the `prepare` `first` handler, add:

```ts
if (/select id from source_asset where id = \?/i.test(sql)) {
  const id = binds[0] as string;
  return (opts.sourceAssetIds ?? []).includes(id) ? { id } : null;
}
```

Also add `IMAGES` to the Bindings:

```ts
const images = { put: vi.fn(async () => null) } as unknown as R2Bucket;
// in returned Bindings:
{ DB: db, IMAGES: images, INTERNAL_TOKEN: 'test', ANTHROPIC_API_KEY: 'test' }
```

(Same change in `mockEnvWithList` for the GET /recent block.)

- [ ] **Step 2: Replace 2 byte-cap tests with 2 asset-existence tests**

In the same test file, **delete** these two tests:
- `'rejects when total image bytes exceed D1 cell limit'`
- `'rejects when wrong_answer_image_refs total exceeds limit'`

**Replace** the existing `'persists prompt_image_refs in question.metadata and wrong_answer_image_refs'` test with:

```ts
it('rejects unknown prompt_image_refs asset id', async () => {
  const { Bindings, executionCtx } = mockEnv({
    knowledgeRows: [{ id: 'k1', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
  });
  const res = await mistakes.request(
    '/',
    {
      method: 'POST',
      body: JSON.stringify({
        prompt_md: 'p',
        reference_md: null,
        wrong_answer_md: 'w',
        knowledge_ids: ['k1'],
        cause: null,
        difficulty: 3,
        question_kind: 'short_answer',
        prompt_image_refs: ['asset_missing'],
      }),
      headers: { 'content-type': 'application/json' },
    },
    Bindings,
    executionCtx,
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { message: string };
  expect(body.message).toMatch(/unknown prompt_image_refs/);
});

it('persists asset id refs and tags metadata kind', async () => {
  const { Bindings, executionCtx, calls } = mockEnv({
    knowledgeRows: [{ id: 'k1', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
    sourceAssetIds: ['asset_p', 'asset_w'],
  });
  const res = await mistakes.request(
    '/',
    {
      method: 'POST',
      body: JSON.stringify({
        prompt_md: 'p',
        reference_md: null,
        wrong_answer_md: 'w',
        knowledge_ids: ['k1'],
        cause: null,
        difficulty: 3,
        question_kind: 'short_answer',
        prompt_image_refs: ['asset_p'],
        wrong_answer_image_refs: ['asset_w'],
      }),
      headers: { 'content-type': 'application/json' },
    },
    Bindings,
    executionCtx,
  );
  expect(res.status).toBe(200);
  const insertQ = calls.find((c) => /insert into question/i.test(c.sql));
  const meta = JSON.parse((insertQ?.binds[6] as string) ?? '{}');
  expect(meta.prompt_image_refs).toEqual(['asset_p']);
  expect(meta.prompt_image_ref_kind).toBe('source_asset_id');
  const insertM = calls.find((c) => /insert into mistake/i.test(c.sql));
  const wrongRefs = JSON.parse(insertM?.binds[5] as string);
  expect(wrongRefs).toEqual(['asset_w']);
});
```

- [ ] **Step 3: Run — verify FAIL**

```bash
pnpm test workers/src/routes/mistakes.test.ts
```

Expected: 2 new tests fail (server still does byte cap, doesn't check asset existence).

- [ ] **Step 4: Implement**

In `workers/src/routes/mistakes.ts`:

1. **Delete** the `TOTAL_IMAGE_BYTES_LIMIT` constant + the two byte-cap blocks.

2. **Add** asset existence check helper near top:

```ts
async function assertAssetsExist(
  db: D1Database,
  ids: string[],
  field: 'prompt_image_refs' | 'wrong_answer_image_refs',
): Promise<{ ok: true } | { ok: false; missing: string[]; field: string }> {
  const missing: string[] = [];
  for (const id of ids) {
    const row = await db.prepare(`select id from source_asset where id = ?`).bind(id).first();
    if (!row) missing.push(id);
  }
  return missing.length > 0 ? { ok: false, missing, field } : { ok: true };
}
```

(Add `D1Database` to type imports.)

3. **Insert** the existence checks right after the knowledge_ids missing check:

```ts
const promptCheck = await assertAssetsExist(c.env.DB, body.prompt_image_refs, 'prompt_image_refs');
if (!promptCheck.ok) {
  return c.json(
    { error: 'validation_error', message: `unknown ${promptCheck.field}: ${promptCheck.missing.join(', ')}` },
    400,
  );
}
const wrongCheck = await assertAssetsExist(c.env.DB, body.wrong_answer_image_refs, 'wrong_answer_image_refs');
if (!wrongCheck.ok) {
  return c.json(
    { error: 'validation_error', message: `unknown ${wrongCheck.field}: ${wrongCheck.missing.join(', ')}` },
    400,
  );
}
```

4. **Update** the questionMetadata to tag the kind:

```ts
const questionMetadata =
  body.prompt_image_refs.length > 0
    ? JSON.stringify({
        prompt_image_refs: body.prompt_image_refs,
        prompt_image_ref_kind: 'source_asset_id' as const,
      })
    : null;
```

- [ ] **Step 5: Run — verify PASS**

```bash
pnpm test workers/src/routes/mistakes.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/src/routes/mistakes.ts workers/src/routes/mistakes.test.ts
git commit -m "feat(mistakes): validate source_asset existence; drop base64 byte cap"
```

---

### Task 4: /record migrate to asset upload

**Files:**
- Modify: `src/routes/record.tsx`

- [ ] **Step 1: Replace base64 image state with uploaded-asset state**

In `src/routes/record.tsx`:

1. **Remove** the `MAX_IMAGE_BYTES` const and `readFileAsDataUrl` function.

2. **Add** at top:

```ts
interface UploadedAsset {
  id: string;
  name: string;
  mime_type: string;
  byte_size: number;
}

async function uploadAsset(file: File): Promise<UploadedAsset> {
  const form = new FormData();
  form.set('file', file);
  const res = await fetch('/api/assets', {
    method: 'POST',
    headers: { 'x-internal-token': INTERNAL_TOKEN },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /api/assets ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { asset: { id: string; mime_type: string; byte_size: number } };
  return { id: body.asset.id, name: file.name, mime_type: body.asset.mime_type, byte_size: body.asset.byte_size };
}
```

3. **Change** state types:

```ts
const [promptImages, setPromptImages] = useState<UploadedAsset[]>([]);
const [wrongAnswerImages, setWrongAnswerImages] = useState<UploadedAsset[]>([]);
const [uploading, setUploading] = useState(false);
```

4. **Change** `appendImages` to upload one-by-one and push UploadedAsset:

```ts
async function appendImages(
  files: FileList | null,
  setter: (updater: (prev: UploadedAsset[]) => UploadedAsset[]) => void,
) {
  if (!files || files.length === 0) return;
  setErrorMsg(null);
  setUploading(true);
  try {
    const uploaded: UploadedAsset[] = [];
    for (const file of Array.from(files)) {
      uploaded.push(await uploadAsset(file));
    }
    setter((prev) => [...prev, ...uploaded]);
  } catch (e) {
    setErrorMsg(`上传图片失败: ${(e as Error).message}`);
  } finally {
    setUploading(false);
  }
}
```

5. **Change** the submit handler payload:

```ts
prompt_image_refs: promptImages.map((a) => a.id),
wrong_answer_image_refs: wrongAnswerImages.map((a) => a.id),
```

6. **Update** `<ImagePicker>` props to accept `images: UploadedAsset[]`. Replace `<img>` thumbnails with filename+size rows:

```tsx
{images.map((img, i) => (
  <li key={img.id} className="flex items-center justify-between text-xs border rounded px-2 py-1 gap-2">
    <span className="truncate">{img.name} · {(img.byte_size / 1024).toFixed(0)}KB</span>
    <button type="button" className="text-red-600 underline" onClick={() => onRemove(i)}>移除</button>
  </li>
))}
```

(Wrap `<ul>` around the list. Drop the data-URL-based `<img>` preview — that visual feedback can come back when GET /api/assets/:id/raw lands in PR B; for PR A keep filename only.)

7. **Disable** submit while uploading:

```tsx
<button type="submit" disabled={submitMutation.isPending || uploading} ...>
  {uploading ? '图片上传中...' : submitMutation.isPending ? '提交中...' : '提交'}
</button>
```

8. **Add** to the clear button: `setPromptImages([]); setWrongAnswerImages([]);` (already there — verify).

- [ ] **Step 2: Type check**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/routes/record.tsx
git commit -m "feat(record): upload images to /api/assets, send asset ids"
```

---

### Task 5: PR A verification + open PR

- [ ] **Step 1: Full test + typecheck + build**

```bash
pnpm test && pnpm typecheck && pnpm build
```

Expected: all green.

- [ ] **Step 2: Document operator action in commit body**

The R2 bucket must exist. Note this in the PR body:

> Operator pre-merge: `wrangler r2 bucket create learning-project-images` and `wrangler r2 bucket create learning-project-images-preview`. Local `pnpm workers:dev` uses miniflare's R2 simulator automatically.

- [ ] **Step 3: Open PR**

```bash
git push -u origin <branch>
gh pr create --title "Phase 1.5 PR A: R2 binding + source_asset (drop base64 inline)" --body "$(cat <<'EOF'
## Summary
- 加 `source_asset` 表 + drizzle 0002 migration
- `[[r2_buckets]] IMAGES` binding；POST /api/assets 上传 → R2 + insert metadata
- /record 改用 asset upload 流程（drop base64 readAsDataURL + 700KB 单图 cap + 800KB worker 总量 cap）
- mistakes.ts 不再 byte-cap，改成 source_asset 存在校验
- question.metadata 加 `prompt_image_ref_kind: 'source_asset_id'` 显式标记

## Operator action
- `wrangler r2 bucket create learning-project-images`
- `wrangler r2 bucket create learning-project-images-preview`

## Test plan
- [x] pnpm test
- [x] pnpm typecheck
- [x] pnpm build
- [ ] 手动: /record 提交一张 PNG，DB 检查 source_asset 行 + R2 object exists

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR B：Ingestion + vision_single 第一波

> **依赖**：PR A 已 merge。Local 须有 R2 bucket 创建。

### Task 6: ingestion schema + 0003 migration

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/core/schema/business.ts`
- Modify: `src/core/schema/generated.ts` + `index.ts`
- Create (by `pnpm db:generate`): `drizzle/0003_*.sql` + meta
- Modify: `src/core/schema/schema.test.ts`

- [ ] **Step 1: Add enums to business.ts**

```ts
export const IngestionSessionStatus = z.enum([
  'uploaded',
  'extracted',
  'reviewed',
  'imported',
  'failed',
]);

export const QuestionBlockStatus = z.enum([
  'draft',
  'reviewed',
  'merged',
  'imported',
  'ignored',
]);

export const QuestionBlockRole = z.enum(['prompt', 'answer_area', 'continuation']);

export const VisualComplexity = z.enum(['low', 'medium', 'high']);
```

- [ ] **Step 2: Add three tables to drizzle schema**

In `src/db/schema.ts` after `source_asset`:

```ts
export const source_document = sqliteTable('source_document', {
  id: text('id').primaryKey(),
  title: text('title'),
  source_asset_ids: text('source_asset_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  body_md: text('body_md'),
  provenance: text('provenance', { mode: 'json' }).notNull().default({}),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});

export const ingestion_session = sqliteTable('ingestion_session', {
  id: text('id').primaryKey(),
  source_document_id: text('source_document_id'),
  source_asset_ids: text('source_asset_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('uploaded'),
  entrypoint: text('entrypoint').notNull(),
  error_message: text('error_message'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});

export const question_block = sqliteTable('question_block', {
  id: text('id').primaryKey(),
  ingestion_session_id: text('ingestion_session_id').notNull(),
  source_document_id: text('source_document_id'),
  source_asset_ids: text('source_asset_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  page_spans: text('page_spans', { mode: 'json' })
    .$type<Array<{ page_index: number; bbox: { x: number; y: number; width: number; height: number }; role?: string }>>()
    .notNull()
    .default([]),
  extracted_prompt_md: text('extracted_prompt_md').notNull(),
  reference_md: text('reference_md'),
  wrong_answer_md: text('wrong_answer_md'),
  image_refs: text('image_refs', { mode: 'json' }).$type<string[]>().notNull().default([]),
  crop_refs: text('crop_refs', { mode: 'json' }).$type<string[]>().notNull().default([]),
  visual_complexity: text('visual_complexity').notNull().default('low'),
  extraction_confidence: real('extraction_confidence').notNull().default(1),
  status: text('status').notNull().default('draft'),
  knowledge_hint: text('knowledge_hint'),
  merged_from_block_ids: text('merged_from_block_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  imported_question_id: text('imported_question_id'),
  imported_mistake_id: text('imported_mistake_id'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});
```

- [ ] **Step 3: Generate migration**

```bash
pnpm db:generate
```

Verify `drizzle/0003_*.sql` has 3 `CREATE TABLE`s and `_journal.json` is updated.

- [ ] **Step 4: Add zod exports**

In `src/core/schema/generated.ts`, append:

```ts
export const SourceDocumentInsertGenerated = createInsertSchema(t.source_document);
export const SourceDocumentSelectGenerated = createSelectSchema(t.source_document);

export const IngestionSessionInsertGenerated = createInsertSchema(t.ingestion_session);
export const IngestionSessionSelectGenerated = createSelectSchema(t.ingestion_session);

export const QuestionBlockInsertGenerated = createInsertSchema(t.question_block);
export const QuestionBlockSelectGenerated = createSelectSchema(t.question_block);
```

In `src/core/schema/index.ts`, append after the `SourceAsset` section:

```ts
const PageSpan = z.object({
  page_index: z.number().int().min(0),
  bbox: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  }),
  role: b.QuestionBlockRole.optional(),
});

// ---------- Ingestion ----------
export const SourceDocumentInsert = g.SourceDocumentInsertGenerated;
export const SourceDocument = g.SourceDocumentSelectGenerated;
export type SourceDocument = z.infer<typeof SourceDocument>;

export const IngestionSessionInsert = g.IngestionSessionInsertGenerated.extend({
  status: b.IngestionSessionStatus.nullish(),
  entrypoint: z.enum(['vision_single', 'vision_paper']),
});
export const IngestionSession = g.IngestionSessionSelectGenerated.extend({
  status: b.IngestionSessionStatus,
  entrypoint: z.enum(['vision_single', 'vision_paper']),
});
export type IngestionSession = z.infer<typeof IngestionSession>;

export const QuestionBlockInsert = g.QuestionBlockInsertGenerated.extend({
  page_spans: z.array(PageSpan).min(1).max(8),
  status: b.QuestionBlockStatus.nullish(),
  visual_complexity: b.VisualComplexity.nullish(),
});
export const QuestionBlock = g.QuestionBlockSelectGenerated.extend({
  page_spans: z.array(PageSpan).min(1).max(8),
  status: b.QuestionBlockStatus,
  visual_complexity: b.VisualComplexity,
});
export type QuestionBlock = z.infer<typeof QuestionBlock>;
```

- [ ] **Step 5: Add schema tests**

In `src/core/schema/schema.test.ts`, add `QuestionBlock` and `QuestionBlockInsert` to the existing import from `./index`, then append these tests inside the existing `describe('schema generated from drizzle', ...)` block:

```ts
it('QuestionBlock accepts page_spans with role', () => {
  const parsed = QuestionBlockInsert.parse({
    id: 'qb_1',
    ingestion_session_id: 'sess_1',
    source_document_id: 'doc_1',
    source_asset_ids: ['asset_1'],
    page_spans: [
      {
        page_index: 0,
        bbox: { x: 0.1, y: 0.2, width: 0.6, height: 0.3 },
        role: 'prompt',
      },
    ],
    extracted_prompt_md: '题面',
    reference_md: null,
    wrong_answer_md: null,
    image_refs: ['asset_1'],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 0.9,
    status: 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_mistake_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    version: 0,
  });
  expect(parsed.page_spans[0].role).toBe('prompt');
});

it('QuestionBlock accepts merged from multiple page-level blocks', () => {
  const parsed = QuestionBlock.parse({
    id: 'qb_merged',
    ingestion_session_id: 'sess_1',
    source_document_id: 'doc_1',
    source_asset_ids: ['asset_1', 'asset_2'],
    page_spans: [
      { page_index: 0, bbox: { x: 0, y: 0.7, width: 1, height: 0.3 }, role: 'continuation' },
      { page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 0.4 }, role: 'answer_area' },
    ],
    extracted_prompt_md: '跨页题面',
    reference_md: null,
    wrong_answer_md: '错答',
    image_refs: ['asset_1', 'asset_2'],
    crop_refs: [],
    visual_complexity: 'medium',
    extraction_confidence: 0.8,
    status: 'merged',
    knowledge_hint: null,
    merged_from_block_ids: ['qb_1', 'qb_2'],
    imported_question_id: null,
    imported_mistake_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    version: 0,
  });
  expect(parsed.page_spans).toHaveLength(2);
  expect(parsed.merged_from_block_ids).toEqual(['qb_1', 'qb_2']);
});
```

- [ ] **Step 6: Run tests**

```bash
pnpm test src/core/schema/schema.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/core/schema/business.ts src/core/schema/generated.ts src/core/schema/index.ts src/core/schema/schema.test.ts drizzle/0003_*.sql drizzle/meta
git commit -m "feat(schema): add ingestion_session, source_document, question_block (page_spans)"
```

---

### Task 7: VisionExtractTask wire + multimodal runner

**Files:**
- Modify: `src/ai/registry.ts`
- Modify: `workers/src/ai/runner.ts`
- Modify: `workers/src/ai/runner.test.ts`
- Create: `workers/src/ingestion/vision.ts`
- Create: `workers/src/ingestion/vision.test.ts`

- [ ] **Step 1: Add failing runner test for multimodal input**

Append inside `describe('runTask (single-shot, no tools)', ...)` in `workers/src/ai/runner.test.ts`:

```ts
  it('passes image content parts when input is multimodal', async () => {
    let seenPrompt: unknown;
    const mockModel = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seenPrompt = options.prompt;
        return makeMockGenerateResult('{"blocks":[]}');
      },
    });
    const { db } = makeMockDb();

    await runTask(
      'VisionExtractTask',
      {
        text: 'Extract blocks from page_index=0. Return strict JSON.',
        images: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
      },
      { env: { DB: db } as never, model: mockModel },
    );

    const serialized = JSON.stringify(seenPrompt);
    expect(serialized).toContain('"type":"image"');
    expect(serialized).toContain('image/png');
  });
```

Run:

```bash
pnpm test workers/src/ai/runner.test.ts
```

Expected: FAIL because current `runTask` serializes every object input into a text `prompt`.

- [ ] **Step 2: Implement `runTask` multimodal branch**

In `workers/src/ai/runner.ts`, change the import to include `ModelMessage`:

```ts
import {
  generateText,
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
```

Add these helpers above `runTask`:

```ts
export interface MultimodalTaskInput {
  text: string;
  images: Array<{ data: string | Uint8Array | ArrayBuffer | URL; mediaType: string }>;
}

function isMultimodalTaskInput(input: unknown): input is MultimodalTaskInput {
  if (input == null || typeof input !== 'object') return false;
  const candidate = input as { text?: unknown; images?: unknown };
  return (
    typeof candidate.text === 'string' &&
    Array.isArray(candidate.images) &&
    candidate.images.every((image) => {
      const img = image as { data?: unknown; mediaType?: unknown };
      return img.data != null && typeof img.mediaType === 'string' && img.mediaType.startsWith('image/');
    })
  );
}

function textPrompt(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function multimodalMessages(input: MultimodalTaskInput): ModelMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: input.text },
        ...input.images.map((image) => ({
          type: 'image' as const,
          image: image.data,
          mediaType: image.mediaType,
        })),
      ],
    },
  ];
}
```

Replace the current `generateText` call inside `runTask` with:

```ts
  const baseOptions = {
    model,
    system: def.systemPrompt,
    abortSignal: AbortSignal.timeout(def.budget.timeout),
  };

  const result = isMultimodalTaskInput(input)
    ? await generateText({
        ...baseOptions,
        messages: multimodalMessages(input),
      })
    : await generateText({
        ...baseOptions,
        prompt: textPrompt(input),
      });
```

Keep `streamTask` text-only for this PR. Vision uses `runTask`, not `streamTask`.

- [ ] **Step 3: Verify runner test passes**

```bash
pnpm test workers/src/ai/runner.test.ts
```

Expected: PASS.

- [ ] **Step 4: Update VisionExtractTask in registry**

In `src/ai/registry.ts`, replace the existing `VisionExtractTask` block with:

```ts
  VisionExtractTask: {
    kind: 'VisionExtractTask',
    description: '错题图片 → 切块 + 题面 + 答案 + bbox',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbackChain: [],
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    systemPrompt:
      '你是错题录入助手。给定一张题目图片（试卷/手写/教材截图），输出严格 JSON（不带 markdown 代码块包裹）：\n{"blocks":[{"extracted_prompt_md":"...","reference_md":"...|null","wrong_answer_md":"...|null","page_index":0,"bbox":{"x":0.1,"y":0.2,"width":0.6,"height":0.3},"role":"prompt|answer_area|continuation","visual_complexity":"low|medium|high","extraction_confidence":0.0-1.0,"knowledge_hint":"...|null"}]}\n约束：bbox 坐标 0-1 归一化（不是像素）；一图可输出 1+ 个 block（一页多题）；page_index 由调用方覆盖；wrong_answer_md 仅当图上有用户错答 / 批改痕迹时填；knowledge_hint 是软提示。',
  },
```

- [ ] **Step 5: Write failing vision parser/extract tests**

Create `workers/src/ingestion/vision.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { parseVisionOutput, runVisionExtract } from './vision';

const oneBlockJson =
  '{"blocks":[{"extracted_prompt_md":"题1","reference_md":"a1","wrong_answer_md":null,"page_index":0,"bbox":{"x":0.1,"y":0.1,"width":0.5,"height":0.3},"role":"prompt","visual_complexity":"low","extraction_confidence":0.9,"knowledge_hint":"虚词"}]}';

describe('parseVisionOutput', () => {
  it('parses well-formed multi-block JSON', () => {
    const out = parseVisionOutput(oneBlockJson);
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].extracted_prompt_md).toBe('题1');
    expect(out.blocks[0].bbox.x).toBe(0.1);
  });

  it('extracts JSON from prose', () => {
    const text = `识别如下：\n${oneBlockJson}\n以上。`;
    const out = parseVisionOutput(text);
    expect(out.blocks).toHaveLength(1);
  });

  it('throws on non-JSON', () => {
    expect(() => parseVisionOutput('not json')).toThrow();
  });

  it('throws on bbox out of [0,1]', () => {
    const text = '{"blocks":[{"extracted_prompt_md":"x","reference_md":null,"wrong_answer_md":null,"page_index":0,"bbox":{"x":1.5,"y":0,"width":1,"height":1},"role":"prompt","visual_complexity":"low","extraction_confidence":0.5,"knowledge_hint":null}]}';
    expect(() => parseVisionOutput(text)).toThrow();
  });
});

describe('runVisionExtract', () => {
  it('passes image bytes as multimodal input and overrides pageIndex', async () => {
    const runTaskFn = vi.fn(async () => ({ text: oneBlockJson }));
    const out = await runVisionExtract({
      assetId: 'asset_1',
      mimeType: 'image/png',
      imageBytes: new Uint8Array([1, 2, 3]).buffer,
      pageIndex: 3,
      env: { DB: {} } as never,
      runTaskFn,
    });

    expect(runTaskFn).toHaveBeenCalledWith(
      'VisionExtractTask',
      {
        text: 'Extract question blocks from page_index=3. Return strict JSON only.',
        images: [{ data: expect.any(ArrayBuffer), mediaType: 'image/png' }],
      },
      { env: { DB: {} } },
    );
    expect(out.asset_id).toBe('asset_1');
    expect(out.blocks[0].page_index).toBe(3);
    expect(out.blocks[0]._input_page_index).toBe(3);
  });
});
```

Run: expect FAIL because `vision.ts` does not exist.

- [ ] **Step 6: Implement `parseVisionOutput` + `runVisionExtract`**

Create `workers/src/ingestion/vision.ts`:

```ts
import { z } from 'zod';
import { QuestionBlockRole, VisualComplexity } from '../../../src/core/schema/business';

const BBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

const VisionBlockSchema = z.object({
  extracted_prompt_md: z.string().min(1).max(5000),
  reference_md: z.string().nullable(),
  wrong_answer_md: z.string().nullable(),
  page_index: z.number().int().min(0),
  bbox: BBoxSchema,
  role: QuestionBlockRole,
  visual_complexity: VisualComplexity,
  extraction_confidence: z.number().min(0).max(1),
  knowledge_hint: z.string().nullable(),
});

const VisionOutputSchema = z.object({
  blocks: z.array(VisionBlockSchema).min(1).max(20),
});

export type VisionOutput = z.infer<typeof VisionOutputSchema>;
export type VisionBlock = z.infer<typeof VisionBlockSchema>;

export function parseVisionOutput(text: string): VisionOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('parseVisionOutput: no JSON');
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseVisionOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return VisionOutputSchema.parse(json);
}

export interface RunVisionExtractParams {
  assetId: string;
  mimeType: string;
  imageBytes: ArrayBuffer;
  pageIndex: number;
  runTaskFn: (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
  env: unknown;
}

export interface ExtractedForAsset {
  asset_id: string;
  blocks: Array<VisionBlock & { _input_page_index: number }>;
}

export async function runVisionExtract(params: RunVisionExtractParams): Promise<ExtractedForAsset> {
  const result = await params.runTaskFn(
    'VisionExtractTask',
    {
      text: `Extract question blocks from page_index=${params.pageIndex}. Return strict JSON only.`,
      images: [{ data: params.imageBytes, mediaType: params.mimeType }],
    },
    { env: params.env },
  );
  const parsed = parseVisionOutput(result.text);
  return {
    asset_id: params.assetId,
    blocks: parsed.blocks.map((b) => ({
      ...b,
      page_index: params.pageIndex,
      _input_page_index: params.pageIndex,
    })),
  };
}
```

- [ ] **Step 7: Run tests + commit**

```bash
pnpm test workers/src/ai/runner.test.ts workers/src/ingestion/vision.test.ts
git add src/ai/registry.ts workers/src/ai/runner.ts workers/src/ai/runner.test.ts workers/src/ingestion/vision.ts workers/src/ingestion/vision.test.ts
git commit -m "feat(vision): VisionExtractTask multimodal runner + parser"
```

---

### Task 8: POST /api/ingestion (sync extract)

**Files:**
- Create: `workers/src/routes/ingestion.ts`
- Create: `workers/src/routes/ingestion.test.ts`
- Modify: `workers/src/index.ts`

Endpoint contract:

`POST /api/ingestion`
Body:
```ts
{ entrypoint: 'vision_single' | 'vision_paper'; asset_ids: string[] }
```
Behavior:
1. Validate every `asset_id` exists in `source_asset`; select at least `id/storage_key/mime_type`.
2. Insert one `source_document` row.
3. Insert one `ingestion_session` row, status='uploaded', source_document_id set, source_asset_ids=asset_ids.
4. For each asset, call `await c.env.IMAGES.get(storage_key)`. If the object is missing, treat only that asset as failed; do not depend on a public R2 URL or `/api/assets/:id/raw`.
5. For each loaded R2 object, call `runVisionExtract({ assetId, mimeType, imageBytes: await object.arrayBuffer(), pageIndex, env: c.env, runTaskFn: runTask })` (Promise.all for batch). For each output block, insert one `question_block` (status='draft', page_spans=[{page_index, bbox, role}], image_refs=[asset_id]).
6. Update session.status = 'extracted' (or 'failed' if all vision calls / R2 reads failed).
7. Return `{ session, blocks }`.

- [ ] **Step 1: Write failing route tests**

Create `workers/src/routes/ingestion.test.ts` with a `mockEnv()` that handles:
- `select id, storage_key, mime_type from source_asset where id = ?`
- inserts into `source_document`, `ingestion_session`, `question_block`
- updates `ingestion_session.status`
- `IMAGES.get(storage_key)` returning `{ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }`

Tests:
- happy path: 2 asset ids → returns status 200, inserts 1 source_document, 1 ingestion_session, 2 question_block rows, calls runTask twice, returns `blocks.length === 2`.
- asset row missing: unknown asset id → 400, no R2 reads, no vision calls.
- one R2 object missing: one asset's `IMAGES.get` returns null → still returns 200 if another asset extracts; session.status='extracted'.
- all R2 objects missing or all vision calls throw → returns 200 with `session.status === 'failed'` and empty blocks.

Run:

```bash
pnpm test workers/src/routes/ingestion.test.ts
```

Expected: FAIL because route is not implemented.

- [ ] **Step 2: Create ingestion route with test injection**

At the top of `workers/src/routes/ingestion.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { runTask } from '../ai/runner';
import { runVisionExtract } from '../ingestion/vision';
import type { AppEnv } from '../types';

export const ingestion = new Hono<AppEnv>();

type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;
let runTaskFn: RunTaskFn = async (kind, input, ctx) => {
  const result = await runTask(kind, input, ctx as { env: AppEnv['Bindings'] });
  return { text: result.text };
};
export function setIngestionRunTaskForTests(fn: RunTaskFn) {
  runTaskFn = fn;
}

const CreateBody = z.object({
  entrypoint: z.enum(['vision_single', 'vision_paper']),
  asset_ids: z.array(z.string().min(1)).min(1).max(5),
});
```

- [ ] **Step 3: Implement asset validation and private R2 read**

Inside `ingestion.post('/', async (c) => { ... })`, parse `CreateBody`, select all asset rows by id, and return 400 if any are missing. For each row:

```ts
const object = await c.env.IMAGES.get(row.storage_key);
if (!object) {
  failures.push({ asset_id: row.id, error: 'r2_object_missing' });
  continue;
}
const imageBytes = await object.arrayBuffer();
const extracted = await runVisionExtract({
  assetId: row.id,
  mimeType: row.mime_type,
  imageBytes,
  pageIndex,
  env: c.env,
  runTaskFn,
});
```

Do not generate or require a public R2 URL.

- [ ] **Step 4: Insert session and blocks**

Use `createId()` for `source_document.id`, `ingestion_session.id`, and each `question_block.id`. Insert `question_block.page_spans` as:

```ts
JSON.stringify([{ page_index: block.page_index, bbox: block.bbox, role: block.role }])
```

Set `question_block.status='draft'`, `image_refs=[asset_id]`, `source_asset_ids=[asset_id]`, `extraction_confidence`, `visual_complexity`, `knowledge_hint`, `created_at/updated_at`, and `version=0`.

- [ ] **Step 5: Mount route**

In `workers/src/index.ts`:

```ts
import { ingestion } from './routes/ingestion';

app.route('/api/ingestion', ingestion);
```

- [ ] **Step 6: Run tests**

```bash
pnpm test workers/src/routes/ingestion.test.ts workers/src/ingestion/vision.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/src/routes/ingestion.ts workers/src/routes/ingestion.test.ts workers/src/index.ts
git commit -m "feat(ingestion): POST /api/ingestion sync vision extract"
```

---

### Task 9: POST /api/ingestion/:id/import

Endpoint contract:

`POST /api/ingestion/:id/import`
Body:
```ts
{
  blocks: Array<{
    block_id?: string;           // present only for an unchanged existing question_block
    source_block_ids: string[];  // original question_block ids used by this final card; length 1 for split/unchanged, N for merged
    page_spans: Array<{ page_index: number; bbox: { x: number; y: number; width: number; height: number }; role?: 'prompt' | 'answer_area' | 'continuation' }>;
    image_refs: string[];        // source_asset ids used by this final card
    final_prompt_md: string;
    final_reference_md: string | null;
    final_wrong_answer_md: string;
    knowledge_ids: string[];     // user picks from current tree
    cause: { primary_category: string; user_notes: string | null } | null;
    difficulty: number;          // 1-5, default 3
    question_kind: string;
  }>
}
```
Behavior per block:
1. Validate `source_block_ids` are non-empty and every source block belongs to this session. Validate `image_refs` all appear in the session's `source_asset_ids`.
2. If `block_id` is present, it must be one of `source_block_ids` and belong to this session. If `block_id` is absent (merged or split client-side card), insert a new `question_block` row with `status='imported'`, `source_asset_ids/image_refs/page_spans/final fields`, and `merged_from_block_ids=source_block_ids`.
3. Insert `question` row (kind = body.question_kind, prompt_md = final_prompt_md, knowledge_ids, source=session.entrypoint (`vision_single` or `vision_paper`), metadata = `{prompt_image_refs: image_refs, prompt_image_ref_kind: 'source_asset_id', source_document_id, ingestion_session_id, question_block_id}`).
4. Insert `mistake` row (wrong_answer_md = final_wrong_answer_md or source block's extracted wrong answer, wrong_answer_image_refs = `image_refs` filtered by `page_spans.role === 'answer_area'` OR empty, source=session.entrypoint (`vision_single` or `vision_paper`), knowledge_ids, cause). Do **not** use `manual_vision`; it is not in `MistakeSource`.
5. Update imported block status='imported', imported_question_id, imported_mistake_id. If this was a merged/split client-side card, update source blocks status='ignored' unless one of them is also imported as an unchanged card in the same request.
6. If body.cause === null, call `c.executionCtx.waitUntil(runAttributionAndWrite({ db: c.env.DB, mistakeId, expectedVersion: 0, input: { prompt_md: final_prompt_md, reference_md: final_reference_md, wrong_answer_md: final_wrong_answer_md, knowledge_context }, runTaskFn, env: c.env }))`.
7. Single propose waitUntil per block (Sub 2 pattern).
8. After all blocks: update `ingestion_session.status='imported'`.

Tests:
- happy: 1 block → 1 question + 1 mistake + 2 waitUntil (propose + attribution).
- block.cause provided: only 1 waitUntil (propose).
- knowledge_ids missing → 400 per block path; or full request 400 if any block fails (return early).
- session not found → 404.
- any `source_block_ids` not in session → 400.
- client-side merged card with no `block_id` → creates synthetic imported `question_block`, marks source blocks ignored, imports 1 question + 1 mistake.
- client-side split cards sharing one source block id → creates one synthetic imported `question_block` per split card.
- Returns `{ question_ids: string[], mistake_ids: string[] }`.

- [ ] **Step 1: Write failing import tests**

Append import tests to `workers/src/routes/ingestion.test.ts`:
- unchanged card: existing `block_id` + `source_block_ids=[block_id]` → inserts 1 question + 1 mistake, updates that question_block imported, returns ids.
- provided cause: only propose waitUntil is queued; no attribution waitUntil.
- no cause: propose waitUntil + attribution waitUntil are queued.
- unknown knowledge_id → 400 and no inserts.
- session not found → 404.
- `source_block_ids` containing a block from another session → 400.
- merged virtual card with no `block_id` and 2 `source_block_ids` → inserts a synthetic imported question_block, marks source blocks ignored, inserts 1 question + 1 mistake.
- split virtual cards sharing one `source_block_id` → inserts one synthetic imported question_block per submitted final card.

Run:

```bash
pnpm test workers/src/routes/ingestion.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Add import body schema**

In `workers/src/routes/ingestion.ts`, add:

```ts
const PageSpanBody = z.object({
  page_index: z.number().int().min(0),
  bbox: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  }),
  role: z.enum(['prompt', 'answer_area', 'continuation']).optional(),
});

const ImportBody = z.object({
  blocks: z.array(z.object({
    block_id: z.string().min(1).optional(),
    source_block_ids: z.array(z.string().min(1)).min(1).max(20),
    page_spans: z.array(PageSpanBody).min(1).max(8),
    image_refs: z.array(z.string().min(1)).min(1).max(20),
    final_prompt_md: z.string().min(1).max(10000),
    final_reference_md: z.string().nullable(),
    final_wrong_answer_md: z.string().min(1).max(10000),
    knowledge_ids: z.array(z.string().min(1)).min(1),
    cause: z.object({ primary_category: z.string(), user_notes: z.string().nullable() }).nullable(),
    difficulty: z.number().int().min(1).max(5).default(3),
    question_kind: z.string().min(1),
  })).min(1).max(50),
});
```

- [ ] **Step 3: Validate session, source blocks, images, and knowledge ids**

For each submitted final card:
- load the session by `:id`; 404 if missing.
- load every `source_block_ids` row and verify `ingestion_session_id === session.id`.
- verify every `image_refs` item appears in `session.source_asset_ids`.
- verify every `knowledge_ids` row exists and is not archived.
- if `block_id` is present, verify it is included in `source_block_ids`.

- [ ] **Step 4: Create synthetic block when needed**

If `block_id` is absent, insert a new `question_block` with `status='imported'`, final edited fields, `page_spans`, `image_refs`, `source_asset_ids=image_refs`, and `merged_from_block_ids=source_block_ids`. Use that new id as `question_block_id` in question metadata.

- [ ] **Step 5: Insert question + mistake**

Use `session.entrypoint` for both `question.source` and `mistake.source`. Metadata must include:

```ts
{
  prompt_image_refs: image_refs,
  prompt_image_ref_kind: 'source_asset_id',
  source_document_id: session.source_document_id,
  ingestion_session_id: session.id,
  question_block_id,
}
```

Then update imported block with `imported_question_id` and `imported_mistake_id`. For merged/split virtual cards, mark source blocks `ignored` unless that source block is also directly imported in the same request.

- [ ] **Step 6: Queue propose + attribution tasks**

For each imported mistake:
- always queue `runProposeAndWrite` with final prompt/reference/wrong answer/knowledge ids.
- queue `runAttributionAndWrite` only when `cause === null`.

- [ ] **Step 7: Run tests + commit**

```bash
pnpm test workers/src/routes/ingestion.test.ts workers/src/routes/mistakes.test.ts
git add workers/src/routes/ingestion.ts workers/src/routes/ingestion.test.ts
git commit -m "feat(ingestion): import question_blocks into question + mistake"
```

---

### Task 10: /ingest UI

**Files:**
- Create: `src/routes/ingest.tsx`

Functional flow:

1. **Upload phase**:
   - File picker (multiple images) → uploads each via existing `uploadAsset` (factor out from `record.tsx` to a shared helper if not already; Task 4 keeps it in record.tsx — for Task 10 either extract to `src/lib/upload.ts` OR duplicate `uploadAsset` in ingest.tsx — pick whichever requires less file movement; if you extract, also update record.tsx import).
   - Show thumbnails (later — for MVP filenames only).
   - "开始提取" button → POST `/api/ingestion` with collected `asset_ids` + entrypoint `vision_single`.

2. **Review phase**:
   - Display each returned block as a card:
     - Page indicator + bbox preview (later, for MVP just show "page 0")
     - Editable `extracted_prompt_md` textarea
     - Editable `reference_md` textarea
     - Editable `wrong_answer_md` textarea
     - Visual complexity + confidence badge (low confidence highlighted yellow)
     - Knowledge multi-select (reused from /record knowledgeOptions)
     - Cause select (留空 → AI 自动归因)
     - "拆分本题" button: locally splits the block's prompt_md content into 2 client-side virtual cards (for the edge case "Vision 把 2 题塞进 1 block"). Each virtual card has `block_id: undefined`, `source_block_ids: [original.block_id]`, copied `page_spans`, copied `image_refs`, and its own editable fields.
   - Multi-select checkboxes top of each card + sticky bar with "合并选中 N 题" button (only enabled if ≥ 2 selected)
     - Merge: client-side concatenates `extracted_prompt_md` of selected blocks (separator `\n\n`), unions `image_refs`, concatenates `page_spans` arrays preserving page_index order, removes the original cards from list, inserts merged virtual card at the topmost-selected position. The merged card has `block_id: undefined`, `source_block_ids: selected.flatMap(card.source_block_ids ?? [card.block_id])`, and local status='merged'.
   - "全部导入" button → POST `/api/ingestion/:id/import` with the final per-card payload. Unchanged cards send their existing `block_id`; merged/split virtual cards omit `block_id` and rely on `source_block_ids/page_spans/image_refs`.

3. **Done phase**:
   - On success → navigate `/mistakes`.

For MVP keep edits client-side only — do NOT hit a "save block" endpoint per edit (avoid round-trip). The `/import` call is the only persistence of user edits. (Acceptable trade-off: refresh loses edits; user is warned with `beforeunload`.)

(This is a single-file ~300-line page; allow it.)

- [ ] **Step 1: Implement** as above.

- [ ] **Step 2: Type check**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/ingest.tsx
git commit -m "feat(ingest): /ingest page upload + review + merge/split + import"
```

---

### Task 11: route mount + nav links

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/routes/inspect.tsx`
- Modify: `src/routes/record.tsx`

- [ ] **Step 1: Mount /ingest in App.tsx**

```tsx
import { IngestSession } from './routes/ingest';
<Route path="/ingest" element={<IngestSession />} />
```

- [ ] **Step 2: Inspect link**

In `src/routes/inspect.tsx`, prepend `/ingest`:

```tsx
Other admin pages:{' '}
<a href="/record" className="underline">/record</a> ·{' '}
<a href="/ingest" className="underline">/ingest</a> ·{' '}
<a href="/mistakes" className="underline">/mistakes</a> ·{' '}
<a href="/knowledge" className="underline">/knowledge</a> ·{' '}
<a href="/knowledge/proposals" className="underline">/knowledge/proposals</a>
```

- [ ] **Step 3: /record top hint**

In `src/routes/record.tsx`, after the "录完跳转" hint paragraph, add:

```tsx
<p className="text-sm text-slate-500 mb-2">
  拍试卷或多张图? 试 <a href="/ingest" className="underline">/ingest</a> (vision OCR 切块再审核)。
</p>
```

- [ ] **Step 4: typecheck + tests**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/routes/inspect.tsx src/routes/record.tsx
git commit -m "feat(client): mount /ingest + nav hints"
```

---

### Task 12: PR B verify + open

- [ ] **Step 1: pnpm test && pnpm typecheck && pnpm build**

Expected: all green.

- [ ] **Step 2: Manual smoke**

Two terminals: `pnpm workers:dev` and `pnpm dev`.

Manual flow:
1. Open `/ingest`.
2. Upload 1 PNG of a test paper question.
3. "开始提取" → wait ~10s → see 1+ blocks rendered.
4. Edit one block's prompt_md.
5. Pick knowledge_ids, leave cause empty.
6. "全部导入" → navigate `/mistakes` → new mistake row appears with "归因中..." badge → ~5s later turns into AI cause badge.
7. DB check (`wrangler d1 execute`):
   - `select * from ingestion_session` → 1 row, status='imported'
   - `select * from question_block where ingestion_session_id = '<id>'` → status='imported'
   - `select * from question where source = 'vision_single'` → row with metadata.prompt_image_refs

- [ ] **Step 3: Open PR**

```bash
git push -u origin <branch>
gh pr create --title "Phase 1.5 PR B: vision_single OCR ingestion + manual merge UI" --body "..."
```

PR body covers:
- Schema (3 new tables, page_spans schema decision)
- VisionExtractTask wire (haiku 4.5 multimodal, JSON output)
- /ingest page (upload → review → edit/merge/split → import)
- Cross-page handling: manual merge button (A path of spec § Block Assembly)
- Sub 3 pattern reused: AttributionTask waitUntil per imported mistake
- Test count, build status, manual smoke checklist

---

## Self-Review Checklist

PR A:

- [ ] R2 bucket creation documented in PR body
- [ ] /record uploads asset before submit; clear button resets uploaded state
- [ ] mistakes route validates source_asset existence; no byte cap left
- [ ] question.metadata records `prompt_image_ref_kind = 'source_asset_id'`
- [ ] All worker tests' `mockEnv` include `IMAGES` stub

PR B:

- [ ] page_spans schema: arrays of `{page_index, bbox, role?}` (not single page_index)
- [ ] VisionExtractTask single-shot JSON; isMultimodal=true
- [ ] ingestion.import path triggers AttributionTask via waitUntil mirroring Sub 3
- [ ] manual merge in client only (no merge endpoint); merged block has status='merged' + merged_from_block_ids
- [ ] /ingest reuses knowledge tree query
- [ ] Failure modes: vision throw on one asset → other blocks still inserted; session.status='failed' only if all fail

---

## Open / 实施时再决

1. **R2 read endpoint**：Vision 不依赖 `/api/assets/:id/raw`，Worker 在 Task 8 通过 private `c.env.IMAGES.get(storage_key)` 读 bytes。`/api/assets/:id/raw` 只为 /ingest UI 缩略图需要；MVP Task 10 缩略图 deferred，后续真需要时再加 GET endpoint with auth。不要要求 bucket public access。
2. **Vision 多页 batch 性能**：5+ 张图同时跑 haiku 4.5 vision，30s timeout 可能不够。如果 PR B Task 8 实际撞超时，把 sync 改成 `c.executionCtx.waitUntil` 异步路径 + 前端 polling `/api/ingestion/:id`（pattern: 沿用 /mistakes/recent refetchInterval）。
3. **Wrangler R2 simulator 行为**：`wrangler dev` 默认 miniflare R2 in-memory；重启 dev server 数据丢。Plan handoff 提示用户用 `--persist` 或接 production bucket（看自用偏好）。
4. **page_spans 长度上限**：当前 schema 没限。建议 zod 加 `.max(8)`（一题跨 8 页极罕见）防 LLM 输入极端。
5. **vision 输出 page_index**：vision 单图只看一张图，page_index 由调用方覆盖（Task 7 `runVisionExtract` 已注入）。LLM 输出的 page_index 字段保留是为了未来真给多页 PDF 时不改 contract，但 MVP 强制覆盖。
