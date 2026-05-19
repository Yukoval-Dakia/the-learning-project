# 架构基础

跨模块共享的概念、AI 任务层、技术栈、数据模型。具体模块行为见 [`modules/`](modules/) 各文件。

---

## 一、知识点图谱（Knowledge Graph）

底层数据结构。每个知识点是一个节点（`knowledge` 表 + `parent_id` 树骨架），节点之间用 `knowledge_edge` 表承载五种类型化横向边（per ADR-0010）：`prerequisite` / `related_to` / `contrasts_with` / `applied_in` / `derived_from`，外加 `experimental:*` 命名空间用于新关系探索。

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

> **Canonical source**: `src/ai/registry.ts` + `docs/adr/0004-pattern-c-two-type-agent-architecture.md` §"Task 现状"。本节为同步快照（2026-05-17）。

**当前 registry**（runner + registry 都通；实际触发看 route / pg-boss handler）：

| Task | 模型 | 触发 | tool call | 多模态 | 产出 |
| --- | --- | --- | --- | --- | --- |
| `AttributionTask` | mimo-v2.5-pro | user action / pg-boss | 否 | — | 错题归因（10 类 cause）+ analysis |
| `KnowledgeProposeTask` | mimo-v2.5-pro | user action / pg-boss | 否 | — | 0-3 条 `propose_new` 知识点 |
| `KnowledgeEdgeProposeTask` | mimo-v2.5-pro | maintenance / nightly | 否 | — | 0-5 条 knowledge_edge proposal |
| `SessionSummaryTask` | mimo-v2.5-pro | review session end | 否 | — | ≤120 字 session summary |
| `LearningIntentOutlineTask` | mimo-v2.5-pro | `/api/learning-intents` | 否 | — | 1 hub + N atomic outline |
| `NoteGenerateTask` | mimo-v2.5-pro | pg-boss `note_generate` | 否 | — | atomic artifact sections |
| `VariantGenTask` | mimo-v2.5-pro | pg-boss `variant_gen` | 否 | — | draft `question(source='mistake_variant')` |
| `TeachingTurnTask` | mimo-v2.5-pro | `/api/teaching-sessions/*` | 否 | — | Active Teaching turn |
| `ReviewIntentTask` | mimo-v2.5-pro | Review Orchestrator | 否 | — | 一句话 session intent |
| `KnowledgeReviewTask` | mimo-v2.5-pro | maintenance | 是 | — | tree / mesh mutation proposal |
| `VisionExtractTask` | mimo-v2.5 | `POST /api/ingestion/[id]/rescue` | 否 | 输入 | bbox blocks |
| `VisionExtractTaskHeavy` | mimo-v2.5 | 同上（heavy manual rescue） | 否 | 输入 | bbox blocks |

**与旧 ADR 版本差异**：原计划的 `EnrichMistakeTask` 已拆分为 `AttributionTask`（归因）+ `KnowledgeProposeTask`（知识点提议）。VisionExtract* 在 ADR-0002 修订（2026-05-11）中改为 manual rescue tool，不参与自动 cascade。`DreamingTask` / `MaintenanceProposeTask` / `BlockAssemblyTask` 作为 lane 级编排概念保留，但当前 registry 以更具体的 task 和 pg-boss handler 承载。

**命名约定**：Task 一律 `PascalCase + 'Task'` 后缀；破坏性操作（删题、合并节点）走 Proposal/Suggestion 流程而非直接 tool（per ADR-0004）。

### 5.2 运行时 Tool Calling

需要"边看数据边决策"的 Task 走 multi-turn tool call；输入已固定的 Task 走单轮 structured output。

> **2026-05-19 alignment**: 现行 runner 在 `src/server/ai/runner.ts`，所有 LLM task 都走 `@anthropic-ai/claude-agent-sdk`。Tool transport 使用 Claude Agent SDK 的 `mcpServers + allowedTools + maxTurns`。统一 Domain Tool Registry 仍是计划中设计；当前只有 `KnowledgeReviewTask` 在 `src/server/knowledge/review.ts` 内部创建本地 in-process MCP tool。

**当前规则**：

