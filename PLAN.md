# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-07　·　历史头部日志（2026-06-23 ~ 07-06 全部【更新】叙事段）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真，含 P5/P9/A5 KEEP 裁决证据锚点）。

> **【更新 2026-07-07 · 红线挑战审查收官】** owner「挑战红线，追究原因与合理性」→ ultracode workflow `wf_ac7fa76c-a9b`（46 agent / 4.1M tok：16 簇+补漏 6 簇挑战者→fable 辩护→fable 终裁→fable critic）。**终裁：22 簇 = KEEP×5 / KEEP-WITH-COST×15 / REWRITE×2 / DROP×0**——REWRITE 仅 P2 cockpit（PLAN.md 看板腐败：头部日志占 42%、死指针 `.remember/remember.md`、14 天零 commit）与 X6 ADR-0025（「结构性保证」被 YUK-167 证伪 + northstar 守卫测试 fixture 退化恒绿）。条文本体几乎全承重（12 个非 KEEP 初裁被终裁实读击倒 10 个：P9 grep -c 单行巨段方法论失效 / P7 No Vercel git 考古 / P8 双重血泪 doc 实录 / A3 fixed-anchor 已建等）；**真病灶在体系层**：成文-现实分裂 ≥8 簇无对齐义务（/audit-drift 自己是 dark lane）、机器执行力与爆炸半径倒挂（「纯人肉」×12）、登记面单向棘轮、仲裁判例三案三答。**完整裁决表 + owner 拍板菜单（13 项分三批）= `scratchpad/research/2026-07-07-redline-challenge-audit.md`**；未开 Linear 单（红线改文全属 owner 拍板，拍后逐项开）；sweep 溢出 2 条未审（kg-mesh-no-tree-edge / credit-decay weight 分离）留下轮。⚠️ 执行 P2 滚存归档时须保头部日志原文——P5/P9/A5 三份 KEEP 的证据锚点在其中。

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局），非纯机械「记+练+复习」闭环。但**机械架构基底先打牢**——诊断轴消费底层引擎/检索/matcher。状态 check 结论（`scratchpad/PROJECT-STATUS-REPORT.md`，2026-06-23）：B1 θ̂ SoT + 检索 + owner 门 + poolFetch **已够硬撑 day-one B**；唯一 day-one 软缺口 = 档案露出 **YUK-476**（后端 live、UI 零渲染）。冷启 day-one 先验仍是底色（记忆 `feedback_cold_start_first`）。

**两条主 project（B 的地基）**：① **领域模型重构 YUK-203**（机械基底：matcher/检索/B1-B5/event-sourcing/note 域）② **学习者全面档案 YUK-452 / A1-A15**（诊断档案）。**owner 排序：先把 event-sourcing 脊柱 YUK-471 浇筑好**，再做诊断露出（YUK-476 → ...）。状态 check 还发现：domain 0 假 Done、profile 0 假 Done；matcher（YUK-397）+ event-sourcing impl（YUK-471）+ misconception 一等节点 = 已建未通电/未落，但**不在 day-one B 关键路径**（act/later 深化弧）。

## NOW（当前 active 线）

> 模式转向（owner 2026-06-21）：从「捡 issue 吞吐」转「单项目深度冲刺到一条可感 milestone」。原则 [defer flip not build]（记忆 `feedback_defer_flip_not_build`）。执行图 `docs/planning/2026-06-21-cold-start-openable-sprint.md`（镜像 Linear Document 挂 YUK-452）。

