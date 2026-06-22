# Knowledge mesh — typed cross-edges 补 parent tree backbone

**决策**：保留 `knowledge.parent_id` 作为**主层级 backbone**（一棵树），并**叠加** `knowledge_edge` 表承载**有类型的横向链接**——`prerequisite` / `related_to` / `contrasts_with` 等。整体形态：**tree 是骨架，mesh 是肌肉**。

不动 parent_id（tree 仍是 effective_domain 派生 + UI 导航的主结构）；只**追加** edges 维度让 knowledge 之间能跨 parent 链接。

---

## 决策细节

### Schema

```sql
knowledge_edge {
  id              text PK
  from_knowledge_id text NOT NULL FK knowledge
  to_knowledge_id   text NOT NULL FK knowledge
  relation_type   text NOT NULL    -- 见下
  weight          real DEFAULT 1   -- 0-1 强度（可选；AI 提议时填 confidence；用户加时默认 1）
  created_by      jsonb (AgentRef) -- 'user' / 'agent:propose' / ...
  reasoning       text             -- 可选解释；AI 提议时必填
  created_at      timestamp NOT NULL
  archived_at     timestamp        -- soft delete

  UNIQUE (from_knowledge_id, to_knowledge_id, relation_type)
  INDEX from_idx on (from_knowledge_id, relation_type)
  INDEX to_idx on (to_knowledge_id, relation_type)
}
```

**directed**——所有 edge 一律有方向。undirected 语义（如 `contrasts_with`）由 app 层查"from OR to"或建对边表达。这与 event chain (caused_by_event_id) 的设计风格一致。

### relation_type 核心集合（含 experimental escape，per Option 折中风格）

| relation_type | 方向语义 | 例 |
|---|---|---|
| `prerequisite` | `from` 是 `to` 的前置 | 实词词义 → 翻译 |
| `related_to` | 弱关联（双向） | 之-用法 ↔ 其-用法 |
| `contrasts_with` | 对照（双向） | 之-代词 vs 之-助词 |
| `applied_in` | `from` 应用于 `to` 场景 | 古今异义 → 阅读理解 |
| `derived_from` | `from` 派生自 `to`（变式 / 拆分） | "之-主谓间用法" derived_from "之-用法" |
| `experimental:*` | 探索性新关系 | `experimental:contrasts_register` 等 |

新关系按 ADR-0006 v2 Option 折中规则——用 `experimental:` 命名空间先跑，稳了 promote 到正式枚举 + 数据迁移。

### AI 平等 actor 在 mesh 上的体现

`knowledge_edge` 是 **event subject_kind 的扩展**——AI / 用户都能提议 / 接受 / 撤回 edge：

```ts
// event.subject_kind 扩展（修订 ADR-0006 v2）：
subject_kind: 'question' | 'knowledge' | 'knowledge_edge' | 'artifact'
            | 'source_document' | 'event'
```

新 event 路径（Phase 1c.1 实施）：

| event 组合 | 含义 |
|---|---|
| `action='propose', subject='knowledge_edge'` | AI 提议加一条新边（dry-run，需用户接受） |
| `action='generate', subject='knowledge_edge'` | AI 直接落库一条新边（仅 maintenance agent / 用户授权时） |
| `action='rate', subject='knowledge_edge'` | 用户对一条 AI 提议的 edge 投票 accept/dismiss |
| `action='attempt', subject='question'`（不变） | 错答触发的 attribution → judge → propose 链条可附 edge proposal |

KnowledgeProposeTask + KnowledgeReviewTask（已有）扩 prompt：rather than only propose new nodes, also propose edges between existing nodes.

