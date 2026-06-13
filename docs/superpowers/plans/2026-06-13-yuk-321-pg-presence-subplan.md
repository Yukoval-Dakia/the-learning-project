# PgPresenceStore 子计划（M5 gate 选项 b 前置子任务，YUK-321）

> 依据：`2026-06-12-yuk-321-m5-plan.md` 用户决断 Gate（L1261-1294）。Gate 已于 2026-06-12 裁决**选项 b——保持双进程 + presence 进 PG 表**。本子计划按 L1290「在 gate 时点现场写（禁预写）」要求于 2026-06-13（Task 8 闭环后）现场写就。**用户已于 2026-06-13 过目通过**（含 §2 两处偏差确认 + §4 决策点裁决选项 i），实施解锁。

**目标**：新增 `editing_presence` 表 + `PgPresenceStore` 第三实现 + migration + db 契约测试，使 editing presence 的「web 进程写、worker 进程读」跨进程契约可由 Postgres 承载，为 Task 9 退役 Redis 铺路。

**不在本子计划范围**（全部归 Task 9 正文）：
- `editing-session.ts` selection 切换为恒用 PgPresenceStore（plan L1292 明文留在 Task 9）；
- Redis 三件（`src/server/redis/`、presence/redis.ts、ioredis 依赖）删除；
- compose / Dockerfile / `scripts/worker.ts` 改造。

**心跳写路径说明**：heartbeat/blur 路由（`src/capabilities/notes/api/editing-{heartbeat,blur}.ts`）已经走 `editing-session.ts` facade（`recordEditingHeartbeat` / `markArtifactIdleAndFlush`），**零路由改动**——Task 9 切换 store 后写路径自然落 PG。本子计划用 db 测试直接构造 PgPresenceStore 验证该路径语义。

---

## 1. 契约现状（实现必须保真的语义）

真相源：`src/server/artifacts/presence/types.ts`（接口 + 两常量）+ `in-memory.ts`（基线状态机）+ `redis.ts`（跨进程实现，prod 现行语义）。要点：

- **状态机**：`recordEditingHeartbeat` 首个 editing 心跳盖戳 `editingStartedAt`（后续心跳不重置，idle 清空）；`isArtifactIdle` **sticky**——editing 超过 `EDITING_HEARTBEAT_TIMEOUT_MS`(30s) 未心跳则副作用转 idle；未见过/已过期的 artifact 读作 idle（安全默认）。
- **defer-vs-apply**：编辑中 → patch 入 FIFO 队列返回 `deferred`；idle 或超过 `EDITING_FORCE_APPLY_TIMEOUT_MS`(10min) force-apply → 调 `persistNoteRefineApply`。
- **原子段边界**：决策（load→判定→入队/写回）必须原子；**DB apply 在原子段之外**（types.ts L82-83 明文）。Redis 用 Lua 单线程保证；PG 等价物 = 短事务 + `SELECT … FOR UPDATE` 行锁。
- **flush**：`markArtifactIdleAndFlush` 原子 drain（置 idle + 清队列）后，事务外按 FIFO 逐个 apply。

## 2. 表 schema（`src/db/schema.ts` 追加）

```ts
// Editing presence（YUK-321 M5 gate 选项 b）：web 进程写心跳、worker 进程读
// idle 决策的跨进程契约，Redis 退役（Task 9）后由本表承载。一 artifact 一行；
// pending 为编辑期被 defer 的 note-refine patch FIFO 队列（jsonb，日期用 ms
// epoch，沿 Redis 序列化形状）。本表是纯状态机存储非业务实体，不设
// created_at/updated_at——时间真相即 last_heartbeat_at。
export const editing_presence = pgTable('editing_presence', {
  artifact_id: text('artifact_id').primaryKey(),
  status: text('status').$type<'editing' | 'idle'>().notNull(),
  last_heartbeat_at: timestamp('last_heartbeat_at', { withTimezone: true }).notNull(),
  // force-apply 时钟：首个 editing 心跳盖戳、idle 清空（types.ts L71-73 契约）。
  editing_started_at: timestamp('editing_started_at', { withTimezone: true }),
  pending: jsonb('pending').$type<SerializedQueuedPatch[]>().notNull().default([]),
});
```

