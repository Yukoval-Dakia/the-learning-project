# Ingestion Pipeline Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current base64-in-D1 image attachment path with an R2-backed source asset layer, add the first ingestion data model, and keep the existing manual `/record -> /api/mistakes -> /mistakes` flow working.

**Architecture:** This is the Phase 1.5 foundation, not full OCR/cutting yet. The browser uploads image files to a new `/api/assets` endpoint, gets `source_asset.id` refs, and submits those refs with the mistake. The worker stores asset metadata in D1, object bytes in R2, and writes a minimal `ingestion_session` + `question_block` record so later Vision/OCR can replace the manual block without changing the rest of the pipeline.

**Tech Stack:** React 19, TanStack Query, Hono Worker, Cloudflare D1, Cloudflare R2, Drizzle schema, Vitest.

---

## Scope

This plan implements the smallest useful ingestion foundation:

- R2-backed image storage.
- `source_asset`, `source_document`, `ingestion_session`, `question_block` schema.
- Manual record flow uses asset IDs instead of base64 strings.
- `POST /api/mistakes` still creates `Question + Mistake` synchronously.
- A single manual `QuestionBlock` is created per manual submission when images are present.

This plan does not implement:

- OCR.
- automatic question cutting.
- PDF rendering.
- crop generation.
- Passage segmentation.
- Exa/Search grounding.

Those become later tasks once the storage/provenance path exists.

## Claude Code Handoff Notes

- Execute tasks in order. Each task should leave the repo compiling before moving on.
- Do not touch the existing untracked `.claude/` directory unless the user explicitly asks.
- Keep the current API field names `prompt_image_refs` and `wrong_answer_image_refs`; this plan changes their meaning from base64 data URLs to `source_asset.id`.
- Do not add OCR, cutting, PDF parsing, Exa, thumbnails, or a public asset download endpoint in this pass.
- Use `apply_patch` or normal editor edits; avoid broad rewrites of unrelated route files.
- If `pnpm db:generate` emits a migration name other than `0002_*`, keep the generated name and update the commit accordingly.
- After every task, run the task-specific test command before committing.

## File Structure

- `src/db/schema.ts` — add ingestion/source tables.
- `src/core/schema/business.ts` — add ingestion/source enums.
- `src/core/schema/index.ts` — export zod schemas for the new tables after drizzle-zod regeneration.
- `drizzle/0002_*.sql` + `drizzle/meta/*` — generated D1 migration for new tables.
- `workers/src/types.ts` — add `IMAGES: R2Bucket` binding.
- `workers/src/routes/assets.ts` — new upload endpoint and asset metadata helpers.
- `workers/src/routes/assets.test.ts` — tests for upload validation and D1/R2 writes.
- `workers/src/routes/mistakes.ts` — accept asset refs, validate they exist, write question/mistake references, create manual ingestion rows.
- `workers/src/routes/mistakes.test.ts` — update image tests from base64 limits to asset-ref validation.
- `workers/src/index.ts` — mount `/api/assets`.
- `src/routes/record.tsx` — upload selected images before submitting mistake, display upload state, send asset IDs.
- `src/routes/mistakes-list.tsx` — no required behavior change; optional future task can render thumbnails.

