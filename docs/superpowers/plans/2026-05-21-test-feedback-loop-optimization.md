# Test Feedback Loop Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the current one-size-fits-all Vitest run into fast unit/invariant feedback and DB-backed integration feedback so daily development does not pay Postgres Testcontainers startup cost for pure tests.

**Architecture:** Keep the existing DB-backed test behavior intact for integration/API tests, but add separate Vitest configs for unit, DB, and migration-smoke runs. `pnpm test` remains the pre-PR full gate, while development uses `test:unit:watch` or targeted `test:db:watch` based on the files being edited.

**Tech Stack:** Vitest 2, pnpm scripts, Drizzle/Postgres, Testcontainers Postgres, Biome, TypeScript.

---

## Current Finding

The current `vitest.config.ts` applies `globalSetup: ['./tests/global-setup.ts']` to every test. `tests/global-setup.ts` starts `postgres:16` through Testcontainers and runs `pnpm db:migrate`. That is correct for DB tests, but too expensive for pure tests.

Tracked tests today:

- Total tracked test files: 134
- Clearly DB-backed test files: about 88
- Fast/no-DB candidates: about 46
- Special case: `tests/integration/migration-smoke.test.ts` starts its own Testcontainer and should not also pay the shared global setup.
- Special case: `src/subjects/math/fixtures/e2e.smoke.test.ts` is DB-backed even though its sibling `index.test.ts` is pure; do not include subject tests with a broad `src/subjects/**/*.test.ts` glob.

The first target is not to make every test fast. It is to make the common edit loop use the 46 no-DB tests without starting Docker.

## Developer Command Model

Use this after the change lands:

```bash
# Pure unit/invariant feedback. No Docker, no DB migration.
pnpm test:unit
pnpm test:unit:watch
pnpm test:unit:watch src/ui/lib/utils.test.ts

# DB/API feedback. Starts one shared Postgres testcontainer per Vitest session.
pnpm test:db
pnpm test:db:watch app/api/review/submit/route.test.ts

# Migration DDL smoke. Own isolated Postgres container, no shared global setup.
pnpm test:migration

# Pre-PR full gate.
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm test
```

## File Structure

- Create `vitest.shared.ts`
  - Owns shared aliases and test partition globs.
  - Prevents config drift between unit, DB, and migration configs.
- Create `vitest.unit.config.ts`
  - No `globalSetup`.
  - Includes only tests that should not require Docker.
- Create `vitest.db.config.ts`
  - Keeps the existing Postgres Testcontainers `globalSetup`.
  - Excludes unit tests and `migration-smoke`.
- Create `vitest.migration.config.ts`
  - Runs only `tests/integration/migration-smoke.test.ts`.
  - No shared `globalSetup`, because that test owns its own container.
- Modify `package.json`
  - Add development and CI scripts.
  - Keep a `test:legacy` escape hatch for the old single-config run during rollout.
- Modify `CLAUDE.md`
  - Document which command to use during development.

## Task 1: Add Shared Vitest Partition Metadata

**Files:**
- Create: `vitest.shared.ts`

- [ ] **Step 1: Create shared config file**

Add this file:

```ts
import path from 'node:path';
import { configDefaults } from 'vitest/config';

export const resolveConfig = {
  alias: { '@': path.resolve(__dirname, 'src') },
};

export const allTestInclude = [
  '*.test.ts',
  'src/**/*.test.ts',
  'app/**/*.test.ts',
  'workers/src/**/*.test.ts',
  'tests/**/*.test.ts',
  'scripts/**/*.test.ts',
];

export const fastTestInclude = [
  'middleware.test.ts',
  'scripts/**/*.test.ts',
  'src/__tests__/**/*.test.ts',
  'src/ai/**/*.test.ts',
  'src/core/**/*.test.ts',
  'src/server/ai/judges/**/*.test.ts',
  'src/server/export/**/*.test.ts',
  'src/server/http/**/*.test.ts',
  'src/server/ingestion/crop.test.ts',
  'src/server/ingestion/figure_attach.test.ts',
  'src/server/ingestion/tencent_mark.test.ts',
  'src/server/ingestion/tencent_mark_parser.test.ts',
  'src/server/ingestion/vision.test.ts',
  'src/server/r2.test.ts',
  'src/server/review/activity-ref.test.ts',
  'src/server/review/fsrs.test.ts',
  'src/server/session/guards.test.ts',
  'src/server/session/index.test.ts',
  'src/subjects/math/fixtures/index.test.ts',
  'src/ui/**/*.test.ts',
  'app/api/ai/*/route.test.ts',
  'app/api/study-log/route.test.ts',
  'tests/core/**/*.test.ts',
  'tests/schema/**/*.test.ts',
  'tests/subjects/**/*.test.ts',
  'tests/integration/judge-gap-audit.test.ts',
  'tests/integration/session-single-owner.test.ts',
  'tests/integration/step12-docs-invariant.test.ts',
  'tests/integration/step9-invariant-audit.test.ts',
];

export const migrationSmokeInclude = ['tests/integration/migration-smoke.test.ts'];

export const sharedExclude = configDefaults.exclude;
```

