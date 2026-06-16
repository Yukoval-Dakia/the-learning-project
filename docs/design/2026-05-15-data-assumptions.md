# 数据假设清单 — design / ADR / plan 各自承诺了什么数据底？

> 起源：2026-05-15 brainstorm 发现 `knowledge.base_mastery` 是 stub field——schema 承诺、零 write path。Q1+Q2 audit 揭露一个 pattern：**承诺的接口 vs 缺失的实现**。本文档系统化盘点。
>
> **格式**：每条假设带 (a) 哪个文档承诺了它 (b) 当前数据底实际状态 (c) Phase 1c.1 / 1c.2 / sub-0d 落地后状态 (d) gap 备注。
>
> **目的**：让 design 不再隐含假设未建的数据能力；落地前能 audit 出 gap；跟 designer 沟通时有 grounding。

---

## 📍 状态更新 (2026-05-15 晚)

- **ADR-0011** 落地：tool_use / accept_suggestion / propose|generate|rate × knowledge_edge 五处 event 路径追认。**§H、§I、§G 等改 ⏳ → ✅ ADR'd**（schema 仍待 1c.1 落库）
- **ADR-0012** 落地：mastery / last_active_at 转 derived view，drop 三个 stub 字段。**§A、§A2 改 🔴 stub → ✅ ADR'd derived**（实施在 Phase 1c.1 Step 1）
- **audit follow-up**：`judgment` 整张表 / `mistake.variants` / `mistake.archived_at` 系列 / `completion_evidence.user_overrode_low_evidence` —— **不是死代码，是 Sub 1 / Sub 5 / Phase 1b 的 pending tasks**。grep 验证：
  - `judgment` 在 sub-0a / sub-0b1 / phase-1-pr1 / phase1a-sub5 plans 引用；sub-0d Step 6 JudgeMistakeTask 要写它
  - `mistake.variants` / `variants_generated_count` 在 phase1a-sub5 / sub-0d Step 14 VariantGenTask
  - 这一切都是 ADR-0004 "60% 任务空格"（pre-1c audit 已 flagged）的延伸
- **GIN 索引 audit**：`src/db/schema.ts` 全无 jsonb GIN 索引。但当前**没有代码做"找 knowledge_ids 包含 X 的 mistake"查询**——所有 SELECT 都是单行或全表扫单字段。**GIN 索引非当前 blocker**，但 v2.1 brief §1.6 `query_mistakes(k='...')` 和 mesh edge reasoning 落地时必加；列为 Phase 1c.1 Step 1 prerequisite

---

## 状态色

- 🟢 **live**：write path + read path 都 OK
- 🟡 **partial**：部分写或部分读（如 INSERT 但无 UPDATE）
- 🔴 **stub**：定义存在，写路径完全空
- ⏳ **planned**：Phase 1c.1 / sub-0d 计划落地，但当前不存在
- ⚫ **未规划**：连 plan 都没提到

---

## 1. 学习进度 / mastery

### A. `knowledge.base_mastery` / `knowledge.ai_delta_mastery` ✅ ADR-0012 已决

| 维度 | 内容 |
|---|---|
| 承诺者 | CONTEXT.md "Dreaming lane: 调整掌握度" / sub-0d plan Step 2.1 `update_ai_delta_mastery` tool / v2.1 brief 隐含（query_knowledge result）|
| 当前 | 🔴 stub —— schema.ts:54-55，仅 INSERT 时初始化为 0（`src/server/knowledge/proposals.ts:267-268`），全代码零 UPDATE |
| ADR-0012 决策 | **drop 字段，改 PG view `knowledge_mastery`** 从 events 派生（30d 半衰期 weighted）|
| 1c.1 后 | ✅ derived —— Phase 1c.1 Step 1 同步执行 DROP + 建 view |
| sub-0d refresh | `get_weak_points` 改 `SELECT FROM knowledge_mastery WHERE mastery < 0.4`；`update_ai_delta_mastery` tool 删除（mastery 不再可写）|

### A2. `knowledge.last_active_at` ✅ ADR-0012 已决

