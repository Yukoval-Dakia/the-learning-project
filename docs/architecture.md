# 架构基础

跨模块共享的概念、AI 任务层、技术栈、数据模型。具体模块行为见 [`modules/`](modules/) 各文件。

---

## 一、知识点图谱（Knowledge Graph）

底层数据结构。每个知识点是一个节点，节点之间有「前置 / 关联 / 同属」三种边。

每个知识点至少包含：
- id / 名称 / 所属领域（应试科目 or 兴趣主题）
- 当前掌握度（0~1，分两层：base + AI delta，详见 [`modules/progress.md`](modules/progress.md)）
- 最近一次活跃时间
- 关联资源（错题列表、artifact 列表、外部链接）

应试和兴趣两套图谱并存但相互引用，不硬合并；通过共享 tag 系统打通。**跨学科引用走软引用**（markdown wiki link `[[物理:能量守恒]]`），不做强类型 cross-domain ref。

---

## 二、AI 角色与能动性边界

### 2.1 AI 角色

不是聊天助手，是「数据加工 + 内容生产 + 主动判断」的中间层。它负责：
1. 归因 / 归类（错题 → 知识点、错因分析）
2. 生产（变式题、卡片、artifact、dreaming 推荐）
3. 复盘（周报、薄弱点诊断、下阶段建议）
4. 维护（提议删错题 / 合并节点 / 归档冷数据）
5. 判定（quiz answer 判分、申诉重判）

AI 是裁判而不是打分器：所有判断必须 evidence-based，留下推理痕迹。

### 2.2 AI 能动性边界

支持 AI 主观判断，但分对象：

| 对象 | AI 能动性 |
| --- | --- |
| 软判断（完成判定、推荐、排序、人话总结、quiz 评分） | ✅ AI 自由发挥 |
| 软提议（删错题、合并节点、归档、状态重置） | ✅ AI 提议 + 用户确认 + 可回滚 |
| 硬数据（错题正确率、复习记录、行为日志、Judgment 历史） | ❌ 事实层，不可改 |
| 不可逆消费（跨预算调用 LLM） | ❌ 硬约束 |

**自用工具最大的失败模式不是死板，是数据失信**。所有 AI 的判断和提议必须留痕，三个月后能回放为什么。**Judgment 不可变**：申诉重判 = 新建 Judgment，不修改旧的。

---

## 三、Artifact 多态化（核心抽象）

Artifact 是 AI 产出物的统一抽象，分两大族：

```
Artifact (AI 产出物)
├── Note  (阅读型，被读)
│   ├── note_hub      (大纲 + 子 atomic 列表)
│   └── note_atomic   (5-section 结构化笔记，含 check section)
└── Tool  (互动型，被用)
    ├── tool_quiz         ← 当前唯一实例
    ├── tool_visualizer   (Phase 3 候选)
    ├── tool_simulator    (Phase 3 候选)
    └── tool_drill        (Phase 3 候选)
```

**两个关键性质**：

1. **Tool 可独立存在**：每日 quiz / final quiz / 用户存的模拟卷 / 复习 session 都是独立的 `tool_quiz` Artifact，不需要嵌在 Note 里。
2. **Tool 也可以嵌入 Note**：note 的 `check` section 是 **inline embedded** 的迷你 quiz——直接在 section 里持 `question_ids[]`，不另建独立 `tool_quiz` Artifact 行（避免数据膨胀，因为 embedded check 跟 section 1:1 强耦合）。

**不抽通用 Tool interface**：Phase 1 只有 quiz 一种 tool kind，搞 generic Tool base 是 YAGNI。等 Phase 3 真出现第二种 tool（visualizer 等）时再抽两者共有的 `mount() / emit() / serialize()`。

---

## 四、统一题库（Question 单一来源）

`Question` 是题面、参考答案、评分标准的**唯一存储**。所有题相关的对象都引用 Question.id：

```
Question (统一题库，single source of truth)
  ↑ 被引用
  ├── tool_quiz Artifact.tool_state.question_ids[]   (standalone quiz)
  ├── note_atomic.sections[check].embedded_check.question_ids[]   (embedded check)
  ├── Mistake.question_id                            (做错事件)
  └── Mistake.variants[].question_id                 (变式题，本身也是 Question)
```

