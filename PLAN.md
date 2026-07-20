# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-20　·　历史头部日志（2026-06-23 ~ 07-19）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真）。

> **【更新 2026-07-20 · backlog 107/107 收口 + 25 项状态修正落地 + 四条研究票入 Linear】** Linear 权威重数 742 票：Done 617 / Backlog 87 / In Progress 13 / Canceled 17 / Duplicate 8（open 100）。107-ID snapshot 已独立证明 classified unique=107 / missing=0 / unexpected=0 / duplicate assignments=0；25 项获批状态修正均已落地回读，YUK-555 仍按 hard-cap acceptance 红线未动。四条 acceptance-ready follow-up 已建为 YUK-738～741 并校正到 Backlog；YUK-679 已扩入 `srtOutcome`、continuous-credit/Fisher、Rust-port/ADR-exemption 与历史 replay compatibility。官方 Linear MCP 在 Business 升级后已通过真实 read/write 验证，后续以官方 `linear` 为主，本地 API-key MCP 仅备用。YUK-556 PR #998 本地与 required gates 绿、独立 review APPROVE、threads=0，但 OCR 因 Codex quota 外部失败，保持 open 不误报全绿；YUK-584 PR #1000 已合，verifier optional hardening 捕获为 YUK-742；YUK-595 已先转 In Progress 再启动 TDD worktree。旧 cockpit PR #973 已由 #999 取代并关闭不合。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。两条主 project 仍是：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。

## NOW（当前 active 线）

- **YUK-556 structured reference solution**：PR #998 open @ `f874655f`；初轮 review 的 DB 29/36 回归、implicit-route 绕过与 prompt/effective-route 漂移均已 RED→GREEN 修复。本地 focused unit 71/71、handler DB 36/36、typecheck/Biome/diff-check/LSP 绿；required Node/full gates 绿、独立 review APPROVE、unresolved threads=0。OCR 仅因 Codex quota 外部失败，故保持 open、不误报全绿。
- **YUK-595 same-KC wrong streak**：已在官方 Linear 转 In Progress 后启动最新 `origin/main` 隔离 worktree，严格 TDD 实施；bounded backend-only（streak reader / producer / evaluator-config / silent-window backstop），不改 UI、不 migration、不翻 flag。
- **backlog-engine 完整性终验已过**：原 107-row 输出只有 80 unique；漏掉 27 票分 A/B/C 三批重扫后，独立验证 expected/classified unique=107、missing/unexpected/duplicate assignments 均 0。最终 107 票分布：research 65 / quick 9 / active 6 / move-backlog 15 / close-done 8 / cancel 3 / conditional-cancel 1。
- **jyeoo 供给链 dark-ship**：`JYEOO_FETCH_ENABLED` 默认 OFF；开闸前 owner 过目 producer patch 提案。
- **安全后续 hygiene**：YUK-669 事故处置与历史 refs 清洗已 Done；剩 secret scanning/push protection 与 unreachable-object GC/support hygiene 仍属 owner/operator lane，禁止 agent 自行执行。

## NEXT（就绪，排队）

- **其余新 ground quick lanes 排队**：YUK-392（移除 Step-5 `kindsMatch` 拒收尾巴）· YUK-448（PfPaper per-slot `latency_ms`）· YUK-497（copilot revert route/UI caller）；YUK-366 等 YUK-698 supply-selection，YUK-384 等 edge mutation lane，YUK-460 等 YUK-301 note-refine。
- **Dependabot 开放 PR 队列（承接票 YUK-671 已 Done）**：#953 minor/patch group 当前 required gates 失败；#954-957 major 当前绿，但仍须逐 lane 验证，AI 两只按双-provider 机制迁移。
- **YUK-354 umbrella**：保持 active；A3 剩余即 YUK-595，完成或正式收窄 acceptance 后再 close。

## PARKED（已捕获，不是现在）

