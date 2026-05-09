# Learning Orchestrator 长期设计

> 状态：长期方向 spec。本文不替代 Phase 1a/1b 的执行计划，只定义 ABC 最终目标、控制面边界、题源策略和复杂录入策略。

## 目标

构建一个 AI-driven 的学习 agent，长期同时覆盖三条闭环：

- A. 错题复习优先：基于真实错题、FSRS、错因和 mastery，决定今天复习什么。
- B. 新知识学习优先：用户说“我想学 X”时，自动拆学习路径、生成材料、安排检查题并追踪完成。
- C. 全局教练优先：每天/每周横跨复习、新学、计划、复盘和维护，主动给出可信、可解释、可拒绝的学习安排。

核心原则：长期 ABC 都要实现，但交付顺序必须是 A -> B -> C。C 依赖 A/B 跑出的行为数据和证据，否则全局规划会变成空泛日程。

## 非目标

- 不复制“作业帮级题库”。题库应由个人真实题、可验证 AI 生成题、开放材料和未来授权题库逐步生长。
- 不让一个万能 agent 直接修改事实层。orchestrator 只读状态、定策略、调任务、写 proposal/evidence。
- 不把带图题和长阅读题压成一个 `prompt_md` 文本框。复杂题必须保留原始材料和结构化引用。
- 不用搜索工具抓第三方商业题库原题。搜索用于找素材、原文、事实来源和开放资源。

## 总体架构

新增一个跨模块控制面：

```text
Learning Orchestrator / Control Plane
  -> State Reader
  -> Policy Engine
  -> Task Dispatcher
  -> Proposal / Evidence Writer
```

### State Reader

读取统一学习状态：

- `Knowledge`：知识图谱、mastery、邻接关系。
- `Question`：统一题库、来源、draft/active 状态。
- `Mistake`：错题事件、错因、FSRS 复习态。
- `LearningItem`：待学项、层级、状态、优先级。
- `StudyLog`：用户主动记录的疑问、顿悟、反思。
- `Answer` / `Judgment` / `CompletionEvidence`：学习证据。
- `SourcePack` / `SourceAsset` / `SourceDocument`：检索和录入来源。
- `CostLedger` / `ToolCallLog`：成本和可观测性。

### Policy Engine

先规则，后 LLM：

- 排序、阈值、状态机、预算守卫用 deterministic 规则。
- 归因、解释、题目生成、复盘、计划说明用 LLM。
- 每次输出必须落到结构化对象：`PlanStep`、`DreamingProposal`、`MaintenanceSuggestion`、`CompletionEvidence` 或 `Question(draft)`。

### Task Dispatcher

只调已有或明确注册的任务：

- `AttributionTask`
- `QuizGenTask`
- `QuizVerifyTask`
- `VariantGenTask`
- `VariantVerifyTask`
- `NoteGenerateTask`
- `NoteVerifyTask`
- `SourceRetrievalTask`
- `VisionExtractTask`
- `PassageSegmentTask`
- `WeeklyReportTask`

### Proposal / Evidence Writer

- 软建议写 proposal。
- 学习完成写 evidence。
- AI 不直接删除、合并、覆盖用户验证内容。
- 硬事实只由用户行为、判题结果、复习事件或审批通过的 mutation 产生。

## ABC 分阶段路线

### Phase 2A: Review Orchestrator

对应 A：错题复习优先。

回答一个窄问题：

> 今天应该复习什么，为什么？

能力：

- 读取 FSRS 到期错题、近期错因、薄弱知识点和复习历史。
- 生成 `review_session` 类型的 standalone `tool_quiz`。
- 对 concept / knowledge_gap 类错因优先配解释或变式。
- 每次 session 结束后写 Answer/Judgment/Mistake/mastery 事件。
- 输出可解释 reason，不直接改硬数据。

完成标准：用户每天能打开一个复习 session，题目选择能解释，结果能回写错题和 mastery。

### Phase 2B: Learning Intent Orchestrator

对应 B：新知识学习优先。

输入：

```text
我想学 X
```

