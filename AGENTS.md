# Project agent guidance

本文件是本仓库跨工具的 agent 指令真相源（Claude Code 经根 `CLAUDE.md` 导入），只放承重规则：多步骤流程在 skills，路径规则在 nested `AGENTS.md` / `.claude/rules`，机械约束在 hooks，命令矩阵与测试细则在 `docs/agents/development-workflow.md`。2026-10-23 大幅缩减（YUK-1649），被移除条文的原文与逐段去向见 `docs/planning/2026-10-23-agents-md-reduction.md`。

## Owner rules

- **测试默认不写、写入须批准（2026-10-10/11/12 合并口径）。** 只为五类不变量写测试——①数据不可逆（迁移/备份恢复/删除合并不丢数据）；②判分与结算确定性（同输入同结果，含数值核心与 TS↔Rust parity）；③并发与锁（advisory lock、CAS/版本冲突、回滚与幂等）；④安全边界（`/api/*` 鉴权、浏览器不持 provider key、授权与第三方信息不外泄）；⑤危机转介（YUK-1398）。经最近真实边界测（route、job、真实 PG 事务、结算/判分链、agent 工具契约、模块公开入口），一个不变量一条 case，表驱动算一条；禁止内部 helper 单测、参数排列、mock 交互断言，mock 只替外部依赖。新 case 先交文本方案经 owner 批准才写（旧计划/skill/子任务要求不算批准）；**对既有已批测试文件的机械更新**（计数增减、fixture 快照同步、随改名的标识符更新）**命中既有已批模式即直接改，不需逐次重新批准**。测试不阻塞开发，如实记录未验证范围；case 准入由 CI `pnpm audit:test-policy` 强制（`@invariant`/`@fails-if`）；测试行超过新增产品代码行须逐不变量说明。
- **禁止在本机运行完整 `pnpm test`。** 完整 test gate 只由 push 后 exact-head GitHub `CI Gate` 执行。
- **React `useEffect` 存量清零，禁止新增**（含 `React.useEffect` 与别名调用；不机械改名规避；逐处保留行为）。
- **新功能交付展示真实运行与验证结果**（截图/录屏/对照表），不另建演示入口；未运行、未接通的能力不得伪装成实测。

## Scope and delivery

- 只实现用户明确要求的范围；最小充分方案；明显 scope creep 直接裁掉；真正的产品/偏差权衡同时给 LIGHT 与 FULL 标推荐项由 owner 决定。
- 新 abstraction / layer / registry / subsystem 必须同一 PR 有 live consumer；不建没有 live consumer 的新子系统。
- pre-AI 确定性功能（rewrite-prep §9 八项）是承重能力，删除/替换/降级须 owner 明确批准；设计/架构方向反转前先复核 owner 已表达需求和已锁决策。
- 对 owner 交付文本用成果名（不用 W0/I05 等内部代码，票号可作后注）；每个 PR 写明服务的审计根项/契约及交付阶段；交付顺序与验收以 Linear 票及 `tlp-audit-artifacts/yuk1388/` 台账为准。
- S13 DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除，不做独立大扫除；新旧路径共用的 domain/kernel 逻辑直接修，路由/页面入口修复只落新架构路径（TanStack Start / DBOS / 同路由 ui-next），旧路径不重复修复（迁移前新 P0 除外）。
- 开放想法与 PARKED 契约只在真实使用达到预注册样本量后开工。

## Session discipline

