# 当前 handoff — 2026-07-25 收尾

## 现在在哪

- **权威主线**：`origin/main` = `3f01d838`（#1068 / YUK-594 W1+W2）。
- 本 session（07-24 深夜 ~ 07-25）**合并 18 个 PR、16 张票 Done**：YUK-770/769/768/765/763/608/562/444/230/229/758/594/775/782/761/781。明细见 `.remember/today-2026-07-25.done.md`，看板见 `PLAN.md`。
- **在飞 2 个 PR，都还没合**（上一版 handoff 的「本波 0 open PR」已过期，勿再引用）：
  - **#1074**（YUK-783，Biome 禁 capability UI 直取 contract-schemas barrel）— mergeState=UNSTABLE，等 CI。
  - **#1076**（YUK-779，夜链静默空跑 attempted vs succeeded 可见性）— mergeState=**DIRTY，需先 rebase**。
- 主工作树 owner-dirty（owner 本机工具配置），本 session 全程只在隔离 worktree 作业，未动主工作树。

## 下一步该干什么

1. **收口两个在飞 PR**（#1076 先 rebase 再看 gate；#1074 等 CI）。合并前按惯例单独读 bot inline threads，别把 thread-check 和 `gh pr merge` 塞一条命令。
2. **主 lane：YUK-777（High）** — durable judge W3 的 A 段。做完才允许翻 `JUDGE_DURABLE_ENABLED`；A 段 = 客户端幂等键 / record-unjudged-at-submit / domain-scan sweeper / DLQ 再入队。
3. **接着 YUK-778（High）** — 夜链 DAG 次级加固（tick 队列 retryDelay+DLQ / 日志可观测 / stale 标记空转）。
4. 快通道小票：**YUK-776**（Medium，placement 在飞态僵尸）；D-ballot 剩余 **YUK-771/772/773**；07-23 队列剩余 **YUK-437/679/757** + 测试跟进 **YUK-764**。
5. **YUK-774 / YUK-784 是 UI 票**：必须先做 design-doc pre-flight 并等 owner 批准，不得直接开工。

## 有什么坑

- **不要翻 `JUDGE_DURABLE_ENABLED`**：W1+W2 已在 main 但默认 OFF、零行为变化；YUK-777 A 段未清前翻 flag 会真丢判分数据（`Tu71c` 是实证的数据丢失，不是理论风险）。
- **部署注记仍有效**：生产 rollout 前需设 `JUDGE_PROVENANCE_SECRET`（`openssl rand -hex 32`，**≠ INTERNAL_TOKEN**）。
- **YUK-590 / YUK-755 metadata-only SLA** 仍待 operator：Linear UI 或 authenticated GraphQL **同时清** `slaBreachesAt` 与 `slaType`，**不得 reopen** 这两张 Done issue。Agent 侧已多次确认无法安全清除，别再重试同一条死路。
- **死 worktree 待清**：本 session 18 个 lane worktree（+ `yuk-594-w1w2-r3`、`yuk-229-ssrf-fix`）已随合并作废仍 pin 着分支；全仓另有 100+ 历史 worktree。仍活的只有 agent-a9d3794f7df453cf6（yuk-783）、agent-a2da146e50c080770（yuk-779）、agent-aa45ca5635aa08991（effect-slice，等 YUK-766）。
- **陈年 PR #1019**（YUK-384 期 cockpit）已被此后多轮 cockpit 同步取代，待核后关；Dependabot #1012-1016 仍未核。
- **YUK-751 effect-slice 别提前开**：硬前置是 YUK-766 三道门的**实施**（checkpoint/delivery 进备份 + principal 类型层 + 幂等契约成文）。
- **Linear 状态保真**：YUK-783 目前是 In Progress 但 PR 已在评审、YUK-779 是 In Review；收口时当场对齐，别留假状态。