- [ ] **Step 2: Verify TypeScript parses the file**

Run:

```bash
pnpm typecheck
```

Expected: TypeScript should not report errors from `vitest.shared.ts`.

## Task 2: Add No-DB Unit Vitest Config

**Files:**
- Create: `vitest.unit.config.ts`

- [ ] **Step 1: Create the unit config**

Add this file:

```ts
import { defineConfig } from 'vitest/config';
import { fastTestInclude, resolveConfig, sharedExclude } from './vitest.shared';

export default defineConfig({
  test: {
    include: fastTestInclude,
    exclude: sharedExclude,
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  resolve: resolveConfig,
});
```

- [ ] **Step 2: Prove it does not require Docker**

Run with Docker stopped or unavailable:

```bash
pnpm exec vitest run --config vitest.unit.config.ts src/ui/lib/utils.test.ts --reporter=dot
```

Expected:

- Passes `src/ui/lib/utils.test.ts`.
- Does not print `Could not find a working container runtime strategy`.
- Does not run `drizzle-kit migrate`.

## Task 3: Add DB-Backed Vitest Config

**Files:**
- Create: `vitest.db.config.ts`

- [ ] **Step 1: Create the DB config**

Add this file:

```ts
import { defineConfig } from 'vitest/config';
import {
  allTestInclude,
  fastTestInclude,
  migrationSmokeInclude,
  resolveConfig,
  sharedExclude,
} from './vitest.shared';

const isListCommand = process.argv.includes('list');
if (isListCommand) {
  const dummyUrl = 'postgres://loom:loom@127.0.0.1:5432/loom?sslmode=disable';
  process.env.DATABASE_URL ??= dummyUrl;
  process.env.TEST_DATABASE_URL ??= dummyUrl;
}

export default defineConfig({
  test: {
    include: allTestInclude,
    exclude: [...sharedExclude, ...fastTestInclude, ...migrationSmokeInclude],
    environment: 'node',
    globals: false,
    globalSetup: isListCommand ? [] : ['./tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: resolveConfig,
});
```

- [ ] **Step 2: Verify a known DB route test still runs**

Run:

```bash
pnpm exec vitest run --config vitest.db.config.ts app/api/review/submit/route.test.ts --reporter=dot
```

Expected:

- Starts one Postgres testcontainer.
- Applies migrations through `tests/global-setup.ts`.
- Runs `app/api/review/submit/route.test.ts`.

## Task 4: Add Migration-Smoke-Only Config

**Files:**
- Create: `vitest.migration.config.ts`

- [ ] **Step 1: Create the migration config**

Add this file:

```ts
import { defineConfig } from 'vitest/config';
import { migrationSmokeInclude, resolveConfig, sharedExclude } from './vitest.shared';

export default defineConfig({
  test: {
    include: migrationSmokeInclude,
    exclude: sharedExclude,
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: resolveConfig,
});
```

- [ ] **Step 2: Verify it does not double-start the shared container**

Run:

```bash
pnpm exec vitest run --config vitest.migration.config.ts --reporter=dot
```

Expected:

- Runs only `tests/integration/migration-smoke.test.ts`.
- Does not invoke `tests/global-setup.ts`.
- Starts only the container created inside `migration-smoke.test.ts`.

## Task 5: Add Package Scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Replace the test scripts block**

Change the existing test-related scripts to:

```json
{
  "test": "pnpm test:unit && pnpm test:db && pnpm test:migration",
  "test:legacy": "vitest run",
  "test:unit": "vitest run --config vitest.unit.config.ts",
  "test:unit:watch": "vitest --config vitest.unit.config.ts",
  "test:db": "vitest run --config vitest.db.config.ts",
  "test:db:watch": "vitest --config vitest.db.config.ts",
  "test:migration": "vitest run --config vitest.migration.config.ts"
}
```

Keep the surrounding scripts unchanged.

- [ ] **Step 2: Verify script discovery**

Run:

```bash
pnpm run
```

Expected: output includes `test:unit`, `test:db`, and `test:migration`.

## Task 6: Partition Audit

**Files:**
- No code changes

- [ ] **Step 1: List unit files**

Run:

