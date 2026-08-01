# 当前 handoff — 2026-08-02 YUK-596 in-loop Stop 后端 safety slice

## Delivered before this lane

- YUK-757 / PR #1149 已在 exact-head CI 全绿后 merge 到
  `main@54d9bf620cf74d07633d72233c90cb9763516643`。
- YUK-596 causal-history / PR #1150 已 merge 到
  `main@915fd5d4fd32cdceebda310879c7fd0c0138e9e5`。
- YUK-596 durable liveness / PR #1151 已在 exact-head CI 全绿后 merge 到
  `main@c6dd37bfe5aaaae63d07a86bff69bd619a523b48`。

## Current implementation

- worktree：`/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-596-in-loop-stop`
- branch：`codex/yuk-596-in-loop-stop`
- base：`main@c6dd37bfe5aaaae63d07a86bff69bd619a523b48`
- 新 `POST /api/copilot/runs/{id}/cancel` 只接受 canonical durable acceptance；unknown 或
  tampered handle 返回 404。成功 contract 幂等区分 `cancel_requested`、`cancelled`、
  `already_requested`、`already_settled`。
- pre-fence Stop 在 dispatch lock 内写唯一 `CANCEL_REQUESTED + FAILED(cancelled)`；迟到
  worker 的 STARTED 和 execution fence 均被挡住。post-fence Stop 写 cooperative request，
  handler 用单调 latch + AbortController + 500ms non-overlap poll 观察。
- SDK async PreToolUse hook 在 spawn hook 之前阻止新工具；DomainTool `beforeExecute` 也 await
  同一取消 gate。执行 barrier 覆盖 tool run、tool-call log 与 mirrored event；Stop 后等待
  materializing tool settle，timeout/未知观察 fail-closed 为 ambiguous 且 `checkpoint_safe:false`。
- terminal settlement lock 让已提交 Stop 赢过迟到 success/failure；取消保留 partial text，
  但只有可证明无未决物化副作用时才暴露 checkpoint。
- nested AI tool 调用继承 `AbortSignal`；turn refresh/replay 保留 checkpoint safety。
- OpenAPI、generated API schema 与 Postman collection 已同步；没有 UI 代码改动。

## Verification evidence

- unit：3 files / **43 tests passed**：取消 poll/latch、async DomainTool gate/barrier、root runner
  中途 abort 与 partial failure logging。
- real DB：3 files / **67 tests passed**：pre/post-fence、四次并发 Stop、retry frame、marker-only、
  unknown/tampered handle、late STARTED race、纯文本 mid-flight Stop、materializing barrier、
  cancel-vs-success settlement race、checkpoint safety/refresh。
- fixture：48 条历史回答、6 个探针、3 份讲义、9 个迁移变式；mock 只覆盖 seam，事件与
  竞态另用真实 Postgres 验证。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` passed。
- API contract/client usage、schema、capability boundaries、agent control-plane、test partition audits passed；
  partition 的 2 个 unmatched 是 owner 指示忽略的 `.opencode` tests，3 个既有 P1 warning
  与本 diff 无关。
- generated API client 与 Postman 各连续生成两次 hash 一致。
- 完整 `pnpm test` 未在本机运行；只允许 push 后 exact-head GitHub CI。
- 独立 initial review：无 P0/P1。P2 advisory 是未来若把 barrier start callback 泛化为
  可抛异步逻辑，可用结构化 `finally` release；当前唯一同步调用者不抛，故不阻塞本 slice。
- GitHub initial advisory 找到 1 个当前有价值的 provenance P2：有 partial/result 的取消 marker
  原先使用 synthetic task-run ID。已改为优先保留真实 provider `task_run_id`，并在三条复杂
  handler 场景断言；修正后 real DB handler **41 tests**、typecheck、lint passed。CodeRabbit
  的 manifest 计数漂移同步修正；其余 future-only/trivial 建议不扩 scope。
- Linear YUK-596 保持 In Progress；duplicate search 命中本票及既有关联 Copilot tickets，
  未发现需要新建的 follow-up。实现/验证 evidence 已写入 comment
  `7ab24b80-dbdd-4d27-9e16-217d026202d6`。

## Current queue

- Linear capture gate 后 commit/push/open PR；exact-head CI 全绿即自主 merge。
- merge 后跑约 30 条真实 provider 复杂对话 burn-in；封存 exact revision、输入/输出 digest、
  task-run/provider/model/cost。
- Dock/UI 前执行 design pre-flight 并等待 owner 批准；之后才做 LIGHT/FULL gate。
- YUK-596 完整收口后顺序：YUK-764 → 457 → 268 → 285 → 213。
