# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

创建 Subagent 时：默认 Opus；fable 为顶档稀缺只用于终裁/最难验证位；Sonnet 只用于轻量机械活；Haiku 基本不用。（owner 2026-07-03 拍板，2026-07-07 成文化）

## Scope Discipline

- Implement EXACTLY what the user asked for; do not expand scope into adjacent frameworks (MCP, Skills, Plugins, full harnesses) unless explicitly requested.
- When tempted to add infrastructure, first ask: "Did the user ask for this?" If unclear, ask before building.
- The MCP/Skills/Plugins/harness prohibition above targets the PRODUCT surface, not the owner's chosen dev/tooling layer — serena, claude-context, superpowers, and OMC are sanctioned tooling and do not violate this rule.

## Session Discipline

- **Long-session task tracking**：当前请求涉及 ≥3 个独立步骤、或预期跨多次工具调用时，主动 `ToolSearch` 加载 `TaskCreate/TaskUpdate` 并维护任务列表；不要凭记忆推进多步工作。
- **Environment-sensitive tasks**：涉及外部 SaaS / 本机权限 / 第三方 CLI（Cloudflare、computer-use、waifu2x 之类）时，先跑 30 秒 pre-flight—— `which` / 版本 / token 在不在 env / 本地化应用名是否解析 —— 打印 pass/fail checklist，全 pass 才进主任务。
- **Cockpit & 全局视角（多线不乱）**：单 session 是线性引擎，全局态活在外部 ledger、不在上下文里——别试图用 session 的脑子当全局视角。**驾驶舱** = `PLAN.md`（repo 根，NOW / NEXT / PARKED / BLOCKED-ON 活看板，手边）+ Linear（权威 projects/issues）+ `.remember/`（跨 session handoff）。
  - **PLAN.md 是看板不是日志**：正文预算 ≤200 行且头部日志区只留最新 1 条【更新】+ `更新于` 戳；超龄【更新】叙事段收尾时滚存进 `.remember/today-*.done.md` 或 `docs/planning/`；四栏对齐 = 就地改写栏目本体（过期条目删改，不得靠追加新段落对冲旧矛盾）。
  - **Session start**：先读 `PLAN.md` + `.remember/now.md`（近况看 `recent.md` / 当日 `today-*.done.md`）+ `MEMORY.md` 重建全局视角，别从零推。
  - **Capture-at-discovery**：任何中途冒出但出当前线的东西（bug / follow-up / 岔路 fork），当场进 `PLAN.md` PARKED 或 Linear，绝不靠记忆「我记着」。
  - **拓扑**：1 个 driver session 持计划 + 只推一条 active 线；广度派 fan-out（workflow / subagent 当 scout，主线只收结论）；并行执行钉 git worktree（每 lane 独立 worktree + branch）；**别开对等多窗抢同一工作树**（冲突/乱的根源）。
  - **保真**：Linear 会腐败（stale In Progress 是常态）；触及的 issue 状态当场对齐代码，周期性 re-excavation 拿 code ground 一遍。
  - **收尾 checklist（结束前必跑）**：① `PLAN.md` 四栏**就地改写**对齐现实 + 滚存超龄日志段 + **commit**（工作树里过夜的看板等于没有看板）；② 所有发现的 follow-up 已落 Linear 或 `PLAN.md`（脑子不留）；③ 触及的 Linear issue 状态对齐代码（无假 In Progress）；④ `.remember` handoff 更新；⑤ 在飞 PR / workflow / worktree 列清状态。

## UI Design Compliance

写任何 UI 代码（新组件 / 改既有组件 / 布局 / 交互）**之前**，先做 design-doc pre-flight，等用户批准后才动手：

1. **逐字引用**相关 design doc 段落 —— 给文件路径 + 章节锚点或行号，不要从上下文推断；找不到就停下问，不要自己编。
2. **声明组件类型**：drawer / route / modal / page / 其它。
3. **列出将要 touch 的文件**：标明创建 vs 修改。

不适用：纯文档 / 纯后端 / 纯 schema / 纯测试 / 已经在批准过的 plan 实现步骤里。Pre-flight 完成后仍需按既有的 design-system tokens / primitives 规则落地，二者叠加生效。

## Stack note

README is the project entrance for current stack + local/NAS setup. Keep it aligned with this note when the runtime stack changes. Current stack (post YUK-321 M5 copilot teardown, 2026-06-13):