| 维度 | 内容 |
|---|---|
| 承诺者 | sub-0d Step 13 MaintenanceProposeTask "60d 无访问归档候选" / architecture.md:329 |
| 当前 | 🔴 stub —— schema 字段存在，全 codebase 零 INSERT/UPDATE/SELECT |
| ADR-0012 决策 | **drop 字段，与 mastery 同一 view** —— `knowledge_mastery.last_active_at = max(events 触及该 knowledge)`，依赖 GIN 索引（见上方状态更新） |
| 1c.1 后 | ✅ derived |

### B. mistake/encounter → knowledge mastery 反向投影

| 维度 | 内容 |
|---|---|
| 承诺者 | ADR-0010 (mesh edge reasoning 引用"近 30 天错答率 78%") / v2.1 brief §1.6 query_knowledge tool result |
| 当前 | 🔴 无 view，无 service。要算"某 knowledge 的错答率"得 `mistake JOIN unnest(knowledge_ids)` 现场聚合 |
| 1c.1 后 | 不变（1c.1 不建聚合）|
| sub-0d 后 | 部分——sub-0d `get_weak_points` (Step 1.1) 提议建一个 `mastery < threshold` 查询，但未明它的数据 source |
| Gap | sub-0d 的"weak point"概念预设 mastery 有真数据。鸡蛋问题：mastery 怎么算 → 要看错答率 → 错答率怎么聚合 → 没建 |

---

## 2. 知识图谱 / mesh

### C. `knowledge_edge` 表

| 维度 | 内容 |
|---|---|
| 承诺者 | ADR-0010 / v2.1 brief §2 |
| 当前 | ⚫ 未存在——schema 无表 |
| 1c.1 后 | ⏳ planned —— 1c.1 Step 1（refresh per ADR-0010）建表 |
| sub-0d 后 | sub-0d 加 `get_node_neighbors` tool (Step 1.1) 消费它 |
| Gap | 表建好后第一份数据从哪来？user 手加？dreaming 提议？需 seeding 策略 |

### D. mesh edge 的 weight / reasoning

| 维度 | 内容 |
|---|---|
| 承诺者 | ADR-0010 schema "weight (0-1)" "reasoning text" / v2.1 brief 各 edge 例 |
| 当前 | ⚫ 未存在 |
| 1c.1 后 | ⏳ planned。但 reasoning 文本如何"用真数据"？AI 写"78% errors"时数据从哪查？|
| Gap | reasoning 当前只有"文本占位"，但 design 例（"近 30 天翻译错答 78% 涉及实词词义不准"）暗示有 aggregation 喂 prompt。这条 aggregation 没建 |

---

## 3. 事件 / events 表

### E. `event` 表（ADR-0006 v2 核心）

| 维度 | 内容 |
|---|---|
| 承诺者 | ADR-0006 v2 / CONTEXT.md "事件 (event)" 词条 / v2.1 brief §1.6 tool-use mirror |
| 当前 | ⚫ 未存在——3 表（mistake / review_event / dreaming_proposal）仍是本相 |
| 1c.1 后 | ⏳ planned —— 1c.1 Step 1 建 event 表（DDL）+ Step 3 三表数据迁移 + Step 9 DROP 旧表 |
| Gap | event 表落地是 1c.1 灵魂。当前 v2.1 brief 全部假设 event 表存在；落地需要 ~3 周工时 |

### F. event chain (`caused_by_event_id`)

| 维度 | 内容 |
|---|---|
| 承诺者 | CONTEXT.md "事件链 (event chaining)" / v2 design EventChain primitive / v2.1 brief §1.1 |
| 当前 | ⚫ |
| 1c.1 后 | ⏳ planned，schema 字段 + writer 写时自动连 |
| Gap | chain 摘要 / 总 cost 聚合（v2.1 §1.5）需另建——chain 本身是 DAG，要计算总 cost 需 traversal |

### G. event.subject_kind = 'knowledge_edge'（ADR-0010 扩展）✅ ADR-0011 已写 schema

