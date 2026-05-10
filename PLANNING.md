# AI 学习工具 · 规划主索引

> 自用 · 移动 + 桌面双修 · 应试与兴趣并行
> v0.12 · 2026-05-09 · Learning Orchestrator + Source Layer + Ingestion Layer

---

## 定位

不是「错题本 + 进度统计 + 笔记工具」三件套的拼盘，而是围绕**知识点图谱**这一根锚组织起来的个人学习系统。

错题、进度、artifact 都是知识点的不同切面：
- 错题 = 知识点上「失败的尝试」
- 进度 = 知识点上「掌握度的演化」
- artifact = 知识点上「可被反复消费的产物」（**Note 阅读型 + Tool 互动型**）
- 题目 = 知识点上「测验素材」（**Question 是统一题库**）
- StudyLog = 知识点上「用户主动记录的非错题内容」（顿悟 / 反思 / 疑问 / 标记）
- Source = 题目 / note / quiz 的来源证据（检索、上传、开放资料、个人材料）
- Ingestion = 复杂题的录入管线（图片 / PDF / 长阅读 → 结构化 Question）

只要锚不丢，模块就不会变成孤岛。**架构是泛化的**，不锁单一学科或场景；**Phase 1 首发数据集 = 文言文（高中语文）**。

长期 AI 形态不是一个直接改数据的万能聊天 agent，而是横跨模块的 **Learning Orchestrator / Control Plane**：读取学习状态，决定下一步，调度 Task，写 proposal / evidence。ABC 都要实现：A 错题复习、B 新知识学习、C 全局教练；交付顺序按 A → B → C。详见 `docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md`。

---

## 文档结构

```
the-learning-project/
├── PLANNING.md                     # 本文件 — 总览、模块速览、路线图、待决策汇总
└── docs/
    ├── architecture.md             # 跨模块基础：知识图谱 / Artifact 多态化 / 统一题库 / AI 任务层 / 技术栈 / 数据模型
    └── modules/
        ├── mistakes.md             # 错题管理（事件 + 复习态；变式题双 pass + 防繁殖；10 类错因）
        ├── learning-items.md       # 待学习列表（4 来源 + 层级化 + 6 状态机 + 优先级 score 公式 + 复学）
        ├── progress.md             # 学习进度追踪（mastery 双层 + StudyLog + 学习时间线）
        ├── notes.md                # Artifact 阅读型（note_hub / note_atomic）
        ├── lanes.md                # Dreaming + Maintenance lanes
        └── quiz.md                 # Artifact 互动型当前唯一实例（tool_quiz）+ 统一题库 Question
```

---

## 模块速览

| 模块 | 一句话 | 详细 |
| --- | --- | --- |
| 架构基础 | KG / Artifact 多态化 / 统一题库 / AI 任务层 / 技术栈 / 数据模型 | [docs/architecture.md](docs/architecture.md) |
| 错题管理 | 录入 / 归因（10 类错因）/ 复习（FSRS）；变式题双 pass + 三层防"错题繁殖" | [docs/modules/mistakes.md](docs/modules/mistakes.md) |
| 待学习列表 | hub + atomic 层级 / 6 状态机 / 优先级 score / 复学机制 | [docs/modules/learning-items.md](docs/modules/learning-items.md) |
| 学习进度追踪 | mastery 双层 + StudyLog（5 种 kind）+ 学习时间线视图 | [docs/modules/progress.md](docs/modules/progress.md) |
| Artifact: Note (note_hub / note_atomic) | 阅读型；hub + atomic 结构；source tier 防幻觉 | [docs/modules/notes.md](docs/modules/notes.md) |
| Artifact: Tool (tool_quiz) | 互动型当前唯一实例；可独立或嵌入 Note；Question/Answer/Judgment + ai_flexible 兜底 | [docs/modules/quiz.md](docs/modules/quiz.md) |
| Dreaming + Maintenance | AI 主动产出（生产 + 维护）两条 lane | [docs/modules/lanes.md](docs/modules/lanes.md) |
| Learning Orchestrator / Source / Ingestion | 长期控制面；Exa/Search-grounded quiz；图片/PDF/长阅读优雅录入 | [长期 spec](docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md) |

---

## 阶段路线图

### Phase 1 · 让一个闭环跑起来（最小可用）

只做错题管理 + 学习项 + 知识点挂载 + Note 录入 + tool_quiz 骨架，验证数据模型。

