# CONTEXT — 领域术语表

> 仅收录对**领域专家**有意义的术语；纯实现概念（pg-boss、SSE、jsonb 字段名）放在 docs/architecture.md。
> 当对话中出现新术语或既有术语需要修订时，**就地**更新本文件，不要批量留到事后。

## 产品形态：五个用户面（2026-06-10 REV 2）

> 源：`docs/archive/superpowers/specs/2026-06-10-architecture-redesign-design.md` §1（YUK-1575 重立档）。AI 是唯一编排者；机制（FSRS、due 队列）永不直接暴露给用户。

- **用户只做四件事**：录题、声明意图、做练习、审批提议。
- **五个用户面**：中央工作台（shell）/ 练习面（practice）/ 知识图谱与笔记（knowledge + notes）/ 录入（ingestion）/ Copilot 抽屉（copilot）——其余一切一律幕后。
- **AI 只有两条用户信道**：提议收件箱（proposal inbox）+ 工作台观察摘要。

## 学习状态与学习安排（已批准目标，2026-10-06）

来源：[ADR-0066](docs/adr/0066-typescript-adaptive-learning-architecture.md)。以下是已批准的产品目标，尚不表示新实现已经上线。

- **学习状态**：对学习者当前掌握情况的判断，连同证据来源、置信程度与版本。它随新证据修正，推断与已经发生的事实分开。只有**独立作答**更新掌握度（θ/PFA 与自动调度评级）；看讲解、带提示的作答只算过程证据（YUK-1604：assistance 曝光 + hint 计数留痕，结算侧 θ abstain `learner_assisted`）。
- **动态学习安排**：结合当前状态、学习目标、可用时间和正在进行的活动，持续调整下一步。学习活动也用于获得证据、减少判断中的不确定性。
- **实时自适应学习**：状态追踪与学习安排持续共同演进；新证据能够及时改变判断与后续活动，旧判断不能覆盖更新的状态。延迟与判断质量需分别验证。

## 抽取与分析

