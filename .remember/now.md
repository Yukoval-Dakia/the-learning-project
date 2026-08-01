# 当前 handoff — 2026-08-01 YUK-776 placement in-flight recovery

## Current state

- delivery base：`origin/main@6f91bab96c444d68fad8a93764d609563a4d9a5a`（YUK-814 / PR
  #1140 已合并）。
- clean delivery worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-776-placement-inflight-recovery-v2`，
  branch `codex/yuk-776-placement-inflight-recovery-v2`。
- 旧的 stopped worktree
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-776-placement-inflight-recovery`
  仍保留原 uncommitted partial，未修改、未强删；本 lane 只把其可用 diff 移植到 clean main
  base 后补完。

## Delivered invariant

- recovery sweeper 独立扫描 `retry_scheduled`、`queued/running/verifying`、
  `pending_dispatch`，每腿有自己的 `maxPerRun`，不会互相饿死。
- `queued` 在 120 分钟 queue expiry 前完全不 probe；到期后仍须 owning job non-live 才收口。
- `running/verifying` 的权威是 active attempt lease，不是 claim elapsed timestamp：future lease
  停到精确 expiry；expired/null/missing attempt 仍须 owning job non-live 才进入 durable reap。
- durable reap 在一个事务内 re-check claim/job/fence/lease，interrupt attempt、只 supersede
  `authorized` questions、terminalize claim；renewed lease、rotated fence、changed job/status、
  row-lock contention 全部 fail-closed stand down。
- in-flight leg 在 paid pending leg 之前执行：同一 `(goal, subject)` 的 old running zombie 被
  exhausted 后，current authoritative pending claim 同轮进入 queued；若 old job 首轮仍 live，
  真实 dispatch savepoint 的 23505 会回滚 enqueue 但保留同一个 current claim，下一轮 old dead
  后无需 re-materialize 即可 queued。
- renew / mark-verifying / finish 都要求 `lease_expires_at > now`，过期 worker 不能复活旧 fence。

## Verification evidence

- scoped real-Postgres command：
  `pnpm exec vitest run --config vitest.db.config.ts src/capabilities/practice/server/placement-starter-recovery.db.test.ts src/server/question-supply/placement-starter-attempts.db.test.ts src/server/question-supply/placement-starter-store.db.test.ts --reporter=dot`
- 当前结果：3 files / 101 tests passed；覆盖 queue boundary、running+verifying、null/missing
  attempt、terminal history、complex 三题 authority packet、lease/fence/job races、两个 sweeper、
  claim/attempt NOWAIT locks、三腿独立 cap、live→dead 两轮恢复，以及生产 dispatch Tx 的
  cross-revision 23505 保留/重试契约。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：passed。
- 未在本机运行完整 `pnpm test`；完整 pre-merge gate 只由 exact-head GitHub CI 执行。

## Closeout boundary

- 本 lane 不部署、不触发真实付费 generation、不改 placement feature flag。
- YUK-776 合并后可置 Done；后续 product issue 在下一独立 session 继续。
- 未发现需要另建 Linear issue 的新 P0/P1；未结算 `reservation:*` 在 terminal old claim 中保留
  保守成本上界，不静默退款或抹除真实 provider provenance。
