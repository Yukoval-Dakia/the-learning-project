# Agent Context Tools — Brainstorm + Doc Map

**状态**：brainstorm / doc-map，配套 spec 为 `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md`。

## 一句话方向

接下来所有 agent tool 文档都围绕同一个原则写：**让 agent 更好地理解当前上下文，并让 proposal 更便宜、更可审计、更容易被用户接受或拒绝**。

## 已落地到文档的内容

| 文档 | 本轮承担的角色 |
|---|---|
| `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` | canonical design：DomainTool、in-process MCP bridge、knowledge graph reader、event/record/mistake/review/LearningItem readers、proposal/action tools、工程阶段 |
| `docs/modules/records.md` | LearningRecord 一次性迁移：替代 StudyLog，把 `/record` 从错题入口改成统一学习记录入口 |
| `docs/modules/knowledge.md` | Subject Graph Guide contract + auto seed/enrich lifecycle + graph proposal quality rubric |
| `docs/architecture.md` §5.2/5.4/5.5/knowledge_mesh | 更新当前 runner 和 tool 设计边界；修正旧 Workers / Vercel AI SDK 表述 |
| `docs/adr/0004-pattern-c-two-type-agent-architecture.md` | 标记 2026-05-17 implementation update：当前 runner 是 Claude Agent SDK，ADR 的两类 agent 和 proposal-only 原则继续有效 |
| `src/ai/README.md` | 给实现者一个短入口：怎么加 Task，怎么接 tool，哪些写入只能 proposal |
| `docs/superpowers/status.md` | 文档地图加 agent context tools spec |

## 应继续 brainstorm 的文档

### 1. Subject Graph Guide Contract

**状态**：已落 `docs/modules/knowledge.md` §2。

已解决：

- guide 是自动 seed / 自动丰富的读图说明，不需要用户 accept 才 active。
- 新 subject 或大知识区域创建时如何 seed guide？
- `wenyan` 这个 subject 的图谱 cluster 怎么命名？
- 哪些 relation type 在文言文里是常见语义？
- 哪些 proposal 是高风险，必须更强 evidence？
- 图谱 overview 里给 agent 的 `reading_hint` 从哪里来？

后续应实现通用 `SubjectGraphGuide` 存储和 seed/enrich 服务；不要为每个学科写一份硬编码说明文件。

### 2. LearningRecord Contract

**状态**：已落 `docs/modules/records.md`。

已解决：

- 因为当前没有真实数据，采用一次性破坏式迁移，不做 StudyLog 兼容桥。
- `/record` 是统一入口，不是错题入口，也不是自由笔记桶；record 应由系统内用户活动产生。
- `LearningRecord.kind='mistake'` 对应错题；它会链接 `question_id` + `attempt_event_id`。
- 非错题记录包括 `worked_example / open_question / insight / reflection / observation / resource_note`。
- 每条运行时创建的 `LearningRecord` 应通过 `origin_event_id` 追溯到触发它的活动 event；全局手动录入也先写 capture event。
- `event` 仍是事实动作流；非错题 record 不伪造成 attempt event。
- `LearningRecord` 是未来 memory 层的证据来源，不是 memory 本身；长期画像、反复误区、偏好和策略应由 AI 从 records / events / graph 中提炼。
- 用户不应手工维护 memory。用户负责捕获、确认和纠错；agent 负责链接、归纳、提炼和提出 memory 更新。
- `/study-log` 和 `study_log` 应删除或开发期返回 `410 Gone`，避免保留坏模型。

### 3. Event / Record / Mistake / Review / Learning Tool Contracts

**状态**：已落 `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md`。

已解决：

- `query_events` 是 bounded timeline reader，不是 raw JSONB / SQL explorer。
- `query_records` 统一读取由用户活动物化出的学习上下文；`query_mistakes` 是 `kind='mistake'` 的专用视图。
- `get_record_context` 读取单条 LearningRecord 的完整上下文。
- `get_attempt_context` 是 Copilot 解释单题错误的主工具，避免 agent 自己拼多次查询。
- `get_review_due` 只读 FSRS due queue，不触发 `/api/review/submit`。
- `get_learning_item_context` 读 hub/atomic、primary artifact、completion evidence、recent activity。
- `attribute_mistake` 包装现有 AttributionTask + `judge` event 写入，不接受调用 agent 传入的 cause。
- `propose_variant` 包装现有 VariantGenTask / `runVariantGen`，MVP 只生成 1 个 draft question。
- `propose_learning_item_completion` / `propose_learning_item_relearn` 只写 proposal，真实状态转换走 accept route。
- `propose_record_links` / `propose_record_promotion` 只写 proposal，真实链接或 promotion 由 accept route 执行。