## Task 1: Add Source/Ingestion Schema

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/core/schema/business.ts`
- Modify after generation: `src/core/schema/index.ts`
- Create by generator: `drizzle/0002_*.sql`
- Test: `src/core/schema/schema.test.ts`

- [ ] **Step 1: Add business enums**

In `src/core/schema/business.ts`, add these exports after `ArtifactType`:

```ts
export const SourceAssetKind = z.enum(['image', 'pdf', 'text', 'web']);

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
  'imported',
  'ignored',
]);
```

- [ ] **Step 2: Add D1 tables to Drizzle schema**

In `src/db/schema.ts`, add these tables after `knowledge` and before `question`:

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

export const source_document = sqliteTable('source_document', {
  id: text('id').primaryKey(),
  title: text('title'),
  source_asset_ids: text('source_asset_ids', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  body_md: text('body_md'),
  provenance: text('provenance', { mode: 'json' }).notNull().default({}),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});

export const ingestion_session = sqliteTable('ingestion_session', {
  id: text('id').primaryKey(),
  source_document_id: text('source_document_id'),
  source_asset_ids: text('source_asset_ids', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
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
  source_asset_ids: text('source_asset_ids', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  page_index: integer('page_index'),
  bbox: text('bbox', { mode: 'json' }),
  extracted_prompt_md: text('extracted_prompt_md').notNull(),
  image_refs: text('image_refs', { mode: 'json' }).$type<string[]>().notNull().default([]),
  crop_refs: text('crop_refs', { mode: 'json' }).$type<string[]>().notNull().default([]),
  reference_md: text('reference_md'),
  visual_complexity: text('visual_complexity').notNull().default('low'),
  extraction_confidence: real('extraction_confidence').notNull().default(1),
  status: text('status').notNull().default('draft'),
  imported_question_id: text('imported_question_id'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  version: integer('version').notNull().default(0),
});
```

- [ ] **Step 3: Generate migration SQL**

Run:

```bash
pnpm db:generate
```

Expected:

- a new `drizzle/0002_*.sql` file is created;
- `drizzle/meta/_journal.json` is updated;
- a new `drizzle/meta/0002_snapshot.json` is created.

Open the generated SQL and verify it contains these four `CREATE TABLE` statements:

```text
CREATE TABLE `source_asset`
CREATE TABLE `source_document`
CREATE TABLE `ingestion_session`
CREATE TABLE `question_block`
```

If a migration file was already generated from a failed attempt, delete only that uncommitted generated `drizzle/0002_*.sql` and its matching `drizzle/meta/0002_snapshot.json`, then rerun `pnpm db:generate`. Do not edit committed migrations.

- [ ] **Step 4: Add generated zod schema exports**

`src/core/schema/generated.ts` is a small checked-in bridge that imports `src/db/schema.ts` and calls `createInsertSchema` / `createSelectSchema`. It is not produced by `pnpm db:generate`, so update it manually.

Add after `KnowledgeSelectGenerated`:

```ts
export const SourceAssetInsertGenerated = createInsertSchema(t.source_asset);
export const SourceAssetSelectGenerated = createSelectSchema(t.source_asset);

export const SourceDocumentInsertGenerated = createInsertSchema(t.source_document);
export const SourceDocumentSelectGenerated = createSelectSchema(t.source_document);

export const IngestionSessionInsertGenerated = createInsertSchema(t.ingestion_session);
export const IngestionSessionSelectGenerated = createSelectSchema(t.ingestion_session);

export const QuestionBlockInsertGenerated = createInsertSchema(t.question_block);
export const QuestionBlockSelectGenerated = createSelectSchema(t.question_block);
```

- [ ] **Step 5: Export typed public zod schemas**

Add to `src/core/schema/index.ts` after the Knowledge section:

```ts
// ---------- Source / Ingestion ----------
export const SourceAssetInsert = g.SourceAssetInsertGenerated.extend({
  kind: b.SourceAssetKind,
});
export const SourceAsset = g.SourceAssetSelectGenerated.extend({
  kind: b.SourceAssetKind,
});
export type SourceAssetInsert = z.infer<typeof SourceAssetInsert>;
export type SourceAsset = z.infer<typeof SourceAsset>;

export const SourceDocumentInsert = g.SourceDocumentInsertGenerated;
export const SourceDocument = g.SourceDocumentSelectGenerated;
export type SourceDocumentInsert = z.infer<typeof SourceDocumentInsert>;
export type SourceDocument = z.infer<typeof SourceDocument>;

export const IngestionSessionInsert = g.IngestionSessionInsertGenerated.extend({
  status: b.IngestionSessionStatus.nullish(),
});
export const IngestionSession = g.IngestionSessionSelectGenerated.extend({
  status: b.IngestionSessionStatus,
});
export type IngestionSessionInsert = z.infer<typeof IngestionSessionInsert>;
export type IngestionSession = z.infer<typeof IngestionSession>;

export const QuestionBlockInsert = g.QuestionBlockInsertGenerated.extend({
  status: b.QuestionBlockStatus.nullish(),
  visual_complexity: z.enum(['low', 'medium', 'high']).nullish(),
});
export const QuestionBlock = g.QuestionBlockSelectGenerated.extend({
  status: b.QuestionBlockStatus,
  visual_complexity: z.enum(['low', 'medium', 'high']),
});
export type QuestionBlockInsert = z.infer<typeof QuestionBlockInsert>;
export type QuestionBlock = z.infer<typeof QuestionBlock>;
```

