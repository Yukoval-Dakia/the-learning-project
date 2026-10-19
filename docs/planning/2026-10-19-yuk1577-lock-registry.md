# YUK-1577 — advisory-lock ownership registry

> 架构深化线子任务交付文档。分支 `refactor/yuk-1577-lock-ownership-registry`，基于
> `origin/main@69644912`。权威叙述文档：`docs/architecture/advisory-locks.md`；机器可读
> 注册表：`src/db/advisory-lock-registry.ts`。

## 1. Owner / full operation

**Owner**：`src/db/advisory-lock-registry.ts`（新模块）+ `docs/architecture/advisory-locks.md`
（新权威文档）。

**完整操作**：对全仓生产代码的 Postgres advisory lock 做完整盘点（acquire / try / unlock
三类原语、命名空间、key 编码、session vs xact 生命周期、释放/超时/失败归属），把盘点
结果落成两个真实消费面：

1. **常量所有权迁移**：`LEARNING_STATE_WRITE_LOCK`（'learning-state:write'）字面量由
   registry 拥有，`learning-state-lock.ts` 兼容再导出。SQL 语句逐字节不变
   （`pg_advisory_xact_lock(hashtext('learning-state:write'))`）。
2. **Fail-closed session admission**：`withinSessionAdvisoryLock` 在保留任何连接之前
   调用 `requireSessionAdvisoryLockFamily(lock)`；未注册描述符抛 coding error 而不是
   静默形成第五条锁协议。当前全仓仅 2 个 helper 调用方（compose-paid-work-lock、
   evaluate-submission），其 family 均已注册，行为不变。

非目标（刻意不做）：不生成 SQL、不做 runtime validator、不改任何获取/重试/超时顺序、
不为"显得活"造伪消费者。Registry 是纯描述元数据 + 两个真实消费点。

## 2. Caller knowledge removed

迁移前，回答"有哪些 advisory lock、谁和谁互斥、按什么顺序取"需要读 ~70 个
`pg_advisory*` 调用点、3 个 helper、以及散落各文件的中文/英文锁序注释；每个新写锁的
人都要重新发明命名空间约定并祈祷不与 int4 字面量（`597_001`、`406_440_3`、
`1356/1393/1355` 族）或裸 `hashtext(<id>)` 撞 keyspace。

迁移后：caller 只需要 registry 一个查表入口——family / keyTemplate / encoding /
scope / sites / after 边都在一处；session-lock helper 自带 fail-closed 准入门禁。

## 3. Two real maintenance scenarios (before → after)

**场景 A：新增一个 session-scoped 锁（比如新 durable family 的跨事务 claim）**

- *Before*：抄 `withinSessionAdvisoryLock` 调用，自定义 `{key:'my-thing:'+id, busy}`。
  若 key 与既有 `stream:compose-paid:<date>` 或匿名 `hashtext(<id>)` 空间冲突，没有任何
  编译期或运行期提示；冲突表现为偶发互斥失败，只能在 pg_locks 里捞。
- *After*：同一调用在 `requireSessionAdvisoryLockFamily` 处立刻抛
  "unregistered session advisory lock"，迫使作者在 registry 里登记 family（key
  模板、scope、release 语义、sites）——登记动作本身让冲突检查变成一次文本检索。

**场景 B：排查 "G 与 assessment-evaluation-group 谁先谁后" 的死锁疑问**

- *Before*：需要同时读 `activate.ts` 头注释、`evaluate-submission.ts:785` 的 session
  包装、`submit.ts:355`、`appeal.ts:24→41`、`review-operation.ts:399→421` 与
  `drizzle/0114` trigger，自己拼出 "G → group → row locks → fsrs:*" 全序。
- *After*：`docs/architecture/advisory-locks.md` §4.2 已给出该脊柱的全部已证边与
  holders 表；§5 明确标注"fsrs:* 后接 group"无站点 —— 不存在环。

## 4. Old responsibilities actually removed

- `src/db/learning-state-lock.ts` 不再拥有 `'learning-state:write'` 字面量本身
  （迁移到 registry；常量值、SQL、语义不变，re-export 兼容全部 ~20 个 import 点）。
- "锁知识" 的权威从"散落在 70 个调用点 + 各文件注释"收敛为 registry + 一篇权威
  文档。各调用点的局部锁序注释保留（它们是其函数内部的局部事实），但跨函数锁序
  的唯一叙述来源改为 `advisory-locks.md`。
