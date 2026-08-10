# 当前 handoff — 2026-08-10 YUK-857 Notes durable handoff

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
- **YUK-855 已交付 main。** YUK-857 前置依赖解除。
- **YUK-857 是当前 active handoff。** PR #1174 已承载 event v1 intent/completion、deterministic
  pg-boss UUID/readback、indexed 每分钟 recovery、0093 Notes verification claim、
  artifact-version/fence CAS、raw-result recovery 与 Notes-owned task definitions。SHA
  `860e39cf` 的 exact-head CI run `31343456441` 已全绿，但后续 PR review 确认 provider-start
  boundary、跨 recovery job 无界 paid retry、claim recovery 吞错三条 P1。repair commit
  `01dd3b68` 已推送 PR #1174；后续 head `e6a0c280` 的 exact-head CI run `31345789472`
  全绿，但 review thread 随后确认 attempt cap 只终结 claim、未终结 artifact 的第四条 P1。
  repair `121bdb85` 使第三次 confirmed provider failure 与所有 cap 入口均同事务投影 claim
  `attempts_exhausted`、artifact `verification_status='failed'` 及 lifecycle event；其 CI run
  `31347238672` 的 DB/unit/migration/build/usability 均通过，但新增 claim→artifacts direct edge
  触发 boundary audit。PR 当前 head 已用 Notes-local verification lifecycle adapter 合并两个 direct
  edge，恢复既有 `notes -> artifacts = 8` / total `523` 基线且未抬高 baseline，并已 commit/push；
  correctness / quality static re-review PASS。只有该 current head 的 fresh exact-head CI/review/merge
  可作最终证据。未做本地 runtime 验证。
- **运行状态：**没有 deployment；YUK-832 HOLD 与 YUK-842 observe 均未改变。

## NEXT

1. 监控 PR current head 的 exact-head GitHub CI 与独立 review。
2. 只以 fresh exact-head 结果验证 tests/typecheck/build。
3. CI/review 全绿后 merge、同步 Linear；F2.2–F4 继续保持 open。

## PARKED

- YUK-832 / YUK-839 保持 fail-closed HOLD；YUK-842 production 保持 observe。
- YUK-856 production rollout 需独立授权；F2.2–F4 尚未关闭。
- Production observation / deployment 需独立授权，不与 YUK-844 delivery 合并。

## BLOCKED-ON

- YUK-857 blocked on fresh exact-head CI、review clean 与 merge。
- Architecture FULL 仍依赖 F2.1–F4，当前不能宣称 closed。
- Production 没有部署授权或真实观察证据；保持未部署表述。