拆为 1a（最小可上手 MVP，5-7 天）和 1b（补完，1a 跑出第一周数据后做）。完整决策见 `docs/superpowers/specs/2026-05-08-phase1-improvements-design.md` 改进 3。

#### Phase 1a · 最小可用（目标 5-7 天上手）

**当前状态（2026-05-10）**：Phase 1a Sub 1-3 已 ship；Phase 1.5 ingestion foundation 已提前落地。下一步回到复习闭环，**Sub 4 拆为 4A（错题 FSRS + review_event）+ 4B（LearningItem 三态 + Evidence）**，分两个 PR ship；4A 是 Phase 1a 闭环的关键，先做。

**核心闭环（manual 录入 + 错因 + FSRS 复习）**
- [x] DB driver 接 D1（PR 1 已落）
- [x] Worker shared-secret auth（PR 1 已落）
- [x] AI Task Runner 骨架 + ToolCallLog / CostLedger（PR 2 已落）
- [x] 知识点 schema seed（文言文课标 import + AI 自动建议节点 + 人工确认 UI；Phase 1a Sub 1 已落）
- [x] **manual 录入页**（粘贴题面 / 参考答案 / 错答 / 知识点 dropdown；Phase 1a Sub 2 已落）
- [x] AttributionTask 接通（10 类 cause + AI 自动归因；失败兜底为 cause 留空 + log，Phase 1a Sub 3 已落）
- [ ] **Sub 4A** — Mistake FSRS 复习闭环（用 OSS `ts-fsrs`） + `review_event` 行为日志表 + 简陋 `/review` UI（键盘 1/2/3 串行）
- [ ] **Sub 4B** — LearningItem 简化版（仅 pending / in_progress / done 三态走通；6 状态字段保留 schema，状态机本身先简化）+ CompletionEvidence 自我宣告写入路径
- [ ] **Sub 5** — 数据导出（JSON 全量 + 错题 CSV 摘要）

**Sub 4A 关键决策**（详见 `docs/superpowers/specs/2026-05-10-phase1a-sub4a-design.md`）：
- FSRS 只调度 Mistake（错题），不管 LearningItem 是否完成
- rating 三档：incorrect → Again / partial → Hard / correct → Good（不暴露 Easy）
- 不做 cause 差异化复习权重（Phase 2 跑数据再说）
- `review_event` 单独一张表（结构化字段 + before/after fsrs_state JSON），从 day 1 就记录所有复习行为，给未来调度器替换 / BMMS 风格分析留 schema 空间
- 不引入"复习 session / tool_quiz" 仪式感 —— Phase 2 才搞

**最小观测**
- [x] AI 任务层 ToolCallLog + CostLedger 写入（PR 2）
- [x] `/_/inspect` 观测 UI（PR 3）

**项目结构**
- [x] 目录边界：`core/` vs `subjects/wenyan/`（PR 1 已落 wenyan 占位）
- [ ] 数据导出（JSON / Markdown）—— 给未来的自己买保险
- [x] PWA 基础（manifest + standalone + 安装到主屏；PR 2 已落，dev-mode SW 关）

目标：自己能用它备文言文一周，跑出第一批数据。

#### Phase 1b · 补完（1a 跑出第一周数据后做）

**录入扩展**
- [x] **vision_single 录入路径**（已提前到 Phase 1.5 ingestion foundation：图片上传 → vision extract → 审核导入）
- [ ] **手动粘贴录入** UX 优化（如需要）
- [x] Source / Ingestion 字段预留：`source_asset` / `source_document` / `ingestion_session` / `question_block` / `image_refs` / `crop_refs`（已提前到 Phase 1.5 ingestion foundation）

**Quiz 骨架 + StudyLog**
- [ ] tool_quiz embedded check（最小 standalone + inline）
- [ ] Schema: Answer / Judgment / UserAppeal（PR 1 schema 已 ready，本阶段接通流程）
- [ ] QuizGenTask + JudgeRouter（exact / keyword / semantic 三种 judge_kind）
- [ ] JudgeFlexibleTask + UserAppeal 流程（兜底必须 Phase 1 就有）
- [ ] Mistake 创建事件（incorrect/partial → mistake，appeal 翻盘撤销）
- [ ] mastery 反馈喂 base_mastery
- [ ] feedback_md 模板 + partial credit 计算
- [ ] **StudyLog 录入入口**（错题 / 题目 / note 旁批"+ 写学习日志"按钮）

