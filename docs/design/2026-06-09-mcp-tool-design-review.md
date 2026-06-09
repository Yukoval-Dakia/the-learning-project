# MCP / DomainTool 设计审查 — 决策账（进行中）

> Status: **CRYSTALLIZED → ADR-0032**（2026-06-09）。逐工具审查走完，决定固化进
> **`docs/adr/0032-domaintool-surface-redesign.md`**。本文件保留为**审查全过程的决策账本**（grounded 基线 + 逐簇推导），
> ADR 是结论摘要；细节看本文件。Linear 已 reconcile（YUK-302 re-scope + ADR-0031/0032 impl umbrella）。
> 已被 compact 过一次——本文档的首要目的是**让审查可在压缩后续上**。
>
> 创建：2026-06-09。最近一次更新：M-1/M-2/E-1 收口、crystallize 进 ADR-0032。

---

## 0. 审查是什么

把 copilot 从 **C 形态**（确定性：关键词 detect → parse → runQuizSkill，模型不碰工具）推到 **A 形态**
（OpenClaw 式 agent：模型自己决定 + inline 调工具，不离开对话、不往后台抛 subagent）。ADR-0031 已固化 quiz 这一刀。
本审查是其**前置**：把**所有** DomainTool 的设计过一遍——找重复/缺失，再逐工具拍逻辑设计——
保证 copilot「全工具」时这套工具面是齐的、坐标系是自洽的。

owner 的总纲：**copilot 应当是全工具的，无论哪一部分的读和写都应有权限**；task 专属直写留给后台 task。

---

## 1. 基线（grounded 2026-06-09，勿凭记忆）

### 1.1 工具清单 = 34（`src/server/ai/tools/bootstrap.ts` CORE_TOOLS）

机械一致：34 == allowlist 三组并集（`allowlists.ts`）。

- **READ_TOOLS = 14**：`query_mistakes` `query_events` `get_attempt_context`
  `get_subject_graph_overview` `query_knowledge` `expand_knowledge_subgraph`
  `find_knowledge_paths` `query_records` `get_record_context` `get_question_context`
  `get_review_due` `get_learning_item_context` `query_memory_brief` `search_memory_facts`
- **PROPOSE_WRITE_TOOLS = 16**：`propose_knowledge_edge` `propose_knowledge_mutation`
  `attribute_mistake` `propose_variant` `propose_learning_item_completion`
  `propose_learning_item_relearn` `propose_learning_item_defer`
  `propose_learning_item_archive` `propose_record_links` `propose_record_promotion`
  `update_prompt` `add_option` `set_question_type` `split_stem` `merge_questions`
  `reassign_figure`
- **REVIEW_PLAN_ONLY_TOOLS = 4**：`read_coach_brief` `get_review_knowledge_snapshot`
  `select_review_question_candidates` `write_review_plan`

### 1.2 DomainTool 契约（`types.ts`）

`effect: read|propose|write` · `costClass: local|cheap_llm|expensive_llm` ·
`mirrorEvent: never|when_user_visible|when_causal|always` · zod in/out · `execute` / `summarize`。
ToolContext = `{ db, taskRunId, callerActor, causedByEventId }`。

### 1.3 8 个面（deny-by-default allowlist，`satisfies Record<DomainToolSurface, ...>` 编译期锁）

`knowledge_review` · `copilot` · `copilot_user_suggested_mistake_action`(**CP⁺**) ·
`dreaming` · `coach` · `maintenance` · `ingestion_block_edit` · `review_plan`

关键现状：
- **CP⁺** = `[...COPILOT_TOOLS, 'attribute_mistake', 'propose_variant']`——即 copilot base **加** 这两个。
- **copilot base 现有**：14 读里除 `get_review_knowledge_snapshot`（它是 review_plan-only，不在 READ_TOOLS）外大体都有；
  写 = `propose_knowledge_edge` `propose_knowledge_mutation` + learning_item 四件套（complete/relearn/defer/archive）。
  **现在没有**：`attribute_mistake` `propose_variant`（在 CP⁺）、`propose_record_links` `propose_record_promotion`（dreaming/maintenance）、
  任何题块编辑工具、`write_review_plan` 及 review_plan 三读。
