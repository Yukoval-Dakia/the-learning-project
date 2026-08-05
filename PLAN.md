# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-05
> **【PR #1154 MERGED — Phase 0 code closed; YUK-832 product HOLD】**

## NOW

- **PR #1154 已 merge 到 main**（squash `effbc1c317`，2026-08-05）。main 的
  `required_linear_history` 禁止 ordinary merge commit，故 GitHub 侧用 squash 落地；
  feature branch 上曾用 ordinary merge 吸收 YUK-842 lifecycle。exact-head CI Gate 全绿；
  review threads 已 resolve（P1 修码 / defensible 回复 / P2 skip rationale）。
- **Architecture FULL Phase 0 实现闭合。** YUK-840/841/842 Done；#1154 把 LIGHT
  evidence certification（sealed blind/comparator/fail-closed + observed-usage lower
  bound + deadline 透传）合入 main。**不部署 combined image**；YUK-832 产品 gate 仍 HOLD。
- **YUK-832 仍 In Progress / HOLD。** r9 actual A01 已降 reference 成本并补齐失败记账，
  但 comparator timeout 仍 fail-closed；mock/本地 gate 不能关闭产品验收。FULL checkpoint
  仍挂 YUK-839。
- **YUK-842 production 仍为 observe。** 当前生产镜像与 #1159 证据未变；本轮无 enforce、
  无 #1154 combined deploy。
- **YUK-757 / YUK-596 transport 已交付**（durable subagent、Stop、reconcile 等）；产品内容
  gate 仍由 YUK-832–836 actual-output P1 约束。

## NEXT

1. **不要部署 #1154 combined image**；YUK-832 保持 In Progress / product HOLD，直至
   owner 授权 actual-output / enforcement 证据或改判。
2. **Phase 0 代码已闭 → 启动 Phase 1 前先对齐**：practice-owned failure-learning
   vertical；任何 UI 仍需独立 design pre-flight + owner 批准。
3. FULL checkpoint（YUK-839）仅在 owner 重新提升时执行；当前不增加 provider budget、
   不重复昂贵 A01。
4. FSRS 无界投影读（perf P2）与 docs 措辞 hygiene 不阻塞；需要时单独开 follow-up，
   不塞回 YUK-832 产品 gate。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；等待 Copilot 主产品链收口。
- **YUK-839 FULL checkpoint**：owner 已批准挂单；r9 comparator timeout 保留实施理由。
- future/refinement backlog 不自动扩实施范围；到达时先核证 live consumer、重复与过期项。

## BLOCKED-ON

- **YUK-832 产品 gate**：LIGHT 代码已在 main，但 actual comparator timeout 仍 fail-closed；
  产品 HOLD。下一决定性解锁是 YUK-839 跨 attempt checkpoint（owner 挂单）或新的
  actual-output 授权，不是再 merge 代码。
- **YUK-596 产品 gate**：YUK-832–836 actual-output P1；transport/Stop pass 不能替代内容
  正确性。
- **YUK-596 后续 owner gate**：产品 P1 与 actual rerun 完成后，先做 UI design pre-flight；
  owner 批准前不写 UI，也不翻 durable-default 扩量。
- **YUK-571 / YUK-405 / YUK-406**：等待真实内容、首次 placement 与真实观察窗口。
- **严格 issue=0**：仍含 future、数据触发、生产 flip 与大 epic；需 owner keep/merge/cancel。