| 维度 | 内容 |
|---|---|
| 承诺者 | ADR-0010 / v2.1 brief §2.2 / **ADR-0011** ProposeKnowledgeEdge / GenerateKnowledgeEdge / RateKnowledgeEdge Zod schemas |
| 当前 | ⚫ schema 未落 |
| 1c.1 后 | ⏳ planned per 1c.1 refresh banner + ADR-0011 |

### H. event.action = 'experimental:tool_use'（v2.1 §1.6 新加）✅ ADR-0011 追认

| 维度 | 内容 |
|---|---|
| 承诺者 | v2.1 brief §1.6 / **ADR-0011 §1** ToolUseExperimental Zod schema + stabilization criteria |
| 当前 | ⚫ schema 未落（依赖 events 表）|
| 落地 | Phase 1c.1 Step 2 写 Zod；sub-0d 落地实际 tool_use 路径 |

### I. event.action = 'accept_suggestion' / subject_kind='chip'（v2.1 §1.6 新加）✅ ADR-0011 追认

| 维度 | 内容 |
|---|---|
| 承诺者 | v2.1 brief §1.6.3b / **ADR-0011 §2** AcceptSuggestionChip Zod schema |
| 当前 | ⚫ |
| 落地 | Phase 1c.1 Step 2 写 Zod；sub-0d 写 chip→tool_use 触发链 |

---

## 4. 聚合 / metrics

### J. 跨 mistake/event 的聚合视图

| 维度 | 内容 |
|---|---|
| 承诺者 | v2.1 brief 各处（Today KPI / EventChain summary / Vision rescue cost / mesh edge reasoning）|
| 当前 | 🟡 partial —— `app/api/_/logs/cost/route.ts` 是唯一聚合（cost-by-bucket × task_kind × model）。无 mistake/knowledge/event 维度的 |
| 决策 | **#2 推到 Phase 1c.1 落地后做**——mistake 表即将 DROP，建在它上是浪费；events 表落地后统一建 `src/server/aggregations/` |
| 部分 | `knowledge_mastery` view（ADR-0012）落地后是第一个跨 event 聚合；其他（chain cost / cost-by-actor）跟随 |

### K. cost-by-actor / cost-by-day（v2 CostRibbon 用）

| 维度 | 内容 |
|---|---|
| 承诺者 | v2 design CostRibbon / v2.1 brief §1.4 Vision rescue meta-row |
| 当前 | 🟡 cost_ledger 表写入 OK，aggregation 部分（cost-by-bucket × task_kind × model 已有，cost-by-actor 部分） |
| Gap | actor 维度的 cost 聚合（"今天 dreaming agent 跑了多少钱"）当前要 sum WHERE task_kind='dreaming' —— 假设 task_kind 是 actor 代理，实际未必 |

---

## 5. 读路径（agent 读数据的方式）

### L. agent 读 knowledge tree

| 维度 | 内容 |
|---|---|
| 承诺者（现状） | `loadTreeSnapshot()` 整棵预加载 进 prompt |
| 承诺者（v2.1） | tool-call 形态：`query_knowledge` tool 按需查（v2.1 brief §1.6）|
| 当前 | 🟢 snapshot 路径 live；🔴 tool-call 路径 未存在 |
| sub-0d 后 | ⏳ planned —— sub-0d Step 1.1 加 `get_knowledge_node` / `search_knowledge_by_concept` 等 read tools |
| Gap | 切换策略未明：snapshot vs tool-call 同时存在还是逐步替换？sub-0d 未说 |

### M. agent 读 mistake 列表

| 维度 | 内容 |
|---|---|
| 承诺者 | sub-0d Step 1.1 `find_similar_mistakes` / `get_recent_mistakes` |
| 当前 | 🔴 无 tool；agent 拿 mistake 是否预 prompt 整批？要 audit |
| Gap | 1c.1 后 mistake → event；read tool 要按 event subject_kind='question' 重写 |

### N. AI 看到 mistake-knowledge 关联（mistake.knowledge_ids[]）

| 维度 | 内容 |
|---|---|
| 承诺者 | sub-0d Step 1.1 `link_mistake_to_node`（write side）|
| 当前 | 🟡 INSERT 时写入（attribution agent 现存），read path 充分？要 audit |
| Gap | "查某 knowledge 的所有挂载 mistake"需 jsonb GIN 索引——schema 有没有？|

