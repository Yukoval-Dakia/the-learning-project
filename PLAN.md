# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-20　·　历史头部日志（2026-06-23 ~ 07-19）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真）。

> **【更新 2026-07-20 · 快速 lane 收口 + 最终 cockpit 对账】** YUK-595 / PR #1002 已 squash-merge `d0b5a9e9`，YUK-744 / PR #1004 已 squash-merge `ca0f2cd7`，两票均为 Done。#1002 exact-head CI 与独立验证通过，但 OCR 在 10:13:03 新发两条性能 thread，合并于 10:13:49 发生，driver 未让新增 thread 数阻断命令；两条随后回复并 resolve，性能债完整捕获为 YUK-745。Owner 已明确授权删除 Node 22、整体迁移公开/runtime contract 到 Node 24；#1003 的旧合同 thread 已 resolved，当前真实阻断仅为 lockfile 缺项及 exact-head CI/OCR 重跑。Docker 已清理：images 22.7 GB → 461.2 MB、build cache 31.27 GB → 0；volumes 未清理。官方 Linear MCP 的 priority 分区结果被证明严重截断（仅 137 票且漏 YUK-745、错误返回无下一页），因此不发布伪精确总数；当前只保留早先全量快照与已知变更推导的下界作 sanity check。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。两条主 project 仍是：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。

## NOW（当前 active 线）

- **driver 仅做 cockpit / handoff 对账**：没有 merge-ready implementation lane；不再启动新实现线。
- **PR #1003 / YUK-686**：owner 已授权删除 Node 22，并已在 `f1ed3662` 同步 Node 24 公开合同；当前 frozen install/Rust parity 因 lockfile 缺 `@types/node@22.19.18` 失败，OCR 为外部 TLS 下载失败。修 lockfile 后 exact-head 重跑，不恢复 Node 22 lane。
- **Linear 全量重数受阻**：官方 MCP 按 priority 0–4 分区仅返回 137 票并全部错误标为 `hasNextPage=false`，且漏掉已知 YUK-745，无法生成可信全量数。早先快照加已知最小变更的 sanity 下界为 total 745 / Done 620 / Backlog 89 / In Progress 11 / Canceled 17 / Duplicate 8（strict open 100）；这不是宣称无其他并发变更的精确现值。
- **owner 工作树保护**：主工作树 `.codex/*`、`AGENTS.md` 与两份未跟踪 design doc 不 stage、不改写、不清理。

## NEXT（就绪，排队）

- **完成驾驶舱提交**：Linear MCP 截断故障与可信下界已回填；仅提交 `PLAN.md`，`.remember/now.md` 作为本地 handoff 更新，不强行纳入 Git。
- **YUK-354 umbrella**：A3 的 YUK-595 已完成；后续是否 close/收窄须按剩余 acceptance 重新 ground，不在本轮代判。
- **研究板作为完整入口**：继续以 `docs/planning/2026-07-20-backlog-reconciliation.md` 承载需要研究、设计或 owner judgment 的票，不从 cockpit 临时开新实现线。

## PARKED（已捕获，不是现在）

- **YUK-392**：已 ground 为移除 QuizGen/sourcing whole-batch `kindsMatch` 拒收并修正文案的 bounded lane；是否同时移除更新的 Jyeoo per-row filter 需要 owner 判断，决定前不实施。
- **YUK-745**：wrong-streak reader 的 semantics-safe 性能优化；keyset pagination/early stop、批量或有界并发 metadata reads、trigger-time bound、提前 `already_nudged`。不得改变 arbitrary `STREAK_N`、exclusion-before-break、cooldown、deterministic winner 与 unsupported/correction/appeal 语义。
- **PR #1003**：Node 24 迁移决策已拍；只待 lockfile 修复、exact-head CI/OCR 与复审收口。
- **YUK-555**：hard-cap acceptance 未保真迁入 YUK-605 或命名 successor 前不得取消或改写。
- **研究板其余项目**：owner/product/scientific、design preflight、architecture/research、external/ops、data/statistics 与 large-program 六类继续 parked，见 backlog reconciliation 文档。

## BLOCKED-ON（在等什么）

- **PR #1003 / YUK-686**：不再 blocked-on 产品决策；Node 24 迁移已获 owner 授权。仅 blocked-on 修复 broken lockfile（缺 `@types/node@22.19.18`）并在新 immutable head 重跑 required CI、Rust parity、OCR 与 threads 检查。
- **YUK-392 Jyeoo 边界**：等 owner 判断是否把带显式 telemetry/acceptance 的新 Jyeoo per-row filter 纳入同一行为变更。
- **YUK-605 supply/ADR drift 批**：YUK-555 hard-cap acceptance 必须保真迁移后才可 conditional-cancel。
- **profile P2 / A9 step-grading**：仍分别等待 misconception/judge 数据校准证据。

## 在飞（PRs / workflows / worktrees）

- **PR 在飞：2**：[#1003](https://github.com/Yukoval-Dakia/the-learning-project/pull/1003) `yuk-686-min-node-ci-dedup` → `main`，head `f1ed3662`，Node 24 决策已拍、合同 thread 已 resolved，待 lockfile 修复与 exact-head gates；[#1005](https://github.com/Yukoval-Dakia/the-learning-project/pull/1005) 为本 docs-only cockpit 修正。
- **明确锁定的 worktree**：`/Users/yuqi/yukoval-projects/the-learning-project/.claude/worktrees/pr1000-ci-dedup`（#1003 active session）；Linear 重数 agent 的临时 worktree由 harness 管理。不得删除或复用。
- **本地主工作树保护清单**：`.codex/hooks.json`、`AGENTS.md`、`.codex/hooks/codex-remember-session-start.sh`、`.codex/hooks/codex-remember-stop.sh`、`.codex/hooks/codex_extract.py`、`.codex/hooks/resolve-remember-plugin.sh`、`docs/design/2026-07-18-jyeoo-supply-selection-matching-design.md`、`docs/design/2026-07-19-evidence-supply-v2-architecture.md`。
- **Docker 当前轻量快照**：2 images / 461.2 MB、build cache 0；containers 0；volumes 5 / 542 MB。此前运行中的测试容器已退出；volumes 仍按指令未清理。

## ✅ 最近已落（防遗落，下次别重做）

- **YUK-595 same-KC wrong-streak（PR #1002）**：merged `d0b5a9e9`、Linear Done；focused TDD unit 8/8、DB 34/34、streak DB 24/24，exact-head required CI 与独立 verifier 通过。合并前 46 秒新增 performance threads 未被 gate 正确阻断是已记录的 driver 错误；最终 threads=0，follow-up 为 YUK-745。
- **YUK-744 unused AI SDK roots（PR #1004）**：merged `ca0f2cd7`、Linear Done；仅移除 `ai` / `@ai-sdk/anthropic` root edges，Claude SDK/provider wiring 保持，exact-head CI/review 通过，threads=0。
- **YUK-584 evidence refs（PR #1000）**：merged `c35ccb20`、Linear Done；validator optional hardening 已捕获为 YUK-742。
- **YUK-556 structured reference solution（PR #998）**：merged `b3fbd1fd`；effective exact/semantic judge route 均要求结构化 reference solution。
- **Dependabot queue**：#953/#954/#1001 已合；不安全 Undici 8 由 YUK-743 承接；废弃 AI SDK majors 已关闭并由 YUK-744 删除根依赖。
- **Docker 空间清理**：执行 unused image 与 builder cache prune，保留 volumes；清理后 images 461.2 MB、build cache 0。
