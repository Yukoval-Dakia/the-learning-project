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
- **YUK-832 exact-head transport/CI 已通过，产品内容仍 HOLD。** PR #1154 的
  `9a7be1b6` exact-head CI/CodeQL 全绿。该 head 的 A01 actual 重放已证明 240s 窄化修复越过
  原 120s timeout，但两次完整返回都因非 strict JSON envelope 被拒；确认重复后主动停止其余
  付费样本；`1d48d4d3` 的单-fence 适配仍未命中真实 wrapper。当前改为复用项目既有的
  structured-task 单 JSON 对象提取器后，`6fbf9c1e` actual 已进入 Zod 并暴露 provider 自创
  protocol/type/status；确认首例后 Stop。当前给 Xiaomi no-native-outputFormat prompt 补 exact
  schema shape 后，`55151d5d` actual 已通过 schema 并收窄到 source pointer 指向非空容器；
  首例即 Stop。`f9e49f1c` 把 scalar/null/显式空容器终点写成 hard rule 后，A01 首个 actual
  reference 仍重复同一 binding 错误，证明静态 prompt 不足，已 Stop。当前让既有第二次 attempt
  只收到 server 生成的有界固定契约错误，不含前次输出或新证据；每次 input/hash 独立绑定，
  多对象/Zod/server binding 仍 fail closed。`41503da5` actual 的第一条 reference 在 218.88s
  完整返回并触发反馈；第二条在 242.01s 被 240s 上限截断。当前只把 durable reference 尾部
  调到 300s；`b1290371` 第二条已在 253s 完整返回并修掉首条 pointer error，但新输出把 4 个
  request coverage 标为 answerable 却给空 evidence indices，server 正确拒绝。当前只把 schema
  已有的“非空 + 与 ledger exact-set 相等”条件写入通用 prompt；`0bcd6494` 的第二条又在 302.01s
  撞到 300s 尾部，未产生输出。当前只调到 360s；FULL 最坏 20min、owner ceiling 32.5min，
  `19e72433` 两条已在 203.46s/168.59s 完整返回，transport 足够；第一条 JSON syntax invalid，
  第二条把 3 个 json_pointer 写成空字符串。当前只给 SyntaxError 固定反馈并逐字禁止 root pointer，
  不加第三次 attempt、不放宽 binding。
- 未在本机运行完整 `pnpm test`；后续仍只用 targeted local loop + exact-head GitHub CI。

## NEXT

1. 完成 validator fixed syntax feedback + non-root pointer prompt 的 commit/push 与 exact-head GitHub CI；包装 prose
   丢弃，不改 inline/comparator 预算与 server binding。
2. 先在 clean committed exact head 重跑 A01；自动 gate 通过后才重跑 5 例 actual-provider v8，逐例审计 primary +
   reference/comparator runs、thinking、digests、exact bytes 与无旁支 validator。
3. actual 5/5 且人工 grounding/coverage/honesty 均 2/2/2 后，
   merge 并对齐 Linear；随后推进 YUK-833/835 → YUK-834 → YUK-836。
4. 每条继续用同一复杂 fixture 做 targeted mock/DB loop，再做最小 actual-provider 重放；完整 suite
   只在 exact-head GitHub CI。
5. 产品 P1 清零后，Dock/UI 开工前逐字引用 design doc、声明 drawer、列文件并等待 owner 批准。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；等待 Copilot 主产品链收口。
- future/refinement backlog 不自动扩实施范围；到达时先核证 live consumer、重复与过期项。

## BLOCKED-ON

- **YUK-832 当前 gate**：bounded contract-feedback exact-head GitHub CI + actual-provider v8 +
  人工 2/2/2；mock、本地 build 或旧 head CI 都不能替代。
- **YUK-596 产品 gate**：YUK-832–836 actual-output P1；transport/Stop 已 pass，不能用它替代
  产品内容正确性。
- **YUK-596 后续 owner gate**：产品 P1 与 actual rerun 完成后，先做 UI design pre-flight；
  owner 批准前不写 UI，也不翻 durable-default 扩量。
- **YUK-571 / YUK-405 / YUK-406**：等待真实内容、首次 placement 与真实观察窗口；synthetic/
  mock 不能冒充 owner 验收。YUK-452 是 parent/epic，须按 children 现实对齐。
- **严格 issue=0**：仍含 future、数据触发、生产 flip 与大 epic；最终需 owner 做
  keep/merge/cancel 裁决，不能靠连续写代码伪归零。
