# 当前 handoff — 2026-08-09 YUK-852 PR #1171 P1 收敛

> 只维护 NOW / NEXT / PARKED / BLOCKED-ON 四栏；以 Linear 与 main CI 为交付权威。

## NOW

- **F0.0 / YUK-850 已在 main。** PR #1166，SHA
  `e93bf52f7a7edc47273e8e18638701ec1a101dbf`；provider inventory 基线
  `530 / 70 / 62`。未部署。
- **F0.1 / YUK-851 已在 main。** PR #1168 merge SHA `839653c5`；main CI / CodeQL green，
  Linear Done。
- **F0.2 / YUK-854 已在 main。** PR #1169 merge SHA `b677dab4`；未部署。
- **F0.3 / YUK-853 已在 main。** SHA `b16f6276cb51033979953e9c8cc8c561f894d13b`；未部署。
- **F0.4 / YUK-852 是当前 active handoff。** PR #1171 已 Ready；P1 修复后的本地 delivery candidate
  已 commit、尚未 push，remote head 仍为 `448c5e7e8a2e628064ecb8309a9867a4dec0ef61`。
  Mem0 三条真实 add 与 canonical search 已进入 PR；candidate 尚未 push，PR 尚未 merge，亦未 deploy。
  unit、DB 与 `530 / 70 / 62` boundary 均 green；无 migration，不能称 delivered。
- **运行状态：**没有 deployment；YUK-832 HOLD 与 YUK-842 observe 均未改变。

## NEXT

1. 对本地 P1 第二 commit 做最终 scope inspection；获授权后 normal push，等待新 exact-head CI 与
   review 收敛后 merge PR #1171。
2. F0.4 后处理 F0.5；F0.5 删除 transitional legacy OCR ledger mirror。
3. F2–F4 继续保持 open。

## PARKED

- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- F0.5、F2–F4 尚未关闭；分别到达时再确认 owner、scope 与验收证据。
- Production observation / deployment 需独立授权，不与 F0.4 PR 交付合并。

## BLOCKED-ON

- F0.4 delivery 尚缺本地 P1 第二 commit push、新 exact-head CI、review 收敛与 PR #1171 merge。
- Architecture FULL 仍依赖 F0.4 交付、F0.5 与 F2–F4，当前不能宣称 closed。
- Production 没有部署授权或真实观察证据；保持未部署表述。
