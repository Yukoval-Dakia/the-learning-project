# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-08
> **【Phase 1 F1 delivered on main via #1164 — main CI green; no deployment】**

## NOW

- **Architecture FULL Phase 1 F1 已交付 main。** YUK-847–849 把 Failure Learning
  竖切进 `practice`：capability-owned TaskSpecs、attempt-event subscription、稳定 job identity、
  两个 jobs、两个 concrete tools 与 author variant public operation 已收口；旧 knowledge /
  central 双轨与四处 producer raw enqueue 已删除。PR #1164 squash merge 为 `1e34a5e7`；
  独立 review 无 P0/P1，merge SHA 的 GitHub CI Gate run `31256157552` 全绿。YUK-847–849
  均 Done，F1 milestone 100%。
- **架构债基线真实下降。** dependency ratchet 从 `547 / 71 / 63` 收紧到
  `531 / 70 / 62`；prompt hash 保持，scoped unit 143/143、typecheck 与边界 audit 通过；
  merge 后 main CI 已真实执行 unit、两个 DB 分片、migration、build 与 audits。
- **Phase 0 仍已闭合。** YUK-840/841/842 Done；#1154 LIGHT evidence certification 已在 main。
  **不部署 combined image**；YUK-832 产品 gate 仍 HOLD。
- **YUK-832 仍 In Progress / HOLD。** r9 actual A01 已降 reference 成本并补齐失败记账，
  但 comparator timeout 仍 fail-closed；mock/本地 gate 不能关闭产品验收。FULL checkpoint
  仍挂 YUK-839。
- **YUK-842 production 仍为 observe。** 当前生产镜像与 #1159 证据未变；本轮无 enforce、
  无 #1154 combined deploy。
- **YUK-757 / YUK-596 transport 已交付**（durable subagent、Stop、reconcile 等）；产品内容
  gate 仍由 YUK-832–836 actual-output P1 约束。

## NEXT

1. **F1 代码线已关闭，不再重开实现。** 后续发布必须 worker-first：先注册两个 jobs 并让
   `practice.failure-learning-attempt@v1` bootstrap/active，再替换已删除 raw enqueue 的 app；
   否则 bootstrap 窗口内的 failure attempt 会漏投。
2. **本轮未部署。** 发布前核对 subscription checkpoint、transition-window census/backfill
   与 permanent-stage marker；代码 merge 不能替代 rollout 证据。
3. **不要部署 #1154 combined image**；YUK-832 保持 In Progress / product HOLD，直至
   owner 授权 actual-output / enforcement 证据或改判。
4. FULL checkpoint（YUK-839）仅在 owner 重新提升时执行；当前不增加 provider budget、
   不重复昂贵 A01。
5. FSRS 无界投影读（perf P2）与 docs 措辞 hygiene 不阻塞；需要时单独开 follow-up，
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