**对 plan 速写的两处偏差（须用户过目确认）**：

1. plan L1290 字段速写为「artifact_id / status / heartbeat_at + 待 flush patch 队列」。落地把 `heartbeat_at` 命名为 `last_heartbeat_at`（对齐 `EditingSessionSnapshot.last_heartbeat_at` 既有字段名），并**补充速写未列的 `editing_started_at`**——`shouldForceApply` 语义（force-apply 10min 时钟）必需，三个现有实现都携带此状态，缺它无法保真契约。
2. `SerializedQueuedPatch`（patch / taskResult / triggerEventId / queuedAtMs）从 `redis.ts` **上移到 `types.ts`** 共享（纯类型移动，redis.ts 改 import），pg/redis 两实现同形序列化。

**YUK-324 教训预防**：jsonb 列经 drizzle 读出**已是解析好的数组**——pg.ts 对 `pending` 一律直接使用，禁止 `JSON.parse`（csv.ts:397 同款漂移已立 YUK-324，此处不重蹈）。

## 3. PgPresenceStore 实现（新建 `src/server/artifacts/presence/pg.ts`）

构造器注入 `Db`（presence 行操作用之）；`persistNoteRefineApply` 一律用 `input.db`——镜像 Redis 实现的分工（redis client 管 presence，`input.db` 管 apply）。

| 方法 | 实现 | 原子性 |
|---|---|---|
| `recordEditingHeartbeat` | 单条 upsert：`.values({...}).onConflictDoUpdate({ set: { status, last_heartbeat_at, editing_started_at: editing ? COALESCE(旧值, now) : null } })`（COALESCE 用 `sql` 片段表达「首戳不重置」） | 单语句天然原子 |
| `isArtifactIdle` | 事务 `FOR UPDATE` load → 无行 `true` → status=idle `true` → 心跳超 30s sticky 写回（`.set({ status:'idle', editing_started_at:null })`）`true` → 否则 `false` | 行锁事务 |
| `enqueueOrApplyNoteRefinePatch` | 事务 `FOR UPDATE` load（无行则插初始 idle 行，镜像 in-memory `currentState`）→ JS 判定 is_idle（含 sticky 写回）+ shouldForceApply → 不 idle 且不 force：pending 追加写回，commit，返回 `deferred`；否则 commit 后**事务外**调 `persistNoteRefineApply` | 决策在行锁事务内，apply 在外 |
| `markArtifactIdleAndFlush` | 事务 `FOR UPDATE` drain：读 pending、置 idle/清 editing_started_at/清 pending、commit → **事务外** FIFO 逐个 `persistNoteRefineApply` | 同上 |
| `getEditingSessionSnapshot` | 单 SELECT，无行返回 null | — |
| `reset` | `DELETE FROM editing_presence`（test helper） | — |

**不做 Redis 式 fail-safe 降级**（YUK-171 的 try/catch→idle 包装不移植）：PG 即业务库——PG 不可用时 `persistNoteRefineApply` 同样写不进去，降级决策无意义；错误直接抛，与仓库其它 db 路径一致。在 pg.ts 文件头注释标注此设计差异及理由。

**行堆积**：一 artifact 一行（upsert 不增行），单用户量级可忽略，不做清理 job（YAGNI，注释标注）。

## 4. ⚠️ 决策点（已裁决）：陈旧 pending 的命运

> **裁决（2026-06-13 用户）**：选 **(i) Redis 等价丢弃**。同时子计划整体过目通过，§2 两处声明偏差（`last_heartbeat_at` 命名 + 补 `editing_started_at` 列）一并确认。

Redis 键带 30s TTL：被放弃的编辑会话（用户关页面、blur 未发出、心跳停止）连同 pending 队列一起**自然蒸发**——ADR-0023 ephemeral 契约明文接受。PG 行不过期，同场景下 pending 会存活到该 artifact 下一次 flush，可能在数天后 apply 一个陈旧 patch。两选项：

