# 架构基础

当前代码的运行时拓扑、capability 契约、执行路径与技术栈；「一」起保留领域概念与数据模型。具体模块行为见 [`modules/`](modules/) 各文件。

---

## 运行时与进程拓扑

- **app**：`server/index.ts`（`pnpm build:server` → `dist/server.cjs`），`@hono/node-server` 监听 `API_PORT`（默认 8787，`src/server/env.ts` 的 `resolveApiPort`）。启动关键步骤：`loadEnv` → 科目 / 配置 / 模型目录水合 → capability tools 注册 → `recoverToolOperationsOnBoot` → admin config 注入 → `startListenLoop` → serve。
- **worker**：`scripts/worker.ts`（`pnpm build:worker` → `dist/worker.cjs`）。`bootWorker()`（`src/server/boss/worker-boot.ts`）先注册 tools，再调 `startBossWorker` 挂 pg-boss、capability jobs、夜间 orchestrator 与 DBOS。worker 不启动 HTTP，也不开 LISTEN loop（`scripts/worker.ts` 注释）。
- **migrate**：`scripts/migrate.ts` → `dist/migrate.cjs`，以 `node dist/migrate.cjs` 在 app / worker 之前跑 Drizzle migration。
- **dev**：`pnpm dev:local`（`scripts/dev-local.ts`）spawn 三进程：`rw:api`（`tsx watch server/index.ts`，脚本自带 `RW_WORKER=1`）、`rw:web`（`vite --config web/vite.config.ts`，:5173，`/api` 代理到 :8787）、`worker:dev`（`tsx scripts/worker.ts`）。因此 dev 里 app 进程与独立 worker 都会消费队列。
- **prod**：`docker-compose.yml` 的 `migrate` / `app`（`node dist/server.cjs`，镜像 target `runner`）/ `worker`（`node dist/worker.cjs`，target `worker`，额外带 headless Chromium 供 `worksheet_render`）/ `postgres`（pgvector）/ `mem0-init` / `cloudflared`。app 与 worker 共用 `DATABASE_URL`；worker 是 mem0 SQLite history 的唯一写者。
- **静态面**：未设 `RW_STATIC_DIR` 时 app 只服务 Hono API；设了（镜像内为 `/app/web/dist`）则走 `server/frontdoor.ts` 的 Start 前门，见下文。

---

## capability 契约

- 组合根是静态数组：`src/capabilities/index.ts` 按固定顺序登记全部 capability manifest，交给 `buildHonoApp`；成员与顺序以该文件为准。
- `manifest.ts` 只声明归属（`CapabilityManifest`，`src/kernel/manifest.ts`）：必填 `name`、`description`；可选 `events.actions`、`subscriptions.handlers`（`EventSubscriptionDecl[]`）、`api.routes`、`jobs.handlers`、`proposals.kinds`、`copilotTools.tools`、`ui.pages`。`validateComposition()` 在启动（`server/app.ts`）与 CI（`pnpm audit:api-contracts` → `scripts/audit-api-contracts.ts`）校验包名、event action、订阅 `id@vN`（`actions` 必须已被某个包声明、`load` 必填）、route key / `operationId` / 路径参数 / 响应契约、job 名与 DAG、proposal kind、DomainTool 名、UI page 路由的全局唯一性。`load` 是懒加载 thunk；route 与 pg-boss job 没有 `load` 就只是归属元数据、不挂载（`backend: 'dbos'` 的 job 例外，由 DBOS 路径启动）。
- `public.ts` 是服务端契约，`ui-public.ts` 是客户端契约。`src/server/**` 新增依赖只能落在别人 `public.ts` / `ui-public.ts`（或 kernel 端口），私有模块与 capabilities barrel 一律拒；capability 之间的 value import 按 owner 对计数，同样由 baseline 冻结（`PUBLIC_ENTRYPOINTS`，`scripts/audit-capability-boundaries.ts`）。
- kernel 端口：`src/kernel/` 承载 manifest、events、tools、read-models、records、proposals、job-dag、cost 等跨 capability 契约。`src/kernel/projection-writer-policy.ts` 拥有 projection writer 审计政策、实体类型与 boot flag-vector 诊断；配置解析和水合仍归 `src/core/config/` 与 `src/server/config/`。跨包读取只走对方 `public.ts`；`audit:capability-boundaries` 禁止新增 kernel / core → capability / server 的 value import，既有 facade 由 ratchet 冻结（`scripts/lib/dependency-ratchet.ts` 的 `auditKernelReverseEdges`）。
- `pnpm audit:capability-boundaries` 是精确 ratchet：记录 `capability → server`、`server → capability deep`、跨 capability value 三类边数，变化必须在同一 PR 登记进 `scripts/capability-boundary-baseline.json`。三类边数与当前非平凡 SCC 构成以该文件的 `debts` 为准。
- `pnpm audit:architecture-deepening` 再查深层 import、公开读环白名单、隐藏写、命令环、TaskSpec / DomainTool / proposal / queue 归属、provider lane census 与依赖上限（严格小于 `DEPENDENCY_CEILINGS`，见 `scripts/audit-architecture-deepening.ts`）。
- TaskSpec 由各包 `task-public.ts` 贡献、`src/capabilities/task-catalog.ts` 用 `composeTaskCatalog` + `expectedCount` 静态聚合；`src/capabilities/task-registry.ts` 用 `createTaskRegistry` 冻同一 catalog，并导出预算 / prompt readers 给 route 与 job。细节见「五、AI 任务层」。

---

## 执行路径

### HTTP 请求路径

- 入口：`server/index.ts` 的 `serve({ fetch, port })`；`fetch` 是 `buildHonoApp(capabilities)`，设了 `RW_STATIC_DIR` 时外面再包 Start 前门。
- `/api/*` 依次经过：`SECURITY_HEADERS` → `x-internal-token` 校验（`/api/health`、`/api/ready` 豁免；`INTERNAL_TOKEN` 未设时全拒）→ DB contract epoch gate（fenced 返回 503 `contract_epoch_fenced`）→ 90s request-scope provider deadline（`HTTP_PROVIDER_SESSION_BUDGET_MS`，`src/kernel/http.ts`）。
- manifest 的 `api.routes[].load` 在首次请求时解析并缓存 handler；返回后由 `assertApiRouteSuccessStatus` 校验 status 契约。未命中的 `/api/*` 统一 404 JSON。
- SSE：`src/server/events/writer.ts` 写 `job_events` 并 `pg_notify('job_status')`；app 进程的 `startListenLoop()` 独占一条 LISTEN 连接（`max:1`），广播给 `sse_router`。该连接不重连，断开需重启进程（`src/server/events/listen_loop.ts`）。
- 浏览器不持 provider key；AI 调用只发生在 route / handler 内。

### pg-boss 作业与夜间 DAG

