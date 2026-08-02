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
- **YUK-832 transport/CI 已通过，产品内容仍 HOLD。** PR #1154 的 `9a7be1b6`
  exact-head CI/CodeQL 全绿；后续 A01 actual 已证明 360s 足够，瓶颈不是 transport，而是要求
  provider 一次生成 12k–18k tokens 的交叉索引大 JSON。`647cc42e` 隔离 r2 的两条 reference
  依次触发 source_refs>12 与 absent pointer；artifact SHA-256
  `0d8ea034ad3da9462a00b7c9e0d1fdea1bc7e71006b12c9a8f89ff3dd9055459`（mode 0600）。
- **Owner 已批准试 FULL 小提交协议。** 不增加第三次整段重写；blind leg 改为 append-only
  evidence/not-material/safe-reply 工具，comparator 改为逐 reply check 工具。server 用短 source id
  还原 JSON Pointer，并生成 point/request/trace coverage、request checks、digest 与 verdict；模型
  不再输出最终大 JSON。`9c43ab8e` 的 targeted gate 与 exact-head CI Gate 30739496669 已全绿。
  首个隔离 A01 正确安全 fail closed：primary 成功并有 thinking，但两条 blind reference 都在
  `maxTurns=4` 精确终止，未进入 comparator。artifact SHA-256
  `95855eef09b80d30634df35dc459340ba1e8d29dc4b08dbd4b8661ada27da7fa`（mode 0600）。这证明
  小提交方向已消除大 JSON 绑定失败，但 4-turn 注册表预算与“分批追加 + explicit complete + terminal”
  协议自相矛盾；现按封闭协议上限改为 reference 16、comparator 18，不增加 paid attempt。
  `c8bd8761` 的 blind reference 随后成功绑定（9 thinking blocks）；两条 comparator 则均在约 122s
  撞原 120s ceiling。artifact SHA-256
  `c72ed9063eee759530b39b35df13c0e75585cea6041ef62665972f25a4dd1fb5`（mode 0600）。`3ad1f0f9`
  再次成功绑定 blind，但第一条 comparator 又在 242s 撞 240s；随后旧 harness 14min monitor
  先于产品 ceiling 到期，本次不算产品 verdict。partial artifact SHA-256
  `55ca0f71287615ce59fc3d758690786d79e03735d90c066c055c6d59ce3dfe97`（mode 0600）；遗留 job/run
  已按产品取消语义终态化。现仅把 durable comparator 对齐 360s，并同步实际 harness 观察窗；
  inline 仍 120s，attempt 数与契约不变。`ef5789a7` + 52min monitor 的 A01 随后正常终态：第一条
  blind 撞 360s，第二条在 263s 先撞精确 `maxTurns=16`；artifact SHA-256
  `94f7d9743a71190642d62cb51913de2e93afd7991a2a5b4e4e1e763ecff4e073`（mode 0600）。现只把
  两个 FULL task 的 turn ceiling 统一为 24，paid wall-clock 不变，并记录无原文的提交进度计数。
- 未在本机运行完整 `pnpm test`；后续仍只用 targeted local loop + exact-head GitHub CI。

## NEXT

1. 验证 actual A01 暴露的 24-turn correction ceiling；保持 360s paid wall-clock、两次 bounded
   attempt、既有 fail-closed binding、blind isolation、inline 120s 与 confirmed comparator 状态机。
2. 新 exact-head CI 全绿后，在 clean committed exact head 重跑 A01；自动 gate 通过后才重跑 5 例 actual-provider v8，逐例审计 primary +
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

- **YUK-832 当前 gate**：FULL 小提交 exact-head GitHub CI + actual-provider v8 +
  人工 2/2/2；mock、本地 build 或旧 head CI 都不能替代。
- **YUK-596 产品 gate**：YUK-832–836 actual-output P1；transport/Stop 已 pass，不能用它替代
  产品内容正确性。
- **YUK-596 后续 owner gate**：产品 P1 与 actual rerun 完成后，先做 UI design pre-flight；
  owner 批准前不写 UI，也不翻 durable-default 扩量。
- **YUK-571 / YUK-405 / YUK-406**：等待真实内容、首次 placement 与真实观察窗口；synthetic/
  mock 不能冒充 owner 验收。YUK-452 是 parent/epic，须按 children 现实对齐。
- **严格 issue=0**：仍含 future、数据触发、生产 flip 与大 epic；最终需 owner 做
  keep/merge/cancel 裁决，不能靠连续写代码伪归零。
