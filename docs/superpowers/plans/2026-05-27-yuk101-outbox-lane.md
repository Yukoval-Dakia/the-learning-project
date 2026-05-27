# YUK-101 — Transactional outbox for writeEvent → memory event ingest

> Lane plan anchor. 现场写 (per memory `feedback_lane_plan_pattern.md`)，主仓 fresh main 起 `lane/yuk-101-outbox`。
> Driver source：Linear YUK-101 issue body 完整设计已 frozen。
> 估时：8 pt（schema 1 + writeEvent refactor 1 + new handler 2 + drop band-aids 1 + tests 2 + ADR-0021 1）

**Lane branch**：`lane/yuk-101-outbox`
**Base**：`main @ d4d68864` (fresh)
**PR target**：`main`

---

## §1 Goal

恢复 ADR-0005 single-owner INSERT contract：`writeEvent` 只 INSERT，不再 inline enqueue。
通过 transactional outbox（`event.ingest_at NULL` ↔ poller）让 Mem0 fact ingest 跟 caller tx 解耦但仍可靠 — caller tx rollback 后 0 orphan job + 0 missing ingest。

把 PR #165 的 7 个 iter2 band-aids（F3 fire-and-forget / F4 singletonKey / F6 module pin / F7 cold-start retry / F9 layer log / F11 try-catch / F15 SKIP_BOSS_INGEST）全部移除 — 这些都是症状的胶布，outbox 是根因 fix。

---

## §2 Phases

### Phase A — Schema migration (1 pt)

**Files create**：
- `drizzle/0017_outbox_event_ingest.sql` — DDL:
  ```sql
  ALTER TABLE event ADD COLUMN ingest_at TIMESTAMP NULL;
  CREATE INDEX event_ingest_pending_idx ON event (created_at) WHERE ingest_at IS NULL;
  ```

**Files edit**：
- `src/db/schema.ts:480+` — `event` pgTable add `ingest_at: timestamp('ingest_at')` nullable column + index 声明

**Acceptance**：
- `pnpm db:generate` 不产生新文件（migration 手写）
- `pnpm test:migration` 全过
- 新 column nullable default null
- pending index 走 partial index（仅 `ingest_at IS NULL` 行）

**Boundary**：
- ❌ 不动 event 表其他列
- ❌ 不动 `event.affected_scopes` / `event.payload` / FK

### Phase B — writeEvent refactor (1 pt)

**Files edit**：`src/server/events/queries.ts`

- DROP 整段 L942-994：`MemoryIngestEnqueuer` 类型 + `defaultMemoryIngestEnqueuer` + `memoryIngestEnqueuer` module-level var + `_setMemoryIngestEnqueuerForTests`
- DROP `writeEvent` body L1064-1094 整段 inline enqueue（YUK-99 wire + iter2 F3/F11 fire-and-forget）
- DROP `void sql;` L1103（不再用）
- Keep：`parseEvent` validation + INSERT + onConflictDoNothing + return id
- `ingest_at` 列**不显式 set** — 默认 NULL（pending state）

**Acceptance**：
- `writeEvent` 仅做 parseEvent + INSERT；body < 60 行
- 没有 `import` `@/server/boss/client` / `@/server/memory/triggers` 在 queries.ts
- ADR-0005 single-owner INSERT contract restored

**Boundary**：
- ❌ 不动 parseEvent
- ❌ 不动 idempotency (onConflictDoNothing)
- ❌ caller signature 不变（输入 / 输出 schema 不动）

### Phase C — Outbox poll handler (2 pt)

**Files edit**：`src/server/memory/triggers.ts`

新增 (next to `enqueueEventMemoryIngest`)：

```ts
export const MEMORY_INGEST_OUTBOX_POLL_QUEUE = 'memory_ingest_outbox_poll';
const OUTBOX_POLL_BATCH = 50;
const OUTBOX_POLL_SCHEDULE = '*/5 * * * * *'; // every 5s (pg-boss extended cron — verify)
const OUTBOX_RECOVERY_SCHEDULE = '0 * * * *'; // hourly recovery sweep, unbounded

// Poll handler: SELECT pending events FOR UPDATE SKIP LOCKED, enqueue each into
// MEMORY_EVENT_INGEST_QUEUE, then UPDATE event.ingest_at = now().
// Wrapped in db.transaction so SELECT...FOR UPDATE + UPDATE share lock.
export function buildMemoryIngestOutboxPollHandler(db: Db, opts?: { limit?: number }) {
  return async (_job: Job<{}>) => {
    const limit = opts?.limit ?? OUTBOX_POLL_BATCH;
    await db.transaction(async (tx) => {
      const pending = await tx.execute(sql`
        SELECT id FROM event
        WHERE ingest_at IS NULL
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      if (pending.rowCount === 0) return;
      const boss = await getStartedBoss();
      for (const row of pending.rows) {
        await enqueueEventMemoryIngest(boss, row.id);
      }
      const ids = pending.rows.map((r) => r.id);
      await tx
        .update(event)
        .set({ ingest_at: new Date() })
        .where(inArray(event.id, ids));
    });
  };
}