流程：

- 判断 X 是已有知识点、缺失节点还是跨领域主题。
- 创建 hub LearningItem。
- 拆成 atomic LearningItems。
- 触发 `NoteGenerateTask` 生成 hub note + atomic notes。
- 为 atomic note 配 embedded check。
- 通过阅读、答题、StudyLog 和错题反馈追踪进度。
- 通过 self_declare / quiz_pass / ai_propose 产生 `CompletionEvidence`。

完成标准：用户能从一个学习意图开始，系统生成学习路径，并通过检查题和证据判断学习是否完成。

### Phase 2C: Active Teaching Session

把 A/B 合成一次教学会话循环：

```text
读取目标和状态
-> 选择下一步：讲解 / 例题 / 复习 / 变式 / 追问
-> 用户作答或记录
-> judge / attribution / study log
-> 更新 evidence
-> 决定继续、切换、结束或安排下次
```

完成标准：系统不只是出题或写笔记，而能围绕一个 LearningItem 连续推进学习。

### Phase 3: Global Coach Orchestrator

对应 C：全局教练优先。

每天/每周运行：

- 今日主学习目标。
- 今日复习 session。
- 最多一个轻量新内容。
- 周复盘：薄弱点、错因分布、完成项、StudyLog 反思。
- 计划调整：推迟、拆小、重学、归档。
- Maintenance：合并知识点、归档旧项、清理坏题，全部走可回滚 proposal。

完成标准：用户打开系统时，不需要从多个模块里自己找下一步；系统给出一个可信、可解释、可拒绝的学习安排。

## Source Layer：解决题库来源

题库不依赖单一外部大题库。来源分层：

1. 个人真实题：手动录入、拍照录入、卷子批量识别。
2. AI 变式题：从个人错题和知识点生成，必须 draft -> verify -> active。
3. Search-grounded 题：基于 Exa/search 找到的材料生成原创题。
4. 开放材料：OER、公有领域文本、官方资料、用户上传教材。
5. 授权题库：未来产品化或大规模应试覆盖时再接。

### Source 数据对象

```ts
SourcePack {
  id: string
  purpose: 'quiz_generation' | 'note_generation' | 'verification'
  query: string
  provider: 'exa' | 'manual' | 'local_corpus'
  result_ids: string[]
  created_at: number
}

SourceResult {
  id: string
  pack_id: string
  url?: string
  title?: string
  excerpt: string
  source_type: 'oer' | 'public_domain' | 'official' | 'web' | 'user_private'
  license?: string
  attribution?: string
  confidence: number
}
```

`Question` 长期增加：

```ts
Question {
  source_refs: SourceRef[]
  generation_method:
    | 'user_entered'
    | 'ai_generated_from_sources'
    | 'ai_variant'
  copy_safety:
    | 'original'
    | 'adapted_from_open_license'
    | 'needs_review'
}
```

### Search-grounded Quiz Pipeline

Quiz agent 不直接“上网找题”，而是先构造可追溯素材包：

```text
QuizRequest
-> QuizPlanTask：决定知识点 / 难度 / 题型
-> SourceRetrievalTask：用 Exa/search 检索素材
-> SourcePack：保存来源、摘录、license、attribution、可信度
-> QuizGenTask：基于 SourcePack + 个人错题生成原创题
-> QuizVerifyTask：检查答案、事实、抄袭风险、知识点命中
-> Question(draft)
```

规则：

- 有个人错题时，优先个人错题和变式。
- 需要新材料时，先检索 SourcePack。
- 没有合格来源，不生成事实依赖强的题。
- 不复制商业题库题干或解析。
- 所有 search-grounded 题默认 `draft`。
- 每题必须能回看 `source_refs[]`。

## Ingestion Layer：解决带图题和长阅读录入

复杂录入统一走：

```text
IngestionSession
-> SourceAsset / SourceDocument
-> AI segmentation
-> QuestionBlock
-> Human review
-> Question / Mistake
```

### 带图题

原图必须保留，OCR/vision 只是派生结果：

