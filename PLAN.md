# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-03
> **【PR #1154 active：merge YUK-842 lifecycle + sealed evidence certification】**

## NOW

- **Architecture FULL Phase 0 实现已闭合。** YUK-840/841/842 均 Done；YUK-842 PR #1159
  exact-head CI 全绿并 merge 为 `main@d4782f36`。exact merged image `sha256:f4add255...`
  只替换 production app/worker，仍为 `observe`；真实 API/worker attempt、cost ledger、pg-boss 与
  20s heartbeat 证据闭合，最终 running/runnable/live-admission=`0|0|0`。
- **PR #1154 正在收口。** branch `codex/yuk-832-evidence-readers` 普通 merge 最新 `origin/main`；
  resolution 必须同时保留 YUK-842 startup/steady permit、90s HTTP absolute deadline、atomic cost
  settlement，以及 #1154 的 toolTrace、全文 buffer、blind review/comparator fail-closed 与 failure usage
  lower bound。合并代码不部署，YUK-832 产品仍 HOLD。
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
- **LIGHT `7979514d` 已完成 exact-head CI 与一次 actual A01。** GitHub `CI Gate`
  run `30746982322`（含完整 test matrix）及 CodeQL 全绿；本机未运行完整 `pnpm test`。r9 中
  reference 首次即成功：324.608s、759,722 input / 25,048 output、USD 1.502762；相对 r8 的成功
  reference，input -29.7%、wall time -26.2%，并消除了前置 482s 失败 attempt。两条 comparator
  仍分别在 362.014s / 362.015s timeout，合计 3,778,904 input；现在分别如实记账 USD
  0.24765047 / 0.181446，而不是 0/null。最终仍为安全 `failed_closed`，因此产品 gate 保持 HOLD，
  不再重复昂贵 A01。r9 artifact SHA-256
  `ee7d562967cc95e829979bc4ed1f9d0ff1e65693237a774b4af4725de0d06d35`（本地 mode 0600）。
- **`read` gate 语义已钉住。** 它只指 Copilot 产品 DomainTool trace 的 `effect=read`：没有
  read attempt 才跳过 paid validator；只要尝试过 read（即使失败）就进入 FULL 并 fail closed；只有
  `executed=true && error_reason=null` 的成功 read 可被引用。validator 内部 submission tools 与
  Tavily remote-MCP 不属于这个判断面。
- 本轮不在本机运行 test/typecheck/lint/build/audit gate；合并验证只接受新 head 的 GitHub CI。

## NEXT

1. 完成 #1154 的 10 个 merge conflict，并在合并后的真实代码上修复或证伪 unresolved high/major
   review；child loom DomainTool read 必须有确定性测试证明进入同一 sealed review gate。
2. 普通 merge commit + push；只跑 exact-head GitHub CI 与独立 review。全绿且无 unresolved P0/P1
   后 merge #1154，但不部署 combined image，YUK-832 保持 In Progress / product HOLD。
3. FULL checkpoint 仍只在 owner 重新提升 YUK-839 时执行；当前不增加 provider budget、不重复 A01。
4. #1154 合并后关闭 Phase 0，再启动 Phase 1 practice-owned failure-learning vertical；UI 仍需独立
   design pre-flight。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；等待 Copilot 主产品链收口。
- **YUK-839 FULL checkpoint**：owner 已批准挂单；r9 comparator timeout 保留了实施理由，但不扩入
  当前 PR，也不自动启动。
- future/refinement backlog 不自动扩实施范围；到达时先核证 live consumer、重复与过期项。

## BLOCKED-ON

- **YUK-832 当前 gate**：LIGHT 已降低 reference 成本并补齐失败记账，但单次 actual A01 的两个
  comparator 仍 timeout；产品保持 HOLD。下一决定性解锁是 YUK-839 的跨 attempt checkpoint，
  owner 当前选择挂单；mock、本地 build 或重复烧同样本都不能替代。
- **YUK-596 产品 gate**：YUK-832–836 actual-output P1；transport/Stop 已 pass，不能用它替代
  产品内容正确性。
- **YUK-596 后续 owner gate**：产品 P1 与 actual rerun 完成后，先做 UI design pre-flight；
  owner 批准前不写 UI，也不翻 durable-default 扩量。
- **YUK-571 / YUK-405 / YUK-406**：等待真实内容、首次 placement 与真实观察窗口；synthetic/
  mock 不能冒充 owner 验收。YUK-452 是 parent/epic，须按 children 现实对齐。
- **严格 issue=0**：仍含 future、数据触发、生产 flip 与大 epic；最终需 owner 做
  keep/merge/cancel 裁决，不能靠连续写代码伪归零。