- 进程：独立 worker（prod `dist/worker.cjs`，dev `scripts/worker.ts`）；dev 的 app 进程因 `RW_WORKER=1` 也会挂一份。启动配方在 `src/server/boss/start-worker.ts`：基础设施队列 `registerHandlers` → capability jobs `registerCapabilityJobs` → verify 补发 → event subscription → orchestrator。
- 每个 job 独立队列；manifest 的 `queue` 只是档位（`llm` / `agent` / `fast`）。llm / agent 有 `<name>_dlq`、`retryLimit=2`、30s 退避；fast 无 DLQ（`src/server/boss/queue-config.ts`）。
- 调度有两种：带 `schedule` 的是裸 cron（`boss.schedule`，按 `tz`）；带 `dependsOn`（含 `[]`）的是夜间 DAG 成员，自身不注册 cron。DAG 只有一根锚点 `nightly_orchestrator`，`30 2 * * *` Asia/Shanghai，启动补跑窗口 5h，tick 60s 自续；硬边失败跳过下游，soft 边照跑并记 stale（`src/server/orchestration/constants.ts`、`src/kernel/job-dag.ts`）。
- DAG 成员与根以各 capability `manifest.ts` 的 `dependsOn` 为准，例如 `dreaming_nightly`、`coach_daily`、`knowledge_edge_propose_nightly`、`knowledge_maintenance_nightly`、`item_prior_backfill`、`recalibration_nightly`、`embed_backfill`、`answer_class_backfill`。
- 域 handler 在 `src/capabilities/<name>/jobs/*.ts`；中央 `src/server/boss/handlers.ts` 只留基础设施（`echo`、`promote_conversation_idle`、verify 补发、memory 队列）。

### DBOS durable 路径

- 只有 manifest 显式声明 `backend: 'dbos'` 的 job 走 DBOS：observability 的 `prune_job_events` / `prune_orphan_*_sessions`、practice 的 `judge_run` / `judge_pending_reconcile`；完整名单以两个 manifest 的 `backend: 'dbos'` 为准。`registerCapabilityJobs`（`src/server/boss/register-capability-jobs.ts`）对集合、queue 档位、schedule 与 `load` 缺席做校验，不符合直接抛错。
- 运行在同一个 worker 进程：`startDurableWorker()`（`src/server/durable/prune-worker.ts`）→ `DBOS.launch()`，系统库 schema `tlp_dbos`，executor `local`。
- 每个家族有一张 control 表（如 `prune_job_events_control`、`review_orphan_control`），`phase ∈ pg-boss | draining-pg-boss | dbos | draining-dbos`。15s reconciler 按 phase 在 pg-boss 的 `boss.work` / `boss.schedule` 与 `DBOS.applySchedules` 之间切换，不会双跑。workflow 内用 `DBOS.runStep` 落业务提交与 checkpoint。
- 新增家族必须同时提供 workflow、control 表、phase 切换和上述白名单校验；只加 `backend: 'dbos'` 一行会在启动期失败。

---

## Start 前门

- 构建：`server/start/vite.config.ts`，`srcDirectory: 'server/start'`，`base: '/_build/'`，输出 `dist/start`（`pnpm build:start`）。
- 挂载：`server/frontdoor.ts` 动态 import `dist/start/server/server.js`，把所有请求交给它的 `fetch`；客户端资产从 `dist/start/client` 提供在 `/_build/*`。
- 路由：`server/start/routes/*.tsx` 文件路由，`routeTree.gen.ts` 由 TanStack Router 生成。已迁页面在 route 里 `lazy()` 一个 capability 的 `ui-public.ts` loader（如 `notes.tsx` → `loadNotesPage`），再包进 `StartWorkbenchShell`。
- `/api/$` 原样转发给 `context.api.fetch`（Hono 组合根）；`/$` catch-all 回退到旧 `web/dist` SPA（`buildLegacySpa`）。新页面按 route 逐个接管，未迁移页面保持旧 SPA。
- Start server function 统一先请求 `/api/auth/check`（`server/start/start.ts`），复用 Hono 的 token 与 epoch gate。

---

## 一、知识点图谱（Knowledge Graph）

底层数据结构。每个知识点是一个节点（`knowledge` 表 + `parent_id` 树骨架），节点之间用 `knowledge_edge` 表承载五种类型化横向边（per ADR-0010）：`prerequisite` / `related_to` / `contrasts_with` / `applied_in` / `derived_from`，外加 `experimental:*` 命名空间用于新关系探索。

每个知识点至少包含：
- id / 名称 / 所属领域（应试科目 or 兴趣主题）
- 当前掌握度（0~1，分两层：base + AI delta，详见 [`modules/progress.md`](modules/progress.md)）
- 最近一次活跃时间
- 关联资源（错题列表、artifact 列表、外部链接）

应试和兴趣两套图谱并存但相互引用，不硬合并；通过共享 tag 系统打通。**跨学科引用走软引用**（markdown wiki link `[[物理:能量守恒]]`），不做强类型 cross-domain ref。

---

## 二、AI 角色与能动性边界

### 2.1 AI 角色

不是聊天助手，是「数据加工 + 内容生产 + 主动判断」的中间层。它负责：
1. 归因 / 归类（错题 → 知识点、错因分析）
2. 生产（变式题、卡片、artifact、dreaming 推荐）
3. 复盘（周报、薄弱点诊断、下阶段建议）
4. 维护（提议删错题 / 合并节点 / 归档冷数据）
5. 判定（quiz answer 判分、申诉重判）

AI 是裁判而不是打分器：所有判断必须 evidence-based，留下推理痕迹。

### 2.2 AI 能动性边界

支持 AI 主观判断，但分对象：

| 对象 | AI 能动性 |
| --- | --- |
| 软判断（完成判定、推荐、排序、人话总结、quiz 评分） | ✅ AI 自由发挥 |
| 软提议（删错题、合并节点、归档、状态重置） | ✅ AI 提议 + 用户确认 + 可回滚 |
| 硬数据（错题正确率、复习记录、行为日志、Judgment 历史） | ❌ 事实层，不可改 |
| 不可逆消费（跨预算调用 LLM） | ❌ 硬约束 |

**自用工具最大的失败模式不是死板，是数据失信**。所有 AI 的判断和提议必须留痕，三个月后能回放为什么。**Judgment 不可变**：申诉重判 = 新建 Judgment，不修改旧的。

---

## 三、Artifact 多态化（核心抽象）

Artifact 是 AI 产出物的统一抽象，分两大族：

```
Artifact (AI 产出物)
├── Note  (阅读型，被读)
│   ├── note_hub      (大纲 + 子 atomic 列表)
│   └── note_atomic   (5-section 结构化笔记，含 check section)
└── Tool  (互动型，被用)
    ├── tool_quiz         ← 当前唯一实例
    ├── tool_visualizer   (Phase 3 候选)
    ├── tool_simulator    (Phase 3 候选)
    └── tool_drill        (Phase 3 候选)
```

**两个关键性质**：

1. **Tool 可独立存在**：每日 quiz / final quiz / 用户存的模拟卷 / 复习 session 都是独立的 `tool_quiz` Artifact，不需要嵌在 Note 里。
2. **Tool 也可以嵌入 Note**：note 的 `check` section 是 **inline embedded** 的迷你 quiz——直接在 section 里持 `question_ids[]`，不另建独立 `tool_quiz` Artifact 行（避免数据膨胀，因为 embedded check 跟 section 1:1 强耦合）。

**通用 Tool interface 暂未抽**：Phase 1 只有 quiz 一种 tool kind。Phase 3 出现第二种 tool（visualizer 等）时再抽两者共有的 `mount() / emit() / serialize()`，时机由 owner 决策。

---

## 四、统一题库（Question 单一来源）