- **研究板终版 65 票**：owner/product/scientific、design preflight、architecture/research、external/ops、data/statistics、large-program 六类；完整 65-ID 清单与动作边界见 `docs/planning/2026-07-20-backlog-reconciliation.md`（107/107 equality 已过）。
- **补扫新增研究/大项**：YUK-213、YUK-346、YUK-588、YUK-605、YUK-675；YUK-268/287/524/550/685 已回 Backlog，YUK-310/354 keep active；YUK-322 已 Done，YUK-373/532 已 Canceled；YUK-555 仅在 cap acceptance 搬入 YUK-605 后 cancel。
- **四条研究 follow-up 已入 Linear**：YUK-738 ASR/TTS audio evidence · YUK-739 SubjectProfile rating/cause semantics · YUK-740 LearningRecord single-writer/CAS/transition policy · YUK-741 misconception recurrence batching，均已回读为 Backlog。YUK-679 已扩入 `srtOutcome`、continuous-credit/Fisher 及 Rust port/ADR exemption + replay compatibility；YUK-742 仅承接 YUK-584 verifier 的 optional validator-throw/concurrent retry rollback 测试。
- **红线审查 / brainstorm / misconception flag / 学科网 follow-ups / stash@{0} rescue / infra 清扫**：沿既有文档与门控保留，不在本轮扩 scope。

## BLOCKED-ON（在等什么）

- **YUK-505 规划脑拓扑裁决**：六月四角色 fan-out vs YUK-572 单 director + ≤1 scout 契约。
- **profile P2 翻 flag**：misconceptionRecurrence / B4 answer_class filter 需数据 + judge 校准。
- **A9 step-grading（YUK-438）**：等 YUK-573/YUK-589 judge 校准证据。
- **YUK-605 supply/ADR drift 批**：YUK-698 前置已 Done，现应重审并拆分；YUK-555 hard-cap acceptance 必须保真迁移后才可 conditional-cancel。

## 在飞（PRs / workflows / worktrees）

- **PR 在飞**：#998 YUK-556 open @ `f874655f`（本地/required gates/独立 review 绿、threads=0；OCR quota 外部失败，未误合）；#999 本 replacement cockpit；YUK-595 implementation lane 已启动、PR 尚未创建；Dependabot #953-957（#953 gates 失败，#954-957 当前绿）。#1000/YUK-584 已合（详情见最近已落）；#973 已由 #999 取代并关闭不合；#968/YUK-735 已合。
- **worktree 在飞**：`/private/tmp/loom-yuk556`（YUK-556）· `/private/tmp/loom-cockpit-backlog`（本 replacement）。YUK-584 agent worktree 已完成但仍占本地 branch，留待安全 worktree cleanup；历史 worktree/branch 存量批量删除仍属 owner-gated infra 清扫。
- **本地主工作树**：仍有 owner 的 `.codex/*`、`AGENTS.md` 与两份 design doc 未跟踪/修改；本轮未触碰。
- **基建注意**：Docker fsync IO 退化与 dev compose schema 落后记录沿 #973 保留；需 full DB gate 的 lane 先确认 Docker 状态。

## ✅ 最近已落（防遗落，下次别重做）

- **YUK-584 evidence refs 校验（07-20）**：PR #1000 squash-merged `c35ccb20`、Linear Done；merge tree 已核对包含 late-reviewed action allowlist（与 `6276fa48` touched-file tree OID 相等）。最终 unit 30/30、DB 11/11、dark-ship 12/12、typecheck/build/Biome/CI 绿，独立 verifier APPROVE、threads=0；唯一 optional throw/retry rollback 测试已落 YUK-742 Backlog。
- **Linear 状态卫生批（07-20）**：25 个获批 state correction 均已落地回读；YUK-555 conditional guard 保持未动。
- **07-19→20 backlog 连清前两波**：P0F/6 telemetry、6-lens 六票、YUK-546 propose 并发锁、YUK-549 oracle 三件均已合；详情见归档头部与对应 PR。
- **07-19 双线推进 / 07-18 产品收口 / YUK-669 遏制 / UH + API 契约 program**：历史详情见 `docs/planning/2026-07-07-plan-header-log-archive.md`，不在活看板重复展开。
