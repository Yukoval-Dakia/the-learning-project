# 当前 handoff — 2026-08-10 YUK-858 Memory reconcile handoff

## NOW

- Base/main 为 YUK-857 merge `3d3c89c5`（PR #1174）；未部署。
- YUK-858 PR #1175 current head 已含实现与 CI repairs，并已 committed/pushed：Mem0 exact event lookup、
  lookup-before-add、opaque operation-kind provider-start fence、post-reserve event v1 add marker、
  completion/intents/dispatch completion、exact deterministic pg-boss UUID/readback、append-only
  recovery cursor、strict 四模式和 bounded wrap hourly recovery 第二 leg。
- 没有新表、migration、generic handoff core 或 cron；所有 handoff event 均设置 `ingest_at`。
- 最新 prior exact-head CI 暴露的 PostgreSQL strict-shape query、trigger mock、audit caller
  evidence 与 Map assertion 缺陷已修；owner 禁止本地 runtime gates，只允许 scoped Biome
  与 diff inspection。Fresh current-head CI 尚未证明 green。

## NEXT

1. 等待 fresh current-head CI 验证 tests/typecheck/build/audits。
2. 确认无 unresolved P0/P1 review findings 后 merge；P2/minor/nit/refactor 不阻塞。
3. 完整执行 Linear capture gate：duplicate search、actionable follow-up 处理、YUK-858 issue
   status calibration；生产 rollout 另行授权。

## PARKED

- Rollout `observe -> write -> recover`；rollback `recover -> drain -> observe`。
- YUK-832 HOLD、YUK-842 observe 与 F2.3–F4 均不变。

## BLOCKED-ON

- Delivery：fresh current-head CI、无 unresolved P0/P1 review findings、merge、完整 Linear capture gate。
- Production：无部署授权或真实观察证据。
