# Sub 0b1: API Route Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every Cloudflare Workers Hono route (`workers/src/routes/*`) and business module (`workers/src/{ai,ingestion,knowledge,review,export}/*`) to Next.js Route Handlers (`app/api/`) and runtime-agnostic `src/server/*`, then delete `workers/` entirely.

**Architecture:** Direct port. Business logic moves into `src/server/` with `db: Db` and `r2: R2Client` injected as function parameters (no module singletons). Route handlers under `app/api/.../route.ts` are thin: parse request → call business function → return `Response.json`. A single `middleware.ts` gates `/api/*` on `x-internal-token`. R2 goes through `@aws-sdk/client-s3` via a small wrapper. PostgreSQL queries are rewritten to Drizzle query builder. Workers tests port 1:1 to the new locations and run against a `testcontainers` Postgres.

**Tech Stack:** Next.js 15 App Router · Drizzle ORM (postgres-js) · Neon Postgres · `@aws-sdk/client-s3` · `@testcontainers/postgresql` · vitest · zod / drizzle-zod · `@paralleldrive/cuid2` · Vercel AI SDK · ts-fsrs.

**Spec:** `docs/superpowers/specs/2026-05-11-sub0b1-api-route-migration-design.md`

---

## File Structure (target end state)

```
src/server/
  http/
    errors.ts                # ApiError + errorResponse helper
    errors.test.ts
  r2.ts                      # @aws-sdk/client-s3 wrapper + R2Client interface
  r2.test.ts
  ai/
    runner.ts
    runner.test.ts
    log.ts
    log.test.ts
    judges/
      index.ts
      exact.ts / keyword.ts / ...
      *.test.ts
  ingestion/
    cascade.ts / vision.ts / ocr_tencent.ts / ocr_tencent_sign.ts
    *.test.ts
  knowledge/
    seed.ts / domain.ts / propose.ts / proposals.ts / attribute.ts / review.ts / tree.ts
    *.test.ts
  review/
    fsrs.ts
    fsrs.test.ts
  export/
    constants.ts / csv.ts / readme.ts
    *.test.ts

app/api/
  health/route.ts                  # already exists (Sub 0a)
  _/seed/route.ts
  _/export/route.ts
  _/import/route.ts
  _/logs/tool_calls/route.ts
  _/logs/cost/route.ts
  assets/route.ts
  assets/[id]/route.ts
  knowledge/route.ts
  knowledge/proposals/route.ts
  knowledge/proposals/[id]/route.ts
  knowledge/review/route.ts
  mistakes/recent/route.ts
  mistakes/route.ts
  ingestion/route.ts
  ingestion/[id]/route.ts
  ingestion/[id]/extract/route.ts
  learning-items/route.ts
  learning-items/[id]/route.ts
  review/due/route.ts
  review/submit/route.ts
  ai/[task]/route.ts
  + route.test.ts beside each

middleware.ts                       # x-internal-token gate
tests/
  global-setup.ts                   # testcontainers Postgres
  helpers/
    db.ts                           # testDb / resetDb
    request.ts                      # buildAuthedRequest
vitest.config.ts                    # globalSetup wired
```

`workers/` is deleted in the final task.

---

## Task 0: Branch + dependencies + env

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Create: `.env.local` additions (developer-managed, not committed)

- [ ] **Step 0.1: Verify on the right branch**

```bash
git status
```
Expected: `On branch sub-0b1-api-route-migration`, working tree clean (spec was already committed).

- [ ] **Step 0.2: Add runtime + dev dependencies**

```bash
pnpm add @aws-sdk/client-s3@^3.700.0
pnpm add -D @testcontainers/postgresql@^10.13.0 testcontainers@^10.13.0
```

Expected output ends with `Done`. Check `package.json` shows the new entries.

- [ ] **Step 0.3: Update `.env.example`**

Append to `.env.example`:

```
# R2 (S3-compatible) — Sub 0b1
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=

# Auth — Sub 0b1
INTERNAL_TOKEN=
```

- [ ] **Step 0.4: Commit**

```bash
git add package.json pnpm-lock.yaml .env.example
git commit -m "chore(sub-0b1): add @aws-sdk/client-s3 + testcontainers; env example for R2 + INTERNAL_TOKEN"
```

---

## Task 1: `src/server/http/errors.ts` — ApiError + errorResponse

**Files:**
- Create: `src/server/http/errors.ts`
- Create: `src/server/http/errors.test.ts`

- [ ] **Step 1.1: Write the failing test**

`src/server/http/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, errorResponse } from './errors';

describe('ApiError + errorResponse', () => {
  it('returns the configured status + code + message for ApiError', async () => {
    const res = errorResponse(new ApiError('validation_error', 'bad input', 400));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'validation_error', message: 'bad input' });
  });

  it('returns 500 internal_error for an unknown error instance', async () => {
    const res = errorResponse(new Error('kaboom'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.message).toBe('kaboom');
  });

  it('returns 500 internal_error for a non-Error throw', async () => {
    const res = errorResponse('weird string throw');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
  });

  it('defaults ApiError status to 400 when not provided', () => {
    expect(new ApiError('x', 'y').status).toBe(400);
  });
});
```

- [ ] **Step 1.2: Run test, verify it fails**

```bash
pnpm vitest run src/server/http/errors.test.ts
```
Expected: `FAIL` — module `./errors` not found.

- [ ] **Step 1.3: Implement**

`src/server/http/errors.ts`:

```ts
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(
      { error: err.code, message: err.message },
      { status: err.status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error('unhandled error', { message, stack, timestamp: new Date().toISOString() });
  return Response.json({ error: 'internal_error', message }, { status: 500 });
}
```

- [ ] **Step 1.4: Run test, verify it passes**

```bash
pnpm vitest run src/server/http/errors.test.ts
```
Expected: `PASS` with 4 passing tests.

- [ ] **Step 1.5: Commit**

```bash
git add src/server/http/errors.ts src/server/http/errors.test.ts
git commit -m "feat(sub-0b1): src/server/http/errors — ApiError + errorResponse"
```

---

## Task 2: `src/server/r2.ts` — `@aws-sdk/client-s3` wrapper

**Files:**
- Create: `src/server/r2.ts`
- Create: `src/server/r2.test.ts`

- [ ] **Step 2.1: Write the failing test**

`src/server/r2.test.ts`:

