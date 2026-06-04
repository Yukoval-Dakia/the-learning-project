# Agent Objectives — runtime 速查卡

> **What this is**: 运行期速查。每张卡用最短篇幅回答"这个 agent 是谁、吃什么、吐什么、能碰哪些工具、边界在哪"。
> **What this is NOT**: 设计记录。形态决策、为什么这样切、被推翻的旧案，全在
> [agent-framework-design spec（AF，2026-06-04 U0 修订）](../superpowers/specs/2026-06-04-agent-framework-design.md)。
> 本卡与 AF spec 互链而不重复：spec 改了，回这里同步授权矩阵与边界；这里发现矛盾，以 spec + [U0 裁决记录](../design/2026-06-04-u0-decisions.md) 为准。
>
> **授权事实源**：工具面一律引 `src/server/ai/tools/allowlists.ts` 的现状常量，不凭记忆列。
> 卡片里若标 *planned*，表示 spec 已裁决但 allowlists.ts 尚未落地（实施时回填）。

产品形态一句话（AF §9）：用户只对一个 Copilot 说话；其余三个在后台规划 / 综合 / 维护，窄任务执行有界活儿。

---

## Copilot — 用户面全能体

- **Purpose**（AF §1.1 / §2.1）：唯一面向用户的对话 agent。全局挂载、自动拿当前上下文，可教学 / 解题 / 讲解 / 批评 / 规划 / 巡检。Teaching 是它的一个 skill/state，不是单独产品面。
- **输入**：用户消息 + `CurrentUserContext` 信封（AF §5：route / surface / 单 active_ref；selection / 多 ref 是后续 pass）+ memory brief + 按需经工具拉的领域记录/事件。
- **输出**：对话回复 + tool-card（工具调用外显）+ 走 propose_* 的提议（破坏性改动一律不直改）。
- **工具面**：`allowlists.ts` 的 `COPILOT_TOOLS`（共 11 项 = 10 项安全 read + 1 项 propose；read 非 `READ_TOOLS` 全集 —— `query_memory_brief` + 图概览/知识/事件/记录/记录上下文/题目/错题/attempt/复习到期 read，**不含** `expand_knowledge_subgraph` 子图展开、`find_knowledge_paths` 路径、`get_learning_item_context` 学习项 read；propose 仅 `propose_knowledge_edge`）；`copilot_user_suggested_mistake_action` 变体在用户显式触发时追加 `attribute_mistake` + `propose_variant`。*Planned*：AF §3.1 授予 `search_memory_facts`（coach/dreaming/copilot 三编排角色之一）。
- **边界**：
  - proposal-only —— 破坏性领域改动只能提议，除非已有用户确认路由拥有该 mutation（owner = [ADR-0025 ND-5](../adr/0025-north-star-goal-entity-and-coach-coexistence.md) + [ADR-0004](../adr/0004-pattern-c-two-type-agent-architecture.md)，AF §1.2 / §3.3 只引用不重定义）。
  - 不持原始 DB mutation 能力；draft-layer 直改只在显式为该编辑设计的 surface 上（如 `ingestion_block_edit`，不在 Copilot 默认工具面）。
  - skill 调 prompt/context/policy，**不**改工具权限边界（AF §1.3）。

## Coach — 规划下一步

- **Purpose**（AF §2.2）：决定学习者下一步该做什么。不是聊天面，是 daily plan / 周反思 / 科目时间配比 / 复习卷规划 / goal strand / plan 调整 / 学习项生命周期提议背后的规划 agent。
- **输入**：规划类 read（mistakes / attempt / review-due / learning-item / question context / memory brief）+ active/pinned 学习项的 knowledge_ids 作为注意力压力一等输入（[U0 D11](../design/2026-06-04-u0-decisions.md)，永不碰记账）。
- **输出**：结构化 artifact —— `TodayPlan`，其中复习走**战略 brief**（科目配比 / 知识焦点 / 时间盒 / intent tags），住 `TodayPlan.review_session_proposal` 扩展字段；不另立 artifact type，不进 in-session 热循环（`checkpoint_adapt` 归 ReviewPlanTask）。
- **工具面**：`allowlists.ts` 的 `COACH_TOOLS`（规划 read + plan/生命周期/知识提议：completion/relearn/defer/archive/`propose_knowledge_mutation`/`propose_knowledge_edge`）。*Planned*：AF §3.1 授予 `search_memory_facts`。
- **边界**：战略 brief only；战术出卷（候选/probe 选择、写 plan、in-session checkpoint 自适应）归窄任务 `ReviewPlanTask`（[ADR-0029](../adr/0029-review-engine-lands-on-existing-primitives.md) §2.2 / CO spec）。proposal-only 同 Copilot。

## Dreaming — 异步综合与记忆

- **Purpose**（AF §2.3）：离开实时交互环跑综合与模式发现。读近期学习信号 / memory brief / 记录，跨 note·question·attempt·proposal·goal 找重复模式，产高价值 inbox 提议，刷新长期学习者记忆，消费窄任务留下的 agent note。
- **输入**：广 read + memory brief/facts + 来自 `leave_agent_note` 的过期带外 hint（AF §4 / §4.1）。
- **输出**：inbox 提议 + 记忆喂入/刷新。
- **工具面**：`allowlists.ts` 的 `DREAMING_TOOLS`（含 knowledge-review read 集 + records/question/mistakes/learning-item read + 学习项 completion/relearn + record links/promotion 提议）。*Planned*：AF §3.1 授予 `search_memory_facts`。
- **边界**：不拥有今日运营排程（那是 Coach 的活）。记忆是注意力先验非真值源（[ADR-0017](../adr/0017-memory-mem0-plus-brief-layer.md)）：不直改 due/mastery/FSRS、不偏置判分（AF §3.1）。

## Maintenance — 基底结构健康

- **Purpose**（AF §2.4）：守护学习基底的结构健康，盯让系统更难推理的东西 —— 断/重知识链、过期或冲突的覆盖、孤儿/畸形 question profile、图形态问题、note/artifact 一致性、proposal 卫生。
- **输入**：广 read（整套 `READ_TOOLS`）+ `leave_agent_note` hint（AF §4.1）。
- **输出**：结构修复提议（走 proposal，不静默改持久学习事实）。
- **工具面**：`allowlists.ts` 的 `MAINTENANCE_TOOLS`（全 `READ_TOOLS` + knowledge edge/mutation + 学习项 completion/relearn/defer/archive + record links/promotion 提议）。
- **边界**：可用广 read 与结构提议工具，但**不**静默 mutate 持久学习事实（AF §2.4）。**不读记忆**——`search_memory_facts` 只授三编排角色，Maintenance 不在内（AF §3.1）。

## 窄任务 — 有界执行

一句话定位（AF §2.5 / §3）：judge / attribution / variant / quiz-gen / 结构修正 / note refine / profile·coverage 提取等，各守自己的最小窄工具面（如 `ingestion_block_edit`、*planned* `review_plan_task`），不升级为用户面 agent，不拿 Copilot 全工具面。`ReviewPlanTask` / `QuizGenTask` / `KnowledgeReviewTask` 及所有 evaluator/operator 任务一律**不读记忆**（AF §3.1 deny 名单）。