`Question` 是题面、参考答案、评分标准的**唯一存储**。所有题相关的对象都引用 Question.id：

```
Question (统一题库，single source of truth)
  ↑ 被引用
  ├── tool_quiz Artifact.tool_state.question_ids[]   (standalone quiz)
  ├── note_atomic.sections[check].embedded_check.question_ids[]   (embedded check)
  ├── learning_session teach_message.question_id      (teaching ask_check)
  ├── Mistake.question_id                            (做错事件)
  └── Mistake.variants[].question_id                 (变式题，本身也是 Question)
```

**变式系列是 Question 的链式扩展**：每条变式是新 Question 实例，通过 `variant_depth` / `root_question_id` / `parent_variant_id` 跟原题关联。`variant_depth ≤ 2`（防"错题繁殖"，详见 [`modules/mistakes.md`](modules/mistakes.md) § 3.4）。

**好处**：
- 题面去重（同题不同来源不重复存）
- 变式题自然成为题库一员（不是 Mistake 私有数据）
- 复习 / 每日 quiz / 模拟卷的题都从 Question 抽
- 错题录入与 quiz 答错的路径一致：先建 Question 再建 Mistake

详见 [`modules/quiz.md`](modules/quiz.md) §  Question 部分 与 [`modules/mistakes.md`](modules/mistakes.md) § 1。

---

## 五、AI 任务层（LLM Task Layer）

所有 AI 调用按「任务」抽象，**不**按 `chat()` 抽象——避免丢掉 provider 特色能力（prompt caching / batch API / structured output / multimodal）。

### 5.1 Task 注册

TaskSpec 由 capability 拥有：`src/capabilities/<name>/tasks/index.ts` 用 `defineOwnedTaskSpecs` 把 owner map 定义成完整 spec（owner 集合以 `src/ai/owned-task-specs.ts` 的 `TaskOwner` 为准），`task-public.ts` 只做再导出。`src/capabilities/task-catalog.ts` 用 `composeTaskCatalog` 合并这些 map：加载期校验 key === `definition.kind`、owner 不重复、kind 不重复，冻结结果并断言 `expectedCount`——**task 名单、归属与总数只写在 owner map 与该文件的 `expectedCount`**，本文不复制。

- 消费面：`src/capabilities/task-registry.ts` 用 `createTaskRegistry` 冻结同一 map，并绑定 `createTaskBudgetReaders` / `createTaskPromptReaders`；`src/ai/task-catalog.ts` 只有 composer 与类型，没有动态发现、可变全局注册或 Copilot overlay。
- TaskSpec 字段（`defaultProvider` / `defaultModel` / budget / prompt / `invocation` / `execution`）见 `src/ai/task-spec.ts`；某个 task 用哪个模型、由谁触发，看 owner map 与调用方代码。
- 分类（compatibility-only、无静态 caller）以 `scripts/audit-task-census.ts` 的 `LIVE_NON_CALLER_CLASSIFICATIONS` 为准；`pnpm audit:task-census` 校验 manifest/job 注册可达性与 run-log 契约。

**仍成立的历史结论**：`EnrichMistakeTask` 已拆成 `AttributionTask`（归因）；`KnowledgeProposeTask` 已移除，答错不再提议新 KC——KC 创建走 content-driven 的 `tagKnowledge`（`src/capabilities/knowledge/server/tag-knowledge.ts`），近重复由 `kc_dedup_nightly`（propose-only）兜底；冷启 reference 生成解耦为 `reference_answer_backfill`；VisionExtract* 只走 ingestion manual rescue。详见 ADR-0045 与 `docs/design/2026-06-22-unified-tagging-axis.md`。

**命名约定**：Task 一律 `PascalCase + 'Task'` 后缀；破坏性操作（删题、合并节点）走 Proposal/Suggestion 流程而非直接 tool（per ADR-0004）。

### 5.2 运行时 Tool Calling

需要"边看数据边决策"的 Task 走 multi-turn tool call；输入已固定的 Task 走单轮 structured output。

现行 runner 在 `src/server/ai/runner.ts`，唯一执行引擎是 pi（`@earendil-works/pi-agent-core` 的 in-process `agentLoop`，`pi-agent-adapter.ts`）。Tool transport 用 `piToolMounts` + `allowedTools` + `maxTurns`（wire name `mcp__<server>__<tool>`）。DomainTool registry、capability manifest inventory 与 in-process MCP bridge 都在跑；产品工具归 owner capability，中央层只负责组合、预算与 transport。

**当前规则**（YUK-321 M5 起 generic `/api/ai/[task]` route 已退场，AI 调用全走 capability manifest 声明的领域 route 或 pg-boss worker）：

- SubjectProfile-driven task 必须走领域 route / worker，由入口解析并传入正确 `SubjectProfile`。
- `needsToolCall: true` 的 task 必须走领域 route / worker，由入口注入 MCP server 和 allowlist。例如 `KnowledgeReviewTask` 由 `knowledge_maintenance_nightly` 夜间 DAG job in-process 调 `streamReviewTask`（YUK-617 撤了冗余的 `/api/knowledge/review` HTTP route）。
- `invocation: 'manual_rescue_only'` 的 VisionExtract* task 只能走 ingestion rescue 入口。
- 本地 `loom` MCP server 从 capability manifests 装配 typed DomainTools，是进程内 transport，不对外暴露 endpoint。`attribute_mistake` / `propose_variant` 的 concrete adapters 归 practice，`author_question` 的 variant 分支只走其窄 public operation。
- 破坏性操作（删题、合并节点、reparent、merge、archive）没有直接 write tool。AI 只能 propose；用户 accept route 再执行真实 mutation。

**DomainTool 合约**：定义在 `src/kernel/tools/types.ts`（`effect: read | propose | write | control`，另有 `costClass`、`mirrorEvent` 与可选 `safeHandoff`），由 manifest inventory + `src/server/ai/tools/registry.ts` 消费；字段以该文件为准，本文不复制。

manifest 在启动期注册的 DomainTools 进入 registry 后，pi mount 把选中的工具编译成 `AgentTool`，执行委托共享 `executeDomainToolCall` 管线。远程 MCP 是现役工具来源之一，不等同于向外发布产品级 MCP server。

当前工具阻塞到结果或取消/期限终态，不向模型返回旧 45 秒 yield 句柄。
Copilot 由服务端持久受理和顺序执行，浏览器只订阅；没有独立 Mission 会话入口
（ADR-0062）。只读 depth-one pi child 在原父执行内返回结果，不生成自动付费根续接。
旧 mailbox researcher/continuation 执行路径已退役；`subagent_run` 保留原生子任务投影，
ToolOperations 仍拥有真实远程工具执行、租约、取消和终态审计，不能笼统视为 drain-only
历史代码。安装排空与保留名称的边界见 ADR-0063，pi 机制见 ADR-0065。

**循环控制**：

