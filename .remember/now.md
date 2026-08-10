# 当前 handoff — 2026-08-10 YUK-860 SDK terminal adaptation

## NOW

- Base/main 为 YUK-861 merge `f84fe3bc44d4e56c4143daf3f382d8ec757c454e`；未部署。
- YUK-858 exact-head CI
  `31362608190` green，未部署。Mem0 exact event lookup、
  lookup-before-add、opaque operation-kind provider-start fence、post-reserve event v1 add marker、
  completion/intents/dispatch completion、exact deterministic pg-boss UUID/readback、append-only
  recovery cursor、strict 四模式和 bounded wrap hourly recovery 第二 leg。
- 没有新表、migration、generic handoff core 或 cron；Memory handoff event 均设置 `ingest_at`，
  避免重新进入 Memory ingest。
- YUK-861 NO-GO docs 已随 squash `f84fe3bc` 合并 main：Verify transactional outbox、Notes post-commit singleton/readback、Memory batch
  digest/cursor/fail-closed receipt 不构成一个可经济抽取的 shared protocol；callback workflow shell
  明确拒绝，协议保持 owner-local（ADR-0052）；Linear 已取消为 not justified。
- YUK-860 已完成作者态：`sdk-terminal.ts` 统一 SDK assistant usage/thinking 累加与 result
  terminal evidence，result usage authoritative，缺失时才 fallback；三个 runner lifecycle 各自持有 collector，
  caller retry/abort/partial/settlement/tool logging policy 未改变。已进入 PR delivery；fresh exact-head
  CI、独立 review 与 merge 待执行，未部署。
- 生产边界不变：YUK-832 HOLD；YUK-842 production observe。

## NEXT

1. 以 exact-head GitHub CI 与独立 review 收口 YUK-860；本地 runtime gates 未运行。
2. YUK-858 rollout 另行授权，顺序 `observe -> write -> recover`；rollback `recover -> drain -> observe`。
3. generic core 只有 ADR-0052 Future reopen gates 全满足才可重开；继续执行 Linear capture gate。

## PARKED

- YUK-832 HOLD、YUK-842 observe 与生产未部署均不变。
- F2.3 / YUK-861 已 NO-GO；F2.5–F4 保持 open。

## BLOCKED-ON

- YUK-860 delivery：fresh exact-head GitHub CI、独立 review 与 merge。
- Production：无部署授权或真实观察证据。