- `needsToolCall: false` 的 task 可走 generic `app/api/ai/[task]`，由 `runTask()` 返回 JSON。
- `needsToolCall: true` 的 task **不能**走 generic route；必须走领域 route，由领域 route 注入 MCP server 和 allowlist。例如 `KnowledgeReviewTask` 走 `/api/knowledge/review`。
- 当前唯一实际 MCP server 是每次 review 请求内创建的本地 `loom` server；唯一 tool 是 `mcp__loom__write_proposal`，用于写 proposal event，不对外暴露 endpoint。
- 破坏性操作（删题、合并节点、reparent、merge、archive）没有直接 write tool。AI 只能 propose；用户 accept route 再执行真实 mutation。

**计划中的 DomainTool 合约**（未落地；第二个 tool-calling task 出现前不实现）：

```ts
type ToolEffect = 'read' | 'propose' | 'write';

interface DomainTool<Input, Output> {
  name: string;
  effect: ToolEffect;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  execute(ctx: ToolContext, input: Input): Promise<Output>;
  summarize(input: Input, output: Output): string;
  mirrorEvent: 'never' | 'when_user_visible' | 'when_causal' | 'always';
}
```

未来 `src/server/ai/tools/registry.ts` 才会成为领域工具源头；`src/server/ai/tools/mcp.ts` 再把选中的 DomainTool 包成 in-process MCP server。独立远程 MCP server 推后，不作为当前产品内 tool 架构核心。

**循环控制现状**：

`TaskBudget.maxIterations` 映射到 Claude Agent SDK `maxTurns`，`timeout` 由 runner 的 `AbortController` 执行。`maxCost` 与 `fallbackChain` 当前只是 registry metadata / future runtime policy；还没有执行预算 nudge、fallback、degraded 记录。

### 5.3 成本控制

- 同步任务（用户操作时跑）：归因、学习意图、review intent、teaching turn 等。
- 异步任务（pg-boss）：OCR、session summary、knowledge proposal、knowledge edge proposal、note generation、variant generation、review-session pruning。
- 模型分级：registry 用 `defaultProvider/defaultModel` 指定当前模型，Provider Manager 解析到 Claude Agent SDK 所需 env/baseUrl/model。
- 每次调用写 `ai_task_runs` / `ai_cost_ledger`；tool 调用写 `ai_tool_calls`。
- **尚未实现**：`maxCost` 硬预算、跨 provider fallback、degraded 标记、结果缓存、prompt caching 策略。不要在实现计划中假设这些已经生效。

### 5.4 Skill / MCP Server / Plugin

这些概念保留，但不要和产品内 runtime tool 混在一起：

- **Skill**（提示词包，markdown + frontmatter）：Phase 2 在 prompt 重复多了之后再抽
- **in-process MCP bridge**（当前可用）：领域 route 可手动创建 Claude Agent SDK `mcpServers`，不对外暴露
- **Standalone MCP Server**（对外暴露 resources + tools）：等核心闭环稳了、且确实需要外部客户端时再 expose；未来复用 DomainTool registry，不重写工具定义
- **Plugin**（学科 bundle）：Phase 3 真有第二学科再做；Phase 1 划好 `core/` vs `subjects/wenyan/` 的目录边界
- **外部 MCP 消费**（Calendar / Search / FS）：Phase 2 按需接

### 5.5 Tool calling 循环位置

**决策**：tool calling 多步循环跑在 **server 端**（Next route / pg-boss worker / scripts worker），client 只负责发起请求 + 接收 JSON 或 stream。浏览器永远不持 provider key，也不直接执行 tool。

#### 实现

- `app/api/ai/[task]/route.ts`：
  - `needsToolCall: false` 的 task → `runTask()` → JSON / buffered text
  - `needsToolCall: true` 的 task → 400 `tool_task_requires_domain_route`
- 领域 route（例如 `/api/knowledge/review`）调用 `streamTask()` / `runAgentTask()`，并注入 MCP server + allowlist。
- Claude Agent SDK 负责 multi-turn tool loop；`maxTurns` 来自 `TaskBudget.maxIterations`
- assistant tool-use blocks 写 `tool_call_log`
- 总 finish 写 `cost_ledger`（按 task / provider / model 聚合）
- client `src/ai/client.ts` 用 `fetch` + `ReadableStream`，按 `content-type` 分流：JSON 走 `res.json()`，stream 走 reader 循环（Phase 1 buffer 全文，未来 UI 消费 progress 再加 callback）

