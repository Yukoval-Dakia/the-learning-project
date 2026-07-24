# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-24　·　历史头部日志（2026-06-23 ~ 07-22）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md` 与 `.remember/today-*.md`。

> **【更新 2026-07-24 · 迁移列车日：七 PR 合并、两 epic 收口、事件总线通电、架构定调】** 单日合并 #1040（YUK-452 Phase B）、#1042（YUK-591）、#1045（fix-forward）、#1046（YUK-762 flake+定时炸弹拆除）、#1044（YUK-751 durable 事件总线 PR2，dispatch-mount 通电 + 迁移 0074-0076）、#1041（YUK-497 级联撤回，99 threads 七波闭环）、#1043（ADR-0048）。YUK-497/546/567/591 Done。PR #1047（YUK-350，0077 grounding）在飞收敛中。**owner 三条新规则**：① monitor 静默≠死亡，长等待须心跳主动核对；② bot findings 不再 important 后修一轮即合、不等 OCR（review-loop-convergence）；③ **新开发硬性避免深度耦合**（守则随派单附带）。**架构定调**：模块化单体 + 事件总线，微服务否决；多用户「买缝不买重构」——审计报告 `docs/audit/2026-07-24-coupling-multiuser-readiness.md`（D1-D9 决策菜单待 owner ballot）。新立案 YUK-762~773。**日终补记**：#1049-#1054 + #1051 亦合并（累计 16 PR/日）；YUK-589 Done（0074-0078 迁移列车全落）；D1-D9 owner ballot 落账（多用户系 D1/D2/D6 缓，D3/D5/D7/D8 立 YUK-770-773）；owner WIP 分诊（两设计文档抢救 #1053、presence 修复 YUK-768）；三层共享模型草稿 #1054；重测 @f9af38e8 入库 #1050（registry.ts 翻倍 1914 行=新头号 god file、D8 tripwire 已触发）。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。两条主 project 仍是：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。

## NOW（当前 active 线）

- **07-24 迁移列车日已全部收官**：16 PR 合并、5 票 Done（YUK-497/546/567/589/591）、开放 agent PR = 0。无代码 lane 在飞。
- **下一 session 作战序（owner 拍板）**：主 lane = **D3/YUK-770**（kernel http facade 收尾 + Biome lint 闸）；并行快通道收小票 **YUK-763/765/768/769**（加紧收票节奏，见 memory ticket-closure-pace：READY 票 2-3 张并行、小票单轮评审 gate 绿即合、session 末报吞吐）。
- **effect-slice 硬前置**：YUK-766 三道门（(a) checkpoint 进备份 + principal 类型层 + 幂等契约）齐前不进实现。

## NEXT（就绪，排队）

- **YUK-589（judge provenance 二期）**：#1047 合并后 rebase worktree agent-a4b5491eaa05fff02，renumber 0074_yuk589→**0078**；PR body 必带 `JUDGE_PROVENANCE_SECRET` 部署注记（openssl rand -hex 32，distinct from INTERNAL_TOKEN）。
- **YUK-751 effect-slice**（worktree agent-aa45ca5635aa08991，rebase-ready）：⚠️ 硬前置 = YUK-766 灾备语义 ballot（D4）。
- **YUK-763（High）placement 快照漂移**：污染全 lane db:generate；YUK-452 lane 出专门迁移。
- **07-23 已拍板可执行队列**（30-ticket 序）：YUK-608/229/230/562/594/444/437/679/757/758。测试跟进：YUK-764/765。
- **D1-D9 中零成本项**（owner ballot 后即刻生效）：D2 锁名约定、D6 备份泳道标注、D9 度量口径。

## PARKED（已捕获，不是现在）

- **战略 non-ready queue（顺序/分类保真）**：epic/excluded = YUK-452；approval/new-carrier/excluded = YUK-680；NEEDS_DESIGN = YUK-747/448/522/750/753/752（07-24 出列：589→NEXT、594→已拍板队列、350→PR #1047、497→Done）；OWNER_GATED = YUK-669/675/677（07-24 出列：591/546→Done，608/678/229/230/679→已拍板队列）；BLOCKED = YUK-596/748（等 YUK-747）/438（07-24 出列：751→PR2 已合并，effect-slice 等 YUK-766）。不得为凑 leaf wave 擅自升级 READY。
- **YUK-384 后续**：仅 rollout 与 YUK-746 hardening；不得回到已关闭未合并的 #1009 quick-fix 协议。
- **YUK-555**：hard-cap acceptance 未保真迁入 YUK-605 或命名 successor 前不得取消或改写。
- **研究板其余项目**：owner/product/scientific、design preflight、architecture/research、external/ops、data/statistics 与 large-program 六类继续 parked，见 backlog reconciliation 文档。

