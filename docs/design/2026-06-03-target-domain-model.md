# 目标领域模型 — note · knowledge · learning_item · question · 组卷 · FSRS

> **Status**: Proposed（多轮设计讨论的综合稿，2026-06-03）。锁定后拆成 ADR + 迁移 spec + claude-design 改动。§7 决策已分别落定为 **ADR-0028**（知识级 FSRS 调度，Accepted 2026-06-03）与 **ADR-0029**（Coach 复习引擎落在既有原语上 / U0 裁决簇，Accepted 2026-06-04）——读本稿存储/调度形态时以这两份 ADR 为准。
> **由来**：UI 重绘（YUK-169）逼出了 note 模型分歧；顺着追到 question / 变式 / 组卷 / FSRS 单元。本稿把这些一起钉成一个目标模型。
> **现状基准**：本稿"现状"均核对过 `src/db/schema.ts` / ADR-0020 / ADR-0012 / 业务枚举（行号见各处）。仓库 `app/**` 旧 UI 已 stale，不作参照；后端是 ground truth。
>
> **rev 2026-06-07（YUK-203 re-map）**：对照 origin/main 已 ship 现实更正四处过时措辞——①§2.4/§6.2/§7.2 daily/final「四形态」清单 → 实际 `intent_source` 四 provenance；②§2.4「或单立 question_set」活口已删（§7.2 锁定复用 tool_quiz）；③§2.3 `source_tier`「真实列」更正为派生值（应用层 `deriveSourceTier`，question 表无此列）；④全文加 ADR-0028 / ADR-0029 交叉引用。语义不变，仅措辞对齐已落地实现。依据见 `.omc/research/yuk203-remap-2026-06-07.md` §4.3。

---

## 0. 一句话

把工具分成三层——**持久知识脊柱**、**意图/组织层**、**练习/评估层**。脊柱里的东西（概念、笔记、题目、记忆态、事件）是**一等公民、长期存储、按 knowledge 标签关联**；组织层（learning_item、goal）**引用**脊柱，不**拥有**它。

---

## 1. 三层

| 层 | 成员 | 性质 |
|---|---|---|
| **持久脊柱（知识本体）** | knowledge 节点 + mesh 边 · **note**(atomic/hub/long) · **question** 题池 · FSRS 记忆态 · knowledge_mastery · **event**(历史) | 一等、长期、knowledge-labeled、event-sourced |
| **意图/组织层** | **learning_item**(学习项/意图) · goal(North-Star) | 长期但是"组织视角"；**引用**脊柱，不拥有 |
| **练习/评估层** | FSRS 间隔复习 · **组卷**(按需测验) | 都产出 `attempt` event → 回喂脊柱的 FSRS/mastery |

---

## 2. 实体（按顺序）

### 2.1 knowledge（概念图，脊柱根）
- 节点 `knowledge`(parent_id 树) + `knowledge_edge`(5 类 typed 有向边，mesh)。mastery 是派生 view `knowledge_mastery`（ADR-0012，从 question event 算）。
- **概念是脊柱的锚点**：note 和 question 都以 `knowledge_ids[]` **标签**挂上来（ADR-0020 §3："label 模型；非 ownership"）。

### 2.2 note（artifact，一等、knowledge-labeled）
ADR-0020 已结构三合一（共用 `body_blocks`），但**三种语义不同、家不同**：

| type | knowledge_ids | 是什么 | **家（锚定）** |
|---|---|---|---|
| **atomic** | =1（verifier 强制） | 一个节点的**节点简介** | knowledge 节点（1:1，叶/中皆可） |
| **hub** | 1 或 N | 一个主题的**入口/索引"作品"**（cross_link 聚合子树 atomics，`hub_auto_sync` 维护） | 主题/子树（topic 节点） |
| **long** | 1 或 N | **跨主题长综合** | N 个节点 |
| **tool_quiz** | 独立 | 见 §2.4（→ 组卷） | — |