#### 为什么不在 client 跑

- Provider API key 不能暴露到浏览器
- Tool 需要 DB transaction、event guard、权限 allowlist、成本日志，必须留在 server 侧

#### 与 Dreaming 实施栈的关系

Dreaming / Maintenance lane 复用这套 runner：pg-boss schedule / job handler 调 `runTask` / `streamTask` 同样入口。区别只是触发方式（HTTP 请求 vs pg-boss scheduled job / queued job）和写入对象（event proposal、artifact、question draft 等）。

---

### 5.6 Dreaming / Maintenance 实施栈

Dreaming 和 Maintenance lane 当前跑在 self-hosted Node worker + pg-boss 上，不再使用旧 Workers 队列设计。

#### 触发与队列

- `scripts/worker.ts` 启动 worker 进程。
- `src/server/boss/handlers.ts` 注册 handlers 和 schedules。
- pg-boss 与 Postgres 共用 `DATABASE_URL`；Docker compose 中 `worker` service 与 `app` 使用同一镜像。

当前已注册的业务 job / schedule：

| Job | 触发 | 产出 |
| --- | --- | --- |
| `knowledge_propose_nightly` | BJT 02:00 schedule | `event(action='propose', subject_kind='knowledge')` |
| `knowledge_edge_propose_nightly` | BJT 02:30 schedule | `event(action='propose', subject_kind='knowledge_edge')` |
| `note_generate` | learning-intent accept 后 enqueue | 填充 atomic artifact sections |
| `variant_gen` | 复习 / 错因相关 enqueue | draft `question(source='mistake_variant')` |
| `session_summary` | review session end | session summary |
| `tencent_ocr_extract` | ingestion extract | OCR / block extraction pipeline |
| `prune_orphan_review_sessions` | BJT 04:15 schedule | abandon stale review sessions |

#### 当前边界

- 产出提议写 event stream，不写旧 proposal 表。
- 大批量 batch / 双 pass verify / weekly review 仍是未来能力，不要假设已存在。
- Cloudflare Tunnel 只负责 ingress；不是 AI worker runtime。

---

## 六、技术栈

| 层 | 选型 | 理由 |
| --- | --- | --- |
| Web app | Next.js 15 App Router + React 19 + Tailwind v4 | 当前实现；backend surface 在 `app/api/**` |
| 数据库 | Postgres + Drizzle ORM (`postgresql` dialect, `postgres` driver) | 本地、测试、NAS compose 同一数据库形态 |
| Blob 存储 | R2 / S3-compatible via `@aws-sdk/client-s3` | 图片 / 来源资产 |
| 部署 | Docker compose on NAS：`app` + `worker` + `postgres` + `cloudflared` | 自托管单用户，Cloudflare Tunnel 只做 ingress |
| 后台任务 | pg-boss + `scripts/worker.ts` | schedules、queues、OCR、proposal、note generation |
| AI 调用 | Claude Agent SDK runner + AI SDK v6 package + provider packages | 见上节任务层 |
| Tool calling 循环 | Claude Agent SDK query loop + in-process MCP bridge | 不自建 loop；当前由领域 route 手动注入 MCP，未来再抽 DomainTool registry |
| Note 编辑器 | TipTap / Milkdown / Lexical（基于 ProseMirror） | 详见 [`modules/notes.md`](modules/notes.md) |
| Note 渲染 | react-markdown / markdown-it | |
| 数学公式 | KaTeX | |
| 图表 | Mermaid | |
| 视觉录入 | Tencent QuestionMarkAgent async OCR + manual vision rescue | OCR 主路径已落地；vision rescue 手动触发 |
| 复习算法 | `ts-fsrs` | 成熟 OSS |

**反模式**：

- 不要一开始就上多端原生（RN / Flutter）
- 不要自建账号系统（自用没必要；当前用 `INTERNAL_TOKEN` 单用户内网/隧道保护）
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

