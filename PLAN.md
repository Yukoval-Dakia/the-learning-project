# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-09
> **Architecture FULL 仍在继续；当前交付边界止于 F0.1 main + F0.2 local code-complete。**

## NOW

- **F0.0 / YUK-850 已交付 main。** PR #1166 squash merge
  `e93bf52f7a7edc47273e8e18638701ec1a101dbf`；direct-provider inventory/audit 基线为
  `530 / 70 / 62`。未部署。
- **F0.1 / YUK-851 已交付 main。** PR #1168 merge SHA `839653c5`；main CI 与 CodeQL
  均 green，Linear 为 Done。独立 `provider_attempt` 生命周期已成为 F0.2 使用的真实契约。
- **F0.2 / YUK-854 本地分支 code-complete，已是 commit candidate，尚未交付。** 隔离分支实现 DashScope embedding、GLM
  memory reconcile、GLM knowledge-edge reconcile 三条 direct-provider lane 的真实 attempt lifecycle。
  证据：focused unit/DB suites、provider/capability/schema/partition audits（边界仍为
  `530 / 70 / 62`）、typecheck、scoped Biome、build、disposable DB/mock-wire QA 均 green。
  当前仍未 push、无 PR、未 merge、未部署。
- **生产边界不变。** F0.0–F0.2 均未部署；YUK-832 继续 HOLD，YUK-842 production 继续 observe。

## NEXT

1. **先交付 F0.2 / YUK-854：**审查当前窄 diff，commit/push、PR、独立 review、exact-head CI，
   merge 后才可称 delivered；本地绿灯不替代 main 交付。
2. **F0.2 merge 后才开始 F0.3。** 重新核对当时的 live callers、契约、错误语义与验证范围；不从
   F0.2 local 状态提前展开。
3. F0.3 交付后再依序推进 F0.4、F0.5；F2–F4 仍为开放工作，按依赖与 owner 优先级单独收敛。
4. 任何 production observation / deployment 都需单独授权；代码 merge 不自动改变 rollout 或 enforcement。

## PARKED

- **YUK-832 / YUK-839：**actual-output/comparator timeout 保持 fail-closed；新的 owner 授权前维持 HOLD。
- **YUK-842 production：**保持 observe，不由 F0.2 改成 enforce。
- **F0.4 / F0.5 / F2–F4：**仍 open；到达各段时重新确认 scope、依赖和 acceptance evidence。
- **YUK-813 / YUK-831 OpenCode、YUK-815 / YUK-816：**不进入当前 F0.2 交付线。

## BLOCKED-ON

- **F0.2 main delivery：**尚缺 commit/push、PR、独立 review、exact-head CI 与 merge。
- **F0.3 start：**硬依赖 F0.2 已 merge；此前只做 F0.2 收尾与交付。
- **Architecture FULL：**F0.3、F0.4、F0.5 与 F2–F4 仍 open，不能宣称 closed。
- **Production：**没有部署授权或生产观察证据；main/local 状态都不等于 deployed。
