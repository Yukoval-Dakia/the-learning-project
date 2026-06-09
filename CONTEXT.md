# CONTEXT — 领域术语表

> 仅收录对**领域专家**有意义的术语；纯实现概念（pg-boss、SSE、jsonb 字段名）放在 docs/architecture.md。
> 当对话中出现新术语或既有术语需要修订时，**就地**更新本文件，不要批量留到事后。

## 抽取与分析

- **结构化抽取（structured extraction）**：把试卷 / 教材 / 题目图像转成机器可读的题目结构（题面、选项、答案、配图坐标、用户手写答案）。架构原则：**结构化抽取 = 确定性 API**（Tencent 试题批改 Agent，异步 job），不交给 LLM。见 ADR-0002。
- **救援（rescue）**：当 Tencent Mark Agent 切错 / 切不出（`layout_quality='partial' | 'text_only'`，或部分手写涂改无法识别）时，**由用户主动**触发的 LLM Vision 抽取（Tier 2 = haiku，Tier 3 = sonnet）。区别于"自动 cascade fallback"—— 救援是显式的、付费可见的、用户授权的。
- **配图（figure / illustration）**：题目附带的图（函数图、几何图、表格图像等）。Tencent 返回坐标（`QuestionImagePositions`），系统**自动裁剪**为独立 R2 asset，元数据存于 `question_block.figures`。
- **配图归属（figure attachment）**：每张 figure 通过 `attached_to_index` 指向所属 StructuredQuestion；初配由 parser 启发式（空间包含 + 最近邻）确定，置 `attach_confidence: 'high' | 'low'`；用户可通过 `PATCH /api/question-blocks/:id/figures/:asset_id` 改归属，状态变 `'manual'`。低置信度归属在 UI 上明确标识，提示用户检查。
- **题目结构（StructuredQuestion）**：一道题的完整结构化表示，含题面 / 选项 / 答案 / 解析 / 表格 / bbox / 题型 / 题号 / 嵌套 sub_questions。是 OCR / Vision rescue / 人工编辑 / agent 修订**共享的唯一真相**字段。
- **大题 / 小题 / 叶题（stem / sub / standalone）**：StructuredQuestion 的三种角色（`role` 字段）。**大题** = 含共享 passage 的容器（阅读理解 / 完形填空 / 文言文），自身无答题动作，含 `sub_questions[]`。**小题** = 大题下的子问题，有独立题面 / 选项 / 答案。**叶题** = 独立单题，无父无子。
- **共享材料（passage）**：大题（stem）的题面文本，对其所有 sub_questions 共享。LLM 处理 sub 时调用方必须前置注入 passage 作为上下文。
- **抽取证据（extraction_evidence）**：StructuredQuestion 上的可选子对象，仅当抽取来源是 Tencent Mark Agent 时填充：
  - **handwriting**：用户写在试卷上的错答（`HandwriteInfo` 文本 + bbox）
  - **tencent_grading**：Tencent 自动判分结果（IsCorrect / RightAnswer / AnswerAnalysis / KnowledgePoints）—— **evidence only，不作为系统真相**；JudgeTask（Sub 1）独立判分，可参考但不替代
- **布局质量（layout_quality）**：抽取结果的结构完整度评分（`'structured' | 'partial' | 'text_only'`），由 parser 启发式判断（如 cloze 的空数 vs sub 数一致性）。UI 据此决定是否提示用户走 rescue。
- **来源标记（source / provenance）**：StructuredQuestion 自带 `source: 'tencent_ocr' | 'vision_rescue' | 'manual' | 'agent_edit'`，记录每一份结构化数据**从哪里来**。所有重写操作都更新此字段 + `last_modified_by`。

## 学习内容

