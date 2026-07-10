# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-10　·　历史头部日志（2026-06-23 ~ 07-10 全部超龄【更新】叙事段，含 YUK-597 v1 判词段）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真，含 P5/P9/A5 KEEP 裁决证据锚点 + YUK-249 收线段）。

> **【更新 2026-07-10 · YUK-597 v3 trait 合同批准（实施权威）+ YUK-603 收口上线】** v2 批准（#748）当日 owner 另提「Subject Control Plane」proposal → 9 席对抗面板（`wf_2c38ce81-8c2`：3 外部检索 + 4 对抗 + 2 替代设计）判「方向正确、不按原样实施、分层采纳」→ owner 四判词（**A** 科目常态 ~10+ → 跨科复用一等 / **B** 新工作新配置足够 → LISTEN/SSE/outbox/epoch 出局 / **C** 排序 = Phase-0 bug → 598/599 → 600 → **602 提前** → 601 / **R** 科目级 rubric = 写端注入指导题目级规范，judge 介入 calibration-gated 二期）→ **v3 trait-hybrid 合同**（6 trait kind + 共享绑定 + 自动 COW fork + append-only 双 journal + 控制面全局 advisory lock + rubricGuidance 四锚点）经 3.5 轮机器对抗（54 findings）+ 两轮 owner review（R1 4P1+2P2 → v3.1；R2 2P1+3P2 → v3.2）后 **owner 批准 v3.2 = 实施权威**（本 PR 入库：`docs/design/2026-07-10-yuk597-v3-trait-subjects.md`）。**YUK-598~602 描述已第三次对齐 v3.2**（7 席 opus 对抗校验后落 Linear）；**Phase-0 两小单已立：YUK-610**（Dockerfile 漏 COPY `_shared/skills`——copilot 共享包生产静默降级，live bug）+ **YUK-611**（扁平 skill 镜像跨科撞名防线）。同日 **YUK-603 PR-0 全链收口**：#749 merged（`4918753c`）+ 生产部署验证（0063 applied、armed_rows=0、health 200）、Linear Done。实施开工令另等 owner。（上一条 v2 契约修订【更新】已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`）

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局），非纯机械「记+练+复习」闭环。但**机械架构基底先打牢**——诊断轴消费底层引擎/检索/matcher。状态 check 结论（`scratchpad/PROJECT-STATUS-REPORT.md`，2026-06-23）：B1 θ̂ SoT + 检索 + owner 门 + poolFetch **已够硬撑 day-one B**；唯一 day-one 软缺口 = 档案露出 **YUK-476**（后端 live、UI 零渲染）。冷启 day-one 先验仍是底色（记忆 `feedback_cold_start_first`）。

**两条主 project（B 的地基）**：① **领域模型重构 YUK-203**（机械基底：matcher/检索/B1-B5/event-sourcing/note 域）② **学习者全面档案 YUK-452 / A1-A15**（诊断档案）。**owner 排序：先把 event-sourcing 脊柱 YUK-471 浇筑好**，再做诊断露出（YUK-476 → ...）。状态 check 还发现：domain 0 假 Done、profile 0 假 Done；matcher（YUK-397）+ event-sourcing impl（YUK-471）+ misconception 一等节点 = 已建未通电/未落，但**不在 day-one B 关键路径**（act/later 深化弧）。

## NOW（当前 active 线）

> 模式转向（owner 2026-06-21）：从「捡 issue 吞吐」转「单项目深度冲刺到一条可感 milestone」。原则 [defer flip not build]（记忆 `feedback_defer_flip_not_build`）。执行图 `docs/planning/2026-06-21-cold-start-openable-sprint.md`（镜像 Linear Document 挂 YUK-452）。

