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

应试和兴趣两套图谱并存但相互引用，不硬合并；通过共享 tag 系统打通。

---

## 二、AI 角色与能动性边界

### 2.1 AI 角色

不是聊天助手，是「数据加工 + 内容生产 + 主动判断」的中间层。它负责：
1. 归因 / 归类（错题 → 知识点、错因分析）
2. 生产（变式题、卡片、artifact、dreaming 推荐）
3. 复盘（周报、薄弱点诊断、下阶段建议）
4. 维护（提议删错题 / 合并节点 / 归档冷数据）

AI 是裁判而不是打分器：所有判断必须 evidence-based，留下推理痕迹。

### 2.2 AI 能动性边界

支持 AI 主观判断，但分对象：

| 对象 | AI 能动性 |
| --- | --- |
| 软判断（完成判定、推荐、排序、人话总结） | ✅ AI 自由发挥 |
| 软提议（删错题、合并节点、归档、状态重置） | ✅ AI 提议 + 用户确认 + 可回滚 |
| 硬数据（错题正确率、复习记录、行为日志） | ❌ 事实层，不可改 |
| 不可逆消费（跨预算调用 LLM） | ❌ 硬约束 |

**自用工具最大的失败模式不是死板，是数据失信**。所有 AI 的判断和提议必须留痕，三个月后能回放为什么。

---

## 三、AI 任务层（LLM Task Layer）

独立模块。所有 AI 调用按「任务」抽象，**不**按 `chat()` 抽象——避免丢掉 provider 特色能力（prompt caching / batch API / structured output）。

### 3.1 Task 注册

```
任务                       →  Provider/Model 选择            tool call
────────────────────────    ──────────────────────────       ─────────
VisionExtractTask          →  低成本视觉 → Haiku vision      否
AttributionTask            →  Sonnet → Haiku 备选            是
VariantGenTask             →  Sonnet + batch                 否
QuizGenTask                →  Sonnet                          否
WeeklyReportTask           →  Opus + prompt cache             是
DreamingTask               →  Opus + batch + prompt cache    是
MaintenanceProposeTask     →  Sonnet + batch                 是
NoteGenerateTask           →  Sonnet + batch (atomic)         hub 是
NoteVerifyTask             →  不同 model + batch              否
NoteSectionUpdateTask      →  Sonnet                          否
```

每个任务独立选 provider，自由用 provider 特色（prompt caching / batch API / structured output），上层只关心业务语义。

### 3.2 运行时 Tool Calling

需要"边看数据边决策"的 Task 走 multi-turn tool call；输入已固定的 Task 走单轮 structured output。

**Tool 分组（按权限）**

```
Read（任何 Task 可用）：
  search_knowledge_by_concept / get_knowledge_node / get_node_neighbors
  find_similar_mistakes / get_recent_mistakes / get_weak_points
  get_review_due / get_learning_history / get_artifact

Write（Task 白名单）：
  create_knowledge_node           # AttributionTask, NoteGenerateTask
  link_mistake_to_node            # AttributionTask
  update_ai_delta_mastery         # 限定 Task，可回滚

Propose-only（产生待审核记录，不立即执行）：
  propose_completion / propose_merge / propose_archive / propose_delete_mistake
  propose_new_knowledge_node      # 用于 hub 大纲变化
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

### 3.3 成本控制

- 同步任务（用户操作时跑）：归因 + 挂载 + 视觉录入
- 异步 batch（夜间跑，50% 折扣）：变式生成、dreaming、maintenance、周报、atomic note 生成
- prompt caching：知识图谱 / 错题历史作为稳定 prefix
- 模型分级：简单任务用便宜模型
- 结果缓存：同 prompt 命中直接返回
- **预算天花板**：日 / 周 cost 上限，超了自动降级（顶级 → 中级 → 暂停 dreaming）
- 每次调用记录 `CostLedger`，按 `(task, provider, model)` 聚合可见

### 3.4 Skill / MCP Server / Plugin（推后）

这三块概念保留但不在 Phase 1 实现：

- **Skill**（提示词包，markdown + frontmatter）：Phase 2 在 prompt 重复多了之后再抽
- **MCP Server**（对外暴露 resources + tools）：Phase 2 等核心闭环稳了再 expose；Phase 1 在代码层面分好"以后能 expose"和"内部"目录
- **Plugin**（学科 bundle）：Phase 3 真有第二学科再做；Phase 1 划好 `core/` vs `subjects/math/` 的目录边界
- **外部 MCP 消费**（Calendar / Search / FS）：Phase 2 按需接

---

## 四、技术栈

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
| 视觉 | vision LLM 直接处理（跳过 OCR） | 移动端拍照场景 |

**反模式**：

- 不要一开始就上多端原生（RN / Flutter）
- 不要自建账号系统（自用没必要，需要时用 Cloudflare Access）
- 不要把 AI 调用做成「聊天框」，做成后台管线
- LLM 抽象层不要按 `chat()` 抽象，按任务抽象
- 不自建 tool-calling 循环，用 OSS
- 不嵌 Obsidian 当 note 框架（详见 [`modules/notes.md`](modules/notes.md)）
- schema 第一天就加 `updated_at` / `version` 字段，给同步留位

---

## 五、数据模型骨架

```
Knowledge
  id, name, domain, parent_id, last_active_at
  base_mastery, ai_delta_mastery
  merged_from[]                   // 合并历史，可拆回
  archived_at?
  proposed_by_ai: bool            // AI 创建的，未经审核
  approval_status: pending | approved | rejected
  updated_at, version

