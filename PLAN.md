# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-09
> **Architecture FULL 仍在继续；当前交付边界止于 F0.2 main + F0.3 local code-complete。**

## NOW

- **F0.0 / YUK-850 已交付 main。** PR #1166 squash merge
  `e93bf52f7a7edc47273e8e18638701ec1a101dbf`；direct-provider inventory/audit 基线为
  `530 / 70 / 62`。未部署。
- **F0.1 / YUK-851 已交付 main。** PR #1168 merge SHA `839653c5`；main CI 与 CodeQL
  均 green，Linear 为 Done。独立 `provider_attempt` 生命周期已成为 F0.2 使用的真实契约。
- **F0.2 / YUK-854 已交付 main。** PR #1169 merge SHA `b677dab4`；三条 direct-provider lane
  已接入 F0.1 attempt lifecycle。未部署。
- **F0.3 / YUK-853 本地 code-complete，尚未交付。** OCR wire owner 已使用 provider-attempt：GLM
  每次真实 page fetch 建 fresh attempt；Tencent Submit/Describe 各自建 attempt，并以同一 page operation
  保存/恢复 JobId；同一 retry generation 的并发 Submit 由 deterministic attempt fence 收敛为一次 wire，
  迟到失败不会反转 completed operation。聚焦 OCR DB `51`、lifecycle DB `22`、unit `39` 均 green；
  no-wire 与 legacy ledger 兼容已覆盖，无 schema migration。本地 committed branch 完成，尚未
  push/PR/merge/deploy，也未经 exact-head CI。
- **生产边界不变。** F0.0–F0.3 均未部署；YUK-832 继续 HOLD，YUK-842 production 继续 observe。

## NEXT

1. **交付 F0.3 / YUK-853：**从当前 clean committed branch 开始 push、PR、独立 review、exact-head CI，
   merge 后才可称 delivered；本地绿灯不替代 main 交付。
2. F0.3 交付后再依序推进 F0.4、F0.5；F0.5 移除 transitional legacy OCR ledger mirror。
3. F2–F4 仍为开放工作，按依赖与 owner 优先级单独收敛。
4. 任何 production observation / deployment 都需单独授权；代码 merge 不自动改变 rollout 或 enforcement。

## PARKED

- **YUK-832 / YUK-839：**actual-output/comparator timeout 保持 fail-closed；新的 owner 授权前维持 HOLD。
- **YUK-842 production：**保持 observe，不由 F0.2 改成 enforce。
- **F0.4 / F0.5 / F2–F4：**仍 open；到达各段时重新确认 scope、依赖和 acceptance evidence。
- **YUK-813 / YUK-831 OpenCode、YUK-815 / YUK-816：**不进入当前 F0.3 交付线。

## BLOCKED-ON

- **F0.3 main delivery：**尚缺 push、PR、独立 review、exact-head CI 与 merge。
- **Architecture FULL：**F0.4、F0.5 与 F2–F4 仍 open，不能宣称 closed。
- **Production：**没有部署授权或生产观察证据；main/local 状态都不等于 deployed。
