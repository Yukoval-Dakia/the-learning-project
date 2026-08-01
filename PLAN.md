# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-01
> **【YUK-757 已交付；YUK-596 active：causal-history PR #1150】**

## NOW

- **YUK-757 已 Done。** PR #1149 exact-head CI Gate `30706461286` 全绿后 squash
  merge 到 `main@54d9bf620cf74d07633d72233c90cb9763516643`；durable Copilot 已具备
  backstage subagent、前台子任务投影、redelivery repair 与失败恢复。
- **YUK-596 当前只推进第一个后端安全 slice：causal history anchor。** PR #1150
  (`codex/yuk-596-causal-history`) 让 worker 固定读取 dispatch 时的 `session_id + run_id`
  anchor；future roots/replies 先于 LIMIT 被排除，旧根的 late reply 保留，并按 causal root
  成组排序。inline 与 `/api/copilot/turns` 保持原 reusable-session reader。
- 本地 scoped real-Postgres 3 files / 68 tests、typecheck、lint、build 与相关 audits 已绿；
  独立 initial review 的 1 个 P1 已修，唯一 verification review 无 P0/P1。
  **未在本机运行完整 `pnpm test`**；等待 PR #1150 exact-head GitHub `CI Gate`。
- Linear 快照：严格 active **86**；排除 owner 指示 parked 的 OpenCode YUK-813 / YUK-831
  后，产品 active **84**。YUK-596 保持 In Progress，不用本 slice 虚假关单。

## NEXT

1. PR #1150 exact-head CI 全绿且无未裁决 P0/P1后自主 merge，并把 merge/CI evidence 回写
   YUK-596；不等待 advisory P2/minor checks。
2. 基于新 main 开独立 worktree，推进 YUK-596 第二个后端 slice：统一 durable run
   observation/terminal predicate，区分 healthy busy/backlog/unavailable，并只 reconcile 有充分
   证据的 stale nonterminal；复用 YUK-693 已有 backlog cap，不另造重复子系统。
3. 后端 liveness 收口后再做 in-loop stop 与约 30 条复杂对话 burn-in；随后才进入 owner
   LIGHT/FULL 决策。任何 Dock/UI 实施仍须先做 design pre-flight 并等待批准。
4. YUK-596 完整收口后按顺序推进 YUK-764 → YUK-457 → YUK-268 → YUK-285 → YUK-213。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；等待 Copilot 主产品链收口。
- future/refinement backlog 不自动扩实施范围；到达时先核证 live consumer、重复与过期项。

## BLOCKED-ON

- **YUK-596 当前 gate**：PR #1150 exact-head GitHub CI；本地 full `pnpm test` 禁止替代。
- **YUK-596 后续 owner gate**：后端安全、Stop 与 burn-in 完成后选择 LIGHT（推荐，保留模型
  自动分流）或 FULL（eligible freeform 全 durable + 更大 classifier/UX scope）。
- **YUK-571 / YUK-405 / YUK-406**：等待真实内容、首次 placement 与真实观察窗口；synthetic/
  mock 不能冒充 owner 验收。YUK-452 是 parent/epic，须按 children 现实对齐。
- **严格 issue=0**：84 条产品 active 中仍有 future、数据触发、生产 flip 与大 epic；最终需
  owner 做 keep/merge/cancel 裁决，不能靠连续写代码伪归零。