> **2026-05-18 修订**：上文"扩 KnowledgeProposeTask + KnowledgeReviewTask prompt"的实施做了**部分调整**：
>
> - `KnowledgeReviewTask` ✅ 按原计划扩 prompt——MCP tool `mcp__loom__write_proposal` 支持 mesh-shape mutation（`payload.mutation: 'propose_knowledge_edge'`），见 `src/ai/registry.ts:KnowledgeReviewTask` 的 system prompt + `src/server/knowledge/review.ts`
> - `KnowledgeProposeTask` **未扩** prompt——边提议能力被剥离到独立 task `KnowledgeEdgeProposeTask`（`src/ai/registry.ts:KnowledgeEdgeProposeTask`，新建于 Phase 1c.1）
>
> 选独立 task 而非扩 prompt 的原因：
>
> 1. **输入数据不同**：node 提议看的是单个 mistake + tree_snapshot；edge 提议看的是 `recent_failures`（24h 窗）+ `existing_edges` 集合——是跨 attempt 的模式匹配，不是 per-attempt 的归因延伸
> 2. **决策树清晰**：原 ADR 担心 prompt 复杂度（"建新节点 vs 建新边"），分成两 task 让每个 prompt 单一职责，节点提议保留低 maxIterations（=2）+ 快路径，边提议独立调优
> 3. **触发节奏不同**：`KnowledgeProposeTask` 跟 attempt 即时触发（user action / pg-boss attribution_followup）；`KnowledgeEdgeProposeTask` 适合 batched / scheduled 触发（看模式需要积累），目前由 pg-boss 起，未来可移到 maintenance cron
> 4. **审计颗粒度**：cost_ledger 按 task_kind 分桶；分两 task 能直接看出"节点提议"和"边提议"各自的 token 消耗、接受率，方便调 prompt
>
> 节点提议和边提议的 event 形态都按原 ADR 走 `subject_kind: 'knowledge' | 'knowledge_edge'`——event 层契约未变，只是产生 event 的 task 分了两个。

> **2026-06-22 修订（Lane D / YUK-482）**：上文 "`KnowledgeProposeTask` + `KnowledgeReviewTask` 扩 prompt" 的实施做了**进一步调整** —— `KnowledgeProposeTask` **整体被移除**（连同 nightly cron `knowledge_propose_nightly` 与 `runProposeAndWrite`）。原任务把"答错 attempt → 提议新 KC"耦合在 performance 轴；按 axis-cleanup 重整，**KC 创建 / 提议是 CONTENT 轴动作**（由材料覆盖什么知识驱动），**与学生答题正误无关**。答错只喂错因 / attribution + mastery。`KnowledgeEdgeProposeTask`（边提议，现仍走 `knowledge_edge_propose_nightly` cron）保留，但其输入仍是 `recent_failures` 的模式匹配视图，**不是**驱动 KC 创建。KC 创建现完全走 content-driven 路径（cold-start-bridge / image-candidate-accept matcher / agent proposal-tools）+ 维护流 `KnowledgeReviewTask`。下文出现 `KnowledgeProposeTask` 的历史段落（含本节首句扩 prompt 设想、§接受的代价中的 prompt 复杂度顾虑、迁移路径 Step 4）保留作演进记录，**不再现役**。详见 `docs/architecture.md` §5.1 与 PR #559。

---

## 理由

1. **真实学习关系不止 tree**。文言文里：
   - "之-主谓间用法" 与 "句式分析" 是 `prerequisite`
   - "之 / 其 / 而" 是 `contrasts_with` 三元
   - "古今异义" `applied_in` "翻译" 和 "阅读理解"
   
   tree-only 让这些关系无家。jsonb knowledge_ids on entity 只是"entity 挂 N 个 knowledge"，**不是** knowledge 之间的关系。
2. **AI-Driven (C 档) 需要 mesh**。Dreaming agent 想要"找到用户薄弱但邻近"的复习候选——没 mesh 就只能用 parent tree + co-occurrence，效果差。Variant gen / quiz gen 同理。Phase 2 的 SourceRetrievalTask 也需要 mesh 来跨节点找相关材料。
3. **Tree 仍是 backbone，不破坏现有逻辑**。effective_domain 继续走 parent_id chain；UI tree-view 不变；新 mesh **可选可视化**（force-directed 模式按需）。
4. **typed relation 比单一 edges 表达力强**。多种关系混在一张表但用 relation_type 区分——查询时按类型过滤（"只看 prerequisite" / "所有非 derived_from"），比把每种关系建独立表干净。
5. **与 event-driven 核协同自然**。edge 不是 first-class 数据"流"，是 **state**。但 edge 的**创建 / 修改 / 接受 / 撤回**都是 event。所以 mesh 是结构层，event 是行为层——两层正交。

---

## 接受的代价

