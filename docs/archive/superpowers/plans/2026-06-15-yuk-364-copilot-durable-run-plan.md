# YUK-364 — Copilot durable run（endurance W1 L2）lane plan

> ADR-0041 endurance W1 第 2 层。把 copilot 从同步面桥到异步 durable pg-boss 面。后端纯改，无 UI。
> 现场写于 fresh `yuk-364-copilot-durable-run`（off main），grounding 对着真实代码核验，2026-06-15。

## Grounding 摘要（实际看到的形态 file:line）

- **capability jobs 贡献制完整**：`src/kernel/manifest.ts:42-54` 定义 `JobDecl`（name / schedule? / queue:'llm'|'agent'|'fast' / load? thunk）；`src/server/boss/register-capability-jobs.ts:46-81` 遍历 `cap.jobs.handlers` 建队 + `boss.work(name, {pollingIntervalSeconds:2, batchSize:1}, factory(db))` + cron schedule。`start-worker.ts:75-79` 先 `registerHandlers`（渐缩簿）再 `registerCapabilityJobs(boss, db, capabilities)`。**copilot manifest（`src/capabilities/copilot/manifest.ts`）当前无 `jobs:` 字段 → 需新增**。范例形态见 agency manifest `jobs.handlers`（`src/capabilities/agency/manifest.ts:20-53`，cron job）；按需/链式 job（无 schedule）形态等价，只是不带 schedule。
- **quiz_gen 工厂蓝本**（`src/server/boss/handlers/quiz_gen.ts`）：`runQuizGen`（:393）构 `triggerEventId`（:408）→ `buildMcpServerFromRegistry({ ctx:{ db, taskRunId, callerActor, causedByEventId: triggerEventId }, serverName: DOMAIN_TOOL_MCP_SERVER_NAME, toolNames, taskKind })`（:415-425）→ `run('QuizGenTask', input, { db, mcpServers, allowedTools, ... })`（:503）→ 成功/失败各 `writeEvent`（:715 / :763）→ `buildQuizGenHandler(db)` 工厂（:790）`for job: runQuizGen(...)`。
- **copilot 同步面**（`src/capabilities/copilot/server/chat.ts`）：`runCopilotChatImpl`（:611）；user_ask event id = `copilot_user_ask_${createId()}`（:692），它就是 `causedByEventId`（:712）；free-form MCP mount（:929-952）用 `resolveDomainToolNames(surface)` + `taskKind:'CopilotTask'` + `causedByEventId`；run input（:991-1007）含 surface/triggered_by/user_message/conversation_history/ambient_context；reply 事件 `copilot_reply_${createId()}`（:1073）。surface 经 `selectSurface(req.triggered_by)`、actorRef `selectActorRef`。`CopilotChatRequest` schema（:153-179）。
- **CopilotTask registry**（`src/ai/registry.ts:488-`）：`maxIterations:6` / `timeout:60_000` / `needsToolCall:true` / `allowedTools:[]`（chat endpoint per-request resolve surface）。
- **job_events 进度流基建齐全**：`writeJobEvent(tx: Db | Tx, {business_table, business_id, event_type, payload})`（`src/server/events/writer.ts:22`）—— **接受 `Db | Tx`**，逐 step 直接传 `db`（每次隐式 tx，commit 后 pg_notify 立即发），范例 `src/server/events/ingestion-progress.ts:56-68`（per-step 进度）。`computeReplay(db, {businessTable, businessId, lastEventId})`（`src/server/events/sse_replay.ts:27`）。`job_events` 表（`src/db/schema.ts:525-539`）：id(identity PK) / business_table / business_id / event_type / payload(jsonb) / occurred_at。消费端范例 `src/capabilities/ingestion/api/events.ts`。
- **boss dispatch 守门**：路由侧 `if (shouldEnqueueBackgroundJobs())`（`@/server/runtime-env`）`+ const boss = await getStartedBoss()`（`@/server/boss/client`）`+ boss.send(queue, data)`，范例 `src/capabilities/practice/api/session-end.ts:63-70`。
- **causedByEventId 已就位**（`src/server/ai/tools/types.ts:38-44`）：`ToolContext.causedByEventId?` 存在；mirror writer 从 `ctx.causedByEventId ?? null` 读。
- **worker 零前置**（grounding 权威，覆盖分支上 stale ADR）：worker 每个 AI job 经 `buildMcpServerFromRegistry`，幂等 `registerCoreTools()` 填 CORE_TOOLS 全集（41 条，是 manifest union 26 的真超集）→ 新 handler 自动有 copilot 全集工具。**不碰 start-worker.ts / registerCapabilityCopilotTools。**