- **结构化抽取（structured extraction）**：把试卷 / 教材 / 题目图像转成机器可读的题目结构（题面、选项、答案、配图坐标、用户手写答案）。架构原则：**结构化抽取 = 确定性 API**（Tencent 试题批改 Agent，异步 job），不交给 LLM。见 ADR-0002。**（2026-07-07 X2 审查补注：post-YUK-145 T-OC 主结构 owner 已改为付费 VLM `StructureTask`（mimo-v2.5, `invocation:'auto'`），腾讯降为纯文字 OCR hint——「确定性 API」现指腾讯文字底层的接口契约稳定性，主结构抽取是每次录入自动触发的 baseline VLM。付费动作红线 scope = 上传即隐式授权 baseline 抽取，只门控 baseline 之外的 discretionary 付费升级与 cascade；见 ADR-0002 修订 2026-05-30。）**
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
- **知识点（knowledge）**：学科知识树的节点。一个 attempt event 可挂 0..N 个 knowledge 节点（通过 judge event payload.referenced_knowledge_ids 关联）。节点带身份标记 **role**（YUK-1600）：`kc`（可测知识点，默认，唯一可评掌握/写 θ/PFA/FSRS/进供给与选题候选的身份）、`goal`（LearningIntent topic 路径新建的目标根）、`container`（subject seed 根等结构性容器）；非 kc 读面一律「不评掌握」，goal 与 kc 可经 mesh 边互相关联、互不替代。拍卷 tag 检索只匹配 role='kc'（目标/容器不作题目的知识点，YUK-1604）；agent 铸的新 KC 一律 `approval_status='pending'` 并记录待确认依据（有效域未解析 / 挂目标或容器下），带 original_quote、mapping_confidence 与 provider/model/revision/cost 对账块；存量错分根（起点锚、pre-pending 的 auto-tag KC）由 ops 脚本经控制面事件修复、保留 ID 与原证据。
- **归因（attribution）**：`event WHERE action='judge' AND actor_kind='agent'`，`payload.cause`（10 类：concept / knowledge_gap / calculation / reading / memory / expression / method / carelessness / time_pressure / other）；通过 `caused_by_event_id` 与 attempt event 链接。
- **复习（review）**：`event WHERE action='review' AND subject_kind='question'`（用户回答的永远是具体题，event 保持 question-scoped）；FSRS 状态派生到 `material_fsrs_state` 表（每次 review event 同事务写入）。**调度单元是知识点**（ADR-0028，2026-06-04 经 U0 裁决确认）：有 knowledge 标签的题，FSRS 投影按 `(subject_kind='knowledge', subject_id=知识点)` 键；未标注的 legacy 题 fallback 到 question 级投影。
- **探针（probe）**：复习一个到期知识点时被选中的那道具体题。**题是测量工具，知识点才是调度 / 记忆对象**——同一知识点可由原题、变体或新生成题轮换探测，避免"背答案"。选题 seam 当前为确定性轮换（ADR-0028 决定 #3），规划由 Coach→ReviewPlanTask 流水线接管（仅替换该 seam，不动记忆单元）。
- **判分（judge）**：评判用户对一道题的答案是否正确，输出分数 + 评语 + 错误细节（写为 judge event）。2026-06-04 U0 裁决：judge event payload 钉 `profile_version` / `capability_ref` / `judge_route`（判时在内存、写时落 event），历史判分的版本上下文从此可重建；rejudge = 新 event，不改写旧结果。
- **答案类别（answer class）**（owner 2026-06-17 PIVOT，源：`docs/archive/superpowers/plans/2026-06-17-kind-step3-answer-class-consolidation.md`，YUK-1575 重立档）：题目的答案形态轴（如选择题 / 填空 / 手写推导）落为**独立 `answer_class` 列**（+ 请求侧 `requested_answer_class`，分类器 `deriveAnswerClass` 纯结构推导、历史由 `answer_class_backfill` 夜作业回填），**不通过扩格 `judge_kind_override` 表达**——后者仍是只许 `exact | keyword | semantic` 的封闭小集合。判分方式（judge kind）与答案类别（answer class）是两条正交轴，不得互相搭桥。
- **组卷 / 试卷（paper / tool_quiz）**（2026-06-04 U0 裁决 X2）：一组引用题池 question 的练习集，**唯一容器是 `tool_quiz` artifact**（长期存储、knowledge 标签、`metadata.question_ids` 引用题池）——Coach 排期的"今日试卷"、用户按需测验、daily/final/笔记嵌入小测都是它，靠 provenance（plan 引用 / source）区分，**不分裂成第二容器**。做卷中的 attempt 走 `learning_session(type='review')`（复用 pause/resume/abandon）；Coach 的 session 内自适应 = artifact 就地更新 + adaptation event 留痕（`caused_by` 链到触发判分）。今日/往日练习有一级页面可查。导出可打印作答卷（导出时逐题创建发放）见本节的**作答卷导出**。
- **复习规划（review planning）**（2026-06-04 U0 裁决 X3）：两级流水线——**Coach 出战略 brief**（知识焦点 / intent tags / 文案，住在 TodayPlan 的 `review_session_proposal` 扩展里；题数 / 分钟 / 时间盒 / 科目配比由 `src/core/daily-review-plan.ts` 按到期队列与每日预算计算，YUK-1622），**ReviewPlanTask 按 brief 做战术出卷**（从候选池选题/探针、写 plan、session 内 checkpoint 自适应；池子不够时输出 `needs[]` 声明而非自己生成）。记忆（Mem0 / memory brief）只进 Coach、经 brief 下传，**永不直接参与选题**。
- **梦境流（Dreaming lane）**：夜间 cron 跑的批量任务，挖新知识点 / 调整掌握度 / 提议关联；产出为 `event WHERE action='propose' AND actor_kind='agent' AND actor_ref='dreaming'`。
- **维护流（Maintenance lane）**：每周 cron 跑的批量任务，复检知识树质量 + 批量生成变体；产出走 MaintenanceSuggestion（含 snapshot + rollback_until）。
- **记忆（memory / attention prior）**（ADR-0017；治理 2026-06-04 U0 裁决）：双层——Mem0 fact 层（细节，按需检索）+ brief 层（方向感，per-scope 三窗 markdown）。**记忆是注意力先验，不是 SoT**（SoT = event + knowledge_mastery view）；只供 orchestrator 角色（Coach / Dreaming / Copilot）读取，evaluator / operator / 生成类任务（judge、tagging、attribution、ReviewPlanTask、QuizGen、KnowledgeReview）一律不读——个性化信号经 Coach brief 洗过后下传。记忆永不直改 due / mastery / FSRS，永不给判分加偏置。
- **作答卷导出（worksheet export）**：导出作答卷时对每道可判题各落一条**发放（issuance）**——不可变的发题记录（被发题门拒的题不发不导）——再据此生成可打印的作答卷 PDF；回读按这些冻结发放重建，不重跑发题门。每页带身份：页眉的人读短码 + 「第 x/y 页」，以及内容为 `tlp://ws/v1/<token>/<页>/<总页>` 的二维码。打印页路由 `/print/worksheet/$token`，PDF 由 worker 的 `worksheet_render` job 用无头 Chromium 渲染；同一遍渲染量出的**区域图（region map）**冻结存档，供回收时按坐标对位。