- [ ] **Step 6: Add schema tests**

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

it('QuestionBlock accepts a manual imported block', () => {
  const result = QuestionBlock.safeParse({
    id: 'qb_1',
    ingestion_session_id: 'ing_1',
    source_document_id: null,
    source_asset_ids: ['asset_1'],
    page_index: null,
    bbox: null,
    extracted_prompt_md: '题面',
    image_refs: ['asset_1'],
    crop_refs: [],
    reference_md: null,
    visual_complexity: 'low',
    extraction_confidence: 1,
    status: 'imported',
    imported_question_id: 'q_1',
    created_at: new Date(1700000000 * 1000),
    updated_at: new Date(1700000000 * 1000),
    version: 0,
  });
  expect(result.success).toBe(true);
});
```

If imports are missing, extend the existing import list with `SourceAsset` and `QuestionBlock`.

- [ ] **Step 7: Run schema tests**

Run:

```bash
pnpm test src/core/schema/schema.test.ts
```

Expected: all schema tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/core/schema/business.ts src/core/schema/index.ts src/core/schema/generated.ts src/core/schema/schema.test.ts drizzle
git commit -m "feat(ingestion): add source asset schema"
```

## Task 2: Add R2 Asset Upload Endpoint

**Files:**
- Modify: `workers/src/types.ts`
- Create: `workers/src/routes/assets.ts`
- Create: `workers/src/routes/assets.test.ts`
- Modify: `workers/src/index.ts`
- Modify: `workers/src/routes/knowledge.test.ts`
- Modify: `workers/src/routes/mistakes.test.ts`

- [ ] **Step 1: Add R2 binding type**

In `workers/src/types.ts`, change `Bindings` to:

```ts
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export type Bindings = {
  ANTHROPIC_API_KEY: string;
  INTERNAL_TOKEN: string;
  DB: D1Database;
  IMAGES: R2Bucket;
};
```

- [ ] **Step 2: Create upload route**

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
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const storageKey = `images/${id}.${ext}`;
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
      kind: 'image',
      storage_key: storageKey,
      mime_type: file.type,
      byte_size: file.size,
      sha256,
    },
  });
});
```

- [ ] **Step 3: Mount route**

In `workers/src/index.ts`, import and mount:

```ts
import { assets } from './routes/assets';
```

Add after the logs route:

```ts
app.route('/api/assets', assets);
```

- [ ] **Step 4: Update existing worker test mocks for the new binding**

Any test env typed as `AppEnv['Bindings']` now needs an `IMAGES` stub. Add `R2Bucket` to type imports where needed:

```ts
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
```

In `workers/src/routes/knowledge.test.ts`, add this inside `mockEnv` after `db` is created:

```ts
const images = { put: vi.fn(async () => null) } as unknown as R2Bucket;
```

Then change the returned bindings to:

```ts
Bindings: { DB: db, IMAGES: images, INTERNAL_TOKEN: 'test', ANTHROPIC_API_KEY: 'test' },
```

In `workers/src/routes/mistakes.test.ts`, update both `mockEnv` and `mockEnvWithList` in the same way:

```ts
const images = { put: vi.fn(async () => null) } as unknown as R2Bucket;
```

and include `IMAGES: images` in each returned `Bindings` object.

- [ ] **Step 5: Add route tests**

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
  it('uploads image to R2 and writes source_asset metadata', async () => {
    const { Bindings, executionCtx, calls, put } = mockEnv();
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'q.png', { type: 'image/png' }));

    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { asset: { id: string; storage_key: string; mime_type: string } };
    expect(body.asset.id).toBeTruthy();
    expect(body.asset.storage_key).toMatch(/^images\/.+\.png$/);
    expect(body.asset.mime_type).toBe('image/png');
    expect(put).toHaveBeenCalledOnce();
    expect(calls.some((c) => /insert into source_asset/i.test(c.sql))).toBe(true);
  });

  it('rejects missing file', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const res = await assets.request('/', { method: 'POST', body: new FormData() }, Bindings, executionCtx);
    expect(res.status).toBe(400);
  });

  it('rejects unsupported mime type', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const form = new FormData();
    form.set('file', new File(['x'], 'note.txt', { type: 'text/plain' }));
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/unsupported mime_type/);
  });
});
```