- **关键改动**：三种都**只以 knowledge 标签关联**，**没有一种被 `learning_item` 拥有**。当前后端的 `learning_item.primary_artifact_id` 1:1（DB 强制唯一，YUK-171）是要**松绑**的遗留耦合——见 §5 delta。
- UI 必须**按 type 区别对待**（节点简介 vs 主题入口 vs 综合长文，入口/反链不同）；现原型把三种拍平成"无 type 标签 note"是要修的。

### 2.3 question（统一题池，一等、multi-source、multi-axis）
**所有题目同一张 `question` 表**（schema L151-198），靠字段区分，不分系统：
- 内容：`kind`/`prompt_md`/`reference_md`/`rubric_json`/`choices_md`/`difficulty`(1-5)/`structured`/`figures`/`image_refs`
- 分类轴（**knowledge_id 只是其一**）。`question` 上的真实列：`knowledge_ids[]`(主题) · `source`(11 种) · `kind` · `difficulty` · `visual_complexity`。**派生/别处**：grounding 轴 `source_tier`（**rev 2026-06-07：非 question 列、是派生值**——由 `deriveSourceTier(source + metadata)` 在应用层算出 `tier 1-4 = authentic/sourced/material/generated`，见 `src/core/schema/provenance.ts:129`；原稿写的 `llm_only/search_grounded/textbook/user_verified` 枚举其实是 `NoteSection.source_tier` 笔记 body-block 的另一套概念，`src/core/schema/business.ts:241`，与 question grounding 无关。**P4 题库 grounding 轴筛选的 authoritative tier 值须由应用层 `deriveSourceTier` derive**——不能把 SQL 当 tier 的 single source of truth；但允许用 SQL `CASE` 近似 tier_rank 做候选池的预排序/分页（先按近似 tier 排再 `LIMIT` 截池），再在 TS 层用 `deriveSourceTier` 重算权威 tier 排序（已 ship 模式见 `src/server/quiz/fewshot-retrieve.ts:108-140`，该 `ORDER BY tier_rank` CASE 只决定哪些行进池、不决定最终 tier）——见 ADR / re-map D-P4-1）；`subject`（**非列**，从 knowledge_ids 经 subject-resolution 推）；`cause_category`（在 `mistake_variant`/judge event，**非 question 列**）
- 变式血缘：`variant_depth`/`root_question_id`/`parent_variant_id` + `mistake_variant` 表（提议生命周期）
- 组合：`kind='question_part'` + `parent_question_id` + `part_index`
- **录入 vs AI 变式同样管理**：同表、同复习/FSRS/判题路径，差别只在 `source` + 血缘元数据。录入暂存在 `question_block`（OCR 原始块）→ enroll → question 行。

### 2.4 组卷 / question-set（tool_quiz 升级）
- **改动**：把"笔记里的嵌入小测"从"自带 `source='embedded'` 独立题"改成**引用题池里的 question**。底子已在：`embedded_check: { question_ids: string[] }`（business.ts L243）。
- **泛化**：所有"引用题池的 question-set / 组卷"都用**同一个** `tool_quiz` 容器，靠 provenance 轴 `intent_source` 区分形态。**rev 2026-06-07（D-P2-1）**：已 ship 的 `intent_source` 四 provenance 是 `review_plan` / `quiz_gen` / `embedded_check` / `ingestion_paper`（`src/core/schema/index.ts:137`）。原稿把 `daily`/`final` 当作并列的"组卷形态"是术语错位——`daily` 实由 **`review_plan`（job/event payload 上的 `run_kind='daily'`，注意 `run_kind` 在 review_plan payload 而非 `learning_session` 列）吸收**，`final` 仅是 `question.source` 上的一个标签枚举值、**无独立组卷路径**，故不存在独立的 daily / final 组卷形态。
- **长期存储 + event-sourced**：question 长存于题池；做组卷里的题 = `attempt` event（与复习同一种）→ 喂同一套 FSRS/mastery，**不另记**。
- 组卷自身是个轻引用实体（沿用 tool_quiz artifact 带 `question_ids`）；与被引用 question 无父子、不级联删（ADR-0020 §6 已定 quiz 独立可多引用）。**rev 2026-06-07（D-P2-3）**：原稿"或单立 `question_set`"活口已删——§7.2 锁定**复用 tool_quiz、不单立 `question_set`**，ADR-0029 §决定2 进一步钉死"试卷容器 = `tool_quiz` 一个容器"（sections / per-assignment intent 进 `ToolStateT` v2 jsonb），代码无 `question_set` 表。