- **红线挑战审查条文落地（2026-07-07，本 wave active）**：ultracode 裁决 22 簇（KEEP×5 / KEEP-WITH-COST×15 / REWRITE×2 / DROP×0）→ 条文/docs 修订波。审查报告入库 `docs/audit/2026-07-07-redline-challenge-audit.md`；owner 拍板菜单 13 项分三批。**merge 政策已成文化（owner 2026-07-07 选项 a：全量 pre-PR gate + 独立 review + CI 绿 → 可自主 merge + 按 07-03 授权自主部署；owner 可点名人工合）** → CLAUDE.md Code Review Workflow 已改。多 lane 并行（各自 worktree）产条文 PR，见「在飞」。
- **方向 B「可开始用」milestone — 代码侧全部完成**：S1 YUK-516（#709 merged）· S2 YUK-478 冷启 e2e（#710 merged）· S3 判定无代码活。**剩硬前置 = YUK-571 flag ①批（owner 运维）**——翻 `PLACEMENT_PROBE_ENABLED` + `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`（顺序①→②→③ + day-zero census）；flag 翻转与部署在 owner 侧机器执行。⚠️ 三 flag 字面量不一致已 code-verify（placement `'true'` / promote `'1'` / refill `'true'|'1'`）。

## NEXT（就绪，排队）

- **ulw Wave 2 双 lane（judge 校准 + registry 诚实化）**——在飞中（见下）；收官后 YUK-573 / YUK-576 关闭。
- **AI pipeline 批判五单剩余**：YUK-575（durable lane 复活——YUK-364 建的桥零生产 caller = dead code）· YUK-577（主动开口触发线）。（YUK-573/574/576 已在飞或已 merge。）
- **能动性×数据 brainstorm Top-3 剩余**：YUK-579（供题覆盖细目表）——PARKED 待 owner 三决策点。（YUK-578 #716 / YUK-580 #715 已 merged。）
- **🦀 Rust 同构核 Phase 0+（YUK-495 project）** ⚠️待核：Phase 1 已 DONE（#634）；Phase 0+/Phase 2 后续项（inc-E YUK-455 prereq 传播 dark-ship 等）状态需 re-ground（原详细 NEXT 记录随头部日志归档）。
- **旧 loop-wiring 尾巴 + profile/教研团冷启 prior 设计**：openable 通电、有真实交互后据外部信号设计（gated on 数据）。

## PARKED（已捕获，不是现在）

- **红线审查 owner 拍板菜单（13 项分三批）** = `docs/audit/2026-07-07-redline-challenge-audit.md` §5：**批①** 成文冲突（merge 政策 ✅本 wave · P1 分层措辞 ✅本 wave · P9 路由 ✅本 wave）· **批②** 两 REWRITE 执行（P2 cockpit ✅本 wave · X6 ADR-0025 northstar fixture 退化修复）· **批③** 工程单候选（audit:fold-writes / audit:flags / step9 断言 / P6 到期悬崖拆解 / X2 成本叙事 / A2 执行状态列 / A3 勘误 / /audit-drift 通电）。红线改文属 owner 拍板，拍后逐项开 Linear。sweep 溢出 2 条未审（kg-mesh-no-tree-edge / credit-decay weight 分离）留下轮。
- **brainstorm 存活 8 条（留档待挑）** = `docs/design/2026-07-06-agency-data-brainstorm-portfolio.md`：教学督导 Part A（次优①）· 周期校准探针 producer+consumer 一体（次优②）· applied_in 死边通电 · 自动 dismiss 悬空提案 · knowledge_edge CREATE 升 A 档（前置 = proposal_signals 采纳率 gate）· 夜间 job 性价比审计 · 答案泄漏护栏 · 会话连接图。**红线挑战组 3 条** = portfolio §5 决策表未拍板。
- **🧠 误区(misconception)建模调查 + 翻 MISCONCEPTION_PROMOTE flag 设计** = doc 存档（2026-07-01，`docs/design/2026-07-01-misconception-*`）。
- **Linear 卫生**（审计 `w8iz32mse`，待 owner 批）：stale 状态对齐（YUK-519/531/476/407 终裁建议翻 Done/收口；YUK-303/306/373/375/360 移出 In Progress）。
- **栈瘦身 / overhead audit**（owner 起念「砍 AI+math → Rust」）· **🦀 Rust 算力兑现 tripwire**（教研团重算演示埋线）· **Step6 [ops] NAS always-on 部署**（`TUNNEL_TOKEN` + compose up）· **C7-C10 matcher cleanup**（折入 YUK-397，随 inc-5 / live-caller）。