```ts
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createR2Client } from './r2';

describe('createR2Client', () => {
  let s3: { send: ReturnType<typeof vi.fn> };
  let r2: ReturnType<typeof createR2Client>;

  beforeEach(() => {
    s3 = { send: vi.fn() };
    r2 = createR2Client(s3 as unknown as S3Client, 'test-bucket');
  });

  afterEach(() => vi.clearAllMocks());

  it('put sends PutObjectCommand with bucket, key, body, contentType', async () => {
    s3.send.mockResolvedValueOnce({});
    await r2.put('k1', new Uint8Array([1, 2, 3]), 'image/png');
    expect(s3.send).toHaveBeenCalledTimes(1);
    const cmd = s3.send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('k1');
    expect(cmd.input.ContentType).toBe('image/png');
  });

  it('get returns Uint8Array when object exists', async () => {
    const bodyStream = Readable.from([new Uint8Array([7, 8, 9])]);
    s3.send.mockResolvedValueOnce({ Body: bodyStream });
    const out = await r2.get('k1');
    expect(out).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('get returns null when NoSuchKey thrown', async () => {
    const err = new NoSuchKey({ message: 'gone', $metadata: {} });
    s3.send.mockRejectedValueOnce(err);
    const out = await r2.get('missing');
    expect(out).toBeNull();
  });

  it('get rethrows other errors', async () => {
    s3.send.mockRejectedValueOnce(new Error('network'));
    await expect(r2.get('x')).rejects.toThrow('network');
  });

  it('delete sends DeleteObjectCommand', async () => {
    s3.send.mockResolvedValueOnce({});
    await r2.delete('k1');
    const cmd = s3.send.mock.calls[0][0];
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('k1');
  });
});
```

- [ ] **Step 2.2: Run test, verify it fails**

```bash
pnpm vitest run src/server/r2.test.ts
```
Expected: `FAIL` — module not found.

- [ ] **Step 2.3: Implement**

`src/server/r2.ts`:

```ts
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface R2Client {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export function createR2Client(client: S3Client, bucket: string): R2Client {
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!res.Body) return null;
        const chunks: Uint8Array[] = [];
        // S3 GetObject body is an AsyncIterable<Uint8Array> in Node.
        for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        return out;
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

// Singleton helper for production use. Reads env at first call.
let _r2: R2Client | undefined;
export function getR2(): R2Client {
  if (_r2) return _r2;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      'R2 env not configured: need R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.',
    );
  }
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  _r2 = createR2Client(client, bucket);
  return _r2;
}
```

- [ ] **Step 2.4: Run test, verify it passes**

```bash
pnpm vitest run src/server/r2.test.ts
```
Expected: `PASS` with 5 passing tests.

- [ ] **Step 2.5: Commit**

```bash
git add src/server/r2.ts src/server/r2.test.ts
git commit -m "feat(sub-0b1): src/server/r2 — @aws-sdk/client-s3 wrapper + R2Client interface"
```

---

## Task 3: `middleware.ts` — `x-internal-token` gate

**Files:**
- Create: `middleware.ts` (repo root)
- Create: `middleware.test.ts` (repo root)

- [ ] **Step 3.1: Write the failing test**

`middleware.test.ts`:

```ts
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { middleware } from './middleware';

function reqOf(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(`http://localhost${path}`), { headers });
}

