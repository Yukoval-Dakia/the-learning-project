# AI 学习工具 (the-learning-project)

自用 AI 学习系统。当前实现是 **Hono API + TanStack Start 前门 + pg-boss worker** 三进程的 self-hosted 单用户应用；规划与架构以当前代码、ADR 与 [architecture.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/architecture.md) 为准；进程、发布、备份与访问约束见 [operations.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/operations.md)；配置见 [configuration.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/configuration.md)。

> 文档不在 git 内：原 `docs/` 与 `PLANNING.md` 的副本在 `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/`（清单 `MANIFEST.tsv`，逐文件 hash `SHA256SUMS`）；下文文档链接均指向该目录。

> **2026-06-13 形态变更（YUK-321 M5）**：Next.js 全栈已退场。现形状 = Hono API（`server/index.ts`，:8787）+ Vite SPA（`web/`，:5173）+ pg-boss worker（`scripts/worker.ts`，dev 入口 `pnpm worker:dev`、prod 入口 `node dist/worker.cjs`）。后端真相源 = capability manifests（`src/capabilities/*/manifest.ts`）+ 组合根 `server/app.ts`。旧 Next/App Router/middleware.ts/Redis 描述只存在于历史文档，均不再适用。后续 Vite SPA（独立 :5173 路由表）已被 TanStack Start 前门取代并移除，页面由 `server/start/routes/` 同源提供于 :8787。

## 技术栈

| 层 | 选型 |
| --- | --- |
| API | Hono（组合根 `server/app.ts` 挂载 capability manifests，`@hono/node-server` :8787，`hono/streaming` SSE） |
| Web | TanStack Start 前门（`server/start/`，Vite 构建）+ React 19 + TanStack Query + TypeScript strict；壳层资源在 `web/src/` |
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
`NODE_ENV=development`; production, test, or an unset environment cannot enable this switch.
An empty project key still prevents SDK loading and export. Omit the switch or set
`LMNR_DEV_TRANSCRIPTS=0` to turn this switch off.

Separately, `LMNR_TRANSCRIPTS=1` enables transcripts in any environment, for a whitelist
of tasks whose content holds no learner material. Today that is
`QuestionAdmissionSolveTask`, and only for a question from `web_sourced` or a
knowledge-triggered `quiz_gen` whose purpose is `allow` and which only pipeline writers
have ever published, so an edited question does not qualify. A task enters the whitelist only
if no tool it can call returns learner data. Every other task stays metadata only. Unset
the switch to turn it off.

Either opt-in captures the Pi system/user/assistant/tool conversation as message
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
Typed decision runs use the same chain: one `task.run`, one `task.attempt` per wire
attempt, and one `llm.call` for the systemone request. That leaf copies the attempt's
settled tokens and cost once, and it does not carry the request or response. Jev
amounts stay on the reported or pricebook basis. A transient retry is a failed
attempt beside the next attempt under the same `task.run`.
Worker pickup starts a new `job.run` root, with logical-run correlation on Copilot;
queue trace headers and payloads are unchanged. Flush runs only after shutdown drain
and waits at most 500 ms. Trace export is best effort and cannot retry application work.

See [YUK-1325 design and verification](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/planning/2026-10-06-yuk1325-laminar.md)
for exact boundaries and current limits.

## 开发

Prerequisites: **Node.js >=24.0.0**（`.node-version` 固定最低支持版本）与
**pnpm 11**。本地开发、生产 Docker 镜像与 CI 完整门禁统一使用 Node 24，
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

Local development has its own Postgres, isolated from the TEST stack (TEST's Postgres
lives on the NAS; its former host ports `127.0.0.1:5433` / `5544` are closed since
2026-11-06). Install once, then one command:

```bash
pnpm install
pnpm dev:local      # then open the printed origin (e.g. http://127.0.0.1:8788/) and paste the printed token
```

`dev:local` starts the dev-only Postgres (`docker-compose.dev.yml`, service `postgres-dev`,
host port **5434**, role `loom_dev`, named volume `loom-dev_loom-dev-pgdata`), waits until it
is healthy, then creates **one database per worktree** inside that shared container —
`loom_dev_<worktree>_<path hash>`, deterministic from the worktree root (`DEV_DB_NAME`
overrides) — applies pending migrations, and starts the API and worker against it. The port
is the first port free on 127.0.0.1 and IPv6 from **8788** up (`DEV_PORT` pins one; 8787
stays TEST's, and a local dev launch that asks for 8787 is refused before binding while
production containers keep `API_PORT=8787`), so several worktrees run dev at the same
time without sharing data or ports. Re-running
reuses the same database and only applies new migrations. Docker/OrbStack must be running
(`open -ga OrbStack`).

