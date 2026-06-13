# AI 学习工具 (the-learning-project)

自用 AI 学习系统。当前实现是 **Hono API + Vite SPA + pg-boss worker** 三进程的 self-hosted 单用户应用；规划与架构详见 [docs/architecture.md](./docs/architecture.md)、[docs/modules/](./docs/modules/) 与 [docs/superpowers/status.md](./docs/superpowers/status.md)。

> **2026-06-13 形态变更（YUK-321 M5）**：Next.js 全栈已退场。现形状 = Hono API（`server/index.ts`，:8787）+ Vite SPA（`web/`，:5173）+ pg-boss worker（`scripts/worker.ts`，dev 入口 `pnpm worker:dev`、prod 入口 `node dist/worker.cjs`）。后端真相源 = capability manifests（`src/capabilities/*/manifest.ts`）+ 组合根 `server/app.ts`。旧 Next/App Router/middleware.ts/Redis 描述出现在历史 docs/ 里，均不再适用。

## 技术栈

| 层 | 选型 |
| --- | --- |
| API | Hono（组合根 `server/app.ts` 挂载 capability manifests，`@hono/node-server` :8787，`hono/streaming` SSE） |
| Web SPA | Vite + React 19 + TanStack Router + TanStack Query + TypeScript strict（root=`web/`） |
| 样式 | Tailwind v4（CSS-first，`@tailwindcss/vite`） |
| 状态 / 数据 | TanStack Query + Zustand |
| Schema / 校验 | Zod |
| 数据库 | Postgres（`pgvector/pgvector:pg16`）+ Drizzle ORM（`postgresql` dialect, `postgres` driver） |
| Blob 存储 | R2 / S3-compatible storage via `@aws-sdk/client-s3` |
| AI runtime | AI SDK v6 (`ai`) + Claude Agent SDK runner；默认 provider 走 Mimo / 小米（`XIAOMI_API_KEY`，Anthropic-protocol-compat），Anthropic direct（`@ai-sdk/anthropic`）为 fallback |
| 记忆 / 事实层 | Mem0 (`mem0ai`) + pgvector store；embedder 默认 OpenAI `text-embedding-3-small`（ADR-0017） |
| 富文本编辑 | Tiptap（block-tree note 编辑器，slash / cross-link suggestion） |
| 数学渲染 | KaTeX + mathjs + `react-markdown` / `remark-math` / `rehype-katex` |
| 知识图谱 | Cytoscape + `cytoscape-fcose` 布局 |
| OCR / 试题抽取 | 腾讯云 OCR (`tencentcloud-sdk-nodejs-ocr`) + `sharp` 预处理 |
| 在线状态 / 跨进程协调 | PG 表 `editing_presence`（`PgPresenceStore`，YUK-321 M5 gate 选项 b）——双进程拓扑下 app 写、worker 读，无 Redis |
| 后台任务 | pg-boss worker（独立进程；`scripts/worker.ts` dev / `dist/worker.cjs` prod） |
| 复习算法 | `ts-fsrs` |
| Lint / Format | Biome |
| 包管理 | pnpm |

设计原则：用成熟 OSS 解成熟问题；AI 调用按 task 抽象，不做聊天框；破坏性 AI 动作走 proposal + 用户确认。

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

`pnpm dev:local`（= `tsx scripts/dev-local.ts`）spawn **三进程**：

| 进程 | 端口 | 命令 | 角色 |
| --- | --- | --- | --- |
| API | :8787 | `pnpm rw:api`（`tsx watch server/index.ts`，`RW_WORKER=1` 同进程启 pg-boss worker） | Hono 组合根 + in-process worker |
| Web | :5173 | `pnpm rw:web`（`vite --config web/vite.config.ts`） | Vite SPA + `/api` proxy → :8787 |
| Worker | — | `pnpm worker:dev`（`tsx scripts/worker.ts`） | 独立 pg-boss worker 进程 |

dev 拓扑必须 api + web + worker 三进程齐活（YUK-321 M5 双进程拓扑）：`LISTEN loop 不消费 boss job`，dev 也必须有独立 worker 进程；同进程 worker 是 RW_WORKER=1 的兜底，不替代独立 worker。

`pnpm dev` 是 `pnpm dev:local` 的别名。不要使用 stale `.env.local` remote `DATABASE_URL` 做 UI smoke。

```bash
pnpm smoke:local
```

生产 / NAS compose 配置放在 `.env`；host-side local dev 也从 `.env` 的 `POSTGRES_*`
派生本地连接串。浏览器代码不持有 provider key，所有 AI 调用都通过 Hono route 或
pg-boss worker 在服务端执行。

常用检查 / PR 前门禁：

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm test             # 全量门禁：audit:profile + test:unit + test:db + test:migration
pnpm audit:schema     # schema write-path 审计（新表/字段必须有 write path）
pnpm audit:partition  # 测试分区审计（依赖 DB 的测试不得进 unit config）
pnpm build            # rw:web:build + 三 esbuild 产物（dist/server.cjs / dist/worker.cjs / dist/migrate.cjs）
```

快速迭代用 watch 模式：`pnpm test:unit:watch`（无 DB，覆盖 UI / core / schema / parser）、
`pnpm test:db:watch`（DB / API，需 Docker）。

`pnpm test` 的 db / migration 分区用 `@testcontainers/postgresql` 启动真实 Postgres，
运行前需要 Docker Desktop 或 OrbStack。

## Self-host on NAS

### Prerequisites

- NAS with Docker support（绿联 UGOS Pro Docker panel, or any Docker Compose capable host）
- Cloudflare account with a domain you control（仅用于 Cloudflare Tunnel ingress）
- R2 / S3-compatible bucket already provisioned（see `.env.example`）

### One-time setup

1. **Create a Cloudflare Tunnel** in the [Zero Trust dashboard](https://one.dash.cloudflare.com) → Networks → Tunnels.
   - Point the public hostname, for example `loom.<your-domain>`, to `http://app:8787`.
   - Copy the Tunnel Token shown after creation.

