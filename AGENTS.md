# Project agent guidance

本文件是本仓库跨工具的 agent 指令真相源。Claude Code 通过根
`CLAUDE.md` 导入本文件；工具专属的多步骤流程放在 skills，路径专属规则放在
nested `AGENTS.md` / `.claude/rules`，机械约束放在 hooks。

## Scope discipline

- 只实现用户明确要求的范围；不要擅自扩张成 MCP、Skill、Plugin 或完整 harness。
- 默认采用最小充分方案，不建没有 live consumer 的新子系统。
- 明显 scope creep 直接裁掉；真正的产品/偏差权衡同时给出 LIGHT 与 FULL，
  标推荐项，由 owner 决定。
- pre-AI 确定性功能是承重的一等能力；除非 owner 明确要求，不删除或降级。
- 设计/架构方向反转前先复核 owner 已表达的需求和已锁决策。

## Session and collaboration discipline

- 涉及至少 3 个独立步骤或多轮工具调用时维护 task plan。
- 外部 SaaS、本机权限或第三方 CLI 先做 30 秒 pre-flight：
  executable、version、required env/auth、target resolution；全通过再执行。
- Session start 先读 `PLAN.md`、`.remember/now.md`，需要时读
  `.remember/recent.md` / 当日 done 文件和 `MEMORY.md`。
- 单 session 只推动一条 active 线；全局态以 Linear + `PLAN.md` +
  `.remember/` 为准，不靠会话记忆。
- 中途发现的 bug/follow-up 当场写入 Linear 或 `PLAN.md` PARKED。
- 并行实施必须每 lane 独立 branch + worktree；不要让多个对等会话写同一工作树。
- 创建 subagent 时默认 Opus；fable 只用于终裁/最难验证，Sonnet 仅机械轻活，
  Haiku 基本不用。
- 收尾时对齐 `PLAN.md` 四栏、Linear 状态、`.remember` handoff、开放
  PR/workflow/worktree；需要落盘的看板更新必须 commit。

## UI design pre-flight

写任何 UI 代码前，先向用户提交并等待批准：

1. 逐字引用相关 design doc，给路径与行号/章节。
2. 声明组件类型：drawer / route / modal / page / other。
3. 列出将创建和修改的文件。

纯文档、纯后端、纯 schema、纯测试或已批准 plan 的实施步骤不适用。批准后仍须
遵循现有 design tokens、primitives 与 design-system 规则。

## Runtime and architecture

当前运行形态、端口、本地/NAS 设置和目录图以 `README.md` 为准；详细架构以
`docs/architecture.md`、`docs/modules/` 和当前 ADR 为准。

必须保持的当前边界：

- Hono API（`server/index.ts` + `server/app.ts`）+ Vite SPA（`web/`）+
  独立 pg-boss worker（`scripts/worker.ts`）。
- Postgres + Drizzle 是真相源；editing presence 走 PG，无 Redis。
- blob storage 走 R2/S3-compatible client。
- 后端 route/job/copilotTool 只能经
  `src/capabilities/<name>/manifest.ts` 贡献到组合根。
- `server/app.ts` 对 `/api/*` 校验 `x-internal-token`，仅
  `/api/health` 豁免。
- 浏览器不持 provider key；AI 调用只经 Hono route 或 worker。
- `core/` 只放跨科目逻辑；科目专属逻辑留在 `subjects/<name>/`。
- AI 动作须可追踪、可逆，并保留现有 run logging。
- `src/server/` 子模块精确清单以 `ls src/server/*/` 的当前输出为准，不硬编码数量。
- Next.js、Vercel、Redis/ioredis、`:3000`、`middleware.ts` 描述均为历史，
  除非当前代码或文档明确说明。
- 多 provider 细节以 `src/server/ai/AGENTS.md` 为准。

## Development and verification

命令矩阵、测试分区、audit 清单和 Postman 流程见
`docs/agents/development-workflow.md`。audit allowlist 的具体契约见
`audits-reference` skill；完整 test gate 的执行位置以下述约束为准。

常用本地入口：

```bash
pnpm dev:local
pnpm vitest run --config vitest.unit.config.ts <test-file>
pnpm vitest run --config vitest.db.config.ts <test-file>
pnpm test:migration
pnpm typecheck
pnpm lint
pnpm build
```

- 使用 pnpm；不要引入 npm/yarn lockfile。
- **禁止在本机运行完整 `pnpm test`**；完整 test gate 只由 push 后的 exact-head
  GitHub `CI Gate` 执行。本机不以 full `pnpm test` 作为 pre-PR 条件。
- 本机只运行与改动范围匹配的 scoped unit / DB / migration tests，以及
  `pnpm typecheck`、`pnpm lint`、`pnpm build`。