- **YUK-597 实施批 = 下一条 active 线（v3.2 trait 合同已批准 2026-07-10，等 owner 开工令）**：科目 = 6 trait 绑定聚合 + opaque id `subj_<cuid2>`；权威依据 `docs/design/2026-07-10-yuk597-v3-trait-subjects.md`（**v3.2，owner 批准**；v2 doc 未被替换章节按 v3 头部明示继续生效）。实施依赖序（判词 C；YUK-598~602 描述已对齐 v3.2）：**Phase-0 立即先行 = YUK-610**（Dockerfile `_shared` COPY，live bug）**+ YUK-611**（skill 撞名防线）→ **YUK-598**（三集合 + provider 水合 + scope_key）∥ **YUK-599**（六表族 DDL + 装配水合 + backup 纳编）→ **YUK-600**（thin-create 绑定式 + goal 防线 + knownSubjects + nightly gate + rubricGuidance 四锚点）→ **YUK-602（提前）**（onboarding 手填 UI，owner 原话落点）→ **YUK-601**（trait 编辑面 + §3.5 读面 + 漂移治理 + 夜间 cron --strict）。⚠️ YUK-601/602 动 UI 前须先落一份合并 UI design doc 获批（UI Design Compliance）。PR-0 = YUK-603 已收口上线（见 ✅）。
- **方向 B「可开始用」milestone — 代码侧全部完成，flag ①批已 LIVE**：S1 YUK-516（#709 merged）· S2 YUK-478 冷启 e2e（#710 merged）· S3 判定无代码活。**YUK-571 flag ①批（`PLACEMENT_PROBE_ENABLED` + `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`）实况 = 2026-07-06 已翻并注入生产容器**（07-09 核验：容器 env + HTTP 零写 smoke 400-not-404；day-zero census 已存档 YUK-571 评论——question=0 / knowledge=3 seed root / 学习表全零）。**剩 gate = 冷库零题（owner 上传/生成内容）→ 首次真实 placement 会话跑通**（空池返回 `sourcingNeeded:true` 走 quiz_gen，设计态非错误态）；② refill 前置未验且空池无意义、③ 按单据明确不动——均维持 off。⚠️ 生产 = 本机 OrbStack compose（`tlp-deploy`），可用性依赖 OrbStack 在跑（always-on ingress 见 PARKED Step6）。

## NEXT（就绪，排队）

- **YUK-596 durable-by-default flip（YUK-575 PR2）**：翻 copilot durable 默认 + N4 Dock 202-branch + in-loop stop + poll frequency。⚠️ **4 条阻断前置**已记 issue 评论（#738 独立 review 终裁 2026-07-09，含 Codex P2 causal-filter 修形）；宜先跑 PR1 opt-in burn-in。
- **Wave 3 follow-up 批**：YUK-594（durable judge lane，替代已 Cancel 的 YUK-592）· YUK-595（主动开口 cut-2 连错 streak）· YUK-589（judge 校准第二期）· YUK-590（观测面诚实化第二期）· YUK-593 + YUK-394（OCR review = **额度耗尽**，owner 07-09 确认；补额度前该 check 挂/跳过均按非阻断处理，勿重跑）。
- **🦀 Rust 同构核 Phase 0+（YUK-495 project）** ⚠️待核：Phase 1 已 DONE（#634）；Phase 0+/Phase 2 后续项（inc-E YUK-455 prereq 传播 dark-ship 等）状态需 re-ground（原详细 NEXT 记录随头部日志归档）。
- **旧 loop-wiring 尾巴 + profile/教研团冷启 prior 设计**：openable 通电、有真实交互后据外部信号设计（gated on 数据）。

## PARKED（已捕获，不是现在）

