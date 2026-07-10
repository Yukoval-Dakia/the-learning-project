# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-10　·　历史头部日志（2026-06-23 ~ 07-10 全部超龄【更新】叙事段，含 YUK-597 v1 判词段）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真，含 P5/P9/A5 KEEP 裁决证据锚点 + YUK-249 收线段）。

> **【更新 2026-07-10 · YUK-597 v2 契约修订：owner request-changes → implementation contract draft 在审】** owner 对 v1 终稿（#747 merged）下技术 review：主方向（臂 B + opaque id）正确不重议，但「作为可直接实施的终稿不够」——**4 阻断**（①建 root 使 goal scope 永久冻结在 `[seed:*:root]` ②opaque id 对 AI 分类器无语义 ③worker lazy DB re-check 同步 Map 下无法落地 ④insertGoal 非单一写面，projectGoal/accept 绕过）+ 8 契约缺口，令改题 **implementation contract draft** 并补状态模型/事务API合同/启动失败矩阵/四阻断 E2E 后**再批准**。v2 修订 run `wf_78170c3d-f74`（6 席 opus B1-B6 + Fable 综合，3 处跨席冲突裁决：root id 钉 `seed:<subjectId>:root`（防 3a topic-root 误伤）/ `subject_name_claim` 单命名空间表 / boot-gate 水合 + worker 60s refresh 取代 lazy）+ 独立 opus 对抗复核（verdict REVISE：3 MAJOR + 5 MINOR，已全数修入——nightly 候选源换 selectable、scope_mode 进 GoalRowSnapshot 必须 optional 防 `.strict()` 拒折历史 genesis、isGeneralFallback 补稳态数据路径等）。doc 已就地重写（§0 裁决级变更表 + §2-§8 四新章 + §9 prerequisites ①-⑪ + §10 PR-0~7）。**阻断①坐实为独立 armed live bug → YUK-603 已立**（flag ①批 07-06 已 ON，goal census=0 尚无中弹行，owner 首次 onboarding 即触发；修复 = doc §5，PR-0 先行独立于自定义科目）。docs PR 在飞等 owner 批准；**批准后**才对齐 YUK-598~602 描述（599 现载已证伪的 lazy re-check、600 现载已废除的 insertGoal 单一写面 + subjectDisplayName passthrough）。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局），非纯机械「记+练+复习」闭环。但**机械架构基底先打牢**——诊断轴消费底层引擎/检索/matcher。状态 check 结论（`scratchpad/PROJECT-STATUS-REPORT.md`，2026-06-23）：B1 θ̂ SoT + 检索 + owner 门 + poolFetch **已够硬撑 day-one B**；唯一 day-one 软缺口 = 档案露出 **YUK-476**（后端 live、UI 零渲染）。冷启 day-one 先验仍是底色（记忆 `feedback_cold_start_first`）。

**两条主 project（B 的地基）**：① **领域模型重构 YUK-203**（机械基底：matcher/检索/B1-B5/event-sourcing/note 域）② **学习者全面档案 YUK-452 / A1-A15**（诊断档案）。**owner 排序：先把 event-sourcing 脊柱 YUK-471 浇筑好**，再做诊断露出（YUK-476 → ...）。状态 check 还发现：domain 0 假 Done、profile 0 假 Done；matcher（YUK-397）+ event-sourcing impl（YUK-471）+ misconception 一等节点 = 已建未通电/未落，但**不在 day-one B 关键路径**（act/later 深化弧）。

## NOW（当前 active 线）

> 模式转向（owner 2026-06-21）：从「捡 issue 吞吐」转「单项目深度冲刺到一条可感 milestone」。原则 [defer flip not build]（记忆 `feedback_defer_flip_not_build`）。执行图 `docs/planning/2026-06-21-cold-start-openable-sprint.md`（镜像 Linear Document 挂 YUK-452）。