- **Hono API**（`server/index.ts` + 组合根 `server/app.ts`，:8787）+ **Vite SPA**（`web/`，TanStack Router + React 19，:5173，dev 经 `/api` proxy → :8787）+ **pg-boss worker** 独立进程（`scripts/worker.ts`，dev `pnpm worker:dev`、prod `node dist/worker.cjs`）三进程；`pnpm dev:local` spawn 三者齐活
- **Postgres + Drizzle ORM**（`postgresql` dialect, `postgres` driver）— connection from `DATABASE_URL`；editing presence 走 PG 表 `editing_presence`（PgPresenceStore，YUK-321 M5 gate 选项 b），**无 Redis**
- **R2 / S3-compatible blob** via `@aws-sdk/client-s3`（`src/server/r2.ts`）
- **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`）via xiaomi/mimo Anthropic-compatible endpoint；runtime is self-hosted Node（CMD `node dist/server.cjs`），not Vercel Functions
- **Switchable AI provider lane (YUK-365)**：默认走 mimo-v2.5（xiaomi key-auth）；`AI_PROVIDER_OVERRIDE=anthropic-sub` 可切到 Opus 4.8 via owner's Claude Max OAuth 订阅。Token 传递、双-provider 分支、生产 SDK 版本前置等完整机制见 `src/server/ai/AGENTS.md`。Wiring 在 `src/server/ai/providers.ts` + `runner.ts`。
- **React 19, Tailwind v4 (CSS-first), Zustand, TanStack Query + Router, Zod, ts-fsrs**
- **pg-boss** worker (`scripts/worker.ts`) for durable background jobs
- **Biome** for lint + format, **Vitest** for tests, **pnpm** package manager
- **esbuild** bundles `dist/server.cjs` / `dist/worker.cjs` / `dist/migrate.cjs`；`pnpm build` = `rw:web:build` + 三 esbuild 产物

Historical docs and audits may still describe the **Next.js 15 App Router** shape（`app/`, `next dev`, `next build`, `:3000`, `middleware.ts`, `Redis/ioredis` editing presence, `Vite/Workers/Hono/D1` 旧栈）. Treat those as historical unless a current doc or code path says otherwise. Treat **capability manifests（`src/capabilities/*/manifest.ts`）+ 组合根 `server/app.ts`** as the backend surface — every route/job/copilotTool 经 manifest 贡献制登记进组合根，不再有 `app/api/**` route handler 壳。

## Commands

```bash
pnpm dev:local        # 推荐本地入口（compose Postgres :5433 为真相源；scripts/dev-local.ts 注入 DATABASE_URL + spawn api+web+worker 三进程）
pnpm dev              # alias for pnpm dev:local
pnpm rw:api           # tsx watch server/index.ts（RW_WORKER=1 同进程启 pg-boss worker）
pnpm rw:web           # vite --config web/vite.config.ts（dev SPA + /api proxy → :8787）
pnpm worker:dev       # tsx scripts/worker.ts（独立 pg-boss worker 进程）
pnpm build            # rw:web:build + 三 esbuild 产物（dist/server.cjs / dist/worker.cjs / dist/migrate.cjs）
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm format           # biome format --write .
pnpm test             # full pre-PR gate: profile audit + unit + DB + migration-smoke
pnpm test:unit        # fast no-DB tests
pnpm test:unit:watch  # fast watch loop for UI/core/schema/AI parser work
pnpm test:watch       # alias for pnpm test:unit:watch
pnpm test:db          # DB/API tests with shared Postgres testcontainer
pnpm test:db:watch    # targeted DB/API watch loop
pnpm test:migration   # migration DDL smoke; owns its own testcontainer
pnpm db:generate      # drizzle-kit generate (migrations from src/db/schema.ts)
pnpm db:push          # drizzle-kit push (uses DATABASE_URL from .env)
pnpm audit:schema     # 检查 schema 字段是否都有 write path（防漂移 lint）
pnpm audit:partition  # 检查 *.test.ts 在 unit/db 分区是否正确（file-level lint）
pnpm audit:profile    # 检查所有 SubjectProfile 是否通过 schema + capability registry 验证
pnpm audit:draft-status # 检查每个 question INSERT 都显式 set draft_status 或在 allowlist（防容器题漏进练习池）
pnpm audit:relations  # KG 死边反向审计：每个 relation_type 是否有特化下游消费（诊断/推荐/复习），report-only
pnpm audit:calibration # READ-ONLY V-A1-fwd retro-validation of live A1 SRT（forward-AUC θ̂ replay），report-only，永不翻 flag
pnpm audit:mastery-provenance # 借用 provenance 消费纪律反查（MasteryProjection 读点 guard 检查），report-only，--strict 才非零 exit
```

Each `pnpm audit:*` script has its own allowlist format, CI-gate wiring, and (for `audit:draft-status`) a NULL-semantics gotcha — see the `audits-reference` skill for full mechanics before adding a new table/field/question-insert site or touching the allowlist JSONs. Quick pointer: `audit:schema`/`audit:draft-status` allowlists need `reason` + `resolves_when{kind,ref,expected_by}`; `audit:schema`/`audit:partition` are CI-gated remotely (`.github/workflows/ci-gate.yml`) and need a local manual run pre-PR; `pnpm test` covers `audit:profile`/`audit:draft-status`/`audit:draft-status-reads --strict` + unit/db/migration.

`/audit-drift` skill (`.claude/skills/audit-drift/SKILL.md`) scans ADR/planning-doc ↔ code drift, manual-trigger only — see the skill for details.

**Behavior change (2026-05-21)**: `pnpm test:watch` is now an alias for `pnpm test:unit:watch` (no longer full+docker). For a DB watch loop use `pnpm test:db:watch`.

Development loop:
- UI/core/schema/prompt/parser changes: run `pnpm test:unit:watch <test-file>` and touched-file Biome.
- API/DB/route/job changes: run `pnpm test:db:watch <test-file>`.
- Migration SQL changes: run `pnpm test:migration`.
- Before PR: run `pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`, `pnpm audit:profile`, `pnpm audit:draft-status`, `pnpm audit:draft-status-reads`, `pnpm test`, and `pnpm build`. `pnpm build` 经 esbuild 全量 bundle（server/worker/migrate 三 .cjs）+ Vite build，catch tsc/biome/vitest 都漏的 bundle 期错误（per YUK-67）。

Single test: `pnpm vitest run --config vitest.unit.config.ts path/to/file.test.ts -t 'name'` for no-DB tests, or `pnpm vitest run --config vitest.db.config.ts path/to/file.test.ts -t 'name'` for DB/API tests.

### Postman / API exploration

`postman/` mirrors the Hono API surface for manual exploration (`pnpm api:smoke [folder]` runs it headless via Newman). The collection is generated from `postman/api-endpoints.json`, not hand-edited — when you add/change a route, edit that spec and run `pnpm gen:postman`. See the `postman-api` skill for the full workflow (manifest reconciliation, spec shape) or `postman/README.md`.

DB tests use a real Postgres via `@testcontainers/postgresql` — Docker must be running. `tests/global-setup.ts` auto-detects OrbStack / Docker Desktop socket on macOS, runs `pnpm db:migrate` against the container once, then clones the migrated database into one `test_fork_<N>` database per configured worker via `CREATE DATABASE … TEMPLATE` (YUK-252). Vitest DB config runs `pool: 'forks'` with `maxWorkers` sourced from `tests/db-fork-constants.ts`; `tests/setup.db-fork.ts` (a `setupFiles` entry) rewrites `DATABASE_URL`/`TEST_DATABASE_URL` per worker to `test_fork_<VITEST_POOL_ID>`, so each fork gets its own cloned database and files run in parallel. Within a single fork, files still share one database and run sequentially — the hermetic contract is unchanged: every DB test must reset state in `beforeEach` (`resetDb()`) and must not assume cross-file state or execution order. To change DB test parallelism or the fork database prefix, update `tests/db-fork-constants.ts`.

Do not put tests that import `tests/helpers/db`, `@/db/client`, `postgres`, `drizzle`, or live `PgBoss` into the unit config. Route tests may be unit tests only when DB/R2/AI dependencies are mocked before importing the route module.

## Architecture

### Request flow

后端逻辑全在 Hono route handlers 里，经 capability manifests 贡献制登记进组合根 `server/app.ts`（`buildHonoApp(capabilities)` 循环挂载 `cap.api.routes`，`[id]` → `:id` 转换由 `toHonoPath` 完成）：

- `src/capabilities/copilot/manifest.ts` — Copilot chat（SSE 4 路由，AF S4）+ D14 单人格编排者 + `copilotTools` 工具贡献制（启动期 `registerCapabilityCopilotTools` 聚合到 DomainTool registry）
- `src/capabilities/observability/manifest.ts` — admin 四面（logs cost/jobs/jobs-by-id/tool_calls）+ subjects + today cost ribbon
- `src/capabilities/ingestion/manifest.ts` — assets multipart upload → R2 + DB row + ingestion pipeline（`src/server/ingestion/`，`src/server/r2.ts`）
- `src/capabilities/{knowledge,notes,practice,agency,shell}/manifest.ts` — domain CRUD + AI tasks；FSRS scheduling via `ts-fsrs` in `src/server/review/`
- `server/app.ts` 直挂 `/api/health`（unauthenticated liveness probe）

组合根侧 `/api/*` token 校验也由 `server/app.ts` 注册的 `app.use('/api/*', ...)` 中间件完成（豁免 `/api/health`）。Browser code never holds the Anthropic key — all AI calls funnel through Hono route 或 pg-boss worker。

### Auth

`server/app.ts` 的 `/api/*` 中间件 reject every request that lacks `x-internal-token === process.env.INTERNAL_TOKEN`，except `/api/health`（直挂免校验）。This is a single-user tool; there is no per-user auth.（旧的 `middleware.ts` Next.js 中间件已随 YUK-321 M5 退场——auth 逻辑现在在 Hono 组合根内。）

### Layering

```
server/            # Hono API 入口（index.ts）+ 组合根工厂（app.ts）+ env 加载
web/               # Vite SPA 工程（root=web/；TanStack Router；@ alias 指 ../src）
src/
  capabilities/    # Capability 包：manifest.ts 声明路由/jobs/copilotTools/ui.pages
    copilot/       # Copilot 域（D14 + copilotTools 贡献制）
    observability/ # Observability 域
    ingestion/     # 录入域
    knowledge/     # 知识图谱域
    notes/         # Note artifact 域
    practice/      # 练习域
    agency/        # 代理域
    shell/         # 工作台域
    index.ts       # 静态组合根：按顺序聚合所有 capability manifests
  kernel/          # CapabilityManifest 契约 + validateComposition 唯一性循环
  core/            # Zod schemas, id helpers — cross-subject, no IO
  db/              # Drizzle schema + Postgres client (single schema.ts)
  ai/              # Task registry + browser-side caller
  server/          # Server-only: ai/, ingestion/, knowledge/, review/, export/, r2.ts, http/
  subjects/
    wenyan/        # Per-subject bundle (Phase 1 dataset: classical Chinese)
  ui/              # Shared React components
scripts/           # worker.ts（pg-boss 独立进程）+ migrate.ts + dev-local.ts + audits
docs/              # architecture.md, modules/, design/
```

`core/` is cross-subject; `subjects/<name>/` is single-subject specialisation. Keep that boundary — don't leak subject-specific logic into `core/` or `server/`. Capability 包（`src/capabilities/<name>/`）是新增路由/jobs/tools 的唯一登记面——manifest 贡献制进组合根，不再有 Next.js 壳文件仪式。

### Design principles (from `docs/architecture.md` and project memory)

- Evidence-first: AI actions should be traceable and reversible — runs log to `src/server/ai/log.ts`. Preserve this when adding AI features.

## Planning & Architecture Workflow

- For architecture/design discussions, capture decisions in versioned planning docs (e.g., `docs/planning/v0.X.md`) and ADRs (`docs/adr/ADR-NNNN.md`).
- Before reversing a prior recommendation, re-check the user's stated requirements (e.g., Phase 1 scope) rather than re-justifying the new direction from scratch.

## Code Conventions

### File Permissions

- Never hardcode file mode bits (e.g., `0o644`). Always respect umask: use `0o666 & ~umask` for files and `0o777 & ~umask` for directories.

## Deployment

Self-hosted on NAS via `docker-compose.yml` (sub-0z): app container（`node:24-slim` 多阶段 `Dockerfile`，CMD `node dist/server.cjs`，:8787）+ worker container（同镜像，compose `command: ["node", "dist/worker.cjs"]` override）+ migrate init container（`node dist/migrate.cjs`）+ Postgres（pgvector）+ Cloudflare Tunnel for ingress. **无 Redis 服务**——editing presence 走 PG 表 `editing_presence`（PgPresenceStore，YUK-321 M5 gate 选项 b）。Runtime config via `.env` injected at compose level. `DATABASE_URL` points to the compose Postgres in prod / NAS, to `.env.local` for local dev, and to the testcontainer URI inside `pnpm test`. **No Vercel** — drop any `.vercel/`, `vercel env pull`, or Vercel-specific assumptions you carry from other Next.js projects（旧栈 Next.js 已于 YUK-321 M5 退场）.

## Agent skills

### Issue tracker

Issues are tracked in Linear (`Yukoval Studios` / `YUK`). GitHub Issues are historical only; do not create new planning / triage / roadmap work with `gh issue create`. See `docs/agents/issue-tracker.md`.

For linked work, include `YUK-XX` in PR titles, PR descriptions, and commit messages; prefer Linear's branch name format `yuk-xx-...`; do not use bare `#N` for new work. When one commit/PR references multiple issues, repeat the Linear keyword for each issue (`Closes YUK-27` + `Closes YUK-28`), never shorthand like `Closes YUK-27 + YUK-28`.

Before the final response for any implementation, audit, planning, or migration task, run the Linear issue capture gate:
- create or update Linear issues for actionable follow-ups discovered in the current work, after searching for duplicates;
- or explicitly state that no Linear issue is needed and why.

Do not leave verified follow-ups only in the final prose, local TODOs, or scratch docs.

### Triage labels

Standard triage labels are used. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout with CONTEXT.md and docs/adr/ at repo root. See `docs/agents/domain.md`.

### Codebase search (serena + claude-context)

2026-06-06 起由两个 user-level MCP（`~/.claude.json` 顶层 `mcpServers`）承担，SessionStart hook (`.claude/hooks/code-search-preload.sh`) 注入分工提示：

- **符号精确侧 → serena**：`find_symbol`（按名定位）、`find_referencing_symbols`（列举全部引用，带 snippet）、`get_symbols_overview`（文件结构）。已知符号名 / 列举引用 / 理解文件结构时优先于 grep。首次使用先调 `mcp__serena__initial_instructions`；返回行号是 0-based。
- **语义召回侧 → claude-context**：`mcp__claude-context__search_code` 自然语言跨文件检索（VoyageAI voyage-code-3 + Zilliz Milvus）。「不知道在哪 / 某 feature 整体在哪实现 / grep 找不到的二次验证」时用。
- **已知坑**：`get_indexing_status` 会在索引仍在写入时提前报「completed」——此时检索静默返回无关结果。结果明显偏靶时，查 `~/.context/mcp-codebase-snapshot.json` 的 `totalChunks`（本仓库健康值 ~13k；若 ≈ 文件数说明切块没完成）再重试。
- grep 仍用于字面字符串枚举；grep 找不到不要断言「不存在」，先 claude-context 二次验证（SQL / migration / view 只有语义检索能命中）。工具默认 deferred，先 ToolSearch 加载 schema。

## Known Limitations

### Settings File Edits

- The agent cannot edit `~/.claude/settings.json` (user-level, blocked by self-modification protection). For user-level changes, output the exact diff/JSON for the user to apply manually.
- Project-level `.claude/settings.json` can be edited directly.

## MCP / Tooling

- MCP servers are snapshotted at session start; configuration changes (adding/swapping/renaming servers) require a session restart before they take effect. Do not attempt to test a newly-added or hot-swapped MCP server in the same session.

## Product / Design Principles

- Pre-AI features (e.g. question banks, quizzes, flows) are load-bearing, first-class parts of the AI-native architecture — not legacy holdovers. Do NOT propose deleting or removing ANY pre-AI feature or deterministic path when designing AI-native improvements; "delete" means "demote from sole source," never remove. Owner-instructed deletions (explicit, e.g. D6/D11-style locked decisions) are the only exception.

## Engineering Approach

- Default to the smallest sufficient solution, and never build unrequested infrastructure or a net-new subsystem lacking a live consumer (the project failure mode 建成不通电). BUT distinguish two cases: (1) clear scope-creep / unrequested infra → cut it, do not ask; (2) a genuine bias-variance or product-judgment fork (e.g. LIGHT vs FULL variant) → present both, mark the recommendation, and let the owner decide — do NOT unilaterally foreclose the fuller option (per `docs/design/2026-07-03-softmax-spec.md` §3, where the anti-over-engineering protocol was explicitly withdrawn in favor of dual LIGHT+FULL presentation with owner as decider). The concrete example (a single vision LLM before multi-step pipelines) still holds for case (1).

## Code Review Workflow

- When spawning review subagents, ensure each agent has Bash access (or dump the diff to disk and feed it) so it can fetch the PR diff.
- After addressing review findings on a PR, **resolve the corresponding review threads** (CodeRabbit / OCR github-actions / codex / Cursor bots), after the fix is committed + pushed. See the `pr` skill for the exact GitHub API mechanics (thread IDs, resolve/reply calls). Resolving threads is cleanup only — it never authorizes a merge by itself. **Merge policy（owner 2026-07-07 拍板成文，取代旧句 "PRs are owner-merged, never auto-merged"）**：全量 pre-PR gate + 独立 review + CI 全绿后，PR 可自主 merge 并按 2026-07-03 部署授权自主部署；owner 可随时点名要求任一 PR 人工合。

## Shell / Environment

- For millisecond timestamps use python (not `date %3N`), since macOS `date` does not support that flag.
