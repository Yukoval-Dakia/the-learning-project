# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-22　·　历史头部日志（2026-06-23 ~ 07-19）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真）。

> **【更新 2026-07-22 · YUK-384 重设计交付：PR #1018 merged，Linear Done】** 闭世界设计（22 席 grounding + Fable 终裁）→ 11 任务 25 RED 严格 TDD 实现 → 独立评审链（初评 + 9 批增量全 CONFIRMED，含评审两次对自己结论的诚实纠正）+ 4 席全维度收口审查（boss 生命周期/租约锁/错误收敛/rollout）→ exact-head 全量 CI（含 audit:projection）success → 117 条 bot 线程全部处置 resolve → squash merge `c6f0a89b`。核心：PG 权威 per-hub reconciliation cursor（trigger 事务内推进 generation）+ token-fenced claim/lease + 原子 fenced apply（version CAS + session 级 editor 隔离）+ 统一 wake/recovery/nightly 单循环 + fold 可重放全快照事件（B4 合规）。9 项非阻塞硬化落 YUK-746。上线默认 `HUB_SYNC_MODE=off`，启用须走 8 步 rollout（docs/architecture.md §十.1）。过程教训已成文（评审面板先于开 PR，memory: review-panel-before-pr）。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。两条主 project 仍是：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。

## NOW（当前 active 线）

- **无 active 实现线**：YUK-384 重设计已交付合并（PR #1018 `c6f0a89b`，Linear Done）；快速收票 renewed pass（YUK-366/584/460/392）此前已收。下一条线待 owner 点题。
- **Backlog 净额口径**：起点 open 106；累计净减 11 后 renewed pass 收 YUK-384（−1）、新建 YUK-746 follow-up（+1），sanity estimate 仍 ≈95。Linear 全局 list 已证实截断，非权威精确总数。
- **owner 工作树保护**：主工作树 `.codex/*`、`AGENTS.md`、并发源码修改与两份未跟踪 design doc 不 stage、不改写、不清理。

## NEXT（就绪，排队）

- **YUK-384 rollout（部署侧）**：代码已在 main 但默认 `HUB_SYNC_MODE=off`。下次部署后按 `docs/architecture.md` §十.1 的 8 步 off→shadow→apply 序列启用；`triggers_installed` sentinel + `/api/admin/hub-sync` 观测。必须 `pnpm db:migrate`（db:push 会产出无 trigger 死库）。
- **YUK-354 umbrella**：A3 的 YUK-595 已完成；后续是否 close/收窄须按剩余 acceptance 重新 ground，不在本轮代判。
- **研究板作为完整入口**：继续以 `docs/planning/2026-07-20-backlog-reconciliation.md` 承载需要研究、设计或 owner judgment 的票，不从 cockpit 临时开新实现线。

## PARKED（已捕获，不是现在）

- **YUK-746**：hub-sync 交付后 9 项非阻塞硬化（block-ref FK 死锁消除、db:push repo 防护、非 hub 队列 drain 持久性等）；逐项独立可拆做。
- **YUK-745**：wrong-streak reader 的 semantics-safe 性能优化；keyset pagination/early stop、批量或有界并发 metadata reads、trigger-time bound、提前 `already_nudged`。不得改变 arbitrary `STREAK_N`、exclusion-before-break、cooldown、deterministic winner 与 unsupported/correction/appeal 语义。
- **YUK-555**：hard-cap acceptance 未保真迁入 YUK-605 或命名 successor 前不得取消或改写。
- **研究板其余项目**：owner/product/scientific、design preflight、architecture/research、external/ops、data/statistics 与 large-program 六类继续 parked，见 backlog reconciliation 文档。

## BLOCKED-ON（在等什么）

- **YUK-605 supply/ADR drift 批**：YUK-555 hard-cap acceptance 必须保真迁移后才可 conditional-cancel。
- **profile P2 / A9 step-grading**：仍分别等待 misconception/judge 数据校准证据。

## 在飞（PRs / workflows / worktrees）

- **实现 PR 在飞：0**：YUK-384 PR #1018 已 merge（远端分支已删）；#1009 已关闭未合并（历史）。当前开放 PR #1012-1016 均为 Dependabot。本 cockpit closeout branch 为 `cockpit-yuk384-delivered`。
- **可清理 worktree**：`/private/tmp/loom-yuk384-redesign-v2`（分支已 merge+远端删除）与 `agent-a6c6cadc778410ba4`（#1009 未合并历史，追溯用）——确认无需追溯后可删。
- **本地主工作树保护清单**：`.codex/hooks.json`、`AGENTS.md`、`.codex/hooks/codex-remember-session-start.sh`、`.codex/hooks/codex-remember-stop.sh`、`.codex/hooks/codex_extract.py`、`.codex/hooks/resolve-remember-plugin.sh`、`docs/design/2026-07-18-jyeoo-supply-selection-matching-design.md`、`docs/design/2026-07-19-evidence-supply-v2-architecture.md`。
- **Docker 当前轻量快照**：2 images / 461.2 MB、build cache 0；containers 0；volumes 5 / 542 MB。此前运行中的测试容器已退出；volumes 仍按指令未清理。

## ✅ 最近已落（防遗落，下次别重做）

- **YUK-384 durable hub-sync（PR #1018）**：merged `c6f0a89b`、Linear Done。PG 权威 reconciliation cursor + token fence + fenced apply + 统一三路循环 + fold 可重放事件；25 RED + 9 批评审修复全 CONFIRMED；117 线程处置；硬化 follow-up = YUK-746；默认 off 待 rollout。教训成文：大 correctness PR 的全维度对抗评审面板要在开 PR 之前跑。
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
