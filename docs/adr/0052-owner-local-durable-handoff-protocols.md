# ADR-0052 — Owner-local durable handoff protocols (YUK-861 NO-GO)

**Status:** NO-GO / Rejected（2026-08-10）
**Decision source:** YUK-861 architecture closeout；evaluated YUK-858 merge base `136faec8224c0f0136532c748aea1bbc689ca7b7`
**Related:** YUK-700 · YUK-857 · YUK-858 · YUK-860 · ADR-0021 · ADR-0051

## Context

F2.1 Notes（YUK-857）与 F2.2 Memory（YUK-858）都已经有 durable handoff，Verify 也已有 transactional
outbox。它们都能回答“进程在边界处退出后，义务如何被重新发现”，但耐久性边界、队列 receipt、幂等
单位、外部副作用与 recovery 义务并不相同。把相似名词提升成一个 generic handoff core，会把这些
差异压成可选字段或 callback，反而失去各 owner 的 fail-closed 语义。

当前实现的本地证据如下；这些路径是各自 owner 的事实真相，不是等待抽取的模板：

| owner / 实例 | durable boundary | dispatch receipt 与幂等单位 | recovery / fail-closed 语义 |
| --- | --- | --- | --- |
| **Verify** — `src/server/boss/verify-dispatch-outbox.ts`（YUK-700） | candidate draft 与 `writeVerifyDispatchIntent()` 在同一 DB transaction；`dispatchPendingVerifyIntents()` 以 `FOR UPDATE SKIP LOCKED` 锁 intent，并通过 `fromPgBossDrizzleTx(tx)` 把 queue send 纳入该事务 | queue enqueue 与 per-question/verifier completion 一起提交；失败回滚后 intent 留 pending。terminal skip 也是显式 completion；普通 intent 的稳定身份是 `(question_id, verifier, placement authority)` | `recoverOrphanVerifyDispatches()` 只合成/投递 verify，不重跑 sourcing/generation；`verify_dispatch_recover` 负责 startup/nightly safety net。这里没有跨 transaction 的 provider call boundary |
| **Notes** — `src/capabilities/notes/server/note-handoff.ts`（YUK-857） | generation/verification intent 是 artifact transaction 内的 append-only event；真实 pg-boss send 在 transaction **提交后**发生 | exact returned job ID 或 exact `getJobById()` readback 确认 queue receipt，确认后才写 dispatch-complete event；generation 另有 artifact singleton 兼容窗口，verification claim/result 是独立生命周期 | `hub_sync_recovery` 是共享 Notes recovery floor；`note_verify` 自己还拥有 version/fence claim、raw-result stage/finalize 与 retry/attempt cap。外部 AI 调用不得持有 DB transaction |
| **Memory** — `src/server/memory/memory-reconcile-handoff*.ts`（YUK-858） | DB transaction 只写 `add_started`、`ingest_completed`、intent、dispatch-complete 与 recovery cursor；Mem0 lookup/SDK 与 pg-boss 调用都在 transaction 外 | 上游 provider truth：exact lookup 先于 opaque provider acquire/start，reserve 后、SDK call 前写 `add_started`，合法 resolution 才能完成 ingest。下游 queue truth：一个 source event 的 batch 以 SHA-256 `intent_digest` 绑定 intent set 与 deterministic job ID；exact returned ID 或 readback 确认一个 batch receipt 后，写多条共享 job/digest 的 per-memory completion marker | provider result 必须有 started marker；不完整/冲突 digest fail-closed。recovery 用 append-only `(dispatch_seq,id)` cursor，bigint 以 decimal string 传递，最多 200 scanned / 50 success、至多一次 wrap；`observe|write|recover|drain` 严格模式由既有 hourly outbox recovery floor 承载 |

这不是同一协议的三种命名：Verify 的 durability 是 DB/pg-boss 同事务，Notes 是 commit 后 queue
receipt/readback，Memory 先维护上游 provider truth，再维护下游 batch queue receipt、digest 与有界游标。即使都使用
append-only event，也不能把一个 owner 的 completion 解释成另一个 owner 的业务完成。

## Decision

### 1. YUK-861 不建立 generic durable handoff core

保持 Verify、Notes、Memory 的 handoff protocol **owner-local**。owner 继续拥有自己的：

- durable fact / intent 的 schema 与单一写入点；
- transaction 与外部副作用的边界；
- 上游 external-provider truth 与下游 queue dispatch receipt 的各自强度；
- 幂等身份、批量 digest、terminal 状态与 recovery cursor；
- rollout mode、回滚顺序与 operator 证据。

允许重复少量机械代码，换取每条链的语义可读性与独立 fail-closed。不得因存在三个 handoff 就新增
`src/server/durable-handoff/`、共享表、共享 cron 或跨 owner 的 callback registry。

