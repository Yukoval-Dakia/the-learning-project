# 当前 handoff — 2026-08-01 YUK-776 已交付，NEXT YUK-759

## Delivered

- YUK-776 / PR #1141 已合并：
  `main@319f0f2ab6d6dde2ea01dd254bce79b2d110736f`；Linear 已 Done，并已有 PR、merge、
  exact-head / post-merge CI evidence。
- recovery sweeper 独立扫描 `retry_scheduled`、`queued/running/verifying`、
  `pending_dispatch`，每腿有自己的 `maxPerRun`。queued 复用 120 分钟 expiry；
  running/verifying 以 active attempt lease 为权威，且必须确认 owning pg-boss job non-live。
- durable reap 在一个事务中重新检查 claim/job/fence/lease，interrupt attempt、只 supersede
  `authorized` questions、terminalize claim；renewed lease、rotated fence、changed job/status、
  row-lock contention 全部 fail-closed stand down。
- in-flight leg 先于 paid pending leg；旧 live revision 的 unique 冲突由 savepoint 回滚，保留
  current pending claim，旧 job 后续 dead 时无需 re-materialize 即可重试 queued。
- renew / mark-verifying / finish 都要求 lease 未过期，过期 worker 不能复活旧 fence。

## Verification evidence

- scoped real-Postgres：3 files / 101 tests passed；覆盖 queue boundary、running/verifying、
  null/missing attempt、terminal history、复杂三题 authority packet、lease/fence/job races、
  两个 sweeper、claim/attempt NOWAIT locks、三腿独立 cap、live→dead 两轮恢复，以及生产
  dispatch Tx 的 cross-revision 23505 保留/重试契约。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：passed。
- PR exact-head CI Gate `30675310904`：passed；merge 后 main CI Gate `30675656977`：passed。
- 独立 initial review 的 P1 已修复；一次 verification review 无未解决 P0/P1。
- 未在本机运行完整 `pnpm test`；本 lane 不部署、不触发真实付费 generation、不改 placement
  feature flag。

## Current queue

- 2026-08-01 live Linear：Backlog 85、In Progress 4、Todo 1，严格未完成 **90**；排除按
  owner 指示 parked 的 YUK-813 / YUK-831 OpenCode 后，产品执行口径 **88**。
- 下一条独立产品 lane：YUK-759 `SemanticJudgeTask` structured-output 迁移。范围是 registry
  schema、`runSemantic` 三态 parse、移除 audit allowlist、复杂现实单测与 exact-head CI；
  不涉及 UI、owner 数据、部署或 feature flag。
- YUK-571 / YUK-405 / YUK-406 等待真实 owner 输入/观察；YUK-452 是 parent/epic。

## Worktrees

- clean functional delivery worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-776-placement-inflight-recovery-v2`。
- 旧 stopped worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-776-placement-inflight-recovery`
  仍保留原 uncommitted partial，未修改、未强删。
- 本 closeout worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-776-closeout-board`。

## Capture gate

- YUK-776 已补最终 CI / merge comment；没有发现需要新建 Linear issue 的 P0/P1 actionable
  follow-up。reservation 在 terminal old claim 上保留保守成本上界与 provider provenance，
  属于明确边界而非遗漏。
