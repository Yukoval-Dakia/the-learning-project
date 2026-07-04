# AGENTS.md instructions for /Users/yukoval/yukoval-projects/the-learning-project

- 始终以中文为主回复；即便用户用英文提问，也默认中文回答。除非用户明确要求使用其他语言。
- Issue tracker 用 Linear：PR / commit 写 `YUK-XX`，分支优先用 Linear 的 `yuk-xx-...` 格式；新工作不要用裸 `#N`。详细规则见 `docs/agents/issue-tracker.md`。
- Codex 项目级 hooks 在 `.codex/hooks.json`，镜像 Claude 侧 `.claude/settings*.json` 关键约束（直接复用 `.claude/hooks/*` 脚本，不重复实现）：
  - Codex 当前 `PreToolUse` / `PostToolUse` 只可靠匹配 Bash；编辑类检查保持轻量：SessionStart 记录 baseline，Stop hook (`.codex/hooks/codex-stop-edit-check.mjs`) 只检查本会话新增/变化的 dirty JSON 可解析性，不在 Stop 阶段自动跑 Biome
  - Bash workflow guard (`.codex/hooks/codex-bash-workflow-guard.mjs`) 给全仓 gate 加摩擦：`pnpm lint` / `pnpm test` / `pnpm build` 默认阻止，明确收尾时用 `CODEX_FULL_GATE=1 pnpm <script>`；同时阻止 `git add .` / `git commit` 带入 zip/tar/dmg/大文件等 artifact
  - Bash 中禁止危险 git 操作 (`.claude/hooks/git-guard.mjs`)：force push、force delete branch、main/master 上 commit、force remove worktree
  - Linear-tracked branch (yuk-*/foundation-*/p\<N\>-*) 上 commit 必须含 `YUK-NN`，多个 issue 必须逐个重复 Linear keyword（例如 `Closes YUK-27` + `Closes YUK-28`，不要写 `Closes YUK-27 + YUK-28`）(`.claude/hooks/linear-guard.mjs`)
  - `git fetch` / `git pull` 后 echo upstream divergence + 上游 author (`.claude/hooks/post-fetch-divergence.sh`)
- ⚠️ Codex 项目 Stop hook 只承担编辑检查；Claude 侧的 `linear-closeout-reminder.sh` 没有迁移到 Codex hooks，在 codex 会话里**不会自动跑**。codex 会话交付前请手动按 `docs/agents/issue-tracker.md` "Closeout issue capture gate" 检查 Linear 状态同步。
- 如果 hooks 尚未被当前 Codex 会话加载或 trust，仍需手动遵守上述约束，并在交付前对 touched files 运行等价检查。

## Agent 记忆契约（mem0 fusion · SPIKE）

> 适用对象：**编码 agent 跨会话的项目记忆**，不是 loom 产品的学习者事实层。repo 里有两个 mem0，严禁混用。

三层所有权，**每条事实只有一个家，禁止双写**：

1. **产品事实层（既有，碰都不碰）** — `mem0ai/oss` + pgvector，collection `learning_project_memories`（ADR-0017，`src/server/memory/`）。这是 **loom 的功能**，记学习者的学习事件。Agent 记忆**绝不写入此 collection**，也不直接调它的 write path（学习者事实只经 worker `memory_event_ingest`）。
2. **Agent 宪法** — Magic Context `ctx_memory` / `<project-memory>`。少量、高重要性、**每会话必注入**的项目不变量：模型路由、gateway 配置、架构 invariant、硬约束。
3. **Agent 情景记忆** — mem0 **hosted** cloud（`mcp.mem0.ai`，独立云账户）。高频长尾事实：代码位置、一次性发现、per-feature 决策、bug 根因。语义 top-k 按需召回。

**写入路由：**
- 代码位置 / 情景事实 / 某处怎么实现 → mem0 hosted（MCP `add`）。
- 项目不变量 / 路由规则 / 跨会话硬约束 → `ctx_memory`。
- 产品学习者事实 → 只经 ADR-0017 write path，agent 不直接写。

**晋升单向**：mem0 情景 → 宪法（高频/高置信的少数条目手动提升），**永不反向**。晋升机器未建（spike 阶段）。

