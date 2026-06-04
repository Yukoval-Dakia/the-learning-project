# ADR-0029 — Coach 复习引擎落在既有原语上（U0 裁决簇）

**Status**: Accepted (2026-06-04)
**Part of**: YUK-203（领域模型重构）· YUK-205（U0 决策 gate）。
**Decision source**: `docs/audit/2026-06-04-design-feasibility-audit.md`（29-agent 可行性审计，30 条高严重度发现全部经对抗验证）+ 2026-06-04 grill 会话逐条拍板（决议全文 `docs/superpowers/specs/` 三份 spec 的同日修订）。
**Related**: ADR-0006 v2（event 核）/ ADR-0008（session envelope）/ ADR-0012（mastery 派生 view）/ ADR-0014（capability registry；其 part 调度 facet 已被本簇 D2 注记 supersede）/ ADR-0017（memory 双层）/ ADR-0020（artifact）/ ADR-0025 ND-5（proposal-only 正主）/ ADR-0028（知识级 FSRS，随 P3 分支合入）。

---

## 背景

`2026-06-03-coach-led-review-engine-design.md`（CO）为 Coach 主导的动态试卷复习引擎提议了 7 张新表与一个独立 planner 任务。可行性审计发现其中三处**隐式推翻已锁决策**（target-domain-model §7、ADR-0014、ADR-0028），并与在途 P3 实现赛跑；同时仓库既有原语（artifact / event / learning_session / 闲置 answer 表 / Mem0 双层）已覆盖绝大部分需求。本 ADR 记录把引擎**落回既有原语**的裁决簇——产品 intent（知识点排期、paper UX、judge-now/show-later、Coach 编排）全部保留，存储与编排形态重定。

## 决定

1. **知识级 FSRS = 复用 `material_fsrs_state(subject_kind='knowledge')`**（ADR-0028）。不建 `knowledge_review_state`；其复活条件 = 出现第二个非 FSRS scheduler policy，且必须显式 supersede ADR-0028。`mastery_estimate`/`uncertainty` 不入存储列（ADR-0012：mastery 是派生 view）。
2. **试卷容器 = `tool_quiz` artifact，一个容器**。Coach 排期卷与用户按需测验同容器，靠 provenance（`intent_source`/`source`/`source_ref` + plan 引用）区分。`review_plan`/`review_paper_attempt`/`paper_question_assignment` 三表不建：sections 与 per-assignment intent（含 `part_ref`、`primary_knowledge_id`、`selection_reason`、profile 快照）进 `ToolStateT` v2 jsonb；运行中 attempt = `learning_session(type='review')` + 新增 nullable `learning_session.artifact_id` 列；session 内自适应 = artifact 就地更新（version 乐观并发）+ adaptation event（`caused_by` 链到触发判分）。
3. **答案与判分留在 event 流**。判分 = judge event payload + `visible_to_user`/`revealed_at`（缓冲反馈的全部所需）；已提交答案 = per-slot attempt/review event；evidence = event 流 + `knowledge_mastery` view。`paper_answer`/`paper_judgement`/`paper_evidence_result` 不建。**闲置 `answer` 表复活**为答题卡草稿层（autosave 的可变工作态；submit 冻结 + event 引用），同步清 allowlist 债。
4. **复习规划 = Coach → brief → ReviewPlanTask 两级流水线**。Coach 出战略 brief（住 TodayPlan `review_session_proposal` 扩展）；ReviewPlanTask 独立注册、专属窄 surface（read brief / knowledge snapshot / candidates / write plan），输出即 paper artifact，带 `needs[]` 声明缺口；checkpoint 自适应归 ReviewPlanTask（Coach 不进热循环）。**ReviewPlanTask 不读记忆**——注意力先验经 Coach brief 单通道下传。
5. **judge event 钉版本**：payload 增可选 `profile_version`/`capability_ref`/`judge_route`，`capability_ref.version` 停止硬编码改读 `SubjectProfile.version`。历史判分的版本上下文从此可重建；rejudge = 新 event 不改写旧结果。
6. **治理归位**：记忆治理与 AI 产出准入规则统一住 agent-framework spec §3——`search_memory_facts`（client.ts 薄封装）只授 coach/dreaming/copilot；evaluator/operator/ReviewPlanTask/QuizGen/KnowledgeReview 不读记忆。准入按爆炸半径：per-item 测量元数据（review_profile/coverage）auto-active 带 provenance 可回滚；全局策略（subject profile）publish-gated。proposal-only 正主 = ADR-0025 ND-5，各 spec 只引用不复述。

## 后果

**正面**
- 新表数：CO 原案 7 → **0 必建**（`question_knowledge_coverage` 按需 DEFER）；调度/容器/证据全部押在已验证原语上，`audit:schema` 零新债。
- P3 分支（ADR-0028 实现）直接成为落地载体；paper 白捡 `learning_session(review)` 的 pause/resume/abandon 与 artifact 的 history/version 机制。
- 版本钉 + 单通道记忆 + 爆炸半径准入，三份 spec 的治理从此一处定义。

**代价 / 风险**
- `tool_state` jsonb 承载 sections/assignment intent：写边界必须加 Zod parse barrier（jsonb 内部 key 不受 `audit:schema` 保护）；跨卷分析依赖 event 流而非可 join 的 assignment 表——若日后出现高频跨卷查询，`question_knowledge_coverage` 物化是预留的逃生口。
- paper artifact 在 attempt 进行中可变，"artifact 不可变"直觉让位；以 adaptation event 留痕兜审计。
- `answer` 表复活需补 slot/paper/session 链接列与写路径（一次 migration）。

## 备选（已否决）
- CO 原案 6+1 新表（重复造 event-sourcing / 与 tool_quiz、learning_session、answer 表三重撞车——审计 X1/X2/X4，全部对抗验证 upheld）。
- ReviewPlan 作为 Coach 的输出 mode（单 agent，无独立边界）——否决以保住 planner 窄工具面 + Coach 不进热循环。
- ReviewPlanTask 直读 Mem0 ——否决以保"记忆不进选题"的单通道治理。