**LearningItem 完整化**
- [ ] LearningItem 6 状态完整（pending / in_progress / done / dismissed / resting / archived）
- [ ] 完成时间戳字段（completed_at / dismissed_at / archived_at + archived_reason）
- [ ] LearningItem 优先级 score 公式（urgency 0.4 / weakness 0.3 / recency 0.3 / pin 顶部）
- [ ] AI 主动提议完成（DreamingProposal.kind=`learning_item_completion`，dismiss 后 7 天冷却）
- [ ] LearningItem 层级化字段（parent_learning_item_id / child_learning_item_ids[]，hub status 自动聚合）
- [ ] 完成判定多路径（自我宣告 + AI propose + quiz_pass，evidence 留痕，软反问 + 强制覆盖）

**Artifact 多态化骨架**
- [ ] Artifact schema 多态化（note_hub / note_atomic / tool_quiz）
- [ ] tool_quiz 可独立存在 + 可嵌入 note section（embedded_check inline 模式）

#### 推到 Phase 1.5+

- vision_paper 卷子拍照（Phase 1.5 MVP 已落；完整跨页/批量优化继续留在后续）
- reverse_mark 反向标记（依赖 Note UI，本来就 Phase 2）
- LearningItem 复学机制 / 变式题双 pass / 错因差异化复习权重（Phase 2，依赖 dreaming）
- 学习时间线视图（Phase 2）

### Phase 1.5 · 批改识别（关键降摩擦特性，MVP 已 ship）

**Why 单独成一个 Phase**：批改识别是错题录入摩擦的关键降低 —— 一张卷子从 N 次单题录入降到 1 次拍照 + 1 次审核。比 Phase 2 其他功能更优先。

- [x] **VisionExtractTask MVP**（支持 1-5 张图片上传；当前按页逐张 vision extract，非真正多图单次 call）
- [x] **批改痕迹识别 MVP**（prompt 识别勾叉 / 扣分 / 批语，schema 不区分痕迹类型）
- [x] **多题切分**（vision 输出 question_blocks[]，审核后导入）
- [x] **IngestionSession 最小状态机**（uploaded → extracted → reviewed → imported / failed）
- [x] **SourceAsset / SourceDocument 最小 schema**（R2 object key / mime / hash / provenance；D1 只存 ref）
- [x] **QuestionBlock + page_spans[] / crop_refs[] schema**（page_spans 已落；真实 crop 生成未做）
- [x] **vision_paper 录入路径 MVP**（`source: vision_paper`，多图审核导入）
- [x] **卷子审核页 MVP**（编辑 / 合并 / 拆分 / 批量导入；“默认仅展开错题”未做）
- [ ] **批量 AttributionTask**（当前是导入后 per-mistake waitUntil；batch API / 夜间跑未做）
- [ ] **保留为模拟卷选项**（勾选后整套 Question 包成 standalone tool_quiz Artifact）
- [ ] 没有批改痕迹时的专门 fallback（用户逐题点对错 / 上传参考答案让 AI 自动判）
- [ ] 真正多图单次 vision call + 跨页大题自动关联
- [ ] 真实 crop_refs 生成与复习时图片回放

### Phase 2 · 进度图谱 + Dreaming + Maintenance + Note Artifact + 高级 Judge + 变式题 + 时间线

**Mastery 与进度**
- [ ] base mastery 公式实现：`max(fsrs_retrievability, quiz_pass_floor=0.7)`
- [ ] Hub mastery 聚合：按 `(错题数 + 学习项数)` 加权平均子节点
- [ ] AI delta mastery + 回滚（单次最大幅度 ±0.15）
- [ ] **复习权重按 cause 类型差异化**（knowledge_gap/concept 高频；carelessness/time_pressure 低频）
- [ ] **mastery 衰减按 cause 类型差异化**（knowledge_gap 影响最大；carelessness 影响小）
- [ ] **学习时间线视图**（整合自动事件 + StudyLog；按时间 / 知识点 / 类型 / 学科过滤）
- [ ] 知识点图谱可视化
- [ ] 学习会话记录 + 热力图