- **Phase 1c.1 工时再 +2-3 d**（18-24 → 20-27 d）。新表 + Zod + AI prompt 扩展 + edge CRUD 路由 + 用户面"接受 AI 提议的 edge"UX。用户已 ack mesh 改造方向。
- **Edge 数据可能膨胀**。AI Dreaming + 用户手加 → 单用户 < 1000 节点 × 平均 5 edges/节点 ≈ 5000 edges。每 edge < 200 bytes ≈ 1 MB。**完全可控**。多用户来时考虑分区，单用户不必。
- **UI 复杂度提升**。`/knowledge` 页要画 mesh（tree + 边）。loom v1 只画 table——v2 需要：
  - 默认 table 视图（不动）+ "切换到 graph 视图"按钮
  - graph 用 force-directed（D3 / cytoscape），按 relation_type 分色
  - 这是 design brief §9.7 已经留口的 "knowledge graph 可视化" open question
- **AI prompt 复杂度**。KnowledgeProposeTask 要思考"是建新节点还是建新边"。**缓解**：prompt 给清晰决策树（"若 concept 是已有节点的子类 → propose_new node; 若是已有节点间关系 → propose_edge"）。

---

## 迁移路径

**零迁移**——只加新表 + 新 event 路径，老数据不动：

1. Phase 1c.1 Step 1 schema：新增 `knowledge_edge` 表（空）+ event.subject_kind enum 加 'knowledge_edge'
2. Phase 1c.1 Step 2 Zod：新增 ProposeKnowledgeEdge / GenerateKnowledgeEdge / RateKnowledgeEdge 三个 discriminated union 分支
3. Phase 1c.1 Step 7 API：CRUD `/api/knowledge/edges` + 接 propose 流
4. Phase 1c.1 Step 7 AI：KnowledgeProposeTask / KnowledgeReviewTask prompt 扩
5. Phase 1c.2 UI：`/knowledge` 加 graph 视图 toggle

---

## 触发重新评估的条件

- **edges 超过 ~10000 行**：查询性能调优 + 可能加部分索引或物化视图
- **多 domain 出现**（Phase 2 真有第二学科）：考虑跨 domain edge 的语义—— prerequisite 是否跨 domain 有意义？
- **AI 提议 edge 接受率 < 30%**：说明 prompt 设计或 relation_type 集合不准；回头收紧
- **用户面"graph 视图"使用率 < 10%**：可能 mesh 是后端有用、前端 table 够——保留后端结构 + 砍 graph UI
- **多用户**：edges 表加 `user_id`（虽然 ADR-0007 单用户假设说明这是 retrofit；mesh 不增加 retrofit 复杂度，因为 edges 本来就是单用户作用域）

---

## 与其它 ADR 的关系

- **ADR-0006 v2**（event-driven 核）：本 ADR **扩展** ADR-0006 v2 的 event.subject_kind enum 加 'knowledge_edge'；新增 3 个 discriminated union 分支（Propose / Generate / Rate edge）
- **ADR-0008**（learning_session 多 type）：不影响——edges 不分 session 类型
- **ADR-0007**（单用户）：mesh 不增加 retrofit 复杂度
- **ADR-0002**（OCR 抽取层）：不影响
- **CONTEXT.md** "知识点 (knowledge)" 词条需要在 Phase 1c.1 落地后补 mesh 说明

---

## 与 loom design brief 的影响

design brief §5 `/knowledge` 行需要 refresh：

> 之前：`/knowledge` 知识 tree + AI 提议入口
> 现在：`/knowledge` 知识 tree + mesh edges + AI 提议入口（节点 / 边都可被 AI 提议）

design brief §9 open question 已经有 "Knowledge graph 可视化 (force-directed)" 一条——本 ADR 让这条从 open question 升级为**确定需要**，由 designer 提议**何种 graph 形态最适合 < 1000 节点 × 5000 edges 规模**（force-directed / arc diagram / matrix view 等）。

design brief §6 加一条新 C 档 UI 元素：

> §6.5（新）**Edge proposal review**：AI 提议一条 knowledge_edge 时，UI 在 `/knowledge` 或 `/today` proposal inbox 里呈现"建议加 [k_A] —prerequisite→ [k_B]"，用户 accept/dismiss。形态待 grill。
