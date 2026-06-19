# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

当创建 Subagent 时，应当考虑任务难度自主调度 Opus 与 Sonnet 模型，极少使用 Haiku。

## Scope Discipline

- Implement EXACTLY what the user asked for; do not expand scope into adjacent frameworks (MCP, Skills, Plugins, full harnesses) unless explicitly requested.
- When tempted to add infrastructure, first ask: "Did the user ask for this?" If unclear, ask before building.

## Session Discipline

- **Long-session task tracking**：当前请求涉及 ≥3 个独立步骤、或预期跨多次工具调用时，主动 `ToolSearch` 加载 `TaskCreate/TaskUpdate` 并维护任务列表；不要凭记忆推进多步工作。
- **Environment-sensitive tasks**：涉及外部 SaaS / 本机权限 / 第三方 CLI（Cloudflare、computer-use、waifu2x 之类）时，先跑 30 秒 pre-flight—— `which` / 版本 / token 在不在 env / 本地化应用名是否解析 —— 打印 pass/fail checklist，全 pass 才进主任务。
- **Cockpit & 全局视角（多线不乱）**：单 session 是线性引擎，全局态活在外部 ledger、不在上下文里——别试图用 session 的脑子当全局视角。**驾驶舱** = `PLAN.md`（repo 根，NOW / NEXT / PARKED / BLOCKED-ON 活看板，手边）+ Linear（权威 projects/issues）+ `.remember/`（跨 session handoff）。
  - **Session start**：先读 `PLAN.md` + `.remember/remember.md` + `MEMORY.md` 重建全局视角，别从零推。
  - **Capture-at-discovery**：任何中途冒出但出当前线的东西（bug / follow-up / 岔路 fork），当场进 `PLAN.md` PARKED 或 Linear，绝不靠记忆「我记着」。
  - **拓扑**：1 个 driver session 持计划 + 只推一条 active 线；广度派 fan-out（workflow / subagent 当 scout，主线只收结论）；并行执行钉 git worktree（每 lane 独立 worktree + branch）；**别开对等多窗抢同一工作树**（冲突/乱的根源）。
  - **保真**：Linear 会腐败（stale In Progress 是常态）；触及的 issue 状态当场对齐代码，周期性 re-excavation 拿 code ground 一遍。
  - **收尾 checklist（结束前必跑）**：① `PLAN.md` 四栏对齐现实；② 所有发现的 follow-up 已落 Linear 或 `PLAN.md`（脑子不留）；③ 触及的 Linear issue 状态对齐代码（无假 In Progress）；④ `.remember` handoff 更新；⑤ 在飞 PR / workflow / worktree 列清状态。

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
- **Switchable AI provider lane (YUK-365)**：默认走 mimo-v2.5（xiaomi key-auth）。设 `AI_PROVIDER_OVERRIDE=anthropic-sub` 全局切到 **Opus 4.8 via owner's Claude Max 订阅（OAuth）** —— token 是 `claude setup-token` 生成的长效 `CLAUDE_CODE_OAUTH_TOKEN`，**绝不入库不打印**。**Token + `AI_PROVIDER_OVERRIDE` 必须对三进程都可见**：大多数 AI 任务跑在 BACKGROUND pg-boss worker（`scripts/worker.ts`）里，所以放 `.env.local` 时三进程（Hono API / Vite / worker）各自在启动期跑 `loadEnv()`（`server/env`）读它——API 走 `server/index.ts`、worker 走 `scripts/worker.ts`（YUK-365 Finding 2 补：worker 此前不读 `.env.local`，背景 job 会回落 mimo），`dev:local` 也把 `.env.local` 透传给三 child。**生产/NAS**：token 经 docker-compose `.env` 同时注入 app + worker 两容器（`loadEnv` 只填空位，容器 env 永远赢）。订阅 token 与 mimo 互斥：oauth lane 在 SDK 子进程 env 里 SET `CLAUDE_CODE_OAUTH_TOKEN`、UNSET `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` + 四个 cloud-provider selector（`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_ANTHROPIC_AWS`/`_FOUNDRY`，它们的优先级高于 OAuth token——YUK-365 Finding 1）（first-party endpoint only）。可选 `AI_PROVIDER_MODEL` 覆盖模型 id（lane 默认 `claude-opus-4-8`）；切到非 mimo 的其它 provider（如 `anthropic` 直连）若不设 `AI_PROVIDER_MODEL` 会 throw 明确 config 错（registry 默认 model 是 mimo id，非 mimo endpoint 不收——YUK-365 Finding 4）。**生产 SDK 版本前置**：`Dockerfile` 的 `sdkdeps` stage 必须装 `@anthropic-ai/claude-agent-sdk` 与 lockfile 同版（当前 0.3.168）才支持 `claude-opus-4-8`；旧版（如 0.3.143）CLI 会拒该 model id（YUK-365 Finding 3）。Wiring 在 `src/server/ai/providers.ts`（`authMode: 'key' | 'oauth'` 判别式 + `AI_PROVIDER_OVERRIDE` 开关）+ `runner.ts`（`buildAgentEnv` 按 authMode 分支）。
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
```

`pnpm audit:schema` 扫描 `src/db/schema.ts` 所有业务字段，验证每个都有 INSERT 或 UPDATE write path。例外字段须在 `scripts/audit-schema-allowlist.json` 显式声明 `reason` + `resolves_when`，其中 `resolves_when` 必须是 `{ "kind": "pr" | "phase" | "manual", "ref": string, "expected_by": "YYYY-MM-DD" }`。`kind: "pr"` 的 `ref` 写 GitHub PR 号或 `#N`，若本地 git history 已包含该 PR 会 fail；`kind: "phase"` 的 `ref` 要能匹配 `docs/superpowers/status.md` 的已 ship 行；`kind: "manual"` 只用于无法机器判定的历史解除条件，仍受 `expected_by` 到期约束。引入新表 / 字段时，要么实现 write path，要么加入 allowlist 并标注可检查的解除条件。详见 `docs/design/2026-05-15-data-assumptions.md`。