- `ingestion_block_edit` = 6 草稿写 + `get_question_context` + `query_events`。6 草稿写**只在此面**。
- `review_plan` 红线：**不读 memory**（无 `search_memory_facts` / `query_memory_brief`），`read_coach_brief` 是其唯一注意力先验。
- `maintenance` 用 deny-filter 把 `search_memory_facts` 滤出（单一 chokepoint 保持 memory-free）。

---

## 2. 贯穿性框架（先于逐工具）

### 2.1 收敛 RULE（已立）

- **同轴 / 同能力 → 收敛**（合一）。例：learning_item 四件套；`author_question`。
- **异轴 / 异爆炸半径 → 分开**。例：知识树(parent_id 单写) vs mesh(typed edge)；record 标注链接 vs 提升物化。

### 2.2 Tool↔Task 二象性（R2，基本认同）

能力同时以 **inline 工具** 和 **后台 Task** 存在，共享**一个 core**：
- attribution：`runAttributionAndWriteJudgeEvent`（`src/server/knowledge/attribute.ts`）
- variant：`runVariantGen`（`src/server/boss/handlers/variant_gen.ts`）

后台 Task 的触发口（`src/server/boss/handlers/AGENTS.md`）：
- **cron 夜间链**：knowledge_propose(02:00) → edge_propose(02:30) → hub_sync(02:45) →
  knowledge_maintenance(03:00) → dreaming(03:15) → coach_daily(03:45) → goal_scope(03:50) → prune(04:00+)；coach_weekly(周日 04:30)
- **事件链**：`note_generate→note_verify→embedded_check`；
  `attribution_followup→variant_gen`（accept 后 →`variant_verify`）；`quiz_gen→quiz_verify`；`session_summary`；`note_refine`
- **user/route**：quiz-skill、ingestion

→ 像 `get_review_knowledge_snapshot`(G5) 这种**毫无疑问不是 task 专属**的读，应开放给 copilot（见 §3.5）。

### 2.3 author_question 统一（D3，待最终 crystallize）

三个「造题」入口共享**一个 `author_question` core** + seeding 模式：
- variant（seed = 错因/mistake-cause）= 现 `propose_variant`/`runVariantGen`
- quiz / `write_question_draft`（seed = knowledge/material）= ADR-0031 的写工具
- `record_promotion → question`（seed = record）= 现 `propose_record_promotion` 的一支

→ ADR-0031 的 `write_question_draft` 在最终稿要**reframe 成 `author_question(seed=knowledge|material)`**；
统一写策略为一句「draft 一道题，用户 accept」。

---

## 3. 逐工具决策账

### 3.1 attribution（`attribute_mistake`）—— 已拍

current：`effect='write'`、直写 judge event（actor='attribution'，newest-wins，幂等）、core 共享、4 入口
（attribution_followup / 本工具 / paper-submit / ingestion import）。「caller cannot provide a cause」。

- **D1**：`attribute_mistake` 进 **copilot base**；**CP⁺ 面溶解**（它本就只多 attribute_mistake + propose_variant，两者都进 base 后 CP⁺ 无增量）。`effect=write` 保留。
- **D2**：新增**用户断言错因**路径（`actor='user'`，走 profile 的 causeCategories taxonomy）——与「judge 来断因」并存。
- **D3**：新增 **`force_reattribute`**（写一条**新** judge event，newest-wins 覆盖；不改旧行）。

### 3.2 `propose_variant` —— 已拍

current：`effect='propose'`，调 `runVariantGen`，写 variant_question proposal；
guards = failure/active/judge-required/cause-targetable/depth≤2/in-flight-cap/cooldown。

- **D1**：进 **copilot base**。
- **D2**：**硬 guard 绑定**（cause-targetable、depth≤2）；**软 guard 降为 advisory**（in-flight cap、cooldown、count=1），允许 **count>1**。
- **D3**：并入 **`author_question` core**（seeding：mistake/knowledge/material）。见 §2.3。

### 3.3 learning_item 四件套（R1）—— 已拍

current：`propose_learning_item_{completion,relearn,defer,archive}` 四个独立工具，差异只在 state 前置条件 / 参数。

- **R1**：收敛为 **`propose_learning_item_transition(to: completed|relearn|deferred|archived, 判别式参数)`** + **per-surface `to` 限制策略**（不同面允许的目标态不同）。

