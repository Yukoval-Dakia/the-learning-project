# ADR-0032 — DomainTool 面设计审查：copilot 全集并 + 能力按轴收敛/补缺

**Status**: Accepted（2026-06-09）— owner 逐工具拍板（见各簇 RULED 行）。实现门禁：本审查为设计阶段，「拍前不实现」；落地走 ADR-0032 impl umbrella。
**Part of**: YUK-203（领域模型重构）。与 ADR-0031（quiz C→A）并列：0031 管 copilot 出题这一条用户路径，本 ADR 管**整个 DomainTool 面**的重复/缺失/逻辑设计。
**Decision source**: 2026-06-09 grill 会话（owner「审查所有 mcp/tool 的设计 → 找重复和缺失 → 逐工具拍逻辑设计」）。逐工具决策账：`docs/design/2026-06-09-mcp-tool-design-review.md`。
**Related**: ADR-0031（copilot 内联出题，author_question 的上游用例）· `docs/superpowers/specs/2026-06-04-agent-framework-design.md`（**full safe capability** 原则）· ADR-0025 ND-5（proposal-only 只管破坏性改动）· ADR-0010（知识 mesh：树脊柱 + typed edge overlay）· ADR-0028（知识级 FSRS）· ADR-0029（tool_quiz 唯一容器）· YUK-270（上一轮 copilot 扩容）· YUK-280（`GET /api/questions` 目录读路由）· YUK-281（`PATCH /api/questions/[id]` 编辑路由）· YUK-302/YUK-212（composite 生成 + 判分收窄）。

---

## 背景

### 上位原则（已锁）：Copilot 是全工具 agent

`agent-framework-design` 已定：copilot 始终持 **full safe capability set**——所有 read/propose + 路由自带 scope 守卫的直写工具；proposal-only 仅约束破坏性 domain 改动（ADR-0025 ND-5）。安全靠「破坏性走提案 + 全程 event 留痕可回滚」，**不靠削工具面**。

### 审查触发

owner 在 ADR-0031 固化 quiz C→A 后，要求把**所有 34 个 DomainTool** 过一遍：先盘重复/缺失，再逐工具拍逻辑设计，保证 copilot「全工具」时工具面齐、坐标系自洽。

### 基线（grounded 2026-06-09）

34 工具 == allowlist 三组并集：**READ=14 / PROPOSE_WRITE=16 / REVIEW_PLAN_ONLY=4**。8 个面 deny-by-default（`satisfies Record<DomainToolSurface,...>` 编译期锁）：`knowledge_review` `copilot` `copilot_user_suggested_mistake_action`(CP⁺) `dreaming` `coach` `maintenance` `ingestion_block_edit` `review_plan`。其中 CP⁺ = copilot base + `attribute_mistake` + `propose_variant`。

---

## 决定

### D0 两条贯穿性 RULE / 原则

1. **收敛 RULE**：**同轴 / 同能力 → 合一**（learning_item 四件套、author_question）；**异轴 / 异爆炸半径 → 分开**（树 vs mesh；record 标注 vs 提升；组已有 vs 造新）。
2. **面-copilot 原则（RP-5）**：**面的窄 = 约束自主 task；copilot（用户驱动）= 全集并。** task 专属面（review_plan「无 memory」、ingestion_block_edit「草稿写」）保持窄，是为了约束夜间/自主 agent；这些工具**同时也授予 copilot**，因为 copilot 是用户的全能代理。

### D1 attribution（`attribute_mistake`）

- 进 **copilot base**；**CP⁺ 面溶解**（其唯一增量 attribute_mistake + propose_variant 都进 base）。`effect=write` 保留（直写 judge event，newest-wins，幂等）。
- 新增**用户断言错因**路径（`actor='user'`，走 profile causeCategories taxonomy）。
- 新增 **`force_reattribute`**：写一条**新** judge event 覆盖（newest-wins，不改旧行）。

### D2 `propose_variant`

- 进 copilot base。
- **硬 guard 绑定**（cause-targetable、depth≤2）；**软 guard 降 advisory**（in-flight cap、cooldown、count=1），允许 count>1。
- 并入 **`author_question` core**（见 D8）。

### D3 learning_item 四件套 → 收敛

`propose_learning_item_{completion,relearn,defer,archive}` 四工具差异仅在 state 前置/参数 → 收敛为 **`propose_learning_item_transition(to: completed|relearn|deferred|archived, 判别式参数)`** + **per-surface `to` 限制策略**。

### D4 知识写 pair → 保持分开

`propose_knowledge_edge`（mesh，rubric-gated）与 `propose_knowledge_mutation`（树 omnibus：propose_new/reparent/merge/split/archive）异轴，分开。**补缺口（E-1）**：`propose_knowledge_edge` 现为 **create-only**，无删边路径（库里 `knowledge_edge.archived_at` + 读 filter 都在，但 propose 侧缺）→ 改为**判别式 `propose_create | propose_archive`**，镜像节点侧 omnibus。

### D5 records pair → 保持分开 + 进 copilot

`propose_record_links`（标注，≤12，低爆炸半径）与 `propose_record_promotion`（物化 → question/learning_item/artifact，高爆炸半径）异轴分开。promotion 的 **→question** 支共享 author_question core。两者**进 copilot base（G6）**。`get_review_knowledge_snapshot`（mastery 读，G5）**开放 copilot**。

### D6 题块读写簇

**决定性事实**：`question.structured`（活跃层）与 `question_block.structured`（草稿层）是**同形状、同节点 id** 的 `StructuredQuestionT` 树，导入**不拍平**（仅 variant/embedded_check 这类无树题为 null）。写侧用 `(id, nodeId)` + figure `asset_id` 寻址；读侧 `get_question_context` 却把树拍平成 `prompt_md` 散文 → **读写两套坐标系**，纯工具的「读→选节点→写」闭环不成立。