- UI/core/schema/prompt/parser 使用 scoped unit loop；API/DB/route/job 使用 scoped DB
  loop；migration SQL 使用 migration smoke。
- watch loop 只用于 scoped file：unit 用 `pnpm test:unit:watch <test-file>`，DB 用
  `pnpm test:db:watch <test-file>`。
- `pnpm build` 必须作为本机 pre-PR gate，负责捕获 tsc/Biome/Vitest 未覆盖的 bundle
  错误。
- 修改 API route 时同步 `postman/api-endpoints.json` 并运行
  `pnpm gen:postman`。
- 文件权限必须尊重 umask；不要硬编码 mode bits。

## Planning and documentation

- 架构/设计决策写入版本化 planning docs 与 ADR。
- `PLAN.md` 是 ≤200 行的活看板，不是日志：头部只留最新一条更新；过期叙事滚存
  到 `.remember/` 或 `docs/planning/`；四栏就地改写，不能靠追加对冲。
- README 是当前 stack 与本地/NAS 入口；runtime 形态改变时同步更新。
- Single-context domain layout 使用根 `CONTEXT.md` 与 `docs/adr/`。

## Linear issue tracking

Linear（Yukoval Studios / YUK）是新规划和跟进的权威 tracker；GitHub Issues 只保留
历史用途。完整流程见 `docs/agents/issue-tracker.md`，标签见
`docs/agents/triage-labels.md`。

- branch、commit、PR 使用 `YUK-NN`；多 issue 时逐个重复
  `Closes YUK-NN`，不要写 `Closes YUK-1 + YUK-2`。
- 实施、审计、规划或迁移任务结束前执行 Linear capture gate：
  先搜索重复，再创建/更新本次发现的 actionable follow-up；若没有，明确说明原因。
- 触及的 issue 状态必须当场与代码现实对齐，不留虚假的 In Progress。
- 已验证 follow-up 不得只留在最终回复、TODO 或 scratch doc。

## Code search

- 未知位置/概念检索先用 `ykv-code-index.search_code`。
- 已知符号、引用或文件结构用 Serena；每 session 首次使用先调用
  `serena.initial_instructions`。
- grep/rg 用于已知字面量、regex 和文件名；grep 无结果不能直接断言不存在。
- 索引结果明显偏靶时检查 index health，再用其他检索面交叉验证。
- Serena 行号为 0-based。

## Tooling and settings

- MCP/tool/plugin 配置在 session start 时快照；新增或换名后需新 session 才能验证。
- 不在项目任务中修改用户级 provider/auth/telemetry 配置。
- 用户级 Claude settings 若受 self-modification 保护，给用户精确 diff；项目级
  `.claude/settings.json` 可直接修改。
- hooks 负责确定性约束；AGENTS/skills 负责行为和流程。不要在提示词里要求忽略
  hook、工具结果或运行时 context。

## Deployment

生产为 NAS docker compose：app、worker、migrate、Postgres/pgvector 和
Cloudflare Tunnel。无 Vercel、无 Redis。部署细节与验证命令以 `README.md` 为准。

## Review, merge, and delivery

- authoring 与独立 review 分离；review agent 必须能读取真实 diff。
- **Review budget（owner 2026-07-30 拍板）**：自动 review 是 advisory，不是 CI correctness
  gate。每个 PR 最多一轮初审 + 一轮 P0/P1 修复后的验证审；push 后出现的新 bot review
  不重置预算，除非 owner 明确要求，不得启动第三轮。
- 只在当前 PR 修复经验证的 P0/P1：security、data loss、correctness failure、release
  blocker。P2/minor/nit/hygiene/refactor/performance 默认不阻塞：回复 skip rationale 后
  resolve；只有实质且可执行的 follow-up 才在去重后进 Linear，不得一条 nit 开一个
  issue，也不得把跳过写成已修复。
- exact-head `CI Gate` 绿色且没有未裁决的 P0/P1 后，不等待、不重跑 pending / failed /
  cancelled / timed-out 的 OCR、PR-Agent、Codex、CodeRabbit 等 advisory review check。
- 修复 PR review 后，在 commit + push 后回复/resolve 对应 review threads；跳过的非阻塞
  finding 可回复 rationale 后 resolve，不能声称已修复。
- 本机 scoped 验证与 typecheck/lint/build、独立 review，以及 push 后 exact-head
  GitHub `CI Gate` 全绿后可自主 merge，并按 owner 已授权流程部署；owner 可随时指定
  人工合并。
- 危险 git guard 被触发时停下查原因，不绕过；不要 force push、force-delete branch、
  或 `git worktree remove --force`。
