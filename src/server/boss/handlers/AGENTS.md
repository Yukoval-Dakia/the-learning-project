# boss/handlers — pg-boss job & cron catalog

> 每个 `*.ts` = 一个 pg-boss queue handler（`buildXxxHandler(db)`）。注册 + 调度集中在 [`../handlers.ts`](../handlers.ts)（worker 启动时 `registerHandlers()` 调一次）。tz 全用 `Asia/Shanghai`。

## CRON（夜间链，按时序串）
| Queue | cron | 说明 |
|-------|------|------|
| `knowledge_edge_propose_nightly` | `30 2` | mesh edge propose（看同夜 fresh 节点）|
| `hub_auto_sync_nightly` | `45 2` | hub auto-zone 重算（靠 version lock，非 heartbeat）|
| `knowledge_maintenance_nightly` | `0 3` | KnowledgeReviewTask 维护流 |
| `dreaming_nightly` | `15 3` | Dreaming producer（DomainTool MCP bridge）|
| `coach_daily` | `45 3` | 读 Dreaming 同夜 proposal |
| `goal_scope_propose_nightly` | `50 3` | 从累积 mastery 提议 goal_scope（在 coach_daily `45 3` 后、`0 4` prune 前；每夜 1 次，cap=1）|
| `prune_job_events` | `0 4` | bulk DELETE（其它 prune 错开避锁）|
| `prune_orphan_review_sessions` | `15 4` | 弃置 >6h stuck review session |
| `prune_orphan_conversation_sessions` | `25 4` | 弃置 stuck conversation |
| `coach_weekly` | `30 4 * * 0` | 周日 weekly_reflection |
| `promote_conversation_idle` | `* * * * *` | 每分钟 active→idle（5min 无输入）|

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