- **Guard:** `dev:local`, `dev:reset` and every script resolving a local database target
  (`db:migrate:local`, `drizzle.config.local.ts`, delivery/spike scripts — one shared
  judgment in `scripts/local-db-env.ts`) refuse TEST targets before connecting: resolved
  port 5433/5544 (compared after parsing, so `05433`-style spellings are caught too) or
  database `loom`. Scripts that read `DATABASE_URL` directly (`db:generate` / `db:push` /
  `db:migrate` via `drizzle.config.ts`, `worker:dev`, `seed:*`, `db:backfill:*`,
  `db:recompute:*` and every CLI importing `scripts/load-env.ts`) get the same refusal:
  every candidate host:port from the URL authority, comma-separated hosts,
  `?host=`/`?port=` and `PGHOST`/`PGPORT` is checked, and any loopback candidate on a
  TEST port — or a loopback candidate whose database is `loom` — refuses. The
  local dev API (`server/index.ts`, non-production) runs that same `DATABASE_URL` check
  before serving; the 8787 fence is a separate non-container check. Production
  (`NODE_ENV=production`) skips the database guard — an explicit switch, not a security
  boundary. The default is always this
  worktree's dev database (`loom_dev` role @ 127.0.0.1:5434). The only override is
  `DEV_ALLOW_TEST_DB=1`, which prints a warning banner and honours the TEST stack's
  `POSTGRES_*` — do not use it casually.
- **Connections:** each dev API and worker uses a small pool (`DB_POOL_MAX=5`, also caps pg-boss), about 29 connections per worktree (pools plus the pg-boss and event LISTEN clients). `dev:local` saves `max_connections=300` on the shared dev Postgres (in its volume, not the compose file) and restarts it only when no other worktree is connected; otherwise it prints the restart command to run once they are stopped.
- **Builtin subjects:** migrations run through the production entry `scripts/migrate.ts`, so every start also runs the subject-root seed and the builtin subject/trait reconcile (4 subjects, 24 traits); both are idempotent, so older dev databases are filled on their next start.
- **Seed questions:** unless `DEV_SEED=0`, a fresh dev DB starts with 7 admitted math questions (ids `devseed:q:*`, fixed answer keys graded without any model call) so the question bank, practice and today pages have content; re-running adds nothing. Dev DB only — never with `DEV_ALLOW_TEST_DB=1`.
  For a cold-start or first-use check on an empty learner state: `pnpm dev:reset`, then `DEV_SEED=0 pnpm dev:local`. Builtin subjects and subject roots still come from `scripts/migrate.ts` (production does the same); `DEV_SEED=0` never deletes questions seeded earlier.
- **Reset the dev DB:** `pnpm dev:reset` drops **only the current worktree's** database (the
  next `pnpm dev:local` recreates, migrates and re-seeds it). Never
  `docker compose -f docker-compose.dev.yml down -v` — the volume holds every worktree's
  database at once.
- **Legacy shared DB:** older worktrees may still use the shared `loom_dev` database. Once
  nothing needs it, drop it by hand:
  `docker compose -f docker-compose.dev.yml exec postgres-dev psql -U loom_dev -d postgres -c 'drop database if exists loom_dev with (force)'`.

`pnpm dev:local`（= `tsx scripts/dev-local.ts`）spawn **两进程**，启动后打印要打开的地址（自动探测 8788 起在 127.0.0.1 与 IPv6 都空闲的首个端口，可用 `DEV_PORT` 固定；8787 是 TEST 中继端口，显式 `DEV_PORT=8787` 恒在绑定前退出，生产入口与容器内 API 的 `API_PORT=8787` 不受影响）：