- `TaskBudget.maxIterations` 映射到 runner `maxTurns`（pi adapter 用 `finishTurn` 计数，超限出 `error_max_turns` 终态）；`timeout` 由 `AbortController` 协作中止（`src/server/ai/runner.ts`、`pi-agent-adapter.ts`）。
- `TaskBudget.maxCost` 在 chat/pi lane 不设美元闸——pi catalog 成本是估算值，mimo 不回 cost，subscription OAuth 是 flat quota；只有 typed lane 自己按每次 wire attempt 预扣 reserve 并累计封顶（`src/server/ai/typed-primitive-runner.ts`）。
- `TaskBudget.transientRetries` 只控**同一已解析目标**的进程内瞬时重试：chat/pi lane 上只有两个 vision judge（`StepsJudgeTask` / `MultimodalDirectJudgeTask`）opt-in，且受 `run-lifecycle.ts` 的 `transientRetryEnabled` / `classifyLifecycleRetry` 门控（ctx 显式开启、无 `override` / `modelBinding` / 全局 override 钉死、白名单瞬时分类、次数封顶、elapsed 未超 `RETRY_ELAPSED_CAP_MS`）；typed lane 由 `typed-primitive-runner.ts` 自行按 `1 + budget.transientRetries` 重试。
- durable job 的瞬时层只靠 pg-boss 显式重投（`retryLimit=2` + 30s 退避，`src/server/boss/queue-config.ts`），不与进程内重试叠加。
- provider API retry 默认 2 次，运维可用 `CLAUDE_CODE_MAX_RETRIES` 覆盖（`pi-agent-adapter.ts`），让 5xx 终态在任务预算内回到 loom 分类层。
- provider session admission（YUK-842）：resolved provider 后先用 Postgres 短事务拿 lane 槽与 start reservation，排队不计 model timeout；在 slot 内以 45s initial lease 调 adapter `startup()`（只做 model/auth 预检，不发 prompt），成功后用 claim-token CAS 切到 15s steady lease，才写 `ai_task_runs`、启动剩余 model timeout 并调一次 `query()`。lease protocol v2 计入 policy fingerprint；只有 heartbeat 以 15s horizon 单调续租、不缩短已确认 expiry；`hard_reclaim_at` = 45s startup + model timeout + abort grace。开关与策略是 `AI_PROVIDER_SESSION_ADMISSION_MODE` / `AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON`（默认 `off`），运维见 `docs/runbooks/provider-session-admission.md`。
- request scope：`server/app.ts` 给每个 `/api/*` 请求开一个 90s absolute provider-session deadline（`HTTP_PROVIDER_SESSION_BUDGET_MS`，`src/kernel/http.ts`），runner 取它与显式 caller deadline 的较早者；adapter 返回后重新校验 lease / abort / deadline，迟到 success 不记成功。durable worker 没有 HTTP scope，保留 task 完整预算；Copilot durable job 用 `DURABLE_OWNER_SETTLEMENT_BUDGET_MS`（45min 执行 + 30s grace）作显式 deadline（`copilot_run.ts`、`copilot-run-settlement.ts`）。
- 同 lane tool 内嵌 task 的一条 descendant chain 借父 family 槽避免自锁，parallel sibling 必须排队或占另一 root 槽，每个 child 仍独立记 start reservation；父先结束时仍运行的 child 接管该 family 槽。短 lease 丢失即 abort，外部 provider 无真实 fencing，故 active family 在 `hard_reclaim_at` 前继续隔离（`src/server/ai/provider-session-admission.ts`）。

### 5.3 成本控制

- 同步 / 异步不是任务类型，而是入口：用户操作触发的 task 在领域 route 的调用链里同步跑；夜间与重活由 capability manifest 声明的 pg-boss job 跑同一批 task，名单以各包 `manifest.ts` 的 `jobs.handlers` 为准。
- 模型分级：registry 用 `defaultProvider/defaultModel` 指定当前模型，Provider Manager 解析到 `ResolvedProvider`（credential/baseUrl/model），pi adapter 解析原生 `builtinModels()` provider/model 条目（`pi-models.ts`），包括协议、compat 与原生认证/请求头规则。
- 每次调用写 `ai_task_runs` / `cost_ledger`（`entry_kind='attempt'` 每次 attempt 一行，带 `task_kind` / `provider` / `model` / `currency`）；工具调用写 `tool_call_log`。YUK-1557 起终态 `usage_json` 固定带 `numTurns` / `cacheReadTokens` / `cacheWriteTokens`；同一次工具执行只留一行（runner 只记 spawn，DomainTool 由 bridge、remote MCP 由 pi mount、custom 由 owner 各记一行），Exa 调用另记 unknown-cost ledger 行。
- 确定性计分板：`harness_scoreboard_daily` 每日从原始表汇总 M1–M6（零 AI），写入 `experimental:harness_scoreboard` 投影；M3/M4/M5 按 ADR 的逐任务/逐子项给出 `parts[]`（各有分子分母与 `basis`），M4 以窗口结束时刻的收件箱投影回放积压；`GET /api/admin/harness-scoreboard` 供状态页读取，`pnpm harness:scoreboard --from … --to …` 可重算任意 BJT 日窗。
- **尚未实现**：通用 per-run 美元硬预算（chat/pi lane 无 contractual USD 信号可闸，只有 typed lane 自闸）、vision judge 以外的跨 provider fallback、结果缓存、prompt caching 策略，以及 YUK-845 所列 non-runner DashScope/Mem0/GLM/OCR/Tencent 出站 admission。已实现：vision judge 的跨 lane fallback（`VISION_JUDGE_PROVIDER` / `VISION_JUDGE_MODEL` 由 `src/server/ai/vision-judge-config.ts` 读取，`src/capabilities/practice/server/judge/provider-lane-fallback.ts` 消费）、同目标瞬时重试、队列显式 retryLimit、stuck-run reconcile sweeper（`ai_task_run_reconcile_nightly`）、central pi query-session admission（默认 off，`off → observe → enforce` 运维见 `docs/runbooks/provider-session-admission.md`），以及 Hono request-scope 的 90s central-session wall-clock fence。后者是 deadline，不是逐 HTTP wire request 的 RPM/并发限流。

### 5.4 Skill / MCP Server / Plugin

这些概念保留，但不要和产品内 runtime tool 混在一起：

- **Skill**（提示词包）：`src/subjects/<subject>/skills/<name>/SKILL.md`，跨科包放 `src/subjects/_shared/skills/`；调用方读正文后经 `piSkillDocs` 拼进 systemPrompt，缺包不注入、回落到 prompt 正文（`src/subjects/copilot-skills.ts`、`quiz-gen-skills.ts`、`note-skills.ts`）。
- **in-process tool bridge**（现役）：领域 route / job 注入 `piToolMounts`（pi `AgentTool`，wire name `mcp__<server>__<tool>`），不对外暴露 endpoint。
- **外部 MCP 消费**（现役）：Exa 托管 MCP，工具名 `mcp__exa__web_search_exa` / `mcp__exa__web_fetch_exa`（`src/ai/exa-mcp.ts`）；其余来源按需接。
- **Standalone MCP Server**（对外暴露 resources + tools）：未实现；未来复用 DomainTool registry，不重写工具定义。
- **Plugin**（学科 bundle）：学科专属逻辑放 `src/subjects/<subject>/`，跨科逻辑放 `core/`。

### 5.5 Tool calling 循环位置

**决策**：tool calling 多步循环跑在 **server 端**（Hono route / pg-boss worker / scripts worker），client 只负责发起请求 + 接收 JSON 或 stream。浏览器永远不持 provider key，也不直接执行 tool。

#### 实现

