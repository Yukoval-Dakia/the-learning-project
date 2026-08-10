# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-10
> **Architecture FULL 仍在继续；当前实施线为 YUK-857。**

## NOW

- **F0.0 / YUK-850 已交付 main。** PR #1166 squash merge
  `e93bf52f7a7edc47273e8e18638701ec1a101dbf`；direct-provider inventory/audit 基线为
  `530 / 70 / 62`。未部署。
- **F0.1 / YUK-851 已交付 main。** PR #1168 merge SHA `839653c5`；main CI 与 CodeQL
  均 green，Linear 为 Done。独立 `provider_attempt` 生命周期已成为 F0.2 使用的真实契约。
- **F0.2 / YUK-854 已交付 main。** PR #1169 merge SHA `b677dab4`；三条 direct-provider lane
  已接入 F0.1 attempt lifecycle。未部署。
- **F0.3 / YUK-853 已交付 main。** main SHA
  `b16f6276cb51033979953e9c8cc8c561f894d13b`；OCR wire provider-attempt 已进入主线。未部署。
- **F0.4 / YUK-852 已交付 main。** PR #1171 merge SHA `c98b10b0`；Mem0 opaque operation、
  caller-owned operation/fresh attempt/terminal truth 与连接池句柄复用均已进入主线。未部署。
- **F0 unknown-cost / YUK-844 已交付 main。** PR #1172 已合并到 `b140d246`；
  all-known nullable cost、placement sticky-null settlement 与 migration 0090 已进入主线。未部署。
- **F0.5 / YUK-855 已交付 main。** YUK-857 的前置依赖已解除。
- **F2.1 / YUK-857 是当前 active implementation。** Notes append-only handoff、deterministic
  dispatch/readback、indexed manifest recovery、version/fence verification claim 与 Notes-owned task
  definitions 已进入 PR #1174；0093 迁移加入短事务 reserve/result/finalize 状态机。SHA
  `860e39cf` 的 exact-head CI run `31343456441` 已全绿，但后续 PR review 确认 provider-start
  boundary、跨 recovery job 无界 paid retry、claim recovery 吞错三条 P1。repair commit
  `01dd3b68` 已推送 PR #1174，并经 correctness / quality / security static review PASS；该 SHA
  的 CI run `31345451148` 已启动，但不是最终交付证据；本次 docs-only sync 将形成更新 head，
  仍须 fresh exact-head CI/review/merge。owner 禁止本地 test/typecheck/build/audit/migration。
- **生产边界不变。** F0.0–F0.4 均未部署；YUK-832 继续 HOLD，YUK-842 production 继续 observe。

## NEXT

1. 监控本次 docs-only 新 exact-head GitHub CI 与独立 review；不在本地跑 runtime gates。
2. 只以 fresh exact-head 结果验证 runtime/type/test gates；全绿且 review clean 后再 merge、同步 Linear。
3. F2.2–F4 继续按依赖与 owner 优先级单独收敛。
4. production observation / deployment 需单独授权。

## PARKED

- **YUK-832 / YUK-839：**actual-output/comparator timeout 保持 fail-closed；新的 owner 授权前维持 HOLD。
- **YUK-842 production：**保持 observe，不由 F0.2 改成 enforce。
- **YUK-856 production rollout：**需要独立部署授权；不作为 YUK-855 code-complete 的一部分。
- **F2.2–F4：**仍 open；到达各段时重新确认 scope、依赖和 acceptance evidence。
- **YUK-813 / YUK-831 OpenCode、YUK-815 / YUK-816：**不进入当前 F0.4 交付线。

## BLOCKED-ON

- **YUK-857 delivery：**blocked on fresh exact-head CI、独立 review 与 merge。
- **Architecture FULL：**F2.1–F4 仍 open，不能宣称 closed。
- **Production：**没有部署授权或生产观察证据；main/local 状态都不等于 deployed。