`pnpm audit:profile` 调用 `scripts/audit-profile.ts`，遍历 `subjectProfiles` 并复用 `validateProfile()` 检查 `SubjectProfileSchema`、`causeCategories` 唯一性、`judgeCapabilities` 是否已在默认 capability registry 注册，以及 registry-backed preferred route 是否已声明。新增或修改 subject profile 后必须先跑 `pnpm audit:profile`；坏 profile 也会在 `SubjectRegistry.register()` 启动期直接抛错。

`pnpm audit:draft-status`（YUK-350）调用 `scripts/audit-draft-status.ts`，扫所有 `.insert(question).values({ ... })` 站点（brace-balanced 抽对象块，跳字符串/模板/注释，word-boundary 排除 `question_block`/`question_part`），要求每个站点要么显式携带 `draft_status` key，要么在 `scripts/audit-draft-status-allowlist.json` 声明 `reason` + `resolves_when{kind,ref,expected_by}`。`question.draft_status` 是 NULL≡active 的三态字段——漏 set 的新 question 会被 review 池当 active 收，容器内专用题（embedded check / teaching check）会静默漏进通用练习池。NULL≡active 是合法语义的 writer（auto-enroll / import / 错题 / 卷题）放 allowlist；allowlisted-AND-explicit 文件静默通过（不 hard-fail）。新增 question INSERT 时要么显式 set draft_status，要么加 allowlist 并标注解除条件。**它已接入 `pnpm test` 链（在 `audit:profile` 之后），所以容器题漏进池的失效模式由自动 gate 强制——不像 `audit:schema`/`audit:partition` 只在 pre-PR 散文清单里靠人工记得跑。**详见 `docs/design/2026-05-15-data-assumptions.md`。