```text
用户上传图片 / 多图
-> 存 SourceAsset（R2/object storage，D1 只存 ref）
-> VisionExtractTask 做 OCR + layout + 图表识别
-> 生成 QuestionBlock
-> 用户确认题面、答案、知识点
-> 创建 Question / Mistake
```

`QuestionBlock`：

```ts
QuestionBlock {
  source_document_id: string
  page_index?: number
  bbox?: { x: number; y: number; width: number; height: number }
  extracted_prompt_md: string
  image_refs: string[]
  crop_refs: string[]
  reference_md?: string
  visual_complexity: 'low' | 'medium' | 'high'
  extraction_confidence: number
}
```

`crop_refs[]` 是关键：几何题、图表题、截图局部题干以后可以原样渲染，不依赖 OCR 完美。

### 超长阅读题

长材料不能复制到每道题里。引入共享 passage：

```text
SourceDocument / Passage
  -> sections / spans
  -> Question[] 引用 passage_id + referenced_span_ids[]
```

```ts
Passage {
  id: string
  source_document_id: string
  title?: string
  body_md: string
  span_index: Array<{ id: string; start: number; end: number }>
  source_refs: SourceRef[]
}

Question {
  passage_id?: string
  referenced_span_ids?: string[]
}
```

Quiz UI：

- 桌面：passage 左侧，当前小题右侧。
- 移动：passage 可折叠，题目固定在下方。
- 每道题只引用相关 span，但用户可展开全文。

### 录入 UX

```text
1. 丢进去：拍照 / 上传 PDF / 粘贴长文
2. AI 预处理：分题、识别 passage、裁剪图片、提取答案
3. 审核页：用户只修关键字段
4. 批量入库：Question + Mistake + Source refs
```

审核默认策略：

- 短题直接展开。
- 长阅读只展示 passage 标题和摘要，小题逐个展开。
- 多图/卷子默认只展开 AI 判断为错题或不确定的块。
- OCR 低信心字段高亮。
- 用户可以拆分 block，也可以合并 block。

## 阶段放置

### Phase 1.5

- `SourceAsset` / `SourceDocument` 最小 schema。
- 图片从 D1 base64 迁向 R2/object storage。
- `IngestionSession` 最小状态机。
- `vision_single` 和 `vision_paper` 共用 QuestionBlock 审核页。
- 保存 `crop_refs[]`，支持带图题原图裁剪回放。

### Phase 2

- `Passage` / `referenced_span_ids[]`，支持长阅读题。
- `SourcePack` / `SourceResult`，接 Exa/search。
- Search-grounded `QuizGenTask`。
- `QuizVerifyTask`，把 search-grounded 题从 draft 推向 active。
- Review Orchestrator 跑通 A。

### Phase 2.5

- Learning Intent Orchestrator 跑通 B。
- NoteGenerateTask 默认 Source-grounded。
- embedded check 也可基于 SourcePack 生成。

### Phase 3

- Global Coach Orchestrator 跑通 C。
- 本地教材 / 用户上传材料 RAG。
- 多 provider search / retrieval。
- 授权题库 adapter（如未来需要）。

## 安全边界

- 搜索结果和用户上传材料都必须记录 provenance。
- license 不明确的来源只用于事实核对或短摘录，不复制题干。
- AI 生成题默认 draft，不直接进入复习池。
- 用户 verified 的 note section 不被自动覆盖。
- Orchestrator 不直接删除、合并、归档；只写 proposal。
- 成本超过预算时，先降级 search-grounded 和 dreaming，保留本地复习。

## 第一可实施切片

在 Phase 1a 之后，优先做：

1. `SourceAsset` + `Question.image_refs/crop_refs`。
2. `IngestionSession` + 单图题审核页。
3. `review_session tool_quiz` 的最小 Review Orchestrator。
4. `SourcePack` + Exa provider stub，只用于 QuizGenTask grounding，不直接生成题库。

这个顺序能同时解决两个实际痛点：复杂题录入摩擦和题库来源不足，同时不打断当前错题闭环。
