# 当前 handoff — 2026-08-09 YUK-853 local complete

> 只维护 NOW / NEXT / PARKED / BLOCKED-ON 四栏；以 Linear 与 main CI 为交付权威。

## NOW

- **F0.0 / YUK-850 已在 main。** PR #1166，SHA
  `e93bf52f7a7edc47273e8e18638701ec1a101dbf`；provider inventory 基线
  `530 / 70 / 62`。未部署。
- **F0.1 / YUK-851 已在 main。** PR #1168 merge SHA `839653c5`；main CI / CodeQL green，
  Linear Done。
- **F0.2 / YUK-854 已在 main。** PR #1169 merge SHA `b677dab4`；未部署。
- **F0.3 / YUK-853 是当前 active handoff。** OCR provider-attempt resume 本地 code-complete：GLM
  wire fetch attempt 与 Tencent Submit/Describe attempt 都由 transport owner 记录；deterministic attempt
  fence 阻止同 generation 双 Submit，completed operation 不被迟到失败反转。聚焦 OCR DB `51`、lifecycle
  DB `22`、unit `39` 均 green；旧 payload 与 legacy zero-cost ledger 保持兼容，无 migration。本地
  committed branch 完成，尚未 push/PR/merge/deploy，因此不能称 delivered。
- **运行状态：**没有 deployment；YUK-832 HOLD 与 YUK-842 observe 均未改变。

## NEXT

1. 收敛并交付 F0.3：从当前 clean committed branch 开始 push、PR、独立 review、exact-head CI、merge。
2. F0.3 后按序处理 F0.4、F0.5；F0.5 删除 transitional legacy OCR ledger mirror。
3. F2–F4 继续保持 open。

## PARKED

- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- F0.4、F0.5、F2–F4 尚未关闭；分别到达时再确认 owner、scope 与验收证据。
- Production observation / deployment 需独立授权，不与 F0.3 PR 交付合并。

## BLOCKED-ON

- F0.3 delivery 尚缺 push、PR、独立 review、exact-head CI 与 merge。
- Architecture FULL 仍依赖 F0.4、F0.5 与 F2–F4，当前不能宣称 closed。
- Production 没有部署授权或真实观察证据；保持未部署表述。
