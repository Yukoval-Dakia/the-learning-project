# boss/handlers — pg-boss job & cron catalog

> 每个 `*.ts` = 一个 pg-boss queue handler（`buildXxxHandler(db)`）。housekeeping 的注册 + 调度集中在 [`../handlers.ts`](../handlers.ts)（worker 启动时 `registerHandlers()` 调一次）；capability 域 cron 经各自 `manifest.ts` → `register-capability-jobs.ts` 注册；memory 3 条经 `src/server/memory/triggers.ts` `registerMemoryHandlers` 注册。tz 默认 `Asia/Shanghai`，**例外：memory outbox 两条走 UTC**。本表是全仓 cron 权威目录（32 条；YUK-700 新增 verify recovery；上一版只列 11 条已过时）。

## CRON — 每日夜链（按时序串，Asia/Shanghai）
| Queue | cron | 注册点 | 说明 |
|-------|------|--------|------|
| `knowledge_edge_propose_nightly` | `30 2` | knowledge/manifest | 24h 失败窗提边（空窗早退；watermark 续扫 = YUK-377 轻量档待做）|
| `hub_auto_sync_nightly` | `45 2` | notes/manifest | hub auto-zone 重算。**真 barrier：必须在 02:30 之后**——edge_propose 夜批 SUPERSEDE 自主写 live 边，02:45 是唯一消费路径（YUK-377 复审 §3.2/YUK-384）|
| `knowledge_maintenance_nightly` | `0 3` | knowledge/manifest | KnowledgeReviewTask 维护流 |
| `memory_brief_sweep` | `0 3` | memory/triggers.ts | stale brief 扫描 → enqueueBriefRegen（6min singleton；subject 腿事件化 = YUK-581）|
| `dreaming_nightly` | `15 3` | agency/manifest | Dreaming producer（DomainTool MCP bridge）|
| `coach_daily` | `45 3` | agency/manifest | TodayPlan/brief（旧 review_plan 链投已 retire）|
| `goal_scope_propose_nightly` | `50 3` | agency/manifest | mastery tree-snapshot 提议 goal_scope（cap=1）|
| `prune_job_events` | `0 4` | ../handlers.ts | 30d bulk DELETE（其它 prune 错开避锁）|
| `verify_dispatch_recover` | `10 4` | ../handlers.ts | durable intent 恢复；只补发 source/quiz verify（另在 worker startup 单次触发）|
| `prune_orphan_review_sessions` | `15 4` | ../handlers.ts | 弃置 >6h stuck review session（sendBeacon-miss 安全网）|
| `item_prior_backfill` | `20 4` | practice/manifest | 无硬轨行新题 → ItemPriorTask 写 b 锚（cap 25/夜）|
| `prune_orphan_conversation_sessions` | `25 4` | ../handlers.ts | 弃置 stuck conversation（错峰避 learning_session 锁）|
| `prune_orphan_placement_sessions` | `35 4` | ../handlers.ts | 弃置 stuck placement；dark-ship（placement flag off）|
| `research_meeting_nightly` | `10 4` | agency/manifest | reconcile-before-propose 教研例会（空夜早退，不写空 anchor/scan 事件）|
| `embed_backfill` | `40 4` | practice/manifest | `embedding IS NULL` 扫描（question+knowledge，limit 100）|
| `recalibration_nightly` | `50 4` | practice/manifest | 攒够 label → b_calib firm-up（compose 前就位）|
| `answer_class_backfill` | `0 5` | practice/manifest | 纯派生 NULL 尾兜底（on-write `withAnswerClass` 已全量上线）|
| `kc_dedup_nightly` | `5 5` | knowledge/manifest | pgvector 近重 KC → merge 提议。**在 embed 04:40 之后**（scan 硬 gate `embedding IS NOT NULL`；原 02:00 恒滞后一天，YUK-377 复审 §3.3 改期）|
| `kt_estimate_nightly` | `10 5` | practice/manifest | BKT kt_json（零下游消费者；owner 拍 2026-07-06 保持每日）|
| `frontier_fill_nightly` | `15 5` | knowledge/manifest | frontier 空时 propose prereq 边（skipped_dense 零 LLM gate）|
| `reference_answer_backfill` | `20 5` | practice/manifest | `reference_md IS NULL` → 参考答案（compose 前就位）|
| `practice_stream_compose_nightly` | `30 5` | practice/manifest | 预产今日练习流（单飞锁幂等；lazy 首读即恢复路径）|
| `axis_state_nightly` | `40 5` | practice/manifest | EZ-diffusion 描述符（display-only，placement-profile 读）|
| `question_supply_nightly` | `0 6` | practice/manifest | 缺口扫描 → sourcing/quiz_gen（7d 指纹 cooldown 是唯一成本闸）|
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
