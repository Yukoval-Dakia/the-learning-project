# 当前 handoff — 2026-08-09 YUK-851 PR-prep

## Current truth

- **F0.0 / YUK-850 已在 main 交付：**PR #1166 squash main SHA
  `e93bf52f7a7edc47273e8e18638701ec1a101dbf`；exact-main CI Gate `31269934370`、CodeQL
  `31269934284`、Rust parity `31269934338` 成功；**未部署。** 审计覆盖六条 live direct provider
  lanes 与一条 prune，10 findings / 0 violations；只删除 unreachable misconception reconcile runtime/tests，
  保留历史 schema/migrations/export/reset tests。基线 `530 / 70 / 62`。
- **F0.1 / YUK-851 是当前 active 线：**`codex/yuk-851-provider-attempt` 本地 code-complete，Linear
  In Progress，PR/merge 未完成。实现独立 `provider_attempt` / `provider_attempt_admission`、中性
  `ProviderAttemptLifecycle` 与 schema `4.18`；无 caller migration，未动 provider_session、runner 或
  cost ledger，**未部署。**
- 本地独立证据：39 focused unit、22 real-PG lifecycle、55 migration、production archive
  roundtrip / reverse-lockstep 4/4、audits/typecheck/Biome/build/diff 通过；disposable DB 手工 QA
  通过。durable start reservation 已关闭 lease/start race；未 reserve 的过期 pre-start lease
  才允许自动接管。
- F1 仍由 #1164 已交付；YUK-832 仍 In Progress / HOLD；YUK-842 production 继续 observe；没有 combined deploy。

## Next handoff

1. 为 YUK-851 完成受控 PR：保持窄 diff，独立 review、exact-head CI、merge 后才可称 F0.1 delivered。
2. F0.1 merge 后才依序开 F0.2、F0.3；F0.4、F0.5 随后。每段必须重新核对契约、live consumer 和验证证据。
3. F0.O1 是单独授权的生产观察，明确排除在 FULL_IMPLEMENTED 之外；未经 deployment authorization 不部署。
4. **Architecture FULL 仍在继续，不能宣称 closed。** 不要把 F0.0 main 或 F0.1 local green 说成完整架构交付。

## Delivery boundary

- 当前可交接的是 YUK-851 的 PR-prep / 本地代码完成状态，不是 main merge、更不是生产发布。
- 不再仅等待 YUK-832/F1 rollout：当前的决定性工作是 F0.1 受控交付，之后继续 F0.2–F0.5。
- YUK-832 HOLD 与 YUK-842 observe 保持原边界；不使用 F0 工作改变产品 gate、enforcement 或部署节奏。
