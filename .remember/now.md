# 当前 handoff — 2026-08-02 YUK-596 actual-output P1 repair wave

## Delivered

- YUK-757 / PR #1149：durable subtask/backstage contract，merge 到 `main@54d9bf62`。
- YUK-596 causal-history / PR #1150：merge 到 `main@915fd5d4`。
- YUK-596 liveness / PR #1151：exact-head CI 后 merge 到 `main@c6dd37bf`。
- YUK-596 in-loop Stop / PR #1152：exact-head PR gate + manual full workflow 后 merge 到
  `main@ae82906510da102cc0ebae68ae08993999cdc888`。

## Actual burn-in

- worktree：`/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-596-burnin`
- branch：`codex/yuk-596-burnin-evidence`
- base：`main@ae82906510da102cc0ebae68ae08993999cdc888`
- 30 个复杂 actual-provider cases，25 done + 5 designed cancel；30/30 mechanical assertions pass。
- provider/model：`xiaomi/mimo-v2.5-pro`；25 successful ledger runs；2,100,674 input tokens、
  118,004 output tokens、USD 6.685758。
- 29 ai runs 中 25 有 thinking aggregate：85 blocks / 181,364 chars；没有 raw reasoning_content。
- 240 DomainTool calls：229 read、9 propose、2 write。
- F01–F05 Stop 独立 review 无 P0/P1；F05 在 materializing write 后 cancel，正确保留写入并
  fail-closed 为 `checkpoint_safe:false`。
- 完整报告与 artifact digests：
  `docs/planning/2026-08-02-yuk-596-actual-burnin.md`。

## Product findings

- **YUK-832**：event/action exact filter、sibling causality、bounded coverage 与 due/future read
  让 Copilot 反转已核验事实。
- **YUK-833**：`author_artifact` 只做 schema/HTML size，矛盾题组可直接写入；需复用泛化
  validator 做 author/update pre-write gate。
- **YUK-834**：模型把 destructive/不存在能力降为 LIGHT，虚构 rollback/SQL，并扩张 owner scope。
- **YUK-835**：直出题解/题包未运行 Solution/Quiz/Teaching validator，却声称自检通过。
- **YUK-836**：correction request 忽略直接上一轮并反转已注入 session 事实。
- YUK-814 的 owner mock waiver 保持不变；没有重开 YUK-814。

## Next order

1. YUK-832：先修 read contracts；后续审计与 validator 都依赖可信 evidence。
2. YUK-833 + YUK-835：共享一个泛化 validator core，分别接 artifact persistence 与 direct reply。
3. YUK-834：effect/capability/scope/rollback owner gate。
4. YUK-836：prior-turn correction contract。
5. 同一复杂 mock + actual-provider rerun；targeted local checks，完整 `pnpm test` 仅 GitHub CI。
6. 上述 P1 清零后提交 UI design pre-flight；owner 明确批准前不写 UI、不翻 expansion。

## Runtime cleanup

- burn-in API/worker 已 SIGINT clean stop；clone Postgres volume 暂保留，供 P1 actual rerun。
- 原始 cases/results 位于本地 mode 0600 `/tmp/tlp-burnin-20260802/`，不提交。
- 原始 repo worktree 仍有用户/其他 lane 的未提交内容；不要 reset、sync 或覆盖。
