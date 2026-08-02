# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-02
> **【YUK-832 active：sealed evidence reply certification】**

## NOW

- **YUK-757 已 Done。** PR #1149 exact-head CI 全绿后 merge 到
  `main@54d9bf620cf74d07633d72233c90cb9763516643`；durable Copilot 已具备
  backstage subagent、前台子任务投影、redelivery repair 与失败恢复。
- **YUK-596 causal-history 与 liveness 已交付。** PR #1150 merge 到
  `main@915fd5d4fd32cdceebda310879c7fd0c0138e9e5`；PR #1151 exact-head CI 全绿后
  merge 到 `main@c6dd37bfe5aaaae63d07a86bff69bd619a523b48`。durable pickup 已绑定 causal
  anchor，并具备 queue heartbeat、stale reconciliation 与 fail-closed ambiguous recovery。
- **YUK-596 Stop 后端已交付。** PR #1152 在新 exact head 的 PR gate + 手动 full workflow
  全绿后 merge 到 `main@ae82906510da102cc0ebae68ae08993999cdc888`；pre-fence marker、
  cooperative abort、materializing barrier 与 fail-closed checkpoint 均在真实 Postgres 覆盖。
- **30 例 actual-provider burn-in 已完成。** 25 done + 5 designed cancel，30/30 durable/terminal/
  domain-reply 自动契约通过；F01–F05 独立 review 无 P0/P1。真实 provider 为
  `xiaomi/mimo-v2.5-pro`，25 个成功 ledger runs，记录成本 USD 6.685758。
- **Transport PASS，产品内容 HOLD。** A–E 独立复核发现并 capture YUK-832–836：reader
  coverage/causality、artifact/直出 validator、human-in-loop capability 与 correction history。
  详情及 digests 见 `docs/planning/2026-08-02-yuk-596-actual-burnin.md`。
- **YUK-832 r8 已给出成本根因。** `ac66f110` exact-head CI/CodeQL 全绿后的隔离 A01
  正常 clean terminal，但安全 fail closed：primary 成功；第一条 blind reference 在 480s timeout，
  第二条 440s 成功绑定（1,080,790 input / 21,874 output / USD 1.537776）；两条 comparator
  均在 360s timeout。三个失败 paid attempt 仍记为 0 tokens / null cost，且 retry 丢失已接受进度。
  artifact SHA-256 `f150ba6f47e887c55c196b79a5587f493bf6f5a297d138b2cce20a80f3be2e58`
  （本地 mode 0600）。这证明继续抬 budget 不经济；tool I/O 只有约 535ms，成本在重复大 context、
  timeout 后从零重做与 explicit completion 尾轮。
- **Owner 选择 LIGHT；FULL 已挂 YUK-839。** LIGHT 在 PR #1154 当前 worktree 实现三项：模型侧
  `evidence_trace` 将 21-call / 1,761-leaf 夹具从 147,403 chars 降到 75,207（-49%），server
  仍私有保留原始 trace/catalog 做 pointer binding；最后一个完整 append 原子 auto-seal；失败
  result 或中途 abort 的已观测 usage/cost 写入 `ai_task_runs` + `cost_ledger`。FULL 的跨 attempt
  sealed checkpoint/恢复、TTL/并发与 digest 绑定独立留在 Backlog YUK-839，不混入 LIGHT。
- **`read` gate 语义已钉住。** 它只指 Copilot 产品 DomainTool trace 的 `effect=read`：没有
  read attempt 才跳过 paid validator；只要尝试过 read（即使失败）就进入 FULL 并 fail closed；只有
  `executed=true && error_reason=null` 的成功 read 可被引用。validator 内部 submission tools 与
  Tavily remote-MCP 不属于这个判断面。
- 未在本机运行完整 `pnpm test`；后续仍只用 targeted local loop + exact-head GitHub CI。

## NEXT

1. 提交并 push LIGHT，等待新 exact-head GitHub `CI Gate` / CodeQL；本机只保留 scoped tests、
   provenance DB loop、typecheck/lint/audits/build。
2. CI 全绿后，在 clean committed exact head 只重跑一次隔离 A01，比较 reference/comparator
   input tokens、wall time、失败记账与 pass/repair；不再用连续加 budget 代替产品证据。
3. A01 自动 gate + 人工 grounding/coverage/honesty 均通过后，才重跑其余 actual-provider 样本；
   未过则据新证据做下一窄化，不重复烧同一种失败。
4. YUK-832 actual gate 收口后推进 YUK-833/835 → YUK-834 → YUK-836；产品 P1 清零后再做
   Dock/UI design pre-flight。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；等待 Copilot 主产品链收口。
- **YUK-839 FULL checkpoint**：owner 已批准挂单；LIGHT actual 数据证明需要前不扩入当前 PR。
- future/refinement backlog 不自动扩实施范围；到达时先核证 live consumer、重复与过期项。

## BLOCKED-ON

- **YUK-832 当前 gate**：LIGHT 新 exact-head GitHub CI + 单次 actual A01 成本/产品复验 +
  人工 2/2/2；mock、本地 build 或旧 head CI 都不能替代。
- **YUK-596 产品 gate**：YUK-832–836 actual-output P1；transport/Stop 已 pass，不能用它替代
  产品内容正确性。
- **YUK-596 后续 owner gate**：产品 P1 与 actual rerun 完成后，先做 UI design pre-flight；
  owner 批准前不写 UI，也不翻 durable-default 扩量。
- **YUK-571 / YUK-405 / YUK-406**：等待真实内容、首次 placement 与真实观察窗口；synthetic/
  mock 不能冒充 owner 验收。YUK-452 是 parent/epic，须按 children 现实对齐。
- **严格 issue=0**：仍含 future、数据触发、生产 flip 与大 epic；最终需 owner 做
  keep/merge/cancel 裁决，不能靠连续写代码伪归零。