## 关键设计裁决（按最小 / 最不引入新真相源走）

1. **不新增表**。run handle = checkpoint_id = user_ask event id（`run_id`）。状态从 `computeReplay(db, {businessTable:'copilot_run', businessId:run_id})` 末事件 `event_type` 派生（`copilot_run.queued` → `.step` → `.reply` → `.done` / `.failed`）。`job_events` 即 SoT，与 ingestion / echo 同型。**理由**：ADR 明确「能不加表就不加」，event log 已是 SoT，瘦 handle 表（活跃 run / 重连）当前无 UI 消费者（run card 订阅 UI 是非 scope 后续 lane），加了就是死写路径会触 audit:schema。→ 报告里标出，请 owner 复核。
2. **sync/async 路由判定放哪 + 阈值**：放在 `copilot/api/chat.ts`（route 入口，dispatch 层）。粗启发 v1：仅当请求显式带 `durable: true` 标记（CopilotChatRequest 新增 optional bool 字段，默认 absent → 走现有 inline `runCopilotChatStreaming` 不动）时 dispatch 到 `copilot_run` 队列。**理由**：scope 写「短活仍走现有 inline streamTaskCollecting 不动」「判定阈值留注释标『先粗、实测后调』」。用显式标记是「最粗、最不误伤短活」的 v1——不猜测 needsToolCall/预估多步（那会改动同步面分类逻辑，风险高）。当前无 UI 会传 `durable:true`，所以本 lane 落地后同步面行为 byte-identical，durable 面经测试 + 未来 UI/手动触发激活。→ 阈值注释标 `先粗、实测后调`。请 owner 复核这个判定位置 + 显式标记的取舍。
3. **interrupt / 串行化**：copilot_run 队列建队走 `agent` 档（EXPIRE_AGENT，同 quiz_gen）。`boss.work` 默认 `batchSize:1` + 注册器固定 `pollingIntervalSeconds:2, batchSize:1` → 天然一次一 job（n=1 单线程语义由 batchSize:1 提供）。cancellation-aware：handler 在每个 SDK run 前后查一个协作 abort 信号——v1 用 `job.data.run_id` 对应是否已有 `copilot_run.cancel_requested` 事件写入 job_events（回合间查 computeReplay 末态含 cancel）→ 早停写 `.failed`(reason:cancelled)。v1 单 SDK run（CopilotTask 自身 maxIterations:6 内部循环），所以「回合间」= run 启动前查一次 + SDK signal 透传（AbortController 接 cancel 事件轮询）。**简化**：v1 只做「启动前查 cancel」+ 不做 live-steer。

## 文件清单

### 创建
- `src/server/boss/handlers/copilot_run.ts` — durable copilot run handler 工厂。`runCopilotRun(params)` 照 quiz_gen：构 MCP（toolNames=copilot 全集 via `resolveDomainToolNames('copilot')`，taskKind 'CopilotTask'）+ ToolContext `causedByEventId: run_id` + `runAgentTask('CopilotTask', input, ...)`；边跑边 `writeJobEvent({business_table:'copilot_run', business_id:run_id, event_type, payload})` 写 queued/step/reply/done/failed。`buildCopilotRunHandler(db)` 工厂 `(jobs) => for job: runCopilotRun`。
- `src/server/boss/handlers/copilot_run.test.ts` — DB test（mock AI runAgentTaskFn dep；real DB writeJobEvent）：① happy path 写 queued→step→reply→done 事件序列 + computeReplay 末态 done；② AI throw → 写 failed 事件 + re-throw（pg-boss retry）；③ cancel 事件存在 → 启动前早停写 failed(cancelled)；④ run handle = run_id = 传入 checkpoint_id。
- `src/server/boss/handlers/copilot_run.derive-status.test.ts`（或并进上面）— 从 replay 末事件派生 status 的纯函数单测（unit 分区，无 DB）。
- `src/capabilities/copilot/server/copilot-run-status.ts` — 纯函数 `deriveCopilotRunStatus(events: ReplayEvent[]): CopilotRunStatus`（仿 `src/ui/lib/ingestion-phase.ts` 从 replay 派生 phase 同型）。导出 `COPILOT_RUN_TABLE='copilot_run'` 常量 + 事件 type 常量。

