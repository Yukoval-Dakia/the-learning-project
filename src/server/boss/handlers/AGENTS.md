# boss/handlers — pg-boss job & cron catalog

> 每个 `*.ts` = 一个 pg-boss queue handler（`buildXxxHandler(db)`）。housekeeping 的注册 + 调度集中在 [`../handlers.ts`](../handlers.ts)（worker 启动时 `registerHandlers()` 调一次）；capability 域 cron 经各自 `manifest.ts` → `register-capability-jobs.ts` 注册；memory 3 条经 `src/server/memory/triggers.ts` `registerMemoryHandlers` 注册。tz 默认 `Asia/Shanghai`，**例外：memory outbox 两条走 UTC**。本表是全仓**调度**权威目录——自 YUK-758 起分两类：**裸 cron**（下表）与 **DAG 成员**（无自身 cron，由夜间 orchestrator 单锚点按依赖触发）。

## DAG 编排（YUK-758）—— 这些 job **没有自己的 cron**
> 单锚点 `nightly_orchestrator` cron `30 2` Asia/Shanghai（`src/server/orchestration/constants.ts`）开闸建当夜 run + enqueue 根节点，此后每 60s 一 tick 轮询 pg-boss job 态、上游成功才 enqueue 下游。依赖在各 `manifest.ts` 的 `JobDecl.dependsOn` 上声明，`validateComposition` 启动期强制「成员不得同时带 cron」。**改这些 job 的时序 = 改 `dependsOn` 边，不是改 cron 时刻**；orchestrator 启动时还会对每个成员跑一次 `boss.unschedule`（清升级前残留的旧 schedule 行）。
>
> 逐边失败语义：硬边（默认）上游 failed/skipped → 下游 skipped 留痕；`soft` 边上游未成功时下游**照跑**，事实只记在 `dag_orchestration_node.stale` 上——**handler 收不到任何 stale 信号**（YUK-778 删掉了那条从来没有消费者的 `{ stale: true }` job payload；成员 job 的 payload 恒为 `{}`）。软边的全部含义就是「不阻塞」。
>
> 可观测（YUK-778）：run 起步 / 收尾（带节点总账，含 stale 计数）、每个 failed（error）/ skipped（warn）节点、跨日 run 被 abandon（error + 放弃前总账）都会打进程日志——两张调度态表是 `BACKUP_EXCLUDED` 且读面（YUK-774）未建，日志是当前唯一诊断出口。`nightly_orchestrator` 队列另有 `nightly_orchestrator_dlq`：tick 抛到 pg-boss 并耗尽重试预算后残骸落 DLQ 保留 7d。重试退避是**带抖动的指数**（`plans.js:1653-1656`，`retry_delay_max` 为 NULL 故无上限钳）：retryDelay 30s ⇒ 第一次重投递 30–60s、第二次 60–120s。

| Queue | 上游边 | 注册点 | 说明 |
|-------|--------|--------|------|
| `item_prior_backfill` | 根 | practice/manifest | 无硬轨行新题 → ItemPriorTask 写 b 锚（cap 25/夜）；`item_calibration.b` 锚**种子**写者 |
| `recalibration_nightly` | ← `item_prior_backfill` **硬** | practice/manifest | 攒够 label → `b_calib` firm-up。真读后写（同表 b 锚：种子先、firm 后）|
| `practice_stream_compose_nightly` | ← `recalibration_nightly` **硬** | practice/manifest | 预产今日练习流；选题实读 `item_calibration.b_calib`（单飞锁幂等；lazy 首读即恢复路径）|
| `question_supply_nightly` | ← `recalibration_nightly` **硬** | practice/manifest | 缺口扫描 → sourcing/quiz_gen；R3 近-θ̂ 判定实读 `b_calib`→`effectiveB`（7d 指纹 cooldown 是唯一成本闸）|
| `embed_backfill` | 根 | practice/manifest | `embedding IS NULL` 扫描（question+knowledge，limit 100）|
| `kc_dedup_nightly` | ← `embed_backfill` **硬**（跨包）| knowledge/manifest | pgvector 近重 KC → merge 提议。硬 gate `embedding IS NOT NULL`——**旧 02:00 恒滞后一天**的时钟 bug 现由边根治（YUK-377 复审 §3.3）|
| `answer_class_backfill` | 根（**无下游**）| practice/manifest | 纯派生 NULL 尾兜底（on-write `withAnswerClass` 已全量上线）。曾被当作 supply 上游，YUK-758 考据证伪 |
| `knowledge_edge_propose_nightly` | 根 | knowledge/manifest | 24h 失败窗提边（空窗早退；watermark 续扫 = YUK-377 轻量档待做）|
| `knowledge_maintenance_nightly` | ← `knowledge_edge_propose_nightly` **软** | knowledge/manifest | KnowledgeReviewTask 维护流。软边：读 proposal inbox 当去重基线，上游挂了照样正确产出 |
| `dreaming_nightly` | ← `edge_propose` **软** + `knowledge_maintenance_nightly` **软** | agency/manifest | Dreaming producer（DomainTool MCP bridge）|
| `coach_daily` | 根 | agency/manifest | TodayPlan/brief（旧 review_plan 链投已 retire）。读在线 mastery/session 态，旧 03:45 错峰=时钟巧合 |
| `goal_scope_propose_nightly` | 根 | agency/manifest | mastery tree-snapshot 提议 goal_scope（cap=1）|
| `research_meeting_nightly` | 根 | agency/manifest | reconcile-before-propose 教研例会（空夜早退，不写空 anchor/scan 事件）|
| `frontier_fill_nightly` | 根 | knowledge/manifest | frontier 空时 propose prereq 边（skipped_dense 零 LLM gate）。PROPOSE-ONLY，产物需人 accept |

