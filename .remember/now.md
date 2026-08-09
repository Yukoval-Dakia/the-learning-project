# 当前 handoff — 2026-08-10 YUK-855 admission modes delivery

> 只维护 NOW / NEXT / PARKED / BLOCKED-ON 四栏；以 Linear 与 main CI 为交付权威。

## NOW

- **F0.0 / YUK-850 已在 main。** PR #1166，SHA
  `e93bf52f7a7edc47273e8e18638701ec1a101dbf`；provider inventory 基线
  `530 / 70 / 62`。未部署。
- **F0.1 / YUK-851 已在 main。** PR #1168 merge SHA `839653c5`；main CI / CodeQL green，
  Linear Done。
- **F0.2 / YUK-854 已在 main。** PR #1169 merge SHA `b677dab4`；未部署。
- **F0.3 / YUK-853 已在 main。** SHA `b16f6276cb51033979953e9c8cc8c561f894d13b`；未部署。
- **F0.4 / YUK-852 已在 main。** PR #1171 merge SHA `c98b10b0`；未部署。
- **YUK-844 已在 main。** PR #1172 merge 到 `b140d246`；unknown-cost 与 migration 0090 已交付。
- **YUK-855 是当前 active handoff。** PR #1173 首个 SHA `7519f350` 的 GitHub CI 已提供失败证据；
  capability baseline、audit unit seam、DB fixtures、cost aggregate ISO bind、off-mode durable truth 与
  control-plane fail-open 修复均已落盘，等待提交后的新 exact-head CI 与独立复审。
- **运行状态：**没有 deployment；YUK-832 HOLD 与 YUK-842 observe 均未改变。

## NEXT

1. Commit/push YUK-855 当前修复，监控 PR #1173 新 exact-head CI，处理剩余 review threads。
2. CI/review 全绿后 merge、同步 Linear，并以非强制方式移除 YUK-855 worktree。
3. 从最新 main 启动 YUK-857 Notes durable handoff；F2.2–F4 继续保持 open。

## PARKED

- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- YUK-856 production rollout 需独立授权；F2.2–F4 尚未关闭。
- Production observation / deployment 需独立授权，不与 YUK-844 delivery 合并。

## BLOCKED-ON

- YUK-855 delivery 尚缺当前修复 commit/push、新 exact-head CI、review clean 与 merge。
- YUK-857 由 YUK-855 阻塞；Architecture FULL 仍依赖 YUK-855 与 F2–F4，当前不能宣称 closed。
- Production 没有部署授权或真实观察证据；保持未部署表述。
