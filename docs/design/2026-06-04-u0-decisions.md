# U0 裁决记录（2026-06-04 grill 会话确定稿，YUK-205）

> 来源：docs/audit/2026-06-04-design-feasibility-audit.md 的 U0 gate + §5 七问，经逐条 grill 用户拍板。
> 本文件是 spec 修订的唯一权威输入；与三份 spec 原文冲突处一律以本文件为准。

## D1（X1）：知识级 FSRS 归属
复用 `material_fsrs_state(subject_kind='knowledge')`（ADR-0028 路线，P3 分支 `yuk-203-p3-knowledge-fsrs` 已有半成品实现 + advisory lock + forward-migration）。**不建** `knowledge_review_state` 表。复活条件 = 真出现第二个非 FSRS scheduler policy，且必须写显式 supersede ADR-0028。CO 的 `mastery_estimate`/`uncertainty` 列违反 ADR-0012（mastery 是派生 view），随表一起取消。P3 分支按既有协议（gate+独立 review）合入，作为 U2 载体。

## D2（A2）：part 不再是独立调度单元
ADR-0014 的 part 独立调度 facet 被 ADR-0028 supersede（已落 ADR-0014 update note）。part 作为独立 question 行的判分/血缘/figures 语义不变。**未标注 knowledge 的 part 在 tagging/enroll 时默认继承写实 parent 的 knowledge_ids**（写实标签，非读时继承）；question 级 FSRS fallback 只留真正无主 legacy。"parent 聚合调度" DEFERRED 项作废。

## D3（X2+X6）：试卷容器 = tool_quiz，一个容器
paper = `tool_quiz` artifact（长期存储 + knowledge_ids 标签 + provenance 三轴区分 Coach 卷/用户卷）。CO 的 `review_plan`/`review_paper_attempt`/`paper_question_assignment` 三表**不建**。
- attempt 运行时 = `learning_session(type='review')`（复用 pause/resume/abandon + orphan cron），新增 **1 个 nullable 列 `learning_session.artifact_id`**（合该表 per-type 专用字段先例）
- 4 个 additive delta：① `ToolStateT` Zod 加 v2 variant（`sections[]`：knowledge focus / feedback_policy / adaptation_policy + per-assignment intent：`{question_id, part_ref?, primary_knowledge_id, secondary_knowledge_ids, selection_reason, review_profile_snapshot}`；平铺 question_ids 形保留给 embedded_check/存量）② assignment 支持 part_ref ③ artifact↔session 链接列 ④ **做卷 UI + 今日/往日练习一级页面**（硬需求，Coach 卷+用户卷统一列出；UI 落地走 design pre-flight）
- session 内自适应 = artifact 就地更新（version 乐观并发）+ adaptation event 留痕（caused_by 链到触发判分）
- plan 与 paper 合一：ReviewPlanTask 的输出就是 paper artifact（带 §7.1 的 labels/rationale/guardrail 契约，subject_ids 不变量保留）

## D4（X4）：答案与判分持久化
- 判分 = 维持 judge event（payload 加 `visible_to_user` 或 `revealed_at` —— 缓冲反馈全部所需）。`paper_judgement`/`paper_evidence_result` 不建；evidence = event 流 + knowledge_mastery view
- 已提交答案 = per-slot attempt/review event（part 是判分边界），照旧喂 FSRS/mastery（TDM"不另记"守住）
- 草稿 autosave = **复活 inert `answer` 表**为答题卡 slot 存储（形状现成：input_kind/content_md/image_refs/vision_extracted；补 slot/paper/session 链接列）；submit 冻结 submitted_at + event 引用 answer 行。allowlist 债同步清
- 铁律：answer 表复活（本裁决）—— 不许第三种"继续挂着"

## D5（X3）：复习规划 = Coach → brief → ReviewPlanTask 两级流水线
- Coach 出战略 brief（科目配比/知识焦点/时间盒/intent tags），家 = TodayPlan 的 `review_session_proposal` 字段扩展（coach.ts:20-24 现 {count,estimated_minutes} 养大），不另立 artifact type
- ReviewPlanTask 独立注册 + 专属窄 surface：`read_coach_brief` + `get_review_knowledge_snapshot` + `select_review_question_candidates` + `write_review_plan`（产出 paper artifact）。`initial_plan`/`checkpoint_adapt` 两 mode；`needs[]`（question_profile_refresh/question_generation）留在输出上
- **ReviewPlanTask 不读记忆**（Mem0/brief 只进 Coach，注意力先验经 brief 洗过下传）
- 触发：pg-boss 链 coach_daily → review_plan 夜间出卷 + on-demand 重出（无新鲜 brief 时降级纯 due-pressure）
- CoachTask 不进 session 热循环（checkpoint_adapt 归 ReviewPlanTask）

## D6（§5-Q5）：judge event 钉版本，现在做
judge event payload 加 3 个可选字段 `profile_version`/`capability_ref`/`judge_route`；修掉 `capability_ref.version` 硬编码 '1.0.0'（question-contract.ts:92,239 / steps-judge.ts:10），改读 SubjectProfile.version。**作为 PS/CO 共享的第一块地基 slice**，排在一切 Studio UI 之前。rejudge = 新 event 不改写旧结果。

