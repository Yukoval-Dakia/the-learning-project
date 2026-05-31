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

<!-- context7 -->
Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Steps

1. Always start with `resolve-library-id` using the library name and the user's question, unless the user provides an exact library ID in `/org/project` format
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question). Use version-specific IDs when the user mentions a version
3. `query-docs` with the selected library ID and the user's full question (not single words)
4. Answer using the fetched docs
<!-- context7 -->

<!-- init-deep:START (generated 2026-05-31, 44eeca1a@main) -->
## CODEBASE MAP

> 导航索引。深层细节看子目录 `AGENTS.md` + 各 `README.md`。架构权威 = [docs/architecture.md](./docs/architecture.md)、决策 = [docs/adr/](./docs/adr/)、领域术语 = [CONTEXT.md](./CONTEXT.md)、命令/约定 = [CLAUDE.md](./CLAUDE.md)。

### OVERVIEW
`loom` —— self-hosted 单用户 AI 学习系统。Next.js 15 App Router + Postgres/Drizzle + pg-boss worker。**事件驱动核**（ADR-0006 v2）：`material × learning_session × event` 三表，AI 是与用户对等的 event actor。

### STRUCTURE
```
app/             # App Router: (app)/(admin) 页面 + api/ 后端（唯一后端面）
src/
  core/          # 跨学科：Zod schema、capability registry、id helpers（无 IO）
  db/            # Drizzle schema.ts + Postgres client（单 schema 文件）
  ai/            # 浏览器侧 task registry + prompt builder（不持 key、无通用 runTask）
  server/        # server-only：ai runner/tools, ingestion, knowledge, review, artifacts...（22 子模块）
  subjects/      # 单学科 bundle：wenyan / math / physics
  ui/            # 共享 React 设计系统
scripts/         # worker 入口 + 迁移 + audit + local dev（一等公民）
drizzle/         # 迁移 SQL + meta 快照（DB 演化历史）
docs/            # architecture / adr / modules / design / agents
```
`core/` 跨学科、`subjects/<name>/` 单学科特化——别把学科逻辑漏进 `core/` 或 `server/`。**不是 monorepo**（单 package.json）。

### WHERE TO LOOK
| 任务 | 位置 |
|------|------|
| 后端逻辑 / API | `app/api/**`（见 [app/api/AGENTS.md](./app/api/AGENTS.md)）|
| AI task 调用 / tool / runner | `src/server/ai/`（见 [AGENTS.md](./src/server/ai/AGENTS.md)）；注册表 `src/ai/registry.ts` |
| 后台 job / cron | `src/server/boss/handlers/`（见 [AGENTS.md](./src/server/boss/handlers/AGENTS.md)）|
| OCR / 试题抽取 / rescue | `src/server/ingestion/`（见 [AGENTS.md](./src/server/ingestion/AGENTS.md)）|
| 知识树 / mesh / 复习 | `src/server/knowledge/`（见 [AGENTS.md](./src/server/knowledge/AGENTS.md)）|
| DB schema / 迁移 | `src/db/schema.ts` + `drizzle/`（见 [src/db/README.md](./src/db/README.md)）|
| Zod 业务 schema / event union | `src/core/schema/`（见 [AGENTS.md](./src/core/schema/AGENTS.md)）|
| UI 组件 / 设计系统 | `src/ui/`（见 [AGENTS.md](./src/ui/AGENTS.md)）|
| server 模块总览 | [src/server/AGENTS.md](./src/server/AGENTS.md) |
| 运维 / 迁移 / audit 脚本 | `scripts/*.ts` |

### COMMANDS（详见 CLAUDE.md）
```bash
pnpm dev:local        # 推荐本地入口（compose Postgres :5433 为真相源）
pnpm typecheck        # tsc --noEmit
pnpm lint             # biome check .
pnpm test             # 全量门禁：audit:profile + unit + db + migration
pnpm test:unit:watch  # 快速无-DB watch（UI/core/schema/parser）
pnpm test:db:watch    # DB/API watch（需 Docker/OrbStack）
pnpm build            # next build —— 抓 tsc/biome/vitest 都漏的 route export 校验
```
PR 前还需：`pnpm audit:schema` / `audit:partition` / `audit:profile`。

### CONVENTIONS（仅本项目偏离项）
- 工具链：**仅 Biome**（无 ESLint/Prettier）——2 空格 / 100 列 / 单引号 / 自动整理 imports；`noExplicitAny` + `useImportType` 为 warning。TS strict + ESM + `@/*`→`src/*`。
- Next：`output:'standalone'`，外置 `pg`/`pg-boss`；**无 Vercel**——别带 `.vercel/` / `vercel env pull` 假设。
- 测试分区严格：依赖 DB/drizzle/postgres/PgBoss 的测试**禁止**放进 unit config；命名 `*.unit.test.ts` / `*.integration.test.ts` / `*.test.ts`。DB 测试用 `tests/global-setup.ts` 起 testcontainers（`pool:forks` + `singleFork`，共享容器）。
- 无 coverage gate；但有 schema/partition/profile audit lint。
- 文件 mode 别硬编码（`0o644`）——尊重 umask（`0o666 & ~umask`）。

### ANTI-PATTERNS (THIS PROJECT)
- **破坏性 AI 动作没有直接 write tool**：删错题 / 合并节点 / reparent / archive 只能 `propose`，用户 accept route 才执行真实 mutation。
- 别经 generic `/api/ai/[task]` 暴露 profile-driven / manual-rescue / tool task——走领域 route 或 worker（仅 `ReviewIntentTask` 走 generic 入口）。
- 浏览器代码**不持** provider key——所有 AI 调用走 route handler 或 worker。
- 别把派生 lifecycle 字段回写源表——建 reader / projection。
- 别引入第二个具体实例之前的抽象（YAGNI）；bug fix 不顺手 refactor。
- 加新表/字段必须有 write path，否则进 `scripts/audit-schema-allowlist.json` 标注可检查解除条件。
<!-- init-deep:END -->
