# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-10

## NOW

- **F2.1 / YUK-857 已合并 main。** PR #1174 merge SHA `3d3c89c5`；Notes append-only
  handoff、deterministic dispatch/readback 与 shared recovery floor 已进入主线。未部署。
- **F2.2 / YUK-858 已合并 main。** PR #1175 merge SHA `136faec8224c0f0136532c748aea1bbc689ca7b7`；
  exact-head CI `31362608190` green。Memory-owned event v1
  fenced provider-start 后置 add marker、ingest completion/intents、exact deterministic
  dispatch/readback、append-only recovery cursor + bounded wrap scan 第二 leg 与 strict
  `observe|write|recover|drain` 模式已实现；没有 table/migration/new cron。
- **F2.3 / YUK-861 NO-GO docs 已合并 main。** squash `f84fe3bc`；Verify transactional outbox、Notes post-commit
  singleton/readback、Memory batch digest/cursor/fail-closed receipt 差异过大；协议保持 owner-local，
  callback workflow shell 明确拒绝。详见 ADR-0052；Linear 已取消为 not justified。
- **F2.4 / YUK-860 SDK terminal adaptation 已完成作者态。** 新 pure collector 统一 assistant
  usage/thinking 累加与 result terminal evidence；`runTask` 每次 retry、`streamTask`、
  `streamTaskCollecting` 均为 lifecycle-local 实例。已进入 PR delivery；fresh exact-head CI、独立 review
  与 merge 待执行，未部署。
- **生产边界不变：** YUK-858 未部署；YUK-832 HOLD 与 YUK-842 observe 未改变。

## NEXT

1. 以 exact-head GitHub CI 与独立 review 收口 YUK-860；不改变 caller 的 retry、abort、partial、
   settlement 或 logging policy。
2. YUK-858 rollout 仍需独立授权与真实观察证据，顺序 `observe -> write -> recover`；回滚为
   `recover -> drain -> observe`。
3. 继续执行 Linear capture gate；generic handoff core 只有 ADR-0052 Future gates 全满足才可重开。

## PARKED

- Production rollout / observation 需独立授权。
- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- F2.3 结案为 YUK-861 NO-GO；F2.5–F4 保持 open，不并入 YUK-858。

## BLOCKED-ON

- Production blocked on独立部署授权和真实观察证据。
- YUK-860 delivery blocked on fresh exact-head GitHub CI、独立 review 与 merge。