- **错题 / 失败 attempt**：`event WHERE action='attempt' AND subject_kind='question' AND outcome='failure'`。UI 保留"错题"称呼（用户语义不变）；底层数据模型是 event 流上的 filter view。归因（cause）走 chained judge event（`caused_by_event_id` 指向此 attempt event）。
- **学习项（learning item）**：用户 / AI 声明的学习意图记录（TODO / Goal 层，ADR-0006）。三个作用：① **意图声明**——"我想学会 X"本身，与发生过的事实（event）解耦；② **项目入口 / 组织容器**——引用入口 hub note（representative 指针）+ label 交集命中的学习材料 + 关联题/组卷，`acceptLearningIntent` 拆解流水线的锚点；③ **人面进度跟踪**——status 生命周期 / user_pinned / due_at（项目期限，非复习排期）+ 派生**健康条**（读时聚合其 knowledge_ids 的 `knowledge_mastery` + due 状态，零拥有 state，ADR-0012 同族；2026-06-04 D11）。active/pinned 学习项的 knowledge_ids 进 Coach brief 的知识焦点排序——**意图只影响注意力，永不当记忆单元**（item-as-FSRS-unit 已审并否决，见 ADR-0029）。它**引用**脊柱而不拥有（ADR-0027）、**不是调度单元**（调度单元是知识点，ADR-0028；2026-06-04 修正本词条旧的"FSRS 调度单元"说法）。比喻：脊柱是图书馆，学习项是借书计划单。
- **变体（variant）**：从原 attempt 派生的同质题，用于巩固练习。Sub 5 Maintenance lane 批量生成。
- **知识点（knowledge）**：学科知识树的节点。一个 attempt event 可挂 0..N 个 knowledge 节点（通过 judge event payload.referenced_knowledge_ids 关联）。
- **归因（attribution）**：`event WHERE action='judge' AND actor_kind='agent'`，`payload.cause`（10 类：concept / knowledge_gap / calculation / reading / memory / expression / method / carelessness / time_pressure / other）；通过 `caused_by_event_id` 与 attempt event 链接。
- **复习（review）**：`event WHERE action='review' AND subject_kind='question'`（用户回答的永远是具体题，event 保持 question-scoped）；FSRS 状态派生到 `material_fsrs_state` 表（每次 review event 同事务写入）。**调度单元是知识点**（ADR-0028，2026-06-04 经 U0 裁决确认）：有 knowledge 标签的题，FSRS 投影按 `(subject_kind='knowledge', subject_id=知识点)` 键；未标注的 legacy 题 fallback 到 question 级投影。
- **探针（probe）**：复习一个到期知识点时被选中的那道具体题。**题是测量工具，知识点才是调度 / 记忆对象**——同一知识点可由原题、变体或新生成题轮换探测，避免"背答案"。选题 seam 当前为确定性轮换（ADR-0028 决定 #3），规划由 Coach→ReviewPlanTask 流水线接管（仅替换该 seam，不动记忆单元）。
- **判分（judge）**：评判用户对一道题的答案是否正确，输出分数 + 评语 + 错误细节（写为 judge event）。2026-06-04 U0 裁决：judge event payload 钉 `profile_version` / `capability_ref` / `judge_route`（判时在内存、写时落 event），历史判分的版本上下文从此可重建；rejudge = 新 event，不改写旧结果。
- **组卷 / 试卷（paper / tool_quiz）**（2026-06-04 U0 裁决 X2）：一组引用题池 question 的练习集，**唯一容器是 `tool_quiz` artifact**（长期存储、knowledge 标签、`metadata.question_ids` 引用题池）——Coach 排期的"今日试卷"、用户按需测验、daily/final/笔记嵌入小测都是它，靠 provenance（plan 引用 / source）区分，**不分裂成第二容器**。做卷中的 attempt 走 `learning_session(type='review')`（复用 pause/resume/abandon）；Coach 的 session 内自适应 = artifact 就地更新 + adaptation event 留痕（`caused_by` 链到触发判分）。今日/往日练习有一级页面可查。
- **复习规划（review planning）**（2026-06-04 U0 裁决 X3）：两级流水线——**Coach 出战略 brief**（科目配比 / 知识焦点 / 时间盒，住在 TodayPlan 的 `review_session_proposal` 扩展里），**ReviewPlanTask 按 brief 做战术出卷**（从候选池选题/探针、写 plan、session 内 checkpoint 自适应；池子不够时输出 `needs[]` 声明而非自己生成）。记忆（Mem0 / memory brief）只进 Coach、经 brief 下传，**永不直接参与选题**。
- **梦境流（Dreaming lane）**：夜间 cron 跑的批量任务，挖新知识点 / 调整掌握度 / 提议关联；产出为 `event WHERE action='propose' AND actor_kind='agent' AND actor_ref='dreaming'`。
- **维护流（Maintenance lane）**：每周 cron 跑的批量任务，复检知识树质量 + 批量生成变体；产出走 MaintenanceSuggestion（含 snapshot + rollback_until）。
- **记忆（memory / attention prior）**（ADR-0017；治理 2026-06-04 U0 裁决）：双层——Mem0 fact 层（细节，按需检索）+ brief 层（方向感，per-scope 三窗 markdown）。**记忆是注意力先验，不是 SoT**（SoT = event + knowledge_mastery view）；只供 orchestrator 角色（Coach / Dreaming / Copilot）读取，evaluator / operator / 生成类任务（judge、tagging、attribution、ReviewPlanTask、QuizGen、KnowledgeReview）一律不读——个性化信号经 Coach brief 洗过后下传。记忆永不直改 due / mastery / FSRS，永不给判分加偏置。