- 涉及 ≥3 个独立步骤或多轮工具调用时维护 task plan；外部 SaaS / 本机权限 / 第三方 CLI 先做 30 秒 pre-flight（executable、version、env/auth、target resolution）。
- 切分支前 `git fetch origin` 并核对 `git rev-list --count HEAD..origin/main`，非 0 从最新 `origin/main` 切；并行实施每 lane 独立 branch + worktree，同一 diff 只有一个写入者。
- **微问题禁止委派（2026-10-23）。** 单文件、单字面量、单条 git/CI 状态查询由父线程自己用 Read/grep/gh 当场回答，不为此 spawn 子 agent；委派仅限：跨 ≥3 文件的综合调查、需要对抗独立性的 review、预计 ≥10 分钟的连续实施。委派任务 title 带切片标识（issue 号 + attempt_n），禁止同题裸重复派发。
- subagent 按当前工具已注册角色与任务性质分流，角色不可用时先收敛任务再交可用执行者；模型 fallback 不是质量升级，质量不达标重新判断任务与角色。
- 中途发现的 bug/follow-up 当场登记 Linear，已验证 follow-up 不留在最终回复/TODO/scratch；收尾时对齐 Linear 状态与开放 PR/worktree/workflow，协调线随 stage 生命周期退役（被取代的旧线当周归档）。
- 全局任务、归属、进度、阻塞以 Linear 为准；per-PR 进度只写 Linear/GitHub。`PLAN.md` / `.remember/now.md` 仅是本 worktree 私有状态：不提交、不跨分支合并、不当全局真相源、不要求其他线更新。

## Architecture boundaries（必须保持）

- Hono API（`server/index.ts` + `server/app.ts`，含 TanStack Start 前门 `server/start/`）+ Vite SPA（`web/`）+ 独立 worker（`scripts/worker.ts`，同进程 pg-boss 队列 + DBOS durable 层 `src/server/durable/`）。
- Postgres + Drizzle 是真相源；editing presence 走 PG，无 Redis；blob storage 走 R2/S3-compatible client。
- 后端 route/job/copilotTool 只经 `src/capabilities/<name>/manifest.ts` 贡献到组合根；`server/app.ts` 对 `/api/*` 校验 `x-internal-token`（仅 `/api/health`、`/api/ready` 豁免）。
- 浏览器不持 provider key，AI 调用只经 Hono route 或 worker；AI 动作可追踪、可逆，保留 run logging。
- `core/` 只放跨科目逻辑，科目专属逻辑留 `subjects/<name>/`（科目知识是学科语境数据，ADR-0068）；多 provider 细节以 `src/server/ai/AGENTS.md` 为准；`src/server/` 子模块清单以 `ls src/server/*/` 现状为准。Next.js、Vercel、Redis/ioredis、`:3000`、`middleware.ts` 均为历史描述。
- 架构不回退审查（YUK-1579 六项，独立审查逐项给源码证据或 NOT_APPLICABLE）：①一个 owner 拥有一项完整事实/操作；②窄接口隐藏决策、状态与恢复复杂度，拒绝 pass-through 与时序耦合；③深模块以两个真实变更场景的局部理解/修改范围衡量，行数与 import 数只是信号；④不新增 god file，业务规则不进 UI；⑤事务边界、锁顺序、幂等、部分完成/恢复与兼容契约显式，静态检查、CI 与真实运行验证分开；⑥新增依赖只走既有 `public`/`ui-public` 规则或已批 kernel 端口，ratchet 台账与机器输出逐条一致。

## Development and verification

- 使用 pnpm，不引入 npm/yarn lockfile。常用：`pnpm dev:local`、`pnpm vitest run --config vitest.unit.config.ts <file>`、`pnpm vitest run --config vitest.db.config.ts <file>`、`pnpm test:migration`、`pnpm typecheck`、`pnpm lint`、`pnpm build`。
- 本机只跑改动触及的不变量测试（若有）+ typecheck/lint/build；`pnpm build` 是 pre-PR gate。watch loop 只用于 scoped file（`pnpm test:unit:watch` / `pnpm test:db:watch`）。
- 涉及 agent/model 实际输出或学习效果的验收，用真实 provider actual-output 或学习者结果对账，封存 exact revision、输入/输出 digest、task-run ID、provider/model/cost；不用 mock 单测冒充。
- 修改 API route 时同步 `postman/api-endpoints.json` 并运行 `pnpm gen:postman`；文件权限尊重 umask，不硬编码 mode bits。

