# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-22　·　历史头部日志（2026-06-23 ~ 07-21）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md` 与 `.remember/today-*.md`。

> **【更新 2026-07-22 · existing-Linear grounding 与四票实现波收口】** 刷新 claude-context 至 1,654 files / 29,494 chunks 后，ground 105 candidates / 76 unique existing Linear issues，建立 30-ticket 战略顺序与 READY-only leaf wave。该 wave 的 YUK-755/#1023、YUK-742/#1021、YUK-590/#1020、YUK-745/#1022 已依次 merge（`91dd6490`、`0d30fbcc`、`07c4a982`、`d5e43a08`）且 Linear 全部 Done；merge 时 exact-head CI 与 review threads 均 clean。YUK-745 最终 focused DB suite 34/34，typecheck、Biome、partition、LSP 与 diff checks 通过。该 wave 无剩余开放 PR；权威 `origin/main` 为 `d5e43a08`。主工作树 owner-dirty，未触碰。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。两条主 project 仍是：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。

## NOW（当前 active 线）

- **existing-Linear 执行图已 grounded**：基于刷新索引的 105 candidates / 76 unique issues，30-ticket 战略顺序已建立；执行只从 READY leaf wave 取票，不跨过依赖、设计或 owner gate。
- **本实现 wave 已结束**：YUK-755、YUK-742、YUK-590、YUK-745 均 merged + Linear Done，无该 wave 开放 PR。
- **owner 工作树保护**：主工作树存在 owner/concurrent dirty changes；本 closeout 只在隔离 worktree 从 exact `origin/main@d5e43a08` 修改 cockpit 三文件，未触碰主工作树。

## NEXT（就绪，排队）

- **READY-only leaf wave**：30-ticket 顺序中的 READY 票 YUK-590、YUK-745、YUK-742 已 Done；READY residue 仅 YUK-749，但它与 owner-modified file 冲突，未获隔离/协调前不得静默启动。
- **YUK-746 hardening**：依赖已交付的 YUK-384 durable hub reconciliation；其 9 项 hardening 应拆成边界明确的 lane，不夹带主工作树未提交修改。
- **YUK-384 rollout**：实现已交付但默认关闭；启用仍须按既定 8-step rollout、先跑 `db:migrate`，不得把代码 merge 等同生产启用。
- **YUK-354 umbrella**：A3 的 YUK-595 已完成；后续是否 close/收窄须按剩余 acceptance 重新 ground，不在本轮代判。
- **研究板作为完整入口**：继续以 `docs/planning/2026-07-20-backlog-reconciliation.md` 承载需要研究、设计或 owner judgment 的票，不从 cockpit 临时开新实现线。

## PARKED（已捕获，不是现在）

- **战略 non-ready queue（顺序/分类保真）**：epic/excluded = YUK-452；approval/new-carrier/excluded = YUK-680；NEEDS_DESIGN = YUK-747/589/594/350/448/522/750/753/752/497；OWNER_GATED = YUK-669/675/591/608/678/546/677/229（先 UI design preflight）/230/679；BLOCKED = YUK-596/748（等 YUK-747）/751（等 YUK-747 + scope reconciliation）/438。不得为凑 leaf wave 擅自升级 READY。
- **YUK-384 后续**：仅 rollout 与 YUK-746 hardening；不得回到已关闭未合并的 #1009 quick-fix 协议。
- **YUK-555**：hard-cap acceptance 未保真迁入 YUK-605 或命名 successor 前不得取消或改写。
- **研究板其余项目**：owner/product/scientific、design preflight、architecture/research、external/ops、data/statistics 与 large-program 六类继续 parked，见 backlog reconciliation 文档。

## BLOCKED-ON（在等什么）

- **YUK-669 owner gate**：历史清洗后的 secret scanning + push protection 仍须 owner/operator 在 GitHub 启用；不得把代码侧 containment 误写成此 gate 已完成。
- **YUK-590 / YUK-755 Linear metadata-only blocker**：两张 Done issue 仍带 accidental synthetic SLA `2099-12-31` / `all`。当前 Linear MCP 无法安全清除，环境无 Linear API token，尝试写 Linear comment 又因 wrapper 强制要求不兼容的 optional fields 而失败。operator 必须通过 Linear UI 或 authenticated raw GraphQL **同时清除** `slaBreachesAt` 与 `slaType`，且不得 reopen 两张 Done issue。
- **YUK-605 supply/ADR drift 批**：YUK-555 hard-cap acceptance 必须保真迁移后才可 conditional-cancel。
- **profile P2 / A9 step-grading**：仍分别等待 misconception/judge 数据校准证据。

## 在飞（PRs / workflows / worktrees）

- **本 wave 开放 PR：0**。仓库仍有 6 个无关开放 PR：cockpit YUK-384 #1019，以及 Dependabot #1012-1016；不得表述为全仓 open PR = 0。
- **权威主线**：`origin/main@d5e43a08`（PR #1022 / YUK-745 merge）是本 closeout exact base；本隔离 worktree不 push。
- **主工作树**：owner-dirty，未 stage、未改写、未清理。

## ✅ 最近已落（防遗落，下次别重做）

- **YUK-755 / PR #1023**：merged `91dd6490`，Linear Done；exact-head CI / review threads clean。
- **YUK-742 / PR #1021**：merged `0d30fbcc`，Linear Done；exact-head CI / review threads clean。
- **YUK-590 / PR #1020**：merged `07c4a982`，Linear Done；exact-head CI / review threads clean；仅遗留 metadata-only SLA 清理。
- **YUK-745 / PR #1022**：merged `d5e43a08`，Linear Done；focused DB 34/34 + typecheck / Biome / partition / LSP / diff checks 通过，exact-head CI / review threads clean；仅 YUK-755 同类 metadata-only SLA 清理仍待 operator。
- **grounding / 排程**：claude-context refresh = 1,654 files / 29,494 chunks；105 candidates / 76 unique existing issues；30-ticket strategic order + READY-only leaf wave 已建立。
- **YUK-384 durable reconciliation（PR #1018）**：merged `c6f0a89b`、Linear Done；YUK-746 承接 9 项 hardening，#1019 为仍开放的无关 cockpit PR。
