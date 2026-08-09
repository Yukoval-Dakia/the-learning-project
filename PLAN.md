# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-10
> **Architecture FULL 仍在继续；YUK-844 已交付 main，当前实施线为 YUK-855。**

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
- **F0.5 / YUK-855 是当前 active delivery。** PR #1173 已打开；provider/lane admission
  `off / observe / enforce`、durable provider-attempt truth、legacy cost writer retirement 与统一成本投影
  已实现。首轮 exact-head CI 暴露的问题已修复，等待新 SHA 的 GitHub CI 与独立 review。
- **生产边界不变。** F0.0–F0.4 均未部署；YUK-832 继续 HOLD，YUK-842 production 继续 observe。

## NEXT

1. **收敛 YUK-855：**提交并 push 当前 review/CI 修复，只以 exact-head GitHub CI 验证；
   review clean 后 merge，并同步 Linear。
2. **启动 YUK-857 / F2.1：**从最新 main 建隔离 worktree，实施 Notes generate/verify durable handoff。
3. F2.2–F4 继续按依赖与 owner 优先级单独收敛。
4. 任何 production observation / deployment 都需单独授权；merge 不自动改变 rollout 或 enforcement。

## PARKED

- **YUK-832 / YUK-839：**actual-output/comparator timeout 保持 fail-closed；新的 owner 授权前维持 HOLD。
- **YUK-842 production：**保持 observe，不由 F0.2 改成 enforce。
- **YUK-856 production rollout：**需要独立部署授权；不作为 YUK-855 code-complete 的一部分。
- **F2.2–F4：**仍 open；到达各段时重新确认 scope、依赖和 acceptance evidence。
- **YUK-813 / YUK-831 OpenCode、YUK-815 / YUK-816：**不进入当前 F0.4 交付线。

## BLOCKED-ON

- **YUK-855 delivery：**当前修复尚缺 commit/push、新 exact-head CI、独立 review 与 merge。
- **YUK-857：**Linear 仍由 YUK-855 阻塞；YUK-855 merge 后立即解除并启动。
- **Architecture FULL：**YUK-855 与 F2–F4 仍 open，不能宣称 closed。
- **Production：**没有部署授权或生产观察证据；main/local 状态都不等于 deployed。
