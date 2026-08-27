# 当前 handoff — 2026-08-27 AI Pipeline Modernization F5 启动

## Owner decisions

- 1A：read/idempotent remote MCP 超过 45 秒可交出真实 handle；不可安全取消的 write/propose
  继续阻塞到 turn deadline，未知结算写 `lost` 与 side-effect risk。
- 2B：background subagent 完成后写 durable mailbox/result event，并以幂等 synthetic parent
  prompt 自动续跑 foreground root；用户面仍只有 root 一个声音。
- 3A：model + system drain + user 都可 cancel；取消是 cooperative，不把未知结算说成成功取消。
- 4B：保留 #1299 batching 文案作为中性能力偏好；删除全部性能收益叙事。YUK-926 已按此
  改名/重写并保持 Done。
- UI 已批准；新增要求：drawer 不展示 sequence/async/durable/inline/model-routing/agent
  architecture 等内部说明，只保留用户需要的状态、结果、错误与动作。

## Tracker

- Parent：YUK-927（In Progress），Project = Architecture Deepening FULL，Milestone = F5。
- Active：YUK-928 ToolOperations foundation；YUK-929 classifier deletion；YUK-930 UI copy cleanup。
- Blocked chain：YUK-931 <- 928；YUK-932 <- 928+929；YUK-933 <- 931+932；
  YUK-934 <- 931+932+933。
- Existing dedupe：YUK-920 由 YUK-931 消费；YUK-757 只覆盖旧 foreground subtask
  projection；YUK-572 是夜间教研 agent，不是 Copilot SubagentRuns。

## Git / worktrees

- origin/main = `f64f1389`（PR #1302 merged）；本地 main 仍为脏旧树，落后 45 commits，
  禁止 reset/clean/overwrite。
- `/Volumes/YukovalSBak/yukoval-projects/the-learning-project-worktrees/f5-20260827/yuk-928`
- `/Volumes/YukovalSBak/yukoval-projects/the-learning-project-worktrees/f5-20260827/yuk-929`
- `/Volumes/YukovalSBak/yukoval-projects/the-learning-project-worktrees/f5-20260827/yuk-930`
- 本 board sync 在同目录 `yuk-927` worktree。

## Safety / validation

- 禁止本机完整 `pnpm test`；各 lane scoped unit/DB/migration + Biome，root 串行跑
  typecheck/lint/audits/build，push 后 exact-head GitHub CI Gate。
- 系统 Data 卷在启动时只余约 117 MiB；把两个新 worktree 从 `/private/tmp` 以 Git
  非强制 remove/re-add 迁到外接卷后约 302 MiB。没有删除用户缓存、旧 worktree 或数据。
- 不部署、不做生产观察，除非另获授权。
