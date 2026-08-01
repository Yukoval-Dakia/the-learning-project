# 当前 handoff — 2026-08-01 YUK-596 durable liveness 后端 safety slice

## Delivered before this lane

- YUK-757 / PR #1149 已在 exact-head CI 全绿后 merge 到
  `main@54d9bf620cf74d07633d72233c90cb9763516643`。
- YUK-596 causal-history / PR #1150 已在 exact-head CI 全绿后 merge 到
  `main@915fd5d4fd32cdceebda310879c7fd0c0138e9e5`；durable pickup 绑定 dispatch 的
  `session_id + run_id` causal anchor。

## Current implementation

- worktree：`/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-596-durable-liveness`
- branch：`codex/yuk-596-durable-liveness`
- functional commit：`e3d73d8d7a4b32b4d2082c091b1fa163aaee2ab5`
- PR：[#1151](https://github.com/Yukoval-Dakia/the-learning-project/pull/1151)
- `copilot-run-status.ts` 是 canonical terminal predicate：历史
  `FAILED(reason='error')` 是 retry frame；其它 FAILED（含 missing/unknown reason）
  fail-closed terminal。backlog、dispatch、checkpoint revert 与 handler settlement 共用 SQL/JS
  twin，避免再次漂移。
- 新 `src/server/boss/job-observation.ts` 泛化 pg-boss created/retry/active、
  completed/cancelled/failed、missing 与 lookup-unknown 证据；Judge adapter 复用且保持旧恢复语义。
- JobDecl 支持可选 queue `heartbeatSeconds`；`copilot_run` 配 30s heartbeat，pg-boss 自动刷新，
  crash 的 active delivery 会进入 retry/failed 权威证据。
- 新偶数分钟（最多等两分钟）fast singleton `copilot_run_reconcile`：每轮最多扫 20 个 outstanding run、零
  model/tool。先修已持久化 outcome marker；created/retry/active 与 queue lookup error 零写；
  仅 QUEUED-only、无 worker-touch 的 dead/missing delivery 原子收敛到
  `pre_execution_lost`。explicit fence 或 legacy STARTED/DELTA/STEP/REPLY/FAILED(error) 均
  fail-closed 为可能执行，只在 12min execution ceiling + 30s grace 后写无 checkpoint 的
  `ambiguous_execution`。
- malformed physical payload 改为抛给 pg-boss，避免 warn+complete 留永久非终态 zombie。
- Dock/API/UI 未改；busy / backlog / unavailable 的消费面与 in-loop stop 留后续 slice。
- agent guidance 已明确禁止本机完整 `pnpm test`；development workflow 与 control-plane audit
  同步强制完整 suite 只跑 push 后 exact-head GitHub `CI Gate`。

## Verification evidence

- real Postgres + real pg-boss：8 files / **68 tests passed**。包括真实 created/active/
  completed/retry/failed/cancelled/missing/unknown、batchSize:1 busy queue、stale heartbeat
  `supervise()` failover，以及混合 durable backlog 的幂等 reconciliation。
- unit：6 files / **65 tests passed**（含 durable pickup 与 control-plane audit tests）。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：passed。
- agent-control-plane/schema/partition/API contract/client/capability/profile/draft-status audits：
  passed；partition 的 2 个 unmatched 均为 owner 指示暂不处理的 `.opencode` tests。
- 独立 initial review 找到 1 个 P1：legacy `FAILED(error)` + dead queue 会被误写成
  pre-execution loss 并暴露 checkpoint。已改为复用 worker-touch predicate、走 ambiguous
  no-checkpoint，并补复杂 DB regression；唯一 verification review 确认无 P0/P1。
- fixture 使用 48 条历史作答、6 个探针、3 份讲义、9 道迁移变式、busy/retry/fence/
  marker/lookup-error 等复杂状态；mock 只覆盖 seam，真实 pg-boss contract 另跑实库。
- 完整 `pnpm test` 未在本机运行，必须交 exact-head GitHub CI。

## Current queue

- 本 handoff commit 推送后等 PR #1151 exact-head CI 全绿并自主 merge，不等待 advisory
  P2/minor/nit。
- merge 后新 worktree 推进 YUK-596 in-loop stop，再跑约 30 条真实 provider 复杂对话
  burn-in；封存 revision、输入/输出 digest、task-run/provider/model/cost。
- Dock/UI 前必须重新执行 design pre-flight 并等 owner 批准；之后才做 LIGHT/FULL gate。
- YUK-596 完整收口后顺序：YUK-764 → 457 → 268 → 285 → 213。

## Capture gate

- Linear YUK-596 已现场核验为 In Progress。搜索 `copilot durable queue heartbeat
  reconciliation stale run` 命中 YUK-596/YUK-693；当前实现属于 YUK-596，backlog cap 复用
  YUK-693，没有重复建票。
- `pnpm test exact-head CI local agent control plane` 命中 YUK-812 等既有 tooling 范围；本轮
  只是执行 owner 明确要求并修正现有 audit，不另建 issue。
