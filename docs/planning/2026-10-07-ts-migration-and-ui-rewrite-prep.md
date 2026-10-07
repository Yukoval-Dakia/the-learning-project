# TS 全栈迁移与前端重写：准备计划

日期：2026-10-07（Asia/Tokyo）。状态：**准备完成，未开始实施**。
决定者：agent，依据[自主交付授权](2026-10-07-autonomous-delivery-charter.md)作出；owner 后续限制优先。
Epic：[YUK-1351](https://linear.app/yukoval-studios/issue/YUK-1351)。第一道 gate：[YUK-1338](https://linear.app/yukoval-studios/issue/YUK-1338)。
目标架构：[ADR-0066](../adr/0066-typescript-adaptive-learning-architecture.md)（ADR-0065 是 Pi execution ADR）。

本文件只做规划与票据。不含代码、依赖变更、schema 变更或部署。

## 1. 起点（2026-10-07 核查）

- 运行形态：Hono API（`server/index.ts` + `server/app.ts`）+ Vite SPA（`web/`）+ pg-boss worker（`scripts/worker.ts`），
  本机 Docker Compose（app/worker/migrate + 外部 Postgres/pgvector），115 项迁移。
- 后端贡献入口：9 个 capability（`src/capabilities/*/manifest.ts`），其中 7 个声明 `jobs`；
  housekeeping cron 另在 `src/server/boss/handlers.ts`。Postman 清单约 73 个端点。
- 前端：`web/src/router.tsx` 约 27 个 surface（today、record、practice、questions、notes、knowledge、coach、admin-* 等）
  + 根挂 CopilotDock；`src/ui/primitives/` + `web/src/globals.css`（约 1.58 万行）承载 Loom 视觉。
  SPA 已使用 `@tanstack/react-router` 与 `@tanstack/react-query`（React 19），路由迁到 TanStack Start 是同家族升级，不是换框架。
- AI：Pi `agentLoop` 已是唯一 chat/agent 执行适配器（main ADR-0065）；Pi + DBOS 步骤级恢复未验证。
- 行为基线：[连续学习系统行为设计](../design/2026-10-06-continuous-learning-system-behavior.md)；
  §4.4 末尾明确导航数量、路由和视觉布局未锁定。

## 2. 关键决定：迁移与重写按路由合并交付

**决定（agent）**：采用 **route-by-route 合并**——每条迁到 TanStack Start 的路由同时上线重写后的 UI；
页面背后的业务操作与任务族在同一波次切换。

理由：
1. 分两条线意味着旧 UI 先被移植到 TanStack（纯搬运），再被重写一次，每个页面验收两遍，工作量约翻倍。
2. 行为设计 §4 要求的变化（工作台三位置关系、首页"回来时"、带版本通知后重读已提交状态）本来就要改数据加载方式；
   新 UI 正好用 TanStack loader/server function 设计，不必先适配旧的 SPA fetch 模式。
3. 一次验收即可覆盖"新栈 + 新 UI + 业务操作 + 任务恢复"，回退开关也按路由一个。

代价与对冲：单个波次更大、UI 与后端耦合排期。对冲方式是**同一竖切拆两张票、两个 PR**
（后端非 UI → UI），各自独立 worktree，后端 PR 先合且旧 UI 仍可用。

| 取舍 | LIGHT | FULL（推荐） |
| --- | --- | --- |
| 管理面 `admin-*` | 迁移时只套新设计系统，不做视觉重设计 | 同 LIGHT——管理面不值得额外视觉投入，两档在此一致 |
| 首个竖切 | 只做示踪路由 `/mistakes`（以读为主），不碰 DBOS | 示踪路由 + 作答闭环（P4）——直接验证 ADR 核心行为 |
| Hono 去留 | 永久保留 Hono 挂在 `/api/*` | P7 用迁移期证据裁决，写 ADR |

## 3. Strangler 与切换：本机生产不停

1. **前门（P1）**：Web 进程改由 TanStack Start（固定 RC 版本）承载；现有 Hono app 原样经 catch-all server route
   `app.fetch(request)` 挂在 `/api/*`；未迁页面由旧 Vite SPA 产物回落。worker 不变。
   回退 = Compose 换回旧 app 镜像（P1 无 schema 变更，回退安全）。挂载不可行时退到两进程 + 本机路径分流，须先记录失败证据。
2. **按路由切换**：每条迁移路由带一个服务端开关，可把该路径切回旧 SPA 页面；保留到本机真实使用一周无 P0/P1 后删除旧页面代码。
3. **生产变更顺序**：沿用授权文件——恢复副本上先跑全部迁移和开关切换 → 停全部 writer → 最终备份 → 迁移生产 → 恢复 worker → 恢复 app。
   不得对私有 Compose 运行 `down`/`--remove-orphans`/`down -v`；发布持 `deployment.lock`。
4. **schema 只做 expand/contract**：新增在前，删除（含 pg-boss 表）只在 P7、且在备份与副本演练之后。

## 4. pg-boss → DBOS：任务迁移与数据安全

不变量（ADR-0066）：每个任务在任一时刻**只有一个**持久执行机制负责恢复；
DBOS 不恢复 ADR-0052 否决的通用 callback 业务壳；业务的事务边界、回执、幂等单位与完成条件仍归业务模块。

- **单位**：以 capability manifest 的 `jobs` 声明为任务族；manifest 增加执行后端字段（pg-boss | dbos），由组合根注册，
  不在 manifest 外另建注册表。housekeeping cron 归入对应族或独立一族。
- **台账（P5 第一步）**：队列名、cron/tz、DLQ、生产者、ADR-0052 持久交接义务（例如 memory reconcile 的 deterministic job ID 与 outbox recovery）、幂等单位。
- **逐族切换**：生产者改投 DBOS → 旧队列只消费不接收 → 排空（retry/DLQ 逐条裁决，不删队列、不盲目重试）→ 注销 pg-boss cron 与 handler。
  cron 在同一发布中只存在一侧，并有测试证明不双跑（参照现有 `knowledge_maintenance_nightly` 不重复调度的测试）。
- **DBOS 系统表**放独立 schema，与 Drizzle 迁移、`pnpm audit:schema`、migration smoke 兼容。
- **回退**：开关把生产者改回 pg-boss；已在 DBOS 中开始的 workflow 按族写明处置（完成后再回退或人工裁决）。
- **Pi 循环**：不得把整段 `agentLoop()` 包为一个步骤；模型响应、工具业务提交、工具回执分别成为可恢复边界（YUK-1338 验证）。
  模型已响应但检查点未保存的窗口单列为"未知外部结果"，不宣称零重复费用。
- **演练**：P5 用低风险 housekeeping 族（如 `prune_job_events`）在恢复副本上走完一次全流程再迁业务族。

## 5. 阶段与退出条件

| 阶段 | Linear | 类型 | 退出条件 |
| --- | --- | --- | --- |
| P0 gate：Pi + DBOS 竖切 | YUK-1338 | 非 UI | 1338 的 5 条验收全过（状态版本、旧结果不覆盖、进程重启不重复、未知窗口单列、三入口共用业务操作）。**不过则不启动 P1/P5/P4** |
| P1 前门 | YUK-1352 | 非 UI | 全部现有页面与 `/api` 在新前门下行为不变；token 校验覆盖 server function；bundle 无 provider key；回退镜像步骤入 runbook |
| P2 视觉方向 loft | YUK-1353 | UI · Opus 5.5 | 3 个结构性变体 + 评分表 + 决策文档入库（见 §6）。可与 P0 并行 |
| P3 设计系统 + 示踪路由 | YUK-1354 | UI · Opus 5.5 | 新 tokens/primitives/壳；`/mistakes` 在 TanStack 下功能对等；新旧页面互跳不丢 token |
| P5 任务迁移框架 | YUK-1355 | 非 UI | 台账；worker 双栈；housekeeping 族在副本上走完切换-排空-回退 |
| P4 首个竖切 | YUK-1356（后端）/ YUK-1357（UI） | 非 UI / UI · Opus 5.5 | 见 §7 |
| P6 分波迁移 | YUK-1358（拆分容器） | 每波两票 | 每波：功能对等 + 行为改进 + 任务族已切并排空 + 确定性能力回归 + 一周无 P0/P1 后删旧页 |
| P7 收口 | YUK-1359 | 非 UI | 旧 SPA、旧 primitives、pg-boss 依赖与 schema 退役（备份后）；Hono 去留 ADR；README/architecture/AGENTS 同步 |

P6 波次：W1 today/inbox → W2 record/drafts/onboarding/placement → W3 questions/notes/knowledge/agent-notes →
W4 CopilotDock/coach/profile → W5 admin-*。顺序依据：先做每日入口，再做材料进入，Copilot 最晚（流式与会话恢复最复杂）。

## 6. UI 重写的设计 pre-flight 输入

**需要决定的是视觉方向**——PLAN 与 ADR-0066 都写明"视觉方向本轮暂缓"。不再空谈，用 loft 定稿（YUK-1353）：

1. 引用：行为设计 §4.1（回来时）、§4.3（工作台三位置关系）、§4.4（导航/路由/布局未锁定）、§7.2（每项安排要说清什么）。
2. 两屏：首页"回来时"、学习工作台解题态。**3 个结构不同的变体**（信息架构/布局不同，不是换色），
   每个都有桌面 + 手机、亮 + 暗；使用接近生产的脱敏 fixture（长题干、图形、草稿、多目标、已有提示、不确定判断）。
3. 评分表：继续已有学习与系统建议是否并列、是否丢失自己的尝试、建议是否给出理由与替代、移动端可用、
   对现有 Loom 资产（`docs/design/loom-refresh/project/tokens.css`、`src/ui/primitives/`）的复用成本。
4. agent 在授权下选定并记录理由，Opus 5.5 独立视觉复核。原型不进生产 bundle。
5. 定稿产物：决策文档（导航骨架、工作台布局规则、保留/替换的 token）是 P3 及之后每张 UI 票 pre-flight 的必引来源。
6. 质感与交互基线（owner 2026-10-07 关注"高级感、顺畅感"，loft 评分表与每张 UI 票验收均适用）：
   - 先 token 后组件：字号 5–6 级、4/8 间距、9–11 级中性灰 + 1 个强调色、圆角 2–3 档、动效时长与曲线入 token；组件禁止硬编码数值。
   - 层级靠字号/字重/灰度与背景色差，少用边框和阴影；空、载入、出错三态必须设计；数字用 `tabular-nums`。
   - 交互 100ms 内有反馈；写操作乐观更新并可回滚；路由 `preload="intent"`，下一题在作答时预取。
   - 动效 150–250ms、只动 `transform`/`opacity`，列表与展开用布局过渡，尊重 `prefers-reduced-motion`。
   - 键盘优先：高频操作有快捷键，提供 `⌘K` 命令面板；长列表虚拟化。
   - 可量化门槛：INP < 200ms、CLS < 0.05、关键交互低端机 60fps，附真实操作录屏为证据。

## 7. 首个竖切：复习作答 → 判分 → 状态更新 → 下一项

选择理由：它就是 ADR-0066 的核心闭环；直接复用 YUK-1338 已验证的业务操作；同时覆盖确定性路径
（ADR-0028 知识点级 FSRS、ADR-0030 按 kind 确定性选题、掌握度 base 层）与 AI 判分任务。
`/mistakes` 只作为 P3 的低风险示踪路由，不当作竖切。

- **YUK-1356（后端，非 UI）**：practice 的 review session / attempts / judge run 以业务操作为唯一实现，页面 server function、
  Copilot 工具、后台入口共用；判分任务族按 P5 切到 DBOS。模型不可用时确定性路径完整可用；AI 判分带状态版本，过期即重校/拒绝；
  步骤边界杀 worker 不重复业务效果；现有 `/api` 契约保留到旧 UI 下线并同步 Postman。
- **YUK-1357（UI · Opus 5.5）**：组件类型 route + drawer；打开讲解不丢草稿；模型流临时输出不显示为已生效；
  通知断线/乱序后重读已提交状态；旧 `practice` 路由保留回退开关。

## 8. 必须保持的边界

- route/job/copilotTool 只经 `src/capabilities/<name>/manifest.ts` 贡献；TanStack server function 只是网络入口，
  调用 capability 的业务操作，不在页面重写业务规则（ADR-0051）。
- `/api/*` 继续校验 `x-internal-token`，仅 `/api/health` 豁免；新增 server function 共用同一校验 helper，并有拒绝测试。
  浏览器仍通过 TokenGate 持有内部 token（单用户不变量），**不持任何 provider key**；P1 起每次构建扫描产物。
- AI 调用只在 Hono route / server function 的服务端或 worker 中执行；保留现有 run logging 与可逆动作。
- `core/` 跨科目、`subjects/<name>/` 科目专属的划分不变。

## 9. 必须存活的 pre-AI 确定性能力（承重）

每波退出与 P7 都按此清单回归；任何一项不得因迁移被删除或降级为"需要模型"：

1. FSRS 知识点级调度与到期复习（ADR-0028，`src/server/fsrs/`）；按 kind 确定性选题 seam（ADR-0030）。
2. 掌握度 base 层（AI delta 之外的确定性部分，`src/server/mastery/`）与 calibration。
3. 统一题库与变式链（`variant_depth ≤ 2`），作答记录、Judgment 不可变（申诉 = 新 Judgment）。
4. 错题录入与 OCR 字符层确定性抽取（ADR-0002）。
5. 提议 + 确认 + 撤销（`src/server/proposals/`、`src/server/revert/`）。
6. pedagogy 确定性 shortlist（ADR-0050 §c）与 today 确定性兜底。
7. 运行日志、费用记录、导出与备份（`src/server/export/`）。
8. housekeeping cron（prune_* 、promote_conversation_idle）的语义与时区。

## 10. 模型路由

- **UI 票**（设计、实施、视觉复核）：只交 **Claude Opus 5.5**，不交 GPT/Codex/MiMo（授权文件 §工作方式）。
  Linear 用 `area:ui` 且标题前缀 `[UI · Opus 5.5 only / Pn]` 标出：YUK-1353、YUK-1354、YUK-1357，以及 P6 每波的 UI 子票。
- **非 UI 票**：授权默认 OpenCode Go MiMo 2.6 Pro（`providerInstanceId=opencode`、`model=opencode-go/mimo-v2.6-pro`、`options={}`）。
- 核对实际运行选择，不把配置回执当作已切换；同一 diff 不派两个写入者；独立 review 与 exact-head CI Gate 照旧。

## 11. 排期与当前单线

PLAN 规定单 session 只推动一条 active 线。当前 active 线仍是 YUK-1103 后续（恢复真实 AI 帮助与学习行为验收）。
本 epic 进入 NEXT：先 YUK-1338 gate；P2 视觉 loft 可在 gate 期间并行（只产出原型与决策，不进生产）。

## 12. 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| TanStack Start 仍为 RC | 升级破坏、server function 行为变化 | 固定版本；P1 证明挂载与鉴权；升级单独成票 |
| Pi + DBOS 步骤集成不成立 | 恢复粒度退化为整循环、重复费用 | YUK-1338 是硬 gate；不过则回到 ADR 重新评估，不进入迁移 |
| 双栈期漂移（两套路由、两套 UI、两套任务） | 维护成本、缺陷归属混乱 | 每路由/每族一个开关；一周无 P0/P1 即删旧代码；P6 每波有删除步骤 |
| 任务迁移丢失或双跑 | 数据丢失、重复业务效果、重复费用 | 台账、逐族排空、cron 单侧测试、副本演练、不删队列 |
| 生产数据库变更 | 不可回退 | expand/contract；授权文件规定的备份与副本顺序；pg-boss 表只在 P7 删除 |
| SSE/流式在新前门下行为变化（`src/ui/lib/sse.ts`、ingestion events、copilot subtask events） | 断流、乱序 | 带版本通知 + 重读已提交状态；Copilot 放在最后一波 |
| `globals.css` 1.58 万行样式债 | 新旧样式冲突 | 新设计系统独立作用域，不整体复制；P7 删除 |
| UI 只能交 Opus 5.5 | UI 吞吐受限 | UI 票小而独立；后端先行，UI 不阻塞后端合并 |
| 当前 active 线（YUK-1103 AI 日用验收）未完成 | 并线导致两头半成品 | 按 §11 排期，gate 之前不动生产 |
