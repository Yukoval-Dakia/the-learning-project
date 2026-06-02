# ADR-0027 — Note/artifact 解耦：从 learning_item 1:1 拥有 → knowledge-labeled 一等实体

**Status**: Accepted (2026-06-03)
**Supersedes**: ADR-0020 §3 的 *ownership* 面（label 模型本身保留）；**reverses** YUK-171 的 `learning_item_primary_artifact_active_unique` 1:1 不变量。
**Part of**: YUK-203（领域模型重构）·P1。**Decision source**: `docs/design/2026-06-03-target-domain-model.md` §2.2/§5/§7.5（多轮讨论 + reviewer 核对 schema 通过）。

---

## 背景

UI 重绘（YUK-169）暴露 note 模型分歧，追溯后确认两条**不同轴**的关系并存：

- **knowledge ↔ note = label**（ADR-0020 §3 原文"label 模型；非 ownership"）：`artifact.knowledge_ids[]`。atomic=1（节点简介，verifier 强制）、hub/long=1..N。这条**保留**。
- **learning_item ↔ note = ownership**：`learning_item.primary_artifact_id` 1:1，**DB 强制唯一**（YUK-171 partial uniqueIndex `learning_item_primary_artifact_active_unique`，schema.ts L237-245）。`artifact` 自身**无** `learning_item_id` 列；owner 由 `resolveOwningLearningItemIds` 反查（block-refs.ts）。`node-page.ts` 只取该节点的**单个** primary atomic（L194-213）。

概念上：atomic（节点简介）、hub（主题入口/子树索引）、long（跨主题综合）**三种 note 都是 knowledge-labeled 的脊柱内容**，没有一种语义上"属于"某个 learning_item。learning_item 是意图/组织层（ADR-0006），应**引用**脊柱、不**拥有**它。当前的 1:1 ownership 是拆解流（`acceptLearningIntent`）顺手建的遗留耦合，导致：note 无法跨项目复用、归档项目会连累 note、一个节点只能显示一篇笔记。

## 决定

1. **note(artifact) 成一等 knowledge-labeled 实体**；`knowledge ↔ note` 维持 label（atomic=1、hub/long=1..N）。UI **按 type 区别呈现**（节点简介 / 主题入口 / 综合长文），不再拍平。
2. **去掉 learning_item 对 note 的 1:1 ownership**：reverse YUK-171 的 `learning_item_primary_artifact_active_unique` 唯一索引。`primary_artifact_id` 列**保留**，语义从"独占 owner"降级为可空的"primary/representative 指针"（不再唯一、不再 DB 强制）。
3. **learning_item 改为引用 note**：项目入口引用其 hub note；学习材料 = label 交集命中的 atomic/long（`notesForItem`）。"可挂载 note"保留（引用），"独占所有权"去掉。
4. **新增 `GET /api/notes/[id]` 读聚合**：一次返回 blocks + labels + verification + versions(history) + backlinks + 相关 learning_items。今天 body-blocks 是 PATCH-only、无单篇读端点。
5. **label 交集列表读**：`notesForKnowledge(kid)` / `notesForItem(item)`；`node-page` 从"单 primary atomic（LIMIT 1）"拓宽到"该节点标签命中的多笔记"，atomic 节点简介仍优先呈现。
6. **`resolveOwningLearningItemIds`** 改为"引用/representative"语义（或退役）；所有依赖 1:1 ownership 的读（node-page、backlinks、learning_intent 创建路径）相应重排。

## 后果

**正面**
- note 跨项目复用；归档 learning_item 不连累 note；一个节点可展多笔记；与设计的一等 NoteReader / `/notes/[id]` 对齐。
- knowledge↔note 的 label 模型（ADR-0020 §3）本就如此，零冲突——本 ADR 只动 ownership 轴。

**代价 / 风险**
- 触 **DB 强制不变量**（YUK-171），不可逆 → **forward-only 迁移**：drop 唯一索引 + 回填/校验现有 primary_artifact_id 数据一致性。
- 重排所有依赖 ownership 的读：`node-page.ts`、`artifacts/block-refs.ts`、`orchestrator/learning_intent.ts` 创建路径、`/api/learning-items/[id]`、`/api/knowledge/[id]`。需配套测试（DB testcontainer）。
- **兼容期**：`primary_artifact_id` 列保留为可空 representative 指针，直到读层全切到 label 交集；期间两路并存但**不再有 DB 唯一约束**。

## 备选（已否决）

- **软对齐**（UI/读层用 label 交集，DB 1:1 不变量暂留）— 否决（决策 #5：走真迁移，避免"DB 说独占、读层说引用"双语义长期并存）。
- **新建独立 `note` 表** — 否决：`artifact` 表已承载 `knowledge_ids` / `body_blocks` / `history` / backlinks（artifact_block_ref）/ note-refine，rename 非必要、迁移成本更高。

## 关联

- 设计稿：`docs/design/2026-06-03-target-domain-model.md`
- ADR-0020（block-tree note；§3 label 模型保留、ownership 面被本 ADR supersede）、ADR-0012（mastery 派生 view，不受影响）、ADR-0006（learning_item = 意图层）
- YUK-171（1:1 不变量，被本 ADR reverse）、YUK-203（umbrella）、YUK-169（UI 重绘）
- 后续：P2 组卷（tool_quiz→question_ids）、P3 FSRS 按知识点（独立 ADR）、迁移 spec（本 ADR 的 forward-only DDL + 读重排清单）
