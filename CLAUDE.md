# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

当创建 Subagent 时，应当考虑任务难度自主调度 Opus 与 Sonnet 模型，极少使用 Haiku。

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
```

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

## Deployment

Self-hosted on NAS via `docker-compose.yml` (sub-0z): app container (Next.js standalone build, `Dockerfile`) + Postgres + Cloudflare Tunnel for ingress. Runtime config via `.env` injected at compose level. `DATABASE_URL` points to the compose Postgres in prod / NAS, to `.env.local` for local dev, and to the testcontainer URI inside `pnpm test`. **No Vercel** — drop any `.vercel/`, `vercel env pull`, or Vercel-specific assumptions you carry from other Next.js projects.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Standard triage labels are used. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout with CONTEXT.md and docs/adr/ at repo root. See `docs/agents/domain.md`.
