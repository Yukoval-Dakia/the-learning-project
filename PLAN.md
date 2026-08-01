# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-02
> **【YUK-596 active：in-loop Stop 后端 safety slice】**

## NOW

- **YUK-757 已 Done。** PR #1149 exact-head CI 全绿后 merge 到
  `main@54d9bf620cf74d07633d72233c90cb9763516643`；durable Copilot 已具备
  backstage subagent、前台子任务投影、redelivery repair 与失败恢复。
- **YUK-596 causal-history 与 liveness 已交付。** PR #1150 merge 到
  `main@915fd5d4fd32cdceebda310879c7fd0c0138e9e5`；PR #1151 exact-head CI 全绿后
  merge 到 `main@c6dd37bfe5aaaae63d07a86bff69bd619a523b48`。durable pickup 已绑定 causal
  anchor，并具备 queue heartbeat、stale reconciliation 与 fail-closed ambiguous recovery。
- **当前实施 in-loop Stop 后端。** 新增 `POST /api/copilot/runs/{id}/cancel`；pre-fence Stop
  原子收敛，post-fence Stop cooperative abort；dispatch/settlement lock 处理迟到 worker、
  重复点击及 cancel-vs-terminal 竞态。SDK PreToolUse 与 DomainTool async gate 共用单调取消
  latch；materializing tool barrier 覆盖执行、日志和事件镜像，无法证明安全时禁用 checkpoint。
- 复杂 fixture 使用 48 条历史回答、6 个探针、3 份讲义、9 个迁移变式。当前 scoped
  验证：unit **3 files / 43 tests**、real DB **3 files / 67 tests**、typecheck、lint、build、
  API contract/client generation、schema/capability/control-plane/partition audits 已绿。未在本机运行
  完整 `pnpm test`；完整 suite 只交 exact-head GitHub CI。
- 独立 initial review 无 P0/P1；唯一 P2 是未来异步 barrier callback 的结构化 `finally`
  hardening，当前唯一同步调用者安全，按 review budget 不阻塞、不扩 scope。
- GitHub initial advisory 的实际 provenance P2 已收口：有结果的 cancelled reply 继续引用真实
  provider `task_run_id`；同时修正 nested AGENTS 的 manifest 计数。修正后 handler real DB
  **41 tests**、typecheck、lint 已绿；其它 future-only/trivial 建议按理由跳过。
- PR #1152 的迟到 review 又发现 pre-fence Stop 只写 job terminal、会让下一轮历史留下 phantom
  user ask。已把 cancellation reply marker 泛化为 API/worker 共用，并用真实 Postgres 验证下一轮
  causal history 含“已停止”回复。旧 head 两组 CI 虽全绿，但已作废，必须重跑新 exact head。

## NEXT

1. Commit/push PR #1152 的 pre-fence history 修复；新 exact-head GitHub `CI Gate`
   与手动 full workflow 全绿后自主 merge。
2. 基于 merge 后 revision 跑约 30 条复杂真实 provider 对话 burn-in，封存输入/输出 digest、
   task-run/provider/model/cost；mock 只验证 seam，不冒充 actual-output 产品验收。
3. Dock/UI 开工前逐字引用 design doc、声明 drawer、列文件并等待 owner 批准；完成后再做
   LIGHT/FULL owner gate。YUK-596 收口后按序推进 YUK-764 → 457 → 268 → 285 → 213。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；等待 Copilot 主产品链收口。
- future/refinement backlog 不自动扩实施范围；到达时先核证 live consumer、重复与过期项。

## BLOCKED-ON

- **YUK-596 当前 gate**：Stop 后端 PR 的 exact-head GitHub CI；本地 full `pnpm test` 禁止替代。
- **YUK-596 后续 owner gate**：后端安全、Stop 与真实 burn-in 完成后选择 LIGHT（推荐，保留
  模型自动分流）或 FULL（eligible freeform 全 durable + 更大 classifier/UX scope）。
- **YUK-571 / YUK-405 / YUK-406**：等待真实内容、首次 placement 与真实观察窗口；synthetic/
  mock 不能冒充 owner 验收。YUK-452 是 parent/epic，须按 children 现实对齐。
- **严格 issue=0**：仍含 future、数据触发、生产 flip 与大 epic；最终需 owner 做
  keep/merge/cancel 裁决，不能靠连续写代码伪归零。
