# 当前 handoff — 2026-07-30

## Active line

- 当前无 active implementation lane。
- worktree：`/Users/yuqi/.codex/worktrees/9a32/the-learning-project`。
- branch：`codex/yuk-825-closeout`；base `origin/main@98b46c97`。
- YUK-825 已 Done；PR #1115 于 2026-07-30 squash merge，main commit `98b46c97`。
- 后续实施已捕获为 YUK-826（Backlog），不得把首波局部收益表述成全量 CI 已显著提速。

## 已实现

1. `tests/helpers/db.ts` 新增 opt-in `beginTestTransaction()` /
   `rollbackTestTransaction()`：从 test pool reserve 单连接，外层 `BEGIN`，每测后 `ROLLBACK`。
2. postgres-js ReservedSql 缺少 Drizzle 构造所需 runtime `options`，helper 显式复用 owning
   pool options；应用内 `db.transaction()` / nested transaction 通过 savepoint shim 保持语义。
3. fail-closed guard：重复 begin 报错；活跃事务内 `resetDb()` 报错；cleanup 先清路由指针，
   再 rollback/release，避免失败后把后续测试绑定到已释放连接。
4. 新增 `tests/helpers/db-transaction.db.test.ts`，覆盖 rollback 不泄漏、guard、savepoint 回滚、
   configured transaction fail-closed、reserved connection 复用。
5. `proposal-tools.test.ts` 全文件迁移为 beforeAll reset + per-test transaction rollback。
6. `orchestrator.db.test.ts` 只迁移无显式并发的 trigger semantics 与 abandoned-run cancel
   两个 describe；包含 multi-worker/CAS `Promise.all` 的 catch-up/logging describe 保留 TRUNCATE。
7. `AGENTS.md` / `CLAUDE.md` 已记录混合隔离合同与禁止迁移的类别。
8. PR review 发现的 transaction options、savepoint cleanup、setup release 边界均已处理；
   exact-head 所有 review threads 已解决。

## 性能与验证

- 变更前基线（proposal + orchestrator，95 tests）：48.94s、56.55s。
- 变更后（同两文件 + 4–5 个 helper tests，共 99–100 tests）：24.46s、25.16s、26.27s、
  27.38s；下降约 44%–57%。
- shuffle seed 825/826：各 99 passed；review 修复后 seed 827：100 passed。
- `pnpm typecheck`、`pnpm lint`、schema/partition/profile/draft-status audits 全绿。
- 完整 `pnpm test`：unit 5917 passed / 33 skipped；DB 4271 passed / 9 skipped / 1 todo；
  migration 27 passed。
- `pnpm build` 全绿。
- 完整本地 DB duration 1305.12s；当时另一 YUK-821 worktree 同时运行 DB tests，故只作
  正确性证据，不作性能对比样本。
- exact-head GitHub CI run 30473740433 全绿：unit 2m16s；DB shard 1/2 5m49s、2/2
  6m18s；shard 2 Vitest 319.48s / tests aggregate 807.42s。
- CI 文件实测：orchestrator 10.88s（main 25.57s，约 -57%）；proposal-tools 40.29s
  （main 46.15s，约 -13%）。整个 shard 2 aggregate 仅从 824.50s 降至 807.42s
  （约 -2.1%）；job wall 本次反而更慢，属于 runner/setup 波动，不能当作回归或收益。

## 下一步

1. 提交并合并本 closeout branch，使 cockpit 与 Linear/main 对齐。
2. 后续若启动 YUK-826：先按 CI 高耗时与 reset 密度审计安全候选，再分批迁移；每批至少
   2 个 shuffle seed + full DB，最终用至少 3 次 exact-head/main CI 量化。
3. proposal-tools 的 runner 动态 import/transform 是独立固定成本，不混入 TRUNCATE 收益。

## 并行事实

- YUK-821 PR #1110 已于 2026-07-29 合并到 main（`770936e0`）；但 canonical Opus 质量
  输出门被 429 weekly limit 阻断，Linear 不应仅因代码合并而关闭。
- YUK-820 selector 与 YUK-823 TS7 rollout 均已在 main。
