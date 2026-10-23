# AI 学习工具 (the-learning-project)

自用 AI 学习系统。当前实现是 **Hono API + Vite SPA + pg-boss worker** 三进程的 self-hosted 单用户应用；规划与架构以当前代码、ADR 与 [docs/architecture.md](./docs/architecture.md)（部分过时，采信前对照代码）为准；进程、发布、备份与访问约束见 [docs/operations.md](./docs/operations.md)；配置见 [docs/configuration.md](./docs/configuration.md)。

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
| AI runtime | Pi agent runtime（`@earendil-works/pi-agent-core` in-process agentLoop，`src/server/ai/pi-agent-adapter.ts`）；默认 provider 走 Mimo / 小米（`XIAOMI_API_KEY`，pi 原生 OpenAI Completions），另有 anthropic-sub OAuth / opencode-go / zhipuai-coding-plan lane（`ZAI_CODING_CN_API_KEY`；已存的 `zai-coding-cn` 仍解析到这条 lane）（`src/server/ai/providers.ts`）。opt-in `openai` lane（`OPENAI_API_KEY`）经 pi builtin provider 走 OpenAI Responses API 服务 gpt-6-astra（YUK-1027，仅显式 binding 可用，生产默认不变） |
| 记忆 / 事实层 | Mem0 (`mem0ai`) + pgvector store；LLM 随产品全局 pin；embedding 为 DashScope `text-embedding-v4`，保留既有维度（ADR-0017） |
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

## Optional Laminar application tracing

Set `LMNR_PROJECT_API_KEY` in the API and worker environment to enable application
traces with `@lmnr-ai/lmnr`. API startup and both worker modes initialize it
idempotently after environment loading. An empty key skips SDK loading and export.
Restart the relevant processes after changing this environment setting.

The default export contains allowlisted IDs, task/tool/model names, execution and
business outcomes, and usage evidence. It excludes prompts, tool arguments/results,
provider credentials, headers, history, images, raw reasoning, and exception text.
`instrumentModules: {}` disables broad SDK capture. `LMNR_DEBUG`,
`LMNR_TRACE_METADATA`, and `LMNR_SPAN_CONTEXT` disable this integration when set;
those SDK modes exceed its application capture policy.

A capability may opt one run into sanitized business text through `RunTaskCtx`:

```ts
await runTask(kind, businessInput, {
  ...context,
  laminarContent: {
    input: { summary: 'Synthetic fixture: compare two supplied statements' },
    output: (result) => ({ summary: sanitizeFinalBusinessAnswer(result.text) }),
  },
});
```

The capability owns sanitization. Each summary is capped at 4,000 characters;
this summary option remains independent of development transcripts. Returning a provider result does not
establish business acceptance: attempt spans remain `business_outcome=unassessed`.
Native assessment validation and Copilot finalization/settlement add their own verdicts.

For the development-stage transcript capture authorized by the owner, configure
`LMNR_PROJECT_API_KEY` through the existing local environment, then start both API
and worker with:

```bash
NODE_ENV=development LMNR_DEV_TRANSCRIPTS=1 pnpm dev:local
```

`dev:local` inherits these variables into both processes. Restart an existing dev
session after changing them. The switch accepts only `1` and requires exactly
`NODE_ENV=development`; production, test, or an unset environment cannot enable it.
An empty project key still prevents SDK loading and export. Omit the switch or set
`LMNR_DEV_TRANSCRIPTS=0` to keep metadata-only tracing.

This opt-in captures the Pi system/user/assistant/tool conversation as message
arrays on `llm.call`, visible final assistant text and correlated tool calls, and
sanitized structured arguments/results on tool spans. It preserves normal
educational content. It excludes reasoning blocks/signatures, credentials, auth
headers, environment/provider binding objects, images/binary/base64, and URLs
with query parameters or embedded credentials. It never reads credentials to
redact them and never fetches assets. Tool error objects become a fixed omission
marker, without their messages or stacks. Streaming observes the existing final
result once; it does not consume the stream again.

