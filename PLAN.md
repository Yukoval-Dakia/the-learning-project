# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-01
> **【YUK-772 已交付；NEXT YUK-805】**

## NOW

- **YUK-772 已 Done。** PR #1145 合并到
  `main@dca5a0ec0585398ce120a144c7612ce890ecc827`：KnownEvent 的 9 个 user-capable
  kind 现在经共享策略在 public member parser 与 union 两层 fail-closed
  （`actor_kind='user' ⇒ actor_ref='self'`）；6 个 agent-only 与 3 个 mixed agent lane
  不变。experimental workflow/source provenance refs 明确留在本票外，等待独立迁移。
- `JUDGE_PROVENANCE_SECRET` 长度 `<32` 现在 loud log + null；unset/empty 仍静默，
  与 `INTERNAL_TOKEN` 相等仍 fail-closed，日志不泄密。单写和 valid-prefix + invalid-tail
  batch 都验证在 parse barrier 前整体零写入。
- 复杂古文学习数据的 event-schema 209 项、相关 DB 110 项、provenance consumer DB
  72 项，以及 typecheck、lint、audit、build 全绿；独立 review 无 P0/P1。PR exact-head
  CI Gate `30689854960` 在 `1a501ce5` 全绿，合并后 main CI Gate `30690217136` 也全绿；
  3 条 review thread 均已回复并 resolve。
  **未在本机运行完整 `pnpm test`**；无 UI、部署、migration、feature flag 或付费调用。
- 2026-08-01 live Linear：Backlog 83、In Progress 4、Todo 1，严格未完成共 **88**；排除
  owner 指示 parked 的 OpenCode YUK-813 / YUK-831 后，当前产品执行口径 **86**。
  19 个 project 中 3 In Progress、2 Backlog、1 Planned、13 Completed。

## NEXT

1. 下一独立产品 lane 启动 **YUK-805**：先验证 judge invoker 是否已暴露 authoritative
   `task_run_id`；若已暴露，用现有 event 列把 probe result 连到 cost ledger，补复杂 DB
   回归并把 conjecture runbook 从“全部 judge 上界”改为真·probe 专属查询，无 migration。
2. 若 invoker 未暴露 run id，YUK-805 会从最小透传变成公共 invoker 契约扩张，按票面约束
   回 owner 过目；否则 scoped validation、独立 review、exact-head GitHub CI 后自主合并。
3. YUK-805 后继续处置产品 backlog/Todo；YUK-757 含前台子任务 UI，进入实施前必须走
   design pre-flight。重复、过期或无 live consumer 的项先核证再 Canceled / Duplicate。

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
