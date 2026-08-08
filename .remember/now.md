# 当前 handoff — 2026-08-08 Failure Learning F1 delivery closeout

## Owner direction and tracker

- 硬约束：完整 gate 只认 exact-head GitHub CI；本机不做 full `pnpm test`。
- Linear：`Architecture Deepening FULL — 语义、成本与运行所有权`。
- F0 实现：YUK-840/841/842 Done；PR #1154 已在 main。
- F1 已交付：YUK-847–849 Done，milestone 100%；PR #1164 squash merge 为 `1e34a5e7`，
  三轴 independent review 无 P0/P1，merge SHA 的 CI Gate run `31256157552` 全绿；未 deploy。
- **YUK-832 产品 gate 仍 HOLD / In Progress**——不部署 combined image、不 flip enforce。

## Delivered on main

- `practice` 接管 Failure Learning TaskSpecs、attribution/variant product operations、durable
  jobs、attempt-event subscription 与两个 concrete tools；author variant 只走窄 public operation。
- producers 只提交 attempt fact；`attribution_followup` / `variant_gen` payload 保持兼容，job id
  改为 queue + attempt + contract version 的稳定 UUID。
- 旧 knowledge attribution job/implementation、中央 variant handler 与中央双工具实现已删除。
- exact effective cause event 成为 proposal causal parent；invalid model output 永久失败，不重烧。
- dependency ratchet：`547 / 71 / 63` → `531 / 70 / 62`。
- scoped unit 143/143、typecheck、capability-boundary audit 通过；merge 后 main CI 已执行 unit、
  两个 DB 分片、migration、build 与 audits，全部成功。

## Production state (unchanged this turn)

- app/worker 仍为 #1159 observe 镜像证据链；本轮 **未** 部署 F1 或 #1154 combined image。
- Postgres/tunnel 未因本轮变更而动。

## YUK-832 gate (still HOLD)

- LIGHT 降 reference 成本 + 失败记账已在代码与 r9 artifact 中；comparator timeout 仍
  fail-closed → 产品不放行。
- FULL checkpoint = YUK-839（parked）。
- 下一 session：**不要**再开 #1154 或重做 F1；要么等 owner 对 YUK-832/839 的产品裁决，
  要么在明确发布任务中按 worker-first 顺序 rollout；UI 仍须先 design pre-flight。

## Delivery boundary

- F1 已进入 main，merge commit `1e34a5e7` 的 exact-head CI 全绿；这是代码交付，不是生产发布。
- 后续 deployment 必须 worker-first，确认 subscription bootstrap/active 后再替 app；本轮不部署。
- 不打印/不轮换任何已暴露凭据（YUK-846 另跟）。