Payloads allow 64 messages/entries per collection, 8 nesting levels, 1,000 visited
nodes, 8,000 characters per text and a 24,000-character text budget. Final JSON is
at most 65,536 characters. Truncation and omitted binary/circular/accessor values
have visible markers. Structured JSON text over 65,536 characters is omitted with
a truncation marker rather than exporting an unchecked prefix. Existing capability
summaries and usage/cost semantics remain in place. No evaluator configuration
changes are required by this switch.

Only `llm.call` leaves carry additive token/cost attributes. Attempt aggregates are
reconciliation metadata and include child usage, so do not add them to leaf totals.
Pi catalog costs are estimates, not invoices; absent usage remains unknown.
Worker pickup starts a new `job.run` root, with logical-run correlation on Copilot;
queue trace headers and payloads are unchanged. Flush runs only after shutdown drain
and waits at most 500 ms. Trace export is best effort and cannot retry application work.

See [YUK-1325 design and verification](docs/planning/2026-10-06-yuk1325-laminar.md)
for exact boundaries and current limits.

## 开发

Prerequisites: **Node.js >=24.0.0**（`.node-version` 固定最低支持版本）与
**pnpm 11.13.1**。本地开发、生产 Docker 镜像与 CI 完整门禁统一使用 Node 24，
避免公开运行时契约与实际验证环境漂移。

### 本地重活限流

`pnpm typecheck*`、`lint*`、`build*`、`test*` 和 web/compose build 入口自动使用
`~/.cache/tlp-heavy-slots/slot-{1,2}`（`HEAVY_SLOTS=1` 可收紧）。与运营
`heavy.sh` 使用同一 `owner` 协议；嵌套 pnpm 和 `heavy.sh pnpm build` 复用
祖先持有的槽位。默认 Node 堆上限为 3072 MiB，覆盖继承的堆配置，其他
`NODE_OPTIONS` 保留。这是每个 Node 进程的堆上限，不是整棵进程树的 RSS 上限。