## 题库准入与出题

- **准入（admission）/ 待准入**：一道题（题组）必须先通过准入判定，才会被自动出给学习者；`withheld` 期间不进练习池。判分准入状态只有 `admitted` / `withheld` 两种；`withheld` 必须记明原因：`unverified_rules`（规则尚未经双门核验）、`verification_failed`、`no_admitted_executor`、`owner_hold`。判定由准入 job 执行：题目发布后自动排队做准入判定，双解与标定通过后才 `admitted`；但声明了尚不支持、未知或损坏的 `answer_shape` 的题会在入队前被拦下，一直停在 `withheld(unverified_rules)`。网页来源题（`sourcing_web`）来源核对通过、`quiz_verify` 质检通过，在当前版本尚无独立准入时首次发布为 `withheld(unverified_rules)`——这种状态叫「待准入」，题库界面显示为「还在检查」。
- **暂不出题（serving hold）**：题目被判定暂时不能出给学习者。底层挂起（suspension）维度只有 `verify_hold` 与 `retraction_hold` 两个原因；题库「暂不出题」页签展示的暂不出题原因则共 8 种：`awaiting_admission`、`admission_failed`、`source_check_failed`、`verify_hold`、`retraction_hold`、`no_input_renderer`、`invalid_presentation`、`withdrawn`，每种都有对应白话标记；页签上的计数与筛选覆盖全库，不只是当前已加载的页。解除命令 `reverify` / `recheck_source` / `release_verify_hold`，经 `POST /api/questions/[id]/serving-actions/[command]`，每个命令都要求 `Idempotency-Key`；`release_verify_hold` 只清 `verify_hold`，不动 `retraction_hold`，`owner_hold` 这类有意扣留没有 reverify。
- **付费效果（paid effect）作废与后继重授权**：一次已经付过费的模型调用记为一个「付费效果」，同一效果身份（同一对象、同一版本、同一单元、同一输入）只记一次账，重新投递不会再付一次。结果未知（`unknown`）的效果可由负责人显式作废为终态 `voided`——不删除、不改写输入与历史——并在同一条授权下指定一个后继效果（后继只能由授权里绑定的那次投递认领）。

## 录入与会话