- generic `/api/ai/[task]` 已退场（YUK-321 M5），旧的 400 dispatch 分支随之作废；同类 task 由 capability 领域 route / worker 承接。
- AI 执行在领域 route 的调用链或 pg-boss job 里调 `runTask()` / `runAgentTask()` / `streamTask()`（copilot：`/api/copilot/chat` 入队 → `copilot_run`；knowledge：`knowledge_maintenance_nightly` → `streamReviewTask`）。
- pi in-process `agentLoop` 负责 multi-turn tool loop；`maxTurns` 来自 `TaskBudget.maxIterations`。
- 工具执行在各自的唯一 owner 写 `tool_call_log`（DomainTool bridge / remote MCP mount / custom mount），runner 只为 spawn 工具补行。
- 终态写 `cost_ledger`（每次 attempt 一行，带 `task_kind` / `provider` / `model` / `currency`）。
- 浏览器侧没有 `src/ai/client.ts` 通用 helper；UI 调具体领域 route，避免绕开 profile / tool / ingestion context。

#### 为什么不在 client 跑

- Provider API key 不能暴露到浏览器
- Tool 需要 DB transaction、event guard、权限 allowlist、成本日志，必须留在 server 侧

#### 与 Dreaming 实施栈的关系

Dreaming / Maintenance lane 复用这套 runner：pg-boss schedule / job handler 调 `runTask` / `runAgentTask` / `streamTask` 同一入口。区别只是触发方式（HTTP 请求 vs pg-boss scheduled job / queued job）和写入对象（event proposal、artifact、question draft 等）。

---

### 5.6 Dreaming / Maintenance 实施栈

Dreaming / Maintenance 复用同一条 pg-boss + 夜间 DAG 路径（见「执行路径 · pg-boss 作业与夜间 DAG」）。job 清单以各 capability `manifest.ts` 的 `jobs.handlers` 为准，本节不再维护副本。提议仍写 event stream，不写旧 proposal 表；Cloudflare Tunnel 只负责 ingress，不是 AI worker runtime。

---

### 5.7 Persistent Copilot and native research

Copilot durably accepts every message into one persistent conversation; transport disconnect only
detaches observation, while explicit Stop cancels execution. Bounded read-only research uses a depth-one
nested pi loop and returns to the same parent. The process-owned `pi:` cursor occupies the retained
`agent_sdk_session_id` column; resume seeds bounded durable turns into pi context. Cold execution folds
history into its prompt once. There are no SDK session files, and retaining a cursor does not prove
cross-process storage or authorize replay of paid work. The drained legacy mailbox researcher and
automatic continuation are removed. Historical rows, native child projections, live remote ToolOperations
and parent-owned recovery remain; no separate Mission conversation is created.
See [ADR-0062](adr/0062-unified-copilot-conversation-lifecycle.md),
[ADR-0063](adr/0063-retire-copilot-mailbox-execution.md) and
[ADR-0065](adr/0065-pi-execution-and-conversation-replay.md).

## 六、技术栈

以 `package.json` 为准：

- **运行时 / 工具链**：Node ≥24.0.0（`package.json` `engines`）、pnpm 11、TypeScript（`tsrs`）、Biome、esbuild。
- **HTTP**：Hono 4 + `@hono/node-server`。
- **Web**：Vite 8 + React 19 + TanStack Router 1 / TanStack Query 5 + Tailwind v4 + Zustand。
- **数据**：Postgres（pgvector 镜像）+ Drizzle ORM（`postgresql` dialect、`postgres` driver），迁移用 drizzle-kit。
- **异步**：pg-boss 12；durable workflow 用 `@dbos-inc/dbos-sdk` 5。
- **AI**：`@earendil-works/pi-agent-core` / `pi-ai`（in-process agentLoop），`@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`、`@lmnr-ai/lmnr`。
- **内容 / 渲染**：TipTap 3（note 编辑）、KaTeX + mathjs + react-markdown / remark-math / rehype-katex、Cytoscape + fcose（图谱）、Playwright Core（`worksheet_render`）。
- **录入**：`tencentcloud-sdk-nodejs-ocr` + `sharp` + `@hyzyla/pdfium`。
- **存储 / 记忆**：`@aws-sdk/client-s3`（R2 / S3-compatible）；`mem0ai` + pgvector。editing presence 走 PG 表 `editing_presence`，无 Redis。
- **复习 / 校验**：`ts-fsrs`、Zod 4。

**反模式**：

- 不要一开始就上多端原生（RN / Flutter）
- 不要自建账号系统（自用没必要；当前用 `INTERNAL_TOKEN` 单用户内网/隧道保护）
- 不要把 AI 调用做成「聊天框」，做成后台管线
- LLM 抽象层不要按 `chat()` 抽象，按任务抽象
- 不嵌 Obsidian 当 note 框架（详见 [`modules/notes.md`](modules/notes.md)）
- 不在 Mistake 表里复制题面（题面只在 Question 表）
- 不在 schema 或 pipeline 里做不必要的分类细化（如批改痕迹类型、跨页 passage 关系等）—— 交给 prompt engineering
- schema 第一天就加 `updated_at` / `version` 字段，给同步留位

---

## 七、数据模型骨架

DDL 唯一真相源是 `src/db/schema.ts`（单文件、按段注释）；本节只写跨模块约束，不复制列清单与 enum 值。

**主实体**

- `knowledge`（树骨架，`parent_id`）+ `knowledge_edge`（类型化横向边，见 §九）。
- `question`（题库唯一存储）+ `question_block` / `question_revision` / `question_group_lifecycle`（结构化题、不可变发布版本、发布组生命周期）。
- `learning_item` / `learning_record` / `completion_evidence`。
- `artifact`（AI 产出物；note 内容在 `body_blocks`，quiz 题号在 `tool_state`）+ `artifact_block_ref` / `artifact_edit_session`。
- `answer` / `learning_session` / `event`。
- 观测与费用：`ai_task_runs` / `tool_call_log` / `tool_operation` / `cost_ledger` / `provider_attempt` / `job_events`。

**读模型 vs 投影表**：`QuestionActivitySummary` 与周报（`loadWeeklyReview` 按窗口聚合 event，`src/capabilities/practice/server/review-weekly.ts`）是即时读模型、不落表；p(L) 诊断在 `mastery_state`、FSRS 调度在 `material_fsrs_state`（随 `action='review'` 同事务写），都是物理投影表。

**已 DROP，只作迁移背景**：`mistake`（改由 attempt event 表达，`outcome='failure'` 即错题视图）、`judgment` + `user_appeal`（改由 judge event）、`dreaming_proposal`（改由 propose event）、`review_event`、`ingestion_session`。`MemoryItem` / `MaintenanceSuggestion` 从未建表；记忆 brief 落 `memory_brief_note`。

**schema 里的显式约束**

- `knowledge` 行不存 mastery：θ̂ 与计数在 `mastery_state`（`subject_kind='knowledge'`）。
- `event.task_run_id`、`tool_call_log.task_run_id`、`cost_ledger.task_run_id` 都是 loose text ref，故意不建 FK（常早于 `ai_task_runs` 行写入）。
- `learning_record.knowledge_ids` 在 KC merge 时故意不重写，unmerge 才能重算（见该表注释）。
- `artifact.knowledge_ids` 是数组列，单值 `knowledge_id` 已不存在。
- `ingestion_creation_receipt` 是两个创建操作（`ingestion_session.create.v1` / `manual_mistake.create.v1`）的永久幂等回执，刻意不建 FK 并随 `FK_ORDER` 进备份（`SCHEMA_VERSION` 4.33 / migration 0133）：收据必须在资源删除后仍在、恢复后仍能命中，否则同 key 重试会重复造资源。收据版本不识别或内容损坏一律 503，绝不当作 cache miss 重建；重放与校验语义见 [`modules/mistakes.md`](modules/mistakes.md) §2.2 / §2.4。

