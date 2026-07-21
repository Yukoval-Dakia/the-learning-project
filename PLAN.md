# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-21　·　历史头部日志（2026-06-23 ~ 07-19）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真）。

> **【更新 2026-07-21 · 快速收票终局：4 票 Done，YUK-384 停止错误 quick-fix】** 本轮原票 YUK-366/#1011、YUK-584/#1008、YUK-460/#1007、YUK-392/#1010 已合并并回读 Linear Done，renewed pass 新建 issue = 0。YUK-384/#1009 在 12 个 pushed head 后经 13 席闭世界 grounding 判定 `REDESIGN_REQUIRED`：旧 deferred patch 可覆盖较新 nightly apply、flush 先清队列会丢失败项/后缀、resident coalescing 无法约束 drained/in-flight 旧 actor work、scheduled sync 绕过 fresh presence、PG/in-memory 状态机不等价，且无统一 durable reconciliation obligation。#1009 已关闭未合并，6 个未提交实验修改已丢弃；YUK-384 已保留完整失败矩阵并退回 Backlog，不创建 successor。当前开放 PR 仅 #1012-1016 Dependabot；主工作树 owner/concurrent 修改未触碰。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。两条主 project 仍是：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。

## NOW（当前 active 线）

- **快速收票实现线已结束**：YUK-366、YUK-584、YUK-460、YUK-392 均已 merge + Linear Done；YUK-384 经闭世界 grounding 退回 Backlog，PR #1009 关闭未合并。当前不再启动该 quick-fix 的实现轮。
- **Backlog 净额口径**：起点 open 106；此前已推导净减 7，renewed pass 再关闭 4 张原票且新建 0，故无其他并发变更时 sanity estimate 为 open 95、累计净减 11。Linear 全局 list 已证实截断，以上不是权威精确总数。
- **owner 工作树保护**：主工作树 `.codex/*`、`AGENTS.md`、并发源码修改与两份未跟踪 design doc 不 stage、不改写、不清理。

## NEXT（就绪，排队）

- **YUK-384 redesign（原票保留）**：闭世界失败矩阵已写回 Linear。下一次开工必须先设计 durable claim/ack/retry、per-actor generation fence、统一 editor-safe ordering boundary、PG/in-memory parity 与 centralized dirty/outbox；不得从 #1009 分支继续堆 enqueue/presence 补丁。
- **YUK-354 umbrella**：A3 的 YUK-595 已完成；后续是否 close/收窄须按剩余 acceptance 重新 ground，不在本轮代判。
- **研究板作为完整入口**：继续以 `docs/planning/2026-07-20-backlog-reconciliation.md` 承载需要研究、设计或 owner judgment 的票，不从 cockpit 临时开新实现线。

## PARKED（已捕获，不是现在）

- **YUK-384**：闭世界 grounding 已证明现有 quick-fix 协议不成立；完整反例与 redesign invariants 保留在原票，退回 Backlog，下一轮先设计后实现。
- **YUK-745**：wrong-streak reader 的 semantics-safe 性能优化；keyset pagination/early stop、批量或有界并发 metadata reads、trigger-time bound、提前 `already_nudged`。不得改变 arbitrary `STREAK_N`、exclusion-before-break、cooldown、deterministic winner 与 unsupported/correction/appeal 语义。
- **YUK-555**：hard-cap acceptance 未保真迁入 YUK-605 或命名 successor 前不得取消或改写。
- **研究板其余项目**：owner/product/scientific、design preflight、architecture/research、external/ops、data/statistics 与 large-program 六类继续 parked，见 backlog reconciliation 文档。

## BLOCKED-ON（在等什么）

- **YUK-384 / hub sync**：等待重设计证明 durable ownership、generation ordering、editor isolation、adapter parity 与 durable reconciliation；#1009 的旧实现不再作为起点。
- **YUK-605 supply/ADR drift 批**：YUK-555 hard-cap acceptance 必须保真迁移后才可 conditional-cancel。
- **profile P2 / A9 step-grading**：仍分别等待 misconception/judge 数据校准证据。

## 在飞（PRs / workflows / worktrees）

- **实现 PR 在飞：0**：YUK-384 PR #1009 已关闭未合并；当前开放 PR #1012-1016 均为 Dependabot。此 cockpit closeout branch 尚未开 PR。
- **保留 worktree**：YUK-384 专用 worktree `agent-a6c6cadc778410ba4` / branch `yuk-384-hub-auto-sync-mutation-enqueue` 已清理为 clean，仅保留未合并历史供追溯，不得作为 redesign 起点。Cockpit closeout branch 为 `cockpit-yuk384-redesign-closeout`。
- **本地主工作树保护清单**：`.codex/hooks.json`、`AGENTS.md`、`.codex/hooks/codex-remember-session-start.sh`、`.codex/hooks/codex-remember-stop.sh`、`.codex/hooks/codex_extract.py`、`.codex/hooks/resolve-remember-plugin.sh`、`docs/design/2026-07-18-jyeoo-supply-selection-matching-design.md`、`docs/design/2026-07-19-evidence-supply-v2-architecture.md`。
- **Docker 当前轻量快照**：2 images / 461.2 MB、build cache 0；containers 0；volumes 5 / 542 MB。此前运行中的测试容器已退出；volumes 仍按指令未清理。

## ✅ 最近已落（防遗落，下次别重做）

- **快速收票 renewed pass**：YUK-366/#1011、YUK-584/#1008、YUK-460/#1007、YUK-392/#1010 均 merged + Linear Done；本 pass 关闭原票 4、新建 0。
- **YUK-384 redesign stop（PR #1009）**：13 席闭世界 grounding 判定 `REDESIGN_REQUIRED`；PR 已关闭未合并，6 个实验修改已丢弃，原票保留失败矩阵并退回 Backlog。
- **YUK-686 Node 24 runtime contract（PR #1003）**：merged `f6b6ad0b`、Linear Done；最终 exact head `7eba3ee6` 保持 current-main 依赖 resolution，frozen install、完整 CI、Rust parity、OCR 与独立 verifier 通过，threads=0；未恢复 Node 22 lane。
- **Cockpit 对账（PR #1005）**：merged `57c5edde`；记录 Linear MCP 截断、backlog 毛/净额与 owner Node 24 决策。
- **YUK-595 same-KC wrong-streak（PR #1002）**：merged `d0b5a9e9`、Linear Done；focused TDD unit 8/8、DB 34/34、streak DB 24/24，exact-head required CI 与独立 verifier 通过。合并前 46 秒新增 performance threads 未被 gate 正确阻断是已记录的 driver 错误；最终 threads=0，follow-up 为 YUK-745。
- **YUK-744 unused AI SDK roots（PR #1004）**：merged `ca0f2cd7`、Linear Done；仅移除 `ai` / `@ai-sdk/anthropic` root edges，Claude SDK/provider wiring 保持，exact-head CI/review 通过，threads=0。
- **YUK-584 evidence refs（PR #1000）**：merged `c35ccb20`、Linear Done；validator optional hardening 已捕获为 YUK-742。
- **YUK-556 structured reference solution（PR #998）**：merged `b3fbd1fd`；effective exact/semantic judge route 均要求结构化 reference solution。
- **Dependabot queue**：#953/#954/#1001 已合；不安全 Undici 8 由 YUK-743 承接；废弃 AI SDK majors 已关闭并由 YUK-744 删除根依赖。
- **Docker 空间清理**：执行 unused image 与 builder cache prune，保留 volumes；清理后 images 461.2 MB、build cache 0。