### 3.4 知识写 pair —— 已拍

- `propose_knowledge_edge`（mesh，subject_kind='knowledge_edge'，rubric-gated）
  与 `propose_knowledge_mutation`（树 omnibus，判别式 propose_new/reparent/merge/split/archive）
  **保持分开**（异轴：mesh overlay vs 树 backbone）。
- **待查缺口**：**edge 删除**路径是否存在（mutation 有 archive，edge 侧是否有对称下架）。

### 3.5 records pair + G5/G6 —— 已拍

- `propose_record_links`（标注，≤12 链接，低爆炸半径）与 `propose_record_promotion`
  （物化 → question/learning_item/artifact，高爆炸半径）**保持分开**。
- record_promotion 的 **→question** 支共享 **`author_question` core**。
- **G6**：`propose_record_links` + `propose_record_promotion` 进 **copilot base**。
- **G5**：`get_review_knowledge_snapshot`（mastery 读，现 review_plan-only）**开放给 copilot**——
  需从 REVIEW_PLAN_ONLY 提升为共享读 / 跨授（实现时定）。

### 3.6 题块读写簇 —— 本轮收口 ✅

**决定性事实**：`StructuredQuestionT` 是递归树，每节点带写侧寻址用的 `id`
（`{id, role:stem|sub|standalone, question_no?, prompt_text, options?, answers?, analysis?, kind?, sub_questions?}`
+ `figures[{asset_id, role, attached_to_index→节点id}]`）。
**`question.structured`（活跃层）和 `question_block.structured`（草稿层）是同一形状、同一套节点 id**；
导入**不拍平**（`question.structured` 是 `jsonb $type<StructuredQuestionT | null>`，仅 variant/embedded_check 这类「直接 prompt_md 生成、从无树」的题为 null）。

**缺口**：唯一读工具 `get_question_context` 把树拍平成 `prompt_md`（散文）+ figures（只给 asset_id/role，**无 attached_to_index**）。
读侧给散文、写侧要节点 id = **两套坐标系**。纯工具的「读→选节点→写」闭环今天不成立（6 草稿写工具能跑只因人在 ingestion UI 喂 node id）。

| 项 | 决定 |
|---|---|
| **R6 活跃结构读** | `get_question_context` 加 `include:['structure']`，吐**裁剪可寻址树**（留 id/role/question_no/prompt_text/options/answers/analysis/kind/sub_questions + figures[asset_id,role,attached_to_index]；**砍** extraction_evidence/bbox/page_index） |
| **草稿结构读** | **新 `get_question_block_structure(blockId)`**，同 projection，**仅 `ingestion_block_edit` 面**（与 6 草稿写同面；面级 allowlist per-tool，故不能折进 get_question_context 的 blockId 分支） |
| **读≡写不变量** | 锁进设计：**读出的树 ≡ 写入的寻址坐标**；禁止再引入 prose/node 错位 |
| **null-structured** | 无树的题 → 结构读返回 null，node 编辑如实拒绝（prose-only），非 bug |
| **active 题编辑** | **约束版 `propose_question_edit`**：窄 typed 节点操作 + post-edit 一致性 verify 闸（mini-QuizVerify）+ proposal-only；**不做自由重写** |
| **6 草稿写** | 留 ingestion-only（A）；收口成 `edit_question_block` omnibus 押后（**R5，低优先**） |

### 3.7 review-plan 簇 —— 已拍

current：4 工具，`review_plan` 面专属（夜间 ReviewPlanTask）。`read_coach_brief`（唯一注意力先验，无 memory）、
`get_review_knowledge_snapshot`(=G5，知识级 due+mastery)、`select_review_question_candidates`（题级候选池整形）、
`write_review_plan`（唯一写，落 `tool_quiz` artifact，重契约校验）。三读都 funnel 过 `executeGetReviewDue` 单一 core。

**三层三轴框架**（造题 vs 组卷是不同轴）：
- 轴1 **造原子** = `author_question`（seed → 1 道新题，可 draft）
- 轴2 **组分子** = paper-compose（N question_id + assignment + policy → 1 个 tool_quiz artifact）
- 轴3 **读给组卷** = 3 RP 读 + `get_review_due`