**周复盘 + Dreaming + Maintenance**
- [ ] 周复盘报告（WeeklyReportTask）
- [ ] **周复盘加 cause 维度统计**
- [ ] **周复盘整合 StudyLog**（reflection / question 作为输入）
- [ ] Dreaming lane（每日总结、每日 quiz、题目 / 知识点建议）
- [ ] **Dreaming 推荐按薄弱 cause 类型出针对训练**
- [ ] **Dreaming 读 StudyLog 信号**（未解 question 提示生成 note）
- [ ] Maintenance lane（合并、归档、删错题、状态重置）

**LearningItem 高级路径**
- [ ] **优先级 score 公式实施**（urgency 0.4 / weakness 0.3 / recency 0.3 / pin 顶部）
- [ ] **AI 主动提议完成走 DreamingProposal**（kind=learning_item_completion）
- [ ] **复学机制**（mastery 衰减 <0.5 持续 N 天 → DreamingProposal.kind=learning_item_relearn）
- [ ] **完成判定的 AI 主动提议路径** UX（一键 approve/dismiss + 7 天冷却）

**Note Artifact**
- [ ] **学习意图声明输入 + Note Artifact 生成 pipeline**（同步创建 LearningItem 层级）
- [ ] **Hub + Atomic note 双层结构（基于 TipTap + markdown 存储）**
- [ ] **结构化 section 模板（5 种 kind）**
- [ ] **Hub outline 同步 + atomic batch 异步生成**
- [ ] **Source tier 标记 + 双 pass 生成（NoteVerifyTask）**
- [ ] **Embedded check 与 mistake / mastery 联动**
- [ ] **Note 演进机制（基于错题更新 section）**

**Quiz 高级 judge**
- [ ] **JudgeRubricTask（rubric 评分）+ JudgeStepsTask（步骤验证）**
- [ ] **JudgeMultimodalTask + VisionAnswerExtractTask + visual_complexity 路由**
- [ ] **Standalone tool_quiz Artifact**（每日 quiz / final quiz / 用户存的模拟卷成独立 artifact 行）
- [ ] **Review session tool_quiz**（FSRS 到期错题集合走 tool_quiz）
- [ ] **Review Orchestrator (A)**（读取 FSRS / 错因 / mastery，决定今日复习 session，并解释选题原因）
- [ ] **SourcePack + Exa/Search retrieval**（QuizGenTask 需要新材料时先检索来源包，不直接抓题）
- [ ] **Search-grounded QuizGenTask**（基于 SourcePack 生成原创题，题目带 source_refs）
- [ ] **QuizVerifyTask**（事实、答案、知识点命中、抄题风险校验；通过后 draft → active）
- [ ] **Passage / referenced_span_ids[]**（长阅读材料共享，不把全文复制进每道题）

**变式题深化**
- [ ] **VariantGenTask**（按 mistake.cause 10 类分别出针对性变式）
- [ ] **VariantVerifyTask**（双 pass，不同 model 验证）
- [ ] **variant_depth + root_question_id + parent_variant_id 字段**
- [ ] **variants_max=3 + variants_generated_count 字段**
- [ ] **draft → active 触发**（首次 verdict=correct，含申诉翻盘）
- [ ] **broken_variant 处理**（VerifyTask 失败 / 用户主动标 → status='broken' + failure_reasons）
- [ ] **用户主动触发"再来几道类似的"按钮**（绕过 variants_max）
- [ ] **变式 Mistake 不再生变式**（链终止逻辑）
- [ ] **变式质量监控指标**（接受率 / broken 率 / cause_targeting 分布）

**其他**
- [ ] 视觉模型 eval（CMMMU + MMMU + 自定义 10~20 张样本），定 baseline
- [ ] Skill 抽离（如果 prompt 重复够多）
- [ ] MCP Server expose（safe resources + propose-only tools）
- [ ] 外部 MCP 消费（Calendar 优先）
- [ ] **Learning Intent Orchestrator (B)**（用户声明“我想学 X”→ hub/atomic LearningItem + Note + embedded check + evidence）

### Phase 3 · 加新 tool_kind / Plugin

- [ ] **Global Coach Orchestrator (C)**（每日/每周横跨复习、新学、计划、复盘和维护给出可拒绝安排）
- [ ] 评估加新 `tool_kind`（visualizer / simulator / drill 等），按需求触发
- [ ] 抽出通用 Tool interface（mount / emit / serialize）—— **真有第二种 tool 才做**
- [ ] Plugin loader（如果引入第二学科）
- [ ] 本地教材 / 用户上传材料 RAG（作为 Source Layer 的高可信来源）
- [ ] 授权题库 adapter（如未来需要，不作为 MVP 前提）
- [ ] 论述题深度评分（多 pass + self-consistency）
- [ ] Tauri 桌面端打包

