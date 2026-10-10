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

## Delivery stages and anti-slop rules (YUK-1388)

- 对 owner 的交付文本用成果名，不用 W0/W1、I05、M073 等内部代码；票号可随后作参考。
  阶段与内部波次对应如下：
  - 第一天能用（W0）
  - 帮助靠谱（W1）
  - 按真实时间安排（W2）
  - 说清不知道并检验（W3）
  - 证明有效（W4）
- 交付顺序与验收以 Linear 票及仓库外绝对路径 artifact 为准：
  `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1388/stage4/I02/waves-v1.md`。
- 新 abstraction、layer、registry 或 subsystem 必须在同一 PR 有 live consumer。
- 每个 PR 写明服务的审计根项或契约及交付阶段；不属于任何阶段的工作，只限新 P0
  或 owner 明确要求。
- S13 DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除，不做独立大扫除；
  新代码不得继续扩展这些对象。
- 删除或替换 rewrite-prep §9 的 8 项 pre-AI 承重能力，须 owner 明确批准；
  未获批准时只做 demote。
- 开放想法与 PARKED 契约，只有真实使用达到预注册样本量后才开工。
- 功能修复落在新架构路径（TanStack Start / DBOS / 同一路由的 ui-next）；
  不在旧路径重复修复，除非 owner 在该页面迁移前实际遇到 P0。

## Session and collaboration discipline

- 涉及至少 3 个独立步骤或多轮工具调用时维护 task plan。
- 外部 SaaS、本机权限或第三方 CLI 先做 30 秒 pre-flight：
  executable、version、required env/auth、target resolution；全通过再执行。
- Session start 先读 `PLAN.md`、`.remember/now.md`，需要时读
  `.remember/recent.md` / 当日 done 文件和 `MEMORY.md`。
- 切分支前先 `git fetch origin` 并核对 `git rev-list --count
  HEAD..origin/main`；非 0 就从最新 `origin/main` 切，不从本地 HEAD 切。
- 单 session 只推动一条 active 线；全局态以 Linear + `PLAN.md` +
  `.remember/` 为准，不靠会话记忆。
- 中途发现的 bug/follow-up 当场写入 Linear 或 `PLAN.md` PARKED。
- 并行实施必须每 lane 独立 branch + worktree；不要让多个对等会话写同一工作树。
- 创建 subagent 时按当前工具**已注册**角色与任务性质分流：实施路径和验收已定的
  机械修改给 Fixer；目标明确但需本地调查、局部方案或调试的非 UI 实施给
  Implementer；UI 交互与视觉给 Designer；高风险架构决策和独立复核给 Oracle。
  角色不可用时由编排者先收敛任务，再交给可用执行者；同一 diff 不派两个写入者。
- 具体模型、variant 和请求故障回退由当前工具配置决定；代码质量不达标须重新
  判断任务与角色，不把模型 fallback 当作质量升级。
- 收尾时对齐 `PLAN.md` 四栏、Linear 状态、`.remember` handoff、开放
  PR/workflow/worktree；需要落盘的看板更新必须 commit。

## UI design pre-flight

2026-10-07 owner 持续委托见 [自主交付授权](docs/planning/2026-10-07-autonomous-delivery-charter.md)。本委托范围内，agent 在实施前记录以下 pre-flight 并承担方案与验收责任，不再等待 owner 逐项批准；owner 后续限制优先。未获此委托的工作仍须先提交并等待批准：

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
  `/api/health` 与 `/api/ready` 豁免。
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
- **默认不写测试（owner 2026-10-10，YUK-1401）。** 只有改动触及下列不变量时才写或
  更新测试，且断言必须在该不变量被破坏时真的失败：
  1. 数据不可逆：迁移、备份恢复不丢列、删除/合并不丢数据；
  2. 判分与结算的确定性：同输入同分数/同状态，含数值核心与 TS↔Rust parity；
  3. 并发与锁：advisory lock、CAS/版本冲突、事务回滚与幂等重试；
  4. 安全边界：`/api/*` 鉴权与豁免、浏览器不持 provider key、授权与第三方信息不外泄；
  5. 危机转介（YUK-1398）。
