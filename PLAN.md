# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-08-01
> **【YUK-776：placement 在飞态僵尸恢复】**

## NOW

- **YUK-776 的 queued/running/verifying 恢复闭环随本变更交付。**
  - `question_supply_nightly` 里的 recovery sweeper 现在有三条独立 capped leg：
    `retry_scheduled` reap、in-flight reap、`pending_dispatch` re-drive。
  - `queued` 复用既有 120 分钟 queue expiry；`running/verifying` 以唯一 active attempt 的
    `lease_expires_at` 为权威。只有 lease 已失效且 owning pg-boss job 确认 non-live 才原子
    `interrupted` attempt、supersede authorized questions、`exhausted` claim。
  - in-flight reap 必须先于 pending re-drive；旧 job 已死时同轮释放 unique slot，仍 live 时
    pending→queued 的 savepoint 冲突会回滚 enqueue 并保留当前 revision claim，下一轮可重试。
  - 旧 worker 的 renew / mark-verifying / finish 都新增未过期 lease CAS，过期 fence 不能复活。
  - claim 与 attempt row lock 都用 NOWAIT；live writer 获胜，background recovery 不制造
    claim→attempt / attempt→claim 的 AB-BA 等待环。
- 本地只跑 scoped gate：3 个真实 Postgres 文件 101 tests 全绿；另有
  `pnpm typecheck`、`pnpm lint`、`pnpm build` 全绿。**未在本机运行完整 `pnpm test`**；完整
  gate 仍只认 exact-head GitHub CI。
- **YUK-814 已经 PR #1140 合并到 `main@6f91bab9` 并 Done。** complex-mock owner waiver
  只关闭 issue，不翻无人值守扩量 flag，也不改写历史 real canary 失败。

## NEXT

1. 为 YUK-776 提交 `Closes YUK-776` PR；exact-head GitHub CI 全绿且无未解决 P0/P1 后合并，
   同步 Linear Done 与 merge evidence。
2. 下一 session 从剩余产品 issue 中选一条独立 active lane；优先可自主验证的 reliability
   closeout，不把 YUK-571 的 owner real-content / first-placement 动作伪装成 agent 验收。
3. 继续对 backlog/Todo 做 product-scope triage：有 live consumer 的实施，无 live consumer、
   重复或过期项明确 Canceled / Duplicate；parent 在 children 处置后关闭。

## PARKED

- **YUK-813 / YUK-831 OpenCode**：按 owner 指示暂不处理；从产品执行队列排除，但仍计入
  Linear 严格 issue=0。
- **YUK-815 / YUK-816**：Grounding 后续协作与档案面；不与本次 placement reliability
  lane 混跑。
- 其余 future/refinement backlog 不自动开 implementation lane，先做 owner scope triage。

## BLOCKED-ON

- **无人值守 auto-intervention expansion**：YUK-814 的 issue-status waiver 不等于生产
  rollout 授权；未来翻 flag 仍须 owner 明示与届时认可的 actual-product-output evidence。
- **YUK-571**：等待 owner 真实内容、goal 与首次 placement 操作，agent 不代答。
- **严格 issue=0**：每次只推进一条 active 产品线；OpenCode parked 不等于已完成。