> **Phase 1c.1 事件驱动核**（ADR-0006 v2）已落地。`event` + `learning_session` + `knowledge_edge` 是现行 schema 的三个新晋实体；下文骨架以现行 schema 为准，旧表（mistake / review_event / dreaming_proposal / ingestion_session）已在 Phase 1c.1 Step 9 DROP。旧实体名称只作为迁移背景出现；代码层不再有这些表。

```
Knowledge                          // 知识树节点（backbone）
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
        | vision_single | vision_paper | reverse_mark | attempt_variant
  source_ref?                     // source event_id (variant) / artifact_id (reverse_mark) / null
  draft_status?: draft | active   // 仅 attempt_variant 等需要双 pass 的题
  // 变式系列字段
  variant_depth: int              // 默认 0；0=原题，1=一代变式，最大 2
  root_question_id?: string       // 指向 root question (variant_depth=0 时可省略)
  parent_variant_id?: string      // 直接上一代
  created_by: {task, version}
  metadata?: { force_flexible?, expected_input_kind?, ... }
  created_at, updated_at, version  // created_at = 题目进入统一题库的记录时间

// ★ Phase 1c.1 实体：attempt = event WHERE action='attempt'
//    outcome='failure' 是错题视图；outcome='success' 也是学习表现信号。
//    旧 Mistake 表已 DROP（ADR-0006 v2）；UI 保留"错题"称呼（用户语义不变）

// 已入库题目的生命周期信息不复制到 Question 表：
// - 入库/记录时间：Question.created_at
// - 来源证据：Question.source / source_ref / metadata（source_document、asset、crop、origin block 等）
// - 作答记录：event(action='attempt', subject_kind='question', subject_id=question.id)
// - 复习记录：event(action='review', subject_kind='question', subject_id=question.id)
// - 当前复习调度：material_fsrs_state(subject_kind='question', subject_id=question.id)
// Reader/API 可以派生 QuestionActivitySummary；不要手写 last_reviewed_at 等漂移字段。
QuestionActivitySummary            // derived/read model, not canonical storage
  question_id
  recorded_at                      // question.created_at
  source, source_ref
  first_attempted_at?, last_attempted_at?
  attempt_counts: { success, partial, failure }
  first_reviewed_at?, last_reviewed_at?
  review_count
  due_at?, last_review_ref?        // read-model ref to the latest review action
  linked_record_ids[]

// 待学习列表（含层级）—— 学习意图层，与 event 解耦
LearningItem
  id
  source: mistake | manual | learning_intent | ai_dream
  source_ref                      // attempt event_id / dream event_id / null
  title, content
  → knowledge_ids[]
  primary_artifact_id?            // 主消费物（note_hub 或 standalone tool_quiz）
  // 层级关系
  parent_learning_item_id?        // atomic 指向 hub
  child_learning_item_ids[]?      // hub 持有 atomic
  // 状态（6 个）
  status: pending | in_progress | done | dismissed | resting | archived
  user_pinned: bool
  ai_score?: float                // weighted (urgency, weakness, recency)
  created_at, due_at?
  completed_at?                   // status=done 时填
  dismissed_at?                   // status=dismissed 时填
  archived_at?                    // status=archived 时填
  archived_reason?: maintenance | user
  reviewed_at?                    // dreaming 来源被用户确认的时间
  updated_at, version

CompletionEvidence
  id, learning_item_id
  path: self_declare | ai_propose | quiz_pass
  evidence_json                   // AI 看到的信号快照
  user_overrode_low_evidence?: bool
  decided_at

// 学习记录 — 用户活动产生的学习上下文（records 模块详述）
LearningRecord
  id
  kind: mistake | worked_example | open_question | insight | reflection | observation | resource_note
  title?
  content_md
  source: manual | ocr | import | conversation | agent
  capture_mode: text | image | paper | voice | url | mixed
  activity_kind: attempt | review | read | ask | annotate | import | conversation | plan
  processing_status: raw | linked | actioned | archived
  → origin_event_id                // 触发/物化该 record 的活动 event
  subject_id?
  → knowledge_ids[]
  → question_id?
  → attempt_event_id?             // kind=mistake 时关联 failure attempt event
  → artifact_id?
  → learning_item_id?
  → source_document_id?
  asset_refs[]
  payload: jsonb                  // kind-specific, small and Zod-guarded at API boundary
  created_at, updated_at, archived_at?, version

// Future memory layer — AI-curated projection, not manual notes
// LearningRecord is raw activity-grounded evidence. Memory is derived from records + events + graph + proposal feedback.
// Users act, capture, and correct; agents link, summarize, detect recurring patterns, and propose updates.
MemoryItem                         // future scope, not part of first LearningRecord migration
  id
  kind: learner_preference | recurring_misconception | durable_goal | strategy_note | subject_pattern
  subject_id?
  → knowledge_ids[]
  summary_md
  confidence
  evidence_refs[]                  // learning_record / event / knowledge / artifact ids
  status: active | stale | dismissed
  created_by: agent
  created_at, updated_at, refreshed_at?

// ★ Phase 1c.1 实体：propose / generate 动作走 event（ADR-0006 v2）
//    旧 proposal 表已 DROP；梦境流提议 = event WHERE action='propose' AND actor_kind='agent'

MaintenanceSuggestion               // ★ 保留 — 用户可回滚的维护建议（非 event，因需快照 + rollback_until）
  id, kind                        // merge_knowledge | archive | reset_fsrs | reset_mastery
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

// ★ Phase 1c.1 实体：LearningSession 替代旧 Session（ADR-0008）
LearningSession
  id, type: ingestion | review | tutor | explore | create | conversation
  status                          // per-type 状态机（见 § 学习会话多态状态机）
  started_at, ended_at?
  updated_at

// ★ Phase 1c.1 实体：event — 统一 action log（ADR-0006 v2）
Event
  id
  session_id → learning_session   // cron / system 事件可空
  actor_kind: user | agent | cron | system
  actor_ref                       // 'self' (user) / task_kind (agent) / cron_name
  action: attempt | judge | propose | generate | review | rate | extract | ...
  subject_kind: question | knowledge | knowledge_edge | artifact | source_document | event | record
  subject_id
  outcome: success | failure | partial | null  // attempt 的 success/failure/partial 都是学习信号
  payload: jsonb                  // Zod-guarded per action × subject_kind（见 ADR-0006 v2）
  caused_by_event_id → event      // 因果链：judge ← attempt，propose ← cron
  task_run_id → ai_task_runs
  cost_micro_usd: int?
  created_at

WeeklyReview
  id, week_start, summary_md
  → weak_points: knowledge_ids[]
  → recurring_attempt_event_ids[] // 反复答错的 attempt event（替代旧 recurring_mistakes）
  → cause_distribution            // 按 cause 类型的分布（来自 judge event payload）
  → integrated_record_ids[]       // 整合本周用户写的 reflection / open_question / insight

ToolCallLog                       // 运行时 LLM tool 调用观测
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
DomainTool {                      // LLM 调用的函数原语，跟 tool_* artifact 是不同概念
  name, description
  effect: read | propose | write
  input_schema, output_schema
  execute(ctx, input)
  summarize(input, output)        // ToolUseCard folded summary
  mirror_event: never | when_user_visible | when_causal | always
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

---

## 八、event — first-class action log（统一 action log）

> ADR-0006 v2 + ADR-0011。`event` 表是 Phase 1c.1 的核心新实体，替代旧 mistake / review_event / dreaming_proposal 三表。

**equal-actor model**：`actor_kind ∈ {user, agent, cron, system}`——AI 不是注释层，是与用户对等的事件发起者。Copilot 对话、Dreaming 夜间产出、Critique 自批改全部 first-class。

**schema reference**：见 § 七、数据模型骨架 `Event` 块；完整 DDL 在 `src/db/schema.ts`（event 表）。

**payload 守护策略**（ADR-0006 v2 "Option 折中"）：
- **KnownEvent union（11 个 discriminated 分支）**：`AttemptOnQuestion` / `JudgeOnEvent` / `ReviewOnQuestion` / `ProposeKnowledge` / `ProposeKnowledgeEdge` / `GenerateArtifact` / `GenerateKnowledgeEdge` / `RateEvent` / `RateKnowledgeEdge` / `AcceptSuggestionChip` / `ExtractSourceDocument`
- **ExperimentalEvent**：`action.startsWith('experimental:')` 的 escape hatch；探索期先跑，稳了再 promote 到 KnownEvent + 数据迁移
- Zod schema 在 `src/core/schema/event/`；每次 event 写入必须经 `parseEvent()` guard

**单一写入点**：`writeEvent()` from `src/server/events/queries.ts`。route / handler 不允许直接 `db.insert(event)` 绕过 parse guard。

**因果链（event chaining）**：`caused_by_event_id` 把动作串成 DAG——judge ← attempt，propose ← cron trigger，rate ← propose。可重放、可审计，critique agent 可作用于历史 event。

**示例**：
```
e1: user / attempt / question:q1 / failure   (用户答错)
e2: agent:attribution / judge / event:e1    (AI 归因，caused_by=e1)
e3: agent:propose / propose / knowledge:k1  (AI 提议知识点，caused_by=e1)
e4: user / rate / event:e3 / accept         (用户接受提议)
```

FSRS 投影表 `material_fsrs_state` 从 event 流派生，每次 `action='review'` 同事务写入（ADR-0006 v2 § 接受的代价）。

---

## 九、knowledge_mesh — tree + typed edge

> ADR-0010。`knowledge_edge` 表是 Phase 1c.1 加入的第二个新实体。模块细节见 [`docs/modules/knowledge.md`](modules/knowledge.md)。

**结构**："tree 是骨架，mesh 是肌肉"——`knowledge.parent_id` 保留主层级 backbone（一棵树），`knowledge_edge` 表叠加有类型的横向链接。tree 用于 effective_domain 派生 + UI tree-view；mesh 用于 Dreaming agent 找"薄弱但邻近"复习候选。

**关系类型（5 核心 + experimental）**：

| relation_type | 语义 | 例 |
|---|---|---|
| `prerequisite` | from 是 to 的前置 | 实词词义 → 翻译 |
| `related_to` | 弱关联（双向） | 之-用法 ↔ 其-用法 |
| `contrasts_with` | 对照（双向） | 之-代词 vs 之-助词 |
| `applied_in` | from 应用于 to | 古今异义 → 阅读理解 |
| `derived_from` | from 派生自 to | 之-主谓间用法 ← 之-用法 |
| `experimental:*` | 探索期新关系 | — |

**单一写入点**：`src/server/knowledge/edges.ts`；route 不允许直接 `db.insert(knowledge_edge)` 绕过 guard。

**propose 路径**（通过 event 流）：
1. `ProposeKnowledgeEdge` event（AI 提议，dry-run）→ 用户 accept
2. `RateKnowledgeEdge` event（rating='accept'）→ 触发 `GenerateKnowledgeEdge` event + `knowledge_edge` INSERT

**agent 读图路径**：不要把整张 `knowledge` / `knowledge_edge` 表直接塞进 prompt。使用语义化 graph reader：

- `get_subject_graph_overview`：subject 图例、root clusters、relation type 语义
- `query_knowledge`：按 query/id 找节点，返回 path、neighbors、stats、recent failures
- `expand_knowledge_subgraph`：围绕中心节点展开 bounded local subgraph
- `find_knowledge_paths`：解释两个节点之间的路径和关系

**其他 runtime context tools**：事件、学习记录、错题、复习队列、LearningItem 也通过语义化 reader 进入 agent 上下文：

- `query_events` / `get_question_context` / `query_mistakes` / `get_attempt_context`：读取 event timeline、题目生命周期和 failure attempt view
- `query_records` / `get_record_context`：读取用户活动物化出的错题、例题、疑问、顿悟、反思、资源摘录
- `get_review_due`：读取 FSRS due queue，不提交 review
- `get_learning_item_context`：给 Teaching / Coach / Copilot 提供学习项上下文
- `attribute_mistake` / `propose_variant`：包装现有 AttributionTask / VariantGenTask owner，不暴露任意 DB mutation

这些 tool 的完整设计见 [`docs/superpowers/specs/2026-05-17-agent-context-tools-design.md`](superpowers/specs/2026-05-17-agent-context-tools-design.md)。

参考 `src/server/knowledge/edges.ts`，ADR-0010，ADR-0011 §3-5。

---

## 十、异步任务层 (pg-boss) — Sub 0c

独立 worker 进程 + app process 经 LISTEN/NOTIFY 协同：

```
[Web (Next.js app)]                [Worker (Node.js, scripts/worker.ts)]
       │                               │  boss.work('tencent_ocr_extract', handler)
       │ POST /.../extract             │  → 拉到 job
       │ enqueueExtraction             │  handler:
       │   ├─ UPDATE session.status    │    IngestionSession.markExtractionStarted
       │   ├─ writeJobEvent → NOTIFY   │    R2.get + Tencent submit/poll + parse + crop
       │   └─ boss.send                │    IngestionSession.applyExtractionResult
       │                               │       └─ writeJobEvent (NOTIFY)
       ├── GET /.../events (SSE)       │    writeCostLedger(outcome, pgboss_job_id)
       │   replay + subscribe          │
       ↑                               │
       └─ listen_loop ←── pg_notify ──┘
          (instrumentation.ts)
