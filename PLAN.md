# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-30
> **【更新 2026-07-30 · YUK-825 混合 DB 测试隔离已实现，待 PR/CI】**
> 事务安全测试改用单连接 `BEGIN/ROLLBACK`；并发、独立连接、pg-boss、advisory lock
> 与跨连接 commit visibility 继续使用全量 `TRUNCATE`，不做危险的一刀切。

## NOW

- **YUK-825：DB tests 混合隔离第一波**
  - `tests/helpers/db.ts` 新增 opt-in `beginTestTransaction()` /
    `rollbackTestTransaction()`；postgres-js reserved connection 持有外层事务，应用内
    `db.transaction()` 映射为 savepoint。
  - fail closed：活跃事务内禁止 `resetDb()`，重复 begin 报错；helper 契约与不适用边界
    已写入 `AGENTS.md` / `CLAUDE.md`。
  - 首批迁移 `proposal-tools.test.ts` 全文件，以及 `orchestrator.db.test.ts` 中两个无并发
    describe；catch-up/concurrent logging 等并发语义仍保留 TRUNCATE。
  - 基线（proposal + orchestrator，95 tests）：48.94s / 56.55s；优化后连同新增 helper
    测试共 99–100 tests：24.46s / 25.16s / 26.27s / 27.38s，墙钟下降约 44%–57%。
  - shuffle seed 825/826 全绿；完整 pre-PR gate 全绿：unit 5917、DB 4271、migration 27，
    lint/audits/typecheck/build 通过。完整本地 DB 受另一 worktree 同时跑 DB 竞争影响为
    1305s，不作为性能对比样本。

## NEXT

1. 提交并推送 `codex/yuk-825-db-rollback`，创建 ready PR（Closes YUK-825）。
2. 检查独立 review、未解决 review threads 与 exact-head GitHub CI Gate；有 finding 就修复
   并重新验证。
3. CI/review 全绿后 squash merge，Linear YUK-825 → Done，并记录真实 CI shard timing。

## PARKED

- **YUK-820 live timing**：DB affected selector 已合入 main、failed-head 回放 20/20；继续以
  普通 server/API PR 的 GitHub timing 验收 selector wall-clock。
- **YUK-821 代码已合并**：PR #1110 / `770936e0` 已进 main；canonical Opus 8 簇真实输出
  质量门仍未关闭，因此 Linear 保持 In Progress，不把代码合并冒充真实输出验收。
- **YUK-822：P1 学科确定性验证器**：设计在
  `docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`；待后续单独实施。
- **干预准备/结算/协作档案**：YUK-791/796、YUK-792、YUK-815、YUK-816；按 mesh
  依赖顺序推进。
- **YUK-824 本地 lint 假红**：sanctioned `.ykv/**` code-index cache 的精确忽略仍是独立线；
  本轮 pre-PR 前仅删除当前 worktree 的本地索引产物，没有改 Biome 范围。

## BLOCKED-ON

- **YUK-825：无 blocker**；只待 PR review/CI/merge。
- **YUK-821 canonical Opus 输出质量**：2026-07-29 实测被 429 weekly limit 阻断；配额故障
  只记 operational，不能用 fallback 或空输出冒充 canonical pass。
- **auto-intervention 扩大使用**：仍需真实 owner/cohort shadow/blind/canary 证据；这是发布
  和扩量条件，不是继续实现功能的前置条件。