In-code registries（非 DB）以代码为准：`DomainTool` 契约在 `src/kernel/tools/types.ts`，`TaskDefinition` 在 `src/ai/task-spec.ts`，`JudgeKind` 在 `src/core/schema/business.ts`。

---

## 八、event — first-class action log（统一 action log）

> ADR-0006 v2 + ADR-0011。`event` 表是 Phase 1c.1 的核心新实体，替代旧 mistake / review_event / dreaming_proposal 三表。

**equal-actor model**：`actor_kind ∈ {user, agent, cron, system}`——AI 不是注释层，是与用户对等的事件发起者。Copilot 对话、Dreaming 夜间产出、Critique 自批改全部 first-class。

**schema reference**：表结构见 `src/db/schema.ts` 的 `event`；Zod 分支见 `src/core/schema/event/`。

**payload 守护策略**（ADR-0006 v2 "Option 折中"）：
- **KnownEvent union**：稳定分支定义与顺序在 `src/core/schema/event/known.ts` 的 `KnownEvent`，解析优先级与 experimental 特化顺序在 `src/core/schema/event/index.ts` 顶部注释；分支清单与数量以这两个文件为准，本文不复制。
- **ExperimentalEvent**：`action.startsWith('experimental:')` 的 escape hatch；探索期先跑，稳了再 promote 到 KnownEvent + 数据迁移
- Zod schema 在 `src/core/schema/event/`；每次 event 写入必须经 `parseEvent()` guard（`src/core/schema/event/index.ts`）

**单一写入点**：`writeEvent()` / `writeEvents()` from `src/kernel/events/events.ts`（`@/kernel/events`）。route / handler 不允许直接 `db.insert(event)` 绕过 parse guard。

**因果链（event chaining）**：`caused_by_event_id` 把动作串成 DAG——judge ← attempt，propose ← cron trigger，rate ← propose。可重放、可审计，critique agent 可作用于历史 event。

**示例**：
```
e1: user / attempt / question:q1 / failure   (用户答错)
e2: agent:attribution / judge / event:e1    (AI 归因，caused_by=e1)
e3: agent:propose / propose / knowledge:k1  (AI 提议知识点，caused_by=e1)
e4: user / rate / event:e3 / accept         (用户接受提议)
```

FSRS 投影表 `material_fsrs_state` 从 event 流派生，每次 `action='review'` 同事务写入（ADR-0006 v2 § 接受的代价）。

---

## 九、knowledge_mesh — tree + typed edge

> ADR-0010。`knowledge_edge` 表是 Phase 1c.1 加入的第二个新实体。模块细节见 [`docs/modules/knowledge.md`](modules/knowledge.md)。

**结构**："tree 是骨架，mesh 是肌肉"——`knowledge.parent_id` 保留主层级 backbone（一棵树），`knowledge_edge` 表叠加有类型的横向链接。tree 用于 effective_domain 派生 + UI tree-view；mesh 用于 Dreaming agent 找"薄弱但邻近"复习候选。

**关系类型（5 核心 + experimental）**（enum 见 `src/core/schema/event/blocks.ts` 的 `RelationTypeSchema`）：

| relation_type | 语义 | 例 |
|---|---|---|
| `prerequisite` | from 是 to 的前置 | 实词词义 → 翻译 |
| `related_to` | 弱关联（双向） | 之-用法 ↔ 其-用法 |
| `contrasts_with` | 对照（双向） | 之-代词 vs 之-助词 |
| `applied_in` | from 应用于 to | 古今异义 → 阅读理解 |
| `derived_from` | from 派生自 to | 之-主谓间用法 ← 之-用法 |
| `experimental:*` | 探索期新关系 | — |

**单一写入点**：`src/kernel/records/knowledge-edge-facts.ts`（`createKnowledgeEdge` / `archiveKnowledgeEdgeFromEvents` / `reactivateKnowledgeEdge`），由 `src/capabilities/knowledge/server/edges.ts` re-export；写命令自带 event provenance，调用方不得另写 generate/archive event。

**propose 路径**（通过 event 流）：
1. `ProposeKnowledgeEdge` event（AI 提议，dry-run）→ 用户 accept
2. `RateKnowledgeEdge` event（rating='accept'）→ 触发 `GenerateKnowledgeEdge` event + `knowledge_edge` INSERT

**agent 读图路径**：不要把整张 `knowledge` / `knowledge_edge` 表直接塞进 prompt。使用语义化 graph reader（knowledge 包 `src/capabilities/knowledge/server/tools/knowledge-readers.ts`）：

- `get_subject_graph_overview`：subject 图例、root clusters、relation type 语义
- `query_knowledge`：按 query/id 找节点，返回 path、neighbors、stats、recent failures
- `expand_knowledge_subgraph`：围绕中心节点展开 bounded local subgraph
- `find_knowledge_paths`：解释两个节点之间的路径和关系

**其他 runtime context tools**：事件、学习记录、错题、复习队列、LearningItem 也通过语义化 reader 进入 agent 上下文：

- `query_events` / `get_question_context` / `query_mistakes` / `get_attempt_context`：读取 event timeline、题目生命周期和 failure attempt view
- `query_records` / `get_record_context`：读取用户活动物化出的错题、例题、疑问、顿悟、反思、资源摘录
- `get_review_due`：读取 FSRS due queue，不提交 review
- `get_learning_item_context`：给 Teaching / Coach / Copilot 提供学习项上下文
- `attribute_mistake` / `propose_variant`：包装现有 AttributionTask / VariantGenTask owner，不暴露任意 DB mutation

这些 tool 的完整设计见 [`docs/archive/superpowers/specs/2026-05-17-agent-context-tools-design.md`](archive/superpowers/specs/2026-05-17-agent-context-tools-design.md)。工具按 owner 分居各包 `server/tools/`，注册走 `manifest.ts` 的 `copilotTools`；ADR-0010、ADR-0011 §3-5。

**永不为工具（negative boundary，自归档 spec L1126-1138 重立档）**：`refresh_memory_brief_note`（Dreaming 定时 job 的事，不是 agent 能力）；raw `db.insert`/SQL；accept/dismiss/rollback handler（用户路由）；`POST /api/review/submit`（FSRS 提交是用户作答 + 事务）；无界 search；FS/网络/外部 MCP（除非后续需求显式引入——T-SQ Tavily 是已引入的豁免先例）。reader 类 tool 返回**语义而非原始行**、权限按 task 收窄、摘要属于工具契约的一部分——这三条同源于该 spec 设计原则。

---

## 十、异步任务层 (pg-boss) — Sub 0c

进程、队列、调度与 DBOS 路径见「执行路径」。本节只保留异步链路的耐久性契约与专属机制。

### 十.1 Durable hub-sync reconciliation (YUK-384)