## CRON — 每日夜链（裸 cron，按时序串，Asia/Shanghai）
| Queue | cron | 注册点 | 说明 |
|-------|------|--------|------|
| `nightly_orchestrator` | `30 2` | orchestration/register.ts | **DAG 单锚点**（见上节）——建当夜 run + enqueue 根节点，随后 60s 自调度 tick。整夜单点，故按 `createJobQueue` 配方建队（retryDelay 30s + backoff + `nightly_orchestrator_dlq`），不再继承 pg-boss 的 retry_delay 0 / 无 DLQ 默认（YUK-778）|
| `hub_auto_sync_nightly` | `45 2` | notes/manifest | hub auto-zone 重算。**与 `knowledge_edge_propose_nightly` 无运行期依赖**——旧表曾写「真 barrier：edge_propose 夜批 SUPERSEDE 自主写 live 边，此处是唯一消费路径」，该说法**已被代码证伪**（YUK-758 review ToTt717）：`runEdgeProposeAndWrite` 的 SUPERSEDE 分支只 `writeAiProposal` 落**待接受提议**，`propose_edge.ts:614-616` 自述「leaves both live accumulators unchanged **until the user accepts it**」，夜批从不自主改 live 边；本 job 侧也只是推进自己的 reconciliation cursor。故二者是各自独立的 sweep，02:45 与锚点 02:30 的先后是**时钟巧合**，不需要编边 |
| `memory_brief_sweep` | `0 3` | memory/triggers.ts | stale brief 扫描 → enqueueBriefRegen（6min singleton；subject 腿事件化 = YUK-581）|
| `prune_job_events` | `0 4` | ../handlers.ts | 30d bulk DELETE（其它 prune 错开避锁）|
| `verify_dispatch_recover` | `10 4` | ../handlers.ts | durable intent 恢复；只补发 source/quiz verify（另在 worker startup 单次触发）|
| `prune_orphan_review_sessions` | `15 4` | ../handlers.ts | 弃置 >6h stuck review session（sendBeacon-miss 安全网）|
| `prune_orphan_conversation_sessions` | `25 4` | ../handlers.ts | 弃置 stuck conversation（错峰避 learning_session 锁）|
| `prune_orphan_placement_sessions` | `35 4` | ../handlers.ts | 弃置 stuck placement；dark-ship（placement flag off）|
| `kt_estimate_nightly` | `10 5` | practice/manifest | BKT kt_json（零下游消费者；owner 拍 2026-07-06 保持每日）|
| `reference_answer_backfill` | `20 5` | practice/manifest | `reference_md IS NULL` → 参考答案。**不入 compose 选题路径**（走判分/UI），故 YUK-758 未编边、留裸 cron |
| `axis_state_nightly` | `40 5` | practice/manifest | EZ-diffusion 描述符（display-only，placement-profile 读）|
| `confusable_contrast_nightly` | `20 6` | practice/manifest | DARK（flag off = discovery 返 [] NO-OP；owner 拍 2026-07-06 保留空转）|