| 进程 | 端口 | 命令 | 角色 |
| --- | --- | --- | --- |
| API + Start 前门 | 自动选择（8788 起，`DEV_PORT` 固定） | `pnpm exec tsx watch server/index.ts`（`RW_WORKER=0`，另设 `RW_FRONTDOOR=dev`） | Hono 组合根，不消费队列；Vite dev server 以 middleware 模式跑在同一进程、同一端口（`server/dev-frontdoor.ts`），页面与 `/api/*` 同源，**页面改动热更新（HMR），不需要构建**；改 `server/`、`src/server/` 等服务端文件由 tsx watch 重启 API |
| Worker | — | `pnpm worker:dev`（`tsx scripts/worker.ts`） | 独立 pg-boss worker 进程，`dev:local` 里唯一的队列消费者 |

dev 拓扑必须 api（含 Vite 前门）+ worker 两进程齐活（YUK-321 M5 双进程拓扑）：`LISTEN loop 不消费 boss job`，队列只由独立 worker 消费。单独跑 `pnpm rw:api` 仍带 `RW_WORKER=1`，是不另起 worker 时的单进程兜底。

`pnpm dev` 是 `pnpm dev:local` 的别名。单独运行 `pnpm rw:api` 时 `API_PORT` 缺省也是 8787，本机 dev（`NODE_ENV` 非 `production`、非容器）会在绑定前退出（8787 是本机 NAS 中继的 TEST 端口；生产入口与容器由 Dockerfile 显式设 `API_PORT=8787`，照常监听）。dev 的 `DATABASE_URL` 由 dev-local 固定指向 dev Postgres（:5434）中本 worktree 自己的库（`loom_dev_<worktree>_<hash>`），忽略 `.env` / `.env.local` 里的 `DATABASE_URL` 与 `POSTGRES_*`。

`dev:local` 也不读 `.env` / `.env.local` 里的 `INTERNAL_TOKEN`：显式导出时沿用它，否则每次启动生成随机值，并打印在启动日志里（复制到页面 TokenGate）；API、worker 与前门共用同一个值。直跑 `rw:api` / `worker:dev` 仍按 `loadEnv()` 从文件加载。对 `dev:local` 跑本地验收脚本时用日志里的 token，例如 `INTERNAL_TOKEN=<值> API_SMOKE_BASE_URL=<打印的 origin> pnpm api:smoke`。