**变式系列是 Question 的链式扩展**：每条变式是新 Question 实例，通过 `variant_depth` / `root_question_id` / `parent_variant_id` 跟原题关联。`variant_depth ≤ 2`（防"错题繁殖"，详见 [`modules/mistakes.md`](modules/mistakes.md) § 3.4）。

**好处**：
- 题面去重（同题不同来源不重复存）
- 变式题自然成为题库一员（不是 Mistake 私有数据）
- 复习 / 每日 quiz / 模拟卷的题都从 Question 抽
- 错题录入与 quiz 答错的路径一致：先建 Question 再建 Mistake

详见 [`modules/quiz.md`](modules/quiz.md) §  Question 部分 与 [`modules/mistakes.md`](modules/mistakes.md) § 1。

---

## 五、AI 任务层（LLM Task Layer）

独立模块。所有 AI 调用按「任务」抽象，**不**按 `chat()` 抽象——避免丢掉 provider 特色能力（prompt caching / batch API / structured output / multimodal）。

### 5.1 Task 注册

| 任务 | Provider/Model 选择 | 触发 | tool call | 多模态 | 产出 |
| --- | --- | --- | --- | --- | --- |
| `VisionExtractTask` | 低成本视觉（CMMMU 选型） | 录入错题图片 → 题面 / LaTeX / 选项 | 否 | 输入 | 题面文本（建 Question） |
| `VisionAnswerExtractTask` | 同上 | 答案图片 → 文字（pipeline 路径） | 否 | 输入 | 文字 |
| `AttributionTask` | Sonnet → Haiku 备选 | Mistake 创建时归因 + 挂载知识点 | 是 | — | Mistake.cause + knowledge_ids |
| `VariantGenTask` | Sonnet + batch | 变式题生成（按 mistake.cause 针对性出题） | 否 | — | 新 Question 实例（source=mistake_variant，draft_status=draft） |
| `VariantVerifyTask` | 不同 model（如 Opus） + batch | 变式题双 pass 验证 | 否 | — | `{is_valid, failure_reasons[], cause_targeting}` |
| `QuizGenTask` | Sonnet (+ batch 可选) | embedded check / daily / final / 用户主动 | 否 | — | `Question[]` |
| `JudgeRouter` | n/a | 答案提交后路由 | 否 | — | judge_kind |
| `JudgeExactTask` | n/a | exact judge | 否 | — | Judgment |
| `JudgeKeywordTask` | n/a | keyword judge | 否 | — | Judgment |
| `JudgeSemanticTask` | Sonnet / Haiku | semantic judge | 否 | — | Judgment |
| `JudgeRubricTask` | Opus / Sonnet | rubric judge | 否 | — | Judgment + criteria |
| `JudgeStepsTask` | Sonnet | computation 步骤验证 | 否 | — | Judgment + steps |
| `JudgeMultimodalTask` | Opus / GPT-5.x (multimodal) | image 答案 + 高 visual_complexity | 否 | 直接 | Judgment |
| `JudgeFlexibleTask` | Opus / 顶级 reasoning | ai_flexible 兜底 | 否 | 视情况 | Judgment + 详细 CoT |
| `WeeklyReportTask` | Opus + prompt cache | 周复盘 | 是 | — | WeeklyReview |
| `DreamingTask` | Opus + batch + prompt cache | 夜间生产 lane | 是 | — | DreamingProposal |
| `MaintenanceProposeTask` | Sonnet + batch | 维护 lane 提议 | 是 | — | MaintenanceSuggestion |
| `NoteGenerateTask` | Sonnet + batch (atomic) | 学习意图触发 | hub 是 | — | note_hub / note_atomic Artifact |
| `NoteVerifyTask` | 不同 model + batch | Note 双 pass 反幻觉 | 否 | — | section.source_tier 标记 |
| `NoteSectionUpdateTask` | Sonnet | Living note 更新某 section | 否 | — | section diff |

**命名约定**：`Note*Task` 产出 note_* 类型 Artifact；`Quiz*Task` 与 `Judge*Task` 服务 tool_quiz 子系统；`Variant*Task` 产出新 Question 挂在 Mistake.variants 上。Tool 之间不共享通用 task，每种 tool_kind 自己长自己的。