PostgreSQL 是权威：`knowledge` / `knowledge_edge` / hub-local `artifact` 拓扑写触发 `drizzle/0071` 的 `mark_hub_sync_dirty` / `fanout_hub_sync_dirty` 触发器，在**写方的同一事务内**推进每个 live hub 的 `hub_sync_reconciliation.generation`（bigint，跨 TS 边界恒为十进制字符串）。收敛由 `runHubSyncCycle`（`src/capabilities/notes/server/hub-sync-reconciliation.ts`）承担：`FOR UPDATE SKIP LOCKED` 一次领一个 generation → lock-free `computeHubDesiredState`（复用 `resolveHubMeshAtomics` + `buildAutoZonePatch`，中立模块 `server/hub-auto-zone.ts`）→ `finalizeHubSync` 在固定锁序（advisory → artifact → cursor → edit-session）+ generation/token/lease/version/editor 栅栏下原子 apply（body + block-refs + event + ack），apply 走 `SET LOCAL app.hub_sync_internal_apply='1'` 不自 dirty。

**三个 job（全部经 `runHubSyncCycle`，无 scheduled 路径直接 apply）**（`src/capabilities/notes/jobs/hub_auto_sync_nightly.ts` + `capabilities/notes/manifest.ts`）：

| queue | 调度 | 作用 |
|---|---|---|
| `hub_sync_mutation_wake` | 按需（无 cron） | 拓扑提交后的**即时合并唤醒**（latency 优化，best-effort） |
| `hub_sync_recovery` | `* * * * *` | **每分钟恢复地板**——drain 就绪游标，≤60s 收敛下限 |
| `hub_auto_sync_nightly` | `45 2 * * *` Asia/Shanghai | 覆盖**修复扫描**（`nightly:<BJT-date>` key，幂等），never direct apply |

**耐久性契约**：耐久性 = SQL 触发器（记录 dirty，事务内）+ 每分钟恢复地板。immediate wake 是纯 latency 优化、best-effort，**从不是耐久性依赖**——漏发/失败由恢复地板兜底。有 backlog 时 recovery/nightly handler peek 已启动的 boss（`getRunningBoss`，不启动 boss）投递恰一个 singleton-keyed continuation，一个 cron tick 内 drain 完。

**FULL wake 接线（哪些即时唤醒 vs 靠恢复收敛）**：wake 在 boss-available 的 HANDLER 边界、外层事务提交后发**一个合并的 hub-agnostic 信号**（不 per-hub、不进每个 KG leaf writer）。已接线（即时唤醒）：`POST /api/knowledge/edges`（建边）、`POST /api/proposals/[id]/decisions`（KC/边提案 accept）、`POST /api/teaching-sessions/[id]/accept-chip`（chip 驱动 accept，直调 acceptAiProposal）。因 wake 合并，这三个覆盖交互常路；其余靠恢复地板：已弃用的 proposal decide/retract 代理路由、learning_intent 编排者（agency applier job）、rejudge 翻案 job、projection fold-appliers（回放期/休眠）、bootstrap 写（seed / ensure-subject-root / subject-control-write）。tag-knowledge 委托、无直接写，无需 wake。

**Rollout mode `HUB_SYNC_MODE = off | shadow | apply`**（`off` 短路 cycle；`shadow` 计算+ack 不写 body；`apply` 全量）。off→shadow→apply→rollback 八步序：

1. 部署 migration/backfill，`HUB_SYNC_MODE=off`。
2. 停掉所有旧 worker 进程再部署新 worker——绝不让旧直接-apply nightly 与新 reconciler 并存。
3. app + worker 同一 build 部署，`HUB_SYNC_MODE=shadow`。
4. 校验：cursor backfill 数 == live hub 数；查 status 分布、ready/dirty age、desired hash、分类错误、重复 nightly repair key 幂等。
5. 所有 app/worker 实例一次协调重启切 `HUB_SYNC_MODE=apply`。shadow 期观察过、未消费义务的 hub 因 shadow re-observe 退避（2min）留在 pending，切 apply 后 **≤~3min 内经每分钟 recovery 自动收敛**（或立即跑一次 nightly repair 强制收敛）。
6. 确认每分钟恢复 drain pending、02:45 BJT repair 用同一 `nightly:<date>` key。
7. apply-mode 校验通过后才退役旧直接-apply nightly 路径。
8. 回滚 = 设 `HUB_SYNC_MODE=off`；保留 reconciliation 行 + 未 ack 的 generation，义务不丢。**但注意 `off` 不是完整 kill switch**：见下「off 语义」——`off` 只停 reconciler，触发器记账（每次 KG/hub 写 bump generation）仍继续，因为触发器是 migration 起的无条件 DDL。

> **⚠️ Provisioning：必须 `pnpm db:migrate`，`db:push` 不支持（R1）。** 本 feature 的触发器 / 函数（`mark_hub_sync_dirty` / `fanout_hub_sync_dirty`）、partial index、backfill **只在手写的 `drizzle/0071` SQL 里**。`drizzle-kit push` 只 diff `schema.ts`，会 bootstrap 出**有表无触发器**的死库（整个 durable-dirty 机制静默缺席、hub 永不收敛），且对已 migrate 的库跑 push 还会**提议 DROP** 那几个 partial index。`readHubSyncHealth` 的 `triggers_installed: boolean`（查 `pg_trigger` 三个 `hub_sync_*` 触发器名）是这条的运行时哨兵——`false` = 触发器缺失、reconciler 形同虚设，务必用 db:migrate 重新 provision。（repo 级 db:push 防护挂 Linear follow-up，不在本 PR。）

**`off` 语义（不是完整 kill switch，R2）**：`HUB_SYNC_MODE=off` 只让 `runHubSyncCycle` 短路（不 claim / 不 apply）；**触发器的 generation 记账继续**——每次 `knowledge` / `knowledge_edge` / hub-local `artifact` 写仍在写方事务内 bump generation（单用户规模开销可忽略）。所以若回滚原因**正是触发器本身**（perf / lock 争用），`off` 不缓解。真正的紧急停用 = DROP 三个触发器：

```sql
DROP TRIGGER IF EXISTS hub_sync_artifact_dirty ON artifact;
DROP TRIGGER IF EXISTS hub_sync_knowledge_dirty ON knowledge;
DROP TRIGGER IF EXISTS hub_sync_knowledge_edge_dirty ON knowledge_edge;
```

重建 = 重跑 `drizzle/0071` 的 `CREATE TRIGGER` 段（函数体仍在，无需重建）+ 跑一次 nightly repair（`runHubAutoSyncNightly`）补齐停用期间遗漏的 coverage。停用期间 abandoned `artifact_edit_session` 的清扫**不受 `off` 或 dormancy 影响**——它在 nightly 的 `beforeEligibility` 与 mode 门之前无条件跑（`sweepAbandonedEditSessions`），presence 卫生不该受 reconciler mode 或资格门控制。

**Restore 语义（R3）**：`hub_sync_reconciliation` 走 `BACKUP_EXCLUDED_TABLES`（非 FK_ORDER）——restore 重插 `artifact` 时 `hub_sync_artifact_dirty` 逐行 fan-out 重建每个 live hub 的 pending 游标（`O(atomics×hubs)` 的一次性 churn，单用户规模可忽略），nightly repair 兜底 coverage；故 restore 后无需手工补游标。