---

## 6. 写路径（agent 写数据的方式）

### O. AI agent 写 mistake 时是否 mirror 进 events 表

| 维度 | 内容 |
|---|---|
| 承诺者 | ADR-0006 v2 "AI first-class actor" / CONTEXT.md "事件" 词条 |
| 当前 | ⚫ events 表不存在，所以谈不上 mirror |
| 1c.1 后 | ⏳ planned —— 1c.1 Step 3 数据迁移把已有 mistake 转 event；Step 4 server rename 让新 write path 直接写 event |
| Gap | 但 **AI 现在写 knowledge** 时（attribution propose new node, dreaming propose）是否 mirror？1c.1 后才统一 |

### P. `dreaming_proposal` write path

| 维度 | 内容 |
|---|---|
| 承诺者 | sub-0d plan Step 3 / CONTEXT.md "梦境流"|
| 当前 | 🟡 表存在；handler `knowledge_propose_nightly` 写 knowledge（不写 dreaming_proposal？要 audit）|
| 1c.1 后 | 表 DROP，迁移进 events `action='propose'` |
| Gap | "dreaming agent 主动产 proposal" 当前如何承载？要看 audit |

---

## 6.5 Audit 新发现的 stub / dead fields 🆕

### O2. 死表（整张表零调用）—— **修正：不是死代码，是 Sub 1 pending**

**`judgment` 表**——audit follow-up 验证：

- grep `docs/superpowers/` 显示 `judgment` 在 sub-0a / sub-0b1 / phase1-pr1 / phase1a-sub5 plan 都引用；**sub-0d Step 6 JudgeMistakeTask 明确要写它**
- Sub 0c handoffs spec L51 / L79 / L96 列 JudgeTask 为 Sub 1 范围（pending）
- 所以**不是死代码，是 ADR-0004 60% 任务空格之一**（pre-1c audit 2026-05-14 已 flagged）
- 1c.1 后 ADR-0006 v2：判分会改成 `event(action='judge')`；**判分表本身在 1c.1 落地后应当被合并 / DROP**
- **决策**：1c.1 时 DROP（与 mistake / review_event 一起），Sub 1 启动时按 event-action 路径建，不再用独立 judgment 表

**`artifact` 表**——同上路径。schema comment 已标 zero usage，1c.1 plan Step 9 不删（因 C 档 AI 主动产出激活——ADR-0006 v2）。状态：planned to revive (ADR-0006 v2 GenerateArtifact)。

**`artifact` 表**——schema comment 已自标 "TODO(Phase 1c+): 当前零调用"。1c.1 plan Step 9 不删（因 C 档 AI 主动产出激活）。状态：planned to revive。

### P2. mistake 上的死/初始化-only 字段 —— **修正：sub-0d / Sub 5 pending**

| 字段 | 类型 | 状态 | 修正后判断 |
|---|---|---|---|
| `mistake.variants` jsonb default [] | 🔴 → ⏳ | sub-0d Step 14 VariantGenTask 要写它；phase1a-sub5 / sub-0a 引用 `variants_generated_count`。**不是死字段，是 Sub 5 维护流的 pending implementation** |
| `mistake.archived_at` / `.archived_reason` / `.delete_reason` | 🔴 stub | soft-delete 真的没人写。1c.1 后 mistake DROP，自然消失。**短期忽略**，但 events 表 / `material_fsrs_state` 投影是否要 archived_at？ADR-0006 v2 未明 |
| `mistake.status` | 🟡 init-only | INSERT 写 'active'，无 UPDATE。**生命周期 transitions 未实现是 ADR-0004 Phase 2 promise**（maintenance lane 应当转 'resting' / 'archived'）|
| **Note** | | 1c.1 后 mistake DROP；所有这些都迁移到 event-driven 模型，由 event 流派生 status / variants_count |

### Q2. completion_evidence

| 字段 | 状态 | Gap |
|---|---|---|
| `user_overrode_low_evidence` boolean | 🔴 stub | INSERT 永远 false；无 path 设 true。Phase 1b "用户强制完成低证据 learning_item" 流未实现 |
| `evidence_json` jsonb / `decided_at` | 🟡 init-only | INSERT 写完不动 |

