# boss/handlers — 通用 pg-boss handler 与调度登记点

> 本目录只放通用（非 capability）job 的 handler 工厂 `buildXxxHandler(db)`。这里**不是**调度目录：job 与 cron 的真相源是各 capability `manifest.ts` 的 `jobs.handlers` 声明（`name` / `schedule` / `dependsOn` / `backend` / `eligibility`），经 `../register-capability-jobs.ts` 注册。要看全仓现役调度，读 manifest 或管理端配置读面（`src/server/admin/config-facts-host.ts` 的 `manifest_schedules` + `infra_schedules`，由同一批声明投影）。tz 默认 `Asia/Shanghai`。

## manifest 之外的调度登记点
不在任何 capability manifest 里的 cron 只有这几处，每处都是一张静态表或单一常量：
- `nightly_orchestrator`（`30 2`）：`src/server/orchestration/register.ts` + `constants.ts`，DAG 单锚点（见下节）。
- `INFRA_HOUSEKEEPING_SCHEDULES`（`../infra-schedules.ts`，`../handlers.ts` 启动时登记）：`promote_conversation_idle`、`verify_dispatch_recover`。
- `MEMORY_INFRA_SCHEDULES`（`src/capabilities/agency/server/memory/triggers.ts`，`../memory-queues.ts` 登记）：memory brief / outbox 队列，**outbox 两条走 UTC**。
- `event_subscription_dispatch`：`src/server/events/subscriptions/dispatch-mount.ts`。

`prune_job_events`、`prune_orphan_review_sessions`、`prune_orphan_conversation_sessions`、`prune_orphan_placement_sessions` 声明在 `src/capabilities/observability/manifest.ts`（`backend: 'dbos'`），由 `../register-capability-jobs.ts` 交给共享 durable host（`src/server/durable/prune-worker.ts`、`session-orphan-worker.ts`、`review-orphan-worker.ts`）挂载，**不在** `../handlers.ts`。

## 退役 cron 的库内清理
从 manifest 删掉一个带 schedule 的 job 后，旧库的 `pgboss.schedule` 行不会自己消失。整体退役（handler 一并删除）时把队列名加进 `src/server/orchestration/register.ts` 的 `RETIRED_BARE_CRONS`：orchestrator 挂载时对其 `unschedule` 并删掉排队中的行。只去掉 schedule、保留 handler 的 job 不能进这张表（它会删掉按需入队的任务），旧 schedule 行须在发布窗口手工清除。

## DAG 编排（YUK-758）—— 成员**没有自己的 cron**
> 成员 = manifest 里带 `dependsOn` 字段的 job（含 `[]` 根），由 kernel `projectDagMembers` 投影。单锚点 `nightly_orchestrator` 开闸建当夜 run + enqueue 根节点，此后每 60s 一 tick 轮询 pg-boss job 态、上游成功才 enqueue 下游。`validateComposition` 启动期强制「成员不得同时带 cron」。**改这些 job 的时序 = 改 `dependsOn` 边，不是改 cron 时刻**；orchestrator 启动时还会对每个成员跑一次 `boss.unschedule`（清升级前残留的旧 schedule 行）。
>
> 逐边失败语义：硬边（默认）上游 failed/skipped → 下游 skipped 留痕；`soft` 边上游未成功时下游**照跑**，事实只记在 `dag_orchestration_node.stale` 上——**handler 收不到任何 stale 信号**（成员 job 的 payload 恒为 `{}`）。软边的全部含义就是「不阻塞」。YUK-1560：`not_needed` / `degraded` 也是软终态（不连坐），原因写在 `dag_orchestration_node.detail`。
>
> 可观测（YUK-778）：run 起步 / 收尾（带节点总账，含 stale 计数）、每个 failed（error）/ skipped（warn）节点、跨日 run 被 abandon（error + 放弃前总账）都会打进程日志——两张调度态表是 `BACKUP_EXCLUDED` 且读面（YUK-774）未建，日志是当前唯一诊断出口。`nightly_orchestrator` 队列另有 `nightly_orchestrator_dlq`：tick 抛到 pg-boss 并耗尽重试预算后残骸落 DLQ 保留 7d。重试退避是**带抖动的指数**（`plans.js:1653-1656`，`retry_delay_max` 为 NULL 故无上限钳）：retryDelay 30s ⇒ 第一次重投递 30–60s、第二次 60–120s。
>
> 裸 cron 的 `eligibility` 在 handler 入口判定：`beforeEligibility` 先跑（必须无视 dormancy 的 housekeeping 放这里），跳过结果写 pg-boss job output 的 `job_eligibility`（`status: 'not_needed'` + reason/tier），不再空返回。