- **红线审查 owner 拍板菜单（13 项分三批）** = `docs/audit/2026-07-07-redline-challenge-audit.md` §5：批① 成文冲突 ✅（#724）· 批② 两 REWRITE ✅（P2 cockpit #724 · X6 ADR-0025 #725）· 批③ 工程单候选 2/8 已落（audit:fold-writes + audit:flags #726）——**剩 6 项待 owner 拍**（step9 断言 / P6 到期悬崖拆解 / X2 成本叙事 / A2 执行状态列 / A3 勘误 / /audit-drift 通电）。sweep 溢出 2 条未审（kg-mesh-no-tree-edge / credit-decay weight 分离）留下轮。
- **brainstorm 存活 8 条（留档待挑）** = `docs/design/2026-07-06-agency-data-brainstorm-portfolio.md`：教学督导 Part A（次优①）· 周期校准探针 producer+consumer 一体（次优②）· applied_in 死边通电 · 自动 dismiss 悬空提案 · knowledge_edge CREATE 升 A 档（前置 = proposal_signals 采纳率 gate）· 夜间 job 性价比审计 · 答案泄漏护栏 · 会话连接图。**红线挑战组 3 条** = portfolio §5 决策表未拍板。
- **🧠 误区(misconception)建模调查 + 翻 MISCONCEPTION_PROMOTE flag 设计** = doc 存档（2026-07-01，`docs/design/2026-07-01-misconception-*`）。
- **Linear 卫生**（审计 `w8iz32mse`，待 owner 批）：stale 状态对齐（YUK-519/531/476/407 终裁建议翻 Done/收口；YUK-303/306/373/375/360 移出 In Progress）。
- **栈瘦身 / overhead audit**（owner 起念「砍 AI+math → Rust」）· **🦀 Rust 算力兑现 tripwire**（教研团重算演示埋线）· **Step6 [ops] NAS always-on 部署**（`TUNNEL_TOKEN` + compose up）· **C7-C10 matcher cleanup**（折入 YUK-397，随 inc-5 / live-caller）。
- **tlp-deploy 误启残留**：`tlp-deploy_pgdata` / `tlp-deploy_mem0data` 两只空 volume（07-10 平行栈事故遗留——tlp-deploy 目录内裸 `compose up` 建了错误项目栈，已 down；classifier 挡删）待 owner `docker volume rm`。

## BLOCKED-ON（在等什么 — 冷启修正后多为「需先验」非「纯等数据」）

- **YUK-567 = probe-answer prep-desk card UI**（design-gated：card 组件不存在，需 claude.ai/design pass 后 slice-by-slice）← producer live 无插头。
- **profile P2 翻 flag**（misconceptionRecurrence / B4 answer_class filter）← 需数据 + judge 校准。
- **matcher 接 live caller** ← 题库规模 + Step2 feeder 验证（小题库 cosine 不稳）。
- **教研团 YUK-405 / 记忆 YUK-322** ← profile 有真实数据 / 交互历史。
- **A9 step-grading 倍增器（YUK-438，#522 draft）** ← judge 校准数据（YUK-573 MVP #729 已 merge，report-only 采样积累中；第二期 YUK-589）。

## 在飞（PRs / workflows / worktrees）

- **在飞 PR**：**#750**（yuk-607-json-parse-repair —— quiz JSON 修复带 + YUK-606 ctx.db，平行 lane，主工作树在推进）· **#751**（YUK-597 v3.2 合同 + 驾驶舱同步 docs PR；判词即授权，CI 绿即 merge，merge 后此条清）。worktree 拓扑 = main（现被 yuk-607 lane 占用）+ `tlp-deploy`（部署 checkout，现指 `4918753c` = 生产实况）+ `tlp-yuk597-v3docs`（本 docs PR 临时 worktree，merge 后清）。**待 owner 清理分支**：`yuk-249-yuwen-migration` · `yuk-249-rename-stragglers`（均本地+远端）（git-guard/classifier 挡删）。
- **噪音/stale PR 待周期清**：audit-drift 周报 draft（#736/#734/#727/#711/#671/#653/#621/#600/#586/#578/#567/#555/#544）· dependabot 依赖 bump（#676-#680/#563/#564/#462/#366/#367）· 停滞 cursor draft（#590 YUK-494 worker bundle · #588 YUK-360 mem0 cost BLOCKED · #522 YUK-438 · #465/#466）。

## ✅ 最近已落（防遗落，下次别重做）

