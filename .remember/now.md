# 当前 handoff — 2026-08-01 YUK-772 已交付，NEXT YUK-805

## Delivered

- YUK-772 / PR #1145 已合并：
  `main@dca5a0ec0585398ce120a144c7612ce890ecc827`；Linear 已自动 Done，并已有 PR、
  merge、exact-head CI 与收口评论 evidence。
- 15 个 KnownEvent kind 已逐项盘点。9 个 user-capable kind 通过同一策略同时保护
  public member parsers 与 KnownEvent union；任何 stable user/non-self ref 都指向
  `actor_ref` fail-closed。6 个 agent-only + Attempt/GenerateKnowledgeEdge/CorrectEvent
  三个 mixed agent lane 保持原语义。
- experimental refs（`owner`、`user:self`、`block_import`、editor/workflow provenance 等）
  仍按当前持久化契约解析；收紧它们需要独立 migration，不在 YUK-772 偷渡。多用户方向
  已由 YUK-767 承接，capture gate 未重复开票。
- `judgeProvenanceSigningSecret()` 现在按原始字符串长度拒绝 `<32`，先于
  INTERNAL_TOKEN equality 检查；不 trim/normalize、不打印 secret，合法 32/64 字符原样返回。

## Verification evidence

- author scoped unit：event schema 16 files / 209 tests；最终 actor/Correct/secret 聚焦
  3 files / 46 tests。相关 event/writer DB 5 files / 110 tests；advice/submit provenance
  consumer DB 2 files / 72 tests。数据覆盖复杂古文作答、FSRS、artifact/edge/judge/OCR，
  以及单写和 valid-prefix + invalid-tail batch 零写入。
- `pnpm audit:partition`、`pnpm audit:schema`、`pnpm audit:capability-boundaries`、
  `pnpm typecheck`、`pnpm lint`、`pnpm build`：passed。
- 独立 initial review 对完整工作树无 P0/P1、无 actionable P2；无 verification round。
- PR exact-head CI Gate `30689854960` 在 `1a501ce5` 全绿：unit、DB 2/2、migration、
  production build、static/audits、usability 均成功。3 个 review threads 已按证据回复并
  resolve；其中 1 个 Major 是忽略 `fatal:false` 的不可复现误报，2 个 minor 按 policy
  保留为 advisory。
- 合并后 `main@dca5a0ec` CI Gate `30690217136` 全绿。
- 未在本机运行完整 `pnpm test`；本 lane 不部署、不改 flag、不触发真实付费模型。

## Current queue

- 2026-08-01 live Linear：Backlog 83、In Progress 4、Todo 1，严格未完成 **88**；排除
  owner 指示 parked 的 YUK-813 / YUK-831 OpenCode 后，产品执行口径 **86**。
- live projects 共 19：3 In Progress、2 Backlog、1 Planned、13 Completed。
- 下一条独立产品 lane：YUK-805。先核验 judge invoker 是否回传 authoritative run id；
  若是，最小透传到 `experimental:probe_result.event.task_run_id`，用现有松耦合列连接
  cost ledger，并把 runbook 查询收紧为 probe-only。若不是，公共 invoker 契约扩张前
  回 owner 过目。
- 次选 YUK-757，但包含 UI，须重新走 design pre-flight；YUK-571 / YUK-405 / YUK-406
  等待真实 owner 输入，YUK-452 是 parent/epic。

## Worktrees

- YUK-772 functional + closeout worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-772-actor-ref-gate`。
- functional branch `codex/yuk-772-actor-ref-gate` 已由 PR #1145 squash merge；当前 worktree
  已切到 `codex/yuk-772-closeout`，基于 `main@dca5a0ec`。
- primary repo 的既有 unrelated dirty/conflict 未触碰；未强删任何 worktree 或 branch。

## Capture gate

- YUK-772 已有实现、review、CI、merge evidence；搜索 `actor_ref experimental multi-user
  migration` 并筛除无关语义噪声后，相关命中仅有本票和既有 YUK-767。本次无新增、
  去重后的 actionable follow-up，因此未新建 Linear issue。
