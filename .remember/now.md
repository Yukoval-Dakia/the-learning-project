# 当前 handoff — 2026-08-01 YUK-805 已交付，NEXT YUK-757

## Delivered

- YUK-805 / PR #1147 已合并：
  `main@1989ac7fe42f091db37755a4d7052d65bbeadeae`；Linear 已自动 Done，并已有 PR、
  merge、exact-head CI 与收口评论 evidence。
- `probe-answer.ts` 现在把 `createDefaultJudgeInvoker().invoke()` 返回的 authoritative
  `task_run_id` 传给 `answerProbe`，后者写入既有 event envelope 列；保持 nullable、无 FK、
  无 migration，不扩张公共 invoker 契约。
- conjecture runbook 的成本口径从 task-kind 上界改为
  `experimental:probe_result + subject_kind='question'` 出发，再按 `task_run_id` 连接
  `ai_task_runs` / `cost_ledger` 的 probe-only 查询；按 currency 分组并保留历史空关联。
- provider 文档与现实一致：vision 调用点 override 逐字段优先于 global override，再回落
  registry；默认 multimodal judge 为 `xiaomi/mimo-v2.5`。

## Verification evidence

- TDD red 先证明两个 event 路径原先都落 `task_run_id = NULL`；实现后 scoped PostgreSQL
  DB 2 files / 48 tests 通过。复杂 fixture 同时 seeded probe 判分与同 task/provider/model
  普通练习判分，生产形 SQL 只计 probe ledger row、tokens 与 cost。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、schema/partition/capability/API audits、
  Postman generation、Biome 与 `git diff --check`：passed。
- 两路独立 initial review 各完成一次 verification，最终均无 P0/P1/actionable P2；OCR
  exact-head review 0 comments，GitHub 无开放 review thread。
- PR exact-head CI Gate `30691440250` 在
  `761885ac1b39b5bf5ab6ea18e500bc4f9ed2d286` 全绿；CodeRabbit/Cursor 因额度未运行，
  按 advisory policy 不阻塞。未在本机运行完整 `pnpm test`；本 lane 不部署、不改 flag、
  不触发真实付费模型。
- 合并后 `main@1989ac7f` CI Gate `30691590064` 全绿。

## Current queue

- 2026-08-01 live Linear：Backlog 82、In Progress 4、Todo 1，严格未完成 **87**；排除
  owner 指示 parked 的 YUK-813 / YUK-831 OpenCode 后，产品执行口径 **85**。
- live projects 共 19：3 In Progress、2 Backlog、1 Planned、13 Completed。
- YUK-772 因 closeout PR automation 从 Done 回拨到 In Progress，已核对合并/CI 现实并
  手动恢复 Done；后续 closeout PR 合并后必须再次核对并恢复 touched issue 状态，避免
  留下虚假的 In Progress。
- 下一条独立产品 lane：YUK-757。它包含 UI，须先给 owner 提交 design doc 逐字引用、
  组件类型和精确文件清单并获批；批准前不写 UI。
- YUK-571 / YUK-405 / YUK-406 等待真实 owner 输入，YUK-452 是 parent/epic；
  YUK-813 / YUK-831 OpenCode 按 owner 指示 parked。

## Worktrees

- YUK-805 functional + closeout worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-805-probe-cost-attribution`。
- functional branch `codex/yuk-805-probe-cost-attribution` 已由 PR #1147 squash merge；当前
  worktree 已切到 `codex/yuk-805-closeout`，基于 `main@1989ac7f`。
- primary repo 的既有 unrelated dirty/conflict 未触碰；未强删任何 worktree 或 branch。

## Capture gate

- 已搜索 `probe task_run_id cost ledger attribution`、`experimental:probe_result task_run_id`
  与 `vision judge provider runbook`；相关命中由 YUK-805、YUK-197、YUK-566 等既有票覆盖。
  本次没有新增、去重后的 actionable follow-up，因此未新建 Linear issue。
