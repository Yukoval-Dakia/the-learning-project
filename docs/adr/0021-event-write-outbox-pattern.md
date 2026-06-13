# ADR-0021: Transactional outbox for event → memory ingest

**Status:** Accepted
**Date:** 2026-05-27 (accepted 2026-05-27 via PR for YUK-101)
**Supersedes:** —
**Superseded by:** —
**Related:** ADR-0005（IngestionSession single-owner — reaffirmed）/ ADR-0006 v2（events 不可变 action log）/ ADR-0017（Memory dual-layer — write triggers）

## Context

PR #163（[YUK-99](https://linear.app/yukoval-studios/issue/YUK-99)，Wave 1 post-ship audit-drift W-01 fix）wired `writeEvent` 把 `enqueueEventMemoryIngest` 当 fire-and-forget 调一次：

```ts
export async function writeEvent(db: DbLike, input: WriteEventInput): Promise<string> {
  parseEvent(input);
  await db.insert(event).values(...).onConflictDoNothing();
  void memoryIngestEnqueuer(input.id).catch((err) => { console.error(...); });
  return input.id;
}
```

PR #165（[YUK-101 iter2](https://linear.app/yukoval-studios/issue/YUK-101)）随后在两周内补了 7 个 band-aid（F3 fire-and-forget / F4 singletonKey / F6 dynamic-import 模块路径锁 / F7 cold-start pre-createQueue / F9 layered console prefix / F11 try-catch collapse / F15 `SKIP_BOSS_INGEST` escape hatch）让它在 admin-script + vitest 环境也能跑。这些 fix 都对，但都没动结构性问题：

1. **ADR-0005 单 owner 失守**：`writeEvent` 原契约只 INSERT。新写法让它额外背了 pg-boss send 副作用——其他模块从 ADR-0005 的「不要 `db.insert(event)`」直接推不到「不要在 INSERT 后顺手 enqueue 跨 tx 的 job」。
2. **跨 tx 的 enqueue 是 orphan job 源头**：`writeEvent` 通常被包在 `db.transaction(async (tx) => ...)` 里（`app/api/review/submit/route.ts`、`src/server/proposals/actions.ts`、`app/api/mistakes/route.ts`、`app/api/ingestion/[id]/import/route.ts`、`src/server/artifacts/sections.ts`、`src/server/boss/handlers/variant_verify.ts`、`src/server/boss/handlers/note_verify.ts` 都是）。`enqueueEventMemoryIngest` 走 pg-boss 自己的连接池，不绑 caller tx——caller tx rollback（FSRS torn state / 23505 unique violation / FK violation / bulk-import 中途失败）后，`event` 行没了但 `pgboss.job` 留 orphan。worker `if (!row) continue;` 静默吞，Mem0 fact 层永久 miss 那个 event。
3. **缺 event-level recovery 路径**：PR #163 多处声称「daily brief sweep 是 belt-and-braces」——结构上不成立。`buildMemoryBriefSweepHandler` 扫的是 `memory_brief_note` 行（per scope），不是 `event` 行。没人扫 event 找 missed ingest。

ADR-0017 §"Write triggers" #1 设计意图：「a pg-boss subscriber on event creation calls `mem0.add(event)`」。iter2 路径满足了「on event creation」的字面意思，但没满足「subscriber」——subscriber 暗示了一个解耦的、可恢复的 dispatch 层。

## Decision

实装**transactional outbox**：`event` 表自己带 outbox 游标，`writeEvent` 只 INSERT（ADR-0005 单 owner 恢复），独立 poller 翻新 row、enqueue、stamp 游标——全在同一个 tx 里。

### Schema

`event` 表新增列 + partial index（drizzle/0017_outbox_event_ingest.sql + schema.ts L515）：

```sql
ALTER TABLE event ADD COLUMN ingest_at timestamp with time zone;
CREATE INDEX event_ingest_pending_idx ON event (created_at) WHERE ingest_at IS NULL;
```