- `withinSessionAdvisoryLock` 不再"无条件接受任意 key"——未注册描述符被拒（新增
  fail-closed 职责）。这是刻意加固：全仓仅 2 个生产调用方，均已注册。

## 5. Failure / transaction / lock / compat behavior retained

- 所有 `pg_advisory*` SQL 语句、key 字面量、hashtext/hashtextextended 编码、salt、
  int 字面量均未改动（registry 只描述，不改写）。
- `withLearningStateLock` 的 Db-vs-Tx `'$client' in db` 分发、session helper 的
  reserve-before-deadline / try-with-deadline / 25ms backoff / timed-out unlock-then-
  release / busy() 语义逐行保留。
- 新增的 `requireSessionAdvisoryLockFamily` 在任何连接保留之前执行；不改
  reservation timing、release、error 路径。失败形态：unregistered key → 同步 throw
  （async 函数内即 rejected promise），不经过 `busy()`。
- 排序/重试/超时无任何变更；row-lock 交互（FOR UPDATE/FOR SHARE）未触碰。

## 6. True metric delta

- 新增：`src/db/advisory-lock-registry.ts`（~900 行数据模块，79 条 family 记录 +
  2 个查询函数）、`docs/architecture/advisory-locks.md`（权威文档）、本文档。
- 修改：`src/db/learning-state-lock.ts`（常量来源换成 registry + 兼容 re-export），
  `src/db/session-advisory-lock.ts`（+1 import，+1 行 fail-closed 调用 + 3 行注释）。
- 删除：无文件、无导出、无行为。
- 锁 inventory 覆盖率：79/79 family（生产 `pg_advisory*`/`pg_try_advisory*`/
  `pg_advisory_unlock` 站点全枚举，原始证据 148 行见仓库外 artifact）。
- 排序证明：18 组已证边（§4），未决 0 个可达环；§5 记录 5 条边界说明。
- 文件行数不是深化指标：本次深化的实质是"70 个散落调用点的锁知识 → 1 个可查表
  + 1 个 fail-closed 门禁"，接口面缩小（session helper 的隐含契约变为显式注册）。

## 7. Verification

- `pnpm exec tsc --noEmit`（根 tsconfig）：PASS（本 worktree head）。
- `pnpm lint`（biome check .）：见 §8 记录。
- `pnpm build`（rw:web:build + 三 esbuild 产物）：见 §8 记录。
- NOT_RUN：无测试新增/修改（owner 2026-10-12 规则：测试需先交文本方案经批准；
  本改动也不触及五类不变量之外的断言面）。无 DB / runtime / provider / paid 验证
  —— fail-closed 门禁的行为变化（unregistered key 会 throw）仅靠静态调用方枚举
  支撑：`rg withinSessionAdvisoryLock` 全仓仅 2 个生产调用点、0 个测试直调，
  两者 key/namespace 均匹配已注册 sessionMatch。若未来新增 session-lock 调用方
  未登记，第一次调用即 throw —— 这是设计意图而非回归。
- NOT_RUN：`pnpm test` 全量（按 AGENTS.md 仅由 push 后 exact-head CI Gate 执行）。

## 8. Coverage denominator / unresolved

- **Denominator**：79/79 family（registry 记录数 = 盘点发现的 family 数；
  `pg_advisory*` 原始站点 148 处含 helper 定义行与注释行，family 按 key 模板/
  命名空间归并）。
- **Unresolved ordering**：0 reachable cycles；§5 明确列出 5 条"无环但值得记录"
  的边界（匿名 int4 claim 共享 keyspace 属理论碰撞面，无实证冲突）。
- **Off-limits 只读**：`src/server/ai/*`（4 family）、`src/db/paid-effect-*.ts`（2
  family）只读盘点，未编辑。

## 9. Follow-ups（非本 PR 范围，已记录给父级）

- `src/server/advisory-locks.ts`（sorted helper）未来可同样改为从 registry 读
  namespace 常量，使 `fsrs:knowledge` / `knowledge_edge` 等字面量有单一 owner；
  该文件不在本 lane 所有权内，未动。
- `model_slice_admission_run.ts` 自留 reserved-connection session lock（不经
  `withinSessionAdvisoryLock`）。统一走 helper 需要改其 off-limits 邻近文件，
  本 lane 只在 registry 中登记其 family 并标注机制差异。
- `acquireSortedAdvisoryLocks` 的 namespace 参数是裸字符串（`fsrs:knowledge`、
  `axis_state:*` 等）；registry 已登记其 family，但字符串常量仍散在调用点 ——
  常量集中化属下一刀（同样触及 off-limits 文件）。