```bash
LOCAL_NEXT_PORT=<dev 端口> INTERNAL_TOKEN=<dev:local 打印值> pnpm smoke:local
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
配置保存、运行时配置解析（task opt-in、Memory LLM、provider `/models` 端点）与
adapter 启动都过同一道可运行性门（`createLoomPiModels().getModel`，同步读面为
`executablePiModel`）；task、global 和 pin 设置先校验必需事实，再校验任务能力。
该门只覆盖目录事实与任务能力——凭据缺失、工具挂载为空或 effort 双设仍会在启动期
失败，保存通过不保证启动成功。
目录缺失的四个旧模型以固定 main 快照补缺，三个 OpenCode Go 旧模型的端点钉在
overrides 兜底；Grok 的封存实测仅覆盖单任务 text/reasoning，端点、限额与 image
输入未实测。这些依据不等同于新的付费准入。
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
声明的模型端点内（另含代码声明的 anthropic/openai 直连根、Xiaomi Token Plan
三区、DashScope embedding 双端点与北京 workspace MaaS host `ws-tcvd1h9009b55vr0.cn-beijing.maas.aliyuncs.com`）；保存与执行解析时校验，registry 与目录 bucket
未同步时任务解析 fail closed，不向旧端点发 key；非默认端口必须由目录端点自身声明，
否则拒绝。`api_key_env` 还与 provider 绑定：内置 provider 的凭据 env
（如 `ZHIPU_API_KEY`、`OPENROUTER_API_KEY`）只能配给自家端点，内置端点也只收
自家凭据 env，跨 provider 配置被拒（YUK-1654）。运维 env 端点
（`MEM0_LLM_BASE_URL`、`MEM0_EMBEDDING_BASE_URL`、`MIMO_VISION_BASE_URL`、
`XIAOMI_TOKEN_PLAN_BASE_URL`）走同一套 host 校验，不在白名单即拒绝发送。该约束
只作用于模型端点，不影响 agent 的网页浏览 /
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
`src/core/config/server/env.ts` 用 @t3-oss/env-core + zod 校验 server schema。加载顺序、
必填项、compose 与本机 dev 的取值、逐键默认值及 DB 配置层见
[configuration.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/configuration.md)。

常用检查 / PR 前门禁：

```bash
pnpm typecheck        # tsrs --noEmit（root + server/start/tsconfig.json）
pnpm lint             # biome check .
pnpm lint:ratchet     # warning/info 总数不得高于 PR 分叉点实测数（merge-base 用 head 的 Biome 重测）；低于不失败，无台账文件；取不到 base 时 fail closed（CI 必须给 LINT_BASE_SHA/--base）
pnpm test             # 全量 umbrella（audit 链 + unit/db/migration）；CI Gate 不调用它，而是跑 .github/workflows/ci-gate.yml 的矩阵（见 AGENTS.md 与 `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/agents/development-workflow.md`）；本机按 AGENTS.md 只跑 scoped tests
pnpm audit:schema     # schema write-path 审计（新表/字段必须有 write path）
pnpm audit:partition  # 测试分区审计（依赖 DB 的测试不得进 unit config）
pnpm audit:task-census # task registry 的 static caller / compatibility 分类与 wiring、run-log 契约
pnpm build            # TanStack Start + 三 esbuild 产物（dist/server.cjs / dist/worker.cjs / dist/migrate.cjs）
```

快速迭代用 watch 模式：`pnpm test:unit:watch`（无 DB，覆盖 UI / core / schema / parser）、
`pnpm test:db:watch`（DB / API，需 Docker）。

`pnpm test` 的 db / migration 分区用 `@testcontainers/postgresql` 启动真实 Postgres，
运行前需要 Docker Desktop 或 OrbStack。

## 当前部署目标：NAS 上的 Agent 开发测试环境

Owner 于 2026-10-07 将产品交付与本机运维持续委托给 agent，见[授权记录](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/planning/2026-10-07-autonomous-delivery-charter.md)。TEST 跑在 NAS（`bancho-nb2.local`，`/volume1/docker/tlp-test/`），Mac 入口 <http://localhost:8787> 经 LaunchAgent `studio.yukoval.tlp-nas-tunnel` 中继到达，只供 Agent 开发测试，沿用独立 app、worker 和 PostgreSQL；只有 owner 之后明确要求“为我日常使用的部署”才切换日用。回滚期 Mac 容器 stopped 不删。完整行为设计见[连续学习系统](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/design/2026-10-06-continuous-learning-system-behavior.md)，设计基线不等于当前实现。当前附件存储与重置证据见[测试存储记录](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/planning/2026-10-07-agent-test-storage.md)与[Agent 测试环境记录](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/planning/2026-10-07-agent-test-environment-reset.md)，后续任务与进度见 [Linear](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/agents/issue-tracker.md)；`PLAN.md` 仅为各工作树的本地记录。

compose 服务、发布与恢复顺序、备份、容器 DNS，以及 Tailscale / 局域网等访问约束统一见[运维](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/operations.md)。远程入口是可选的 Tailscale Serve（同一 tailnet、Mac 开机且用户会话内 daemon 运行，未开 Funnel）；主机名和局域网地址属于本机私有配置。

下面的 NAS / Cloudflare Tunnel 指南是通用自托管参考；当前 TEST 的 NAS 部署用的是 owner 私有的 `compose.private.json`，不以下面这份为准。

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
   [configuration.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/configuration.md)。

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
   [ADR-0063](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/adr/0063-retire-copilot-mailbox-execution.md).
   Goal, LearningItem and MistakeVariant now have one structural writer; their old
   `PROJECTION_IS_WRITER_*` switches are ignored. Rollback requires the previous
   release plus a verified recovery configuration, not switching these entities OFF
   in the new release. The previous reducers cannot replay the new LearningItem repair
   events: previous-release recovery must preserve materialized rows, disable its three
   structural projection modes, and never rebuild them with those older reducers.
   Before returning to canonical mode after rollback writes, repeat readiness checks
   and repair any mismatch. See the [cutover evidence](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/planning/2026-09-07-canonical-state-writers.md).
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
`target: worker`。Dockerfile（node:24-slim 多阶段）build 产物为
`dist/start`（TanStack Start 前门）和 `dist/server.cjs`、`dist/worker.cjs`、`dist/migrate.cjs`。
app 容器 `CMD ["node", "dist/server.cjs"]`，`RW_FRONTDOOR=1` 启用 Start 前门：
`/api/*` 直接交给原 Hono app，`/_build/*` 与站点根的 PWA 文件（manifest、图标）提供 Start 客户端资产，全部页面以
`server/start/routes/` 为准（无旧 SPA 回落）。API hydration、tool recovery 和 shutdown
的 owner 保持不变。切换/回退及 P7 清理条件见[前门 runbook](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/planning/2026-10-07-yuk1352-start-frontdoor.md)。
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

**日级 dump**：Mac 上 launchd 每日 07:15 跑 `scripts/mac-daily-dump.sh`，经 ssh 在 NAS 的 TEST postgres 容器里 `pg_dump`，写 `loom-daily-YYYYMMDD.dump`（custom format），保留最近 14 份 + 每月 1 号归档；Mac 关机时当日不跑。安装、TCC 约束、失败标记与巡检命令见[运维：备份与恢复](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/operations.md#备份与恢复)。

**手动 dump / restore**：

```bash
pnpm db:dump
pnpm db:restore < /tmp/loom-20260101-000000.sql
```

**完整 Postgres 恢复演练**：外部 maintenance owner 持有 writer 边界后跑 `scripts/cutover-final-backup.sh ... --strict`，用 `scripts/restore-drill.sh` 在隔离 scratch 比较，最终 manifest 另加 `--require-restore-parity`；`--strict` 只检查 capture 工件。命令、边界与重开条件见[完整 Postgres 恢复流程](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/sub5-restore-cli.md#full-postgres-disaster-recovery)。Postgres dump 不含 R2 对象，需独立备份。

## 目录

```text
server/           # Hono API 入口（index.ts）+ 组合根工厂（app.ts）+ env 加载
  start/          # TanStack Start 前门：routes、server functions、授权 middleware
web/              # Start 路由共用的壳层资源（RootShell、TokenGate、globals.css、字体）
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
```

`core/` 是跨学科共享层；`subjects/<name>/` 是单学科特化层。`src/capabilities/<name>/manifest.ts`
是后端真相源——新增路由/jobs/tools 都通过 manifest 贡献制登记进组合根 `server/app.ts`。当前已从语文（首个科目，当前内容为文言文）扩展到 math / physics pressure subjects，新增科目应优先新增 profile 与能力声明，不 fork framework 路径。


### TEST on the NAS, reached through a Mac-local relay

TEST runs on the NAS (`bancho-nb2.local`) at `/volume1/docker/tlp-test/` — project `the-learning-project` with a private `compose.private.json`, memory/CPU-limited containers, restart `unless-stopped`; `app` and Postgres bind `127.0.0.1:18787` / `127.0.0.1:15433` on the NAS only, never `0.0.0.0`. The NAS sshd forbids TCP forwarding, so the Mac reaches TEST through LaunchAgent `studio.yukoval.tlp-nas-tunnel`: a relay on `127.0.0.1:8787` where each connection is an ssh exec channel running a Python forwarder on the NAS (with a few warm channels parked, a request normally skips the ssh setup). The relay's Postgres ports (`5433`/`5544` → NAS `15433`) were closed on 2026-11-06 — dev scripts used to default to 5433, so those ports must not reach TEST; query TEST data over `ssh yukoval@bancho-nb2.local docker exec … psql` instead. `studio.yukoval.tlp-nas-watch` restarts the NAS memory watchdog after NAS reboots and alerts on a memory stop or unhealthy TEST. With the Mac off, TEST keeps running but is unreachable from outside, the Tailscale entry is down, and that day's backup does not run. Relay/watch reinstall steps and token/health rules are in [operations.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/operations.md#网络与访问). Specific private addresses stay in owner private records, not this repo.

AI tasks inherit `opencode-go/deepseek-v4.1-flash` from `DEFAULT_TASK_MODEL`
(`src/core/config/model-overrides.ts`) with
`lane.global.reasoning={"level":"high"}`. Set `task.<kind>.reasoning={"level":"max"}`
for a task override. `AI_PROVIDER_OVERRIDE` / `AI_PROVIDER_MODEL` remain process-wide
provider/model emergency pins; clear both to exercise the defaults. Removed `mimo-v2.5*` stored
models fail visibly instead of switching silently. Mem0 still follows the global
model pair; without a pair it inherits the product default unless explicit
`MEM0_LLM_MODEL` / `MEM0_LLM_BASE_URL` selects the legacy memory configuration.