### 修改
- `src/capabilities/copilot/manifest.ts` — 新增 `jobs: { handlers: [{ name:'copilot_run', queue:'agent', load: () => import('@/server/boss/handlers/copilot_run').then(m => m.buildCopilotRunHandler) }] }`（无 schedule = 按需 job）。新增 `events.actions` 若需要（copilot_run 事件走 job_events 非 domain event 表 → 不需要进 events.actions；job_events 是 free-form event_type，见 ingestion-progress NOTE）。
- `src/capabilities/copilot/server/chat.ts` — `CopilotChatRequest` 新增 optional `durable: z.boolean().optional()`（向后兼容，absent→不变）。
- `src/capabilities/copilot/api/chat.ts` — dispatch 入口：parse 后，若 `parsed.durable && shouldEnqueueBackgroundJobs()` → 写 user_ask 事件得 run_id（checkpoint_id）→ `boss.send('copilot_run', { run_id, user_message, triggered_by, ... })` → 返回 `{ run_id }`（202-ish JSON，非 SSE）；否则走现有 `runCopilotChatStreaming`（不动）。**user_ask 事件写入归位**：durable 路径需要在 enqueue 前写 user_ask（domain event 表，作为 checkpoint_id），handler 内再以它做 causedByEventId。复用 chat.ts 既有 user_ask 写法或抽一个薄 helper —— 决策：抽 `writeCopilotUserAsk(db, {...}): Promise<string>` 到 chat.ts 导出，inline 与 durable 共用，零行为漂移。
- `postman/api-endpoints.json` — `/api/copilot/chat` 已存在；durable 是同 path 同 method 的 body 字段扩展（加 optional `durable`），spec body 描述更新即可（无新 route）。若 dispatch 不新增 path 则可能无需改 postman；确认后跑 `pnpm gen:postman`。

## 测试清单
- `pnpm test:db:watch src/server/boss/handlers/copilot_run.test.ts` 迭代 handler。
- `pnpm test:unit:watch` 跑 copilot-run-status 纯函数 + manifest composition（validateComposition 查 job 名唯一）。
- route dispatch 分支：copilot chat api test（durable=true → boss.send 被调 + 返回 run_id；durable absent → 走 streaming，byte-identical）。
- gate：typecheck / lint / audit:schema（**确认无新表 → 无新 write path 需求**）/ audit:partition（新 test 文件分区正确：copilot_run.test.ts 进 db，derive-status.test.ts 进 unit）/ audit:profile / test / build。

## 风险
- **audit:partition**：handler DB test import `@/db/client` / drizzle → 必须 db 分区；纯函数 status derive test 无 DB → unit 分区。放错会 fail。
- **audit:schema**：不新增表则零风险；若中途发现必须加瘦 handle 表，须进 FK_ORDER + SCHEMA_VERSION + write path + 注释（按 ADR），且会拖 gate —— 先按不加表走。
- **user_ask 事件双写**：durable 路径在 route 写 user_ask，inline 路径在 chat.ts 写 —— 抽共享 helper 防漂移，避免两份逻辑分叉。
- **gen-postman 对账层**：若不新增 route，spec 无死条目风险；若改了就跑 gen:postman。
- **同步面零回归红线**：durable 字段 absent 时所有现有路径必须 byte-identical（测试钉）。