- [ ] **Step 6: Run asset and smoke route tests**

Run:

```bash
pnpm test workers/src/routes/assets.test.ts workers/src/routes/knowledge.test.ts
```

Expected: tests pass.

- [ ] **Step 7: Commit**

```bash
git add workers/src/types.ts workers/src/routes/assets.ts workers/src/routes/assets.test.ts workers/src/index.ts workers/src/routes/knowledge.test.ts workers/src/routes/mistakes.test.ts
git commit -m "feat(worker): add source asset uploads"
```

## Task 3: Update Mistake Creation to Use Asset Refs

**Files:**
- Modify: `workers/src/routes/mistakes.ts`
- Modify: `workers/src/routes/mistakes.test.ts`

- [ ] **Step 1: Replace image byte validation with source_asset validation**

In `workers/src/routes/mistakes.ts`, remove `TOTAL_IMAGE_BYTES_LIMIT` and the two total byte checks.

Add helper near the body schema:

```ts
async function assertAssetsExist(db: D1Database, ids: string[], field: string): Promise<Response | null> {
  const missing: string[] = [];
  for (const id of ids) {
    const row = await db.prepare(`select id from source_asset where id = ?`).bind(id).first();
    if (!row) missing.push(id);
  }
  if (missing.length > 0) {
    return new Response(
      JSON.stringify({
        error: 'validation_error',
        message: `unknown ${field}: ${missing.join(', ')}`,
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }
  return null;
}
```

Add import:

```ts
import type { D1Database } from '@cloudflare/workers-types';
```

After knowledge validation, add:

```ts
const badPromptAssets = await assertAssetsExist(c.env.DB, body.prompt_image_refs, 'prompt_image_refs');
if (badPromptAssets) return badPromptAssets;
const badWrongAssets = await assertAssetsExist(c.env.DB, body.wrong_answer_image_refs, 'wrong_answer_image_refs');
if (badWrongAssets) return badWrongAssets;
```

- [ ] **Step 2: Store asset refs in question metadata**

Keep the existing metadata key for compatibility, but it now contains asset IDs:

```ts
const questionMetadata =
  body.prompt_image_refs.length > 0
    ? JSON.stringify({ prompt_image_refs: body.prompt_image_refs, prompt_image_ref_kind: 'source_asset_id' })
    : null;
```

- [ ] **Step 3: Create manual ingestion rows in the same D1 batch**

Replace:

```ts
await c.env.DB.batch([insertQuestion, insertMistake]);
```

with:

