# 当前 handoff — 2026-08-10 YUK-861 NO-GO architecture closeout

## NOW

- Base/main 为 YUK-858 merge `136faec8224c0f0136532c748aea1bbc689ca7b7`（PR #1175）；未部署。
- YUK-858 exact-head CI
  `31362608190` green，未部署。Mem0 exact event lookup、
  lookup-before-add、opaque operation-kind provider-start fence、post-reserve event v1 add marker、
  completion/intents/dispatch completion、exact deterministic pg-boss UUID/readback、append-only
  recovery cursor、strict 四模式和 bounded wrap hourly recovery 第二 leg。
- 没有新表、migration、generic handoff core 或 cron；所有 handoff event 均设置 `ingest_at`。
- YUK-861 架构结论为 NO-GO：Verify transactional outbox、Notes post-commit singleton/readback、Memory batch
  digest/cursor/fail-closed receipt 不构成一个可经济抽取的 shared protocol；callback workflow shell
  明确拒绝，协议保持 owner-local（ADR-0052）；Linear closeout 在 docs 交付合并后执行。
- 生产边界不变：YUK-832 HOLD；YUK-842 production observe。

## NEXT

1. 以 exact-head GitHub CI、独立 review 和 merge 收口 YUK-861 docs-only 交付，再把 Linear
   YUK-861 关闭为 not justified。
2. F2.4 / YUK-860 为下一实现 lane；Linear 当前 scope 已核验为统一 Agent SDK terminal evidence
   adaptation，且独立于 F2.3，不重开 durable handoff 抽象。
3. YUK-858 rollout 另行授权，顺序 `observe -> write -> recover`；rollback `recover -> drain -> observe`。
4. generic core 只有 ADR-0052 Future reopen gates 全满足才可重开；继续执行 Linear capture gate。

## PARKED

- YUK-832 HOLD、YUK-842 observe 与生产未部署均不变。
- F2.3 / YUK-861 已 NO-GO；F2.5–F4 保持 open。

## BLOCKED-ON

- YUK-861 docs delivery：exact-head GitHub CI、独立 review 与 merge。
- Production：无部署授权或真实观察证据。
