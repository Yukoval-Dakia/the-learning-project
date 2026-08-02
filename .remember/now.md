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

- PR #1154 / branch `codex/yuk-832-evidence-readers`；LIGHT commit
  `7979514d28333d9c6f9cdcd68286280e509ae134` 的 exact-head GitHub `CI Gate` run
  `30746982322`（含完整 test matrix）与 CodeQL 全绿。本机未运行完整 `pnpm test`。
- 隔离 A01 r8 在 2026-08-02 完成 clean terminal，evidence status=`failed_closed`：primary 成功；
  reference #1 在 480s timeout，reference #2 在 440s 成功绑定；两个 comparator 均在 360s
  timeout。第二条 reference 使用 1,080,790 input / 21,874 output / USD 1.537776；三个失败
  attempt 仍是 0 usage/null cost。artifact：
  `/tmp/tlp-burnin-20260802/results-yuk832-ac66f110-actual-v10-a01-r8.jsonl`，SHA-256
  `f150ba6f47e887c55c196b79a5587f493bf6f5a297d138b2cce20a80f3be2e58`，mode 0600。
- r8 有界证据：24 次产品 read trace、精确 observation reconstruction 61,364 chars、旧模型侧
  raw trace + pointer catalog 约 152 KB；tool I/O 总计约 535ms。成本主因是每轮重复大 context、
  timeout 后丢失 accepted progress、explicit complete 尾轮与失败成本不可见，不是 SDK thinking
  未开启；成功 primary/reference 均记录 thinking aggregate，仍不记录 raw reasoning_content。
- Owner 决策：**LIGHT 走，FULL 挂单**。当前 LIGHT 已实现：
  1. 每个 exact leaf 内嵌 `[source_id, exact_value]` 的紧凑 `evidence_trace`，原始 trace/catalog
     仅留 server 做 binding/digest；21-call / 1,761-leaf 夹具从 147,403 降至 75,207 chars（-49%）。
  2. reference/comparator 最后一批完整 append 自动原子 seal，explicit complete 仅作幂等恢复。
  3. SDK result-error 与 abort 前 assistant-turn usage 进入 failure run + `cost_ledger`，不再把 paid
     timeout 伪装成 0/null；raw thinking 仍只留 block/character aggregate。
- FULL 已建 Linear **YUK-839**（Backlog）：跨 attempt 可恢复 sealed checkpoint，绑定 input hash /
  source-catalog digest / protocol，保留 blind isolation、两个独立 comparator pass、TTL/并发/幂等；
  不混入 LIGHT。YUK-837 继续单独负责 Tavily exact-result capture。
- `read` 判断只覆盖 Copilot 产品 DomainTools：无 read attempt 才 skip；失败 read 也触发 validator
  但自动标 unusable，只有 `executed=true && error_reason=null` 能引用。submission MCP tools 与
  Tavily remote-MCP 不在该判断面。
- 本地已通过 172 个 targeted unit、2 个 provenance DB tests、typecheck、lint、agent-control-plane /
  capability-boundary audits 与 production build；完整 `pnpm test` 仍只交 exact-head GitHub CI。
- clean committed head 只运行了一次隔离 A01 r9，随后停止，没有其他昂贵样本：
  - primary success：95.321s，189,904 input / 6,251 output，USD 0.816931；
  - reference 首次 success：324.608s，759,722 input / 25,048 output，USD 1.502762，digest bound；
    相对 r8 成功 reference 为 input -29.7%、wall time -26.2%、cost -2.3%，并消除了 r8 的前置
    482s timeout attempt；
  - comparator #1/#2 均在约 362s timeout，合计 3,778,904 input；失败 run/ledger 分别记录
    USD 0.24765047 / 0.181446，证明 LIGHT failure accounting 生效；
  - 最终 `failed_closed`、clean terminal、无不安全产品输出。artifact：
    `/tmp/tlp-burnin-20260802/results-yuk832-7979514d-actual-v10-a01-r9.jsonl`，SHA-256
    `ee7d562967cc95e829979bc4ed1f9d0ff1e65693237a774b4af4725de0d06d35`，mode 0600。
- r9 总 ledger USD 2.74878947；不可与 r8 的 USD 2.196909 直接比较绝对节省，因为 r8 漏记全部
  failed paid attempts。按 run wall time，r9 约比 r8 少十分钟/约三分之一，但 comparator 仍未通过，
  产品保持 HOLD，不再重复 A01。
- r9 沿用了 v10 harness，因此其中两条 ledger 失败是旧断言把所有 failure 都要求“无 ledger”；
  这不是产品失败。已另存 mode 0600 `harness-v11.ts`，让成功 run 对应 `success` ledger、带已观测
  usage/cost 的失败 run 对应 `failed_retryable|failed_permanent` ledger，并已独立 typecheck；不改写
  v10 或 r9 artifact，也不据此重跑 provider。其余四条失败仍是 comparator 未绑定导致的真实产品 gate。

## Next order

1. YUK-832：提交 r9 handoff 后保持 In Progress / product HOLD；不重复 A01。FULL 只在 owner
   重新提升 Backlog YUK-839 时执行。
2. YUK-833 + YUK-835：共享一个泛化 validator core，分别接 artifact persistence 与 direct reply。
3. YUK-834：effect/capability/scope/rollback owner gate。
4. YUK-836：prior-turn correction contract。
5. 修复后才用同一复杂 mock + actual-provider rerun；targeted local checks，完整 `pnpm test` 仅
   GitHub CI。
6. 上述 P1 清零后提交 UI design pre-flight；owner 明确批准前不写 UI、不翻 expansion。

## Runtime cleanup

- burn-in API/worker 已 SIGINT clean stop；clone Postgres volume 暂保留，供 P1 actual rerun。
- 原始 cases/results 位于本地 mode 0600 `/tmp/tlp-burnin-20260802/`，不提交。
- 原始 repo worktree 仍有用户/其他 lane 的未提交内容；不要 reset、sync 或覆盖。