```ts
const batchStatements = [insertQuestion, insertMistake];
const allAssetIds = [...body.prompt_image_refs, ...body.wrong_answer_image_refs];

if (allAssetIds.length > 0) {
  const ingestionId = createId();
  const blockId = createId();
  const sourceDocumentId = createId();
  const sourceAssetIdsJson = JSON.stringify(allAssetIds);
  const promptImageRefsJson = JSON.stringify(body.prompt_image_refs);

  batchStatements.push(
    c.env.DB.prepare(
      `insert into source_document (
        id, title, source_asset_ids, body_md, provenance, created_at, updated_at, version
      ) values (?, ?, ?, ?, ?, ?, ?, 0)`,
    ).bind(
      sourceDocumentId,
      body.prompt_md.slice(0, 80),
      sourceAssetIdsJson,
      body.prompt_md,
      JSON.stringify({ entrypoint: 'manual_record' }),
      now,
      now,
    ),
  );
  batchStatements.push(
    c.env.DB.prepare(
      `insert into ingestion_session (
        id, source_document_id, source_asset_ids, status, entrypoint, error_message,
        created_at, updated_at, version
      ) values (?, ?, ?, 'imported', 'manual_record', null, ?, ?, 0)`,
    ).bind(ingestionId, sourceDocumentId, sourceAssetIdsJson, now, now),
  );
  batchStatements.push(
    c.env.DB.prepare(
      `insert into question_block (
        id, ingestion_session_id, source_document_id, source_asset_ids, page_index, bbox,
        extracted_prompt_md, image_refs, crop_refs, reference_md, visual_complexity,
        extraction_confidence, status, imported_question_id, created_at, updated_at, version
      ) values (?, ?, ?, ?, null, null, ?, ?, '[]', ?, 'low', 1, 'imported', ?, ?, ?, 0)`,
    ).bind(
      blockId,
      ingestionId,
      sourceDocumentId,
      sourceAssetIdsJson,
      body.prompt_md,
      promptImageRefsJson,
      body.reference_md,
      questionId,
      now,
      now,
    ),
  );
}

await c.env.DB.batch(batchStatements);
```

- [ ] **Step 4: Update route tests**

In `workers/src/routes/mistakes.test.ts`, update `mockEnv` so source assets can be looked up:

```ts
function mockEnv(opts: {
  knowledgeRows?: Array<{ id: string; name: string; domain: string | null; parent_id: string | null; archived_at: number | null }>;
  sourceAssetIds?: string[];
  treeAllThrows?: boolean;
} = {}) {
  const sourceAssetIds = new Set(opts.sourceAssetIds ?? []);
```

In `first`, add:

```ts
if (/select id from source_asset where id = \?/i.test(sql)) {
  const id = binds[0] as string;
  return sourceAssetIds.has(id) ? { id } : null;
}
```

Delete the two byte-limit tests because `/api/mistakes` no longer receives raw image bytes. Also replace the old `persists prompt_image_refs in question.metadata and wrong_answer_image_refs` test with the second test below because the refs are now `source_asset.id` values, not data URLs.

Add these tests:

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

it('persists source asset refs and creates manual ingestion rows', async () => {
  const { Bindings, executionCtx, calls } = mockEnv({
    knowledgeRows: [{ id: 'k1', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
    sourceAssetIds: ['asset_prompt', 'asset_wrong'],
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
        prompt_image_refs: ['asset_prompt'],
        wrong_answer_image_refs: ['asset_wrong'],
      }),
      headers: { 'content-type': 'application/json' },
    },
    Bindings,
    executionCtx,
  );
  expect(res.status).toBe(200);
  expect(calls.some((c) => /insert into source_document/i.test(c.sql))).toBe(true);
  expect(calls.some((c) => /insert into ingestion_session/i.test(c.sql))).toBe(true);
  expect(calls.some((c) => /insert into question_block/i.test(c.sql))).toBe(true);
});
```

- [ ] **Step 5: Run mistake route tests**

Run:

```bash
pnpm test workers/src/routes/mistakes.test.ts
```

Expected: route tests pass.

- [ ] **Step 6: Commit**

```bash
git add workers/src/routes/mistakes.ts workers/src/routes/mistakes.test.ts
git commit -m "feat(ingestion): attach source assets to mistakes"
```

## Task 4: Update `/record` to Upload Images Before Submit

**Files:**
- Modify: `src/routes/record.tsx`

- [ ] **Step 1: Replace base64 image state with upload state**

In `src/routes/record.tsx`, add:

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
    throw new Error(`POST /api/assets failed: ${res.status} ${text}`);
  }
  const body = (await res.json()) as {
    asset: { id: string; mime_type: string; byte_size: number };
  };
  return {
    id: body.asset.id,
    name: file.name,
    mime_type: body.asset.mime_type,
    byte_size: body.asset.byte_size,
  };
}
```