### R2. knowledge 上的初始化-only

| 字段 | 状态 | 期望行为 vs 现实 |
|---|---|---|
| `knowledge.domain` | 🟡 init-only | 设计上是"派生自 parent chain"（effective_domain），但字段自己只 INSERT 写。OK——derived 用 parent_id 现算 |
| `knowledge.approval_status` | 🟡 init-only | 期望 admin 流转 pending→approved，**UPDATE path 缺失** |
| `knowledge.proposed_by_ai` | 🟡 init-only | INSERT 一次性标，OK |
| `knowledge.merged_from` | 🟡 init-only | merge 操作走 archive 路径（applyArchive at proposals.ts:327），merged_from 只 INSERT 时写。**merge 后 from→to 标记可能漏更新**——audit 嫌疑点 |

### S2. learning_item.knowledge_ids 🟡 init-only

INSERT 写一次（learning-items/route.ts:76），**无 UPDATE path**。如果 AI 后续要追加 knowledge 关联（attribution agent 发现新挂点），当前不能改。Sub 0d / 1c.1 落 attribution 时要建。

---

## 7. UI 数据 fetch（design 假设的）

### Q. v2 Today KPI（FSRS 到期 / 归因中 / 学习项 active / AI 提议 pending）

| 维度 | 内容 |
|---|---|
| 承诺者 | v2.1 brief §1.3 |
| 当前 | 🟢 FSRS due query 存在 (`app/api/review/due/route.ts`); 🟡 "归因中"未明确（attribution 是同步 task，没"中间状态"概念）; 🟢 learning_item active 可查; 🟡 "AI 提议 pending" → dreaming_proposal.status='pending' 可查 |
| Gap | "归因中" KPI 假设 attribution 是异步且有 in_progress 状态——当前是同步。这条 KPI 落地前要决策 attribution 是否异步化 |

### R. v2 EventChain primitive 在 /mistakes 卡片渲染

| 维度 | 内容 |
|---|---|
| 承诺者 | v2 design + v2.1 brief §1.1 |
| 当前 | ⚫ events 表不存在 |
| 1c.1 后 | ⏳ planned |
| Gap | chain traversal API（"给我这个 event 的所有 caused_by 上游"）需建 |

---

## 总览：gaps 排序（修订 — ADR-0011/0012 落地后）

按 **会卡多少 design / 多少 plan** 排：

1. **events 表未建（#E + #F + #G + #H + #I + #O + #P）** —— Phase 1c.1 灵魂；所有 mastery / mesh / tool-use 路径都 stake 在它上。⭐ **下一步主战场**
2. **聚合层（#J）+ GIN 索引** —— 等 events 表落定后跟随建。`knowledge_mastery` view (ADR-0012) 是第一个；query_mistakes / chain_cost 等跟随
3. ~~mastery / last_active_at（#A + #A2）~~ → ✅ ADR-0012 已决策为 derived view，落 1c.1 Step 1
4. ~~新 event 类型（tool_use / accept_suggestion / mesh edges）~~ → ✅ ADR-0011 已追认 Zod schema，落 1c.1 Step 2
5. **sub-0d refresh**（#L + #M）—— 1c.1 落地后启动；`update_ai_delta_mastery` tool 删（per ADR-0012），`get_weak_points` 改 view 查询
6. **死表 / pending 字段** —— audit 修正后明确：
   - `judgment` 表：1c.1 同步 DROP（合并进 event action='judge'）
   - `mistake.variants` etc：Sub 5/Sub 0d pending，1c.1 DROP 后由 event 派生
   - `completion_evidence.user_overrode_low_evidence`：Phase 1b 流要决定实现 or 删 schema
   - `knowledge.approval_status` UPDATE path：要么实现 admin 流（用户级权限决策），要么字段降级为 INSERT-only
7. **C 档 maintenance lifecycle transitions**（mistake.status / learning_item lifecycle）—— ADR-0004 Phase 2 promise，待 sub-0d Step 13 落

---

## 行动建议（落地状态 — 2026-05-15 晚）

