# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-01
> **【YUK-759 已交付；NEXT YUK-772】**

## NOW

- **YUK-759 已 Done。** PR #1143 合并到
  `main@7b2008ef46df02eabe1b7629c8ebafebf7b35cdc`：`SemanticJudgeTask` 与同票
  waiver 的 `UnitDimensionFallback` 现在都从 registry 的核心 Zod schema 生成
  `outputFormat`，非空 `structured_output` 优先，null/absent 继续走旧 text
  char-scan；schema-invalid structured product 不会被合法 text 掩盖。
- calibration sampler 在 SDK text 为空时仍保存 structured rejudge product / task-run id；
  structured-judge allowlist 已清为 `{}`，四个 judge task 全部声明 schema。
- 复杂《报任安书》论证题与复合 SI 单位 scoped mock、相关 judge 回归、真实 Postgres
  calibration、strict golden、typecheck、lint、build 全绿；独立复核无 P0/P1。PR exact-head
  CI Gate `30687352999` 与合并后 main CI Gate `30687647155` 全绿。
  **未在本机运行完整 `pnpm test`**；无 UI、部署、feature-flag 或真实付费调用。
- 2026-08-01 live Linear：Backlog 84、In Progress 4、Todo 1，严格未完成共 **89**；排除
  owner 指示 parked 的 OpenCode YUK-813 / YUK-831 后，当前产品执行口径 **87**。

## NEXT

1. 下一独立 session 启动 **YUK-772**：在 KnownEvent union / shared base 建统一
   fail-closed 闸门（`actor_kind='user' ⇒ actor_ref='self'`），逐 kind / writer 盘点豁免，
   并用复杂多 kind user/agent 数据覆盖；同票收口 provenance secret 最小长度守卫。
2. YUK-772 scoped validation、独立 review、exact-head GitHub CI 全绿后自主合并，并同步
   Linear、`PLAN.md`、`.remember`；完整 `pnpm test` 仍只在 GitHub CI 跑。
3. 继续按产品价值处置 backlog/Todo：优先可自主验证的可靠性闭环；重复、过期或没有
   live consumer 的项先核证再 Canceled / Duplicate，parent 在 children 处置后关闭。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；不与当前产品 reliability lane 混跑。
- 其余 future/refinement backlog 不自动开 implementation lane，先做 owner scope triage。

## BLOCKED-ON

- **无人值守 auto-intervention expansion**：YUK-814 的 issue-status waiver 不等于生产
  rollout 授权；未来翻 flag 仍须 owner 明示与届时认可的 actual-product-output evidence。
- **YUK-571 / YUK-405 / YUK-406**：等待 owner 真实内容、首次 placement 与观察窗口；agent
  不代答、不把 synthetic/mock 伪装成真实 owner 验收。
- **YUK-452**：parent/epic，须先对齐未完成 children，不能用单条代码变更直接关单。
- **严格 issue=0**：每次只推进一条 active 产品线；OpenCode parked 不等于已完成。
