# Agent development workflow

This is the detailed command and validation reference linked from `AGENTS.md`.
`README.md` remains the source of truth for runtime shape, local setup, NAS
deployment, and the directory map.

## Local processes

```bash
pnpm dev:local        # Postgres + API :8787 + Vite :5173 + worker
pnpm dev              # alias for dev:local
pnpm rw:api           # Hono API
pnpm rw:web           # Vite SPA
pnpm worker:dev       # standalone pg-boss worker
pnpm build            # Vite + server/worker/migrate bundles
```

Development requires the API, web app, and standalone worker. `RW_WORKER=1`
is a fallback and does not replace the standalone worker.

## Local validation commands

```bash
pnpm typecheck
pnpm lint
pnpm vitest run --config vitest.unit.config.ts <test-file>
pnpm vitest run --config vitest.db.config.ts <test-file>
pnpm test:unit:watch <test-file>
pnpm test:db:watch <test-file>
pnpm test:migration
pnpm build
```

Do **not** run the complete `pnpm test` suite on the local machine. Push the
candidate head and let the exact-head GitHub `CI Gate` run the complete suite.
Local verification is intentionally scoped to the changed unit/DB/migration
surface plus typecheck, lint, audits, and build.

Choose the narrowest loop while iterating:

- UI, core, schema, prompt, or parser: `pnpm test:unit:watch <test-file>` plus
  Biome on touched files.
- API, DB, route, or job: `pnpm test:db:watch <test-file>`.
- Migration SQL: `pnpm test:migration`.
- Single unit test:
  `pnpm vitest run --config vitest.unit.config.ts <file> -t '<name>'`.
- Single DB/API test:
  `pnpm vitest run --config vitest.db.config.ts <file> -t '<name>'`.

DB tests use a real Postgres testcontainer and must reset state in `beforeEach`.
Files importing DB clients, `postgres`, Drizzle, or live `PgBoss` belong in the
DB config, not the unit config. DB files run in isolated fork databases. The default
remains `resetDb()` in `beforeEach`; transaction rollback is opt-in only when every
query flows through `testDb()`. Keep full resets for singleton/raw clients, pg-boss,
advisory locks, concurrency, committed cross-connection visibility, and
`RESTART IDENTITY`-sensitive assertions. Never call `resetDb()` inside an active
transaction.

## Audit commands

The complete mechanics and allowlist formats live in the `audits-reference`
skill. Common entry points:

```bash
pnpm audit:agent-control-plane
pnpm audit:schema
pnpm audit:dependencies
pnpm audit:api-contracts
pnpm audit:api-client
pnpm audit:api-client-usage
pnpm audit:capability-boundaries
pnpm audit:provider-lanes
pnpm audit:partition
pnpm audit:profile
pnpm audit:learner-copy
pnpm audit:no-learning-styles
pnpm audit:draft-status
pnpm audit:draft-status-reads
pnpm audit:relations
pnpm audit:calibration
pnpm audit:mastery-provenance
pnpm audit:fold-writes
pnpm audit:flags
pnpm audit:projection
pnpm audit:golden --kind=<kind>
pnpm audit:judge-golden
pnpm audit:judge-prompts
```

`audit:capability-boundaries` 同时检查 public/ui-public access seam 与三张架构债
ratchet（capability→server、server→capability deep、cross-capability value/SCC）。
机器可读报告用 `pnpm audit:capability-boundaries -- --json`；有意删除依赖后用
`pnpm audit:capability-boundaries:snapshot` 打印 canonical baseline，再在同一变更中收紧
`scripts/capability-boundary-baseline.json`。snapshot 命令只打印，不直接覆盖文件；禁止为了让
新增依赖通过而上调 baseline。

Before a PR, run:

First run the scoped tests that match the diff. Then run this local gate:

```bash
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm audit:partition
pnpm audit:api-client
pnpm audit:api-client-usage
pnpm audit:capability-boundaries
pnpm audit:provider-lanes
pnpm audit:profile
pnpm audit:draft-status
pnpm audit:draft-status-reads
pnpm build
```

After push, the exact-head GitHub `CI Gate` runs `pnpm test`, which includes the
agent-control-plane, API-contract, API-client, API-client-usage,
capability-boundary, provider-lane, profile, learner-copy, no-learning-styles,
structured-judge, draft-status, strict draft-status-read, and hub-sync-writer
audits before unit, DB, and migration tests. The explicit local audit commands
remain useful for clear attribution, but they do not replace the GitHub gate.

## Postman

`postman/api-endpoints.json` is the source of truth for the generated
collection. After adding or changing a route, update the spec, run
`pnpm gen:postman`, and optionally run `pnpm api:smoke [folder]`.
