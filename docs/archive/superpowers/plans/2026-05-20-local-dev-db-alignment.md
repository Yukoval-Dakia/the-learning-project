# Local Dev DB Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local host development and UI smoke consistently target the docker-compose Postgres database, not stale `.env.local` external database settings.

**Architecture:** Docker compose remains the source of truth for the real database. Code running inside compose uses `postgres:5432`; code running on the host uses the compose overlay port `127.0.0.1:5433`. Add small script wrappers so `pnpm dev:local`, local migrations, and local smoke all derive the same host-side database URL from `.env` defaults.

**Tech Stack:** Next.js dev server, Node/tsx scripts, Drizzle migrations, docker compose Postgres, existing `INTERNAL_TOKEN` middleware.

---

## Scope

In scope:
- Host-side local dev against docker compose Postgres.
- Host-side local migration wrapper for the compose DB.
- Host-side local smoke wrapper for API routes used by `/today`.
- README and env examples that say Neon/remote DB is not the default local dev path.

Out of scope:
- Changing production/NAS compose deployment.
- Migrating or deleting any remote Neon database.
- Changing middleware auth or token storage.
- Adding seed data.
- Fixing unrelated `.mcp.json` formatting.

## Files

- Create `scripts/local-db-env.ts`
- Create `scripts/dev-local.ts`
- Create `scripts/migrate-local-db.ts`
- Create `scripts/smoke-local.ts`
- Modify `package.json`
- Modify `README.md`
- Modify `.env.example`
- Modify `.env.local.example`

---

### Task 1: Local DB URL Helper

**Files:**
- Create: `scripts/local-db-env.ts`
- Create: `scripts/local-db-env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/local-db-env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildLocalDatabaseUrl, buildLocalDevEnv } from './local-db-env';

describe('local dev DB env', () => {
  it('builds the host-side compose Postgres URL from docker defaults', () => {
    expect(
      buildLocalDatabaseUrl({
        POSTGRES_USER: 'loom',
        POSTGRES_PASSWORD: 'loom',
        POSTGRES_DB: 'loom',
      }),
    ).toBe('postgres://loom:loom@127.0.0.1:5433/loom?sslmode=disable');
  });

  it('supports custom host port without changing compose-internal DATABASE_URL', () => {
    expect(
      buildLocalDatabaseUrl({
        POSTGRES_USER: 'dev user',
        POSTGRES_PASSWORD: 'dev/pass',
        POSTGRES_DB: 'learning db',
        LOCAL_POSTGRES_PORT: '15433',
      }),
    ).toBe(
      'postgres://dev%20user:dev%2Fpass@127.0.0.1:15433/learning%20db?sslmode=disable',
    );
  });

  it('builds Next dev env without reading stale .env.local DATABASE_URL', () => {
    const env = buildLocalDevEnv({
      POSTGRES_USER: 'loom',
      POSTGRES_PASSWORD: 'loom',
      POSTGRES_DB: 'loom',
      LOCAL_NEXT_PORT: '3002',
    });

    expect(env.DATABASE_URL).toBe('postgres://loom:loom@127.0.0.1:5433/loom?sslmode=disable');
    expect(env.NEXT_PUBLIC_BASE_URL).toBe('http://127.0.0.1:3002');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run scripts/local-db-env.test.ts
```

Expected: fail because `scripts/local-db-env.ts` does not exist.

- [ ] **Step 3: Add helper implementation**

Create `scripts/local-db-env.ts`:

```ts
export interface LocalEnvInput {
  POSTGRES_USER?: string;
  POSTGRES_PASSWORD?: string;
  POSTGRES_DB?: string;
  LOCAL_POSTGRES_HOST?: string;
  LOCAL_POSTGRES_PORT?: string;
  LOCAL_NEXT_PORT?: string;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export function buildLocalDatabaseUrl(env: LocalEnvInput = process.env): string {
  const user = env.POSTGRES_USER ?? 'loom';
  const password = env.POSTGRES_PASSWORD ?? 'loom';
  const database = env.POSTGRES_DB ?? 'loom';
  const host = env.LOCAL_POSTGRES_HOST ?? '127.0.0.1';
  const port = env.LOCAL_POSTGRES_PORT ?? '5433';

  return `postgres://${encode(user)}:${encode(password)}@${host}:${port}/${encode(database)}?sslmode=disable`;
}

