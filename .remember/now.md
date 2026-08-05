# 当前 handoff — 2026-08-03 Architecture Deepening FULL / PR #1154 reconciliation

## Owner direction and tracker

- Owner：「直接启动 FULL」；硬约束：「gate 不要在本地跑」。
- Linear project：`Architecture Deepening FULL — 语义、成本与运行所有权`（In Progress）。
- F0：YUK-840、YUK-841、YUK-842 均 Done；当前收口 PR #1154 的 LIGHT evidence
  certification 代码，YUK-832 产品 gate 仍 HOLD。

## Delivered and production state

- 原始 admission PR #1157 已 merge：main `34af0f75b8b7bfc1ac6b49826f9c6ba94c1012c8`；
  exact-head CI 全绿，独立审查无 P0/P1。
- 本地 prompt/config 物化修复 PR #1158 已 merge：main
  `c76ccf57edb88b7af48643fd61858534d9ddfbfb`；exact-head CI 全绿，独立审查无 P0/P1。
- startup/steady lease 修复 PR #1159 已 merge：main
  `d4782f36cc36d1b47de1ff4842e50b27d9b60fc5`；exact-head CI 与独立审批全绿。
- production app/worker 当前同镜像
  `sha256:f4add25574b89df2fbc3e579fd90704aeddf3daf1a6ccee1c6a678838b5d2687`，
  都是 `observe`，policy 为 xiaomi concurrency=4 / starts=30 / queue=32 / wait=30s；health 正常、
  restart=0。Postgres/tunnel 未重启，migration 0088 已应用。
- rollback：`the-learning-project-app:yuk842-prestartup-202608030000` 指向部署前 observe image
  `sha256:a7839883...`；exact merged image 另有 `yuk842-d4782f36cc36` tag。
- 尚未切 `enforce`；本轮也不会部署 #1154 combined image。

## Production evidence and second root cause

- 两次真实 API-originated Copilot 请求都 HTTP 200 且用户结果被 observe fail-open 保护。
- 第一次证明 acquire 后的一次性 skill/config 物化会阻塞 heartbeat；PR #1158 已把这些工作移到
  admission 前。
- PR #1158 部署后的第一次冷请求仍在 acquire 后约 16.2s 才恢复 event loop，原 15s lease 到期并
  记录 `lease_lost`。prompt/options 已完成，剩余 stall 位于 SDK `query()` 同步 CLI spawn/initialize。
- SDK 0.3.220 的正式 seam 是 `startup({options, initializeTimeoutMs}) → WarmQuery`；`startup()` 只
  spawn/initialize，不发送 prompt，`WarmQuery.query(prompt)` 才写 prompt。CLI binary 约 272MB。
- 原 lifecycle 还在 `sdkQuery()` 前启动 model timer；16s event-loop stall 也会饿死 10s task timer，
  因而仅延长 lease 不能闭合 runner correctness。

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
## Validation boundary and next action

- YUK-842 cold evidence 已闭合：API/worker 主 attempt 都 released/success/cost-truth matched；真实
  MemoryBrief heartbeat 跨过 15s，最终 AI/job/admission `0|0|0`，Linear 已 Done。
- PR #1154 正在普通 merge `origin/main@d4782f36`；必须同时保留 90s HTTP absolute deadline、
  startup/steady permit、atomic attempt settlement 与 evidence buffer/review/fail-closed。
- 当前 merge 后只跑 exact-head GitHub CI；不运行本地 test/typecheck/lint/build/audit gate。
- unresolved high/major review 必须在真实合并代码上修复或用 child-only loom read 等确定性测试证伪；
  exact-head 全绿、无 P0/P1 后才 merge。
- #1154 只合并代码，不部署 combined image；YUK-832 保持 HOLD，YUK-839 checkpoint 仍 parked。

## Explicit residual scope

- YUK-845 承接 DashScope embeddings、Mem0 fan-out、direct GLM/OCR、Tencent OCR 与 manual preflight；
  当前不能宣称产品级 HTTP capacity 已统一治理。
- production `enforce` 仍需更长 observe 证据、全调用进程同 binary/fingerprint、application-level
  quiesce/drain 与 restore protocol；本轮冷证据干净也不自动授权切 enforce。
- 若任何 owner abort/kill/stop 不可证明正常 drain，恢复/切换等待下界是 process stop time + 45s
  startup budget + deployed max execution timeout + 30s abort grace；DB `hard_reclaim_at` 只能延长。