- **R6 活跃结构读**：`get_question_context` 加 `include:['structure']`，吐**裁剪可寻址树**（留 id/role/question_no/prompt_text/options/answers/analysis/kind/sub_questions + figures[asset_id,role,attached_to_index]；砍 extraction_evidence/bbox/page_index）。
- **草稿结构读**：新 **`get_question_block_structure(blockId)`**，同 projection，**仅 `ingestion_block_edit` 面**（与 6 草稿写同面；面级 allowlist per-tool）。
- **读≡写不变量**：读出的树 ≡ 写入的寻址坐标；禁止再引入 prose/node 错位。
- **null-structured**：无树题结构读返回 null，node 编辑如实拒绝（prose-only）。
- **active 题编辑（B）**：新 **`propose_question_edit`**（建在 YUK-281 `write.ts` 上）= 窄 typed 节点操作 + post-edit 一致性 verify 闸（mini-QuizVerify）+ **proposal-only**；不做自由重写。
- **6 草稿写**：留 ingestion-only（A）；收口成 `edit_question_block` omnibus 押后（R5，低优先）。

### D7 review-plan 簇（task 专属写）

4 工具走 `review_plan` 面（夜间 ReviewPlanTask）。三读 funnel 过 `executeGetReviewDue` 单一 core。

- **RP-1**：`write_review_plan` ≠ `author_question`（异轴：组已有非草稿题 vs 造新题），分开。
- **RP-2**：组卷（轴2）实为两 wrapper——`write_review_plan`（复习：池内非草稿、Coach-gated、per-run 幂等）+ ADR-0031 copilot 组卷写（草稿允许、无池 gate）。前置条件**相反**故分开，但产出 tool_quiz 形状相同 → 共享 `writeToolQuizArtifact` core。**不预抽**（反过度工程），ADR-0031 组卷落地时再抽。
- **RP-4**：3 RP 读不删（同 core 不同粒度投影）；**4 个 RP 工具（含 `write_review_plan`）全部也授予 copilot**；review_plan 面对夜间 task 保持窄 + 无 memory（红线约束的是夜间 planner，不是「带 memory 的人不能写复习卷」）。

### D8 author_question 统一

三个「造题」入口共享**一个 `author_question` core** + seeding 模式（同轴 → 合一）：
- variant（seed=错因）= 现 `propose_variant` / `runVariantGen`
- quiz / `write_question_draft`（seed=knowledge/material）= ADR-0031 写工具
- `record_promotion → question`（seed=record）= 现 `propose_record_promotion` 一支

ADR-0031 的 `write_question_draft` reframe 成 `author_question(seed=knowledge|material)`；统一写策略为「draft 一道题，用户 accept」。

### D9 query 缺口

- **M-1**：`query_mistakes`（失败 attempt + 错因/复习/变体复合读）**不并入** `query_question`——异轴。
- **M-2 缺口**：无 `query_questions` 目录浏览 **DomainTool**。`GET /api/questions` 多轴筛选 reader 已存在（YUK-280），但未包成 agent 工具。ADR-0031 copilot 组卷/authoring 需「knowledge X 上已有哪些题」**避免重复造题** → 新 `query_questions` DomainTool 包 YUK-280 reader 逻辑。届时再看 `query_mistakes` 是否降为其 filtered view。

---

## 后果

### copilot base 净增量

新增授予：`attribute_mistake`、`propose_variant`（D1/D2，CP⁺ 溶解）、`propose_record_links`、`propose_record_promotion`、`get_review_knowledge_snapshot`（D5/G5/G6）、4 个 RP 工具含 `write_review_plan`（RP-4）、`query_questions`（D9）；learning_item 四件套 → `propose_learning_item_transition`（D3）。

### 新工具 / 改造

新增：用户断言错因路径、`force_reattribute`（D1）、`author_question`（D8）、`propose_learning_item_transition`（D3）、`get_question_context include:['structure']` + `get_question_block_structure`（D6）、`propose_question_edit`（D6/B）、`query_questions`（D9）。
改造：`propose_knowledge_edge` → 判别式 create|archive（D4/E-1）；`propose_variant` guard 软硬分层（D2）。
core 抽取：`writeToolQuizArtifact`（RP-2，ADR-0031 组卷落地时与 `write_review_plan` 共享）。

### 面变更

CP⁺（`copilot_user_suggested_mistake_action`）溶解。`review_plan` / `ingestion_block_edit` 保持窄（D0-2）。`ingestion_block_edit` 加 `get_question_block_structure` 读。

### 不变量

- 读≡写坐标（D6）。
- review_plan 面无 memory（RP-4）。
- 破坏性改动 proposal-only（ADR-0025 ND-5）；copilot 直写仅限路由已守 scope 的安全工具。
- 34 == allowlist 并集的机械一致性（改后须同步 bootstrap + allowlist + 测试）。

### Linear

- **YUK-302** re-scope：composite **生成**结构piece → 归 ADR-0031 / author_question（D8）；**判分收窄**（YUK-212）是可分离的独立 scope，留存。
- 开 **ADR-0032 impl umbrella**（本 ADR 落地）+ **ADR-0031 impl umbrella**（quiz C→A，依赖 author_question）。
- 新 issue：`query_questions` DomainTool（D9，包 YUK-280）、`propose_knowledge_edge` 删边（D4/E-1）、`author_question` 统一（D8）、`propose_question_edit`（D6，建 YUK-281）等——并入 ADR-0032 umbrella 的 workstream 清单。