- `ingest_at IS NULL` = pending（未 dispatch 到 Mem0 ingest queue）
- `ingest_at IS NOT NULL` = 已 enqueue 且 stamp 完成
- partial index 让 pending scan 保持 O(pending rows) 而非 O(total events)

### writeEvent

回归 ADR-0005 契约（`src/server/events/queries.ts`）：

```ts
export async function writeEvent(db: DbLike, input: WriteEventInput): Promise<string> {
  parseEvent({...});
  await db.insert(event).values({...}).onConflictDoNothing({ target: event.id });
  return input.id;
}
```

- 不 import `@/server/boss/client` 也不 import `@/server/memory/triggers`
- `ingest_at` 默认 NULL（pending）
- 没有 inline enqueue → 没有 fire-and-forget / cold-start race / VITEST 短路 / SKIP_BOSS_INGEST

### Outbox poll handler

`src/server/memory/triggers.ts`：

```ts
export function buildMemoryIngestOutboxPollHandler(db, boss) {
  return async () => {
    await db.transaction(async (tx) => {
      const pending = await tx
        .select({ id: event.id })
        .from(event)
        .where(isNull(event.ingest_at))
        .orderBy(event.created_at)
        .limit(OUTBOX_POLL_BATCH)        // 50
        .for('update', { skipLocked: true });
      if (pending.length === 0) return;
      for (const row of pending) await enqueueEventMemoryIngest(boss, row.id);
      await tx.update(event)
        .set({ ingest_at: new Date() })
        .where(inArray(event.id, pending.map((r) => r.id)));
    });
  };
}
```

- `SELECT ... FOR UPDATE SKIP LOCKED` 让多 worker 并发安全（每个 row 至多被一个 worker 抢到）
- 一个 batch（SELECT + N × enqueue + UPDATE）在同一个 tx 里——worker 进程在中途崩溃，tx 回滚，`ingest_at` 不被 stamp，下一次 poll 重新抢同样的 row
- 通过 pg-boss `schedule(QUEUE, '* * * * *', ...)` 每分钟跑（pg-boss cron 最小粒度）

### Recovery sweep handler

每小时跑一次的 unbounded drain（`buildMemoryIngestOutboxRecoverHandler`），在一个循环里反复调用 poll batch 直到 `countPendingIngest()` 不再下降。Forward-progress guard 防死循环。**用途**：worker outage 中 backlog 远大于 batch limit 时一次性回灌。每分钟 poller 处理稳态；recovery sweep 是兜底。

### What goes away

PR #165 的 7 个 iter2 band-aid 全部移除：

| iter2 fix | 移除原因 |
|---|---|
| F3 fire-and-forget | writeEvent 不再 enqueue |
| F4 singletonKey | outbox 通过 `ingest_at IS NULL` partition 天然 dedup |
| F6 dynamic-import 模块路径锁 | writeEvent 不 import boss/triggers，无需 pin |
| F7 cold-start pre-createQueue | boss handler 启动期一次性 registerMemoryHandlers |
| F9 `[memory-ingest]` console 前缀 | 单 producer = 单层 log |
| F11 inner try/catch | enqueue 失败让 tx 自然回滚 |
| F15 `SKIP_BOSS_INGEST` env | admin script 跑 writeEvent 正常；outbox poller 不跑就不 enqueue |

`_setMemoryIngestEnqueuerForTests` test injector 同样删（writeEvent 不再调任何 enqueuer）。

## Consequences

### 直接收益

- **ADR-0005 单 owner 契约恢复**：`writeEvent` 文档级承诺再次准确，未来 audit 可机器验证「writeEvent 不 import `@/server/boss/`」。
- **Caller tx rollback → 0 orphan job**：tests cover 该场景（`triggers.outbox.test.ts > tx rollback`）。Mem0 fact 层不再在 rollback 场景永久 miss event。
- **Event-level recovery 真存在**：每小时 sweep 扫 `event WHERE ingest_at IS NULL`，与 brief sweep 互补（后者扫 `memory_brief_note`）。
- **Worker 并发安全**：`FOR UPDATE SKIP LOCKED` 让多 worker 不抢同 row。
- **Test partition**：`triggers.outbox.test.ts` 跑真实 Postgres（testcontainer + drizzle migrate），不靠 mock，对照 wave1-postship-drift.md W-05 教训（mock 测试 + 漏 caller wiring = production dead code）。