CI（`CI`、`GITHUB_ACTIONS` 或 `CIRCLECI` 为 `true` / `1`）不拿槽、不改
`NODE_OPTIONS`，原命令及退出状态继续传给 CI。Docker build 内部的槽位不与
宿主共享，因此 **宿主 docker build、pnpm install、直接运行 vitest 等仍须经**
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/heavy/heavy.sh <命令>`。
每条工作线同时最多一个重活；开运行窗前还须确认磁盘 ≥20GB、
`memory_pressure` free ≥25%、load ≤20。这些运行窗检查不由 pnpm 包装器替代。

包装器收到 INT/TERM/HUP 时转发给自己的命令进程组，组内进程退出后才归还槽位。
它不自动删除旧槽，避免与其他进程回收竞争。若主机重启或 SIGKILL 留下槽位，先核
`owner` PID 及运行资源，再由运营清理确认为过期的槽；不要删除仍由其他线持有的槽。

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

模型能力目录（YUK-924 / YUK-1563）：worker 启动时和每天从 models.dev 拉取
`api.json`，写入 `model_catalog_cache`（`src/server/boss/start-worker.ts`）。API 启动时
也从该行 hydrate，并每 60 秒检查 version 变化后重载（`server/index.ts`
`hydrateModelCatalogBeforeServe`、`src/server/ai/model-catalog.ts` `startModelCatalogWatch`）。
拉取失败沿用该行；没有该行就用 `src/server/ai/model-catalog.snapshot.json`。
`pnpm gen:model-catalog` 仍重写这份随包快照。
工具调用、推理及原生档位、输入模态、上下文/输入/输出上限和 API base URL
统一从该目录读取；Pi 只提供协议与兼容处理，不覆盖这些事实。目录缺项保持 unknown，
执行缺少必需端点或限额时明确报错。只有目录缺失或实测不符才能在
`src/server/ai/model-catalog-overrides.ts` 按 provider/model 写明原因后覆盖。
配置保存与 adapter 启动都以 `createLoomPiModels().getModel` 判定可执行性；
task、global 和 pin 设置均先校验必需事实，再校验任务能力，不接受保存成功但无法启动的模型。
目录缺失的四个旧模型以固定 main 快照补缺，Grok 另有已封存实测；这些依据不等同于新的付费准入。
压缩沿用 85% 触发、60% 裁剪目标，基数为目录 context 与显式 input 上限的较小值，
取整后至少为 1；最新工具结果与其调用成组保留，即使该组超出裁剪目标。
请求输出不得超过目录上限及估算的剩余上下文。估算不是 provider token 计量。
目录的模型级 Anthropic/OpenAI-compatible 协议声明优先于 Pi 协议快照；
OpenCode Go 已知协议路径不匹配时不执行。Anthropic 的目录 `/v1` 仅在传输适配时
去重，避免 SDK 再追加 `/v1/messages`。目录能力不等同于应用已接线或实测准入。
刷新不改任务选模；已选模型消失或能力/端点变化保留旧事实，并记录由 YUK-1563
负责处理的 finding。

自定义 provider（YUK-1563 ④）：`PUT /api/admin/custom-providers/:id` 填 baseURL、
key 环境变量名与协议（openai-completions / anthropic-messages）即可接入新 provider，
不改代码、不跑脚本。定义存 `custom_provider` 表（只有 env 变量名，key 值放
`.env.local` / 容器 env，不进库、不进日志）；变量名必须以 `_API_KEY` / `_TOKEN`
结尾，`DATABASE_*`、`POSTGRES_*`、`INTERNAL_TOKEN`、云凭据等共享 env 名会被拒绝
（值会被当作 Bearer 发到该 provider）。baseURL 的 host 还必须在 models.dev 目录
声明的模型端点内（另含代码声明的 anthropic/openai 直连根与 Xiaomi Token Plan
三区）；保存与执行解析时校验，该约束只作用于模型端点，不影响 agent 的网页浏览 /
fetch 工具。模型列表来自该端点自己的 `GET /models`
（自定义 provider 只做这类不计费读取，不发探针），能力字段按模型 id 复用 models.dev
同 id 条目；目录里没有、或缺必需限额/端点事实的模型不出现在 `runnable_models`
（可列出但过不了可运行性检查，不能保存为任务模型）。每个自定义 provider 在运行时
目录里有一个 `custom:<slug>` 合成 bucket：消失的已选模型与能力变化走同一条有主
finding 语义。配置面板经 `GET /api/admin/custom-providers` 读列表（只显示
已配置/未配置/认证失败 与 env 变量名），per-task 选模沿用 `PATCH /api/admin/config`
（provider 填 `custom:<slug>`），保存时与内置 provider 过同一道 `getModel` 可运行性检查。

生产 / NAS compose 配置放在 `.env`；host-side local dev 也从 `.env` 的 `POSTGRES_*`
派生本地连接串。浏览器代码不持有 provider key，所有 AI 调用都通过 Hono route 或
pg-boss worker 在服务端执行。

API 与独立 worker 都先由 `server/env.ts` 加载 `.env.local` / `.env`，再由
`src/server/env.ts` 用 @t3-oss/env-core + zod 校验 server schema。加载顺序、
必填项、compose 与本机 dev 的取值、逐键默认值及 DB 配置层见
[docs/configuration.md](./docs/configuration.md)。

常用检查 / PR 前门禁：

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm lint:ratchet     # warning/info 总数 ratchet（基线 scripts/lint-baseline.json，只降不升；修完 warning 后 pnpm lint:ratchet:update 重生基线）
pnpm test             # 全量 umbrella（audit 链 + unit/db/migration）；CI Gate 不调用它，而是跑 .github/workflows/ci-gate.yml 的矩阵（见 docs/agents/development-workflow.md）；本机按 AGENTS.md 只跑 scoped tests
pnpm audit:schema     # schema write-path 审计（新表/字段必须有 write path）
pnpm audit:partition  # 测试分区审计（依赖 DB 的测试不得进 unit config）
pnpm audit:task-census # task registry 的 static caller / compatibility 分类与 wiring、run-log 契约
pnpm build            # SPA + TanStack Start + 三 esbuild 产物（dist/server.cjs / dist/worker.cjs / dist/migrate.cjs）
```

