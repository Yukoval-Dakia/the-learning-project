# 抽取层 = 确定性 OCR，LLM 只做分析

**决策**：所有自动抽取走 Tencent QuestionSplitOCR（确定性 API），LLM 不参与主链路抽取。LLM 任务（AttributionTask / JudgeTask / KnowledgeProposeTask）只负责语义分析 / 归因 / 判分。Vision 任务（VisionExtractTask / VisionExtractTaskHeavy）保留在 task registry，但**降级为用户手动触发的"救援工具"**，由 `/api/ingestion/[id]/rescue` 端点同步调用，不再作为 cascade 自动 fallback。

**理由**：
1. **职责分工**：结构抽取是 deterministic problem，交给专用 OCR；语义分析是 reasoning problem，交给 LLM。混用会让一次录入两层 LLM 调用，既贵又难 debug。
2. **成本可预测**：OCR 单价稳定，LLM 调用次数固化为"每道题 1 次 Attribution + 1 次 Judge"级别。
3. **用户对救援保留控制权**：OCR 切错时**用户主动**升级 Tier 2/3，系统不在背后烧钱。

**接受的代价**：OCR 失败时**没有自动 fallback** —— UI 必须显示"OCR 失败，手动触发救援"，依赖用户介入。单用户工具下可接受。

**结构化存储**：OCR 不仅输出题目文本，还**结构化存储**配图。每张题目附带的 illustration / diagram 由 OCR bbox 触发裁剪，作为独立 R2 asset，FigureRef 元数据存入 `question_block.figures` jsonb。题目本身的 prompt / options / answers / parses / tables 等结构化字段存入 `question_block.structured` jsonb（`StructuredQuestion` 类型）。下游 LLM 拿到 question 时同时拿到结构化 figures 和 markdown 派生（`structuredToPromptMarkdown()` 现场派生，不持久化）。

**Agent 修改约束**：修改 `question_block.structured` 必须走领域工具集（`updatePrompt` / `addOption` / `updateAnswer` 等，Sub 1 实现），由工具内部维持 Zod 校验 + version 递增 + provenance 留痕。**不开放裸 jsonb 编辑**，避免 schema 飘移。`extracted_prompt_md` 不持久化，所有 markdown 视图由 structured 现场派生，杜绝双源不一致。

---

**修订（2026-05-11）— 抽取层能力边界 + endpoint 选择**

实际验证（cloze 测试）暴露了 Tencent `QuestionSplitOCR` 对**结构分离布局**（完形填空 / 长 passage + 网格选项）只识别文本不识别结构。修订原则：

- **抽取层走 Tencent 试题批改 Agent**（`SubmitQuestionMarkAgentJob` + `DescribeQuestionMarkAgentJob`，异步 job 对），原计划的 `QuestionSplitOCR` 直接弃用。新 endpoint 是超集：覆盖完形填空 / 阅读理解嵌套布局，且额外返回手写答案 bbox + Tencent 内置判分。
- **抽取层仍是确定性的、非 LLM 的**。Tencent 内部用了什么模型与本系统无关；对调用方而言 Mark Agent 是黑盒 API，**接口契约稳定 + 错误码确定 + 计费透明** —— 符合"自动抽取 = 确定性 API"的精神。
- **Tencent 内置判分（IsCorrect / RightAnswer / AnswerAnalysis / KnowledgePoints）当 evidence 存，不当真相**。存入 `StructuredQuestion.extraction_evidence.tencent_grading`。Sub 1 JudgeTask 仍由本系统独立实现，Tencent 判分可作为输入信号或交叉校验，但**不替代** JudgeTask。
- **手写错答（HandwriteInfo + HandwriteInfoPositions）也归 extraction_evidence**。原计划 Sub 1 让用户手动输入错答，现在 Sub 0c 直接捕获。这是新 endpoint 带来的能力提升。
- **当 Mark Agent 都失败时**（layout_quality='text_only' 或 'partial'，例如非常规手写涂改），UI 仍走"用户手动救援" —— `POST /api/ingestion/[id]/rescue` 同步触发 Vision Tier 2/3。救援路径是用户授权的、付费可见的、可选的，**不是自动 fallback**。
- **Vision Tier 2/3 永远是用户触发的救援工具**，原则不变。

---

**修订（2026-05-21）— 推广 "structured 派生 markdown" 原则到 `question` 表（M-1）**

**Trigger**：math MVP（vision-as-input）要求 `question` 表自身承载多模态结构，不再只是 markdown 派生的下游消费表。Migration 0010_fair_selene 给 `question` 加了 `figures` / `image_refs` / `structured` 三个 jsonb 字段。

**Rule update**：原决策"`extracted_prompt_md` 不持久化，所有 markdown 视图由 structured 现场派生"从 `question_block` 推广到 `question`：

- `question.structured`（jsonb，nullable）是题目结构的 source of truth（**当 non-null 时**）。
- `question.prompt_md` / `question.reference_md` 仍持久化，但当 `structured` non-null 时**必须**能由 `structuredToPromptMarkdown` / `structuredToReferenceMarkdown` 现场派生出来（写入时保证一致）。
- `question.figures`（`FigureRef[]`）承载结构化图片元数据（含 bbox / role / attach 归属），给 vision-aware judge 用（M2 `steps@1` 是第一个消费者）。
- `question.image_refs`（`string[]`，扁平 asset_id list）给简单读取场景用，**不需要 bbox / attach 信息**的 caller 直接读这个。
- `question.metadata.prompt_image_refs` **deprecated**（M-1 / 2026-05-21）：保留以兼容老 reader（answer history rendering 等），新代码 SHOULD 读 `question.image_refs`。M3 后视使用情况移除。

**Scope**：`question_block` 语义不变（它仍是 ingestion 侧的结构化承载）。变的是 `question` 现在镜像同一套字段，让下游 judge / agent / 渲染层不必绕路回 question_block 拿结构化数据。

**Agent 修改约束沿用**：修改 `question.structured` 必须走领域工具集，version 递增 + provenance 留痕，不开放裸 jsonb 编辑。

**See also**：`docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md` §4 + `docs/superpowers/plans/2026-05-21-math-mvp-m-1-m0.md` Task 1-4。