### 代价 / 延迟

- **Per-event ingest 延迟从 ~ms 变成 ≤ 1 min**（每分钟 poller）。当前用例（brief regen，30 min 半衰期；Mem0 fact 层用作 attention prior 而非 SoT）这个 1 min 延迟可忽略。
- **每分钟 1 个 SQL 查询**：`SELECT FOR UPDATE SKIP LOCKED LIMIT 50` on `event` with partial index——成本几乎为零。
- **新 column + index**：`event.ingest_at` + 1 个 partial index。column 走 ADR-0005 单 owner（writeEvent 不显式写，poller 是唯一 UPDATE 来源，per Phase D）。

### 触发后续工作

- **`event.affected_scopes` 也走类似 outbox**：当前 `affected_scopes` 在 INSERT 时算好，brief regen subscriber 读它再 enqueue brief regen。这条链是 Mem0 worker 内部（不跨 tx），目前不需要 outbox。如果未来发现 brief regen 也需要 caller tx 解耦，可以加 `brief_regen_at` 列、走相同 pattern。
- **观察期跑稳后 promote `experimental:tool_use`**：本 ADR 不动 `experimental:*` lifecycle。

### Why not alternatives

- **Logical replication / Debezium**：单用户、单节点 NAS 部署，pg → kafka pipeline 工程量爆表。
- **Plain trigger function**：DB trigger 调 pg-boss 也要跨连接池，回到原问题；而且 trigger 难测试。
- **同 tx 内 INSERT + INSERT INTO pgboss.job**：可行但耦合 pg-boss schema，且 `boss.send()` 还做 backoff / retry / cron 逻辑，自己手写 INSERT 比 outbox 复杂。
- **Higher-level wrapper around writeEvent**：「把 enqueue 放到 wrapper」只搬位置，跨 tx 问题原样存在。

## Touches ADR-0005

ADR-0005 §"single-owner invariant" continues to hold. `writeEvent` 是 `event` 表的 single INSERT path；本 ADR 进一步收紧：**writeEvent 也是单纯 INSERT，不带副作用**。`ingest_at` 列由 outbox poller 单独 UPDATE，跟 caller 完全解耦。

## Touches ADR-0017

ADR-0017 §"Write triggers (three paths)" #1 实装路径更新：

- 旧：「a pg-boss subscriber on event creation calls `mem0.add(event)`」（PR #163 实装为 writeEvent inline enqueue）
- 新：「writeEvent INSERT 行→ ingest_at = NULL（pending）→ outbox poll handler 每分钟 SELECT...FOR UPDATE SKIP LOCKED → enqueueEventMemoryIngest + UPDATE ingest_at（同 tx）→ worker 跑 `mem0.add()`」

ADR-0017 §"Anti-storm" 6min 单例 lock 仍然 holds（针对 brief regen，不针对 event ingest）。

## Acceptance（PR-level）

- `grep -rn "SKIP_BOSS_INGEST\|defaultMemoryIngestEnqueuer\|_setMemoryIngestEnqueuerForTests\|INGEST_SINGLETON_SECONDS\|memoryIngestEnqueuer\b" src/ scripts/` → 0 命中
- `grep -rn "@/server/boss/client\|@/server/memory/triggers" src/server/events/queries.ts` → 0 命中
- `triggers.outbox.test.ts` 6 真实 db 场景全过（happy / tx-rollback / idempotency / batch-limit / recovery-drain / recovery-empty）
- `pnpm test` 全过（含 unit / db / migration-smoke）
- `pnpm build` 全过

> **M5 路径注（YUK-321，2026-06-13）**：本文提及的 `app/api/**` Next route 路径已随旧栈拆除迁移至 capability manifests（`src/capabilities/*/manifest.ts` + 各包 `api/*.ts`），由组合根 `server/app.ts` 挂载；决策本身不受影响。