```

**关键模块**：
- `src/server/boss/{client,handlers,shutdown}.ts` — pg-boss 单例 + handler 注册 + graceful stop
- `src/server/events/{writer,sse_router,listen_loop,sse_replay}.ts` — job_events + NOTIFY + SSE
- `src/server/session/` — LearningSession 多态模块（ADR-0008 + ADR-0005 演化，single owner）
- `src/server/ingestion/tencent_mark{,_parser,_errors}.ts` — Mark Agent SDK + parser + 错误分类
- `src/server/boss/handlers/tencent_ocr_extract.ts` — 生产 OCR async job handler

**学习会话 (LearningSession) 多态状态机** (ADR-0008，演化自 ADR-0005；[CONTEXT.md](../CONTEXT.md) "录入会话")：

`learning_session` 表承载 6 种会话类型：`ingestion | review | tutor | explore | create | conversation`。Phase 1c.1 实现前 2 种；余 4 种 enum 占位、行为延后。

每种 type 有独立 status 状态机，由 `src/server/session/` 多态模块内部分支：

```
# type='ingestion'（从 ADR-0005 IngestionSession 平移而来）
uploaded → (enqueueExtraction) → queued
        → (worker markExtractionStarted) → extracting
        → applyExtractionResult         → extracted | partial
        → markExtractionFailed          → failed
