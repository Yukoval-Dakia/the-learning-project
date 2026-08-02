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

## YUK-832 current gate

- PR #1154 `8db403af` exact-head CI/CodeQL 已全绿；无未解决 P0/P1。
- exact-head actual-provider v8 五例全部安全 fail closed 且没有 candidate 泄漏。A01/A03/A04
  的复杂 blind-reference 多次撞 120s；A03/C01/C04 也有成功 provider 输出被 strict contract
  拒绝。原始结果在本地 mode 0600 artifact，不提交。
- 当前窄化修复只给 durable blind-reference 300s；inline 与 comparator 保持 120s。FULL 最坏
  审阅为 18min，连同 primary 12min + 30s grace 的 owner ceiling 为 30.5min，仍小于 1h
  stuck-run 阈值。加入的诊断只保留固定 contract 错误类别/有界单行消息，不记录 raw output、
  candidate 或 thinking。
- `9a7be1b6` 的 A01 actual 已让两次 blind reference 越过原 120s timeout 并完整返回，但都被
  诊断为非 strict JSON；重复证据足够后停止 A03，其余样本未继续烧 provider。下一窄化修复
  先尝试只接受唯一一个 syntax-only JSON fence，但 `1d48d4d3` actual 的首个 A01 reference
  仍不匹配，随即 Stop，未继续重复烧 provider。现改为复用项目既有 structured-task 单 JSON
  对象提取器：`6fbf9c1e` actual 成功进入 Zod，暴露 provider 自创 protocol_version/type/status
  和额外字段；首例即 Stop。根因是 Xiaomi 不接收 SDK native outputFormat，而 prompt 没给 exact
  JSON shape；现已把两个 validator 的 numeric protocol、字段、数组与 enum 逐字写入 prompt。
  `55151d5d` 的 A01 actual 已通过 schema，随后被 server 正确拒绝，因为 source pointer 指向
  非空 object/array；首例即 Stop。`f9e49f1c` 把 pointer 只能终止在 scalar/null/显式空容器写成
  hard rule 并让 comparator 优先只引用 sealed point，但首个 actual reference 仍重复同一
  binding 错误，随即 Stop。现让既有第二次 attempt 只收到 server 生成的 240-char 固定契约错误，
  不含前次 output/verdict、candidate、thinking 或新证据，并按每次实际 input 重新 hash/bind；
  wrapper prose 丢弃，多对象/Zod/server binding 仍拒绝。`41503da5` A01 primary 在 133.31s
  完成；第一条 reference 在 218.88s 完整返回并因 request coverage 6–9 缺 evidence point 被拒，
  第二条已收到固定反馈但在 242.01s 被 240s 上限截断。artifact SHA-256
  `a1337940a00ccfb10418f13aa2fbeac0b9c34e13d3fe6eddb91936b1731caf72`（本地 mode 0600）。
  现只把 durable reference 调到 300s；新 committed exact head 仍须跑 GitHub CI，先过 A01
  自动 gate 再跑五例 actual v8。更早的 A01 两次 reference 分别约
  198.30s/198.33s，均为 provider success + thinking；partial artifact SHA-256
  `7e7d7e402a7d007c165049f8fc42534072ed068e536d3ee53eacd99da1190d7b`（本地 mode 0600）。

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
