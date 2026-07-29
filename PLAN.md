# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-30
> **【更新 2026-07-30 · YUK-825 混合 DB 测试隔离第一波已合并】**
> PR #1115 / `98b46c97` 已进 main；事务安全测试可用单连接 `BEGIN/ROLLBACK`，
> 不安全类别继续 `TRUNCATE`。首波局部收益明确，但全 shard 只下降约 2.1%，第二波见 YUK-826。

## NOW

- **当前无 active implementation lane。**
- **YUK-825 已 Done**：PR #1115 exact-head CI/review 全绿并 squash merge；所有 review
  threads 已解决。
- GitHub CI run 30473740433：unit 2m16s；DB shard 1/2 5m49s、2/2 6m18s。shard 2
  Vitest 319.48s / tests aggregate 807.42s。
- 已迁移文件：`orchestrator.db.test.ts` 10.88s（main 对照 25.57s，约 -57%）；
  `proposal-tools.test.ts` 40.29s（对照 46.15s，约 -13%）。首波只让 shard 2 tests
  aggregate 从 824.50s 降至 807.42s（约 -2.1%）；单次 job wall 受 runner/setup
  波动反而更慢，不宣称全局 CI 已显著提速。

## NEXT

1. **YUK-826**：按真实 CI 文件耗时与 `resetDb()` 密度审计第二批单连接测试；只迁移无
   并发、无跨连接可见性、无 pg-boss/advisory lock、无 identity reset 断言的 describe。
2. 第二波以至少 3 次 exact-head/main CI 比较 shard Vitest duration 与 tests aggregate，
   不用单次 job wall 波动冒充收益。
3. **YUK-820 live timing**：继续用普通 server/API PR 验收 affected-selector 的真实命中率。

## PARKED

- **YUK-820 live timing**：DB affected selector 已合入 main、failed-head 回放 20/20；继续以
  普通 server/API PR 的 GitHub timing 验收 selector wall-clock。
- **YUK-826 第二波事务回滚迁移**：已在 Linear Backlog；候选优先看 knowledge proposals、
  hub sync reconciliation、candidate signals、rubric validator、placement starter recovery。
- **YUK-821 代码已合并**：PR #1110 / `770936e0` 已进 main；canonical Opus 8 簇真实输出
  质量门仍未关闭，因此 Linear 保持 In Progress，不把代码合并冒充真实输出验收。
- **YUK-822：P1 学科确定性验证器**：设计在
  `docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`；待后续单独实施。
- **干预准备/结算/协作档案**：YUK-791/796、YUK-792、YUK-815、YUK-816；按 mesh
  依赖顺序推进。
- **YUK-824 本地 lint 假红**：sanctioned `.ykv/**` code-index cache 的精确忽略仍是独立线；
  本轮 pre-PR 前仅删除当前 worktree 的本地索引产物，没有改 Biome 范围。

## BLOCKED-ON

- **YUK-821 canonical Opus 输出质量**：2026-07-29 实测被 429 weekly limit 阻断；配额故障
  只记 operational，不能用 fallback 或空输出冒充 canonical pass。
- **auto-intervention 扩大使用**：仍需真实 owner/cohort shadow/blind/canary 证据；这是发布
  和扩量条件，不是继续实现功能的前置条件。
