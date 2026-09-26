---
name: swarm
description: 并行 worker fan-out：把同一 brief 切成 N 条独立 slice 或 race，一条消息里全部 background dispatch，等全部终端态后聚合成一份报告（不转发原始 dump）。Use when user says "swarm", "/swarm", "并行跑 N 个", "fan out", or a verification/scan/port task cleanly partitions into independent slices or competing attempts.
---

# Swarm

pstack `swarm` 的本仓库移植。原则：**先证明单个 worker 可信，再开 N 个**（验证密度决定并行上限）。

## 前置

- 明确 done predicate + 每条 worker 必须返回的报告格式 + worker 数量。race 模式还要先定选择规则（`first pass` / `rank all` / `best-of`），发出前固定。
- 每条写 worker 必须有**独立可写位置**（独立 worktree/branch/文件集），写重叠一律串行不 swarm——AGENTS.md：同一 diff 不派两个 writer。
- 验证类 brief 必须含确切 SHA/范围；测量类 brief 必须含测量方法。

## Dispatch

- 一条消息里发全部 N 个 `subagent(..., background: true)`。
- 写 lane → `implementer`（目标明确但需本地调查）或 `fixer`（路径+验收已定）；只读验证/扫描 → `explorer`；外部事实 → `librarian`。不许让两个 writer 写同一文件集。
- 每条 worker prompt 独立成文：目标、scope（文件/边界）、slice/race 参数、验证要求、**报告格式**。

## Worker 报告契约

`PASS` / `ISSUES` / `BLOCKED` 三档 + 证据指针（SHA、`file:line`、命令输出、artifact 路径）。证明了缺陷的 worker 必须报出**全部**已证实问题，不许只报首个。掉线/失败记为 dropout，run 缩为 N-1 并在报告里注明。

## 聚合

1. 等全部终端态（不靠 polling，靠完成通知）。
2. 缺必需字段（SHA/方法/报告格式）的结果驳回重跑一次；二次仍缺 → 记 gap，不算过。
3. 每个 slice 都要有结果才谈 coverage；race 按预先固定的选择规则裁决。
4. 输出：紧凑表格（slice → 状态 → 证据）、逐条已证实问题一行一条、gap/dropout 清单。**不转发 worker 原始输出**。

## 不做的事

- ❌ 并行跑有写重叠的 worker。
- ❌ 把 worker 的 "done" 自报当结论——证据指针必须可解。
- ❌ swarm 内部做 merge/conflict 解决——slice 间依赖在切分时消掉，消不掉的不并行。