快速迭代用 watch 模式：`pnpm test:unit:watch`（无 DB，覆盖 UI / core / schema / parser）、
`pnpm test:db:watch`（DB / API，需 Docker）。

`pnpm test` 的 db / migration 分区用 `@testcontainers/postgresql` 启动真实 Postgres，
运行前需要 Docker Desktop 或 OrbStack。

## 当前部署目标：Mac 上的 Agent 开发测试环境

Owner 于 2026-10-07 将产品交付与本机运维持续委托给 agent，见[授权记录](docs/planning/2026-10-07-autonomous-delivery-charter.md)。本机入口 <http://localhost:8787> 只供 Agent 开发测试，沿用独立 app、worker 和 PostgreSQL；只有 owner 之后明确要求“为我日常使用的部署”才切换日用。完整行为设计见[连续学习系统](docs/design/2026-10-06-continuous-learning-system-behavior.md)，设计基线不等于当前实现。当前附件存储与重置证据见[测试存储记录](docs/planning/2026-10-07-agent-test-storage.md)与[Agent 测试环境记录](docs/planning/2026-10-07-agent-test-environment-reset.md)，后续任务与进度见 [Linear](docs/agents/issue-tracker.md)；`PLAN.md` 仅为各工作树的本地记录。

compose 服务、发布与恢复顺序、备份、容器 DNS，以及 Tailscale / 局域网等访问约束统一见[运维](docs/operations.md)。远程入口是可选的 Tailscale Serve（同一 tailnet、Mac 开机且用户会话内 daemon 运行，未开 Funnel）；主机名和局域网地址属于本机私有配置。

下面的 NAS / Cloudflare Tunnel 指南保留为可选方式，不是当前 Mac 的默认操作入口。

## Self-host on NAS

### Prerequisites

- NAS with Docker support（绿联 UGOS Pro Docker panel, or any Docker Compose capable host）
- Cloudflare account with a domain you control（仅用于 Cloudflare Tunnel ingress）
- R2 / S3-compatible bucket already provisioned（see `.env.example`）

### One-time setup