// Recovery sweep: same query unbounded, runs hourly. Catches anything the
// rapid poller missed (e.g., poller worker offline).
export function buildMemoryIngestOutboxRecoverHandler(db: Db) {
  return async (_job: Job<{}>) => {
    // No LIMIT — drain everything still pending.
    ...
  };
}
```

**Files edit**：`src/server/boss/handlers.ts`

`registerMemoryHandlers` 内补：
```ts
await boss.createQueue(MEMORY_INGEST_OUTBOX_POLL_QUEUE);
await boss.work(MEMORY_INGEST_OUTBOX_POLL_QUEUE, buildMemoryIngestOutboxPollHandler(db));
await boss.schedule(MEMORY_INGEST_OUTBOX_POLL_QUEUE, OUTBOX_POLL_SCHEDULE, {}, { tz: 'UTC' });
// + recovery sweep schedule
```

**Acceptance**：
- 5s 内 pending event → ingest_at set → ingest job in `pgboss.job` table for `memory_event_ingest`
- SKIP LOCKED 让多 worker 安全并发
- Recovery sweep 抓得到 missed events

**Boundary**：
- ❌ 不动现有 `memory_event_ingest` handler (`buildMemoryEventIngestHandler`)
- ❌ 不动 brief regen / sweep handler

### Phase D — Drop iter2 band-aids (1 pt)

**Files edit**：
- `src/server/memory/triggers.ts`:
  - DROP `enqueueEventMemoryIngest` 的 `singletonKey` (F4) + 注释 — outbox 通过 `ingest_at IS NOT NULL` 天然 dedup
  - `INGEST_SINGLETON_SECONDS` 删除
- `src/server/events/queries.ts`:
  - F15 `SKIP_BOSS_INGEST` 已随 Phase B 一起删
  - F7 cold-start `createQueue` 仍合理但留在 `enqueueEventMemoryIngest` 的 caller path 而不是 writeEvent — 实际 outbox poll handler 调 enqueueEventMemoryIngest 前 boss 已 fully started，不需 pre-create
- `tests/global-setup.ts` 或 vitest helpers：F6 dynamic-import VITEST short-circuit 删（如有）

**Acceptance**：
- grep `SKIP_BOSS_INGEST` / `_setMemoryIngestEnqueuerForTests` / `defaultMemoryIngestEnqueuer` / `singletonKey` / `INGEST_SINGLETON_SECONDS` / `memoryIngestEnqueuer` 在 `src/` 0 命中
- iter2 注释也清掉（commits 已记 history）

### Phase E — Tests (2 pt)

**Files create / edit**：

1. `src/server/events/queries.test.ts`（或 outbox.test.ts 新文件）：
   - **真实路径测试**：`await writeEvent(db, input)` → 立即查 `SELECT ingest_at FROM event WHERE id=...` 应 NULL；poller 跑一次后 NOT NULL + `pgboss.job` 表有 1 行 `name=memory_event_ingest`
   - **Tx rollback 测试**：`db.transaction(async (tx) => { await writeEvent(tx, input); throw new Error('rollback'); })` → 0 `event` 行 + 0 ingest job（per ADR-0005 contract）
   - **Idempotency 测试**：相同 id writeEvent 两次 → 1 行 event；poller 一次后 1 个 ingest job（不重）
   - **Concurrent poller**：spawn 2 个 poll handler 并行 → 全 pending events 总共 ingest 1 次 / event（SKIP LOCKED 验证）
   - **Recovery sweep**：模拟 poller offline 30 min → 推 100 个 pending events → 跑 recovery → 全 ingested

2. **W-05 lesson enforce**：Phase E 必须含真实 e2e integration test 验 writeEvent → poller → mem0.add() 全链路一次（mock `MemoryClient.add` 但不 mock pg-boss / db）

**Acceptance**：
- `pnpm test:db src/server/events/queries.test.ts` 5+ 新 case 全过
- `pnpm test` 全过（含原 unit / DB / migration）

### Phase F — ADR-0021 outbox semantics (1 pt)

**Files create**：`docs/adr/0021-event-write-outbox-pattern.md`

Content outline:
- **Context**: ADR-0005 single-owner INSERT；ADR-0017 §"Write triggers" #1；PR #163 (YUK-99) wire；PR #165 (YUK-101 iter2) band-aids 暴露 root cause
- **Decision**: transactional outbox via `event.ingest_at` column；writeEvent INSERT-only；separate poller owns enqueue + ingest_at update；recovery sweep
- **Consequences**:
  - ADR-0005 INSERT contract restored
  - Caller tx rollback 不产生 orphan job
  - Mem0 fact 层在 rollback 场景 0 ingest miss
  - Poller worker offline 可恢复（recovery sweep）
- **Touches ADR-0005**: 显式 cross-ref，ADR-0005 §"single-owner invariant" 仍 holds（writeEvent 不调 enqueue）
- **Touches ADR-0017**: §"Write triggers" #1 实装路径更新 — "pg-boss subscriber on event creation" 改 "outbox poller picks up new event row"

**Files edit**：
- `docs/planning/v0.4-complete-form-roadmap.md` §2 ADR 表加 ADR-0021 行
- `docs/adr/0005-ingestion-session-single-owner.md` 末尾加 evolution note ref ADR-0021
- `docs/adr/0017-memory-mem0-plus-brief-layer.md` §"Write triggers" #1 实装注释 ref ADR-0021

---

## §3 Wave 1 lesson enforcement

per `docs/audit/2026-05-27-wave1-postship-drift.md` W-05 — lane subagent 单元测过但生产 caller 漏 wire。本 lane Phase E **必须**含 real-path integration test（pg-boss + db 都真，仅 Mem0 client 可 mock）。

Acceptance gate（lane subagent self-verify before reporting done）：
1. `pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test && pnpm build` 全绿
2. `grep -r "SKIP_BOSS_INGEST\|defaultMemoryIngestEnqueuer\|_setMemoryIngestEnqueuerForTests\|singletonKey.*ingest\|INGEST_SINGLETON_SECONDS\|memoryIngestEnqueuer" src/ scripts/` → 0 命中
3. `grep -rn "import.*@/server/boss/client" src/server/events/` → 0 命中（writeEvent 不依赖 boss）
4. `grep -rn "import.*@/server/memory/triggers" src/server/events/` → 0 命中（writeEvent 不依赖 triggers）
5. Real-path integration test in queries.test.ts 含 4 个 scenario（happy / tx-rollback / idempotency / recovery）

---

## §4 Commit / PR

**Commits**（按 Phase 分）：
1. `feat(events): add event.ingest_at column for transactional outbox (YUK-101 phase A)`
2. `refactor(events): drop inline ingest enqueue from writeEvent (YUK-101 phase B)`
3. `feat(memory): outbox poll handler + recovery sweep (YUK-101 phase C)`
4. `refactor(memory): drop iter2 ingest band-aids (YUK-101 phase D)`
5. `test(events): outbox tx-rollback + idempotency + recovery (YUK-101 phase E)`
6. `docs(adr): ADR-0021 event write outbox pattern (YUK-101 phase F)`

最后一个 commit 用 `Closes YUK-101`。

**PR title**: `feat(events): transactional outbox for memory ingest (YUK-101)`
**PR body**: §1 goal + §2 phase list 链 ADR-0021 + 验证 evidence

---

## §5 Boundaries (Hard NO)

- ❌ 不动 `event` 表其他字段
- ❌ 不动 `parseEvent` discriminated union
- ❌ 不动 brief regen / sweep handler
- ❌ 不动 Mem0 client / fact 层
- ❌ 不引入新依赖
- ❌ 不改 ADR-0005 invariant —— 它仍然是 single-owner INSERT 的 anchor，本 lane 是 reaffirm 而不是 supersede
- ❌ 不动现有 enqueueEventMemoryIngest signature（worker handler 直接复用）

---

## §6 Open Q (lane subagent 自决；不行就停下问)

- pg-boss `schedule()` 是否支持 5s 间隔（`*/5 * * * * *` 6 字段 cron）— 看 pg-boss 文档；不支持则改 work loop + sleep 5s
- `tx.execute(sql\`...FOR UPDATE SKIP LOCKED\`)` 是否能 typed —— Drizzle SQL helper 应该 OK
- ADR-0021 vs revise ADR-0005 —— 倾向 ADR-0021 new ADR（ADR-0005 unchanged，本 lane 是其 reaffirm + 一个新 layer）

---

**End of lane plan**。Lane subagent should impl all 6 phases, run §3 acceptance gate, then commit + PR.
