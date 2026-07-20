# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-20　·　历史头部日志（2026-06-23 ~ 07-19）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真）。

> **【更新 2026-07-20 · backlog 全量重对账：状态卫生 15 票落地 + YUK-556 TDD PR 修复复审中 + 分类器截断纠偏】** Linear 当前 737 票：Done 615 / Backlog 84 / In Progress 15 / Canceled 15 / Duplicate 8（open 99）。已验证修正：YUK-326/397/407/440/471/585→Done，YUK-255→Canceled，YUK-350/377/386/438/506/572/596→Backlog，YUK-490 原已 Done；YUK-556→In Progress，以严格 RED（4 fail/65 pass）→初轮 GREEN（69/69）落 PR #998；独立 review 抓出 handler DB suite 29/36 回归及 implicit exact/semantic route 绕过后，修复 commit `470539eb` 已推，本地 unit 71/71、handler DB 36/36、typecheck/Biome/diff-check/LSP 全绿，最新 CI/独立复审仍 pending，禁止提前合并。对抗复核另发现初轮分类器虽产 107 rows，却因 27 重复 ID 漏掉另 27 票；A/B/C 三批补扫后已独立证明 expected unique=107 / classified unique=107 / missing=0 / unexpected=0 / duplicate assignments=0，最终分布为 research 65 / quick 9 / active 6 / backlog 15 / close 8 / cancel 3 / conditional-cancel 1。新提议的状态与立单仍待 owner 批准，未擅自写 Linear。旧 cockpit PR #973 内容已实质过期，待本 replacement 建立后关闭不合。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。两条主 project 仍是：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。

## NOW（当前 active 线）

- **YUK-556 structured reference solution**：PR #998 open；初轮独立 review 抓出的 handler DB 29/36 回归与 implicit exact/semantic route 绕过，已由 `470539eb` 修复。本地 focused unit 71/71、handler DB 36/36、typecheck/Biome/diff-check/LSP 全绿；最新 CI/独立复审 pending，未获批准前禁止合并。
- **backlog-engine 完整性终验已过**：原 107-row 输出只有 80 unique；漏掉 27 票分 A/B/C 三批重扫后，独立验证 expected/classified unique=107、missing/unexpected/duplicate assignments 均 0。最终 107 票分布：research 65 / quick 9 / active 6 / move-backlog 15 / close-done 8 / cancel 3 / conditional-cancel 1。
- **jyeoo 供给链 dark-ship**：`JYEOO_FETCH_ENABLED` 默认 OFF；开闸前 owner 过目 producer patch 提案。
- **安全后续 hygiene**：YUK-669 事故处置与历史 refs 清洗已 Done；剩 secret scanning/push protection 与 unreachable-object GC/support hygiene 仍属 owner/operator lane，禁止 agent 自行执行。

## NEXT（就绪，排队）

- **YUK-595 same-KC wrong streak**：ground 为 GO；cut-1 基建已合，剩 streak reader + 三 producer + evaluator/config，复用现有 UI/schema/backstop，无 migration。以 `origin/main` 新 worktree 实施，避开 stale YUK-586 worktree。
- **YUK-584 research-meeting evidence refs 校验**：漏票补扫判 QUICK_EXECUTE；Linear In Progress 实为 stale，无 branch/PR，先回 Backlog 或开工时重置 In Progress。
- **其余新 ground quick lanes 排队**：YUK-392（移除 Step-5 `kindsMatch` 拒收尾巴）· YUK-448（PfPaper per-slot `latency_ms`）· YUK-497（copilot revert route/UI caller）；YUK-366 等 YUK-698 supply-selection，YUK-384 等 edge mutation lane，YUK-460 等 YUK-301 note-refine。
- **Dependabot 开放 PR 队列（承接票 YUK-671 已 Done）**：#953 minor/patch group 当前 required gates 失败；#954-957 major 当前绿，但仍须逐 lane 验证，AI 两只按双-provider 机制迁移。
- **YUK-354 umbrella**：保持 active；A3 剩余即 YUK-595，完成或正式收窄 acceptance 后再 close。

## PARKED（已捕获，不是现在）

- **研究板终版 65 票**：owner/product/scientific、design preflight、architecture/research、external/ops、data/statistics、large-program 六类；完整 65-ID 清单与动作边界见 `docs/planning/2026-07-20-backlog-reconciliation.md`（107/107 equality 已过）。
- **补扫新增研究/大项**：YUK-213、YUK-346、YUK-588、YUK-605、YUK-675；YUK-268/287/524/550/685 保持 Backlog；YUK-310/354 keep active；YUK-322 可 close Done；YUK-373/532 可 cancel obsolete；YUK-555 仅在 cap acceptance 搬入 YUK-605 后 cancel。
- **四条 acceptance-ready 新 issue 草案（尚未获 filing 授权）**：ASR/TTS audio evidence path · rating cause semantics 移入 SubjectProfile · LearningRecord single-writer/CAS/transition-policy（已证非 YUK-503 duplicate）· misconception recurrence aggregate batching。不得只留脑内；下一拍获准后建 Linear。
- **YUK-679 扩 scope，不另立重复票**：纳入 `srtOutcome` + continuous-credit/Fisher 数值路径的 Rust port 或 ADR-0046 exemption 裁决。
- **红线审查 / brainstorm / misconception flag / 学科网 follow-ups / stash@{0} rescue / infra 清扫**：沿既有文档与门控保留，不在本轮扩 scope。

## BLOCKED-ON（在等什么）

- **YUK-505 规划脑拓扑裁决**：六月四角色 fan-out vs YUK-572 单 director + ≤1 scout 契约。
- **profile P2 翻 flag**：misconceptionRecurrence / B4 answer_class filter 需数据 + judge 校准。
- **A9 step-grading（YUK-438）**：等 YUK-573/YUK-589 judge 校准证据。
- **YUK-605 supply/ADR drift 批**：YUK-698 前置已 Done，现应重审并拆分；YUK-555 hard-cap acceptance 必须保真迁移后才可 conditional-cancel。

## 在飞（PRs / workflows / worktrees）

- **PR 在飞**：#998 YUK-556 open（`470539eb` 本地 focused checks 绿，最新 CI/独立复审 pending，未批准前不合）；#973 stale cockpit（本 replacement 建立后关闭不合）；Dependabot #953-957（#953 gates 失败，#954-957 当前绿）。#968/YUK-735 已合，不再列 In Review。
- **worktree 在飞**：`/private/tmp/loom-yuk556`（YUK-556）· `/private/tmp/loom-cockpit-backlog`（本 replacement）；历史 worktree/branch 存量未清，批量删除仍属 owner-gated infra 清扫。
- **本地主工作树**：仍有 owner 的 `.codex/*`、`AGENTS.md` 与两份 design doc 未跟踪/修改；本轮未触碰。
- **基建注意**：Docker fsync IO 退化与 dev compose schema 落后记录沿 #973 保留；需 full DB gate 的 lane 先确认 Docker 状态。

## ✅ 最近已落（防遗落，下次别重做）

- **Linear 状态卫生批（07-20）**：14 个 approved transition 逐票回读 verified；YUK-556 另转 In Progress，YUK-490 no-op。
- **07-19→20 backlog 连清前两波**：P0F/6 telemetry、6-lens 六票、YUK-546 propose 并发锁、YUK-549 oracle 三件均已合；详情见归档头部与对应 PR。
- **07-19 双线推进 / 07-18 产品收口 / YUK-669 遏制 / UH + API 契约 program**：历史详情见 `docs/planning/2026-07-07-plan-header-log-archive.md`，不在活看板重复展开。
