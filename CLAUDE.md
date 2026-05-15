# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

当创建 Subagent 时，应当考虑任务难度自主调度 Opus 与 Sonnet 模型，极少使用 Haiku。

## Scope Discipline

- Implement EXACTLY what the user asked for; do not expand scope into adjacent frameworks (MCP, Skills, Plugins, full harnesses) unless explicitly requested.
- When tempted to add infrastructure, first ask: "Did the user ask for this?" If unclear, ask before building.

## Stack note (README is stale)

The README still describes the original Phase-1 stack (Vite + React Router + Cloudflare Workers + Hono + D1). That migration is done — see commit `4c324b8 chore(sub-0b1): delete workers/, drop hono/wrangler/@cloudflare/workers-types`. Current stack:

- **Next.js 15 App Router** (`app/`), self-hosted on NAS via Docker (sub-0z) — `next dev` for dev, Next standalone build runs in container for prod
- **Postgres + Drizzle ORM** (`postgresql` dialect, `postgres` driver) — connection from `DATABASE_URL`
- **R2 / S3-compatible blob** via `@aws-sdk/client-s3` (`src/server/r2.ts`)
- **AI SDK v6** (`ai` package) + `@ai-sdk/anthropic` — SDK only; runtime is self-hosted Node, not Vercel Functions
- **React 19, Tailwind v4 (CSS-first), Zustand, TanStack Query, Zod, ts-fsrs**
- **Biome** for lint + format, **Vitest** for tests, **pnpm** package manager

The `workers/` directory still exists on disk but is no longer part of the build; the Hono AI proxy was inlined into Next route handlers. Treat `app/api/**` as the only backend surface.

## Commands

```bash
pnpm dev              # Next dev server
pnpm build            # next build
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm format           # biome format --write .
pnpm test             # vitest run (spins up a Postgres testcontainer)
pnpm test:watch
pnpm db:generate      # drizzle-kit generate (migrations from src/db/schema.ts)
pnpm db:push          # drizzle-kit push (uses DATABASE_URL from .env.local)
pnpm audit:schema     # 检查 schema 字段是否都有 write path（防漂移 lint）
```

`pnpm audit:schema` 扫描 `src/db/schema.ts` 所有业务字段，验证每个都有 INSERT 或 UPDATE write path。例外字段须在 `scripts/audit-schema-allowlist.json` 显式声明（含 reason + resolves_when）。引入新表 / 字段时，要么实现 write path，要么加入 allowlist 并标资源解除条件。详见 `docs/design/2026-05-15-data-assumptions.md`。

Single test: `pnpm vitest run path/to/file.test.ts -t 'name'`.

Tests use a real Postgres via `@testcontainers/postgresql` — Docker must be running. `tests/global-setup.ts` auto-detects OrbStack / Docker Desktop socket on macOS and runs `pnpm db:push --force` against the container before tests. Vitest is configured with `pool: 'forks'` + `singleFork: true` so the container is shared across files; do not parallelise tests in a way that assumes isolated DBs.

## Architecture

### Request flow

All backend logic is in Next App Router route handlers under `app/api/**`:

- `app/api/ai/[task]/route.ts` — streaming + JSON AI endpoint. Dispatches by `task` to handlers in `src/server/ai/` (registry in `src/ai/registry.ts`, runner in `src/server/ai/runner.ts`). Browser code never holds the Anthropic key — all AI calls funnel through here.
- `app/api/assets/*` — multipart upload → R2 + DB row (`src/server/r2.ts`).
- `app/api/ingestion/*` — session create + import pipeline (`src/server/ingestion/`).
- `app/api/_/{export,import,seed,logs}` — admin/dev utilities; round-trip test lives at `app/api/_/_round_trip.test.ts`.
- `app/api/{knowledge,learning-items,mistakes,review}/*` — domain CRUD; FSRS scheduling via `ts-fsrs` in `src/server/review/`.
- `app/api/health` — unauthenticated liveness probe.

### Auth

`middleware.ts` rejects every `/api/*` request that lacks `x-internal-token === process.env.INTERNAL_TOKEN`, except `/api/health`. This is a single-user tool; there is no per-user auth.

### Layering

```
src/
  core/          # Zod schemas, id helpers — cross-subject, no IO
  db/            # Drizzle schema + Postgres client (single schema.ts)
  ai/            # Task registry + browser-side caller (fetches /api/ai/[task])
  server/        # Server-only: ai/, ingestion/, knowledge/, review/, export/, r2.ts, http/
  subjects/
    wenyan/      # Per-subject bundle (Phase 1 dataset: classical Chinese)
  ui/            # Shared React components
app/             # Next App Router pages + api/
docs/            # architecture.md, modules/, design/
```

`core/` is cross-subject; `subjects/<name>/` is single-subject specialisation. Keep that boundary — don't leak subject-specific logic into `core/` or `server/`.

### Design principles (from `docs/architecture.md` and project memory)

- Use mature OSS for solved problems (tool-calling loops, FSRS, AI SDK). Do not hand-roll.
- Don't introduce abstractions until a second concrete instance demands them.
- Evidence-first: AI actions should be traceable and reversible — runs log to `src/server/ai/log.ts`. Preserve this when adding AI features.

## Planning & Architecture Workflow

- For architecture/design discussions, capture decisions in versioned planning docs (e.g., `docs/planning/v0.X.md`) and ADRs (`docs/adr/ADR-NNNN.md`).
- Before reversing a prior recommendation, re-check the user's stated requirements (e.g., Phase 1 scope) rather than re-justifying the new direction from scratch.

## Code Conventions

### File Permissions

- Never hardcode file mode bits (e.g., `0o644`). Always respect umask: use `0o666 & ~umask` for files and `0o777 & ~umask` for directories.

## Deployment

Self-hosted on NAS via `docker-compose.yml` (sub-0z): app container (Next.js standalone build, `Dockerfile`) + Postgres + Cloudflare Tunnel for ingress. Runtime config via `.env` injected at compose level. `DATABASE_URL` points to the compose Postgres in prod / NAS, to `.env.local` for local dev, and to the testcontainer URI inside `pnpm test`. **No Vercel** — drop any `.vercel/`, `vercel env pull`, or Vercel-specific assumptions you carry from other Next.js projects.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Standard triage labels are used. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout with CONTEXT.md and docs/adr/ at repo root. See `docs/agents/domain.md`.

## Known Limitations

### Settings File Edits

- The agent cannot edit its own `settings.json` (self-modification protection). When changes are needed, output the exact diff/JSON for the user to apply manually.