## 事件触发链（enqueue-by-event，非 cron）
- `note_generate` 由 Notes manifest 注册；同事务 intent + 提交后 deterministic dispatch 衔接，由 `hub_sync_recovery` 每分钟补投。
- `attribution_followup`（替代 inline `after()`）→ `variant_gen`；accept 后 → `variant_verify`
- `quiz_gen` → `quiz_verify`、`sourcing` / `jyeoo_fetch` → `source_verify`、`variant_verify` —— YUK-868 起全部由 practice/manifest 声明注册（`quiz_gen` handler 在 `src/capabilities/practice/jobs/`，三条 verify handler 在 `src/capabilities/practice/question-bank/jobs/`），中央 handlers.ts 不再登记这三条 verify 队列；`verify_dispatch_recover` 仍由基础设施 `../verify-dispatch-recovery.ts` 装配，协议归 `src/capabilities/practice/question-bank/server/verify-dispatch-outbox.ts`；只补发，queue 名不变
- `tencent_ocr_extract` —— 生产 OCR async（R2 creds 缺失不应破坏 test worker：lazy `get r2()`）
- `session_summary` —— review session end 后 enqueue
- `note_refine` —— 5 trigger 之一触发；NotePatch `≤3 ops AND ≤2 new blocks → mutator`，否则 propose
- `learner_return_wake` —— YUK-1560：订阅 kernel `LEARNING_ACTIVITY_ACTIONS` 入队。只在入队前档位是空闲或休眠时准备今日安排和限量补题；允许推导的事件才刷新 `subject:` 简报。任何档位都先经 `src/kernel/coach-wake.ts` 判断教练计划是否过期
- `coach_daily` —— 不在夜间 DAG。`learner_return_wake` 在「24h 内无 coach 运行且此后有允许推导的学习活动」时入队，singleton `coach.wake` 24h 槽（每槽至多一个 job，与原每夜一次同界；llm 档失败重试各自计费，与改前相同）

## YUK-1393 review orphan recovery

- One process owns one DBOS SDK host. Production collects both admitted declarations before launch. The prune-only fixture entry remains compatible; it cannot be expanded after launch.
- Review has independent control, immutable tick/row receipt and append-only disposition tables. Native timestamp provenance is scheduled; legacy provenance is first admission of the actual job ID.
- Draining finishes admitted lists and fences unadmitted ticks from either backend, including already queued legacy deliveries. An uncertain COMMIT requires the writable primary's tick lock and receipt, never current-state convergence or a blind retry.
- Phase finish requires task/receipt/SEND_IT obligations to settle and recorded old-consumer/producer quiescence. The 60-second rollback horizon is an additional minimum, not proof that suspended senders disappeared. Old selected-row handlers have no business fence; stop them before cutover.
- DB/process/cron acceptance for this implementation is pending. Unit/static/build evidence does not establish runtime migration or full-DB restore safety. Full recovery includes both family ledgers, pg-boss and tlp_dbos together.

## CONVENTIONS
- handler 是工厂 `build*(db, opts?)`，返回 pg-boss work fn；若需不变量测试（YUK-1401），旁置 `*.test.ts`。
- 默认 `localConcurrency 1, batchSize 1`，无 `singleton`——单 worker 串行，跨进程靠 DB version lock。
- generic boss job 才加进 `../handlers.ts`；capability job 只经对应 manifest 声明。

## ANTI-PATTERNS
- 别在 handler factory 外调 `getR2()`——缺 env 会炸 test worker 启动。
- 改 cron 时刻前先看链上 offset 注释（避免锁竞争 / 读不到同夜 proposal）。
