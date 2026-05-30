# ADR-0023: Cross-process editing presence via Redis

**Status:** Accepted
**Date:** 2026-05-30 (accepted via PR for YUK-148)
**Supersedes:** —
**Superseded by:** —
**Related:** ADR-0007（single-user assumption — reaffirmed）/ ADR-0020（block-tree note rebuild）/ ADR-0022（TipTap PM node schema）

## Context

`src/server/artifacts/editing-session.ts` 维护「用户正在编辑哪个 artifact」的 presence
状态，note-refine 流程用它决定：用户活跃编辑时把 AI patch **defer**（排队），idle 时
才 apply / flush。状态机有四个行为：

1. **heartbeat**：`/api/editing-session/heartbeat` 每隔几秒记 `editing` / `idle`。
   `editingStartedAt` 只在**第一个** editing heartbeat 打戳（后续 heartbeat 不重置
   force-apply 时钟），idle 时清空。
2. **sticky idle-on-timeout**：`isArtifactIdle` 在最后一个 heartbeat 超过
   `EDITING_HEARTBEAT_TIMEOUT_MS`（30s）时把 editing session **就地翻成 idle**（有副作用
   的读）。
3. **force-apply ceiling**：editing 持续超过 `EDITING_FORCE_APPLY_TIMEOUT_MS`（10min）
   后，即便仍在编辑也强制 apply，避免 patch 无限 defer。
4. **defer / flush**：editing 期间 enqueue，`markArtifactIdleAndFlush` 按 FIFO drain。

问题：状态存在**进程内的** `const sessions = new Map(...)`。Next web server 和 pg-boss
worker（`scripts/worker.ts`）是**两个独立进程**。用户在网页里编辑时，web 进程记
heartbeat；但 worker 的 note-refine handler 调 `isArtifactIdle()` 查的是**它自己那个
空 Map**，永远看到「idle」，于是在用户编辑到一半时 apply 了 AI patch——clobber 掉
live edit。这正是 YUK-148。

presence 必须跨进程共享。

## Decision

用 **Redis** 做共享 presence 后端。web + worker 指向同一个 Redis（NAS docker-compose
里新增 `redis:7-alpine` 服务，注入 `REDIS_URL=redis://redis:6379` 到 app + worker）。

### PresenceStore 抽象

抽出 `PresenceStore` 接口（`src/server/artifacts/presence/types.ts`），把原状态机的
全部行为编码成方法：`recordEditingHeartbeat` / `isArtifactIdle`（sticky）/
`enqueueOrApplyNoteRefinePatch`（force-apply ceiling + defer-vs-apply）/
`markArtifactIdleAndFlush`（FIFO drain）/ `getEditingSessionSnapshot` / `reset`（test）。
两个具体实现满足同一接口——这正是「第二个具体实例出现才引入抽象」的门槛（不是预设抽象）。

### In-memory vs Redis split + selection

- **In-memory impl**（`presence/in-memory.ts`）= 原 Map 行为**逐字保留**。它是 dev +
  fast unit suite 的**默认**（无需 Redis，`editing-session.test.ts` 仍是快速 no-DB unit）。
  它**不是**跨进程的——这就是被修的 bug 本身。
- **Redis impl**（`presence/redis.ts`）= `ioredis`（成熟 OSS，不手写 Redis client），
  `REDIS_URL` 设置时选中。
- **factory**（`editing-session.ts`）按 `REDIS_URL` 是否存在挑实现，lazy singleton，
  整个进程复用一个 store + 一个 ioredis 连接（`src/server/redis/client.ts`，模式对齐
  `src/db/client.ts` / `src/server/boss/client.ts` 的单例）。

`editing-session.ts` 退化成**薄 façade**：保留原导出名（函数 + `EDITING_*` 常量），
内部委托给 active store。consumers 几乎不用改（只是函数现在 async，加 `await`）。

### Async 签名