## D7（§5-Q6）：记忆治理三件套
① 治理条款统一进 **AF §3**（工具权限 owner），CO §10 缩成引用；核心规则引 ADR-0017 原文（attention prior 非 SoT）+ 禁止效应（不直改 due/mastery/FSRS、不偏置判分）
② `search_memory_facts` DomainTool **建**（src/server/memory/client.ts 之上薄封装 —— Mem0 后端已完整落地，mem0ai@3.0.4 + client/triggers/scope_tagger/active-subjects 全在，审计"不存在"仅指 agent 工具层），只授 `coach`/`dreaming`/`copilot`
③ deny 从宽：evaluator/operator（judge/tagging/structure/attribution/verification）+ ReviewPlanTask + QuizGenTask + KnowledgeReviewTask 一律不读记忆

## D8（§5-Q7 + C2）：准入规则 + 不变量归一
- blast-radius 准入规则明文进 AF §3：**per-item 测量元数据**（review_profile、coverage 行）= auto-active，必须带 confidence+provenance、可追溯可回滚（status 灭活/覆写）；**全局策略**（subject profile）= publish-gated。CO §1.6 与 PS §4 改为引用
- proposal-only 不变量正主 = ADR-0025 ND-5（+ADR-0004）；CO §11 / PS §4+§11 / AF §1.2 三处复述改一句引用 + 各自特有增量条款保留

## D9（PS 裁剪，读法 A：MVP 刀法 + 零 CUT 全 DEFER）
- **MVP KEEP**：D6 stamping（第一刀）→ audit:profile registry 遍历修复（YUK-206）→ SubjectProfileDraft+ProfileImpactReport Zod → draft-JSON→validateProfile→diff CLI 编译脚本 → profile→TS 字面量 serializer → ProfileCriticTask（唯一 MVP agent）→ 只读 /admin/subjects 页（复用 (admin) layout+TokenGate；将来写操作必须走 /api/admin/* 继承 token gate）
- **DEFER + 显式触发器**（不删愿景）：4 张 subject_profile_* DB 表（触发 = git 流证明不够用）；due-queue 预览（触发 = 第二个 scheduler policy 存在）；cause-taxonomy board + subject_id rename/alias/fork 分类器（触发 = 第一次真实 rename/split 需求）；ProfileAuthorTask（触发 = Critic 环跑顺）；route-resolution diff 预览（近期最有用的 impact 预览，可先做但不挡 MVP）
- **PS §0 不反转**：高影响编辑保持"允许但强 gate"；gate 工具到位前 Studio UI 暂无入口 = 排期非政策。cause-id lint 守护（causeLean 硬编码 + variant_gen 靶向）并进 YUK-172

## D10（AF 序列）
- **新增 Slice 0 = Copilot chat composer**（M；后端 runCopilotChat 完整，前端 TodayCopilotDrawer.tsx:107-109 是占位符 —— AF 所有 slice 的隐藏前置；与 YUK-169 协调，7A 已 merge，composer 做在 shell 挂的 drawer 里）
- Slice 6 去重 → 交叉引用 CO spec + D5 流水线
- Slice 4 合并对象是**三个** chat surface：Active Teaching + **SolveTutor（YUK-193，文档原漏）** + Copilot；保护约束：corrective-chip 独立 endpoint 保留（KPI 分离）、ask_check raw INSERT 留窄服务路径不进 Copilot 工具面、旧路由迁移期并行。仍排最后（XL）
- 执行序：S1（文档+标 ADR-0004 superseded-in-product-shape）→ S0 ∥ S5（leave_agent_note，零 schema 骑 ExperimentalEvent）→ S2a（去 Today 文案，S）→ S3a（turn 持久化+replay-last-N，M）→ S2b（CurrentUserContext v0 = route+单 active_ref，L）→ S3b（rolling summary，L，YAGNI gate：真超窗才做）→ S4（XL）
- B8 两通道分工写进 AF §4：`needs[]` 留 plan artifact（结构化、Coach 下轮消费）；`leave_agent_note` 带过期带外 hint；共享 `signal_kind` 词汇

## D11（grill 追问产物）：学习项与调度的边界
用户提议"学习项当 FSRS 单元、挂 knowledge_ids、拥有目标"——**否决**（四个结构性死因：重叠 item 双排期同一记忆 / item 生命周期会静默退役知识 / 无主知识需要 fallback 又回双调度器 / 证据粒度错配；CO §2.3 原案已否决同形态）。三条收编获用户确认：
① active/pinned 学习项的 knowledge_ids 作为 **Coach brief 的一等输入**（注意力压力，永不碰记账）——已落 CO §7.1 Inputs
② item-scoped 试卷已存在（quiz_gen trigger 指针支持 learning_item_id），无需改动
③ 学习项**健康条** = 读时聚合其 knowledge_ids 的 knowledge_mastery + due 状态（ADR-0012 同族，零拥有 state）——已落 CO §2.4 derived-consumer 注记 + CONTEXT.md

## 已落盘（本会话）
- CONTEXT.md：学习项（修内矛盾）、复习（知识点调度）、探针（新）、组卷/试卷（新）、复习规划（新）、判分（version 钉）、记忆（新）
- ADR-0014：2026-06-04 update note（D2）
- ADR-0029：本裁决簇的 ADR（独立文件）