## 录入与会话

- **录入会话（ingestion session）**：一次"用户上传一批材料 → 系统抽取 → 落库"的工作单元。状态机：`uploaded` →（用户触发抽取）→ `queued` →（worker 起跑）→ `extracting` → `extracted` / `partial` / `failed`；`extracted` / `partial` 可 `markReviewed()` → `reviewed`（可选步骤，`commitImport()` 也直接接 `extracted` / `partial`）→ **`imported`（终态，只读）**。`failed` 可 `retryExtraction()` 重入 `queued`。所有 transition 由 `src/server/ingestion/session.ts` 单一守卫，五个写入位置（POST /api/ingestion、/extract、handler、/rescue、/import）都走它。**救援是 block-level**：session 状态不变（partial → partial），仅替换单块内容。
- **会话总结（session summary）**：用户主动结束一次学习会话时由 LLM 生成的总结。Phase 1b 新增（架构 review Q1）。

## 已批准（approved，2026-05-15 v2 — event-driven 核）

> 2026-05-15 grill：用户明确 AI-Driven（C+D 档）是中心设计概念。ADR-0006 v2 推翻 v1 单表 encounter，转向 3-table 模型（material + learning_session + event）。本节词条对应 ADR-0006 v2 + ADR-0008 修订。Phase 1c.1（Steps 1-9）已落地。
>
> v1 词条（遭遇 / 单表 outcome / exposure）已被 v2 取代，见 ADR-0006 v1 决策（已被取代）节。

- **知识网（knowledge mesh）**（ADR-0010）：`knowledge.parent_id` 作主层级 backbone（tree），叠加 `knowledge_edge` 表承载有类型横向链接。**relation_type** 核心 5 类：`prerequisite | related_to | contrasts_with | applied_in | derived_from`，外加 `experimental:*` 命名空间。AI 与用户都可 propose / generate / rate edge。"tree 是骨架，mesh 是肌肉"。
- **事件（event）**（ADR-0006 v2）：学习系统里发生的一次动作（user / agent / cron / system 皆可）。`actor_kind × action × subject_kind` 三轴定位；payload 按 Zod discriminated union 守。subject_kind 含 `knowledge_edge`（ADR-0010 扩展）。**替代** 旧的 `mistake` / `review_event` / `dreaming_proposal` 三表。
  - 例：用户错答 = `event(actor='user', action='attempt', subject=question, outcome='failure')`
  - 例：AI 归因 = `event(actor='agent:attribution', action='judge', subject=event, caused_by=...)`
  - 例：AI 提议变式 = `event(actor='agent:variant_gen', action='generate', subject=artifact)`
  - 例：用户接受 AI 提议 = `event(actor='user', action='rate', subject=event, payload={rating:'accept'})`