- **YUK-597 v2 契约 = 当前 active 线（v2 draft 在 PR 审，等 owner 批准）**：臂 B + opaque id `subj_<cuid2>` 判词不变；权威依据 `docs/design/2026-07-10-yuk597-custom-subjects.md`（**implementation contract draft**，owner request-changes 4 阻断已闭合 + 对抗复核 REVISE 项已修，待 owner「再批准」）。实施依赖序（批准后生效，且 **YUK-598~602 描述须先对齐 v2**——599/600 现载已证伪机制）：**PR-0 = YUK-603 scope_mode 修复先行独立**（armed live bug，见头部【更新】）→ **YUK-598**（三集合拆分 + provider 水合 + scope_key 统一）∥ **YUK-599**（subject_profile + subject_name_claim 表 + boot-gate 水合 + worker refresh + backup FK_ORDER）先行 → **YUK-600**（thin-create 事务 + goal 写路径防线 + knownSubjects 富化 + nightly 候选源换 selectable）/ **YUK-601**（admin 编辑面 + validateProfile 写门 + reconcile 治理）→ **YUK-602**（onboarding 手填 thin-create，owner 原话落点）。⚠️ YUK-601/602 动 UI 前须先落一份合并 UI design doc 获批（UI Design Compliance）。
- **方向 B「可开始用」milestone — 代码侧全部完成，flag ①批已 LIVE**：S1 YUK-516（#709 merged）· S2 YUK-478 冷启 e2e（#710 merged）· S3 判定无代码活。**YUK-571 flag ①批（`PLACEMENT_PROBE_ENABLED` + `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`）实况 = 2026-07-06 已翻并注入生产容器**（07-09 核验：容器 env + HTTP 零写 smoke 400-not-404；day-zero census 已存档 YUK-571 评论——question=0 / knowledge=3 seed root / 学习表全零）。**剩 gate = 冷库零题（owner 上传/生成内容）→ 首次真实 placement 会话跑通**（空池返回 `sourcingNeeded:true` 走 quiz_gen，设计态非错误态）；② refill 前置未验且空池无意义、③ 按单据明确不动——均维持 off。⚠️ 生产 = 本机 OrbStack compose（`tlp-deploy`），可用性依赖 OrbStack 在跑（always-on ingress 见 PARKED Step6）。

## NEXT（就绪，排队）

- **YUK-596 durable-by-default flip（YUK-575 PR2）**：翻 copilot durable 默认 + N4 Dock 202-branch + in-loop stop + poll frequency。⚠️ **4 条阻断前置**已记 issue 评论（#738 独立 review 终裁 2026-07-09，含 Codex P2 causal-filter 修形）；宜先跑 PR1 opt-in burn-in。
- **Wave 3 follow-up 批**：YUK-594（durable judge lane，替代已 Cancel 的 YUK-592）· YUK-595（主动开口 cut-2 连错 streak）· YUK-589（judge 校准第二期）· YUK-590（观测面诚实化第二期）· YUK-593 + YUK-394（OCR review = **额度耗尽**，owner 07-09 确认；补额度前全 PR 该 check 必挂，勿重跑）。
- **🦀 Rust 同构核 Phase 0+（YUK-495 project）** ⚠️待核：Phase 1 已 DONE（#634）；Phase 0+/Phase 2 后续项（inc-E YUK-455 prereq 传播 dark-ship 等）状态需 re-ground（原详细 NEXT 记录随头部日志归档）。
- **旧 loop-wiring 尾巴 + profile/教研团冷启 prior 设计**：openable 通电、有真实交互后据外部信号设计（gated on 数据）。

## PARKED（已捕获，不是现在）

- **红线审查 owner 拍板菜单（13 项分三批）** = `docs/audit/2026-07-07-redline-challenge-audit.md` §5：批① 成文冲突 ✅（#724）· 批② 两 REWRITE ✅（P2 cockpit #724 · X6 ADR-0025 #725）· 批③ 工程单候选 2/8 已落（audit:fold-writes + audit:flags #726）——**剩 6 项待 owner 拍**（step9 断言 / P6 到期悬崖拆解 / X2 成本叙事 / A2 执行状态列 / A3 勘误 / /audit-drift 通电）。sweep 溢出 2 条未审（kg-mesh-no-tree-edge / credit-decay weight 分离）留下轮。
- **brainstorm 存活 8 条（留档待挑）** = `docs/design/2026-07-06-agency-data-brainstorm-portfolio.md`：教学督导 Part A（次优①）· 周期校准探针 producer+consumer 一体（次优②）· applied_in 死边通电 · 自动 dismiss 悬空提案 · knowledge_edge CREATE 升 A 档（前置 = proposal_signals 采纳率 gate）· 夜间 job 性价比审计 · 答案泄漏护栏 · 会话连接图。**红线挑战组 3 条** = portfolio §5 决策表未拍板。
- **🧠 误区(misconception)建模调查 + 翻 MISCONCEPTION_PROMOTE flag 设计** = doc 存档（2026-07-01，`docs/design/2026-07-01-misconception-*`）。
- **Linear 卫生**（审计 `w8iz32mse`，待 owner 批）：stale 状态对齐（YUK-519/531/476/407 终裁建议翻 Done/收口；YUK-303/306/373/375/360 移出 In Progress）。
- **栈瘦身 / overhead audit**（owner 起念「砍 AI+math → Rust」）· **🦀 Rust 算力兑现 tripwire**（教研团重算演示埋线）· **Step6 [ops] NAS always-on 部署**（`TUNNEL_TOKEN` + compose up）· **C7-C10 matcher cleanup**（折入 YUK-397，随 inc-5 / live-caller）。

## BLOCKED-ON（在等什么 — 冷启修正后多为「需先验」非「纯等数据」）