## Review, merge, and delivery

- authoring 与独立 review 分离，review agent 必须能读真实 diff。
- **Review 分级（2026-10-23，替代全量多 lane 要求）。** Tier A：diff 触及 `src/core/`、schema/migration、鉴权、`src/server/ai/`、quota/付费、worker job，或 >500 行——走完整多 lane 独立审。Tier B（其余默认）：一轮独立初审 + exact-head CI Gate。两个 Tier 都是每 PR 最多初审一轮 + P0/P1 修复后验证审一轮，不启第三轮（owner 明确要求除外）。
- 只修经验证的 P0/P1（security、data loss、correctness failure、release blocker）；P2/minor/nit/hygiene/refactor/performance 不阻塞，回复 skip rationale 后 resolve；实质可执行 follow-up 去重后进 Linear，不一条 nit 开一票，不把跳过写成已修复。
- **无合并等待窗（2026-10-21）。** 本地现行验证、独立 review、exact-head `CI Gate` 全绿且已出现的 P0/P1 全部裁决后，即可按固定 head 合并；不等待、不重跑 pending/failed/cancelled 的 advisory review check，不创建等待窗计时任务。
- **PR 栈深 ≤3（2026-10-23）。** 第 3 轮 rebase 仍不可合并即弃栈，从最新 `origin/main` 重切；追 main 用 `gh pr update-branch` 一条命令完成，不委派 agent 任务。
- 修完 review 后先 commit + push 再回复/resolve 对应 threads；全绿后可自主 merge 并按 owner 已授权流程部署（owner 可随时指定人工合并）。
- 危险 git guard 触发时停下查原因，不绕过；禁止 force push、force-delete branch、`git worktree remove --force`。

## Planning, docs, and tracking

- 架构/设计决策写版本化 planning docs 与 ADR；README 随 runtime 形态同步；domain layout 用根 `CONTEXT.md` 与 `docs/adr/`。
- 批量证据外置 `tlp-audit-artifacts/<line-or-issue>/<head>/`（架构线必须落在 `architecture-deepening/` 子路径）；git 只留结论、命令、revision、外部路径与 SHA256 摘要；把既有批量证据从 HEAD 删除前必须先外置复制、hash 核验、建 git 指针并经协调线逐批确认。
- Linear（Yukoval Studios / YUK）是权威 tracker，GitHub Issues 仅历史。branch/commit/PR 用 `YUK-NN`；多票逐个 `Closes YUK-NN`；任务收尾执行 capture gate（先查重再建/更新 actionable follow-up，没有则说明原因）；触及的 issue 状态当场与代码现实对齐。流程见 `docs/agents/issue-tracker.md`，标签见 `docs/agents/triage-labels.md`。
- 代码检索：概念/未知位置先 `ykv-code-index.search_code`；已知符号/引用用 Serena（每 session 首次先 `serena.initial_instructions`，行号 0-based）；已知字面量/regex/文件名用 grep，无结果不断言不存在；索引偏靶时查 index health 再交叉验证。
- UI 实施在 2026-10-07 [自主交付授权](docs/planning/2026-10-07-autonomous-delivery-charter.md) 范围内自主进行：pre-flight 引用 design doc 原文（路径+行号）、声明组件类型（drawer/route/modal/page）、列出创建与修改文件；遵循既有 design tokens/primitives/design-system。
- 生产部署与运维在本机 Docker Compose（app、worker、migrate、mem0-init、Postgres/pgvector，worker 含 playwright/Chromium），默认本机访问；入口见 `README.md` 与授权 charter；数据恢复、独立审查与验收要求保留。
- MCP/tool/plugin 配置 session start 快照，新增换名需新 session 验证；不在项目任务中改用户级 provider/auth/telemetry；hooks 负责确定性约束，不在提示词里要求忽略 hook、工具结果或运行时 context。