- **录入会话（ingestion session）**：一次"用户上传一批材料 → 系统抽取 → 落库"的工作单元。状态机：`uploaded` →（用户触发抽取）→ `queued` →（worker 起跑）→ `extracting` → `extracted` / `partial` / `failed`；`extracted` / `partial` 可 `markReviewed()` → `reviewed`（可选步骤，`commitImport()` 也直接接 `extracted` / `partial`）→ **`imported`（终态，只读）**。`failed` 可重新入队（`enqueueExtraction()`）回到 `queued`。**救援是 block-level**：session 状态不变（partial → partial），仅替换单块内容。
- **会话总结（session summary）**：用户主动结束一次学习会话时由 LLM 生成的总结。Phase 1b 新增（架构 review Q1）。
- **上传材料的使用范围（usage choice）**：学习者上传材料时选择这份资料可以用在哪里：`allow`（**全部使用**，也可进长期记忆、学习总结）或 `answer_only`（**只用于本题**，只用来生成这道题的答案与判分）。上传后可经 POST `/api/ingestion-sessions/:id/purpose` 在 `allow` 与 `answer_only` 间变更（body 含 `request_id`、`source_document_id`、`expected_version`、`target`），系统 `crisis` 不可被用户放宽。GET 同路径读回执、停止与派生修复状态；已外发副本与未归因历史仍记 `unknown`，不宣称全部撤回（详见 `docs/planning/2026-10-28-ingestion-purpose-change-full.md`）。
- **使用回执（usage receipt）**：上传识别后给学习者的一条回执，说明从识别出的文字里隐去了哪些类别的个人信息（只报类别与处数，不报被隐去的值），以及**原图是否原样交给 AI**（拍照 / PDF 必须把原图交给识别引擎，回执明说原图原样交出；Word 文本行不外传图像）。在录入会话详情里可以查看这份回执，Word 文本行也补写回执。

## 安全

- **危机守卫（crisis guard）**：Copilot 在**接纳点**对用户消息做确定性词法分类（不接模型）；命中时服务端强制把该回合的 `derivation_policy` 设为 `crisis`，覆盖客户端送来的任何值，`answer_only` 回合也可被收紧为 `crisis`。回应不在接纳点生成，而由版本化模板文件给出，每条模板带审定状态 `未审定` / `已审定`（当前全部 `未审定`）。守卫事件 `experimental:crisis_guard` 只记类别、模板版本与入口，**永不写原文**。`crisis` 是受限用途：危机回合在写入点就退出记忆摄取（读写两面都排除），其回复与镜像同样排除。

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
- **事件对象（event subject）**：一次学习动作直接作用的对象，例如知识点、题目或另一条事件。同一条因果链可以经过不同事件对象；“事件对象不同”不表示跨学科，也不表示没有共同起因。
- **核心 6+ action 严守 Zod + experimental:* 松守**（ADR-0006 v2 Option 折中）：已稳定的 `attempt / judge / propose / generate / review / rate / extract` 用 discriminated union 严守 payload；新交互用 `experimental:*` 命名空间先跑，稳了再 promote。

### 概念 → event 流映射（Phase 1c.1 已落地）

- **错题**（"做错的题"用户语义）= `events WHERE action='attempt' AND outcome='failure' AND subject_kind='question'`
- **归因**（AI 判错因）= `events WHERE action='judge' AND actor_kind='agent'`，`payload.cause`
- **复习**（FSRS 到期重做）= `events WHERE action='review'`；FSRS 状态投影到 `material_fsrs_state`
- **梦境流 / 维护流**（Dreaming / Maintenance）= `events WHERE actor_kind IN ('agent','cron')` 夜间批量产出
- **学习项（learning_item）**—— **保留** TODO / Goal 语义，与 event 解耦（用户 / AI 声明的学习意图 ≠ 发生过的事件）

## AI 能力组织（skill / behavior pack）

> 2026-06-08 grill 裁决：「skill」一词此前被过载（审计 AP-4），就地收归单一含义。

