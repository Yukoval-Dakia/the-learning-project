# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

当创建 Subagent 时，应当考虑任务难度自主调度 Opus 与 Sonnet 模型，极少使用 Haiku。

## Scope Discipline

- Implement EXACTLY what the user asked for; do not expand scope into adjacent frameworks (MCP, Skills, Plugins, full harnesses) unless explicitly requested.
- When tempted to add infrastructure, first ask: "Did the user ask for this?" If unclear, ask before building.

## Session Discipline

- **Long-session task tracking**：当前请求涉及 ≥3 个独立步骤、或预期跨多次工具调用时，主动 `ToolSearch` 加载 `TaskCreate/TaskUpdate` 并维护任务列表；不要凭记忆推进多步工作。
- **Environment-sensitive tasks**：涉及外部 SaaS / 本机权限 / 第三方 CLI（Cloudflare、computer-use、waifu2x 之类）时，先跑 30 秒 pre-flight—— `which` / 版本 / token 在不在 env / 本地化应用名是否解析 —— 打印 pass/fail checklist，全 pass 才进主任务。

## Stack note (README is stale)

The README still describes the original Phase-1 stack (Vite + React Router + Cloudflare Workers + Hono + D1). That migration is done — see commit `4c324b8 chore(sub-0b1): delete workers/, drop hono/wrangler/@cloudflare/workers-types`. Current stack:

- **Next.js 15 App Router** (`app/`), self-hosted on NAS via Docker (sub-0z) — `next dev` for dev, Next standalone build runs in container for prod
- **Postgres + Drizzle ORM** (`postgresql` dialect, `postgres` driver) — connection from `DATABASE_URL`
- **R2 / S3-compatible blob** via `@aws-sdk/client-s3` (`src/server/r2.ts`)
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) via xiaomi/mimo Anthropic-compatible endpoint; runtime is self-hosted Node, not Vercel Functions
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
pnpm test             # full pre-PR gate: unit + DB + migration-smoke
pnpm test:unit        # fast no-DB tests
pnpm test:unit:watch  # fast watch loop for UI/core/schema/AI parser work
pnpm test:watch       # alias for pnpm test:unit:watch
pnpm test:db          # DB/API tests with shared Postgres testcontainer
pnpm test:db:watch    # targeted DB/API watch loop
pnpm test:migration   # migration DDL smoke; owns its own testcontainer
pnpm test:legacy      # old single Vitest config, retained during rollout
pnpm db:generate      # drizzle-kit generate (migrations from src/db/schema.ts)
pnpm db:push          # drizzle-kit push (uses DATABASE_URL from .env.local)
pnpm audit:schema     # 检查 schema 字段是否都有 write path（防漂移 lint）
pnpm audit:partition  # 检查 *.test.ts 在 unit/db 分区是否正确（file-level lint）
```

`pnpm audit:schema` 扫描 `src/db/schema.ts` 所有业务字段，验证每个都有 INSERT 或 UPDATE write path。例外字段须在 `scripts/audit-schema-allowlist.json` 显式声明（含 reason + resolves_when）。引入新表 / 字段时，要么实现 write path，要么加入 allowlist 并标资源解除条件。详见 `docs/design/2026-05-15-data-assumptions.md`。

`/audit-drift` skill（`.claude/skills/audit-drift/SKILL.md`）扫描 **ADR / planning-doc ↔ 代码实现**结构性漂移（不重审 schema），输出到 `docs/audit/YYYY-MM-DD-drift.md`，命令式手动触发；不自动开 issue / PR / cron。配套 `pnpm audit:schema` 形成 schema 层 + 决策层双 lint。

**行为变更（2026-05-21）**：`pnpm test:watch` 不再跑全量 + 启 docker，现在是 `pnpm test:unit:watch` 的 alias。如果要 DB watch loop 请用 `pnpm test:db:watch`；如果要旧的单 config 全量行为请用 `pnpm test:legacy`（rollout 期保留的退路）。

Development loop:
- UI/core/schema/prompt/parser changes: run `pnpm test:unit:watch <test-file>` and touched-file Biome.
- API/DB/route/job changes: run `pnpm test:db:watch <test-file>`.
- Migration SQL changes: run `pnpm test:migration`.
- Before PR: run `pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`, and `pnpm test`.

Single test: `pnpm vitest run --config vitest.unit.config.ts path/to/file.test.ts -t 'name'` for no-DB tests, or `pnpm vitest run --config vitest.db.config.ts path/to/file.test.ts -t 'name'` for DB/API tests.

DB tests use a real Postgres via `@testcontainers/postgresql` — Docker must be running. `tests/global-setup.ts` auto-detects OrbStack / Docker Desktop socket on macOS and runs `pnpm db:migrate` against the container before DB tests. Vitest DB config is configured with `pool: 'forks'` + `singleFork: true` so the container is shared across files; do not parallelise DB tests in a way that assumes isolated databases.

Do not put tests that import `tests/helpers/db`, `@/db/client`, `postgres`, `drizzle`, or live `PgBoss` into the unit config. Route tests may be unit tests only when DB/R2/AI dependencies are mocked before importing the route module.

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

- The agent cannot edit `~/.claude/settings.json` (user-level, blocked by self-modification protection). For user-level changes, output the exact diff/JSON for the user to apply manually.
- Project-level `.claude/settings.json` can be edited directly.
