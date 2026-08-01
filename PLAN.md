# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-01
> **【YUK-776 已交付；NEXT YUK-759】**

## NOW

- **YUK-776 已 Done。** PR #1141 合并到
  `main@319f0f2ab6d6dde2ea01dd254bce79b2d110736f`：placement recovery 现在按
  `retry_scheduled`、`queued/running/verifying`、`pending_dispatch` 三条独立 capped leg
  恢复；in-flight 以 queue expiry / active attempt lease + owning job liveness 判定，原子
  interrupt attempt、supersede authorized questions、terminalize claim，且旧 worker 的
  renew / verifying / finish 不能跨过期 lease 复活。
- scoped real-Postgres 3 files / 101 tests、`pnpm typecheck`、`pnpm lint`、`pnpm build`
  全绿；独立复核无未解决 P0/P1。exact-head CI Gate `30675310904` 与合并后 main CI Gate
  `30675656977` 全绿。**未在本机运行完整 `pnpm test`**；无部署或 feature-flag 变更。
- **YUK-814 已 Done。** complex-mock owner waiver 经 PR #1140 合并到 `main@6f91bab9`；
  只关闭 issue，不声称 real canary 通过，也不翻无人值守扩量 flag。
- 2026-08-01 live Linear：Backlog 85、In Progress 4、Todo 1，严格未完成共 **90**；排除
  owner 指示 parked 的 OpenCode YUK-813 / YUK-831 后，当前产品执行口径 **88**。

## NEXT

1. 下一独立 session 启动 **YUK-759**：将 `SemanticJudgeTask` 从 free-text JSON-fishing
   迁到已交付的 structured-output seam，保留 absent fallback 与 verdict 语义，删除对应
   audit allowlist，并用复杂、现实的 valid / schema-mismatch / fallback 数据覆盖。
2. YUK-759 scoped validation、独立 review、exact-head GitHub CI 全绿后自主合并，并同步
   Linear、`PLAN.md`、`.remember`；完整 `pnpm test` 仍只在 GitHub CI 跑。
3. 继续按产品价值处置 backlog/Todo：优先可自主验证的可靠性闭环；重复、过期或没有
   live consumer 的项先核证再 Canceled / Duplicate，parent 在 children 处置后关闭。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；不与当前产品 reliability lane 混跑。
- 其余 future/refinement backlog 不自动开 implementation lane，先做 owner scope triage。

## BLOCKED-ON

- **无人值守 auto-intervention expansion**：YUK-814 的 issue-status waiver 不等于生产
  rollout 授权；未来翻 flag 仍须 owner 明示与届时认可的 actual-product-output evidence。
- **YUK-571 / YUK-405 / YUK-406**：等待 owner 真实内容、首次 placement 与观察窗口；agent
  不代答、不把 synthetic/mock 伪装成真实 owner 验收。
- **YUK-452**：parent/epic，须先对齐未完成 children，不能用单条代码变更直接关单。
- **严格 issue=0**：每次只推进一条 active 产品线；OpenCode parked 不等于已完成。