### 5.2 运行时 Tool Calling

需要"边看数据边决策"的 Task 走 multi-turn tool call；输入已固定的 Task 走单轮 structured output。

**Tool 分组（按权限）**

```
Read（任何 Task 可用）：
  search_knowledge_by_concept / get_knowledge_node / get_node_neighbors
  find_similar_mistakes / get_recent_mistakes / get_weak_points
  get_review_due / get_learning_history / get_artifact / get_question

Write（Task 白名单）：
  create_knowledge_node           # AttributionTask, NoteGenerateTask (atomic 级)
  link_mistake_to_node            # AttributionTask
  create_question                 # 录入 / VariantGenTask
  update_ai_delta_mastery         # 限定 Task，可回滚

Propose-only（产生待审核记录，不立即执行）：
  propose_completion / propose_merge / propose_archive
  propose_delete_mistake / propose_new_knowledge_node (hub 级)
```

破坏性操作（删错题、合并节点）**没有直接 tool**——AI 只能 propose，走 MaintenanceSuggestion 流程。

**循环控制**

每个 Task 三层 budget：

```
TaskBudget {
  maxIterations    // 最多几轮 tool call
  maxCost          // 单次任务总成本上限
  timeout          // 总超时
}
```

超 budget → 1 轮 nudge（"必须给出最终答案"）→ 仍不收敛则 fallback 到确定性逻辑，记录 `degraded` 标记。

**实现**：tool-calling 循环、provider 兼容、流式都是成熟问题，**直接用开源方案**（Vercel AI SDK / LangChain / 自选），不自建。重点是把这四件做对：
- Tool 注册（含权限）
- Task → 允许 tool 白名单
- Budget 与降级
- ToolCallLog（必须）

### 5.3 成本控制

- 同步任务（用户操作时跑）：归因 + 挂载 + 视觉录入 + 答案判定（除 ai_flexible）
- 异步 batch（夜间跑，50% 折扣）：变式生成、变式验证、dreaming、maintenance、周报、atomic note 生成、Note Verify
- prompt caching：知识图谱 / 错题历史 / rubric 标准 / system prompt 作稳定 prefix
- 模型分级：简单任务用便宜模型
- 结果缓存：同 prompt 命中直接返回
- **预算天花板**：日 $5 / 周 $30（自用规模兜底，跑数据后调）；超了自动降级（顶级 → 中级 → 暂停 dreaming）
- 每次调用记录 `CostLedger`，按 `(task, provider, model)` 聚合可见

### 5.4 Skill / MCP Server / Plugin（推后）

这三块概念保留但不在 Phase 1 实现：

- **Skill**（提示词包，markdown + frontmatter）：Phase 2 在 prompt 重复多了之后再抽
- **MCP Server**（对外暴露 resources + tools）：Phase 2 等核心闭环稳了再 expose；Phase 1 在代码层面分好"以后能 expose"和"内部"目录
- **Plugin**（学科 bundle）：Phase 3 真有第二学科再做；Phase 1 划好 `core/` vs `subjects/wenyan/` 的目录边界
- **外部 MCP 消费**（Calendar / Search / FS）：Phase 2 按需接

---

## 六、技术栈

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 前端 | React / Svelte + Tailwind | 个人手感，两者都能 PWA |
| 桌面壳 | **Tauri** | 比 Electron 轻一个数量级，自用够了 |
| 移动 | PWA（先）→ 必要时 Capacitor 包装 | 不要一上来就 RN |
| 本地存储 | SQLite（Tauri 原生集成） | 错题/进度天然适合关系型 |
| 云同步 | Cloudflare D1 + R2 | 已有账号 |
| AI 调用 | 见上节任务层 | |
| Tool calling 循环 | OSS 框架（Vercel AI SDK / LangChain） | 不自建 |
| Note 编辑器 | TipTap / Milkdown / Lexical（基于 ProseMirror） | 详见 [`modules/notes.md`](modules/notes.md) |
| Note 渲染 | react-markdown / markdown-it | |
| 数学公式 | KaTeX | |
| 图表 | Mermaid | |
| 视觉录入 | vision LLM（CMMMU + 自定义样本选型） | 跳过 OCR 中间层 |

