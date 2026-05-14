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

- **错题（mistake）**：一道用户做错的具体题目实例。挂在一个 `question` 上，可能多个 mistake 共享同一 question（用户多次做错同一题）。
- **学习项（learning item）**：FSRS 调度单元，泛指 mistake / 变体 / 概念卡。
- **变体（variant）**：从原 mistake 派生的同质题，用于巩固练习。Sub 5 Maintenance lane 批量生成。
- **知识点（knowledge）**：学科知识树的节点。一个 mistake 可挂 0..N 个 knowledge 节点。
- **归因（attribution）**：分析一次错误的成因（10 类 cause：concept / knowledge_gap / calculation / reading / memory / expression / method / carelessness / time_pressure / other），写入 mistake.cause。
- **判分（judge）**：评判用户对一道题的答案是否正确，输出分数 + 评语 + 错误细节。
- **梦境流（Dreaming lane）**：夜间 cron 跑的批量任务，挖新知识点 / 调整掌握度 / 提议 mistake-knowledge 关联。
- **维护流（Maintenance lane）**：每周 cron 跑的批量任务，复检知识树质量 + 批量生成变体。

## 录入与会话

- **录入会话（ingestion session）**：一次"用户上传一批材料 → 系统抽取 → 落库"的工作单元。状态机：`uploaded` →（用户触发抽取）→ `queued` →（worker 起跑）→ `extracting` → `extracted` / `partial` / `failed`；`extracted` / `partial` 可 `markReviewed()` → `reviewed`（可选步骤，`commitImport()` 也直接接 `extracted` / `partial`）→ **`imported`（终态，只读）**。`failed` 可 `retryExtraction()` 重入 `queued`。所有 transition 由 `src/server/ingestion/session.ts` 单一守卫，五个写入位置（POST /api/ingestion、/extract、handler、/rescue、/import）都走它。**救援是 block-level**：session 状态不变（partial → partial），仅替换单块内容。
- **会话总结（session summary）**：用户主动结束一次学习会话时由 LLM 生成的总结。Phase 1b 新增（架构 review Q1）。

## 提议中（provisional，待 brainstorm grill）

> 以下词条出自 2026-05-14 审查 + brainstorm（见 `docs/superpowers/brainstorms/2026-05-14-phase1c-encounter-session-ui.md`），**未落地、未 grill 终结**，留作未来 Phase 1c 设计入口。落地后从本节移走、合并进上面正式词条。

- **遭遇（encounter）** *(provisional, R1)*：学习者与材料的一次交互。outcome 可为 `wrong | right | exposed | created | drilled | reviewed`。试图替换当前 `mistake` 为 first-class entity——`mistake` 退化为 `encounter where outcome='wrong'`。**Phase 1c brainstorm 主推方向。**
- **学习会话（learning_session）** *(provisional, R5)*：通用 session envelope。type ∈ `ingestion | review | tutor | explore | create | conversation`，统一承载 timeline / summary / artifacts。ADR-0005 的 `IngestionSession` 模块退化为本结构的一个子状态机。
- **暴露（exposure）** *(provisional, R1 outcome)*：仅"看过 / 读过 / 听过"但未答题的 encounter outcome。区别于 wrong（答错）和 right（答对）——填补"只输入未输出"的语义空缺。
