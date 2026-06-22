# 抽取层 = 确定性 OCR，LLM 只做分析

> **2026-06-22 修订注记（Lane D / YUK-482）**：本 ADR 第一段列举的 LLM 任务里，`KnowledgeProposeTask` 已被移除。原计划由「答错 attempt → 触发 KC 提议」走该 task，现按 axis-cleanup 拆除：**提议 / 创建 KC 是 CONTENT 轴动作**（由材料覆盖内容驱动），**与学生答题正误无关**；答错是 PERFORMANCE 轴信号 → 只喂错因 / attribution + mastery。KC 创建现完全走 content-driven 路径（cold-start-bridge / image-candidate-accept matcher / agent proposal-tools）+ 维护流 `KnowledgeReviewTask`。详见 `docs/architecture.md` §5.1 与 PR #559。下文出现 `KnowledgeProposeTask` 的历史段落保留作演进记录，**不再现役**。

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

---

**修订（2026-05-30）— VLM 全权拥有结构，腾讯降为纯文字 OCR hint（T-OC / YUK-145，OC-1/OC-2）。slice 2 已实装。**

**Trigger**：T-OC OCR/录入 pipeline 重建 design（`docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md`，design-approved 2026-05-29）。feature 探查暴露原"抽取层 = 确定性 OCR"在两类硬伤上扛不住：**跨页大题**腾讯结构提取搞不定（YUK-144），**题图匹配**靠易错的 bbox 启发式（`assignFigures`）。

**演进原则**：这是对本 ADR 原则"结构抽取是 deterministic problem，交给专用 OCR"的**演进**而非否定：结构/语义层在带手写、跨页、复杂版式的真实录入场景里**不是** deterministic problem，需要 reasoning。字符 OCR 仍是确定性的，仍归腾讯。

**实装设计（slice 2 已落地，YUK-145）**：
- **腾讯 OCR 退为纯文字底层**：腾讯 Mark Agent 仍**逐页**跑（字符级文字提取 + 手写答案 + 题图 bbox），但其**结构输出降为 text hint** —— 在 handler 里把每页 `parseMarkAgentResponse` 的 `questions` 用 `structuredToPromptMarkdown` 拍平成 `=== page K ===` 分隔的 markdown，作为 VLM 的参考文字，不再是结构 source of truth。
- **StructureTask（VLM mimo-v2.5 多模态）拥有结构**：新 AI task（`src/ai/registry.ts` + `buildStructurePrompt` in `src/ai/task-prompts.ts`，`invocation:'auto'`，类比 `StepsJudgeTask`）。runner 实现：`src/server/ingestion/structure.ts` `runStructureTask` —— 输入 N 页图片（runner 多模态路径一条 user message 带多图，已验证支持）+ 腾讯文字 hint → 严格 JSON `StructureOutput`（Zod 校验）→ 规范结构树（`source:'vlm_structure'`，id 运行时补）。VLM 可完全覆盖腾讯切分。
- **跨页大题组装（YUK-144 根治）**：handler 从单页（`source_asset_ids[0]`）改为**读全部 session 页**喂 VLM；prompt 明确要求把横跨多页的同一大题组装成**一个** stem。
- **regression safety / evidence-first**：VLM 失败（provider down / 输出不可解 / 0 题）时抛 `StructureTaskError`，handler **回落到腾讯逐页拼接的结构**（即 slice 1 行为）并记一条 warning —— provider 故障降级而非硬失败。
- **接缝（wiring）**：`src/server/boss/handlers/tencent_ocr_extract.ts` 把 VLM 树作为结构 of record 传给 `Ingestion.applyExtractionResult`；下游 import route + slice-1 `enrollCapturedBlock` 不变（仍读 `question_block.structured`）。

**题图匹配 DEFER 到 slice 2b（未实装）**：OC-2 的 VLM 题图匹配（VLM 判图属哪题，替代 `assignFigures` 启发式）**本次没做**。原因：它要把 VLM 生成的 question-id 命名空间和 crop/bbox 命名空间耦合（VLM 给不出可靠像素 bbox，crop 仍需腾讯 bbox），半成品会导致图错挂且难审计。slice 2 仍用 `assignFigures`（腾讯 bbox 启发式）做题图归属；StructureTask prompt 已为 2b 留好扩展位（output schema 加 figures 块 + 串 id）。见 `docs/superpowers/plans/2026-05-30-yuk145-toc-slice2-lane.md` §DEFERRED。

**Status**：
- **Slice 1（YUK-145，已实现）**：OC-3 泛化捕获 model fix（见 ADR-0024）。
- **Slice 2（YUK-145，本次已实现）**：StructureTask VLM 实装 + 腾讯结构降为 hint + 跨页大题组装。**题图匹配（slice 2b）+ TaggingTask/WorkflowJudge（slice 3）仍为 future。**

**Agent 修改约束沿用**：VLM 写 `structured` 仍须走领域工具集（Zod 校验 + version + provenance）；裸 jsonb 不开放。本次 StructureTask 是 extraction-time 一次性写 `question_block.structured`（走 `applyExtractionResult`），不是 agent 在已物化 question 上的增量编辑。

**See also**：`docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` §2（OC-1/OC-2）+ `docs/superpowers/plans/2026-05-30-yuk145-toc-slice2-lane.md`（slice 2 边界 + slice 2b/3 DEFERRED）+ `docs/superpowers/plans/2026-05-30-yuk145-toc-slice1-lane.md` + ADR-0024（slice 1 的 OC-3 model）。
