# AI 学习工具 (the-learning-project)

自用 AI 学习系统。当前实现是 Next.js + Postgres + pg-boss 的 self-hosted 单用户应用；规划与架构详见 [docs/architecture.md](./docs/architecture.md)、[docs/modules/](./docs/modules/) 与 [docs/superpowers/status.md](./docs/superpowers/status.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| Web app | Next.js 15 App Router + React 19 + TypeScript strict |
| 样式 | Tailwind v4（CSS-first） |
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
| 在线状态 / 跨进程协调 | Redis (`ioredis`) editing presence（ADR-0023）；无 Redis 时回退内存 |
| 后台任务 | pg-boss worker (`scripts/worker.ts`) |
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

`pnpm dev` is still available for non-standard environments, but the canonical host-side
path is `pnpm dev:local`. Do not use a stale `.env.local` remote `DATABASE_URL` for UI smoke.

```bash
pnpm smoke:local
```

生产 / NAS compose 配置放在 `.env`；host-side local dev 也从 `.env` 的 `POSTGRES_*`
派生本地连接串。浏览器代码不持有 provider key，所有 AI 调用都通过 Next route handler 或
pg-boss worker 在服务端执行。

常用检查 / PR 前门禁：

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm test             # 全量门禁：audit:profile + test:unit + test:db + test:migration
pnpm audit:schema     # schema write-path 审计（新表/字段必须有 write path）
pnpm audit:partition  # 测试分区审计（依赖 DB 的测试不得进 unit config）
pnpm build            # next build —— 抓 tsc/biome/vitest 都漏的 route export 校验
```

快速迭代用 watch 模式：`pnpm test:unit:watch`（无 DB，覆盖 UI / core / schema / parser）、
`pnpm test:db:watch`（DB / API，需 Docker）。

`pnpm test` 的 db / migration 分区用 `@testcontainers/postgresql` 启动真实 Postgres
（presence 集成测试另起 `@testcontainers/redis`），运行前需要 Docker Desktop 或 OrbStack。

## Self-host on NAS

### Prerequisites

- NAS with Docker support（绿联 UGOS Pro Docker panel, or any Docker Compose capable host）
- Cloudflare account with a domain you control（仅用于 Cloudflare Tunnel ingress）
- R2 / S3-compatible bucket already provisioned（see `.env.example`）

### One-time setup

1. **Create a Cloudflare Tunnel** in the [Zero Trust dashboard](https://one.dash.cloudflare.com) → Networks → Tunnels.
   - Point the public hostname, for example `loom.<your-domain>`, to `http://app:3000`.
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
(pgvector image), `redis` (ephemeral editing-presence store, ADR-0023), `app`, `worker`,
and `cloudflared`. The app is reachable through the Cloudflare Tunnel; port 3000 is not
bound to the host.

### Verify

```bash
curl https://loom.<your-domain>/api/health
# → {"status":"ok"}
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
app/
  (app)/         # 学习者页面
  (admin)/       # 管理页面
  api/           # 唯一后端面：route handlers（/api/health 免鉴权）
src/
  core/          # Zod schemas, id helpers, cross-subject primitives
  db/            # Drizzle schema + Postgres client
  ai/            # Task registry + browser-side caller（不持 provider key）
  server/        # Server-only：AI runner/tools、ingestion、knowledge、memory、review、export、R2、pg-boss helpers
  subjects/
    wenyan/      # Phase 1 subject bundle: classical Chinese
    math/        # Non-wenyan pressure subject: KaTeX + steps judging
    physics/     # Foundation closeout subject: units/dimensions pressure test
  ui/            # Shared React components（block-tree Tiptap 编辑器、KnowledgeGraph cytoscape）
scripts/         # worker entrypoint、dev/migrate wrappers、schema/partition/profile audits
docs/            # architecture, modules, ADRs, planning
```

`core/` 是跨学科共享层；`subjects/<name>/` 是单学科特化层。当前已从文言文扩展到 math / physics pressure subjects，新增科目应优先新增 profile 与能力声明，不 fork framework 路径。