## BLOCKED-ON（在等什么）

- **D1-D9 架构手术菜单** ← owner 逐项 ballot（报告 docs/audit/2026-07-24-coupling-multiuser-readiness.md §4）。
- **YUK-766 灾备恢复语义** ← effect-slice 硬前置（=D4）。
- **YUK-405 教研团两周窗** ← owner 本周上传内容。

- **YUK-669 owner gate**：历史清洗后的 secret scanning + push protection 仍须 owner/operator 在 GitHub 启用；不得把代码侧 containment 误写成此 gate 已完成。
- **YUK-590 / YUK-755 Linear metadata-only blocker**：两张 Done issue 仍带 accidental synthetic SLA `2099-12-31` / `all`。当前 Linear MCP 无法安全清除，环境无 Linear API token，尝试写 Linear comment 又因 wrapper 强制要求不兼容的 optional fields 而失败。operator 必须通过 Linear UI 或 authenticated raw GraphQL **同时清除** `slaBreachesAt` 与 `slaType`，且不得 reopen 两张 Done issue。
- **YUK-605 supply/ADR drift 批**：YUK-555 hard-cap acceptance 必须保真迁移后才可 conditional-cancel。
- **profile P2 / A9 step-grading**：仍分别等待 misconception/judge 数据校准证据。

## 在飞（PRs / workflows / worktrees）

- **开放 agent PR：0**（本 session 16 个全合并：#1040-1047、#1049-1054、#1041；#1048 作废重做为 #1049）。cockpit #1019 与 Dependabot #1012-1016 沿旧口径未核。
- **权威主线**：origin/main@8135cfad（#1051 / YUK-589）。**部署注记**：生产 rollout 前需设 `JUDGE_PROVENANCE_SECRET`（openssl rand -hex 32，≠ INTERNAL_TOKEN；详见 YUK-589 收官评论）。
- **worktrees**：仅剩 agent-aa45ca5635aa08991（effect-slice，等 YUK-766 三道门）。本地分支 wip/owner-0724（owner WIP 存档，内容已榨干——可随时 `git branch -D` 删）。
- **主工作树**：owner 工具配置（.codex bridge/AGENTS.md/serena）已还原为 owner 版本，仍未提交（其本机 setup 的家）。main 本地分支已与 origin 拉平。

## ✅ 最近已落（防遗落，下次别重做）

- **07-24 迁移列车日**：七 PR 合并明细与技术要点（G→supply→row 锁序、单事务快照 bootstrap、物化工具类五角全堵、rerun 不重解析 merge-ref、本地宽松 mock vs CI 严格）见 `.remember/today-2026-07-24*.md`；审计报告 + 部署形态裁定见 `docs/audit/2026-07-24-coupling-multiuser-readiness.md`。

- **YUK-755 / PR #1023**：merged `91dd6490`，Linear Done；exact-head CI / review threads clean。
- **YUK-742 / PR #1021**：merged `0d30fbcc`，Linear Done；exact-head CI / review threads clean。
- **YUK-590 / PR #1020**：merged `07c4a982`，Linear Done；exact-head CI / review threads clean；仅遗留 metadata-only SLA 清理。
- **YUK-745 / PR #1022**：merged `d5e43a08`，Linear Done；focused DB 34/34 + typecheck / Biome / partition / LSP / diff checks 通过，exact-head CI / review threads clean；仅 YUK-755 同类 metadata-only SLA 清理仍待 operator。
- **grounding / 排程**：claude-context refresh = 1,654 files / 29,494 chunks；105 candidates / 76 unique existing issues；30-ticket strategic order + READY-only leaf wave 已建立。
- **YUK-384 durable reconciliation（PR #1018）**：merged `c6f0a89b`、Linear Done；YUK-746 承接 9 项 hardening，#1019 为仍开放的无关 cockpit PR。