export function buildLocalDevEnv(env: LocalEnvInput = process.env): {
  DATABASE_URL: string;
  NEXT_PUBLIC_BASE_URL: string;
  LOCAL_NEXT_PORT: string;
} {
  const port = env.LOCAL_NEXT_PORT ?? '3001';

  return {
    DATABASE_URL: buildLocalDatabaseUrl(env),
    NEXT_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    LOCAL_NEXT_PORT: port,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run scripts/local-db-env.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/local-db-env.ts scripts/local-db-env.test.ts
git commit -m "chore(dev): add local compose db env helper"
```

---

### Task 2: Local Dev And Migration Wrappers

**Files:**
- Create: `scripts/dev-local.ts`
- Create: `scripts/migrate-local-db.ts`
- Modify: `package.json`

- [ ] **Step 1: Add `dev-local` wrapper**

Create `scripts/dev-local.ts`:

```ts
import { spawn } from 'node:child_process';
import { config } from 'dotenv';
import { buildLocalDevEnv } from './local-db-env';

config({ path: '.env', override: false });

const localEnv = buildLocalDevEnv(process.env);

const child = spawn(
  'next',
  ['dev', '--hostname', '127.0.0.1', '--port', localEnv.LOCAL_NEXT_PORT],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: localEnv.DATABASE_URL,
      NEXT_PUBLIC_BASE_URL: localEnv.NEXT_PUBLIC_BASE_URL,
    },
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
```

- [ ] **Step 2: Add migration wrapper**

Create `scripts/migrate-local-db.ts`:

```ts
import { spawn } from 'node:child_process';
import { config } from 'dotenv';
import { buildLocalDatabaseUrl } from './local-db-env';

config({ path: '.env', override: false });

const child = spawn('drizzle-kit', ['migrate'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: buildLocalDatabaseUrl(process.env),
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
```

- [ ] **Step 3: Add package scripts**

Modify `package.json` scripts:

```json
{
  "dev:local": "tsx scripts/dev-local.ts",
  "db:migrate:local": "tsx scripts/migrate-local-db.ts"
}
```

Keep existing `dev` and `db:migrate` unchanged for compose/container use.

- [ ] **Step 4: Run helper test and migration wrapper**

Run:

```bash
pnpm vitest run scripts/local-db-env.test.ts
pnpm db:migrate:local
```

Expected:
- test passes
- migration reports no pending migrations when local compose DB is already at `0007`

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/dev-local.ts scripts/migrate-local-db.ts
git commit -m "chore(dev): add local compose db wrappers"
```

---

### Task 3: Local API Smoke Wrapper

**Files:**
- Create: `scripts/smoke-local.ts`
- Modify: `package.json`

- [ ] **Step 1: Add smoke script**

Create `scripts/smoke-local.ts`:

```ts
import { config } from 'dotenv';
import { buildLocalDevEnv } from './local-db-env';

config({ path: '.env', override: false });

const { NEXT_PUBLIC_BASE_URL } = buildLocalDevEnv(process.env);
const token = process.env.INTERNAL_TOKEN;

if (!token) {
  throw new Error('INTERNAL_TOKEN is missing from .env');
}

const endpoints = [
  '/api/health',
  '/api/review/due?limit=1',
  '/api/mistakes?limit=1',
  '/api/knowledge',
] as const;

let failed = false;

for (const endpoint of endpoints) {
  const res = await fetch(`${NEXT_PUBLIC_BASE_URL}${endpoint}`, {
    headers: { 'x-internal-token': token },
  });
  const text = await res.text();
  let shape = 'non-json';

  try {
    const body = JSON.parse(text) as { rows?: unknown[] } & Record<string, unknown>;
    shape = Array.isArray(body.rows) ? `rows:${body.rows.length}` : Object.keys(body).sort().join(',');
  } catch {
    // keep non-json shape
  }

  console.log(`${res.status} ${endpoint} ${shape}`);
  if (!res.ok) failed = true;
}

if (failed) {
  process.exit(1);
}
```

- [ ] **Step 2: Add package script**

Modify `package.json` scripts:

```json
{
  "smoke:local": "tsx scripts/smoke-local.ts"
}
```

- [ ] **Step 3: Verify smoke against running `pnpm dev:local`**

In terminal A:

```bash
pnpm dev:local
```

In terminal B:

```bash
pnpm smoke:local
```

Expected:

```text
200 /api/health db_ok,ok
200 /api/review/due?limit=1 rows:0
200 /api/mistakes?limit=1 rows:0
200 /api/knowledge rows:0
```

The row counts may be any non-negative integer; the success criterion is HTTP 200 plus a `rows:*` shape.

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/smoke-local.ts
git commit -m "chore(dev): add local api smoke"
```

---

### Task 4: Documentation And Env Examples

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `.env.local.example`

- [ ] **Step 1: Update README local development section**

Replace the current development snippet with:

````md
## 开发

Local development uses the docker-compose Postgres database as the source of truth.
Inside compose, services use `postgres:5432`; host-side commands use the local overlay
port `127.0.0.1:5433`.

```bash
pnpm install
docker compose -f docker-compose.yml -f docker-compose.local.yml up postgres -d
pnpm db:migrate:local
pnpm dev:local
```

`pnpm dev` is still available for non-standard environments, but the canonical host-side
path is `pnpm dev:local`. Do not use a stale `.env.local` remote `DATABASE_URL` for UI smoke.

```bash
pnpm smoke:local
```
````

- [ ] **Step 2: Update `.env.example` database comments**

Change database comments to:

```env
# Docker compose runtime DATABASE_URL. This is for app/worker containers.
# Host-side local dev should use `pnpm dev:local`, which derives
# postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@127.0.0.1:5433/<POSTGRES_DB>?sslmode=disable
# from the POSTGRES_* values below.
DATABASE_URL=postgres://loom:loom@postgres:5432/loom?sslmode=disable
```

- [ ] **Step 3: Update `.env.local.example`**

Replace the remote database example with:

```env
# .env.local is optional. Do not put a stale remote DATABASE_URL here for normal local dev.
# Use `.env` + `pnpm dev:local` for host-side development against docker compose Postgres.

# Internal API auth (random shared secret; UI passes via x-internal-token header)
INTERNAL_TOKEN="change-me"

# AI provider keys.
ANTHROPIC_API_KEY=""
XIAOMI_API_KEY=""

# Tencent OCR.
TENCENT_SECRET_ID=""
TENCENT_SECRET_KEY=""
TENCENT_OCR_REGION="ap-guangzhou"

# Cloudflare R2.
R2_ACCOUNT_ID=""
R2_ACCESS_KEY_ID=""
R2_SECRET_ACCESS_KEY=""
R2_BUCKET="learning-project-images"
```

- [ ] **Step 4: Run docs/script checks**

Run:

```bash
pnpm vitest run scripts/local-db-env.test.ts
pnpm exec biome check package.json README.md .env.example .env.local.example scripts/local-db-env.ts scripts/dev-local.ts scripts/migrate-local-db.ts scripts/smoke-local.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example .env.local.example package.json scripts
git commit -m "docs(dev): document compose db local workflow"
```

---

### Task 5: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Verify local compose DB is up**

Run:

```bash
docker compose ps postgres
```

Expected: `the-learning-project-postgres-1` is `Up` and healthy, with `5433:5432` published by the local overlay.

- [ ] **Step 2: Verify migration wrapper**

Run:

```bash
pnpm db:migrate:local
```

Expected: migrations complete without applying remote Neon changes.

- [ ] **Step 3: Verify local API smoke**

In terminal A:

```bash
pnpm dev:local
```

In terminal B:

```bash
pnpm smoke:local
```

Expected: all endpoints return HTTP 200.

- [ ] **Step 4: Verify standard checks**

Run:

```bash
pnpm typecheck
pnpm vitest run scripts/local-db-env.test.ts
```

Expected: pass.

- [ ] **Step 5: Stop point**

Stop after local dev and smoke are deterministic. Do not change production compose, do not touch `.env.local`, and do not migrate any remote database.

---

## Stop Point

Stop when `pnpm dev:local` + `pnpm smoke:local` prove the current working tree talks to docker compose Postgres through `127.0.0.1:5433`, and docs no longer describe Neon/remote DB as the normal dev path.