### Phase 4 · 体验打磨

- [ ] 云同步（D1 + R2，基于 Phase 1 留下的 version 字段）
- [ ] 离线优先策略
- [ ] 移动端拍照 vision pipeline 优化
- [ ] 多 provider 接入（按任务路由 / 备选链）
- [ ] Voice input
- [ ] Obsidian plugin（让用户在 Obsidian 里看 backlinks）

---

## 待决策汇总

### 已定（Cluster A/B/C 决议 + 后续 reframe）

- [x] 应试 vs 兴趣两套图谱 → 共享 tag、独立主图
- [x] AI 调用 API 还是本地 → 走 API（Phase 1 单家 Claude，任务层留多 provider 接口）
- [x] 同步策略 → 本地优先 + 自动后台同步（去抖 3~5s），LWW + version 字段
- [x] 完成判定 → 多路径 + Evidence 留痕，不强制 quiz；self_declare 软反问 + 强制覆盖（留痕）
- [x] AI 能动性边界 → 软判断 / 软提议 AI free，硬数据 / 不可逆操作锁死
- [x] **Artifact 定位 → 多态化（note_hub / note_atomic / tool_quiz / tool_<future>）**；Tool 可独立存在或嵌入 Note；不抽通用 Tool interface 直到第二种 tool 出现
- [x] **题目唯一存储 → Question 是统一题库**；Mistake / tool_quiz Artifact / embedded check 都引用 question_id
- [x] **Mistake 与 Question 解耦** → Mistake 只记事件（question_id + wrong_answer + source）+ 复习态（fsrs_state）+ 错因（cause）
- [x] Note 结构 → Hub + Atomic 双层，atomic ↔ 知识点节点
- [x] Tool calling 实现 → 用 OSS 框架（Vercel AI SDK / LangChain），不自建
- [x] Note 框架 → 自建（不嵌 Obsidian），编辑器用 TipTap，存储用 markdown + frontmatter
- [x] 第一个落地的应试场景 → 文言文（高中语文）
- [x] 视觉模型 eval baseline → CMMMU + MMMU + 自定义 10~20 张真实样本
- [x] tool_quiz 的判定方式 → 7 种 judge_kind，由 JudgeRouter 路由
- [x] Vision 输入路径 → pipeline 与 direct multimodal 双路径，按 visual_complexity 路由
- [x] Embedded check 模型 → inline 在 note section（持 question_ids），不独立成 tool_quiz Artifact 行；standalone tool_quiz（每日 / final / 模拟卷 / review session）才是独立 Artifact
- [x] AI 申诉兜底 → JudgeFlexibleTask（Opus + 完整上下文 + CoT），同 Judgment 限申诉 1 次
- [x] base mastery 公式 → `max(fsrs_retrievability, quiz_pass_floor=0.7)`
- [x] Hub mastery 聚合 → 按 `(错题数 + 学习项数)` 加权平均子节点
- [x] AI delta mastery 单次最大幅度 → ±0.15
- [x] LearningItem 优先级 → Hybrid（用户 pin + AI score）
- [x] 跨学科引用 → markdown wiki link 软引用，不做强类型
- [x] 阅读 UX → 移动优先线性流 + 桌面双栏
- [x] 变式题质量保证 → 双 pass + draft 状态（VariantGenTask + VariantVerifyTask）
- [x] 变式题深化 → 按 cause 类型针对性生成；三层防"错题繁殖"
- [x] Search-grounded 搜索源 → Phase 2 初通用 web，后期教材 RAG
- [x] AI 主动提议完成的触发 → mastery>0.8 持续 14 天 ∨ 关联 check 全过 ∨ 7 天错 0
- [x] 复习 = tool_quiz session → FSRS 到期 Mistake 集合 → 临时 standalone tool_quiz（source=review_session）
- [x] 录入学科判断 → AI 自主判断（vision pipeline + AttributionTask），不让用户预选
- [x] 批改识别提前到 Phase 1.5 → 多张图一次 vision call；批改痕迹靠 prompt 不靠 schema 分类
- [x] 录入流程必审字段 → 题面 / 参考答案 / 关联知识点；其他自动
- [x] AI 失败不阻塞录入 → Mistake 总能创建，AttributionTask 失败后台重试
- [x] 错因分类 10 类 → concept / knowledge_gap / calculation / reading / memory / expression / method / carelessness / time_pressure / other
- [x] secondary_categories[] 多重原因支持
- [x] cause confidence + user_edited 字段
- [x] 复习权重 / mastery 衰减按 cause 差异化（Phase 2 实施）
- [x] 周复盘加 cause 维度统计 / dreaming 推薄弱 cause 类型针对训练
- [x] **LearningItem 层级化（v0.11）** → 学习意图触发 1 hub + N atomic 自动拆分；其他来源默认 1 atomic
- [x] **LearningItem 状态扩展到 6**（pending / in_progress / done / dismissed / resting / archived）
- [x] **hub status 自动聚合 children**
- [x] **"复学"机制** → mastery 衰减 <0.5 持续 N 天 dreaming propose `learning_item_relearn`
- [x] **优先级 score 4 维加权公式**（urgency 0.4 / weakness 0.3 / recency 0.3 / pin 顶部）
- [x] **AI 主动提议完成走 DreamingProposal**（kind=`learning_item_completion`，dismiss 后 7 天冷却）
- [x] **dismissed ≠ archived ≠ done**：语义清晰区分
- [x] **引入 StudyLog 对象**（5 种 kind：highlight / insight / question / reflection / observation）
- [x] **StudyLog 多对一关联**（knowledge / question / mistake / artifact / learning_item 任一/多）
- [x] **学习时间线视图**（Phase 2 整合自动事件 + StudyLog）
- [x] **DreamingProposal.kind 扩展** → 加 learning_item_completion / learning_item_relearn
- [x] **Learning Orchestrator 长期形态** → ABC 都要实现，按 A 错题复习 → B 新知识学习 → C 全局教练交付
- [x] **题库来源策略** → 个人真实题优先 + AI 变式双 pass + Search-grounded 原创题 + 开放/授权来源
- [x] **Quiz agent 接 Source Layer** → 通过 SourcePack/Exa/search grounding，不直接抓第三方题库原题
- [x] **复杂录入策略** → IngestionSession + SourceAsset/SourceDocument + QuestionBlock + crop_refs + Passage