**权衡（H 决定）**：agent 情景记忆数据**出本机进 mem0 云**——这是对 agent 记忆的有意例外；产品事实层仍 local-first 不变。hosted key 放 `~/.config/opencode/opencode.json`（全局配置，不进项目 git），不写入本仓任何文件。

**SPIKE 目标**：验证 mem0 hosted 语义召回是否真比 Magic Context `ctx_search` 强。不强则拔掉 MCP，省得白养一套。

<!-- context7 -->
Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Steps

1. Always start with `resolve-library-id` using the library name and the user's question, unless the user provides an exact library ID in `/org/project` format
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question). Use version-specific IDs when the user mentions a version
3. `query-docs` with the selected library ID and the user's full question (not single words)
4. Answer using the fetched docs
<!-- context7 -->

<!-- init-deep:START (generated 2026-07-03, 614a62c2@workflow/upgrade-ocr-idempotency-v2) -->
## CODEBASE MAP

> 导航索引。深层细节看子目录 `AGENTS.md` + 各 `README.md`。架构权威 = [ARCHITECTURE.md](./ARCHITECTURE.md)、[docs/architecture.md](./docs/architecture.md)、决策 = [docs/adr/](./docs/adr/)、领域术语 = [CONTEXT.md](./CONTEXT.md)、命令/约定 = [CLAUDE.md](./CLAUDE.md)。

### OVERVIEW
`loom` —— self-hosted 单用户 AI 学习系统。当前运行形状（YUK-321 M5 后）：**Hono API (`server/`, :8787) + Vite SPA (`web/`, :5173) + pg-boss worker (`scripts/worker.ts`)** 三进程。Postgres + Drizzle，R2/S3 blob，Claude Agent SDK。事件驱动核（ADR-0006 v2）：`event` 表是统一 action log，AI 是与用户对等的 actor。

### 新栈两棵树（M0 起）
```
server/          # Hono API 入口（index.ts）+ 组合根工厂（app.ts）+ env 加载
web/             # Vite SPA（TanStack Router + React 19 + Tailwind v4）
src/
  kernel/        # CapabilityManifest 契约 + validateComposition
  capabilities/  # Capability 包：manifest.ts 声明路由 / jobs / copilotTools / ui.pages
    agency/      # 能动编排：夜链 + goal scope 提议 + agent-notes
    copilot/     # Copilot 单人格对话面 + 工具贡献
    ingestion/   # 录入域：OCR / Vision rescue / 抽取 / 入库
    knowledge/   # 知识图谱域：树 + mesh + 提议 + 归因
    notes/       # Note artifact 域：block-tree 编辑器 + Living Note refine
    observability/ # AI 可观测性：admin 四页 + 今日成本条
    practice/    # 练习域：review / quiz / judge / paper / 题库
    shell/       # 工作台壳层：收件箱 + Today + Coach
  core/          # 跨学科 Zod schema、capability registry、id helpers（无 IO）
  db/            # Drizzle schema.ts + Postgres client
  ai/            # 浏览器侧 task registry + prompt builder（不持 key）
  server/        # 旧 server-only 业务层（采石场：仍运行，逐步迁入 capabilities）
  subjects/      # 单学科 bundle：wenyan / math / physics
  ui/            # 共享 React 设计系统
scripts/         # worker.ts + migrate.ts + dev-local.ts + audits
drizzle/         # 迁移 SQL + meta 快照
docs/            # architecture / adr / modules / design / agents / superpowers
```
**不是 monorepo**（单 package.json）。`core/` 跨学科；`subjects/<name>/` 单学科特化；别把学科逻辑漏进 `core/` 或 `server/`。