Mistake
  id, content, source, created_at
  → knowledge_ids[]
  → cause: {category, ai_analysis}
  → variants[]                    // 含 status: draft | active
  → fsrs_state {due_at, interval, ease, repeat, lapses}
  deleted_at?                     // soft delete (30 天后真删)
  updated_at, version

LearningItem                      // 待学习列表
  id
  source: mistake | manual | learning_intent | ai_dream
  source_ref                      // mistake_id / dream_id / null
  title, content
  → knowledge_ids[]
  primary_artifact_id?            // 主消费物（note hub）
  status: pending | in_progress | done | dismissed
  priority
  created_at, due_at?
  reviewed_at?
  updated_at, version

CompletionEvidence
  id, learning_item_id
  path: self_declare | ai_propose | quiz_pass
  evidence_json                   // AI 看到的信号快照
  decided_at

DreamingProposal
  id, kind: problem | knowledge | quiz | summary
  payload, reasoning
  status: pending | accepted | dismissed
  proposed_at, decided_at

MaintenanceSuggestion
  id, kind                        // delete_mistake | merge_knowledge | archive | reset_fsrs | reset_mastery
  target_ref
  reasoning
  status: pending | accepted | dismissed | rolled_back
  snapshot_json                   // 操作前快照，回滚用
  proposed_at, decided_at, rollback_until

Artifact                          // Note 优先；Tool 型 Phase 3 评估
  id
  type: hub | atomic              // Phase 1/2 只做 note
  title
  knowledge_id                    // atomic 必填，hub 可选
  parent_artifact_id?             // atomic 指向 hub
  child_artifact_ids[]            // hub 持有
  intent_source: declared | from_mistake | from_dream
  source_ref                      // 触发它的 LearningItem / Mistake / Proposal
  outline_json                    // hub: [{section_id, atomic_id, status}]
  sections: [{                    // atomic
    id, kind: definition | mechanism | example | pitfall | check
    body_md
    source_tier: llm_only | search_grounded | textbook | user_verified
    user_verified: bool
    embedded_check?: {questions[], last_result}
    version
  }]
  generation_status: pending | partial | complete
  generated_by: {task, provider, model, prompt_version}
  history[]                       // 章节级 diff，可回放
  archived_at?
  updated_at, version

Session
  id, started_at, ended_at, type
  → knowledge_ids[]
  → mistake_ids[]

WeeklyReview
  id, week_start, summary_md
  → weak_points: knowledge_ids[]
  → recurring_mistakes: mistake_ids[]

ToolCallLog                       // 运行时 tool 调用观测
  id, task_run_id, task_kind
  tool_name, input_json, output_json
  iteration, latency_ms, cost
  occurred_at

CostLedger
  id, task_kind, provider, model
  cost, tokens_in, tokens_out
  occurred_at

// In-code registries (not DB)
Tool { name, description, input/output_schema, handler, permission, cost_estimate }
Task { kind, allowed_tools[], budget, system_prompt, default_provider, fallback_chain, needs_tool_call }
```