这批 tool 的共同原则：read 工具返回 agent 可理解的语义摘要；write/action 工具只能走现有 owner，不能暴露任意 DB mutation。

### 4. Context Budget Policy

**建议位置**：`docs/modules/agent-tools.md` 或 agent context tools spec 的后续修订。

要决定：

- Copilot 每轮最多读多少 nodes / edges / events？
- Dreaming batch 可以读多大的 subgraph？
- Review Orchestrator 什么时候只用 deterministic summary，什么时候允许 tool read？
- tool 返回里 excerpt 的最大长度是多少？

目标不是省 token 本身，而是防止 agent 因为上下文太胖而误读重点。

### 4.5 Memory Brief Note

**状态**：已细化为 Dreaming 维护的 brief note，进入 coding plan。

已决定：

- `query_records` 读的是 evidence，不是 durable memory。
- 第一批 memory 不是 vector layer / profile builder，而是 `memory_brief_note`。
- Dreaming 周期性刷新三段短文：近一周、近几个月、长期重要 memory。
- brief note refresh 必须引用 evidence ids，例如 `learning_record.id`、`event.id`、`knowledge.id`、`artifact.id`。
- `query_memory_brief` 作为未来 DomainTool 读这个派生摘要；真正的 tool registry 不在本次 data-loop 计划里硬造。

要继续 brainstorm：

- 是否需要 subject-scoped brief note 默认和 global 同时刷新？
- long-term 段落如何做 stale 规则：多久无证据支撑后降权或移除？
- brief note 如何参与 Orchestrator proposal，而不污染 mastery 的确定性信号？

### 5. Proposal Quality Rubric

**状态**：已落 `docs/modules/knowledge.md` §4。

已决定：

- `propose_knowledge_edge` 至少需要几条 evidence event？
- 一条近期 failure 是否足够提出 `contrasts_with`？
- `prerequisite` 是否必须有学习顺序证据，而不是只靠名字判断？
- duplicate / redundant tree edge 的拒绝规则在哪里表达？

这份 rubric 会直接影响 proposal 接受率，是 Dreaming / Maintenance lane 的质量门。

### 6. Tool Eval Fixtures

**状态**：knowledge fixture 清单已落 `docs/modules/knowledge.md` §5；其他 tool fixture 仍需实现。

要覆盖的固定问题：

- "我为什么老错之？"
- "这两个知识点是不是易混？"
- "是否应该提议 prerequisite？"
- "query 0 result 后，Copilot 如何给 corrective chip？"
- "这题我到底错在哪里？" → `get_attempt_context`
- "今天为什么要复习这些题？" → `get_review_due`
- "这个 LearningItem 能不能标完成？" → `get_learning_item_context` + completion proposal evidence
- "我的记录里最近有哪些未解决问题？" → `query_records(kind=open_question)`
- "这条记录后续能做什么？" → `get_record_context`
- "针对这次 concept 错因出一道变式。" → `propose_variant`

目标是先验证 tool 输出够不够 agent 理解，而不是只测 SQL 正不正确。

### 7. Copilot Suggestion Semantics

**建议位置**：`docs/adr/0011-tool-use-and-edge-event-paths.md` 后续修订。

要继续区分：

- `proactive` suggestion：agent 主动提议下一步
- `corrective` suggestion：tool soft/hard fail 后建议换参数或重试
- 用户点击 chip 后是 `accept_suggestion`，不是模拟 user message

这个语义会影响 UI、metrics 和 event chain 可读性。

### 8. ToolUse Promotion Criteria

**建议位置**：`docs/adr/0011-tool-use-and-edge-event-paths.md`。

ADR-0011 现在把 `experimental:tool_use` 留在实验命名空间。等至少三个真实 tool 跑起来后，要决定是否 promote 到 stable `tool_use`。

Promote 前需要明确：

- event payload shape 是否稳定？
- `tool_call_log` 和 `event` 的边界是否稳定？
- cost 是只在 ledger，还是也 mirror 到 event？
- failed tool 的 error taxonomy 是否够用？

## Scope Fence

暂时不要写这些：

- 独立远程 MCP Server 实现计划
- 通用 plugin / skill marketplace
- 多学科 subject abstraction
- 让 agent 直接写 knowledge/tree destructive mutation
- 让 agent 自己 accept / dismiss / rollback proposal
- 让 agent 调 `POST /api/review/submit`
- 把所有 Task 都改成 tool-calling

先把知识图谱读懂、proposal 写顺，再扩张。