`recordEditingHeartbeat` / `isArtifactIdle` / `getEditingSessionSnapshot` 因 Redis I/O
变 `async`（`enqueueOrApplyNoteRefinePatch` / `markArtifactIdleAndFlush` 本就 async）。
ripple `await` 到全部 consumer：

- `app/api/editing-session/heartbeat/route.ts`（`recordEditingHeartbeat` 原来没 await，
  补上）
- `app/api/editing-session/blur/route.ts`（已 await）
- `src/server/boss/handlers/note-refine.ts`（已 await）
- `src/server/boss/handlers/note-refine.test.ts`（test：补 `await`）

UI `src/ui/block-tree/ArtifactBlockTree.tsx` 走的是 fetch 到 route，不直接调这些函数，
无需改（grep 确认无直接 import）。

### Ephemeral state — 不做持久化

presence 是**短暂的尽力而为状态**：重启丢了 presence 安全地读成 idle（最坏结果是一个
本该 defer 的 patch 提前 apply，跟 timeout 自然 idle 等价）。所以 Redis 服务**不配**
AOF / RDB / volume。每个 artifact 的 key 带 **TTL = heartbeat timeout**，stale presence
自动过期（缺失 / 过期的 key 读成 idle——安全默认）；deferred 队列在每次 SET 时刷新
TTL，不会编辑中途静默过期。

「lost presence safely reads as idle」**同样适用于 Redis 连接失败**（连不上 / 超时 /
命令报错），不只是 key 缺失 / 过期（YUK-171）。`RedisPresenceStore` 的每个方法把 ioredis
调用包在 try-catch 里，失败时 `console.warn` 一次并返回 ADR-0023 fail-safe，绝不让错误冒泡
到 heartbeat / blur route（→ 500）或 worker（→ throw）。per-method 降级：

- `isArtifactIdle` → 返回 `true`（idle），用户编辑永不被 Redis 故障阻塞。
- `recordEditingHeartbeat` → no-op（resolve）；丢的 heartbeat 等价于缺失 key，session 自然 age-out。
- `getEditingSessionSnapshot` → 返回 `null`（诊断读，不破坏调用方）。
- `enqueueOrApplyNoteRefinePatch` → DECIDE 失败时降级到 **APPLY** 并照常执行
  `persistNoteRefineApply`——DB 写必然发生，AI patch 绝不静默丢失（最坏结果 = 在活跃编辑期
  提前 apply，跟 timeout-idle + force-apply ceiling 等价）。
- `markArtifactIdleAndFlush` → drain 失败时 warn 并返回 `{ flushed: 0, results: [] }`；
  没有 Lua 给的权威 drained 列表就不臆测要 apply 哪些 item，pending 留在 Redis（或随 TTL 过期），
  下次 trigger 重新 apply。

降级只发生在 `presence/redis.ts` 层；consumer（heartbeat / blur route、note-refine handler）
无需 redundant try-catch——façade 已返回 fail-safe 值，不会 throw。in-memory impl 无需改
（进程内 Map 不会连接失败）。

### Atomicity

web heartbeat、worker idle-check（**超时会写**）、flush 会跨进程交错，必须避免
read-modify-write 丢更新。

每个 artifact 的整份状态存在**一个** Redis string key（`editing:<artifactId>`），
JSON：`{ status, lastHeartbeatAtMs, editingStartedAtMs, pending[] }`（日期存 ms epoch
方便 Lua 算术）。每个复合操作做成**单个 Lua 脚本**（`defineCommand`，ioredis 自动
`EVALSHA` 缓存）：

- `presenceHeartbeat`：load → set status / lastHeartbeat / editingStartedAt（首戳语义）→ SET PX ttl。
- `presenceIdleCheck`：缺 key → 直接 idle（不建状态）；否则 load → sticky idle 判定（超时
  就地翻 idle 并清 editingStartedAt）→ 回写（让跨进程可见 sticky 转换）→ 返回 idle/not。
