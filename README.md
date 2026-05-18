# AI 学习工具 (the-learning-project)

自用 AI 学习系统。当前实现是 Next.js + Postgres + pg-boss 的 self-hosted 单用户应用；规划与架构详见 [docs/architecture.md](./docs/architecture.md)、[docs/modules/](./docs/modules/) 与 [docs/superpowers/status.md](./docs/superpowers/status.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| Web app | Next.js 15 App Router + React 19 + TypeScript strict |
| 样式 | Tailwind v4（CSS-first） |
| 状态 / 数据 | TanStack Query + Zustand |
| Schema / 校验 | Zod |
| 数据库 | Postgres + Drizzle ORM (`postgresql` dialect, `postgres` driver) |
| Blob 存储 | R2 / S3-compatible storage via `@aws-sdk/client-s3` |
| AI runtime | AI SDK v6 package + Claude Agent SDK runner + `@ai-sdk/anthropic` provider package |
| 后台任务 | pg-boss worker (`scripts/worker.ts`) |
| 复习算法 | `ts-fsrs` |
| Lint / Format | Biome |
| 包管理 | pnpm |

设计原则：用成熟 OSS 解成熟问题；AI 调用按 task 抽象，不做聊天框；破坏性 AI 动作走 proposal + 用户确认。

## 开发

```bash
pnpm install
pnpm dev

# 后台 worker（另开终端，需要 DATABASE_URL）
pnpm worker:dev
```

本地配置放在 `.env.local`；生产 / NAS compose 配置放在 `.env`。浏览器代码不持有 provider key，所有 AI 调用都通过 Next route handler 或 pg-boss worker 在服务端执行。

常用检查：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm audit:schema
```

`pnpm test` 使用 `@testcontainers/postgresql` 启动真实 Postgres，运行前需要 Docker Desktop 或 OrbStack。

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
   DATABASE_URL=postgres://loom:loom@postgres:5432/loom
   INTERNAL_TOKEN=...
   XIAOMI_API_KEY=...
   ANTHROPIC_API_KEY=...
   TUNNEL_TOKEN=<paste-token-here>
   # + R2 / Tencent OCR keys
   ```

3. **Run database migrations** after first start:
   ```bash
   docker compose exec app pnpm db:migrate
   ```

### Deploy

```bash
docker compose build
docker compose up -d
```

The compose stack starts `postgres`, `app`, `worker`, and `cloudflared`. The app is reachable through the Cloudflare Tunnel; port 3000 is not bound to the host.

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
app/             # Next App Router pages + API route handlers
src/
  core/          # Zod schemas, id helpers, cross-subject primitives
  db/            # Drizzle schema + Postgres client
  ai/            # Task registry + browser-side caller
  server/        # Server-only AI, ingestion, review, export, R2, pg-boss helpers
  subjects/
    wenyan/      # Phase 1 subject bundle: classical Chinese
  ui/            # Shared React components
scripts/         # worker entrypoint, schema audit, maintenance scripts
docs/            # architecture, modules, ADRs, planning
```

`core/` 是跨学科共享层；`subjects/<name>/` 是单学科特化层。当前 Phase 1 首发文言文，但架构边界必须保留给后续多科目。