Remove `MAX_IMAGE_BYTES` and `readFileAsDataUrl`.

Change state:

```ts
const [promptImages, setPromptImages] = useState<UploadedAsset[]>([]);
const [wrongAnswerImages, setWrongAnswerImages] = useState<UploadedAsset[]>([]);
const [uploading, setUploading] = useState(false);
```

- [ ] **Step 2: Send asset IDs to Worker**

In `handleSubmit`, change:

```ts
prompt_image_refs: promptImages.map((x) => x.id),
wrong_answer_image_refs: wrongAnswerImages.map((x) => x.id),
```

Disable submit while uploading:

```tsx
<button
  type="submit"
  disabled={submitMutation.isPending || uploading}
  className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-50"
>
  {submitMutation.isPending ? '提交中...' : uploading ? '图片上传中...' : '提交'}
</button>
```

- [ ] **Step 3: Replace appendImages**

Replace `appendImages` with:

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

- [ ] **Step 4: Update ImagePicker props**

Change `ImagePicker` props from `images: string[]` to:

```ts
function ImagePicker({
  label,
  images,
  onAdd,
  onRemove,
}: {
  label: string;
  images: UploadedAsset[];
  onAdd: (files: FileList | null) => void;
  onRemove: (index: number) => void;
}) {
```

Render filenames instead of base64 thumbnails:

```tsx
{images.length > 0 && (
  <ul className="mt-2 space-y-1">
    {images.map((img, i) => (
      <li key={img.id} className="flex items-center justify-between text-xs border rounded px-2 py-1">
        <span>
          {img.name} · {(img.byte_size / 1024).toFixed(0)}KB
        </span>
        <button type="button" className="underline" onClick={() => onRemove(i)}>
          移除
        </button>
      </li>
    ))}
  </ul>
)}
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: TypeScript passes.

- [ ] **Step 6: Commit**

```bash
git add src/routes/record.tsx
git commit -m "feat(record): upload images as source assets"
```

## Task 5: Full Verification

**Files:**
- No source changes unless a verification failure exposes a bug.

- [ ] **Step 1: Run worker and schema tests**

Run:

```bash
pnpm test workers/src/routes/assets.test.ts workers/src/routes/mistakes.test.ts src/core/schema/schema.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run full tests**

Run:

```bash
pnpm test
```

Expected: full Vitest suite passes.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: client and worker typecheck pass.

- [ ] **Step 4: Run lint**

Run:

```bash
pnpm lint
```

Expected: Biome reports no errors.

- [ ] **Step 5: Manual dev smoke**

Run:

```bash
pnpm workers:dev
```

In another terminal:

```bash
pnpm dev
```

Open `/record`, upload one small PNG as a题面图, submit a manual mistake, then open `/mistakes`.

Expected:

- `/record` shows uploaded filename before submit.
- submit succeeds.
- `/mistakes` shows the new mistake.
- cause starts as `归因中...` if not manually provided.
- no large base64 string is posted to `/api/mistakes`.

- [ ] **Step 6: Final commit if any verification fixes were needed**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "fix(ingestion): pass verification"
```

If no fixes were needed, do not create an empty commit.

## Self-Review

Spec coverage:

- R2-backed source assets are covered in Task 2.
- Existing manual mistake flow remains covered in Tasks 3 and 4.
- Source/Ingestion/QuestionBlock data model is covered in Task 1.
- `crop_refs[]` exists in schema, but actual crop generation is intentionally not implemented in this foundation.
- OCR/cutting/PDF/passage/search are intentionally out of scope and remain future work.

Unresolved-marker scan:

- The plan contains no unresolved markers or intentionally vague implementation step.

Type consistency:

- Frontend sends `prompt_image_refs` and `wrong_answer_image_refs` as string arrays, preserving the existing API shape.
- The semantics of those strings change from base64 data URLs to `source_asset.id`.
- `question.metadata.prompt_image_ref_kind = 'source_asset_id'` records the new interpretation.