### 2.5 learning_item（意图/组织层，引用不拥有）
- ADR-0006 定义：**"用户/AI 声明的学习意图（TODO/Goal 层）"**。生命周期（status: pending/in_progress/done/resting/dismissed/archived；列含 `user_pinned`(bool) + `due_at`/`completed_at`/`dismissed_at`/`archived_at`/`reviewed_at` 时间戳）→ 长期项目记录、**可 archive**。
- **决策（§7.3）：learning_item 可 archive；archived 默认折叠/隐藏**（agent tool 默认不返回 archived、UI 默认收起 archived 区）。surface 本身不降权。
- 作用：意图 → AI 拆解 hub+atomic 计划 → 跟踪进度 → 学习入口 → 接 goal。
- **改动**：从"`primary_artifact_id` 1:1 拥有一篇 note"改成**引用**脊柱：引用它的 hub note（项目入口）+ label 交集的 atomic/long（学习材料）+ 关联的 question/组卷。**"可挂载 note" 保留（引用），"独占所有权"去掉。**

### 2.6 FSRS 记忆态 + event
- `material_fsrs_state`：唯一键 `(subject_kind, subject_id)`，**今天 `subject_kind='question'`**（per-question）。注释明示 `subject_kind` 是**泛化点**（"other material kinds in later phases"）。
- `event`：动作（attempt/review/judge/correction…）+ `caused_by_event_id` 链 = 历史脊柱。FSRS 态、mastery 都从 event 投影。

---

## 3. 关系（join 模型）

```
knowledge ──label(knowledge_ids)──> note          (atomic=1 / hub=topic子树 / long=N)
knowledge ──label(knowledge_ids)──> question
knowledge ──typed edge──> knowledge                (mesh, 5 类)
question  ──lineage(root/parent/depth)──> question (变式) + mistake_variant 生命周期
组卷      ──reference(question_ids)──> question
learning_item ──reference──> {note, question, 组卷, goal}   ★不再 own
* ──> event ──caused_by──> event                   (一切留痕)
```

**两个核心原则**：① 脊柱实体之间靠 **knowledge 标签**关联（非 ownership）；② 组织层（learning_item/goal）**引用**脊柱实体。

---

## 4. 两种练习模式（都喂同一事件流）

| 模式 | 触发 | 单元 | 产出 |
|---|---|---|---|
| **间隔复习（FSRS）** | FSRS 排期（到期） | 见 §5 | attempt event → FSRS + mastery |
| **组卷/测验（评估）** | 按需/节奏（你发起） | 一组 question 引用 | attempt event → FSRS + mastery |

组卷**不被 FSRS 排期**（是评估不是记忆刷新），但其 attempt **照样进 event、照样更新记忆态**。

---

## 5. FSRS 单元 — 本稿最大的开放决策

现状 = **per-question**。两条张力：
1. **变式破坏 per-question**：变式是"用不同题考同一知识"，per-question 会把每个变式当独立记忆项各排各期（错粒度）。
2. **recall vs application**：纯回忆题重复见同题=目的（per-question 合适）；应用/解题题重复见同题=背答案（有害），该靠**换变式**练同一技能。

**建议（待你拍）**：
- 纯回忆题 → 保持 **per-question FSRS**。
- 应用/变式重的题 → 转 **per-知识点/技能 FSRS + 变式轮换**（探针）；和 `knowledge_mastery` 对齐。
- 落地为**按 subject/question-kind 路由的混合**（capability registry 已按 kind 路由判题，调度单元同理可路由）。
- 基础设施已铺路：`material_fsrs_state.subject_kind` 泛化点 + `knowledge_mastery` view + 变式血缘。

---

## 6. 与现状的 delta（按实施顺序）

> 顺序 = 先脊柱模型、再题目/组卷、再练习单元、最后 UI。每步都能独立交付。

