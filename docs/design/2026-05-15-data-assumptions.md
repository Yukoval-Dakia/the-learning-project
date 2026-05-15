# 数据假设清单 — design / ADR / plan 各自承诺了什么数据底？

> 起源：2026-05-15 brainstorm 发现 `knowledge.base_mastery` 是 stub field——schema 承诺、零 write path。Q1+Q2 audit 揭露一个 pattern：**承诺的接口 vs 缺失的实现**。本文档系统化盘点。
>
> **格式**：每条假设带 (a) 哪个文档承诺了它 (b) 当前数据底实际状态 (c) Phase 1c.1 / 1c.2 / sub-0d 落地后状态 (d) gap 备注。
>
> **目的**：让 design 不再隐含假设未建的数据能力；落地前能 audit 出 gap；跟 designer 沟通时有 grounding。

---

## 状态色

- 🟢 **live**：write path + read path 都 OK
- 🟡 **partial**：部分写或部分读（如 INSERT 但无 UPDATE）
- 🔴 **stub**：定义存在，写路径完全空
- ⏳ **planned**：Phase 1c.1 / sub-0d 计划落地，但当前不存在
- ⚫ **未规划**：连 plan 都没提到

---

## 1. 学习进度 / mastery

### A. `knowledge.base_mastery` / `knowledge.ai_delta_mastery`

| 维度 | 内容 |
|---|---|
| 承诺者 | CONTEXT.md "Dreaming lane: 调整掌握度" / sub-0d plan Step 2.1 `update_ai_delta_mastery` tool / v2.1 brief 隐含（query_knowledge result）|
| 当前 | 🔴 stub —— schema.ts:54-55，仅 INSERT 时初始化为 0（`src/server/knowledge/proposals.ts:267-268`），全代码零 UPDATE |
| 1c.1 后 | 不变（1c.1 只动 mistake → event 迁移，不碰 mastery）|
| sub-0d 后 | ⏳ planned —— sub-0d Step 2.1 `update_ai_delta_mastery` tool 提议建立 write path（dreaming agent 调用）|
| Gap | **base_mastery 没有 write path 任何计划**。`ai_delta` 有但要等 sub-0d。base_mastery 是用户 review hard/again 派生还是 dreaming 计算？ADR 未明 |

### A2. `knowledge.last_active_at` 🆕（audit 新发现）

| 维度 | 内容 |
|---|---|
| 承诺者 | sub-0d Step 13 MaintenanceProposeTask "60d 无访问归档候选"——隐含 last_active_at 在维护 |
| 当前 | 🔴 stub —— schema 字段存在，**全 codebase 零 INSERT、零 UPDATE、零 SELECT** |
| Gap | 谁该写？mistake / review_event 触达 knowledge 时应当 bump last_active_at。当前没人做。又一例"sub-0d 假设但前置未建" |

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

### G. event.subject_kind = 'knowledge_edge'（ADR-0010 扩展）

| 维度 | 内容 |
|---|---|
| 承诺者 | ADR-0010 / v2.1 brief §2.2 |
| 当前 | ⚫ |
| 1c.1 后 | ⏳ planned per 1c.1 refresh banner |
| Gap | 无 |

### H. event.action = 'experimental:tool_use'（v2.1 §1.6 新加）

| 维度 | 内容 |
|---|---|
| 承诺者 | v2.1 brief §1.6 |
| 当前 | ⚫ |
| 1c.1 后 | 部分——event 表存在，experimental:* 命名空间可用，但 tool_use 是 v2.1 design 新提议，**未进 ADR-0006 v2 文本**。要补 ADR-0006 v2 或单开新 ADR |
| Gap | 文档级 gap——v2.1 brief 引入新 action 类型，ADR 还没追认。落地前先补 ADR-0006 v2 修订 |

### I. event.action = 'accept_suggestion' / subject_kind='chip'（v2.1 §1.6 新加）

| 维度 | 内容 |
|---|---|
| 承诺者 | v2.1 brief §1.6.3b（designer 反馈采纳） |
| 当前 | ⚫ |
| Gap | 同 H——ADR 未追认 |

---

## 4. 聚合 / metrics

### J. 跨 mistake/event 的聚合视图

| 维度 | 内容 |
|---|---|
| 承诺者 | v2.1 brief 各处（Today KPI / EventChain summary / Vision rescue cost / mesh edge reasoning）|
| 当前 | 🟡 partial —— `app/api/_/logs/cost/route.ts` 是唯一聚合（cost-by-bucket × task_kind × model）。无 mistake/knowledge/event 维度的 |
| 计划 | ⚫ 任何 plan 都没明确建 |
| Gap | **#2 候选**：`src/server/aggregations/` module 集中所有跨表聚合。是 mastery write、tool-use result、design KPI 三方共用前置 |

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

### O2. 死表（整张表零调用）

**`judgment` 表**——schema 完整定义但全 codebase **零 INSERT / 零 UPDATE / 零 SELECT**：
- 字段：id / answer_id / judge_kind / verdict / appeal_kind / is_effective / ... 11 列
- 推测：是 Sub 1 plan 的 "JudgeTask 独立判分" 预留——但 Sub 1 一直没启动
- 1c.1 后 ADR-0006 v2：判分用 `event(action='judge')` 替代——judgment 表彻底无家
- **决策待**：删 or 等 Sub 1 重启再说