- **YUK-597 v3.2 trait 合同批准（2026-07-10，本 PR 入库）**：owner「Subject Control Plane」proposal → 9 席面板分层采纳 → 四判词（A/B/C/R）→ trait-hybrid 合同 3.5 轮机器对抗（54 findings）+ 2 轮 owner review（R1/R2 共 11 findings）→ 批准 = 实施权威；YUK-598~602 三次对齐完成（7 席 opus 校验）；Phase-0 YUK-610/611 已立。
- **YUK-603 scope_mode PR-0 收口（2026-07-10，#749 `4918753c`，已上生产）**：subject goal 停止冻结派生 scope、读时真派生（三分支写路 + 四读点 live-resolve + tier-3 排根）；0063 migration（判据收紧数据修复）生产 applied、armed_rows=0、health 200；Linear Done。
- **YUK-597 v2 契约批准（2026-07-10，#748 merged）**：owner request-changes（4 阻断 + 8 缺口）→ v2 就地重写（run `wf_78170c3d-f74` 6 席 opus + 独立 opus 复核 REVISE 全修）→ owner 批准；其 §2 状态模型后被 v3 取代，未替换章节继续生效。
- **YUK-597 设计线收线（2026-07-10，判词 = 臂 B + opaque id）**：对抗面板 `wf_eef6dfd1-94a`（8 席）证伪 LIGHT/FULL 假分叉（KILL-1 派生轴恒空 / F1 编辑器不通电），真分叉 = 共享底座 + 臂 A(seed-root-only) vs 臂 B(+profile 行)；owner 点 B + `subj_<cuid2>`。doc `docs/design/2026-07-10-yuk597-custom-subjects.md`（v1 经 #747 merge 后 owner request-changes 降级为 implementation contract draft，v2 修订见头部【更新】）；实施 5 单 YUK-598~602 已立（见 NOW）；面板六稿在 session scratchpad、综合稿同挂 YUK-597 评论。
- **YUK-249 科目顶层改名 wenyan→yuwen（2026-07-09，已上生产 + 金标验收）**：#742（registry alias 脊柱 + registry-driven 首会 UI + drizzle 0062 + 222 文件机械 sweep，4-lens review 抓回 1 P1）· #743（Dockerfile skills COPY + vitest unit include 两处漏网）；生产 0062 applied、DB 零 wenyan、`/welcome` chips = 语文/数学/物理；DB 化 + 手填科目 → YUK-597 设计线（见 NOW）。
- **红线条文波 + Wave 2（2026-07-07）**：#724（Lane D：CLAUDE.md merge 政策等六项 + PLAN 手术 + 审查报告入库）· #725（Lane E：X6 ADR-0025 northstar fixture）· #726（Lane F：audit:fold-writes + audit:flags）· #729（YUK-573 judge 校准 MVP，report-only）· #730（YUK-576 registry 诚实化；follow-ups YUK-589/590/593 已立）。
- **Wave 3（2026-07-07~09）**：#732（YUK-579 供题覆盖细目表）· #733（YUK-577 主动开口 cut-1 ingestion）· **#738（YUK-575 durable PR1：opt-in flag + assembleCopilotRunInput 字节等价 + 单发 FAILED 语义 + pickup-stall 检测）**；YUK-592 Canceled→YUK-594；PR2 = YUK-596（4 阻断前置）。
- **YUK-538 全项目逻辑打磨 program 达成（14/14）**：#690-#707 全 merged（quickwin 批 + kc-dedup + SoT-flip + frontier-gate + softmax + kg-borrowing + verify-check + memory-reconcile + revert-bracket + conjecture-wire + induce-self-consistency + draft-status；#701 YUK-436 BKT 嫁接插单）。
- **方向 B「可开始用」硬前置代码侧**：#709（YUK-516 placement scope parity）· #710（YUK-478 冷启 e2e）· #708（AGENTS.md maps + program sync）全 merged。
- **AI pipeline 五单 + brainstorm Top-3（2026-07-06）**：#713（YUK-572 PR-1 scout）· #715（YUK-580 digest 红旗）· #716（YUK-578 审题闸）· #717（YUK-574 learner-state header）· #719（YUK-572 PR-2 director lane）· #720（YUK-581 subject bridge）· #721（YUK-583 edge watermark）· #722（YUK-379 attribution rethrow）· #714（brainstorm portfolio 存档）· #718（YUK-377 cron 复审）全 merged。