`pnpm audit:relations`（YUK-357 / RT4）调用 `scripts/audit-relations.ts`，做 **KG 死边反向审计**（gap-analysis 决策 7 / gate doc §1.7 7c，源自 GPT §10.1「只保留能影响诊断/推荐/复习的关系」）。对每个核心 `knowledge_edge.relation_type`（prerequisite / related_to / contrasts_with / applied_in / derived_from）反查下游消费路径，按三层分级——`creation-validation`（提议时校验，不算下游学习消费）/ `generic-read`（copilot 一把灌所有 type，最弱信号）/ `specialized`（诊断/推荐/复习按具体 type 驱动行为）。**「死边」= 某 type 零 specialized 消费**（图在转但不影响学习）。消费矩阵是手维护的声明式 `CONSUMER_REGISTRY`，每条带 `file:marker` 证据；脚本对每条做**源码反查**，marker 不再命中即报 STALE（registry↔代码漂移）。**默认 report-only（exit 0），`--strict` 才非零 exit**（gate doc §1.7 标「→ Linear follow-up」非硬 gate；升级为 CI gate 是 owner 决策）。当前实测唯一死边 = `applied_in`（hub-mesh 显式排除、topology-gate 仅 prerequisite、paths 反向邻接仅 related_to/contrasts_with）。新增「按 relation_type 分支」的消费路径时须在 registry 补一条。

`/audit-drift` skill（`.claude/skills/audit-drift/SKILL.md`）扫描 **ADR / planning-doc ↔ 代码实现**结构性漂移（不重审 schema），输出到 `docs/audit/YYYY-MM-DD-drift.md`，命令式手动触发；不自动开 issue / PR / cron。配套 `pnpm audit:schema` 形成 schema 层 + 决策层双 lint。

**行为变更（2026-05-21）**：`pnpm test:watch` 不再跑全量 + 启 docker，现在是 `pnpm test:unit:watch` 的 alias。如果要 DB watch loop 请用 `pnpm test:db:watch`。（旧的 `pnpm test:legacy` 单 config 退路已在 YUK-321 M5 删除。）

Development loop:
- UI/core/schema/prompt/parser changes: run `pnpm test:unit:watch <test-file>` and touched-file Biome.
- API/DB/route/job changes: run `pnpm test:db:watch <test-file>`.
- Migration SQL changes: run `pnpm test:migration`.
- Before PR: run `pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`, `pnpm audit:profile`, `pnpm audit:draft-status`, `pnpm test`, and `pnpm build`. `pnpm build` 经 esbuild 全量 bundle（server/worker/migrate 三 .cjs）+ Vite build，catch tsc/biome/vitest 都漏的 bundle 期错误（per YUK-67）。

Single test: `pnpm vitest run --config vitest.unit.config.ts path/to/file.test.ts -t 'name'` for no-DB tests, or `pnpm vitest run --config vitest.db.config.ts path/to/file.test.ts -t 'name'` for DB/API tests.

### Postman / API exploration

`postman/` holds a Postman collection mirroring the Hono API surface（capability manifests → `server/app.ts` mounted routes）plus a secret-free environment. It is the manual-exploration layer; Vitest route tests remain the regression gate. Run headless via `pnpm api:smoke [folder]` (Newman through `pnpm dlx`, token injected from `.env` — no committed dep, no committed secret). The collection is **generated**, not hand-edited: `postman/api-endpoints.json` is the source of truth. **When you add or change a route（method, path, request body, or query params），edit `postman/api-endpoints.json` and run `pnpm gen:postman`**（idempotent; Biome-formats the output）. `scripts/gen-postman.ts` now has a **manifest 对账层**：每个 spec 条目必须存在于组合根路由清单（capabilities manifests + `/api/health`），死条目 throw——剪 spec 时跑一遍兜底。See `postman/README.md` for the spec shape.

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

- Do NOT propose deleting or removing pre-AI features (question banks, quizzes, flows) when designing AI-native improvements; treat them as legacy-compatible and additive unless explicitly told otherwise. "Delete" usually means "demote from sole source," not remove.

## Engineering Approach

- Prefer the smallest sufficient solution: confirm the simplest approach (e.g., a single vision LLM) before proposing multi-step pipelines or broad refactors.

## Code Review Workflow

- When spawning review subagents, ensure each agent has Bash access (or dump the diff to disk and feed it) so it can fetch the PR diff.

## Shell / Environment

- For millisecond timestamps use python (not `date %3N`), since macOS `date` does not support that flag.
