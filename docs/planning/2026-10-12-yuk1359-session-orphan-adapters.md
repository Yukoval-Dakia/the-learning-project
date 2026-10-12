# Session orphan 适配入口收口（YUK-1359）

- 交付阶段：第一天能用；对应 YUK-1355 / YUK-1359 的共享业务操作与任务迁移。
- 起点：实时 fetch 的 `main` / `8fb160ed517c85a56cabbebfe1f1a19f137e4639`。
- 独立分支：`refactor/yuk-1359-session-orphan-adapters`，不依赖未合并的 PR #1704。
- 范围：conversation / placement orphan 两族的现役 pg-boss payload 适配归回已有 backend；没有切换 runtime owner。

## 两族业务操作与入口清单

两族的业务操作在本次之前已共用 `runSessionOrphanTick`。剩余两份
`boss/handlers` 文件各自仅做 job 名检查、串行转发和 payload 映射，唯一现役
consumer 是 `createSessionOrphanBackend`。本次将这段适配放回该既有 backend，
删除两份文件及其 builder / forwarding exports，没有新增业务操作或 wrapper。

| 族 / manifest queue | 保留的业务写者 | 本次退出的旧源码入口 | 收口后的 pg-boss 入口 |
| --- | --- | --- | --- |
| `prune_orphan_conversation_sessions` | `session/conversation.ts` 的 `abandonOrphanConversationTx` | `server/boss/handlers/prune_orphan_conversation_sessions.ts` 的 `buildPruneOrphanConversationSessionsHandler` / `runPruneOrphanConversationSessions` | `createSessionOrphanBackend` → `fenceAwareJobHandler` → 同 backend 内 handler → `runSessionOrphanTick` → conversation 事务写者 |
| `prune_orphan_placement_sessions` | `session/placement.ts` 的 `abandonOrphanPlacementTx` | `server/boss/handlers/prune_orphan_placement_sessions.ts` 的 `buildPruneOrphanPlacementSessionsHandler` / `runPruneOrphanPlacementSessions` | `createSessionOrphanBackend` → `fenceAwareJobHandler` → 同 backend 内 handler → `runSessionOrphanTick` → placement 事务写者 |

源码均位于 `src/`。声明仍由 `capabilities/observability/manifest.ts` 提供，
`server/durable/prune-worker.ts` 的 shared host 仍组合两族 backend。
DBOS 入口仍为 `registerSessionOrphanWorkflows` → `DBOS.runStep` →
`runSessionOrphanTick`，后者继续持有 admission、冻结 candidates、锁内写入和 receipt。

`src/`、`server/`、`scripts/`、`tests/` 的已知路径及四个旧符号检索确认：没有现役
consumer 留在被删模块。两份 migration DB 测试仍引用 `original.runPrune…`，但其
`migration-fixture.ts` 的 `verifiedArtifact` 从固定历史 revision 取出、校验并运行
旧 bundle。这是历史迁移验收输入；这两份测试、fixture 和历史 hash 均未改动。

## 保留的运行语义

- pg-boss job 名检查、错误文本、串行 `await`、`source.kind='pg-boss'` 与实际
  `job.id` 映射相同；没有 catch 或吞掉拒绝。
- `boss.work` 的 `fenceAwareJobHandler(db, family, handler)`、轮询 2 秒、
  batch size 1 不变；tick 内 epoch 检查和事务业务 fence 不变。
- `reconcile` / `stop`、两族独立 phase、调度表达式、暂停/恢复、回退边界、
  recovery obligation 和数据写入者不变。默认 pg-boss phase 保留。
- 本次完成两份转发源码入口退役；YUK-1359 的整体 pg-boss/runtime 退出仍未完成。

## 真实入口证据

复用未改动的 `tests/dbos-session-orphan/cron.db.test.ts`，**1 文件、2 case 全部通过**。
每族从真实 Timekeeper / worker 入口覆盖混合 phase、双 scheduler、重启及独立回退。
执行使用新建的临时 PostgreSQL 容器与合成 `test_fork` 数据，不连接已有数据库。

| 族 | DBOS 首次 / 重启后 scheduled tick（UTC） | 回退时 Timekeeper 实际 job ID | 对应 pg-boss receipt |
| --- | --- | --- | --- |
| conversation | `11:14:42` / `11:14:46` | `fa4f973a-2eca-4c15-b3cf-a111b1c848fb` | `legacy:fa4f973a-2eca-4c15-b3cf-a111b1c848fb` |
| placement | `11:15:06` / `11:15:14` | `c2ed9f0e-1f5d-44bd-b254-2d88364cac82` | `legacy:c2ed9f0e-1f5d-44bd-b254-2d88364cac82` |

日期均为 2026-10-12。这六个 receipt 均为 `admitted`，每个对应合成 session 的
`outcome={kind:'abandoned',fromVersion:0,toVersion:1}`；回退 receipt 的 backend
为 `pg-boss`、provenance 为 `legacy-first-admission`。两个场景的收尾快照均
`gaps=[]` 且所有 workflow 为 `SUCCESS`。placement 快照包含前一场景历史，不能把
两次快照计数相加。回退时间边界由既有 fixture 控制。

完整观测、child logs 与 receipt 存于
[cron-evidence.json.gz](evidence/yuk1359-session-orphan-adapters/cron-evidence.json.gz)；
只脱敏 child log 中的临时测试数据库 URI，业务观测和 ID 原样保留。
[checks.json](evidence/yuk1359-session-orphan-adapters/checks.json) 包含原始/封存 hash、
关键 receipt、相对原始 evidence 的 observation index，以及未修改 owner/fence/fixture
文件与 base 字节相等的 SHA-256 清单。

## 验证与交付边界

- `pnpm typecheck`、`pnpm lint`、`pnpm build` 全部通过；lint 为现有 172 warnings。
- 两项既有架构检查通过；dependency totals 仍为 `428/0/48`，没有改 baseline。
- 未新增/改动测试；本地没有运行完整 test gate。各检查日志与 hash 同目录封存。
- 独立审查 `/root/review_session_adapters`：**NONE**；范围为三个产品文件，
  产品 diff SHA-256：`f69b9eac1cc3fa5c023f0bf65737e2b01ffd0326fb96d4239414809018d500d6`。
  本文及封存证据在审查后添加，不声称它们经过独立审查。
- 临时测试容器和四个 fixture child 进程退出、运行锁释放；原有数据库容器保持健康。
- 仅提交 draft PR，精确 commit 的 CI 结果写入 PR；不 merge/deploy，不改外部 tracker、
  共享 `PLAN.md` / `.remember/now.md` 或 PR #1703 的 docx-agent 路径。
- 本块未发现新增 actionable follow-up；整体 runtime owner 迁移仍由已有 YUK-1359
  清单跟踪，协调者负责共享看板与 tracker 状态。