## BLOCKED-ON（在等什么 — 冷启修正后多为「需先验」非「纯等数据」）

- **YUK-567 = probe-answer prep-desk card UI**（design-gated：card 组件不存在，需 claude.ai/design pass 后 slice-by-slice）← producer live 无插头。
- **profile P2 翻 flag**（misconceptionRecurrence / B4 answer_class filter）← 需数据 + judge 校准。
- **matcher 接 live caller** ← 题库规模 + Step2 feeder 验证（小题库 cosine 不稳）。
- **教研团 YUK-405 / 记忆 YUK-322** ← profile 有真实数据 / 交互历史。
- **A9 step-grading 倍增器（YUK-438，#522 draft）** ← judge 校准（YUK-573 在飞）。

## 在飞（PRs / workflows / worktrees）

- **红线挑战审查条文波（2026-07-07 active）**：多 lane 各自 worktree 产条文/docs PR——本 **Lane D** = CLAUDE.md（merge 政策 P1/P2/P6/P8/P9 六项）+ PLAN.md 手术 + design-docs（A1/A2/A3/A5/X2/A6）+ 审查报告入库；**Lane E** = ADR-0025（X6 northstar fixture 退化修复）。红线 wave 三 PR ⚠️待核（编号待开）；**停等 owner merge**（本波承载 merge 政策换文，bootstrap 期不自主合）。
- **ulw Wave 2 双 lane（2026-07-07 在飞）**：**Lane E = YUK-573 judge 校准 MVP**（生产流量 golden set + 双 judge 不同意率采样 job；report-only 绝不改 outcome/mastery/θ̂；默认 OFF kill switch）· **Lane F = YUK-576 registry 诚实化**（maxCost/fallbackChain 接线或删除 + 结构化输出迁移 + task_run_stuck reconcile sweeper）。各自 worktree off `dba3f77d` + TDD + 独立 Opus 审 → PR；撞车预期 `src/ai/registry.ts` 后合者 rebase。（注：此 Wave 2 与红线条文波共用「Lane E」名但为不同波次。）
- **噪音/stale PR 待周期清**：audit-drift 周报 draft（#711/#671/#653/#621/#600/#586/#578/#567/#555/#544）· dependabot 依赖 bump（#676-#680/#563/#564/#462/#366/#367）· 停滞 cursor draft（#590 YUK-494 worker bundle · #588 YUK-360 mem0 cost BLOCKED · #522 YUK-438 · #465/#466）。

## ✅ 最近已落（防遗落，下次别重做）

- **YUK-538 全项目逻辑打磨 program 达成（14/14）**：#690-#707 全 merged（quickwin 批 + kc-dedup + SoT-flip + frontier-gate + softmax + kg-borrowing + verify-check + memory-reconcile + revert-bracket + conjecture-wire + induce-self-consistency + draft-status；#701 YUK-436 BKT 嫁接插单）。
- **方向 B「可开始用」硬前置代码侧**：#709（YUK-516 placement scope parity）· #710（YUK-478 冷启 e2e）· #708（AGENTS.md maps + program sync）全 merged。
- **AI pipeline 五单 + brainstorm Top-3（2026-07-06）**：#713（YUK-572 PR-1 scout）· #715（YUK-580 digest 红旗）· #716（YUK-578 审题闸）· #717（YUK-574 learner-state header）· #719（YUK-572 PR-2 director lane）· #720（YUK-581 subject bridge）· #721（YUK-583 edge watermark）· #722（YUK-379 attribution rethrow）· #714（brainstorm portfolio 存档）· #718（YUK-377 cron 复审）全 merged。