- **技能包（skill / SKILL.md）**：可移植的**领域方法论指令包**，位于 `src/subjects/<id>/skills/<name>/SKILL.md`，frontmatter 含 `name` + `description`，正文是领域知识/规范（出题、笔记、质检标准等）。pi 执行引擎没有文件系统 skill loader——调用方（`resolveCopilotSkillDocs` / `resolveNoteSkillDoc` / `resolveQuizGenSkillDocs`）读出 SKILL.md 正文，经 `piSkillDocs` 注入 provider 的 system prompt；缺包时不注入、回退 prompt 散文。跨科共享包放在 `src/subjects/_shared/skills/`。**「skill」在本项目只指这一样东西**：**不是**代码路由，**不是**在服务层用 enum 静态分流。现有 8 个：`_shared` 的 `copilot` 与 `quiz-gen` 只由 `resolveCopilotSkillDocs()` 加载给 Copilot；`note-{math,physics,yuwen}` 由 `resolveNoteSkillDoc()` 给笔记生成/核验/精修；学科 `quiz-gen-{calculation,reading-comprehension,translation}` 由 `resolveQuizGenSkillDocs()` / `resolveQuizGenSkillDocsForSubject()` 给 QuizGen 与 QuizVerify。一个对应推论：题型规范（如「文言文阅读 = 原文 + 一组小题」）已住在技能包里，是**真相**；若生成产物没遵循，病灶在落库管线（schema / handler）而非知识层。
- **行为包（behavior pack，≠ skill）**：server 端现役行为包只有 `teaching`（`COPILOT_BEHAVIOR_PACK_KINDS = ['teaching']`），由 `src/capabilities/copilot/server/skills/teaching-skill.ts` 做**服务层 TS 编排**（组一个 `TeachingTurnTask` 调用、绕开 CopilotTask 自由 loop），曾被冠以「skill」之名（AP-4 术语过载）。**它不是技能包，停止用 skill 指代。** `solve` 已脱离聊天路由，只作为暂无 UI 入口的独立解题提示服务存在（`solve-skill.ts`）；`skill_context` 仍保留 solve/quiz 只为兼容已持久化的值。一个「模式」本质上拆成三样、各有归处：**方法论 → 技能包**、**确定性副作用 → loop 内工具/effect**、**能力范围 → tool allowlist**；没有第四样需要独立代码路。目标形态：`teaching` behavior pack 最终**消解**，不保留为独立构造（迁移路径见 `.omc/research/copilot-implementation-audit-2026-06-07.md` AP-1~AP-4 / Step 0~3）。

## 提案中（PROPOSED — 未批准，勿当作已定术语）

> 来源：`docs/planning/2026-09-24-question-assessment-redesign.md` 与 [implementation grounding](docs/planning/2026-09-24-question-assessment-implementation-grounding.md)（YUK-1038）。
> **owner 已认可五层模型方向并裁决全量迁移（拒绝 LIGHT 分批）**：schema 与迁移已落地（`assessment_issuance`、`evaluation_group`、`assessment_submission`、`assessment_response_draft`、`evaluation`、`evaluation_effective_head` 表，见 `drizzle/0104_yuk1044_assessment_contract_truth.sql` 与 `drizzle/0110_yuk1052_response_draft.sql`）。
> 本节仅登记草案中新出现的候选术语，**不修改也不覆盖**上文任何已批准定义；术语本身仍未定案。

- **响应槽（response slot）**（PROPOSED）：一个可作答小题下学生需要填的单个作答位置（选择集合 / 文本 / 数值 / 匹配对 / 扩展作答）。一个空不是天然一张 question 行，也不是天然一次 attempt。
- **联合评分组（evaluation group）**（PROPOSED）：需要一起判分的响应槽集合；有依赖的槽要么一起定稿并一起结算，要么在前置缺失时保持 provisional 且不结算。（对应 `evaluation_group` 表。）
- **评分依据（MarkingSpec）**（PROPOSED）：`reference_md` 之外的评分契约，可组合答案键、得分点与等级量表；每个评分单元只贡献一次分数，响应槽是证据位置而非计分权威；区分来源权威、抽取断言与核验准入。
- **有效判定（effective judgment）**（PROPOSED）：某次 submission 当前唯一生效的判分结果；候选/影子输出不进普通有效判分通道，接受与替代必须显式。（对应 `evaluation_effective_head` 表。）