1. **Create a Cloudflare Tunnel** in the [Zero Trust dashboard](https://one.dash.cloudflare.com) → Networks → Tunnels.
   - Point the public hostname, for example `loom.<your-domain>`, to `http://app:8787`.
   - Copy the Tunnel Token shown after creation.

2. **Configure environment variables** — copy `.env.example` to `.env`; 至少填写
   `DATABASE_URL`、`INTERNAL_TOKEN` 和所选 provider lane 的 key（模板默认 lane 用
   `OPENCODE_API_KEY`）。走 Cloudflare Tunnel 时填 `TUNNEL_TOKEN`；录入需要 R2 的 key，
   以及 OCR 引擎的 key——默认 `glm` 需要 `ZHIPU_API_KEY`，设为 `tencent` 时改为腾讯 OCR
   的 key；worker 处理记忆事件需要 `DASHSCOPE_API_KEY`。

   变量含义、默认值、AI/记忆 pin 与 DB 配置层见
   [docs/configuration.md](./docs/configuration.md)。

3. **Database migrations run automatically.** A dedicated `migrate` init container
   (YUK-65) applies the bundled drizzle migrations before `app` / `worker` start on
   every `docker compose up` — idempotent, drizzle's `__drizzle_migrations` table
   tracks applied state. The runner also prepares Goal/LearningItem/MistakeVariant/Artifact/QuestionBlock
   legacy anchors and checks fold/live values and row sets. Incomplete history or drift
   fails deployment without rebuilding live rows; all newly prepared anchors roll back.
   For an upgrade from the legacy mailbox release, first complete the special drain
   procedure below. Otherwise, stop application writers before a manual re-run (the preparation takes table locks
   and fails after 5 seconds if an existing transaction prevents acquisition):
   ```bash
   docker compose stop app worker
   docker compose run --rm migrate
   ```
   The runner also refuses an undrained legacy Copilot mailbox. Before upgrading
   from the mailbox release, prove the full retry window is empty, stop admission,
   unschedule exactly `copilot_subagent_reconcile` with the previous pg-boss client,
   and let the previous worker drain any queued housekeeping ticks before stopping it.
   A remaining legacy child, continuation, queued/active/retry job or old schedule
   blocks migration; terminal history and native child projections are retained.
   Never delete pending jobs to pass readiness. Rolling back the worker restores its
   schedule, so repeat this check before retrying the upgrade. See
   [ADR-0063](docs/adr/0063-retire-copilot-mailbox-execution.md).
   Goal, LearningItem and MistakeVariant now have one structural writer; their old
   `PROJECTION_IS_WRITER_*` switches are ignored. Rollback requires the previous
   release plus a verified recovery configuration, not switching these entities OFF
   in the new release. The previous reducers cannot replay the new LearningItem repair
   events: previous-release recovery must preserve materialized rows, disable its three
   structural projection modes, and never rebuild them with those older reducers.
   Before returning to canonical mode after rollback writes, repeat readiness checks
   and repair any mismatch. See the [cutover evidence](docs/planning/2026-09-07-canonical-state-writers.md).
   Knowledge, KnowledgeEdge, Note and QuestionBlock editors also use canonical
   projection writers; the global `PROJECTION_IS_WRITER` and retired per-entity
   flags no longer select alternate writers. Deployment preparation validates all
   seven entities, including knowledge creation indexes/acceptances and merge-source
   history, before seeding only genuinely eventless legacy rows. A failed history
   check requires repair; do not bypass it with a replacement genesis or live rebuild.
   Rollback uses the previous release and its matching configuration, not toggles
   in the new release. ItemCalibration remains Scheme A, default OFF.
   Restart worker, then app only after migration succeeds. Do not bypass a failed
   readiness check with `--no-deps` or snapshot over incomplete event history.

### Deploy

```bash
docker compose build
pnpm compose:up
```

`pnpm compose:up` checks that the connector token is non-empty before Compose can
create a cloudflared restart loop. The cloudflared container also reports Docker
health from its `/ready` endpoint, which becomes healthy only after at least one
edge connection is registered. Inspect it with:

```bash
docker compose ps cloudflared
docker compose logs --tail 50 cloudflared
```

The compose stack starts `migrate` (one-shot init that applies migrations), `postgres`
(pgvector image), `app` (Hono :8787), `mem0-init`（one-shot `chown` `mem0data` 卷，供
worker 写入历史库前修好属主）, `worker`（`image: the-learning-project-worker` +
`target: worker`，在 runner 上叠加 `playwright-core` 1.64.0 与
`chromium-headless-shell`，供 `worksheet_render` 使用），and `cloudflared`. The app is
reachable through the Cloudflare Tunnel; port 8787 is bound only inside the compose
network，不暴露到 host。

`migrate` / `app` / `mem0-init` 都显式 `target: runner`；只有 `worker` 用
`target: worker`。Dockerfile（node:24-slim 多阶段）build 产物为 `web/dist`（原 SPA）、
`dist/start`（TanStack Start 前门）和 `dist/server.cjs`、`dist/worker.cjs`、`dist/migrate.cjs`。
app 容器 `CMD ["node", "dist/server.cjs"]`，`RW_STATIC_DIR=/app/web/dist` 启用 Start 前门：
`/api/*` 直接交给原 Hono app，`/_build/*` 提供 Start 客户端资产，已接管的页面以
`server/start/routes/` 为准，其余页面回落到原 SPA。API hydration、tool recovery 和 shutdown
的 owner 保持不变。切换/回退及 P7 清理条件见[前门 runbook](docs/planning/2026-10-07-yuk1352-start-frontdoor.md)。
**无 Redis 服务**——editing presence 走 PG 表 `editing_presence`（PgPresenceStore，YUK-321
M5 gate 选项 b）。

停止时 API 先停止接纳 HTTP，请求最多排空 30 秒（超时断开订阅连接，不等于
Copilot Stop）；`RW_WORKER=1` 时先等同进程 worker 启动完成，随后已启动的 pg-boss 执行
30 秒清理，再关闭 DB pool。
API 总退出期限 65 秒，Compose 留 70 秒；独立 worker 保留 30 秒清理，Compose 留 40 秒。
超出总期限或清理失败以非零退出并记录日志；未完成的持久任务仍按既有恢复策略处理。

### Verify

```bash
curl https://loom.<your-domain>/api/health
# → {"ok":true}
```

### Backup

**日级 dump（Mac 本机）**：launchd 每日 07:15 跑 `scripts/mac-daily-dump.sh`，写 `loom-daily-YYYYMMDD.dump`（custom format），保留最近 14 份 + 每月 1 号归档。安装、TCC 约束、失败标记与巡检命令见[运维：备份与恢复](docs/operations.md#备份与恢复)。

**手动 dump / restore**：

```bash
pnpm db:dump
pnpm db:restore < /tmp/loom-20260101-000000.sql
```

**完整 Postgres 恢复演练**：外部 maintenance owner 持有 writer 边界后跑 `scripts/cutover-final-backup.sh ... --strict`，用 `scripts/restore-drill.sh` 在隔离 scratch 比较，最终 manifest 另加 `--require-restore-parity`；`--strict` 只检查 capture 工件。命令、边界与重开条件见[完整 Postgres 恢复流程](docs/sub5-restore-cli.md#full-postgres-disaster-recovery)。Postgres dump 不含 R2 对象，需独立备份。

## 目录

```text
server/           # Hono API 入口（index.ts）+ 组合根工厂（app.ts）+ env 加载
  start/          # TanStack Start 前门：routes、server functions、授权 middleware
web/              # Vite SPA 工程（root=web/；TanStack Router；@ alias 指 ../src）
crates/
  calibration-native/ # Rust 离线 calibration 核心（napi + WASM，与 TS oracle parity）
src/
  capabilities/   # Capability 包：manifest.ts 声明路由/jobs/copilotTools/ui.pages
    copilot/      # Copilot 域（D14 单人格 + 统一记忆读取面 + copilotTools 贡献制）
    observability/# Observability 域（admin/logs/cost/jobs four GET 面平移）
    onboarding/   # 冷启动引导：目标设定、材料上传、起点探测与起始档案
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
    yuwen/        # Phase 1 subject bundle: 语文 (current content: classical Chinese)
    math/         # Non-yuwen pressure subject: KaTeX + steps judging
    physics/      # Foundation closeout subject: units/dimensions pressure test
    general/      # 中性默认 subject profile（未知 domain 的 fallback 身份）
  ui/             # Shared React components（block-tree Tiptap 编辑器、KnowledgeGraph cytoscape）
  ui-next/        # UI rewrite 的 scoped design-system 基础层（tokens/primitives/shell/mascot/motion）
scripts/          # worker.ts（pg-boss 独立进程）+ migrate.ts + dev-local.ts + audits（schema/partition/profile）
postman/          # api-endpoints.json 真相源 + gen:postman manifest 对账层
docs/             # architecture, configuration, operations, modules, ADRs, planning
```

`core/` 是跨学科共享层；`subjects/<name>/` 是单学科特化层。`src/capabilities/<name>/manifest.ts`
是后端真相源——新增路由/jobs/tools 都通过 manifest 贡献制登记进组合根 `server/app.ts`。当前已从语文（首个科目，当前内容为文言文）扩展到 math / physics pressure subjects，新增科目应优先新增 profile 与能力声明，不 fork framework 路径。


### TEST home LAN access (owner decision 2026-10-11)

The current Mac TEST app keeps both `127.0.0.1:8787:8787` and a specific home-LAN address in its private Compose `services.app.ports`; never bind `0.0.0.0`. LAN addressing, Tailscale remote entry, token/health rules, and the binding-change checklist are in [docs/operations.md](docs/operations.md#网络与访问). Specific addresses and hostnames stay in owner private records, not this repo.