extracted | partial → markReviewed → reviewed
extracted | partial | reviewed → commitImport → imported (终态)
failed → enqueueExtraction (retry) → queued
partial → applyRescue (block-level) → partial（session 不变）

# type='review'（Phase 1c.1 新建最小状态机）
started → completed | abandoned
```

**Single owner invariant** (ADR-0005 / ADR-0008)：`src/server/session/` 是 `learning_session.status` 唯一可信写入点；route / handler 不允许直接 `db.update(learning_session)`。per-type Zod 状态机定义见 `src/core/schema/`。

**OCR 抽取层** (ADR-0002 修订)：用 Tencent QuestionMarkAgent (async submit+poll)，**不再 cascade**。Vision Tier 2/3 (haiku / sonnet) 仅作为**用户触发的救援**，走 `/api/ingestion/[id]/rescue`，永不参与自动 fallback。

**Acceptance gates**：EchoJob E2E (`app/api/echo/echo.e2e.test.ts`) + tencent_ocr_extract handler test + IngestionSession 16 transition tests。

**pg-boss dev harness（`echo_jobs` + `/api/echo`）**：`echo_jobs` 表 + `POST /api/echo` 路由 + `src/server/boss/handlers/echo.ts` 是 Sub 0c 的 **pg-boss E2E dev harness**，验证 enqueue → pg-boss worker → notify → SSE 全链路。这是验收门（acceptance gate），**不是生产业务路由**；不在 Phase 1c.1 DROP，但 Phase 2+ 可按需清理。（closes #34 finding 2）

**命名澄清**：`Tool` (LLM 函数原语) ≠ `tool_*` Artifact (互动型产出物)。前者是 AI 任务层的实现细节，后者是用户消费的内容对象。两个层级不冲突但同名易混。
