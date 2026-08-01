# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-01
> **【YUK-757 已交付；YUK-596 active：durable liveness 后端 safety slice】**

## NOW

- **YUK-757 已 Done。** PR #1149 exact-head CI Gate `30706461286` 全绿后 squash
  merge 到 `main@54d9bf620cf74d07633d72233c90cb9763516643`；durable Copilot 已具备
  backstage subagent、前台子任务投影、redelivery repair 与失败恢复。
- **YUK-596 causal-history slice 已交付。** PR #1150 exact-head CI 全绿并 merge 到
  `main@915fd5d4fd32cdceebda310879c7fd0c0138e9e5`；durable pickup 固定读取 dispatch
  时的 `session_id + run_id` causal anchor。
- **当前推进 durable liveness + stale reconciliation 后端 safety slice。** 统一 Copilot
  terminal predicate 与通用 pg-boss observation；`FAILED(reason='error')` 保持 retry frame，
  其它 FAILED fail-closed terminal。`copilot_run` 加 30s queue heartbeat；每分钟 fast
  singleton 有界扫 20 个 outstanding run，零 model/tool，只修 outcome marker、QUEUED-only
  queue-proven pre-execution loss，或已过 12min+30s 的 dead explicit/legacy-touch ambiguous
  execution；legacy `FAILED(error)` 绝不误给 checkpoint。
- 当前 scoped 验证：real Postgres/pg-boss **8 files / 68 tests**、unit **6 files / 65
  tests**、typecheck、lint、build 与相关 audits 已绿。**未在本机运行完整 `pnpm test`**；
  独立 initial review 的 1 个 P1（legacy retry frame 误给 checkpoint）已修；唯一
  verification review 无 P0/P1。还需 commit/push 与 exact-head GitHub `CI Gate`。
- Linear YUK-596 已现场核验为 In Progress；本 slice 不虚假关整票。最近全量快照仍是严格
  active 86 / 排除 owner parked OpenCode 后产品 active 84，待本 slice merge 后再刷新。

## NEXT

1. commit/push/PR 后以 exact-head GitHub `CI Gate` 执行完整 `pnpm test`，全绿即自主
   merge，并回写 YUK-596 evidence；不等待 advisory P2/minor checks。
2. 基于新 main 开独立 worktree推进 YUK-596 in-loop stop；复用当前 cancel/event seam，不把
   stop 误作纯 UI。
3. 跑约 30 条复杂、真实 provider 对话 burn-in，封存 exact revision、输入/输出 digest、
   task-run/provider/model/cost；mock 只测 seam，不能冒充 actual-output 产品验收。
4. Dock/UI 开工前按 design doc 逐字引用、声明 drawer、列文件并等 owner 批准；随后完成
   LIGHT/FULL owner gate。YUK-596 收口后按序推进 YUK-764 → 457 → 268 → 285 → 213。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；等待 Copilot 主产品链收口。
- future/refinement backlog 不自动扩实施范围；到达时先核证 live consumer、重复与过期项。

## BLOCKED-ON

- **YUK-596 当前 gate**：durable-liveness 独立 review + PR exact-head GitHub CI；本地 full
  `pnpm test` 禁止替代。
- **YUK-596 后续 owner gate**：后端安全、Stop 与 burn-in 完成后选择 LIGHT（推荐，保留模型
  自动分流）或 FULL（eligible freeform 全 durable + 更大 classifier/UX scope）。
- **YUK-571 / YUK-405 / YUK-406**：等待真实内容、首次 placement 与真实观察窗口；synthetic/
  mock 不能冒充 owner 验收。YUK-452 是 parent/epic，须按 children 现实对齐。
- **严格 issue=0**：84 条产品 active 中仍有 future、数据触发、生产 flip 与大 epic；最终需
  owner 做 keep/merge/cancel 裁决，不能靠连续写代码伪归零。