**反模式**：

- 不要一开始就上多端原生（RN / Flutter）
- 不要自建账号系统（自用没必要，需要时用 Cloudflare Access）
- 不要把 AI 调用做成「聊天框」，做成后台管线
- LLM 抽象层不要按 `chat()` 抽象，按任务抽象
- 不自建 tool-calling 循环，用 OSS
- 不嵌 Obsidian 当 note 框架（详见 [`modules/notes.md`](modules/notes.md)）
- 不抽通用 Tool interface（YAGNI，等第二种 tool kind 出现再抽）
- 不在 Mistake 表里复制题面（题面只在 Question 表）
- 不在 schema 或 pipeline 里做不必要的分类细化（如批改痕迹类型、跨页 passage 关系等）—— 交给 prompt engineering
- schema 第一天就加 `updated_at` / `version` 字段，给同步留位

---

## 七、数据模型骨架

```
Knowledge
  id, name, domain, parent_id, last_active_at
  base_mastery, ai_delta_mastery
  merged_from[]                   // 合并历史，可拆回
  archived_at?
  proposed_by_ai: bool            // AI 创建的，未经审核
  approval_status: pending | approved | rejected
  updated_at, version

// 统一题库
Question
  id
  kind: choice | true_false | fill_blank | short_answer | essay
        | computation | reading | translation
  prompt_md
  reference_md
  rubric_json?                    // {criteria: [{name, weight, descriptor}]}
  judge_kind_override?
  visual_complexity?: low | medium | high
  → knowledge_ids[]
  difficulty: 1~5
  source: embedded | daily | final | dreaming | manual
        | vision_single | vision_paper | reverse_mark | mistake_variant
  source_ref?                     // mistake_id (variant) / artifact_id (reverse_mark) / null
  draft_status?: draft | active   // 仅 mistake_variant 等需要双 pass 的题
  // 变式系列字段
  variant_depth: int              // 默认 0；0=原题，1=一代变式，最大 2
  root_question_id?: string       // 指向 root question (variant_depth=0 时可省略)
  parent_variant_id?: string      // 直接上一代
  created_by: {task, version}
  metadata?: { force_flexible?, expected_input_kind?, ... }
  created_at, updated_at, version

// 做错事件 + 复习态（题面在 Question 那边）
Mistake
  id
  question_id                     // ★ 必须，题面在 Question
  wrong_answer_md?                // 用户当时的错答（可省略）
  wrong_answer_image_refs[]?
  source: quiz_answer | manual | vision_single | vision_paper | reverse_mark
  source_ref?                     // judgment_id (quiz_answer) / artifact_id (reverse_mark)
                                  //   / paper_session_id (vision_paper)
  → knowledge_ids[]                // 错过反映的具体盲点（可与 Question.knowledge_ids[] 不同）
  cause: {
    primary_category               // concept | calculation | reading | knowledge_gap | ...
    secondary_categories[]?
    ai_analysis_md
    user_notes?
    partial?: bool
  }
  fsrs_state {due_at, interval, ease, repeat, lapses, retrievability_at}
  variants[]: [{
    question_id,
    status: draft | active | broken | dismissed,
    failure_reasons?: string[]    // status=broken 时记录 VerifyTask 输出
  }]
  variants_generated_count: int   // 默认 0
  variants_max: int                // 默认 3
  status: draft | active | resting | archived
  archived_reason?: mastered | obsolete | user
  archived_at?
  deleted_at?
  delete_reason?: user | merge | duplicate | misjudged
  created_at, updated_at, version

LearningItem                      // 待学习列表
  id
  source: mistake | manual | learning_intent | ai_dream
  source_ref                      // mistake_id / dream_id / null
  title, content
  → knowledge_ids[]
  primary_artifact_id?            // 主消费物（note_hub 或 standalone tool_quiz）
  status: pending | in_progress | done | dismissed
  user_pinned: bool
  ai_score?: float                // weighted (urgency, weakness, recency)
  created_at, due_at?
  reviewed_at?
  updated_at, version

CompletionEvidence
  id, learning_item_id
  path: self_declare | ai_propose | quiz_pass
  evidence_json                   // AI 看到的信号快照
  user_overrode_low_evidence?: bool
  decided_at

DreamingProposal
  id, kind: problem | knowledge | quiz | summary | note_section_update
  payload, reasoning
  status: pending | accepted | dismissed
  proposed_at, decided_at

MaintenanceSuggestion
  id, kind                        // delete_mistake | merge_knowledge | archive | reset_fsrs | reset_mastery
  target_ref
  reasoning
  status: pending | accepted | dismissed | rolled_back
  snapshot_json
  proposed_at, decided_at, rollback_until

Artifact                          // AI 产出物的统一抽象（Note + Tool）
  id
  type: note_hub | note_atomic | tool_quiz | tool_<future>
  title

  knowledge_id?                   // note_atomic 必填；note_hub 可选；tool_* 视情况

  parent_artifact_id?             // note_atomic→note_hub
  child_artifact_ids[]            // note_hub 持有 atomic 列表

  intent_source: declared | from_mistake | from_dream
  source                          // 具体语义按 type:
                                  //   note: 同 intent_source
                                  //   tool_quiz: embedded | daily | final | dreaming | manual | mistake_variant | review_session
  source_ref?

  // Note 字段（type=note_*）
  outline_json?                   // note_hub
  sections?                       // note_atomic
    [{
      id, kind: definition | mechanism | example | pitfall | check
      body_md
      source_tier: llm_only | search_grounded | textbook | user_verified
      user_verified: bool
      embedded_check?: { question_ids: [string] }   // inline，引用 Question 表
      version
    }]

  // Tool 字段（type=tool_*）
  tool_kind?                      // quiz | visualizer | simulator | drill | ...
  tool_state?                     // tool_quiz: { question_ids[], session_meta? }

  generation_status: pending | partial | complete
  generated_by: {task, provider, model, prompt_version}
  history[]
  archived_at?
  updated_at, version

// Quiz 子系统的事件 schema
Answer
  id, question_id, learning_item_id?
  input_kind: text | option | image | voice
  content_md
  image_refs[]
  vision_extracted?
  tags?: [string]
  submitted_at

Judgment                          // 不可变；同 answer_id 可有多条
  id, answer_id
  judge_kind: exact | keyword | semantic | rubric | steps | multimodal_direct | ai_flexible
  verdict: correct | partial | incorrect
  score: 0~1
  feedback_md
  evidence_json
  is_flexible_fallback: bool
  triggered_by?: initial | borderline | appeal | force
  prior_judgment_id?
  judged_by: {task, provider, model, version}
  judged_at
  is_effective: bool

UserAppeal
  id, judgment_id
  reason: text?
  appealed_at
  resolved_judgment_id?

Session
  id, started_at, ended_at, type
  → knowledge_ids[]
  → mistake_ids[]

WeeklyReview
  id, week_start, summary_md
  → weak_points: knowledge_ids[]
  → recurring_mistakes: mistake_ids[]

ToolCallLog                       // 运行时 LLM tool 调用观测（注意：跟 tool_* artifact 不同概念）
  id, task_run_id, task_kind
  tool_name, input_json, output_json
  iteration, latency_ms, cost
  occurred_at

CostLedger
  id, task_kind, provider, model
  cost, tokens_in, tokens_out
  occurred_at
```

In-code registries (not DB)：

```
Tool {                            // LLM 调用的函数原语，跟 tool_* artifact 是不同概念
  name, description, input/output_schema, handler
  permission: read | write | propose
  cost_estimate
}

Task {
  kind, allowed_tools[], budget, system_prompt
  default_provider, fallback_chain
  needs_tool_call: bool
  is_multimodal: bool
}

JudgeTask extends Task {
  judge_kind: JudgeKind
  needs_llm: bool
  // Common interface: run(question, answer) -> Judgment
}
```

**命名澄清**：`Tool` (LLM 函数原语) ≠ `tool_*` Artifact (互动型产出物)。前者是 AI 任务层的实现细节，后者是用户消费的内容对象。两个层级不冲突但同名易混。
