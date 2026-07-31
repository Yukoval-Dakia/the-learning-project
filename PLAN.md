# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-01
> **【YUK-814：owner-approved complex mock closeout】**

## NOW

- **YUK-814 已按 owner 2026-08-01 新口径验收并在 Linear 置 Done。**
  - owner 明确以 agent 自跑 complex mock 作为本 issue 的 closure gate，取代旧的
    fresh 10-run real-product closeout 条件。
  - clean `main@931b1742` 上 scoped mock gate 为 3 files / 41 tests 全绿；复用
    101,764-byte、1,137-line 六案例 regression packet（数学/语文/通用推理，3 个应拒绝
    + 3 个正控制），SHA-256
    `85af0488411ae2099f1a804a16a999444ce7bc11eadd09c6debae6a188106530`。
  - 这是 YUK-814 issue-status waiver，不把历史失败 canary 改写成成功，不把
    `satisfies_yuk_814_canary` 改为 true，也未翻
    `AUTO_INTERVENTION_EXPANSION_ENABLED` 或部署无人值守扩量。
- **YUK-829 已在 PR #1139 合并为 `main@931b1742` 并 Done。** FULL reviewer 的共享
  validator、blind solve、V3 provenance 与 fail-closed comparator 已成为当前基线。
- 当前 closeout branch：`codex/yuk-814-mock-closeout`；只同步版本化决策、cockpit 与
  Linear 证据，不修改产品运行时。

## NEXT

1. push 本 closeout PR，由 exact-head GitHub CI 跑完整 gate；合并后不做生产 flag 变更。
2. 下一条可自主推进的产品可靠性 issue：**YUK-776**。用
   `placement_starter_attempt.lease_expires_at` 回收 queued/running/verifying 僵尸，解除
   `(goal, subject)` 后续 revision 被 nonterminal unique index 永久阻塞的问题。
3. human-in-loop：YUK-571 等 owner 导入真实内容并亲自完成首次 placement；
   YUK-405/YUK-406 等两周真实使用验收。
4. 继续对 backlog/Todo 做 product-scope triage：有 live consumer 的实施，无 live
   consumer、重复或过期项明确 Canceled / Duplicate；parent 在 children 处置后关闭。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；先完成更窄的 YUK-776。
- 其余 future/refinement backlog 不自动开 implementation lane，先做 owner scope triage。

## BLOCKED-ON

- **无人值守 auto-intervention expansion**：YUK-814 的 issue-status waiver 不等于生产
  rollout 授权；若未来要翻 flag，仍须单独取得 owner 明示并提供届时认可的
  actual-product-output release evidence。
- **YUK-571**：等待 owner 真实内容、goal 与首次 placement 操作，agent 不代答。
- **严格 issue=0**：YUK-814 Done 后仍需逐张处置其余未完成 issue；“暂不处理”不等于完成。