### 2. 明确拒绝 callback workflow shell

不引入 `onReady` / `afterHandoff` / generic callback chain、workflow DSL 或由中央壳层编排 owner
副作用。callback 只能表达“某个函数被调用”，不能表达本 ADR 所需的 commit boundary、精确 queue
receipt、provider-start fence、batch digest、terminal receipt 与有界 recovery。Notes 已删除旧的
`onReady` / agency best-effort send；Verify 与 Memory 也不应以 callback shell 重新接回去。

route、job、subscription 或 cron 仍可以是 owner-local protocol 的触发器，但不得成为第二个产品
语义 owner，也不得把 callback 成功当作 durable completion。

### 3. 当前交付状态与下一 lane

- YUK-858 已合并 main，merge SHA 为 `136faec8224c0f0136532c748aea1bbc689ca7b7`；exact-head CI
  `31362608190` green。
- 本次 closeout 不部署；YUK-832 继续 HOLD，YUK-842 production 继续 observe，均未改变。
- YUK-861 以本 ADR 的 NO-GO 结案。下一实现 lane 是 **F2.4 / YUK-860 — Unify Agent SDK
  terminal adaptation**：其 Linear scope 已核验为统一 `runner.ts` 的 SDK terminal evidence
  interpretation，且明确独立于 F2.3；它不会重开本 ADR 否决的 durable handoff 抽象。

## Future gates

### Reopen gate — 重新讨论 generic core 前必须全部满足

1. 至少两个 live consumers 的真实协议已经具有相同不变量；它们可以来自新 owner，也可以由当前
   owner 的协议演化收敛。仅有相似命名、抽象讨论、测试 helper 或 callback wrapper 不算。
2. 一份 side-by-side contract matrix 证明至少两个 live consumers 对 **同一** durability boundary、
   receipt strength、idempotency unit、terminal semantics 与 recovery progress 有相同不变量；若
   仍需 owner-specific optional flags 或 callback 分支，则 gate 失败。
3. 先做可删除的 prototype，并提供每个 owner 的 deletion test：transaction rollback、duplicate/concurrent
   dispatch、lost send/readback、malformed receipt、external-call boundary、bounded recovery progress
   与 fail-closed outcome 都必须有真实 scoped test/CI artifacts；不得只以接口能编译作为证据。
4. 明确 migration/rollback/retention 方案，证明 shared implementation 不会吞掉任何既有 owner-local
   event、digest、cursor、claim 或 receipt；owner 与 architecture review 均批准后，才可重新打开
   YUK-861（或创建替代 issue）。

### Deletion gate — 删除任一 owner-local protocol 前必须全部满足

1. 静态 inventory 与 runtime manifest 均证明没有 live producer、consumer、queue registration 或
   recovery reader；不能以“当前没观测到 job”代替证明。
2. 该协议的 pending intent/claim/result、pg-boss job 与 recovery obligation 已 drain 为零，或有
   已验证的逐条迁移映射、回滚点和保留期限；历史 event 的 reader/replay/retention 决策已落盘。
3. 若存在 replacement，必须有其 exact-head scoped tests、boundary audit 与 failure artifact，并确认旧
   action/payload 不会被新 reader 误解释；若协议被证明已死且无 replacement，则必须证明没有遗留
   producer、reader 或 retention 义务。任何 shared core replacement 还要先完成一个 shadow/readback
   observation window，再删旧实现。
4. 以上证据与部署/回滚授权齐全后才可删除代码、manifest、测试和文档；本 ADR 不授权现在删除任何
   protocol。

## Consequences

- 三条链保持静态 modular monolith 内的本地 service seam，不引入网络微服务、动态 plugin 或通用
  workflow framework。
- 维护者必须在 owner-local 文档与测试中说明自身的 commit boundary、receipt 与 recovery，不得用
  “durable handoff” 这一标签跳过具体语义。
- 未来若新 lane 只需要一条 owner-local handoff，应继续复制最小充分实现；只有 Future gates 全部
  满足才重新评估抽象。

## Rejected alternatives

- **Generic durable handoff core**：三条链的 transaction、provider boundary、batch digest、receipt
  与 recovery 维度不相同，抽象会变成 optional-field union，增加误读和 fail-open 风险。
- **Callback workflow shell**：callback 只证明调用发生，不证明事务提交、队列 receipt、provider
  fence、terminal outcome 或 recovery progress；会重新制造 Notes 已删除的 legacy `onReady` 形态。
- **先建共享表/cron 再迁移**：当前没有第二个相同 live consumer，新增 schema/cron 没有经济性，也会
  让 owner-local deletion boundary 变模糊。