1. **note 解耦（脊柱）**：松绑 `learning_item.primary_artifact_id` 1:1 不变量（reverse YUK-171 的 DB 唯一索引）→ note 成一等 knowledge-labeled 实体；learning_item 改引用。新增 `GET /api/notes/[id]` 读聚合 + label 交集列表读（notesForKnowledge / notesForItem，把 node-page 的"单 primary atomic"拓宽成"多笔记"）。typed backlink 分组、decay 派生 bucket。
2. **组卷化（题目层）**：tool_quiz → 引用 `question_ids`（底子已在 embedded_check）；所有组卷统一为单一 `tool_quiz` 容器、靠 `intent_source` 四 provenance（`review_plan`/`quiz_gen`/`embedded_check`/`ingestion_paper`）区分形态；组卷 attempt = event。**rev 2026-06-07（D-P2-1）**：原"统一 daily/final/嵌入小测/试卷"措辞已更正——daily 由 `review_plan(run_kind='daily')` 吸收、final 仅 `question.source` 标签，二者非独立组卷形态（详见 §2.4）。
3. **FSRS 单元（练习层）**：按 §5 决策落地；若上 per-知识点，用 `subject_kind='knowledge'` 这条泛化路径 + 变式轮换的 due 选题。
4. **UI（重绘对齐）**：① 笔记按 type 区别呈现（不再拍平）；② 新增 **题库/题目管理 surface**（多轴筛选：来源/难度/grounding/变式家族/知识点）——现设计里没有；③ 学习项详情"关联笔记"按"引用"而非"独占"，区分项目入口(hub)与材料(atomic/long)。

---

## 7. 决策（已锁，2026-06-03）

1. **FSRS 单元 → 按知识点，AI 调度。** 不再 per-question 排期；`material_fsrs_state` 走 `subject_kind='knowledge'`，到期的是**知识点**，由 AI 选题/变式去探测（变式轮换）。per-question 态退役为派生/历史信号。**（rev 2026-06-07：本决定已落定为 ADR-0028「FSRS scheduling by knowledge point, with question probes」，Accepted 2026-06-03；ADR-0028 §决定3 把变式轮换/AI 选题明确为 deterministic selection seam 的未来替换项——当前 due 选题仅做"避开上次题"的确定性轮换，变式家族感知选题尚未接通；ADR-0028 §决定4/5 另留 unlabeled legacy question 仍走 question-level FSRS fallback。）**
2. **组卷 → 复用 `tool_quiz`**（artifact 带 `question_ids` 引用题池），不单立 `question_set`。所有组卷形态都用 tool_quiz，靠 `intent_source` 四 provenance 区分。**（rev 2026-06-07：本决定已落定为 ADR-0029「Coach 复习引擎落在既有原语上 / U0 裁决簇」§决定2，Accepted 2026-06-04——"试卷容器 = `tool_quiz` 一个容器"，sections / per-assignment intent 进 `ToolStateT` v2 jsonb，运行 attempt = `learning_session(type='review')` + nullable `artifact_id`；`review_plan`/`review_paper_attempt`/`paper_question_assignment` 三表不建。原稿"daily/final/嵌入小测/试卷"列举更正为实际四 provenance `review_plan`/`quiz_gen`/`embedded_check`/`ingestion_paper`——D-P2-1，详见 §2.4。）**
3. **learning_item → 可 archive；archived 的默认折叠/隐藏**（agent tool 默认不返回 archived、UI 默认收起 archived 区）。learning_item surface 本身保持正常、**不**降权。
4. **题库 / 题目管理 surface → 这轮加**（多轴筛选：来源 / 难度 / grounding / 变式家族 / 知识点）。
5. **note 解耦 → 走真迁移**：reverse YUK-171 的 1:1 唯一索引 + 重排 node-page / backlinks / resolveOwningLearningItemIds 的读（不走"软对齐"）。

→ 全部锁定。§2.4 / §2.5 / §5 按以上落地。下一步：按 §6 顺序拆 ADR + 迁移 spec + claude-design prompt（见下方实现计划）。
