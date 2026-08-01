# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-01
> **【YUK-805 已交付；NEXT YUK-757（等待 UI design pre-flight 批准）】**

## NOW

- **YUK-805 已 Done。** PR #1147 合并到
  `main@1989ac7fe42f091db37755a4d7052d65bbeadeae`：probe 判分现在把 judge
  invoker 的 authoritative `task_run_id` 持久化到
  `experimental:probe_result.event.task_run_id`，可经既有松耦合列连接
  `ai_task_runs` / `cost_ledger`，无需 migration 或 FK。
- conjecture runbook 已改为从 probe result 出发的 probe-only 成本查询，并按 currency
  分组；同时写明历史空关联、ledger best-effort 缺失、result 前付费失败等不可归因边界。
- 复杂 DB 数据同时包含同一 task/provider/model 的 probe 判分与普通练习判分，验证只归因
  probe 行；scoped DB 2 files / 48 tests、typecheck、lint、build 与相关 audits 全绿。
  两路独立 review 与 OCR 均无 P0/P1/actionable P2；exact-head CI Gate `30691440250`
  在 `761885ac` 全绿，合并后 main CI Gate `30691590064` 也全绿。
  **未在本机运行完整 `pnpm test`**。
- 2026-08-01 live Linear：Backlog 82、In Progress 4、Todo 1，严格未完成共 **87**；排除
  owner 指示 parked 的 OpenCode YUK-813 / YUK-831 后，当前产品执行口径 **85**。
  19 个 project 中 3 In Progress、2 Backlog、1 Planned、13 Completed。YUK-772 曾被
  closeout PR 自动回拨为 In Progress，已按合并与 CI 现实校正回 Done。

## NEXT

1. 下一独立产品 lane 是 **YUK-757**（当前唯一 Todo）：对齐 copilot backstage spawn、
   前台子任务可见与 durable 衔接。该票含 UI；写任何 UI 代码前必须提交 design doc
   逐字引用、组件类型与精确文件清单并等待 owner 批准。
2. 获批后在隔离 worktree 以最小充分范围实施；mock 可用，但题目、运行链和状态组合必须
   足够复杂真实。只跑 scoped 本地验证，完整 `pnpm test` 留给 exact-head GitHub CI。
3. YUK-757 后继续按产品 backlog/Todo 顺序核证；重复、过期或无 live consumer 的项先
   对齐 Linear 再 Canceled / Duplicate，不为归零重复造轮子。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；不与当前产品 reliability lane 混跑。
- 其余 future/refinement backlog 不自动开 implementation lane，先做 owner scope triage。

## BLOCKED-ON

- **YUK-757 UI 实施**：等待 owner 对本轮 design pre-flight 的明确批准；批准前不写 UI。
- **无人值守 auto-intervention expansion**：YUK-814 的 issue-status waiver 不等于生产
  rollout 授权；未来翻 flag 仍须 owner 明示与届时认可的 actual-product-output evidence。
- **YUK-571 / YUK-405 / YUK-406**：等待 owner 真实内容、首次 placement 与观察窗口；agent
  不代答、不把 synthetic/mock 伪装成真实 owner 验收。
- **YUK-452**：parent/epic，须先对齐未完成 children，不能用单条代码变更直接关单。
- **严格 issue=0**：每次只推进一条 active 产品线；OpenCode parked 不等于已完成。