describe('middleware', () => {
  beforeEach(() => {
    vi.stubEnv('INTERNAL_TOKEN', 'secret-token');
  });

  it('passes through /api/health without token', () => {
    const res = middleware(reqOf('/api/health'));
    expect(res).toBeUndefined();
  });

  it('returns 401 when x-internal-token is missing on /api/anything', async () => {
    const res = middleware(reqOf('/api/learning-items'));
    expect(res?.status).toBe(401);
    const body = await res?.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when x-internal-token does not match', async () => {
    const res = middleware(reqOf('/api/learning-items', { 'x-internal-token': 'wrong' }));
    expect(res?.status).toBe(401);
  });

  it('passes through with matching x-internal-token', () => {
    const res = middleware(reqOf('/api/learning-items', { 'x-internal-token': 'secret-token' }));
    expect(res).toBeUndefined();
  });
});
```

- [ ] **Step 3.2: Run test, verify it fails**

```bash
pnpm vitest run middleware.test.ts
```
Expected: `FAIL` — `./middleware` not found.

- [ ] **Step 3.3: Implement**

`middleware.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest): NextResponse | undefined {
  const path = req.nextUrl.pathname;
  // Uptime monitors hit /api/health without credentials; explicitly exempt.
  if (path === '/api/health') return;
  const token = req.headers.get('x-internal-token');
  if (!token || token !== process.env.INTERNAL_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
}

export const config = { matcher: '/api/:path*' };
```

- [ ] **Step 3.4: Run test, verify it passes**

```bash
pnpm vitest run middleware.test.ts
```
Expected: `PASS` with 4 passing tests.

- [ ] **Step 3.5: Commit**

```bash
git add middleware.ts middleware.test.ts
git commit -m "feat(sub-0b1): middleware — x-internal-token gate for /api/* (health exempt)"
```

---

## Task 4: testcontainers Postgres + vitest globalSetup

**Files:**
- Create: `tests/global-setup.ts`
- Create: `tests/helpers/db.ts`
- Create: `tests/helpers/request.ts`
- Modify: `vitest.config.ts` (create if absent)
- Modify: `package.json` test script (no change expected; document)

- [ ] **Step 4.1: Look at existing vitest config**

```bash
ls vitest.config.* 2>/dev/null; cat vitest.config.ts 2>/dev/null
```
If file does not exist (Sub 0a did not add one), create it in step 4.4.

- [ ] **Step 4.2: Write `tests/global-setup.ts`**

```ts
import { spawnSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  container = await new PostgreSqlContainer('postgres:16').start();
  const uri = container.getConnectionUri();
  process.env.TEST_DATABASE_URL = uri;
  // Drizzle pushes schema into the fresh container. We point drizzle-kit at
  // TEST_DATABASE_URL via env so it does not touch the dev Neon DB.
  const result = spawnSync(
    'pnpm',
    ['db:push', '--force'],
    {
      env: { ...process.env, DATABASE_URL: uri },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    throw new Error(`drizzle-kit push failed (exit ${result.status}) against test container`);
  }
}

export async function teardown() {
  await container?.stop();
}
```

- [ ] **Step 4.3: Write `tests/helpers/db.ts`**

```ts
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';

let _client: ReturnType<typeof postgres> | undefined;
let _db: ReturnType<typeof drizzle> | undefined;

export function testDb() {
  if (_db) return _db;
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set — globalSetup did not run');
  _client = postgres(url, { max: 4 });
  _db = drizzle(_client, { schema });
  return _db;
}

// Truncate all known tables, used in beforeEach for hermetic tests.
// CASCADE handles FK dependencies; whitelist of identifiers (not user input).
const ALL_TABLES = [
  'user_appeal',
  'judgment',
  'answer',
  'completion_evidence',
  'review_event',
  'mistake',
  'study_log',
  'artifact',
  'learning_item',
  'question_block',
  'question',
  'ingestion_session',
  'source_document',
  'source_asset',
  'knowledge',
  'dreaming_proposal',
  'tool_call_log',
  'cost_ledger',
] as const;

export async function resetDb() {
  const db = testDb();
  for (const t of ALL_TABLES) {
    await db.execute(sql.raw(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`));
  }
}
```

- [ ] **Step 4.4: Write `tests/helpers/request.ts`**

```ts
export function buildAuthedRequest(
  url: string,
  init: RequestInit = {},
  token = 'test-token',
): Request {
  const headers = new Headers(init.headers);
  headers.set('x-internal-token', token);
  return new Request(url, { ...init, headers });
}
```

- [ ] **Step 4.5: Create / update `vitest.config.ts`**

```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000, // container startup
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // share container across files
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
```

- [ ] **Step 4.6: Smoke-test the harness**

Write `tests/smoke.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testDb } from './helpers/db';

describe('testcontainers PG harness', () => {
  it('can SELECT 1', async () => {
    const db = testDb();
    const rows = await db.execute(sql`select 1 as ok`);
    expect((rows as unknown as Array<{ ok: number }>)[0]?.ok).toBe(1);
  });
});
```

Run:
```bash
pnpm vitest run tests/smoke.test.ts
```
Expected: container boots (may take ~30s on first pull), `db:push` runs, smoke test passes. Then delete the smoke file.

- [ ] **Step 4.7: Delete smoke file + commit**

```bash
rm tests/smoke.test.ts
git add tests/global-setup.ts tests/helpers/db.ts tests/helpers/request.ts vitest.config.ts
git commit -m "test(sub-0b1): testcontainers PG harness + helpers (testDb, resetDb, buildAuthedRequest)"
```

---

## Task 5: Port `src/server/review/fsrs.ts`

**Files:**
- Move: `workers/src/review/fsrs.ts` → `src/server/review/fsrs.ts`
- Move: `workers/src/review/fsrs.test.ts` → `src/server/review/fsrs.test.ts`

This module is pure logic — no DB or R2. Only path + import changes.

- [ ] **Step 5.1: Copy file with adjusted imports**

Original `workers/src/review/fsrs.ts` imports `'../../../src/core/schema/business'`. The new location `src/server/review/fsrs.ts` should import `'../../core/schema/business'`. Apply that one-line change in the new copy.

```bash
mkdir -p src/server/review
cp workers/src/review/fsrs.ts src/server/review/fsrs.ts
cp workers/src/review/fsrs.test.ts src/server/review/fsrs.test.ts
```

Then edit `src/server/review/fsrs.ts` line 3 from `'../../../src/core/schema/business'` to `'../../core/schema/business'`.
Edit `src/server/review/fsrs.test.ts` similarly — change any `'../../../src/'` to `'../../'`.

- [ ] **Step 5.2: Run the ported test**

```bash
pnpm vitest run src/server/review/fsrs.test.ts
```
Expected: `PASS` — same assertions as workers, no DB needed.

- [ ] **Step 5.3: Delete the workers copies**

```bash
git rm workers/src/review/fsrs.ts workers/src/review/fsrs.test.ts
```

- [ ] **Step 5.4: Commit**

```bash
git add src/server/review/
git commit -m "feat(sub-0b1): port src/server/review/fsrs (pure logic, no DB/R2)"
```

---

## Task 6: Port `src/server/knowledge/*`

The seven files (`seed`, `domain`, `propose`, `proposals`, `attribute`, `review`, `tree`) all live under `workers/src/knowledge/`. Each takes a `D1Database` (or doesn't touch DB at all). Convert `D1Database` parameter type to our `Db` type from `@/db/client`, and rewrite SQL bodies from D1's `db.prepare('...').bind(...).first()` style to Drizzle query builder.

**Files:**
- Move each `workers/src/knowledge/<name>.ts` → `src/server/knowledge/<name>.ts` (+ test)

- [ ] **Step 6.1: Inspect each file**

```bash
ls workers/src/knowledge/
```
Confirm 7 source files + 7 test files (14 total).

- [ ] **Step 6.2: Port `seed.ts` (representative; apply same pattern to the rest)**

Original signature: `export async function seedKnowledge(db: D1Database)`.

Read full file:
```bash
cat workers/src/knowledge/seed.ts
```

New version `src/server/knowledge/seed.ts`:

```ts
import { eq } from 'drizzle-orm';
import { getCurriculum } from '../../subjects/wenyan/seed';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';

export interface SeedResult {
  inserted: number;
  skipped: number;
}

export async function seedKnowledge(db: Db): Promise<SeedResult> {
  const curriculum = getCurriculum();
  let inserted = 0;
  let skipped = 0;

  for (const seed of curriculum.knowledge_seeds) {
    const id = `seed:${curriculum.domain}:${seed.slug}`;
    const [existing] = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(eq(knowledge.id, id))
      .limit(1);
    if (existing) {
      skipped += 1;
      continue;
    }
    const now = new Date();
    await db.insert(knowledge).values({
      id,
      name: seed.name,
      domain: curriculum.domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
    });
    inserted += 1;
  }

  return { inserted, skipped };
}
```

Port `src/server/knowledge/seed.test.ts` from `workers/src/knowledge/seed.test.ts`: replace any D1 mocking with the real `testDb()` from `tests/helpers/db.ts` + `resetDb()` in `beforeEach`. Assertions stay the same.

Sketch of the ported test:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { seedKnowledge } from './seed';

describe('seedKnowledge', () => {
  beforeEach(async () => { await resetDb(); });

  it('inserts curriculum nodes when DB is empty', async () => {
    const db = testDb();
    const result = await seedKnowledge(db);
    expect(result.inserted).toBeGreaterThan(0);
    expect(result.skipped).toBe(0);
  });

  it('is idempotent on second run', async () => {
    const db = testDb();
    await seedKnowledge(db);
    const second = await seedKnowledge(db);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6.3: Port the remaining 6 source files + 6 test files**

For each of: `domain`, `propose`, `proposals`, `attribute`, `review`, `tree`:

1. Read `workers/src/knowledge/<name>.ts`
2. Create `src/server/knowledge/<name>.ts` with:
   - Replace `import type { D1Database } from '@cloudflare/workers-types'` → `import type { Db } from '@/db/client'`
   - Replace function parameter type `db: D1Database` → `db: Db`
   - Replace D1 `db.prepare('SELECT ... WHERE x = ?').bind(val).first<T>()` → Drizzle query builder (`db.select().from(table).where(eq(table.col, val)).limit(1)`)
   - Replace D1 `db.prepare('INSERT INTO ...').bind(...).run()` → `db.insert(table).values({...})`
   - Replace D1 `db.prepare('UPDATE ...').bind(...).run()` → `db.update(table).set({...}).where(eq(...))`
   - Adjust relative imports (drop one `..`)
3. Read `workers/src/knowledge/<name>.test.ts`
4. Create `src/server/knowledge/<name>.test.ts` with:
   - Drop D1 mocks; import `testDb` + `resetDb` from `tests/helpers/db`
   - `beforeEach(async () => { await resetDb(); })`
   - Replace any direct SQL inserts in test fixtures with `db.insert(...).values(...)` calls
5. Run `pnpm vitest run src/server/knowledge/<name>.test.ts`; iterate until green

Refer back to **Step 6.2 (seed.ts)** for the canonical transformation pattern.

- [ ] **Step 6.4: Delete the workers copies**

```bash
git rm -r workers/src/knowledge
```

- [ ] **Step 6.5: Run all ported tests**

```bash
pnpm vitest run src/server/knowledge/
```
Expected: all 7 test files pass.

- [ ] **Step 6.6: Commit**

```bash
git add src/server/knowledge/
git commit -m "feat(sub-0b1): port src/server/knowledge/* (seed, domain, propose, proposals, attribute, review, tree) — D1 → Drizzle PG"
```

---

## Task 7: Port `src/server/ai/*`

**Files:**
- Move: `workers/src/ai/runner.ts` → `src/server/ai/runner.ts`
- Move: `workers/src/ai/log.ts` → `src/server/ai/log.ts`
- Move: `workers/src/ai/judges/*` → `src/server/ai/judges/*`
- Plus their `.test.ts` siblings.

The decoupling: `runner.ts` currently takes `ctx: { env: Bindings }`. Replace with explicit `{db, r2, model?}`.

- [ ] **Step 7.1: Rewrite `runner.ts` signatures**

Read the current `RunTaskCtx`:
```bash
sed -n '15,30p' workers/src/ai/runner.ts
```

Replace `RunTaskCtx`:

```ts
import type { Db } from '@/db/client';
import type { R2Client } from '../r2';
import type { LanguageModel } from 'ai';

export interface RunTaskCtx {
  db: Db;
  r2: R2Client;
  /** Override model for testing (defaults to anthropic provider with task's defaultModel). */
  model?: LanguageModel;
}
```

Then audit every usage of `ctx.env.DB` and `ctx.env.IMAGES` in the file:
```bash
grep -n 'ctx\.env\.' workers/src/ai/runner.ts
```
Replace `ctx.env.DB` → `ctx.db`, `ctx.env.IMAGES` → `ctx.r2`. The same applies to other `env` fields referenced (e.g. `ctx.env.ANTHROPIC_API_KEY` → `process.env.ANTHROPIC_API_KEY`).

Similarly for `log.ts` (uses `db` directly; the function takes `db` as a parameter — minor: change parameter type from `D1Database` to `Db` and rewrite the `INSERT INTO tool_call_log / cost_ledger` statements to Drizzle `db.insert(tool_call_log).values({...})`).

- [ ] **Step 7.2: Port judges**

`workers/src/ai/judges/*` are pure functions over LLM I/O; they should not couple to env. Path-only port, plus any `D1Database` → `Db` swap in helpers.

For each of `exact.ts`, `keyword.ts`, `index.ts`:
```bash
mkdir -p src/server/ai/judges
cp workers/src/ai/judges/<name>.ts src/server/ai/judges/<name>.ts
cp workers/src/ai/judges/<name>.test.ts src/server/ai/judges/<name>.test.ts
```
Adjust imports (drop one `..` level).

- [ ] **Step 7.3: Port tests**

For each `*.test.ts`: drop D1 mocks, use `testDb` + `resetDb` where DB is touched; mock R2 with a simple in-memory implementation (see Step 7.6 below).

- [ ] **Step 7.4: In-memory R2 helper for tests**

Add `tests/helpers/r2.ts`:

```ts
import type { R2Client } from '@/server/r2';

export function memR2(): R2Client & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async put(key, body) { store.set(key, body); },
    async get(key) { return store.get(key) ?? null; },
    async delete(key) { store.delete(key); },
  };
}
```

- [ ] **Step 7.5: Run tests**

```bash
pnpm vitest run src/server/ai/
```
Expected: every ported judge + runner + log test passes.

- [ ] **Step 7.6: Delete workers copies + commit**

```bash
git rm -r workers/src/ai
git add src/server/ai/ tests/helpers/r2.ts
git commit -m "feat(sub-0b1): port src/server/ai/* — decouple env to {db, r2}; in-mem R2 for tests"
```

---

## Task 8: Port `src/server/ingestion/*`

**Files:**
- Move: `workers/src/ingestion/{cascade,vision,ocr_tencent,ocr_tencent_sign}.ts` (+ tests) → `src/server/ingestion/`

These modules currently mostly take `env: Bindings` for OCR secret access. Replace each function signature: instead of `env: Bindings`, take an explicit subset (`{ TENCENT_SECRET_ID, TENCENT_SECRET_KEY, TENCENT_OCR_REGION, ANTHROPIC_API_KEY }`) or read directly from `process.env`. Going forward, `process.env.*` is the right pattern.

- [ ] **Step 8.1: Port each file**

For each of `cascade.ts`, `vision.ts`, `ocr_tencent.ts`, `ocr_tencent_sign.ts`:

1. Read source: `cat workers/src/ingestion/<name>.ts`
2. Create at `src/server/ingestion/<name>.ts` with:
   - Replace `env: Bindings` parameter / destructure with direct `process.env.TENCENT_SECRET_ID`, etc.
   - Any `env.IMAGES` → take `r2: R2Client` parameter
   - Any `env.DB` → take `db: Db` parameter
   - Adjust relative imports
3. Repeat for test files using mocks already present in `workers/src/ingestion/<name>.test.ts` — usually the tests mock at the function boundary, so test ports are mostly path adjustments.

- [ ] **Step 8.2: Run tests**

```bash
pnpm vitest run src/server/ingestion/
```
Expected: all pass.

- [ ] **Step 8.3: Delete + commit**

```bash
git rm -r workers/src/ingestion
git add src/server/ingestion/
git commit -m "feat(sub-0b1): port src/server/ingestion/* — Tencent OCR + vision; env → process.env / args"
```

---

## Task 9: Port `src/server/export/*`

**Files:**
- Move: `workers/src/export/{constants,csv,readme}.ts` (+ tests) → `src/server/export/`

These are mostly pure helpers (CSV serialization, README templating, constants). Path-only port.

- [ ] **Step 9.1: Copy + adjust imports**

```bash
mkdir -p src/server/export
cp workers/src/export/{constants,csv,readme}.ts src/server/export/
cp workers/src/export/{constants,csv,readme}.test.ts src/server/export/
```
Adjust any `'../../../src/'` imports inside to `'../../'`.

- [ ] **Step 9.2: Run tests**

```bash
pnpm vitest run src/server/export/
```
Expected: all pass.

- [ ] **Step 9.3: Delete + commit**

```bash
git rm -r workers/src/export
git add src/server/export/
git commit -m "feat(sub-0b1): port src/server/export/* (constants, csv, readme)"
```

---

## Task 10: Route handler `/api/_/seed`

The seed business function (`seedKnowledge`) was ported in Task 6. Now the HTTP wrapper.

**Files:**
- Create: `app/api/_/seed/route.ts`
- Create: `app/api/_/seed/route.test.ts`

- [ ] **Step 10.1: Write failing route test**

`app/api/_/seed/route.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { buildAuthedRequest } from '../../../../tests/helpers/request';
import { POST } from './route';

describe('POST /api/_/seed', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns 200 with inserted count on first run', async () => {
    process.env.INTERNAL_TOKEN = 'test-token';
    const res = await POST(buildAuthedRequest('http://localhost/api/_/seed', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBeGreaterThan(0);
    expect(body.skipped).toBe(0);
  });

  it('is idempotent on second run', async () => {
    process.env.INTERNAL_TOKEN = 'test-token';
    await POST(buildAuthedRequest('http://localhost/api/_/seed', { method: 'POST' }));
    const res = await POST(buildAuthedRequest('http://localhost/api/_/seed', { method: 'POST' }));
    const body = await res.json();
    expect(body.inserted).toBe(0);
    expect(body.skipped).toBeGreaterThan(0);
  });
});
```

Note: route handler tests bypass `middleware.ts` (which only runs in a live Next.js server). We test middleware separately (Task 3). Auth is therefore assumed by the test as if it had passed.

- [ ] **Step 10.2: Run test, verify it fails**

```bash
pnpm vitest run app/api/_/seed/route.test.ts
```
Expected: `FAIL` — no `route.ts` yet.

- [ ] **Step 10.3: Implement**

`app/api/_/seed/route.ts`:

```ts
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { seedKnowledge } from '@/server/knowledge/seed';

export async function POST() {
  try {
    const result = await seedKnowledge(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 10.4: Run test, verify it passes**

```bash
pnpm vitest run app/api/_/seed/route.test.ts
```
Expected: `PASS`.

- [ ] **Step 10.5: Commit**

```bash
git add app/api/_/seed/
git commit -m "feat(sub-0b1): POST /api/_/seed route handler"
```

---

## Task 11: Route handlers `/api/_/logs/{tool_calls,cost}`

**Files:**
- Create: `app/api/_/logs/tool_calls/route.ts` + test
- Create: `app/api/_/logs/cost/route.ts` + test

The original `workers/src/routes/logs.ts` runs two read-only SQL queries. Rewrite both to Drizzle query builder.

- [ ] **Step 11.1: Port logs.test.ts**

Read `workers/src/routes/logs.test.ts`. Adapt assertions to two separate route-handler test files using `buildAuthedRequest` + the new route imports.

Skeleton for `app/api/_/logs/tool_calls/route.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { buildAuthedRequest } from '../../../../../tests/helpers/request';
import { tool_call_log } from '@/db/schema';
import { GET } from './route';

describe('GET /api/_/logs/tool_calls', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns recent tool calls ordered by occurred_at desc', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(tool_call_log).values([
      { id: 't1', task_run_id: 'r1', task_kind: 'k', tool_name: 'a', iteration: 0, latency_ms: 10, cost: 0.001, occurred_at: new Date(now.getTime() - 1000) },
      { id: 't2', task_run_id: 'r1', task_kind: 'k', tool_name: 'b', iteration: 1, latency_ms: 20, cost: 0.002, occurred_at: now },
    ]);
    const res = await GET(buildAuthedRequest('http://localhost/api/_/logs/tool_calls', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].id).toBe('t2');
    expect(body.items[1].id).toBe('t1');
  });
});
```

`app/api/_/logs/tool_calls/route.ts`:

```ts
import { desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { tool_call_log } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
    const items = await db
      .select()
      .from(tool_call_log)
      .orderBy(desc(tool_call_log.occurred_at))
      .limit(limit);
    return Response.json({ items });
  } catch (err) {
    return errorResponse(err);
  }
}
```

Repeat for `/cost/route.ts` (query `cost_ledger` instead).

- [ ] **Step 11.2: Run tests, verify pass**

```bash
pnpm vitest run app/api/_/logs/
```

- [ ] **Step 11.3: Commit**

```bash
git add app/api/_/logs/
git commit -m "feat(sub-0b1): GET /api/_/logs/{tool_calls,cost} route handlers"
```

---

## Task 12: Route handlers `/api/mistakes/*`

**Files:**
- Create: `app/api/mistakes/recent/route.ts` + test
- Create: `app/api/mistakes/route.ts` + test (POST)

Read `workers/src/routes/mistakes.ts` (246 LOC) for full behavior — list ordering, cause attribution call, mistake creation flow.

Pattern: each handler unwraps `req` → calls business helper (extract from `mistakes.ts` into `src/server/mistakes.ts` if logic is non-trivial; for inline queries, keep them in the handler).

- [ ] **Step 12.1: Inspect source**

```bash
cat workers/src/routes/mistakes.ts | head -100
```

- [ ] **Step 12.2: For each handler**

For `GET /api/mistakes/recent` and `POST /api/mistakes`:
1. Port the matching `workers/src/routes/mistakes.test.ts` test cases to `app/api/mistakes/recent/route.test.ts` and `app/api/mistakes/route.test.ts`
2. Implement the route handler in the new path using:
   - Drizzle query builder (no raw SQL)
   - Zod validation via `MistakeInsert` / `Mistake` from `src/core/schema`
   - `errorResponse(err)` from `@/server/http/errors`
3. Run + commit

Skeleton for `POST /api/mistakes`:

```ts
// app/api/mistakes/route.ts
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { mistake } from '@/db/schema';
import { MistakeInsert } from '@/core/schema';
import { ApiError } from '@/server/http/errors';
import { createId } from '@paralleldrive/cuid2';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = MistakeInsert.safeParse(body);
    if (!parsed.success) {
      throw new ApiError('validation_error', parsed.error.message, 400);
    }
    const now = new Date();
    const id = createId();
    const [row] = await db
      .insert(mistake)
      .values({ ...parsed.data, id, created_at: now, updated_at: now })
      .returning();
    return Response.json({ mistake: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
```

Reference the corresponding workers route for fields like `cause` attribution and `knowledge_id` validation. Port every test case from `workers/src/routes/mistakes.test.ts` to one of the two new test files.

- [ ] **Step 12.3: Run tests + commit**

```bash
pnpm vitest run app/api/mistakes/
git add app/api/mistakes/
git commit -m "feat(sub-0b1): /api/mistakes/{recent,(root)} route handlers + tests"
```

---

## Task 13: Route handlers `/api/knowledge/*`

**Files:**
- Create: `app/api/knowledge/route.ts` (GET) + test
- Create: `app/api/knowledge/proposals/route.ts` (GET) + test
- Create: `app/api/knowledge/proposals/[id]/route.ts` (POST approve/reject) + test
- Create: `app/api/knowledge/review/route.ts` (POST) + test

Read `workers/src/routes/knowledge.ts` (60 LOC — small). The body is mostly thin DB calls plus delegations to `src/server/knowledge/*` ported in Task 6.

- [ ] **Step 13.1: Port each handler**

For each of the 4 paths:
1. Port the relevant `workers/src/routes/knowledge.test.ts` cases to the new route test files
2. Implement the handler using Drizzle + `src/server/knowledge/*` business funcs
3. Use `[id]` dynamic segment in Next.js — parameters reach the handler as `{ params: Promise<{ id: string }> }`:

   ```ts
   export async function POST(
     req: Request,
     { params }: { params: Promise<{ id: string }> },
   ) {
     const { id } = await params;
     // ...
   }
   ```

- [ ] **Step 13.2: Run tests + commit**

```bash
pnpm vitest run app/api/knowledge/
git add app/api/knowledge/
git commit -m "feat(sub-0b1): /api/knowledge/* route handlers (list, proposals, proposals/[id], review)"
```

---

## Task 14: Route handlers `/api/learning-items/*`

**Files:**
- Create: `app/api/learning-items/route.ts` (GET + POST) + test
- Create: `app/api/learning-items/[id]/route.ts` (PATCH + DELETE) + test

Read `workers/src/routes/learning_items.ts` (369 LOC). Notable details:
- GET supports `?status=pending|in_progress|done` filter
- POST validates `knowledge_ids` exist (per-row; uses `assertKnowledgeIdsExist`)
- PATCH partial-updates content / status / knowledge_ids
- DELETE soft-deletes (sets `archived_at`)

`assertKnowledgeIdsExist` helper from workers should move into `src/server/knowledge/validate.ts`:

```ts
import { and, inArray, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';

export async function assertKnowledgeIdsExist(
  db: Db,
  ids: string[],
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  if (ids.length === 0) return { ok: true };
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(inArray(knowledge.id, ids), isNull(knowledge.archived_at)));
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}
```

- [ ] **Step 14.1: Port the helper + its test (extract from workers/src/routes/learning_items.test.ts if covered there; otherwise add minimal unit tests)**

- [ ] **Step 14.2: Port the 4 handlers (GET + POST in `route.ts`; PATCH + DELETE in `[id]/route.ts`)**

Use the Drizzle ordering pattern for the GET list (originally a SQL `CASE` ordering): convert to a `desc(updated_at)` plus an in-memory sort post-fetch, OR use Drizzle's `sql\`case ... end\`` with explicit casts.

For PATCH: read query columns, build a partial `set` object, increment `version`.

For DELETE: `db.update(learning_item).set({ archived_at: new Date() }).where(eq(...))`.

- [ ] **Step 14.3: Port every test case from `workers/src/routes/learning_items.test.ts` (768 LOC)**

Split: GET-related tests → `app/api/learning-items/route.test.ts`; per-ID tests → `app/api/learning-items/[id]/route.test.ts`.

- [ ] **Step 14.4: Run + commit**

```bash
pnpm vitest run app/api/learning-items/ src/server/knowledge/validate.test.ts
git add app/api/learning-items/ src/server/knowledge/validate.ts src/server/knowledge/validate.test.ts
git commit -m "feat(sub-0b1): /api/learning-items/* + assertKnowledgeIdsExist helper"
```

---

## Task 15: Route handlers `/api/review/{due,submit}`

**Files:**
- Create: `app/api/review/due/route.ts` + test
- Create: `app/api/review/submit/route.ts` + test

Read `workers/src/routes/review.ts` (178 LOC) — uses `src/server/review/fsrs.ts` (already ported in Task 5) for state transitions, and writes a `review_event` row with `fsrs_state_before` / `fsrs_state_after`.

- [ ] **Step 15.1: GET /api/review/due**

Selects mistakes whose `fsrs_state->>'due'` ≤ now, limited by query param. In PG with the new jsonb column, the SQL is:

```sql
select * from mistake
where status = 'active'
  and (fsrs_state is null or (fsrs_state->>'due')::timestamptz <= now())
order by (fsrs_state->>'due')::timestamptz nulls first
limit 20;
```

Drizzle expression — use `sql\`\``:

```ts
import { sql } from 'drizzle-orm';
import { and, eq, isNull, or } from 'drizzle-orm';

const rows = await db
  .select()
  .from(mistake)
  .where(
    and(
      eq(mistake.status, 'active'),
      or(
        isNull(mistake.fsrs_state),
        sql`(${mistake.fsrs_state} ->> 'due')::timestamptz <= now()`,
      ),
    ),
  )
  .orderBy(sql`(${mistake.fsrs_state} ->> 'due')::timestamptz nulls first`)
  .limit(limit);
```

- [ ] **Step 15.2: POST /api/review/submit**

Reads `mistake.fsrs_state`, runs `scheduleReview(prevState, rating)` from `src/server/review/fsrs.ts`, writes `review_event` row, updates `mistake.fsrs_state`. Wrap in a transaction:

```ts
import { sql } from 'drizzle-orm';

await db.transaction(async (tx) => {
  // read mistake
  // compute nextState via scheduleReview
  // insert review_event
  // update mistake.fsrs_state
});
```

- [ ] **Step 15.3: Port tests from `workers/src/routes/review.test.ts` (478 LOC)**

Split: due-listing tests → `due/route.test.ts`; submission tests → `submit/route.test.ts`.

- [ ] **Step 15.4: Run + commit**

```bash
pnpm vitest run app/api/review/
git add app/api/review/
git commit -m "feat(sub-0b1): /api/review/{due,submit} route handlers + FSRS scheduler integration"
```

---

## Task 16: Route handlers `/api/assets/*`

**Files:**
- Create: `app/api/assets/route.ts` (POST upload) + test
- Create: `app/api/assets/[id]/route.ts` (DELETE) + test

`workers/src/routes/assets.ts` does:
- POST: receives `multipart/form-data` with `file`, hashes the bytes, writes to R2 at `assets/<sha256>`, inserts `source_asset` row.
- DELETE: looks up `source_asset` by id, deletes R2 object, deletes DB row.

Next.js Route Handlers expose multipart via `req.formData()`. Same API surface.

- [ ] **Step 16.1: Sketch POST**

```ts
// app/api/assets/route.ts
import { db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { errorResponse, ApiError } from '@/server/http/errors';
import { getR2 } from '@/server/r2';
import { createId } from '@paralleldrive/cuid2';

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new ApiError('validation_error', 'missing file', 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha = await sha256(bytes); // helper below
    const storageKey = `assets/${sha}`;
    const r2 = getR2();
    await r2.put(storageKey, bytes, file.type || 'application/octet-stream');
    const id = createId();
    const now = new Date();
    const [row] = await db
      .insert(source_asset)
      .values({
        id,
        kind: 'image',
        storage_key: storageKey,
        mime_type: file.type || 'application/octet-stream',
        byte_size: bytes.byteLength,
        sha256: sha,
        created_at: now,
      })
      .returning();
    return Response.json({ asset: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

- [ ] **Step 16.2: Implement DELETE**

```ts
// app/api/assets/[id]/route.ts
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { errorResponse, ApiError } from '@/server/http/errors';
import { getR2 } from '@/server/r2';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const [row] = await db
      .select()
      .from(source_asset)
      .where(eq(source_asset.id, id))
      .limit(1);
    if (!row) throw new ApiError('not_found', `asset ${id} not found`, 404);
    await getR2().delete(row.storage_key);
    await db.delete(source_asset).where(eq(source_asset.id, id));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 16.3: Test using `memR2()`**

Tests use `tests/helpers/r2.ts`'s `memR2` via module mock:

```ts
import { vi } from 'vitest';
vi.mock('@/server/r2', () => {
  const { memR2 } = require('../../../../tests/helpers/r2');
  const r2 = memR2();
  return { getR2: () => r2, createR2Client: () => r2 };
});
```

Then port every test case from `workers/src/routes/assets.test.ts` (128 LOC). Include the round-trip case: POST → row exists in DB + R2 → DELETE → row gone from both.

- [ ] **Step 16.4: Run + commit**

```bash
pnpm vitest run app/api/assets/
git add app/api/assets/
git commit -m "feat(sub-0b1): /api/assets/* (POST upload, DELETE) — multipart + R2 + DB"
```

---

## Task 17: Route handlers `/api/ingestion/*`

**Files:**
- Create: `app/api/ingestion/route.ts` (POST create session) + test
- Create: `app/api/ingestion/[id]/route.ts` (GET + PATCH) + test
- Create: `app/api/ingestion/[id]/extract/route.ts` (POST kickoff) + test

This is the largest route group: `workers/src/routes/ingestion.ts` is 723 LOC; tests are 1424 LOC. Most of the heavy lifting was already in `src/server/ingestion/*` (Task 8). The HTTP wrappers are smaller — DB read/write + delegation.

- [ ] **Step 17.1: Map workers route bodies onto the 3 new handler files**

The workers file has many sub-routes mounted onto `/api/ingestion`. Read it carefully:
```bash
grep -nE "ingestion\.(get|post|patch|delete)" workers/src/routes/ingestion.ts
```

Group endpoints onto the three new `route.ts` files based on URL:
- `POST /api/ingestion` → `route.ts`
- `GET  /api/ingestion/:id` → `[id]/route.ts`
- `PATCH /api/ingestion/:id` → `[id]/route.ts`
- `POST /api/ingestion/:id/extract` → `[id]/extract/route.ts`

If the workers file has additional endpoints (e.g. `/api/ingestion/:id/blocks/:bid`), add corresponding nested `route.ts` files.

- [ ] **Step 17.2: Implement handlers**

Each handler is a thin wrapper:
- Parse request (URL params, body via `await req.json()`)
- Call into `src/server/ingestion/*` business functions
- Return `Response.json(result)` or error via `errorResponse`

- [ ] **Step 17.3: Port tests**

`workers/src/routes/ingestion.test.ts` cases distribute across the three new test files. Use:
- `testDb()` + `resetDb()` for DB state
- `memR2()` via `vi.mock` for R2 calls
- Mock `src/server/ingestion/ocr_tencent` and `vision` at the module level — these external API integrations are unit-tested separately (Task 8) and route tests only need to assert the call shape.

- [ ] **Step 17.4: Run + commit**

```bash
pnpm vitest run app/api/ingestion/
git add app/api/ingestion/
git commit -m "feat(sub-0b1): /api/ingestion/* route handlers (session create, get/patch, extract)"
```

---

## Task 18: Route handlers `/api/_/export` + `/api/_/import`

**Files:**
- Create: `app/api/_/export/route.ts` (GET ZIP) + test
- Create: `app/api/_/import/route.ts` (POST ZIP) + test

`workers/src/routes/export.ts` (86 LOC) streams a ZIP of all DB tables (CSV) + R2 objects. `workers/src/routes/import.ts` (185 LOC) consumes the same shape.

- [ ] **Step 18.1: Inspect ZIP producer**

```bash
cat workers/src/routes/export.ts
```
Note the use of `client-zip` (already in `package.json`) for streaming ZIP.

- [ ] **Step 18.2: Implement GET /api/_/export**

```ts
// app/api/_/export/route.ts
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { getR2 } from '@/server/r2';
import { buildBackupArchive } from '@/server/export'; // business glue from Task 9
// (you may need to create an `index.ts` in src/server/export/ exporting buildBackupArchive)

export async function GET() {
  try {
    const stream = await buildBackupArchive({ db, r2: getR2() });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="loom-backup.zip"',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
```

Inspect workers/src/routes/export.ts to see the existing `buildBackupArchive` shape (or whatever it's named there); port it into `src/server/export/index.ts` taking `{ db, r2 }` as args.

- [ ] **Step 18.3: Implement POST /api/_/import**

```ts
// app/api/_/import/route.ts
import { db } from '@/db/client';
import { errorResponse, ApiError } from '@/server/http/errors';
import { getR2 } from '@/server/r2';
import { restoreFromArchive } from '@/server/export';

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.includes('application/zip') && !contentType.includes('multipart')) {
      throw new ApiError('validation_error', 'expected application/zip body or multipart', 400);
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    const result = await restoreFromArchive({ db, r2: getR2(), bytes });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 18.4: Port export.test.ts + import.test.ts + round_trip.test.ts**

`workers/src/routes/round_trip.test.ts` covers the export-then-import cycle. Port it as `app/api/_/_round_trip.test.ts` — a single file that exercises both handlers end-to-end with `memR2`.

- [ ] **Step 18.5: Run + commit**

```bash
pnpm vitest run app/api/_/export/ app/api/_/import/ app/api/_/_round_trip.test.ts
git add app/api/_/ src/server/export/index.ts
git commit -m "feat(sub-0b1): /api/_/export + /api/_/import (ZIP backup/restore) + round-trip test"
```

---

## Task 19: Route handler `/api/ai/[task]` (streaming)

**Files:**
- Create: `app/api/ai/[task]/route.ts` + test

Original at `workers/src/index.ts` lines 60-78. Streaming is preserved via Web Streams API — Next.js Route Handlers natively return `Response(stream)`.

- [ ] **Step 19.1: Implement**

```ts
// app/api/ai/[task]/route.ts
import { tasks } from '@/ai/registry';
import { db } from '@/db/client';
import { runTask, streamTask } from '@/server/ai/runner';
import { errorResponse } from '@/server/http/errors';
import { getR2 } from '@/server/r2';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ task: string }> },
) {
  try {
    const { task } = await params;
    const def = (tasks as Record<string, { needsToolCall: boolean }>)[task];
    if (!def) return Response.json({ error: 'unknown_task', task }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { input?: unknown };

    if (def.needsToolCall) {
      return streamTask(task, body.input ?? {}, { db, r2: getR2(), tools: {} });
    }
    const result = await runTask(task, body.input ?? {}, { db, r2: getR2() });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
```

`streamTask` returns a `Response` with a `ReadableStream` body — propagate as-is.

- [ ] **Step 19.2: Port tests from `workers/src/ai/runner.test.ts`**

(Most assertions live at the business layer — runner.test.ts ported in Task 7. Route-level test asserts only that the dispatch picks the right code path: 404 on unknown task, JSON on single-shot, streaming Response on tool-calling.)

`app/api/ai/[task]/route.test.ts` skeleton:

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildAuthedRequest } from '../../../../tests/helpers/request';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn().mockResolvedValue({ task_run_id: 'r1', text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }),
  streamTask: vi.fn().mockImplementation(() => new Response('chunk1\nchunk2\n', { headers: { 'content-type': 'text/plain' } })),
}));

vi.mock('@/ai/registry', () => ({
  tasks: { cause_attribution: { needsToolCall: false }, judge_flexible: { needsToolCall: true } },
}));

import { POST } from './route';

describe('POST /api/ai/[task]', () => {
  it('returns JSON for non-streaming task', async () => {
    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/cause_attribution', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      }),
      { params: Promise.resolve({ task: 'cause_attribution' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_run_id).toBe('r1');
  });

  it('returns streaming Response for tool-calling task', async () => {
    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/judge_flexible', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      }),
      { params: Promise.resolve({ task: 'judge_flexible' }) },
    );
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('chunk1');
  });

  it('returns 404 for unknown task', async () => {
    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/nope', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ task: 'nope' }) },
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 19.3: Run + commit**

```bash
pnpm vitest run app/api/ai/
git add app/api/ai/
git commit -m "feat(sub-0b1): POST /api/ai/[task] route handler (streaming + JSON)"
```

---

## Task 20: Delete `workers/`, drop deps, smoke verify

**Files:**
- Delete: `workers/` (entire tree)
- Modify: `package.json` (remove `hono`, `wrangler`, `@cloudflare/workers-types`; remove `workers:dev` / `workers:deploy` scripts)
- Modify: `tsconfig.json` (if it has a `workers/*` path or include)
- Modify: `biome.json` (`files.ignore`: drop `.wrangler` and `workers` if listed)

- [ ] **Step 20.1: Confirm everything ported**

```bash
find workers -name '*.ts' -not -name '*.test.ts' | sort
# Expected: only workers/src/{index.ts, auth.ts, db.ts, types.ts, routes/*}.
# All business modules under workers/src/{ai,knowledge,ingestion,review,export} should already be gone.
```

Verify each remaining route file's logic is represented under `app/api/`:

```bash
ls workers/src/routes/
# assets.ts, export.ts, import.ts, ingestion.ts, knowledge.ts, learning_items.ts, logs.ts, mistakes.ts, review.ts
ls app/api/
# _, ai, assets, health, ingestion, knowledge, learning-items, mistakes, review
```

- [ ] **Step 20.2: Delete the tree**

```bash
git rm -r workers/
```

- [ ] **Step 20.3: Drop deps**

```bash
pnpm remove hono wrangler @cloudflare/workers-types
```

- [ ] **Step 20.4: Drop scripts**

Edit `package.json` — remove the `workers:dev` and `workers:deploy` script entries.

- [ ] **Step 20.5: Clean up biome.json**

Edit `biome.json` `files.ignore` array: remove `".wrangler"` and `"workers"` entries.

- [ ] **Step 20.6: Run the full suite**

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

Each must succeed. `pnpm test` runs every ported test against a fresh testcontainers Postgres.

- [ ] **Step 20.7: Commit**

```bash
git add -A
git commit -m "chore(sub-0b1): delete workers/, drop hono/wrangler/@cloudflare/workers-types"
```

---

## Task 21: Final verification + PR open

**Files:** (none changed in this task)

- [ ] **Step 21.1: Push branch**

```bash
git push -u origin sub-0b1-api-route-migration
```

- [ ] **Step 21.2: Watch Vercel preview deploy**

Use Vercel MCP `list_deployments` filtered by branch alias. Wait for `state: READY`.

- [ ] **Step 21.3: Curl the 24 endpoints against the preview URL**

For each method/path in the spec endpoint inventory (§4), run `curl -H 'x-internal-token: <TOKEN>' <preview-url><path>` (with appropriate method + body) and confirm the response. Recommended: write a smoke script `tests/smoke-preview.sh` that exercises one happy path per endpoint.

- [ ] **Step 21.4: Open PR**

```bash
gh pr create --title "Phase 1a Sub 0b1: API Route Migration — Workers → Next.js" --body-file ./.github/pr-templates/sub-0b1.md
```
(Author the body inline if no template exists, referencing the spec + plan + acceptance checklist.)

- [ ] **Step 21.5: PR review fix loop**

Mirror Sub 0a process: receive review report (P1/P2/P3), address P1+P2 in this PR, log P3 for follow-up.

- [ ] **Step 21.6: Merge**

After review + verification, squash-merge with a body that lists the new file structure and notes Workers deletion.

---

## Self-review notes

- **Spec coverage:** Every section of the spec maps to at least one task: §1 decisions → Tasks 1-4 + 20; §2 source layout → Tasks 5-9 + 20; §3.1 SQL rewrite → Tasks 6-19; §3.2 R2 → Task 2 + 16; §3.3 auth → Task 3; §3.4 streaming → Task 19; §3.5 errors → Task 1; §3.6 pooling → already configured in Sub 0a, doc-only; §4 endpoint inventory → Tasks 10-19; §5 tests → Tasks 4 + every port; §6 acceptance → Task 21; §7 risks → addressed inline.
- **Type consistency:** `Db` from `@/db/client`, `R2Client` from `@/server/r2`, `ApiError` + `errorResponse` from `@/server/http/errors`, `testDb` + `resetDb` from `tests/helpers/db`, `buildAuthedRequest` from `tests/helpers/request`, `memR2` from `tests/helpers/r2`. Function names match across tasks.
- **Placeholder scan:** No "TBD"/"implement later". Where workers source is referenced ("read X, port to Y"), the reading is part of the task — not a placeholder, but real work the engineer needs to do.
- **Order:** Foundations (Tasks 1-4), business modules (5-9), route handlers small→large (10-19), cleanup (20), ship (21). Each commit builds on the previous; no task imports something not yet defined.

---

## Estimate

| Phase | Tasks | Effort |
|---|---|---|
| Scaffolding | 1-4 | 0.5d |
| Business module ports | 5-9 | 1d |
| Small route groups (logs, seed, mistakes, knowledge, learning-items, review) | 10-15 | 1d |
| Heavier route groups (assets, ingestion, export/import, ai) | 16-19 | 1d |
| Cleanup + verify + PR | 20-21 | 0.5d |

**Total:** ~4d.