**✅ A. 死字段 → ADR-0012 已决（derived view）+ Phase 1c.1 Step 1 落地**

**✅ B. ADR 追认 → ADR-0011 已写**

**⏭️ C. 聚合 module 推到 1c.1 落地后做**——`src/server/aggregations/` 等 events 表落地统一建。当前唯一可做的轻量聚合是 `knowledge_mastery` view（ADR-0012）含在 1c.1 Step 1

**⏭️ D. Phase 1c.1 启动**——本次 brainstorm 终点。事件表 + mesh + DROP 死字段 + 建 view + UI 脚手架。20-27d 工时

**⏳ E. 1c.1 落地后：sub-0d refresh + 启动**

sub-0d 改造点（per ADR-0011 / 0012）：
- Step 1.1 `get_weak_points` 改 `SELECT FROM knowledge_mastery WHERE mastery < 0.4`
- Step 1.1 `get_recent_mistakes` 改 `event WHERE action='attempt' AND outcome='failure'` 视图
- Step 2.1 `update_ai_delta_mastery` 删除（mastery 不再可写，per ADR-0012）
- Step 6 JudgeMistakeTask → JudgeEventTask，写 `event(action='judge', subject_kind='event')`
- Step 14 VariantGenTask → 写 `event(action='generate', subject_kind='artifact')` per ADR-0006 v2

**⏳ F. Sub 1 (Judge / Variant gen) 接 Sub 0d 后**

**⏳ G. 数据假设清单 maintenance** —— 任何 ADR / plan 写新表 / 字段时附 write path 标注；建议建轻量 lint："schema 字段必须 grep 到 ≥1 处 write，否则 fail"——防止 1c.1 之后再撞同样问题。本 lint 不阻塞 1c.1，可作 Phase 1c.1 收尾任务

---

## 已完成的 Audit follow-up（2026-05-15 晚）

| 问题 | 结论 |
|---|---|
| `judgment` 是否真有 Sub 1 plan 引用？ | ✅ 是。sub-0a / sub-0b1 / phase1-pr1 / phase1a-sub5 / sub-0d Step 6 都引用。但 ADR-0006 v2 后判分是 event action—— **judgment 表 1c.1 DROP** |
| `knowledge.last_active_at` 是否 sub-0d 之外引用？ | ✅ architecture.md:329 / sub-0d Step 13 / spec architecture-review 都用。ADR-0012 决策 derived，drop 字段 |
| `mistake.knowledge_ids` GIN 索引？ | ❌ schema.ts 全无 jsonb GIN 索引。但当前**没有 query 需要它**（所有 SELECT 单行/全表扫单字段）。落地 §1.6 `query_mistakes(k=...)` / mesh reasoning 时必加—— Phase 1c.1 Step 1 prerequisite |
| `mistake.variants` Sub 5 真要写吗？ | ✅ sub-0d Step 14 VariantGenTask。但 1c.1 后 mistake → event，variants 改为 `event(action='generate', subject_kind='artifact')` 表达 |

---

## Audit 结论

audit 揭露的 stub 模式不止 mastery 一处——是**系统性**的："schema 留位 / 写路径缺 / design 假设有"。**最危险的是 `judgment` 整张死表**——这意味着 Sub 1 plan 期待落但从来没启动。同样 `mistake.variants` 是 Sub 5 维护流的死 promise。

这两条都不是"局部 bug"，是"plan 没跟上"。建议：

1. 任何 ADR / plan 写新表 / 字段时，**附带 write path location 标注**——否则字段永远 stub
2. 建一个轻量 lint："`schema.ts` 里所有非默认字段，在 codebase 至少 grep 到一处 INSERT 或 UPDATE，否则 fail"——能预防未来漂移
3. 本次 audit 作 baseline，下次 Phase 1c.1 / sub-0d 落地前重跑

---

> Audit 完毕（2026-05-15）。本文档转 final。后续如有新 ADR / plan，建议在 PR 时附上数据假设更新。

---

## 附录 · 合成 seed 与真实 ingest 数据的分层定位（2026-06-05 · Strategy D · YUK-214）