- `presenceDecide`（enqueueOrApply 的决策）：load → isArtifactIdle（sticky）→ shouldForceApply
  → 不 idle 且未到 force ceiling 就 `table.insert` pending 返回 `deferred`；否则回写后返回
  `apply`。复刻 in-memory 的调用顺序（currentState → isArtifactIdle → shouldForceApply → enqueue）。
- `presenceFlush`：load → 取出 pending → 置 idle / 清队列 → 回写 → 返回 drained 数组。

Redis 单线程执行 ⇒ 每个脚本内的「读-改-写」整体原子，**不需要** WATCH/MULTI 重试循环。

**关键约束**：DB 副作用（`persistNoteRefineApply`）不能在 Lua 里跑（Lua 碰不到
Postgres）。所以 Lua 只**原子地做决策 / drain**，真正的 DB 写在脚本返回后于 JS 侧执行。
对 `enqueueOrApply`：要么 Lua 决定 `deferred`（已入队，无 DB 写），要么 `apply`（无队列
变更，JS 侧再 `persistNoteRefineApply`）。对 flush：Lua 原子地读出+清空 pending 并置
idle，JS 侧按序 apply drained 出来的每条。这一拆分是「决策跨进程原子、IO 在外」的标准
做法，跟 ADR-0021 outbox「决策在 tx 内、enqueue 副作用解耦」同源思路。

### Test 策略

- `src/server/artifacts/editing-session.test.ts`（原 11+ case 状态机 test，在
  `fastTestInclude`）：适配 async API（加 `await`），**继续用 in-memory impl**（无
  `REDIS_URL`），保持 fast no-DB unit，全部 case 语义不变。`resetEditingSessionStateForTests`
  reset 当前 active impl。
- `src/server/artifacts/presence/redis.integration.test.ts`：真正的 YUK-148 回归。起一个
  自包含的 Redis testcontainer（`@testcontainers/redis`），构造**两个独立的**
  `RedisPresenceStore`（同一个 url，模拟 web + worker），instance A 记 editing heartbeat，
  断言 instance B 看到 `isArtifactIdle === false`（presence 共享）+ deferred patch 经 A 入队
  能被 B flush；再加一个对照 case：两个 in-memory store **不**共享（复现 pre-fix bug）。
  含 testcontainer ⇒ 不是 fast unit，落在 db 分区（`@testcontainers/redis` 已加入
  `scripts/audit-test-partition.ts` 的 DB_NPM 集，`pnpm audit:partition` 干净）。

## Consequences

### 直接收益

- **跨进程 presence**：worker 不再在用户编辑中途 apply patch——YUK-148 修复，
  `redis.integration.test.ts` 用两个独立 store 实证。
- **原子复合操作**：Lua 脚本消除 read-modify-write 竞态，无需手写 WATCH/MULTI 重试。
- **自愈的 stale presence**：TTL = heartbeat timeout，崩溃 / 漏发 idle 的 session 自动
  过期成 idle。
- **dev / test 零依赖**：无 `REDIS_URL` 时 in-memory fallback，fast unit suite 不需要 Redis。

### 代价 / 延迟

- **每次 presence 操作多一次 Redis round-trip**：单用户 NAS 部署、局域网内 Redis，
  亚毫秒级，可忽略。
- **多一个容器**：`redis:7-alpine`，无 volume / 无持久化，资源占用极小。
- **状态序列化**：整份 state 一个 key 一次读写——artifact 数量级（单用户）下队列不会大到
  让单 key 序列化成为问题。

### 触发后续工作

- 暂无。若未来 presence 需要承载更大 / 更频繁的状态（多设备并发编辑等），可重新评估
  per-field hash + 更细粒度脚本；当前单 key + JSON 足够。

## Touches ADR-0007

单用户假设继续成立。本 ADR 不引入多租户：presence key 不带 user 维度，因为只有一个用户。
Redis 只是把**同一个用户**的 presence 在 web/worker 两进程间共享，不是多用户隔离。