### WHERE TO LOOK
| 任务 | 位置 |
|------|------|
| 后端 API / 组合根 | [server/AGENTS.md](./server/AGENTS.md)、`server/app.ts`、`server/index.ts` |
| SPA / 路由 / 壳层 | [web/AGENTS.md](./web/AGENTS.md)、`web/src/router.tsx` |
| capability 契约 | [src/kernel/AGENTS.md](./src/kernel/AGENTS.md)、`src/kernel/manifest.ts` |
| capability 包总览 | [src/capabilities/AGENTS.md](./src/capabilities/AGENTS.md)、`src/capabilities/index.ts` |
| 录入 / OCR / rescue | `src/capabilities/ingestion/AGENTS.md` |
| 知识树 / mesh / 提议 | `src/capabilities/knowledge/AGENTS.md` |
| 练习 / 判分 / 组卷 | `src/capabilities/practice/AGENTS.md` |
| Note / artifact | `src/capabilities/notes/AGENTS.md` |
| Copilot / 对话 / 工具 | `src/capabilities/copilot/AGENTS.md` |
| 夜链 / 能动性 | `src/capabilities/agency/AGENTS.md` |
| 可观测性 / admin | `src/capabilities/observability/AGENTS.md` |
| 工作台 / 收件箱 | `src/capabilities/shell/AGENTS.md` |
| 旧 server 模块总览 | [src/server/AGENTS.md](./src/server/AGENTS.md) |
| AI runner / tool / MCP bridge | [src/server/ai/AGENTS.md](./src/server/ai/AGENTS.md) |
| pg-boss job catalog | [src/server/boss/handlers/AGENTS.md](./src/server/boss/handlers/AGENTS.md) |
| DB schema / 迁移 | `src/db/schema.ts` + `drizzle/`（见 [src/db/README.md](./src/db/README.md)）|
| Zod 业务 schema / event union | [src/core/schema/AGENTS.md](./src/core/schema/AGENTS.md) |
| UI 组件 / 设计系统 | [src/ui/AGENTS.md](./src/ui/AGENTS.md) |
| 学科 bundle | `src/subjects/<name>/` |
| 运维 / audit 脚本 | `scripts/*.ts` |

### COMMANDS（详见 CLAUDE.md）
```bash
pnpm dev:local        # 推荐本地入口：spawn api(:8787) + web(:5173) + worker
pnpm rw:api           # tsx watch server/index.ts（RW_WORKER=1 同进程启 worker）
pnpm rw:web           # vite --config web/vite.config.ts
pnpm worker:dev       # 独立 pg-boss worker 进程
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm test             # 全量门禁：audit:profile + audit:draft-status + unit + db + migration
pnpm test:unit:watch  # 快速无-DB watch
pnpm test:db:watch    # DB/API watch（需 Docker/OrbStack）
pnpm build            # rw:web:build + esbuild 三产物（server/worker/migrate .cjs）
```
PR 前还需：`pnpm audit:schema` / `audit:partition` / `audit:profile` / `audit:draft-status`。

### CONVENTIONS（仅本项目偏离项）
- 工具链：**仅 Biome**（无 ESLint/Prettier）——2 空格 / 100 列 / 单引号 / 自动整理 imports；`noExplicitAny` + `useImportType` 为 warning。TS strict + ESM + `@/*`→`src/*`。
- 后端 surface = capability `manifest.ts` → `src/capabilities/index.ts` 静态组合根 → `server/app.ts` 循环挂载。不再有 `app/api/**` Next.js route handler 壳。
- 测试分区严格：依赖 DB/drizzle/postgres/PgBoss 的测试**禁止**放进 unit config；新栈约定 `src/kernel/**` / `src/capabilities/**` 的 `*.unit.test.ts` 自动进无 DB 快车道，`*.db.test.ts` 自动进 testcontainer 车道。
- 无 Vercel / Redis；editing presence 走 PG 表 `editing_presence`。
- 文件 mode 别硬编码——尊重 umask（`0o666 & ~umask`）。

### ANTI-PATTERNS (THIS PROJECT)
- **破坏性 AI 动作没有直接 write tool**：删错题 / 合并节点 / reparent / archive 只能 `propose`，用户 accept route 才执行真实 mutation。
- 别经 generic `/api/ai/[task]` 暴露 profile-driven / manual-rescue / tool task——走领域 route 或 worker。
- 浏览器代码**不持** provider key——所有 AI 调用走 Hono route 或 pg-boss worker。
- 别把派生 lifecycle 字段回写源表——建 reader / projection。
- capability 包间禁深层 import，走 manifest 公共接口。
- bug fix 不顺手 refactor。
- 加新表/字段必须有 write path，否则进 `scripts/audit-schema-allowlist.json` 标注可检查解除条件。
<!-- init-deep:END -->