2. **Configure environment variables** — copy `.env.example` to `.env` and fill in:
   ```bash
   DATABASE_URL=postgres://loom:loom@postgres:5432/loom?sslmode=disable
   INTERNAL_TOKEN=...
   XIAOMI_API_KEY=...
   ANTHROPIC_API_KEY=...
   OPENAI_API_KEY=...            # Mem0 fact-layer embedder (ADR-0017)
   TUNNEL_TOKEN=<paste-token-here>
   # + R2 / Tencent OCR keys
   # MEM0_* keys are optional — see .env.example for defaults
   ```

   `OPENAI_API_KEY` is required as soon as the worker processes its first
   `memory_event_ingest` job (every `writeEvent` enqueues one, per ADR-0017
   §"Write triggers" #1). The fact layer defaults to Mem0's `openai` embedder
   per ADR-0017 errata 2026-05-27 and the spike findings in
   [docs/superpowers/plans/2026-05-27-t37-mem0-spike-findings.md](docs/superpowers/plans/2026-05-27-t37-mem0-spike-findings.md).
   The `MEM0_*` overrides (embedding model / dims, LLM model, pgvector
   collection + index toggles, Anthropic base URL) all have sensible defaults
   baked into `src/server/memory/client.ts` and only need to be set if you are
   diverging from those.

3. **Database migrations run automatically.** A dedicated `migrate` init container
   (YUK-65) applies the bundled drizzle migrations before `app` / `worker` start on
   every `docker compose up` — idempotent, drizzle's `__drizzle_migrations` table
   tracks applied state. To force a manual re-run against the running stack:
   ```bash
   docker compose run --rm migrate
   ```

### Deploy

```bash
docker compose build
docker compose up -d
```

The compose stack starts `migrate` (one-shot init that applies migrations), `postgres`
(pgvector image), `app` (Hono :8787), `worker`（同镜像，compose `command` override 跑
`node dist/worker.cjs`），and `cloudflared`. The app is reachable through the Cloudflare
Tunnel; port 8787 is bound only inside the compose network，不暴露到 host。

Dockerfile（node:24-slim 多阶段）build 出 4 件产物：`web/dist`（Vite build）+ `dist/server.cjs`
+ `dist/worker.cjs` + `dist/migrate.cjs`。app 容器 `CMD ["node", "dist/server.cjs"]` 并经
`RW_STATIC_DIR=/app/web/dist` 用 `@hono/node-server/serve-static` 托管 SPA；worker 容器同镜像，
compose 层 `command: ["node", "dist/worker.cjs"]` 覆盖。**无 Redis 服务**——editing presence 走
PG 表 `editing_presence`（PgPresenceStore，YUK-321 M5 gate 选项 b）。

### Verify

```bash
curl https://loom.<your-domain>/api/health
# → {"ok":true}
```

### Backup

`db:dump` streams a `pg_dump` from the running `postgres` container to a timestamped SQL file on the host:

```bash
pnpm db:dump
```

To restore:

```bash
pnpm db:restore < /tmp/loom-20260101-000000.sql
```

## 目录

```text
server/           # Hono API 入口（index.ts）+ 组合根工厂（app.ts）+ env 加载
web/              # Vite SPA 工程（root=web/；TanStack Router；@ alias 指 ../src）
src/
  capabilities/   # Capability 包：manifest.ts 声明路由/jobs/copilotTools/ui.pages
    copilot/      # Copilot 域（D14 单人格 + 统一记忆读取面 + copilotTools 贡献制）
    observability/# Observability 域（admin/logs/cost/jobs four GET 面平移）
    ingestion/    # 录入域（assets/ingestion pipeline）
    knowledge/    # 知识图谱域
    notes/        # Note artifact 域（block-tree Tiptap 编辑器）
    practice/     # 练习域（review/quiz/judge/teaching skills）
    agency/       # 代理域（nightly chain + goals）
    shell/        # 工作台域（CopilotDock + admin pages）
    index.ts      # 静态组合根：按顺序聚合所有 capability manifests
  kernel/         # CapabilityManifest 契约 + validateComposition 唯一性循环
  core/           # Zod schemas, id helpers, cross-subject primitives
  db/             # Drizzle schema + Postgres client
  ai/             # Task registry + browser-side caller（不持 provider key）
  server/         # Server-only：AI runner/tools、ingestion、knowledge、memory、review、export、R2、pg-boss helpers
  subjects/
    wenyan/       # Phase 1 subject bundle: classical Chinese
    math/         # Non-wenyan pressure subject: KaTeX + steps judging
    physics/      # Foundation closeout subject: units/dimensions pressure test
  ui/             # Shared React components（block-tree Tiptap 编辑器、KnowledgeGraph cytoscape）
scripts/          # worker.ts（pg-boss 独立进程）+ migrate.ts + dev-local.ts + audits（schema/partition/profile）
postman/          # api-endpoints.json 真相源 + gen:postman manifest 对账层
docs/             # architecture, modules, ADRs, planning
```

`core/` 是跨学科共享层；`subjects/<name>/` 是单学科特化层。`src/capabilities/<name>/manifest.ts`
是后端真相源——新增路由/jobs/tools 都通过 manifest 贡献制登记进组合根 `server/app.ts`。当前已从文言文扩展到 math / physics pressure subjects，新增科目应优先新增 profile 与能力声明，不 fork framework 路径。
