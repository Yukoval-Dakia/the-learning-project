# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像 NOW / NEXT / PARKED / BLOCKED-ON。
> 更新于：2026-08-27（AI Pipeline Modernization F5 启动，基线 main @ f64f1389）

## NOW

- **F5 · Foreground root + ToolOperations / SubagentRuns 已启动（YUK-927）**。
  owner 裁决：1A 安全 remote MCP carve-out；2B durable mailbox 完成后 synthetic parent
  prompt 自动续跑 root；3A model/system/user 均可 cancel；4B 保留 not-material batching
  能力，但不得再宣称轮次、输入、耗时或成本收益。
- **固定架构**：根 Copilot 保持前台交互；普通 tool/MCP 默认阻塞；45 秒只对可安全观察的
  read/idempotent operation 交出 handle。`ToolOperations`、`SubagentRuns`、显式
  Cloud/Mission 保持三套独立身份；非 job 不写假 `job_events`。
- **三条隔离 lane 进行中**（均基于 `origin/main@f64f1389`）：
  - YUK-928：独立 `tool_operation` schema/migration + KnownEvent + wait/poll/cancel/lost foundation；
  - YUK-929：删除 `CopilotDispatchTask` 与默认预测分流，保留显式 202 durable path；
  - YUK-930：清理 Copilot drawer 面向用户的内部执行架构叙述。
- YUK-926 已按真实证据改名/重写并保持 Done；R4b 证据 PR #1302 已合并为 `f64f1389`，
  当前开放 PR 为 0（F5 lane 尚未开 PR）。

## NEXT

1. 独立 review + scoped gate 收口 YUK-928 / YUK-929 / YUK-930，顺序合并 exact-head CI。
2. YUK-928 后启动 YUK-931：45 秒安全 tool handoff + wait/poll/cancel；同时消费 YUK-920
   的 `toolUseId` 关联缺口，不重复立票。
3. YUK-928 + YUK-929 后启动 YUK-932：独立 SubagentRuns mailbox + one-shot synthetic
   parent continuation。
4. YUK-931 + YUK-932 后启动 YUK-933 drawer lifecycle projection；最后 YUK-934 删除迁移
   残留、同步 ADR/audit/PLAN 并收口 F5。

## PARKED

- 多 provider 方案一（YUK-921）维持方向批准、实施搁置；不混入 F5。
- YUK-572 夜间教研 agent shadow、YUK-832 HOLD 与 Architecture FULL 生产观察保持原状态。
- 本地脏 `main` 不清理、不覆盖；所有 F5 写入只在外接卷隔离 worktree。

## BLOCKED-ON

- Production rollout / observation 仍需独立授权。
- 本机 Data 卷仅余约 302 MiB；F5 worktree 与测试输出放外接卷，不安装依赖。若 scoped
  test 仍因系统临时空间失败，先按磁盘清理流程列候选并取得路径级批准。
