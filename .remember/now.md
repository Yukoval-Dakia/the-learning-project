# 当前 handoff — 2026-08-01 YUK-596 causal-history PR #1150

## Delivered before this lane

- YUK-757 / PR #1149 已在 exact-head CI Gate `30706461286` 全绿后 squash merge：
  `main@54d9bf620cf74d07633d72233c90cb9763516643`；Linear 已 Done。
- YUK-757 的最后 P2（run 终态可能遗留 running subtask 卡）已去重折入 YUK-596 UI 收口，
  不阻塞 #1149。

## Current implementation

- worktree：`/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-596-causal-history`
- branch：`codex/yuk-596-causal-history`
- functional commit：`9695b0416b1dfc87fb46780311f20e0ebd9aaa74`
- PR：[\#1150](https://github.com/Yukoval-Dakia/the-learning-project/pull/1150)
- `getCopilotTurnsBeforeAnchor` 固定读取 job 的 session + persisted user-ask anchor；root/chip
  以 anchor 前 dispatch coordinate 判资格，reply 继承 causal root，parentless legacy reply
  退回自身 coordinate；future/cross-session 因果在 SQL LIMIT 前排除。
- anchored SQL 按 causal root 排序，同 root newest-first 为 reply→root，projection reverse 后为
  root→reply；避免 batchSize:1 下多 ask 先排队、reply 后落库时产生孤立 AI 历史。
- current reusable-session reader 与 anchored reader 共用 correction/retraction/materializing/
  ambiguous/checkpoint projection；inline 与 `/api/copilot/turns` 行为未变。
- missing legacy anchor 按 YUK-596 2026-07-09 锁定契约 structured alert 后回退旧 reader；
  existing wrong action/session fail closed 到 pinned header。

## Verification evidence

- TDD red 先证明 future turn 泄漏、同毫秒边界错误、25h 后读错 session、mismatch 未关闭。
- final scoped real-Postgres：3 files / **68 tests passed**：
  `turns.db.test.ts`、`copilot-run-input.db.test.ts`、`copilot_run.test.ts`。
- 富数据覆盖：6 个锚点前 pair + 10 个 future pair、同毫秒 dispatch_seq、late reply、25h
  pickup + 新 session、6 个 queued roots/5 个 post-anchor replies、chip、parentless legacy、
  cross-session parent、missing/empty/invalid/session-mismatch anchor。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、agent-control-plane/schema/partition/API client/
  capability/profile/draft-status audits 与 `git diff --check`：passed。
- 独立 initial review 找到 1 个 P1（reply 自身 seq 截断破坏 causal pair），已修；唯一
  verification review：P0/P1 均无。完整 `pnpm test` 未在本机运行，交 exact-head GitHub CI。

## Current queue

- YUK-596 保持 In Progress；PR #1150 只交 causal-history safety slice，不关整票。
- 合并 #1150 后下一独立 slice：durable liveness + stale reconciliation，共用 run observation 与
  deliberate-terminal predicate；先审 YUK-693 已交付 backlog cap，避免重复造轮子。
- 再后：in-loop stop → 约 30 条复杂对话 burn-in → owner LIGHT/FULL；Dock/UI 前必须重新
  design pre-flight。之后产品顺序 YUK-764 → 457 → 268 → 285 → 213。
- Linear 严格 active 86；排除 OpenCode YUK-813/YUK-831 后产品 active 84。

## Capture gate

- 搜索 `copilot causal history anchor session durable`、`future ask late reply history`、
  `durable liveness reconciliation stale nonterminal`；YUK-596 覆盖本轮与下一 slice，YUK-693
  已覆盖 backlog cap。独立 review 的 P1 已在本 PR 修复，P2 文档漂移也已同步；没有新的、
  去重后仍 actionable 的 follow-up，因此不新建 Linear issue。