**`artifact` 表**——schema comment 已自标 "TODO(Phase 1c+): 当前零调用"。1c.1 plan Step 9 不删（因 C 档 AI 主动产出激活）。状态：planned to revive。

### P2. mistake 上的死/初始化-only 字段

| 字段 | 类型 | 状态 | Gap |
|---|---|---|---|
| `mistake.variants` jsonb default [] | 🔴 stub | INSERT 写 []，**从无 push**。Sub 5 维护流要"批量生成变式"——promise 没兑现 |
| `mistake.archived_at` / `.archived_reason` / `.delete_reason` | 🔴 stub | soft-delete 三件套全空。表上没有"归档错题"路径 |
| `mistake.status` | 🟡 init-only | INSERT 写 'active'，无 UPDATE。生命周期 transitions 未实现 |
| **Note** | | 1c.1 后 mistake DROP，这些字段全部不存在。**短期忽略**，长期注意 encounter 要不要继承同样的 soft-delete 设计 |

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

## 总览：gaps 排序

按 **会卡多少 design / 多少 plan** 排：

1. **聚合层缺失（#J）** —— v2.1 几乎所有 KPI / tool-use / mesh reasoning 都假设它。**单点 blocker**
2. **events 表未建（#E + #F + #G + #H + #I）** —— Phase 1c.1 灵魂，~3 周工时
3. **mastery / last_active_at 写路径全空（#A + #A2 + #B）** —— sub-0d 假设 mastery 在、last_active_at 在；当前两个都是 stub
4. **死表 / 半死表（#O2 + #P2 + 部分 #Q2 + #R2 + #S2）** —— `judgment` 整张死、mistake 三个 soft-delete 字段死、user_overrode_low_evidence 死、approval_status 流转 UPDATE 缺、learning_item.knowledge_ids UPDATE 缺
5. **agent read tools（#L + #M）** —— sub-0d 范围，但 sub-0d deferred + needs refresh
6. **agent write mirror to events（#O + #P）** —— 1c.1 落地后才能 audit
7. **新 event 类型（tool_use / accept_suggestion）（#H + #I）** —— v2.1 brief 引入但 ADR-0006 v2 未追认

---

## 行动建议（待 grill）

**A. 建聚合 module（#2 候选）**——`src/server/aggregations/`，先做 knowledge-level + event-chain 两组。**做完它，70% gap 闭环**。当下唯一不被 1c.1 / sub-0d block 的工作。

**B. mastery / last_active_at 写路径定权（#1 候选）**

需要 ADR 级决策（**或微 ADR**）回答：
- `base_mastery` 是 user 派生 / dreaming 计算 / 删掉？
- `ai_delta_mastery` 谁更新、何时、按什么信号？
- `last_active_at` 在哪个事件链上 bump？

**C. 死字段 / 死表批量清理**

按 audit 结果逐条决策：
- `judgment` 整张表 → ADR-0006 v2 后 judge 是 event.action，**删表**
- `mistake.variants / archived_at / archived_reason / delete_reason` → 1c.1 后 mistake DROP，**自然消失**
- `completion_evidence.user_overrode_low_evidence` → Phase 1b 流要么实现要么删字段
- `knowledge.approval_status` UPDATE path → 缺，要么实现要么把字段降级为 INSERT-time only

**D. 补 ADR-0006 v2 修订或新 ADR**

v2.1 brief 引入的 `action='experimental:tool_use'` / `action='accept_suggestion'` / `subject_kind='chip'` 进 ADR 文本——否则落地时随手发明，引发设计漂移。

**E. sub-0d refresh + 重新评估"前置依赖"**

sub-0d Step 1.1 `get_weak_points`（mastery）、`get_recent_mistakes`（events 表）—— 全部前置依赖未建。要么 sub-0d 自己建（变大），要么先做 #A + #B 喂数据。

**F. 多 audit follow-up**：

- `judgment` 表是否真有 Sub 1 plan 引用？（如有，决定 keep；如否，删）
- `knowledge.last_active_at` 是否 sub-0d 之外有人引用？
- `mistake.knowledge_ids` GIN 索引存在吗？（影响 §N 是否真能 query "某 knowledge 的所有 mistakes"）

---

## Audit 结论

audit 揭露的 stub 模式不止 mastery 一处——是**系统性**的："schema 留位 / 写路径缺 / design 假设有"。**最危险的是 `judgment` 整张死表**——这意味着 Sub 1 plan 期待落但从来没启动。同样 `mistake.variants` 是 Sub 5 维护流的死 promise。

这两条都不是"局部 bug"，是"plan 没跟上"。建议：

1. 任何 ADR / plan 写新表 / 字段时，**附带 write path location 标注**——否则字段永远 stub
2. 建一个轻量 lint："`schema.ts` 里所有非默认字段，在 codebase 至少 grep 到一处 INSERT 或 UPDATE，否则 fail"——能预防未来漂移
3. 本次 audit 作 baseline，下次 Phase 1c.1 / sub-0d 落地前重跑

---

> Audit 完毕（2026-05-15）。本文档转 final。后续如有新 ADR / plan，建议在 PR 时附上数据假设更新。