| # | 决定 |
|---|---|
| **RP-1** | `write_review_plan` ≠ `author_question`（异轴：组已有 vs 造新），分开；不是 author_question 的 seeding 模式 |
| **RP-2** | 轴2 实为两 wrapper：`write_review_plan`（复习：池内**非草稿**、Coach-gated、per-run 幂等）+ ADR-0031 copilot 组卷写（**草稿允许**、无池 gate）。前置条件**相反**故分开，但产出 tool_quiz 形状相同 → 共享 `writeToolQuizArtifact` core。**不预抽**（反过度工程：第二实例未落地），ADR-0031 组卷落地时再抽 |
| **RP-3** | **GAP**：copilot 组卷写不存在，ADR-0031 impl 要补（轴2 的 copilot wrapper，allow draft） |
| **RP-4** | 3 RP 读不删（同 core 不同粒度投影，非重复）；**4 个 RP 工具（含 `write_review_plan`）全部也授予 copilot**；review_plan 面对夜间 task 保持窄 + 无 memory |
| **RP-5（原则）** | **面的窄 = 约束自主 task；copilot（用户驱动）= 全集并。** review_plan「不读 memory」约束的是夜间 planner，不是「带 memory 的人不能写复习卷」——copilot 读完 memory 再 `write_review_plan` OK（该工具自身不读 memory） |

---

## 4. 最终 crystallize 时要落的 ripple

- ADR-0031 `write_question_draft` → reframe 成 `author_question(seed=knowledge|material)`。
- 统一写策略：一句「draft 一道题，用户 accept」。
- **CP⁺ 面溶解**（attribute_mistake + propose_variant 进 copilot base 后）。
- G5 mastery 读（`get_review_knowledge_snapshot`）开放 copilot。
- copilot base 新增净增量汇总：`attribute_mistake`、`propose_variant`、`propose_record_links`、
  `propose_record_promotion`、`get_review_knowledge_snapshot`；learning_item 四件套 → 收敛后的 `propose_learning_item_transition`。
- 新工具：用户断言错因路径、`force_reattribute`、`author_question`、
  `propose_learning_item_transition`、`get_question_context include:['structure']`、
  `get_question_block_structure`、`propose_question_edit`。

---

### 3.8 query 缺口 + edge 删除 —— 已拍（最后两 open 收口）

- **M-1**：`query_mistakes`（失败 attempt + 错因/复习/变体复合读，event-centric）**不并入** `query_question`——异轴（失败-attempt 复合 vs 题库目录浏览）。错题专用 cause/variant join 塞进通用目录读会污染后者。
- **M-2 缺口**：无 `query_questions` 目录浏览 **DomainTool**。`GET /api/questions` 多轴筛选 reader 已存在（**YUK-280 Done**），但未包成 agent 工具。ADR-0031 组卷/authoring 需「knowledge X 上已有哪些题」避免重复造题 → 新 `query_questions` DomainTool 包 YUK-280 reader；届时再看 query_mistakes 是否降为其 filtered view。
- **E-1**：`propose_knowledge_edge` 现 **create-only**（`proposed_change` 只 `{from,to,relation_type,weight}`，无 archive 方向；库里 `archived_at` + 读 filter 在但 propose 侧缺）→ 改**判别式 `propose_create | propose_archive`**，镜像 `propose_knowledge_mutation` 节点侧 omnibus。

---

## 5. 收口

逐工具审查 + 重复/缺失盘点全部走完 → 固化进 **`docs/adr/0032-domaintool-surface-redesign.md`**（D0–D9）。

**Linear reconcile（已做）**：
- YUK-302 re-scope（生成结构 piece → author_question / ADR-0031；判分收窄 YUK-212 留存可分离）。
- ADR-0032 impl umbrella（本审查落地）+ ADR-0031 impl umbrella（quiz C→A，依赖 author_question）。
- 校正：`query_questions`（M-2）建在 YUK-280 reader 上；`propose_question_edit`（D6/B）建在 YUK-281 `write.ts` 上——都不是从零造。

**实现门禁**：「拍前不实现」——本审查为设计阶段，落地走 impl umbrella 的 lane 拆分，不在本轮动代码。