```bash
pnpm exec vitest list --config vitest.unit.config.ts
```

Expected: includes `src/ui/lib/utils.test.ts`, `src/ai/task-prompts.test.ts`, `tests/schema/event.test.ts`, and does not include `app/api/review/submit/route.test.ts`.

- [ ] **Step 2: List DB files**

Run:

```bash
pnpm exec vitest list --config vitest.db.config.ts
```

Expected: includes `app/api/review/submit/route.test.ts`, `src/server/events/writer.test.ts`, and does not include `src/ui/lib/utils.test.ts` or `tests/integration/migration-smoke.test.ts`.

Note: `vitest.db.config.ts` skips shared global setup only for the `vitest list` command and injects a dummy Postgres URL so DB-importing modules can be collected without Docker. Real `test:db` runs still start the shared Postgres testcontainer.

- [ ] **Step 3: List migration files**

Run:

```bash
pnpm exec vitest list --config vitest.migration.config.ts
```

Expected: includes only `tests/integration/migration-smoke.test.ts`.

## Task 7: Document the Workflow

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the test command guidance**

In the `Commands` section, replace the current single-test guidance with:

```md
pnpm test              # full pre-PR gate: unit + DB + migration-smoke
pnpm test:unit         # fast no-DB tests
pnpm test:unit:watch   # fast watch loop for UI/core/schema/AI parser work
pnpm test:db           # DB/API tests with shared Postgres testcontainer
pnpm test:db:watch     # targeted DB/API watch loop
pnpm test:migration    # migration DDL smoke; owns its own testcontainer
pnpm test:legacy       # old single Vitest config, retained during rollout
```

Then add:

```md
Development loop:
- UI/core/schema/prompt/parser changes: run `pnpm test:unit:watch <test-file>` and touched-file Biome.
- API/DB/route/job changes: run `pnpm test:db:watch <test-file>`.
- Migration SQL changes: run `pnpm test:migration`.
- Before PR: run `pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, and `pnpm test`.

Do not put tests that import `tests/helpers/db`, `@/db/client`, `postgres`, `drizzle`, or live `PgBoss` into the unit config. Route tests may be unit tests only when DB/R2/AI dependencies are mocked before importing the route module.
```

- [ ] **Step 2: Verify docs still mention Docker requirement**

Run:

```bash
rg -n "test:db|testcontainer|Docker" CLAUDE.md
```

Expected: output makes clear that DB tests still need Docker.

## Task 8: Benchmark and Rollout

**Files:**
- No code changes

- [ ] **Step 1: Capture baseline**

Run before applying the config split:

```bash
time pnpm test -- --reporter=dot
```

Expected: records current full-suite duration.

After Task 5 creates `test:legacy`, the same baseline can be rerun as:

```bash
time pnpm test:legacy -- --reporter=dot
```

- [ ] **Step 2: Capture unit timing**

Run:

```bash
time pnpm test:unit -- --reporter=dot
```

Expected: no Docker startup and materially faster than the legacy full run.

- [ ] **Step 3: Capture DB timing**

Run:

```bash
time pnpm test:db -- --reporter=dot
```

Expected: similar DB coverage to the legacy run, minus unit tests and migration-smoke.

- [ ] **Step 4: Capture full timing**

Run:

```bash
time pnpm test
```

Expected: full correctness gate still passes. Full runtime may stay close to the old runtime, but day-to-day feedback should move to `test:unit:*` or targeted `test:db:watch`.

## Later Optimization Options

Do these only after the partition split is stable:

1. Add a guarded `test:db:local` mode that uses a dedicated local database such as `loom_test`, refuses to run unless the database name ends with `_test`, and resets schema before use. This can remove Testcontainers startup from local DB loops, but it is riskier because a bad guard could wipe a developer database.
2. Move pure invariant tests currently under `tests/integration/` into `tests/invariants/` so names match behavior.
3. Add CI jobs that run `test:unit`, `test:db`, and `test:migration` in parallel. This reduces wall-clock CI time without reducing coverage.
4. Add a profiling script after the split:

```json
{
  "test:db:profile": "vitest run --config vitest.db.config.ts --reporter=verbose --slowTestThreshold=1000"
}
```

Use it only when DB tests themselves are slow after container startup is no longer the main issue.

## Success Criteria

- `pnpm test:unit` passes without Docker.
- `pnpm test:db` still applies migrations and catches DB/API regressions.
- `pnpm test:migration` runs migration smoke without double-paying shared global setup.
- `pnpm test` remains the full pre-PR gate.
- `CLAUDE.md` tells agents and humans which command to use for each edit type.
- No test coverage is intentionally dropped; the only change is which config owns each test.