- **(i) Redis 等价（推荐）**：`enqueueOrApply` / `markIdleAndFlush` load 时丢弃 `queuedAtMs` 距 now 超过 `EDITING_FORCE_APPLY_TIMEOUT_MS`(10min) 的 pending 项，`console.warn` 计数留痕。保 prod 现行语义（NAS compose 今天就是 Redis 承载），「patch 不会在意外晚的时点突然 apply」。
- **(ii) in-memory 等价**：pending 永存直到 flush。零丢弃，但接受晚到 apply 的语义变化。

推荐 (i)；若选 (ii) 须在 pg.ts 注释标注语义差异。

## 5. Migration + audit 处置

- `pnpm db:generate` → 产出 `drizzle/0030_*.sql`（CREATE TABLE editing_presence）；`pnpm test:migration` 验证 DDL。
- `pnpm audit:schema`：写路径在 pg.ts 经 drizzle builder 落地——`.values()` 含全部 5 字段（upsert 初插）、`.set()` 覆盖 status/last_heartbeat_at/editing_started_at/pending（sticky/入队/drain 三处 update）→ 预期全字段 `live`，**零 allowlist**。若实跑仍有字段被判 stub/init-only，优先补全 builder 写形态；确属延后才按协议登记 allowlist（kind/ref/expected_by）。
- `pnpm audit:partition`：新测试命名 `pg.db.test.ts` 落 db 分区，自然合规。

## 6. 测试（新建 `src/server/artifacts/presence/pg.db.test.ts`，db 分区）

直接构造 `PgPresenceStore`（不经 facade——selection 切换在 Task 9），`persistNoteRefineApply` 处理方式照搬 `redis.integration.test.ts` 既有模式。三组场景：

1. **状态机契约**（移植 `editing-session.test.ts` 全部 11 场景）：no-session 读 idle / 新鲜心跳不 idle / sticky 超时转 idle / 显式 idle 即时生效 / editingStartedAt 首戳不重置且 idle 清空 / idle 即时 apply / editing defer / force-apply 超时 / FIFO flush 顺序与计数 / 空 flush no-op / snapshot null + 活跃字段。
2. **跨进程语义**（移植 `redis.integration.test.ts` 核心 2 场景）：两个 PgPresenceStore 实例（模拟 web/worker 两进程）共享同一 PG——A 写心跳 B 读到 editing；A defer 的 patch 经 B flush。
3. **陈旧 pending**（按 §4 裁决结果）：选 (i) 则断言超 10min 的 pending 在 flush 时被丢弃且 warn；选 (ii) 则断言仍被 apply。

每个测试 `beforeEach` 走 `resetDb()` 惯例（hermetic 契约）。

## 7. 实施步骤与验证 gate

- [ ] `types.ts`：上移 `SerializedQueuedPatch`；`redis.ts` 改 import（行为零变化）
- [ ] `schema.ts`：追加 `editing_presence` 表（§2 代码）
- [ ] `pnpm db:generate` → 检查产出 SQL 只含 CREATE TABLE editing_presence
- [ ] `pg.ts`：PgPresenceStore（§3 + §4 裁决）
- [ ] `pg.db.test.ts`：§6 三组场景
- [ ] Gate（全部原始输出尾部留证）：`pnpm test:migration` / `pnpm vitest run --config vitest.db.config.ts src/server/artifacts/presence/pg.db.test.ts` / `pnpm typecheck` / `pnpm lint` / `pnpm audit:schema` / `pnpm audit:partition`
- [ ] 单 commit：`feat(notes): editing_presence 表 + PgPresenceStore（M5 gate 选项 b 前置）(YUK-321)`，不 push
- [ ] M-cycle：executor 完成后派独立 reviewer（契约保真逐场景比对 in-memory/redis 语义、FOR UPDATE 原子段边界、audit 零 allowlist 实证）

完成后才进 Task 9 正文（plan L1292）。