**Operator 面**：`GET /api/admin/hub-sync`（`readHubSyncHealth`，单条 filtered-aggregate；`capabilities/observability`）暴露 status 计数、`dirty_count` / `ready_count` / `expired_lease_count` / `invalid_document_count`、`oldest_dirty_age_seconds` / `oldest_invalid_age_seconds`、`max_consecutive_failure_count`、`max_generation_lag`（TEXT，bigint-safe）、`last_acknowledged_at` / `last_repair_key`、`triggers_installed`（provisioning 哨兵，见上 Provisioning 警告）。reconciler 每次 attempt 发一行结构化 NDJSON（`hub_sync_attempt`：artifact_id / generation / claim_token / reason / mode / outcome / duration_ms / error_class——**只带 id 与元数据，从不带文档正文**）。告警阈值：oldest dirty > 5m；expired lease 跨 > 2 个恢复周期仍在；invalid document > 15m；ready backlog 连续采样单调增长。mutation-to-ack 延迟 = `last_dirty_at` → `acknowledged_at`。

**所有权守卫**：`pnpm audit:hub-sync-writers`（`scripts/audit-hub-sync-writers.ts`，writer 清单在 `scripts/audit-hub-sync-writers-allowlist.json`）静态锁四不变量：拓扑写全部登记（触发器 own 正确性）、`hub_sync_reconciliation` + `app.hub_sync_internal_apply` 唯一属 `hub-sync-reconciliation.ts`、禁直接 `actorRef:'hub_auto_sync'` apply。

**并发注记 — atomic 硬删 vs finalizer 死锁 (X2)**：atomic 硬删事务持 atomic 行锁 → `AFTER DELETE` 触发器 fan-out 要更新 hub cursor；同时 finalizer 持 cursor 锁 → `syncBlockRefsForArtifact` 插 `artifact_block_ref(to_artifact_id=该 atomic)` 需该 atomic 行的 `KEY SHARE` → 两事务互等。这是**可能但收敛安全**的：PostgreSQL 死锁检测（默认 `deadlock_timeout` 1s）解环、abort 一边并抛 `40P01 deadlock_detected`。**finalize 侧**若被 abort，`40P01` 是 5 字符 SQLSTATE → `classifyHubSyncError` 归 `pg_transient` → classified retry → 下一周期自愈（无数据损失，义务不丢）。**删除侧调用方**若被 abort，需容忍并重试该删除（标准写侧重试纪律）。彻底消除方案（如 finalize 先验 refs、或延迟 block-ref fan-out）是 follow-up，非本 PR——单用户规模下死锁窗口极小，PG 解环 + 自愈已足。

### 十.2 Owner-local durable handoff protocols (YUK-861 NO-GO)

YUK-861 对 Verify、Notes、Memory 三条 durable handoff 做了架构 closeout；结论写入
[`ADR-0052`](adr/0052-owner-local-durable-handoff-protocols.md)：它们都支持 crash recovery，但不是同一
个协议，不建立 generic handoff core 或 callback workflow shell。

| owner | 事实与提交边界 | receipt / recovery |
|---|---|---|
| Verify (`src/capabilities/practice/server/verify-dispatch-outbox.ts`) | draft 与 `writeVerifyDispatchIntent()` 同一 transaction；`dispatchPendingVerifyIntents()` 锁 pending intent，并用 `fromPgBossDrizzleTx(tx)` enqueue | enqueue 与 per-question/verifier completion 同一 transaction；失败保留 intent，`recoverOrphanVerifyDispatches()` 只恢复 verify |
| Notes (`src/capabilities/notes/server/note-handoff.ts`) | artifact transaction 写 append-only intent；queue send 在 commit 后发生 | exact returned job ID 或 exact `getJobById()` readback 确认 receipt 后写 completion；`hub_sync_recovery` 作为共享 floor，claim/result recovery 仍由 Notes 自己拥有 |
| Memory (`src/server/memory/memory-reconcile-handoff*.ts`) | DB transaction 只写 marker/intent/completion/cursor；Mem0 lookup/SDK 与 pg-boss 在 transaction 外 | 上游 provider truth 由 fence、`add_started` 和 resolution 约束；下游一个 batch job 的 exact receipt 被物化为共享 job/digest 的多条 per-memory completion；严格 `observe|write|recover|drain` 与 append-only bounded cursor 保持 Memory-owned |

这三个边界必须继续由各 owner 维护。重复少量机械 dispatch/readback 代码是可接受的架构成本；
不得以 callback 成功、共享 completion 或统一 optional-field shell 替代真实 transaction、provider、
digest、cursor 与 receipt 语义。

**学习会话 (LearningSession) 多态状态机** (ADR-0008，演化自 ADR-0005；[CONTEXT.md](../CONTEXT.md) "录入会话")：

`learning_session` 承载 7 种 type：`ingestion | review | tutor | conversation | placement` 有实装状态机，`explore | create` 仍是 `placeholder` 单值占位。per-type status enum 与判别联合在 `src/core/schema/learning_session.ts`（`LearningSessionStatusByType`）；状态图与合法取值以该文件与各 lifecycle owner 为准，本文不复制。

**Single owner invariant** (ADR-0005 / ADR-0008)：每个 type 只有一个 lifecycle owner。Placement 完整状态操作归 `src/capabilities/practice/server/placement-session-lifecycle.ts`；本域直接消费，外部 orphan caller 经 `practice/public.ts` 调用并持有原事务与 receipt。其他 type 由各自现役 lifecycle owner 负责。route / handler 不允许直接 `db.update(learning_session)`。

**OCR 抽取层** (ADR-0002 修订)：用 Tencent QuestionMarkAgent (async submit+poll)，**不再 cascade**。Vision Tier 2/3 (haiku / sonnet) 仅作为**用户触发的救援**，走 `/api/ingestion/[id]/rescue`，永不参与自动 fallback。

**pg-boss dev harness**：`echo_jobs` 表 + `echo` job + `src/server/boss/handlers/echo.ts` 是 Sub 0c 的 enqueue → pg-boss worker → notify → SSE 联调通道，**不是生产业务路由**；HTTP 路由已不在 manifest 声明中。

**命名澄清**：`Tool` (LLM 函数原语) ≠ `tool_*` Artifact (互动型产出物)。前者是 AI 任务层的实现细节，后者是用户消费的内容对象。两个层级不冲突但同名易混。

### Direct-provider attempt admission and cost truth

Direct and opaque provider calls use `provider_attempt` as their durable lifecycle and cost truth.
The closed lane set and `off -> observe -> enforce` resolver are documented in
`docs/runbooks/provider-attempt-admission.md`. This gate is separate from the pi query-session
gate (`provider_session_admission`). Admission `off` bypasses limiting while provider calls
remain durably traced on a best-effort basis; a persistence outage may leave an off-mode call
untracked. When persistence is available, the admission row retains exact `mode = off` with an
`acquired` lifecycle lease for fencing and settlement; it never emits `would_deny` and is excluded
from capacity/rate/mixed-policy aggregation. Cost readers union terminal, provider-started attempts
with existing `cost_ledger` rows. Only durable exact attempt-ID links are de-duplicated. Unlinked
historical OCR job-level rows remain visible as explicit legacy truth; exact-head code no longer
writes new mirrors. Readers never copy provider attempts into `cost_ledger`.