- **学习会话（learning_session）**（ADR-0008 修订）：通用 session envelope。type ∈ `ingestion | review | conversation | tutor | explore | create`。一个 session 内的 event 流自然成 timeline。`type='conversation'` **替代** ADR-0004 原规划的独立 agent_sessions / agent_messages 表。
- **AI 平等 actor**（ADR-0006 v2 核心原则）：event.actor_kind ∈ {'user', 'agent', 'cron', 'system'} —— AI 不是注释层，是和用户对等的事件发起者。Copilot 对话、Dreaming 夜间产出、Critique 自批改全部 first-class。
- **事件链（event chaining）**：event.caused_by_event_id 把因果连成 DAG。可重放、可审计、可让 critique agent 作用在历史 event 上。
- **核心 6+ action 严守 Zod + experimental:* 松守**（ADR-0006 v2 Option 折中）：已稳定的 `attempt / judge / propose / generate / review / rate / extract` 用 discriminated union 严守 payload；新交互用 `experimental:*` 命名空间先跑，稳了再 promote。

### 概念 → event 流映射（Phase 1c.1 已落地）

- **错题**（"做错的题"用户语义）= `events WHERE action='attempt' AND outcome='failure' AND subject_kind='question'`
- **归因**（AI 判错因）= `events WHERE action='judge' AND actor_kind='agent'`，`payload.cause`
- **复习**（FSRS 到期重做）= `events WHERE action='review'`；FSRS 状态投影到 `material_fsrs_state`
- **梦境流 / 维护流**（Dreaming / Maintenance）= `events WHERE actor_kind IN ('agent','cron')` 夜间批量产出
- **学习项（learning_item）**—— **保留** TODO / Goal 语义，与 event 解耦（用户 / AI 声明的学习意图 ≠ 发生过的事件）

## AI 能力组织（skill / behavior pack）

> 2026-06-08 grill 裁决：「skill」一词此前被过载（审计 AP-4），就地收归单一含义。

- **技能包（skill / SKILL.md）**：可移植的**领域方法论指令包**，位于 `src/subjects/<id>/skills/<name>/SKILL.md`，frontmatter 含 `name` + `description`（description 是模型加载的触发钩子），正文是领域知识/规范（出题、笔记、质检标准等）。经 `ctx.skills` 白名单喂进 Claude Agent SDK，由对应 Task 按需加载。**「skill」在本项目只指这一样东西**——它是「把方法论交给模型按需加载」的知识，**不是**代码路由，**不是**在服务层用 enum 静态分流。现有 6 个：`note-{math,physics,wenyan}`、`quiz-gen-{calculation,reading-comprehension,translation}`，被 NoteGenerate/Verify/Refine 与 QuizGen/QuizVerify/Sourcing 共用。一个对应推论：题型规范（如「文言文阅读 = 原文 + 一组小题」）已住在技能包里，是**真相**；若生成产物没遵循，病灶在落库管线（schema / handler）而非知识层。
- **行为包（behavior pack，≠ skill）**：`src/server/copilot/skills/{teaching,solve}-skill.ts` 与 `COPILOT_SKILL_KINDS` enum 是**服务层 TS 编排**（组一个 `TeachingTurnTask` 调用、绕开 CopilotTask 自由 loop），曾被冠以「skill」之名（AP-4 术语过载）。**它们不是技能包，停止用 skill 指代。** 一个「模式」本质上拆成三样、各有归处：**方法论 → 技能包**、**确定性副作用 → loop 内工具/effect**、**能力范围 → tool allowlist**；没有第四样需要独立代码路。目标形态：teaching/solve 两个 behavior pack 最终**消解**，不保留为独立构造（迁移路径见 `.omc/research/copilot-implementation-audit-2026-06-07.md` AP-1~AP-4 / Step 0~3）。