## CRON — 周批
| Queue | cron | 注册点 | 说明 |
|-------|------|--------|------|
| `coach_weekly` | `30 4 * * 0`（周日）| agency/manifest | weekly_reflection |
| `merge_attribution_sweep` | `0 4 * * 1`（周一）| knowledge/manifest | merge 残留竞态 census + bounded auto-repair（cap 50）|
| `projection_oracle_sweep` | `30 4 * * 1`（周一）| knowledge/manifest | REPORT-ONLY projection 漂移 oracle |
| `kg_borrow_shadow_sweep` | `0 5 * * 1`（周一）| knowledge/manifest | A5/A6 shadow 遥测（特意周批防 outbox 扇出）|

## CRON — 高频
| Queue | cron | 注册点 | 说明 |
|-------|------|--------|------|
| `promote_conversation_idle` | `* * * * *` | ../handlers.ts | 每分钟 active→idle（5min 无输入；idle=事件缺席，只能 poll）|
| `memory_ingest_outbox_poll` | `* * * * *`（**UTC**）| memory/triggers.ts | ADR-0021 transactional outbox dispatch 心跳（**不可降频**——写点直投=复刻已回滚 PR #163）|
| `memory_ingest_outbox_recover` | `0 * * * *`（**UTC**）| memory/triggers.ts | outbox 排空 recovery drain（cap 1000 cycles）|
| `copilot_run_reconcile` | `0-58/2 * * * *` | copilot/manifest | YUK-596/YUK-832 — durable Copilot 收敛底线：偶数分钟执行（最多等两分钟），每轮只扫 20 个 outstanding run、reconcile 自身零 LLM/tool；先修持久化 outcome marker，再以 pg-boss 权威状态区分 live / dead / lookup unknown。只对 QUEUED-only、无任何 worker-touch 的 queue-proven dead run 写 `pre_execution_lost`；explicit fence 或 legacy STARTED/DELTA/STEP/REPLY/FAILED(error) 都视为可能执行过，须等主任务 12min + 最终证据审阅最坏 18min（2×5min blind reference + 4×2min comparison）+ 30s settlement grace 后才写无 checkpoint 的 `ambiguous_execution`。created/retry/active 与 lookup error 均不终态化。|
| `judge_pending_reconcile` | `50 * * * *` | practice/manifest | YUK-777 A3 — durable judge 的 domain-state-scan sweeper：扫「作答已录、判词未落」的 `experimental:judge_pending_attempt`（无 `event.id = run_id` 的 review），经**同一 rate-limited 入队面**重投 `judge_run`。**每小时而非夜批**：这是学习者面前悬着的判词，等一夜等于丢一天；stall 门槛 15min + pg-boss liveness 权威判定，故不会抢在飞的 run。自身零 LLM（付费发生在 `judge_run`）→ fast 层。恢复次数封顶（`judge_run.requeued` 计数）+ 7d 年龄封顶后转人工（D6 manual-only，YUK-800 A4）|

## 事件触发链（enqueue-by-event，非 cron）
- `note_generate` →`onReady`→ `note_verify`（YUK-358 决定3：`onPassed` 链已删——`embedded_check_generate` 孤儿链真删后无下游消费者）
- `attribution_followup`（替代 inline `after()`）→ `variant_gen`；accept 后 → `variant_verify`
- `tencent_ocr_extract` —— 生产 OCR async（R2 creds 缺失不应破坏 test worker：lazy `get r2()`）
- `session_summary` —— review session end 后 enqueue
- `note_refine` —— 5 trigger 之一触发；NotePatch `≤3 ops AND ≤2 new blocks → mutator`，否则 propose

## CONVENTIONS
- handler 是工厂 `build*(db, opts?)`，返回 pg-boss work fn；测试旁置 `*.test.ts`。
- 默认 `localConcurrency 1, batchSize 1`，无 `singleton`——单 worker 串行，跨进程靠 DB version lock。
- 新 job：建 queue + work + （如 cron）schedule，全部加进 `../handlers.ts`，并在此表登记时序理由。

## ANTI-PATTERNS
- 别在 handler factory 外调 `getR2()`——缺 env 会炸 test worker 启动。
- 改 cron 时刻前先看链上 offset 注释（避免锁竞争 / 读不到同夜 proposal）。