- **YUK-567 = probe-answer prep-desk card UI**（design-gated：card 组件不存在，需 claude.ai/design pass 后 slice-by-slice）← producer live 无插头。
- **profile P2 翻 flag**（misconceptionRecurrence / B4 answer_class filter）← 需数据 + judge 校准。
- **matcher 接 live caller** ← 题库规模 + Step2 feeder 验证（小题库 cosine 不稳）。
- **教研团 YUK-405 / 记忆 YUK-322** ← profile 有真实数据 / 交互历史。
- **A9 step-grading 倍增器（YUK-438，#522 draft）** ← judge 校准数据（YUK-573 MVP #729 已 merge，report-only 采样积累中；第二期 YUK-589）。

## 在飞（PRs / workflows / worktrees）

- **docs PR 在飞：YUK-597 v2 implementation contract draft**（分支 `yuk-597-v2-implementation-contract`，docs-only → 免独立 review，CI 绿即可；**不 merge——等 owner 批准**「补四阻断 E2E 后再批准」）。此外**无 feature PR 在飞**（YUK-249 收官：#742 `b93ad862` + #743 均 merged 并已部署，2026-07-09）。worktree 拓扑 = main + `tlp-deploy`（NAS 部署 checkout，现指 `77075a59`）。**待 owner 清理分支**：`yuk-249-yuwen-migration` · `yuk-249-rename-stragglers`（均本地+远端）（git-guard/classifier 挡删）。
- **噪音/stale PR 待周期清**：audit-drift 周报 draft（#736/#734/#727/#711/#671/#653/#621/#600/#586/#578/#567/#555/#544）· dependabot 依赖 bump（#676-#680/#563/#564/#462/#366/#367）· 停滞 cursor draft（#590 YUK-494 worker bundle · #588 YUK-360 mem0 cost BLOCKED · #522 YUK-438 · #465/#466）。

## ✅ 最近已落（防遗落，下次别重做）

- **YUK-597 设计线收线（2026-07-10，判词 = 臂 B + opaque id）**：对抗面板 `wf_eef6dfd1-94a`（8 席）证伪 LIGHT/FULL 假分叉（KILL-1 派生轴恒空 / F1 编辑器不通电），真分叉 = 共享底座 + 臂 A(seed-root-only) vs 臂 B(+profile 行)；owner 点 B + `subj_<cuid2>`。doc `docs/design/2026-07-10-yuk597-custom-subjects.md`（v1 经 #747 merge 后 owner request-changes 降级为 implementation contract draft，v2 修订见头部【更新】）；实施 5 单 YUK-598~602 已立（见 NOW）；面板六稿在 session scratchpad、综合稿同挂 YUK-597 评论。
- **YUK-249 科目顶层改名 wenyan→yuwen（2026-07-09，已上生产 + 金标验收）**：#742（registry alias 脊柱 + registry-driven 首会 UI + drizzle 0062 + 222 文件机械 sweep，4-lens review 抓回 1 P1）· #743（Dockerfile skills COPY + vitest unit include 两处漏网）；生产 0062 applied、DB 零 wenyan、`/welcome` chips = 语文/数学/物理；DB 化 + 手填科目 → YUK-597 设计线（见 NOW）。
- **红线条文波 + Wave 2（2026-07-07）**：#724（Lane D：CLAUDE.md merge 政策等六项 + PLAN 手术 + 审查报告入库）· #725（Lane E：X6 ADR-0025 northstar fixture）· #726（Lane F：audit:fold-writes + audit:flags）· #729（YUK-573 judge 校准 MVP，report-only）· #730（YUK-576 registry 诚实化；follow-ups YUK-589/590/593 已立）。
- **Wave 3（2026-07-07~09）**：#732（YUK-579 供题覆盖细目表）· #733（YUK-577 主动开口 cut-1 ingestion）· **#738（YUK-575 durable PR1：opt-in flag + assembleCopilotRunInput 字节等价 + 单发 FAILED 语义 + pickup-stall 检测）**；YUK-592 Canceled→YUK-594；PR2 = YUK-596（4 阻断前置）。
- **YUK-538 全项目逻辑打磨 program 达成（14/14）**：#690-#707 全 merged（quickwin 批 + kc-dedup + SoT-flip + frontier-gate + softmax + kg-borrowing + verify-check + memory-reconcile + revert-bracket + conjecture-wire + induce-self-consistency + draft-status；#701 YUK-436 BKT 嫁接插单）。
- **方向 B「可开始用」硬前置代码侧**：#709（YUK-516 placement scope parity）· #710（YUK-478 冷启 e2e）· #708（AGENTS.md maps + program sync）全 merged。
- **AI pipeline 五单 + brainstorm Top-3（2026-07-06）**：#713（YUK-572 PR-1 scout）· #715（YUK-580 digest 红旗）· #716（YUK-578 审题闸）· #717（YUK-574 learner-state header）· #719（YUK-572 PR-2 director lane）· #720（YUK-581 subject bridge）· #721（YUK-583 edge watermark）· #722（YUK-379 attribution rethrow）· #714（brainstorm portfolio 存档）· #718（YUK-377 cron 复审）全 merged。