### 阈值类默认（runtime 调）

- [x] 归档触发的久未触达阈值 → 90 天
- [x] dreaming 接受率阈值 → 滚动 30 天 <30% 触发砍信号
- [x] soft delete retention → 30 天
- [x] 成本天花板 → $5/day, $30/week（兜底）
- [x] borderline 阈值 → 0.4 ≤ score ≤ 0.7（统一，可 runtime 调）
- [x] partial credit verdict 阈值 → score≥0.85=correct, 0.4<score<0.85=partial, ≤0.4=incorrect
- [x] partial 错题复习 → 进 FSRS 但 lapses+0.5 半计
- [x] 变式接受率阈值 → 应 >70%；broken 率 <15%（低于阈值触发调 prompt）
- [x] 错因 confidence 阈值 → <0.6 走 'other'
- [x] **复学触发 mastery 阈值 → < 0.5 持续 N 天**（runtime 调）
- [x] **AI 主动提议完成被 dismiss 后冷却 → 7 天**（默认）

### 仍未定（runtime 数据后再决）

- [ ] Phase 1 启动后第一周跑出的具体数据，校准 base mastery 公式权重
- [ ] LearningItem priority score 的权重 (urgency / weakness / recency / pin)
- [ ] Rubric 多次评分的一致性检测策略（Phase 3+）
- [ ] 何时引入第二种 tool_kind（drill / visualizer / simulator）
- [ ] cause 类型差异化的复习权重 / mastery 衰减具体数值（Phase 2 跑数据）
- [ ] StudyLog 喂 dreaming 信号的具体方式（Phase 2+）
- [ ] Exa/Search provider 的域名白名单 / 黑名单策略
- [ ] Source license 不明确时允许生成的题型边界
- [ ] 长阅读 passage 的默认切分粒度（段落 / 句群 / 题目引用 span）

### 模块特定未定

各模块的 open questions 见各自文档底部。错题模块剩"搜索 UX 细节"。

---

## 未来可能性（不在当前路线图）

- 番茄计时和复习日程同步到日历
- 多人模式（学习小组、错题互通）
- 与已有 osu / 编程项目的数据打通（学习时长聚合）
- 语音问答（路上回顾错题）
- 知识图谱跨用户合并（应试图谱社区共享）
