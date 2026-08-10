# 当前 handoff — 2026-08-10 YUK-858 Memory reconcile handoff

## NOW

- Base/main 为 YUK-857 merge `3d3c89c5`（PR #1174）；未部署。
- YUK-858 在 `codex/yuk-858-memory-reconcile-handoff` 完成未提交实现：Mem0 exact event lookup、
  lookup-before-add、opaque operation-kind provider-start fence、post-reserve event v1 add marker、
  completion/intents/dispatch completion、exact deterministic pg-boss UUID/readback、append-only
  recovery cursor、strict 四模式和 bounded wrap hourly recovery 第二 leg。
- 没有新表、migration、generic handoff core 或 cron；所有 handoff event 均设置 `ingest_at`。
- Owner 禁止 runtime gates；只允许 scoped Biome 与 diff inspection。

## NEXT

1. 独立 review diff，随后 commit/push。
2. 只用 future exact-head CI 验证 tests/typecheck/build/audits。
3. clean 后 merge/Linear sync；生产 rollout 另行授权。

## PARKED

- Rollout `observe -> write -> recover`；rollback `recover -> drain -> observe`。
- YUK-832 HOLD、YUK-842 observe 与 F2.3–F4 均不变。

## BLOCKED-ON

- Delivery：commit/push、exact-head CI、independent review、Linear sync。
- Production：无部署授权或真实观察证据。
