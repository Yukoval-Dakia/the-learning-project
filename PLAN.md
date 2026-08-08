# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-09
> **【Architecture FULL 正在继续：F0.0 已交付 main；F0.1 本地代码完成，尚未交付】**

## NOW

- **F0.0 / YUK-850 已交付 main。** PR #1166 squash merge 为
  `e93bf52f7a7edc47273e8e18638701ec1a101dbf`；exact-main CI Gate
  `31269934370`、CodeQL `31269934284`、Rust parity `31269934338` 均成功。
  本轮只做 live direct provider lanes 审计：六条可达 lane 加一条 prune，10 findings / 0
  violations；仅删除不可达的 misconception reconcile runtime/tests，保留历史 schema、migrations、
  export/reset tests。基线现为 `530 / 70 / 62`。**未部署。**
- **F0.1 / YUK-851 本地代码完成，尚未交付。** 分支
  `codex/yuk-851-provider-attempt` 引入独立 `provider_attempt` /
  `provider_attempt_admission`、中性的 `ProviderAttemptLifecycle` 与 schema `4.18`；没有 caller
  migration，未改 `provider_session`、runner 或 cost ledger。Linear 仍 In Progress，PR/merge 尚未完成，
  **不得表述为 delivered 或 deployed。**
- **F0.1 本地证据已齐。** 39 focused unit、22 real-PG lifecycle、55 migration、production
  archive roundtrip / reverse-lockstep 4/4、audits/typecheck/Biome/build/diff 均通过；一次性
  disposable DB 手工 QA 通过。生命周期以 durable start reservation 关闭 lease/start race，
  未 reserve 的过期 pre-start lease 才可接管。
- **F1 保持已交付。** #1164 已在 main；YUK-832 仍 In Progress / HOLD，YUK-842 production 仍 observe。
  本轮没有 combined deploy。
- **架构 FULL 尚未关闭。** F0.0 仅完成现状盘点/收敛；F0.1 仍待 PR merge，随后才进入后续语义与调用方工作。

## NEXT

1. **先完成 F0.1 受控 PR 交付：**保持当前窄范围，推送/PR、独立 review、exact-head GitHub CI 后再 merge；
   merge 前不要迁移 caller，也不要修改 provider_session、runner 或 cost ledger。
2. **F0.1 merge 后依序推进 F0.2、F0.3；**随后 F0.4、F0.5。每段都须以当时的 live consumer、契约和
   验证证据重新确认范围，不能由 F0.1 的本地绿灯替代。
3. **F0.O1 属生产观察，不计入 FULL_IMPLEMENTED。** 仅在获得单独 deployment 授权后规划；本轮没有部署授权。
4. YUK-832 继续 HOLD，YUK-842 保持 observe；不把 F0 合并成 combined image 或借此改变产品/enforcement 状态。

## PARKED

- **YUK-832 / YUK-839：**actual-output/comparator timeout 仍 fail-closed；新的 owner 授权前不重开昂贵
  checkpoint，也不把 mock/local evidence 写成产品放行。
- **YUK-842 production：**继续真实观察，不在 F0.1 范围内翻转 enforce。
- **YUK-813 / YUK-831 OpenCode、YUK-815 / YUK-816：**不进入本 active 线；到达时先复核 live consumer、
  重复与 owner 优先级。

## BLOCKED-ON

- **F0.1 delivery：**PR 创建/审阅、exact-head CI 和 merge 尚未发生；本地 code-complete 不等于 main delivery。
- **Architecture FULL：**F0.1 merge 后仍依赖 F0.2 → F0.3 → F0.4 → F0.5；F0.O1 另需部署授权与真实生产观察，
  因此不属于 FULL_IMPLEMENTED 的关闭条件。
- **Production：**没有本轮部署授权；所有 main/local 代码状态均不能替代 deployment 或运营证据。
- **YUK-832 产品 gate：**actual comparator timeout 仍 fail-closed，保持 In Progress / HOLD。
