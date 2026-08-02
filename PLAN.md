# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-02
> **【YUK-841 active：Architecture Deepening FULL / F0-2】**

## NOW

- **Owner 已明确「直接启动 FULL」，并要求 gate 不在本地跑。** F0 串行依赖保持
  YUK-840 → YUK-841 → YUK-842；所有验证只接受 exact-head GitHub CI。
- **YUK-840 已 Done。** PR #1155 merged，main commit
  `24add632b8941d0e4ebfeddb337761e7a1e38c29`；dependency ratchet 与 ADR-0051 已交付。
- **YUK-841 In Review，PR #1156。** 独立 worktree
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-841-attempt-cost-truth`，branch
  `codex/yuk-841-attempt-cost-truth`，base `origin/main@24add632`。
- 当前实现把 SDK terminal evidence 先于 success/error 分类捕获，并用一个
  `AttemptCostTruth(reported | estimated | unknown)` 投影到 result、`ai_task_runs` 与唯一 attempt
  ledger；run terminal update + ledger insert 共用 transaction，stuck reconcile 走同一 finalizer。
- schema/migration、admin run/detail/cost、`/api/cost/today`、Postman 与 generated API client 已同步；
  历史与非 runner ledger 保持显式 `legacy`，unknown amount 为 NULL 且不进入金额 SUM。
- 本轮仅做了代码编辑、只读检查、生成器和 formatter；**未运行任何本地 test/typecheck/lint/
  build/audit gate**。PR 的前一 exact-head 已由 GitHub CI 全绿；合并前 review 发现 success
  settlement fail-open 会破坏 attempt 单一真相，当前已改为 fail-closed 并补普通/流式反证测试，
  新 head 仍须重新通过远端 CI。三路独立只读 review 均无其它未解决 P0/P1。
- **YUK-596 transport/Stop 与 actual burn-in 证据保持已交付；产品内容仍 HOLD。** YUK-832–836
  没有取消或完成，只因 owner 切换 active 主线而暂停。

## NEXT

1. 提交并推送 PR #1156 的 success-settlement fail-closed 修复；只由 exact-head GitHub CI 执行
   migration/unit/DB/typecheck/lint/build/audit gates。
2. CI 绿且无未解决 P0/P1 后 merge，将 YUK-841 标 Done。
3. 从合并后的 main 新建独立 worktree 启动 YUK-842 provider-lane admission；共享 schema/runtime lane
   不并行。
4. F0 全部通过后，按 execution addendum 建 Phase 1 milestone/issues，迁 practice-owned
   failure-learning vertical；必须删除旧 knowledge/central handler/tool 双轨。

## PARKED

- YUK-841 明确非目标：真实合同价格校准、UI、OCR/GLM 等非 `AiRunLifecycle` writer 全面迁移。
  placeholder price 只能标 estimated，不能用于预算可信声明。
- 产品级 `cost_usd ?? 0` 聚合与 UI 的 null→$0 展示仍是后续 operation/UI debt；本票只承诺
  model-attempt truth，不扩写成 product-operation cost truth；operation 传播已捕获为 YUK-844。
- stuck-run reconciler 的单行结算异常隔离为 P2 可用性 follow-up，已捕获为 YUK-843。
- **YUK-832–836 actual-output P1**：保留原优先级与证据，FULL active 期间暂停，不用架构 gate
  冒充产品质量 gate。
- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；等待 active 主线重新排期。

## BLOCKED-ON

- **YUK-842** blocked by YUK-841；Phase 1 blocked by F0 exact-head completion 与一个真实 provider
  observation。
- FULL 不触 UI；未来任何 UI 工作仍须 design-doc 逐字引用、组件类型与文件清单 pre-flight，
  owner 批准前不得写 UI。
- **YUK-571 / YUK-405 / YUK-406** 仍等待真实内容、首次 placement 与 owner 观察窗口；
  synthetic/mock 不能冒充验收。
- 严格 issue=0 仍含 future、数据触发、生产 flip 与大 epic；不能靠连续写代码伪归零。