- 五类不变量优先于下面的排除项：helper、DTO、UI 行为若承载上述不变量（如确定性
  判分、幂等、隐私隔离），仍按不变量写测试。除此之外不写：只验证 UI/组件渲染、
  DTO/schema 形状、prompt/文案/快照/字节 hash、源码路径与文档结构、实现细节，或只断言
  “被调用/存在”的测试，以及为覆盖率补的测试。
  修 bug 时若不触及上面五类，用 typecheck/build 和真实运行验证，不补回归测试。
- 涉及 agent/model 实际输出或学习效果的验收，用真实 provider actual-output 或学习者
  结果对账，并封存 exact revision、输入/输出 digest、task-run ID、provider/model/cost；
  不用 mock 单元测试冒充。
- 本机只运行改动触及的不变量测试（若有），以及 `pnpm typecheck`、`pnpm lint`、
  `pnpm build`。
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

2026-10-07 起 owner 指定生产部署与运维在这台 Mac，沿用 Docker Compose 的 app、worker、migrate 和 Postgres/pgvector，默认本机访问。Cloudflare Tunnel / NAS 是可选历史部署方式，不是当前发布目标。部署授权持续有效，数据恢复、独立审查与验收要求仍保留。当前入口见 `README.md` 和[自主交付授权](docs/planning/2026-10-07-autonomous-delivery-charter.md)。

## Review, merge, and delivery

- authoring 与独立 review 分离；review agent 必须能读取真实 diff。
- **Merge 等待窗（owner 2026-10-06 更新）**：所有 review bot 均已结束且无 findings 时，可免除等待窗；owner 2026-10-08 补充：修复已超过一轮且最新一轮无 P1 时，也可免除 ~17 分钟等待窗；其余 gate 和既有 P0/P1 裁决要求不变。否则从最后一次 push 起等待至少 ~17 分钟，给 advisory review（Codex/CodeRabbit）发出时间。免等待仅影响时间条件，本地验证、独立 review、exact-head CI Gate 与 P0/P1 裁决要求仍适用。等待窗内已发出的 P0/P1 必须裁决（回复 + 修或 rationale-skip）才可 merge；等待窗结束后再出现的新 review 不重置，但不得无视既有 P0/P1。
- **Review budget（owner 2026-07-30 拍板）**：自动 review 是 advisory，不是 CI correctness
  gate。每个 PR 最多一轮初审 + 一轮 P0/P1 修复后的验证审；push 后出现的新 bot review
  不重置预算，除非 owner 明确要求，不得启动第三轮。
- 只在当前 PR 修复经验证的 P0/P1：security、data loss、correctness failure、release
  blocker。P2/minor/nit/hygiene/refactor/performance 默认不阻塞：回复 skip rationale 后
  resolve；只有实质且可执行的 follow-up 才在去重后进 Linear，不得一条 nit 开一个
  issue，也不得把跳过写成已修复。
- exact-head `CI Gate` 绿色且没有未裁决的 P0/P1 后，不等待、不重跑 pending / failed /
  cancelled / timed-out 的 Codex、CodeRabbit 等 advisory review check。
- 修复 PR review 后，在 commit + push 后回复/resolve 对应 review threads；跳过的非阻塞
  finding 可回复 rationale 后 resolve，不能声称已修复。
- 本机 scoped 验证与 typecheck/lint/build、独立 review，以及 push 后 exact-head
  GitHub `CI Gate` 全绿后可自主 merge，并按 owner 已授权流程部署；owner 可随时指定
  人工合并。
- 危险 git guard 被触发时停下查原因，不绕过；不要 force push、force-delete branch、
  或 `git worktree remove --force`。
