# ADR-0020 — Note artifact 重塑：block tree + Notion-like 编辑 + Living Note mutator-mode

**Status**: accepted
**Date**: 2026-05-26
**Supersedes**: [ADR-0019](0019-correction-event-artifact-section-subject.md)
**Related**: [ADR-0006 v2](0006-encounter-replaces-mistake.md) (event-driven core), [ADR-0010](0010-knowledge-mesh.md) (knowledge mesh), [ADR-0012](0012-mastery-as-derived-view.md) (mastery from events), [ADR-0014](0014-generalized-activity-and-capability-registry.md) §6 (correction event), [YUK-88](https://linear.app/yukoval-studios/issue/YUK-88), [YUK-89](https://linear.app/yukoval-studios/issue/YUK-89)

> **Spec doc**: [docs/planning/2026-05-26-note-rich-doc.md §0](../planning/2026-05-26-note-rich-doc.md) 是本 ADR 的扩展实施方案与 phase 表；本 ADR 锁核心契约。

## Context

ADR-0019（2026-05-26 同日 accepted）刚把 correction event 扩到 `subject_kind='artifact'` + 引入 `section_id` anchor 给 atomic note mark-wrong 用。

YUK-85 Sub 3 (PR #154) smoke session 用户反馈：

> 对于末端节点，atomic 这么做确实是好的。但比如氧化还原反应这个大类，可读性很差，信息量太少。大部分中大型知识点都适合参考 Notion 这些笔记软件，允许挂 label / 有 link / 有层级。

2026-05-26 grill-with-docs 全量 grill 后路径升级：

- **note 编辑必须 day1 ship**（用户强约束，不允许"v0 read-only"）
- **atomic 5-section 物理结构对中大型主题信息量稀薄**，需要 block tree 灵活性
- **knowledge tree 升级为 graph (mesh)**（ADR-0010 已 ship knowledge_edge）→ "叶子节点"概念在 mesh 视角下退场
- **cross_link 跨笔记** 是核心诉求（Notion-like）—— `knowledge_edge` 表达概念关系，不该混进 note 文档级 ref
- **Living Note 必须 day1 ship**（AI 不能是看客），AI 直接 mutate 同一 body_blocks → 引入并发协调
- **AI agent 不依赖 block lineage 字段**：event log（ADR-0006 v2）是 superset，supersedes / derived_from 是 over-engineered

ADR-0019 的 `section_id` anchor + atomic.sections[] schema 在 Y 路径下整体失效，需新 ADR 接管。

## Decision

采纳 **Y 路径**（原 §3.C 复活但收敛）：atomic 也变 block tree，三态共用 schema field，旧 `sections[]` / `outline_json` / `child_artifact_ids[]` 全 DROP。本 ADR 锁核心架构契约；具体 TipTap PM node schema 在 P2 实现后补 ADR-0021。

### 1. Artifact 三态共用 `body_blocks JSONB`

```
artifact.type ∈ { note_hub, note_atomic, note_long, tool_quiz, tool_<future> }
```

三 note type **共用** `body_blocks JSONB` field，差异仅在：

- **AI prompt**（NoteGenerateTask 内 `type` 参数 switch）
- **verifier 约束**：atomic 必须 5 个 `semantic_kind ∈ {definition, mechanism, example, pitfall, check}` 至少各出现 1 次；hub 必须 ≥ 3 个 `cross_link` block；long 无约束
- **渲染 idiom**（按 `block.attrs.semantic_kind` + `type` 分支）

### 2. block_id 稳定性 + Notion 位置规则

- block id 是稳定 UUID（生命周期内不变）
- **Split**（用户在 paragraph 中间按 Enter）：**原 id 跟"上半"**，下半全新 id
- **Split implementation rule**：P0 TipTap spike 确认必须用显式 command wrapper 固化上述 id 策略；不得依赖 generic ProseMirror split 默认行为隐式保 id。
- **Merge**（开头按 Backspace 合并到上块）：**前 block id 保留**，后 block id 丢弃
- **In-place edit**（改文本 / 加 mark）：id 不变
- **删除 block**：annotation 与该 block 一起丢失（accepted tradeoff，与 Notion 一致）
- **无 `supersedes` / `derived_from` / `lineage` 字段**：因果由 event log 承载（ADR-0006 v2），block 不存 provenance

### 3. Knowledge ↔ Artifact = label 模型

```ts
artifact.knowledge_ids: text[]   // plural, label 模型；非 ownership
```

- artifact 必须挂 ≥ 1 个 knowledge_id（如果用户当下没有合适 knowledge → 走 propose_knowledge → accept → bind 路径）
- atomic 的 knowledge_ids 数组长度 = 1（verifier 强制；"节点简介"语义）
- long 的 knowledge_ids 可 1 或 N（跨主题合成）
- hub 的 knowledge_ids 可 1 或 N（主题入口）
- atomic 1:1 节点但**不限节点位置**（叶子 / 中层都可）—— mesh 视角下叶子概念已 obsolete

### 4. mark-wrong anchor = `block_id`

- correction event payload `section_id?: string` → `block_id?: string`（schema rewrite，无数据 backfill）
- mark-wrong UI 默认聚合到 `nearest_semantic_kind_ancestor` 或 heading 级展示，可钻取到具体 block
- 实施细节见 spec doc §0.2 Q10.a

### 5. Cross_link 物理形态（L3+L2 索引混合）

- **L3（source of truth）**：block 内 `attrs.cross_link = { artifact_id, block_id? }`（TipTap inline atom node 或 block node）
- **L2（反链索引）**：`artifact_block_ref` 表 write-through：

```sql
CREATE TABLE artifact_block_ref (
  from_artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  from_block_id TEXT NOT NULL,
  to_artifact_id TEXT NOT NULL REFERENCES artifact(id),
  to_block_id TEXT,
  PRIMARY KEY (from_artifact_id, from_block_id, to_artifact_id, COALESCE(to_block_id, ''))
);
CREATE INDEX artifact_block_ref_to_idx ON artifact_block_ref (to_artifact_id, to_block_id);
```

- artifact 写路径同步扫 body_blocks 抽 cross_link → upsert 索引表
- 反链查询走索引表 O(log N)
- **`knowledge_edge` 留作概念关系**（prerequisite / contrasts_with / ...），不与 note ref 混

### 6. Embedded check (quiz inline)

- 独立 `tool_quiz` artifact
- atomic body_blocks 内一个 `{ type: 'artifact_ref', target: { artifact_id, kind: 'tool_quiz' } }` block，inline render
- 删除 atomic 不 cascade 删 quiz（quiz 独立可被多 atomic 引用 / standalone 复用）
- quiz 与 atomic 无 parent-child；knowledge_ids 各自独立维护

### 7. LearningIntent orchestrator 产出契约

- 输出：1 hub + N atomic + 0-M long
- atomic 不再强制叶子，AI 可挂中层（需 justify）；prompt 软引导叶子优先
- propose_knowledge + propose_artifact 一次性 accept（保留现存 plan-C 流程）
- 单 `NoteGenerateTask` + `type` 参数 switch（atomic / long / hub 共用 handler 框架）

### 8. Living Note v0 = mutator-mode + idle 协调 + undo

- day1 ship 全 atomic + long + hub
- **mutator-mode**（小 patch：block 级 `insert_after` / `replace_block` 等 op）：AI 直接 apply 到 body_blocks
- **propose-mode**（激进：用户主动 "regenerate" / mastery 升触发自动生成新 long）：用户必须 accept 后才 apply
- **不做 v1 → v2 整篇重写**：所有 mutation 都是 block 级增量 patch；"regenerate" 按钮路由到 propose 多 patch（不 wipe）
- **并发协调**（用户编辑 vs AI mutator）：客户端 presence heartbeat；server `note_refine` worker 写入前查 editing_session，idle 时 flush AI patch；editing 中 deferred；超时（10min）强行 apply
- **Undo**：每次 apply 落 event；用户 always 可 undo（per-block + 集中 view 批量）
- **集中入口**：`/today` 加 "Living Note 活动卡"（24h digest + 批量 undo）+ artifact 页内 "AI 改动" tab（本 note timeline）

### 9. Hub auto-sync 双区机制

- hub.body_blocks 内"手动区"（用户写）+"自动区"（系统填）；自动区在手动区**之后**
- 自动区是 `AutoLinksContainer` block group：用户可重排顺序，但不可增删 children
- **nightly worker**（与 `knowledge_edge_propose_nightly` 同时段 02:30 BJT）维护：scan hub + 挂同主题 atomic 不在 auto-zone 的差集 → upsert
- **包含判定（iii-curated）**：
  1. `atomic.knowledge_ids ⊆ hub.knowledge_ids`（字面集合包含）
  2. atomic 挂的节点是 hub 任一 knowledge_id 的 **tree descendant**
  3. mesh 关系命中：`prerequisite` incoming / `derived_from` outgoing / `contrasts_with` symmetric
  4. **不包含** `related_to` / `applied_in` / `experimental:*`（前两个 future per-hub opt-in）
- **dismiss**：用户可隐藏自动区某条 → 落 `artifact.attrs.suppressed_block_refs: [{artifact_id}, ...]`；nightly 重填时跳过；产 event `event(action='suppress', subject='artifact', payload)`
- **chip 视觉**：每条 auto-link 显示 relation chip（"via prerequisite" / "via 派生" / "via 对比" / "via 子主题"），hover 出现 dismiss 按钮

### 10. Knowledge node 节点页（`/knowledge/[id]`）

- 分层视图：节点元数据 + mastery + mesh 邻居 chip → 主 atomic body_blocks **inline 渲染** → "出现在 N 个 hub / M 个 long" 反链 panel → 最近活动 timeline
- 无主 atomic 时占位卡 + 一键生成（触发 NoteGenerateTask）
- **节点页 = 视图职能**（query 聚合不存盘），**hub = 作品职能**（artifact 实体），两者不重叠；day1 不做 D graph 视图（roadmap phase 2+）

### 11. 编辑器选型

- **TipTap**（ProseMirror wrapper），React-first，headless
- `body_blocks` JSONB = TipTap doc.toJSON() 形态（PM `{type, content[], attrs, marks[]}`，非 Codex 原建议的 `{id, type, children, attrs}`）
- 阅读视图独立 `<BlockTreeRenderer>` SSR-only，共享 NodeView 组件、**不加载 editor bundle**
- day1 ship：完整 Notion-like（text edit / split / merge / drag-drop / paste markdown / undo-redo / inline marks / slash command / block cross_link / mention 输入）
- 具体 PM node schema（SemanticBlock / CrossLinkBlock / ArtifactRefBlock / CalloutBlock / AutoLinksContainer）在 P2 实现后补 **ADR-0021**；本 ADR 不锁

### 12. archived_at 字段语义

- 字段保留作 future auto-archive maintenance agent 槽位
- day1 不做新 UI 入口（既不"用户手动归档"也不"v1/v2 切换"）

## Consequences

### Schema 变更（详见 spec doc §0.3）

```sql
ALTER TABLE artifact DROP COLUMN sections;
ALTER TABLE artifact DROP COLUMN outline_json;
ALTER TABLE artifact DROP COLUMN child_artifact_ids;
ALTER TABLE artifact DROP COLUMN knowledge_id;
ALTER TABLE artifact ADD COLUMN body_blocks JSONB;
ALTER TABLE artifact ADD COLUMN knowledge_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE artifact ADD COLUMN attrs JSONB NOT NULL DEFAULT '{}'::jsonb;
-- 若 attrs 已存在则复用

CREATE TABLE artifact_block_ref (...);
CREATE INDEX artifact_block_ref_to_idx ON artifact_block_ref (to_artifact_id, to_block_id);
CREATE INDEX event_referenced_knowledge_gin
  ON event USING GIN ((payload -> 'referenced_knowledge_ids'));

-- src/core/schema/event/known.ts CorrectArtifactEvent.payload.section_id → block_id
```

**无数据 backfill**：当前项目无生产 artifact 数据；migration 任务退化为 tests rework（P7）。

### 受影响的 ADR

- **ADR-0019 被本 ADR superseded**（section_id 整体废止）
- **ADR-0006 v2 不动**：event log 仍是真相，本 ADR 只改 event payload 字段名
- **ADR-0010 不动**：knowledge_edge 留作概念关系；本 ADR 引用 mesh edge 做 hub auto-sync iii-curated 判定
- **ADR-0012 不动**：mastery 仍从 question events 派生；artifact.knowledge_ids 是 label 不进 mastery 投影
- **ADR-0014 §6 不动**：correction event 抽象保留；只是 payload 字段重命名
- **ADR-0021（pending，P2 后补）**：TipTap PM node schema 具体形态

### 工程量

~61 pts / 17-20 周 elapsed（单人）。8 phase（P0 Spike → P7 tests），phase 滚动落 PR，每个 PR 进 staging 即时验。详见 spec doc §0.5。

### 风险

- **P2 编辑器 16pt 是估算上限**：TipTap 接入复杂度未亲手验过；P0 spike 跑通 fixture 后收敛到 ±15% 内
- **P3 + P4 并行 schema 撞**：ADR-0021 锁 PM node schema 后才可并行
- **Living Note mutator-mode 用户感知**：AI 在 idle 期间改 note，用户回来发现变化 —— 必须保证 `/today` 活动卡 + 单条 undo 始终好用，否则用户会失去对 Living Note 的信任
- **TipTap bundle 120kb gzip**：阅读视图必须 SSR-only `<BlockTreeRenderer>`，editor lazy load

## Alternatives considered

### A. 增量 B-path（保留 atomic 5-section，引入 note_long 第三态）

原 plan（spec doc §3.B）。被 grill 否决，理由：

- 用户明确"note 编辑 day1 ship" → atomic 5-section 不可编辑（YUK-54 in-place edit 限于 section.body 字符串，不能 split / merge / 加 callout）→ 与"day1 编辑"约束冲突
- atomic 5-section 对中大型主题信息量稀薄是核心病灶；B-path 没解决
- B-path 与 Y-path 的工程量差距小（B ~30pt vs Y ~61pt），但 Y 把 atomic 也升级到 block tree 体感差别大

### B. C-path（完全 Notion，单一 `note` type 废区分）

被 Q6 否决：

- AI prompt 失去 "atomic / long / hub" hint → 输出风格漂移
- LearningIntent orchestrator 的 "1 hub + N atomic" 路由逻辑要全 rework
- 视觉 idiom 失去 type 分支

Y 是 B 与 C 的折中：schema 层等价 C（共用 body_blocks），type 层等价 B（保 atomic / long / hub）。

### C. lineage 字段（supersedes / derived_from）

被 Q14 否决：Notion 5 年生产数据验证不需要；event log 是 superset，agent 通过 events 而非 block lineage 推理因果；schema 简洁性优先。

### D. Living Note v0 propose-only（不 mutator）

被 Q16 否决：A3+B3 day1 ship 后 propose-only 让 AI 沦为看客，与"AI first-class equal actor"项目精神冲突。改为 mutator + idle 协调 + always undoable + 集中 digest 入口。

## Notes

- 本 ADR 文档化的是 2026-05-26 grill-with-docs session 全量决策；session log 形态保存在 git history（PR #155 + 后续修订）
- ADR-0019 仅 2026-05-26 当日 accepted → 2026-05-26 superseded by ADR-0020；属同日修订，无 ship 路径回退成本
- 与 docs/modules/notes.md §5 "Note 是活的" 5 触发器列表的关系：本 ADR 不锁触发信号映射（P4 实施时定，见 spec doc §0.6 Open）；只锁 Living Note 的 mutator vs propose 分级框架