随真实 ingest 数据飞轮（ingest → 做题 → FSRS 信号 → Coach/brief 吃真实证据）打通，
明确合成数据与真实数据的职责边界，避免误把合成 seed 当作可被真实数据"替代/退役"
的运行时信号源：

- **`scripts/seed-synthetic.ts` + `tests/**/layer8_e2e.db.test.ts` 的合成数据 = 仅作
  测试 harness / 确定性 regression guard。** 它制造一段因果链完整、时间分布合理的事件
  历史，让 FSRS / proposal / detection 切片在 **本地 dev DB** 或测试里可观测、可断言。
  合成事件全部带 `payload.__synthetic = true`，合成知识节点用 `synthetic:` id 前缀，
  按确定性 id 幂等。
- **真实 ingest 数据替代的是「生产运行时信号源」**——FSRS / Dreaming / Coach brief
  在 prod 实际消费的真实证据。这是与合成 seed **正交的另一层**，不是同一职责的两种
  实现。
- **二者不互相替代：**
  - 合成 seed **不退役**。真实数据进来后，测试 / regression 仍用确定性合成数据——它更
    稳，不随真实数据漂移；用真实 fixture 做 regression 会引入数据漂移与不可复现失败。
  - 真实数据进来后**也不**把测试迁到真实 fixture。"真实数据驱动 prod 信号" 与 "合成数据
    驱动测试断言" 是两条永久并存的轨道。

> 落点依据：本文档已是项目数据假设的单一出处（§格式 / §目的），故合成-vs-真实 的分层
> 定位写在此处而非散落 plan。详见 `docs/superpowers/plans/2026-06-05-strategy-d-s1-ingest-practice-bridge.md` §7 Step 7。

## 附录 · `question.draft_status` 的 NULL≡active 三态契约（2026-06-16 · YUK-350）

`question.draft_status` 是三态字段，且 **NULL 被语义化为 active**：

| 值        | 语义                              | 进通用练习池？ |
| --------- | --------------------------------- | -------------- |
| `'draft'` | 未验证 / 容器内专用，不可进池     | **否**         |
| `'active'`| 已验证 / 已晋升的池题             | 是             |
| `NULL`    | **隐式 active**（合法 active 题） | 是             |

**风险（红线 4）**：一条新插入的 question 若**不显式** set `draft_status`，它就是 `NULL`，被
整个 review 池当 active 收。容器内专用题（embedded check / teaching check——只该被它的
artifact 容器 / teaching session 读，不该当独立池题）若漏 set `draft_status`，会**静默漏进
通用练习池**。所有池选择路径用 `draft_status IS NULL OR <> 'draft'` 排除 draft（`due-list`、
`variant-rotation`、`review-session`、`sourcing-sequence`、`fewshot-retrieve`）；容器读路径
（`note-page` 的 `inArray(question.id, ids)`、`getActiveQuestionState` 的 source+session_id）
**不**带 draft filter，所以 draft 容器题仍能被它的容器解析——这是「双面契约」：容器可读、池不选。

**审计契约**：`pnpm audit:draft-status`（`scripts/audit-draft-status.ts`）扫所有
`.insert(question).values({ ... })` 站点，要求每个要么显式携带 `draft_status` key，要么在
`scripts/audit-draft-status-allowlist.json` 声明 `reason` + `resolves_when{kind,ref,expected_by}`。
NULL≡active 是合法语义的 writer（`auto-enroll` / `import` / 错题 `mistakes` / 卷题 `parts`——
它们本就是 active 池题）进 allowlist；容器题（`embedded_check_generate` / `materialize-ask-check`）
YUK-350 起显式 set `draft_status:'draft'`，同时保留在 allowlist 作 harmless-redundant 的
chain-merge guard——审计对 **allowlisted-AND-explicit** 文件静默通过（不 hard-fail）。新增 question
INSERT 时：要么显式 set `draft_status`，要么加 allowlist 并标注可检查的解除条件。

> 这是 schema 层 `pnpm audit:schema`（字段是否有 write path）之外的**值层**漂移 lint：
> 字段有 write path ≠ 每个 INSERT 都填了正确的值。
