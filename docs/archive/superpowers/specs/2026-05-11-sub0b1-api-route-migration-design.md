# Sub 0b1 · API Route Migration — Workers Hono → Next.js · Design

**Date:** 2026-05-11 (revised 2026-05-11 for self-host pivot)
**Stack pivot context:** Architecture review 2026-05-11 (#25) + Sub 0a (#26 merged) + self-host pivot 2026-05-11
**This sub:** Sub 0b1 — API only. UI redesign per Loom design v1 = Sub 0b2 (separate spec).

> **Deployment target update (2026-05-11):** The project moved from Vercel + Neon to **self-host on 绿联 NAS** (Docker compose + local Postgres + Cloudflare R2 + Cloudflare Tunnel). Sub 0b1 itself is deployment-agnostic — Next.js Route Handlers + `src/server/*` business logic run on either target — but verification examples and acceptance steps below use the local docker-compose flow rather than Vercel preview deploys. The NAS deployment bootstrap (Dockerfile, docker-compose.yml, Cloudflare Tunnel agent, `.vercel/` cleanup) is **Sub 0z**, a separate brainstorm.

---

## 0. Goal

Migrate all Cloudflare Workers Hono routes to Next.js App Router Route Handlers. Business logic moves out of `workers/` into runtime-agnostic `src/server/` modules. D1 → Postgres via Drizzle; R2 binding → `@aws-sdk/client-s3`. Workers tree fully deleted at the end. UI rebuild deferred to Sub 0b2.

**Why now:** Sub 0a shipped infrastructure (Next.js + PG + /api/health) but legacy API still lives in `workers/`. Sub 0c (pg-boss inline workers + OCR upgrade) needs the routes on the new runtime first.

**Out of scope:**
- UI / pages (Sub 0b2)
- pg-boss inline workers + durable job pipeline (Sub 0c)
- Tencent OCR EduPaperOCR → QuestionSplitOCR upgrade (Sub 0c)
- NAS deployment bootstrap — Dockerfile, docker-compose, Cloudflare Tunnel agent, removal of Vercel artifacts (Sub 0z)
- New endpoints; this is pure port + decouple

---

## 1. Locked decisions

| Topic | Decision | Rationale |
|---|---|---|
| Migration approach | **Direct port** (no Hono catch-all hybrid) | Clean end state; business logic already separable; Hono dep can go |
| Business logic location | `src/server/{ai,ingestion,knowledge,review,export}` (1:1 with `workers/src/*`) | Runtime-agnostic; future self-host can reuse |
| Dependency injection | Functions take `db: Db` and `r2: R2Client` as args | Unit tests use mocks; no module singletons |
| Route handler granularity | One `route.ts` per URL (Next.js convention), exports `GET`/`POST`/`PATCH`/`DELETE` as needed | Standard pattern |
| R2 client | `@aws-sdk/client-s3` v3 | Most mature; bundle size irrelevant on self-host Node 24; broad docs; Cloudflare R2 stays as offsite-friendly asset store |
| Auth | `x-internal-token` via `middleware.ts` matching `/api/:path*`, exempting `/api/health` | Works behind Cloudflare Tunnel; same scheme Workers used |
| SQL rewrite | Drizzle query builder (not raw `sql\`\``) for all touched queries | Type-safety; PG-native operator hints |
| Test PG | `testcontainers` (Docker Postgres) via vitest `globalSetup` | Automated, deterministic; CI Docker available on `ubuntu-latest` |
| Test port | All workers/*.test.ts ported 1:1 (unit + route handler) | Coverage parity, no silent regressions |
| Workers cleanup | Final commit deletes `workers/` + drops `wrangler` / `hono` / `@cloudflare/workers-types` deps | No double-stack maintenance |

---

## 2. Source layout (after)

```
src/server/                          # runtime-agnostic business logic
  ai/
    runner.ts                        ← workers/src/ai/runner.ts
    judges/*.ts                      ← workers/src/ai/judges/
  ingestion/
    *.ts                             ← workers/src/ingestion/*
  knowledge/
    seed.ts                          ← workers/src/knowledge/seed.ts
  review/
    fsrs.ts                          ← workers/src/review/fsrs.ts
  export/
    *.ts                             ← workers/src/export/*
  r2.ts                              ← NEW: @aws-sdk/client-s3 wrapper
  http/
    errors.ts                        ← NEW: ApiError + errorResponse helper

src/db/                              # unchanged (Sub 0a)
  client.ts
  schema.ts

src/core/schema/                     # unchanged
  business.ts / generated.ts / index.ts

app/api/                             # HTTP boundary (Next.js)
  health/route.ts                    ✅ existing
  _/seed/route.ts                    POST
  _/export/route.ts                  GET (ZIP backup)
  _/import/route.ts                  POST (ZIP restore)
  _/logs/tool_calls/route.ts         GET
  _/logs/cost/route.ts               GET
  assets/route.ts                    POST
  assets/[id]/route.ts               DELETE
  knowledge/route.ts                 GET
  knowledge/proposals/route.ts       GET
  knowledge/proposals/[id]/route.ts  POST (approve/reject)
  knowledge/review/route.ts          POST
  mistakes/recent/route.ts           GET
  mistakes/route.ts                  POST
  ingestion/route.ts                 POST (session create)
  ingestion/[id]/route.ts            GET / PATCH
  ingestion/[id]/extract/route.ts    POST
  learning-items/route.ts            GET / POST
  learning-items/[id]/route.ts       PATCH / DELETE
  review/due/route.ts                GET
  review/submit/route.ts             POST
  ai/[task]/route.ts                 POST + streaming

middleware.ts                        ← NEW: x-internal-token check
```

`workers/` deleted at the end of the PR.

---

## 3. Migration mappings

### 3.1 D1 → Drizzle PG query builder

Workers uses raw D1 statements:

```ts
// before
const row = await c.env.DB.prepare('select id, name from knowledge where id = ?')
  .bind(id).first<{id: string; name: string}>();
```

Rewrite to Drizzle query builder:

```ts
// after
import { eq } from 'drizzle-orm';
import { knowledge } from '@/db/schema';

const [row] = await db
  .select({ id: knowledge.id, name: knowledge.name })
  .from(knowledge)
  .where(eq(knowledge.id, id))
  .limit(1);
```

**SQL dialect deltas:**

| D1 (SQLite) | PG | Handling |
|---|---|---|
| `?` placeholder | `$1` | Drizzle abstracts |
| `json_extract(x, '$.k')` | `x->>'k'` | Few usages; rewrite manually |
| `unixepoch()` | `now()` | Most business code already uses JS timestamps |
| `IFNULL` | `COALESCE` | Drizzle abstracts |

Where a query is genuinely too dynamic for the builder, fall back to `db.execute(sql\`...\`)` — must be commented with why.

### 3.2 R2 binding → S3 client

`src/server/r2.ts`:

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  forcePathStyle: true,
});
const bucket = process.env.R2_BUCKET!;

export interface R2Client {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export const r2: R2Client = {
  async put(key, body, contentType) {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: contentType,
    }));
  },
  async get(key) {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) return null;
      const chunks: Uint8Array[] = [];
      // @ts-expect-error AsyncIterable<Uint8Array> in Node
      for await (const c of res.Body) chunks.push(c);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'name' in err && err.name === 'NoSuchKey') return null;
      throw err;
    }
  },
  async delete(key) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
};
```

Business functions take `r2: R2Client` so tests can mock.

**New env vars** (`.env.local` for dev; `docker-compose.yml` env_file for prod — wired by Sub 0z):
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT` (e.g. `https://<accountid>.r2.cloudflarestorage.com`)
- `R2_BUCKET`
- `INTERNAL_TOKEN` (already used by Workers; carries over)

### 3.3 Auth middleware

`middleware.ts` at repo root:

```ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path === '/api/health') return; // uptime monitors hit this
  const token = req.headers.get('x-internal-token');
  if (!token || token !== process.env.INTERNAL_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
}

export const config = { matcher: '/api/:path*' };
```

Note: Next.js middleware runs on every matched request. Use Node runtime (default in Next 15 when middleware does only env reads + header checks; no Edge runtime quirks).

### 3.4 Streaming on `/api/ai/[task]`

Workers' `streamTask` returns a `Response` with a `ReadableStream` body. Next.js Route Handlers support the same exact return — port as-is:

```ts
// app/api/ai/[task]/route.ts
import { streamTask, runTask } from '@/server/ai/runner';
import { tasks } from '@/ai/registry';

export async function POST(req: Request, { params }: { params: Promise<{ task: string }> }) {
  const { task } = await params;
  const body = (await req.json().catch(() => ({}))) as { input?: unknown };
  const def = (tasks as Record<string, { needsToolCall: boolean }>)[task];
  if (!def) return Response.json({ error: 'unknown_task', task }, { status: 404 });

  if (def.needsToolCall) {
    return streamTask(task, body.input ?? {}, { db, r2, tools: {} });
  }
  const result = await runTask(task, body.input ?? {}, { db, r2 });
  return Response.json(result);
}
```

`runner.ts` is moved into `src/server/ai/` and its `env` parameter is replaced with explicit `{db, r2}` injection.

### 3.5 Error handling

`src/server/http/errors.ts`:

```ts
export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json({ error: err.code, message: err.message }, { status: err.status });
  }
  console.error('unhandled error', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    timestamp: new Date().toISOString(),
  });
  return Response.json(
    { error: 'internal_error', message: err instanceof Error ? err.message : 'unexpected' },
    { status: 500 },
  );
}
```

Each Route Handler wraps its body in `try/catch` → `errorResponse(err)`. Business functions throw `ApiError` for known failures; unexpected errors fall through to the 500 branch with structured logging.

### 3.6 DB connection pooling

Sub 0a `src/db/client.ts` uses `postgres-js` with `max: 10`. On self-host the entire Next.js app runs in a single Node process — one connection pool, capped at 10, owned by that process. For single-user load (~30 questions/day) this is far below the bottleneck. No PgBouncer needed.

If concurrency ever climbs (e.g. pg-boss adds parallel workers in Sub 0c), bump `max` or move workers to their own process with their own pool.

This is a doc-only note for Sub 0b1; no code change.

---

## 4. Endpoint inventory

All endpoints currently in `workers/src/index.ts` and `workers/src/routes/*`. Each row: source file, HTTP method + path, target Next.js file, business module that gets extracted.

| Method | Path | Source (workers) | Target (Next.js) | Business module |
|---|---|---|---|---|
| GET | `/api/health` | `index.ts` | `app/api/health/route.ts` ✅ | (in-line; already done) |
| POST | `/api/_/seed` | `index.ts` | `app/api/_/seed/route.ts` | `src/server/knowledge/seed.ts` |
| GET | `/api/_/export` | `routes/export.ts` | `app/api/_/export/route.ts` | `src/server/export/*` |
| POST | `/api/_/import` | `routes/import.ts` | `app/api/_/import/route.ts` | `src/server/export/*` (shared with export — restore lives here) |
| GET | `/api/_/logs/tool_calls` | `routes/logs.ts` | `app/api/_/logs/tool_calls/route.ts` | inline (simple query) |
| GET | `/api/_/logs/cost` | `routes/logs.ts` | `app/api/_/logs/cost/route.ts` | inline |
| POST | `/api/assets` | `routes/assets.ts` | `app/api/assets/route.ts` | `src/server/assets.ts` (NEW; ports the asset upload logic) |
| DELETE | `/api/assets/:id` | `routes/assets.ts` | `app/api/assets/[id]/route.ts` | same as above |
| GET | `/api/knowledge` | `routes/knowledge.ts` | `app/api/knowledge/route.ts` | inline |
| GET | `/api/knowledge/proposals` | `routes/knowledge.ts` | `app/api/knowledge/proposals/route.ts` | inline |
| POST | `/api/knowledge/proposals/:id` | `routes/knowledge.ts` | `app/api/knowledge/proposals/[id]/route.ts` | inline |
| POST | `/api/knowledge/review` | `routes/knowledge.ts` | `app/api/knowledge/review/route.ts` | inline |
| GET | `/api/mistakes/recent` | `routes/mistakes.ts` | `app/api/mistakes/recent/route.ts` | inline |
| POST | `/api/mistakes` | `routes/mistakes.ts` | `app/api/mistakes/route.ts` | inline |
| POST | `/api/ingestion` | `routes/ingestion.ts` | `app/api/ingestion/route.ts` | `src/server/ingestion/*` |
| GET | `/api/ingestion/:id` | `routes/ingestion.ts` | `app/api/ingestion/[id]/route.ts` | `src/server/ingestion/*` |
| PATCH | `/api/ingestion/:id` | `routes/ingestion.ts` | `app/api/ingestion/[id]/route.ts` | `src/server/ingestion/*` |
| POST | `/api/ingestion/:id/extract` | `routes/ingestion.ts` | `app/api/ingestion/[id]/extract/route.ts` | `src/server/ingestion/*` |
| GET | `/api/learning-items` | `routes/learning_items.ts` | `app/api/learning-items/route.ts` | inline |
| POST | `/api/learning-items` | `routes/learning_items.ts` | `app/api/learning-items/route.ts` | inline |
| PATCH | `/api/learning-items/:id` | `routes/learning_items.ts` | `app/api/learning-items/[id]/route.ts` | inline |
| DELETE | `/api/learning-items/:id` | `routes/learning_items.ts` | `app/api/learning-items/[id]/route.ts` | inline |
| GET | `/api/review/due` | `routes/review.ts` | `app/api/review/due/route.ts` | `src/server/review/fsrs.ts` |
| POST | `/api/review/submit` | `routes/review.ts` | `app/api/review/submit/route.ts` | `src/server/review/fsrs.ts` |
| POST | `/api/ai/:task` | `index.ts` | `app/api/ai/[task]/route.ts` | `src/server/ai/runner.ts` |

**Total:** 24 handler bindings across 22 `route.ts` files (some share a file when on the same URL with different methods, e.g. `learning-items/[id]/route.ts` exports both `PATCH` and `DELETE`).

---

## 5. Test strategy

### 5.1 Test layout

```
src/server/
  knowledge/
    seed.ts
    seed.test.ts                    ← unit test, mock db
  review/
    fsrs.ts
    fsrs.test.ts                    ← unit test
  ingestion/
    *.ts
    *.test.ts
  ai/
    runner.ts
    runner.test.ts
  export/
    *.test.ts

app/api/
  health/
    route.ts
    route.test.ts                    ← optional; existing
  learning-items/
    route.ts
    route.test.ts                    ← happy + 1 edge per handler
  ingestion/
    route.test.ts
    [id]/
      route.test.ts
      extract/
        route.test.ts
  ...
```

### 5.2 PG via testcontainers

`vitest.config.ts` `globalSetup` spins up an ephemeral Postgres container, runs `drizzle-kit push` against it, sets `TEST_DATABASE_URL` for the test run, tears down on exit.

```ts
// tests/global-setup.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;

export async function setup() {
  container = await new PostgreSqlContainer('postgres:16').start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();
  // drizzle-kit push pointed at TEST_DATABASE_URL
  // (implemented via spawn; details in plan)
}

export async function teardown() { await container.stop(); }
```

`src/db/client.ts` reads `DATABASE_URL`. Tests get a separate `Db` constructed against `TEST_DATABASE_URL`, exported from `tests/helpers/db.ts`. Business functions in tests are called with this test db.

**CI:** GitHub Actions `ubuntu-latest` has Docker preinstalled; no extra setup. Locally: `docker desktop must be running`. Documented in `README` test section.

### 5.3 Route handler tests

```ts
// app/api/learning-items/route.test.ts
import { describe, it, expect } from 'vitest';
import { GET, POST } from './route';
import { testDb } from '@/../tests/helpers/db';

describe('GET /api/learning-items', () => {
  it('returns 200 with list', async () => {
    const req = new Request('http://localhost/api/learning-items', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });
});
```

Route handlers expose `GET`/`POST`/etc. — directly callable in tests without booting a server.

### 5.4 Test port coverage target

Every `workers/**/*.test.ts` has an equivalent in the new layout — same describe/it names so coverage parity is verifiable by diff.

---

## 6. Acceptance checklist

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm build` clean
- [ ] `pnpm test` green, coverage ≥ Workers baseline
- [ ] All 24 endpoints respond against local `pnpm dev` (curl matrix or smoke script; DATABASE_URL points at a local docker-compose Postgres or temporarily Neon)
- [ ] `/api/health` 200, `db_ok=true`
- [ ] `/api/_/seed` produces seed knowledge rows
- [ ] `/api/ai/<task>` streaming case: chunks arrive in order, non-buffered
- [ ] R2 round-trip: POST `/api/assets` → record DB row → DELETE `/api/assets/:id` → R2 object gone
- [ ] `workers/` directory deleted
- [ ] `hono`, `wrangler`, `@cloudflare/workers-types` removed from `package.json`
- [ ] `workers:dev` / `workers:deploy` scripts removed
- [ ] `.gitignore` cleaned of Workers-only entries
- [ ] PR review (P1/P2 fix loop per Sub 0a pattern)

> **NAS deployment verification is Sub 0z** — pulling the merged 0b1 branch onto the NAS, `docker compose up`, hitting endpoints via `loom.<domain>.com` through Cloudflare Tunnel. Not part of 0b1's acceptance.

---

## 7. Risks + mitigations

| Risk | Mitigation |
|---|---|
| testcontainers Docker unavailable on dev machine / CI | Local dev: documented "Docker Desktop must be running". CI: GitHub Actions `ubuntu-latest` ships Docker. Smoke-tested in Task 4 of the plan. |
| Drizzle PG rewrite misses behavior on complex queries (esp. `ingestion.ts` 723 LOC) | Task decomposition is per-module; each module ships with its ported test before moving on |
| `@aws-sdk/client-s3` bundle size affects standalone build | Acceptable on self-host Node (no function size limits); standalone build still <50MB |
| `/api/_/import` ZIP very large (multi-GB) | Self-host has no platform payload cap; only constraint is NAS RAM. Document chunked upload for future; proper fix is Sub 0c (pg-boss chunked import job). |
| DB connection pooling under high concurrency | Single Node process owns the postgres-js pool (`max: 10`); single-user load nowhere near. No PgBouncer needed on self-host. |
| Workers tests use D1 fixtures that don't translate (e.g. `unixepoch()`) | Rewrite the few SQL bits as part of test port; not a separate task |

---

## 8. Estimate

~4d (per architecture-review.md Sub 0b estimate, narrowed since UI is Sub 0b2):
- Day 1: scaffold (`src/server/`, `r2.ts`, `middleware.ts`, `errors.ts`, testcontainers setup)
- Day 2: small route groups (knowledge, mistakes, learning-items, logs, review)
- Day 3: heavy route groups (ingestion, assets, ai/runner, export/import)
- Day 4: Workers cleanup, PR review fix loop, final verification

---

## 9. Out of scope / followups

- **Sub 0z (NAS bootstrap):** `Dockerfile` + `docker-compose.yml` (app + postgres:16-alpine + cloudflared) + remove `.vercel/`, drop Vercel-specific scripts, point `DATABASE_URL` at the NAS PG, document Cloudflare Tunnel setup. Can run in parallel to 0b1 since neither blocks the other.
- **Sub 0b2:** Loom design v1 UI (separate spec)
- **Sub 0c (revised):** pg-boss inline workers + durable LLM pipeline + Tencent QuestionSplitOCR upgrade. Replaces the earlier "Vercel Workflow DevKit" plan with pg-boss running in the same Node process as the API (single-process for single-user load).
- **Sub 1+:** actual product features (capture pipeline, knowledge_link, dreaming, etc.)
