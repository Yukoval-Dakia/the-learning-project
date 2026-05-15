# Loom · Design Brief v2.1 — 在 v2 基础上 refine + 加 mesh

> **For Claude Design**: this is an **iteration**, not a redo. v2 (`docs/design/loom-design-v2/`) 已经是高质量的 event-driven 基础——保留 95%。本 brief 列出 **5 处精细化** + **1 个大补：knowledge mesh (ADR-0010)**。
>
> v2 落到 `docs/design/loom-design-v2/`；本轮请把 refined version 落到 `docs/design/loom-design-v2.1/`（同 repo），diff-style 修改，不重画整套。

---

## 0. v2 哪里 nail 了（保留，不动）

读 `docs/design/loom-design-v2/README.md` 看自陈。要保留：

- **6 路由 + Copilot drawer** 的结构
- **新 Primitives**：`<ActorBadge>` / `<EventChain>` / `<ProposalCard>` / `<CopilotDrawer>` / `<CostRibbon>` / `<Lane>`
- **SEED 事件数据** in `data.jsx`（caused_by chain / task_run_id / cost_micro_usd / actor_kind × action × subject_kind 三轴 mirror ADR-0006 v2）
- **审美 / voice / tokens** 全部 lift 自 v1 loom + 我增的 `--info` for AI actor tone
- **§9 open questions 做成 Tweaks 面板** 这个 pattern 极好，保留扩展（见 §1.5 给新 tweak）

---

## 1. 五处 refine（grill 后定的）

### 1.1 EventChain 形态分场景调整

v2 当前：`/mistakes` / `/knowledge` / Copilot drawer 三处都用 inline `<details>`。grill 后：

- **`/mistakes` 卡片内**：✅ 保留 inline `<details>`（链短 + 错题已是终点视图）
- **`/knowledge` 节点页**：⚠️ **改 popover 或 sidebar 面板**——一个热门 knowledge 节点可能挂 10+ AI 事件，inline 撑爆。点 "AI 活动 (12)" → 右侧抽屉列表，每条可展开
- **Copilot drawer 内**：⚠️ **改"查看链 →" 跳出 drawer**，落到 `/mistakes/eX` 对应卡片——drawer 不该是终点视图（嵌套 details 套娃）

### 1.2 Copilot proactive trigger 1.2s → 30s

v2 tweak `proactive` 选项当前 1.2s 触发——过激进，1.2s 是用户还没读完顶部的时间。改：

- **默认 trigger = 30s** 停留 + 未交互
- 或更精明：**行为信号** —— 用户在同一 entity 内连续 hover/scroll 5s+ 无 click（"卡住了"信号）
- 显式：双访同一 entity 触发 ("反复看说明困惑")

不要拍卖时长（1.2s 是 sales 弹窗思路）—— 学习工具应当克制。

### 1.3 Today KPI 4 个中"知识点数" → "AI 提议 pending"

v2 Today KPI：FSRS 到期 / 归因中 / 学习项 active / 知识点数。

"知识点数"是 **vanity metric**——"127 知识点"不影响行为。

**替换为 "AI 提议 pending"**：`events WHERE action='propose' AND status='pending'`（用户未 accept/dismiss 的）。这是 **C 档核心信号**——AI 主动产了一堆等审。点 → 跳 `/inbox`。

### 1.4 Vision Tier rescue 按钮 cost 分行 meta

v2 当前形如 `[Vision Tier 2 (Haiku) · $0.005]`——成本与动作语义粘一起读不顺。

改 meta-row 分离：

```
┌──────────────────────┐
│ Vision Tier 2        │  ← 主按钮 label
│ Haiku · ~$0.005      │  ← meta-row tone (--ink-4 + smaller font)
└──────────────────────┘
```

成本作副信息退后，不抢主焦点。同 loom voice "show the mechanism" 但视觉分层。

### 1.5 EventChain summary cost / per-row 省略

v2 当前每个 chain row 都印 cost——用户只在探索推理时是 noise。

改 **分层透明**：

- `<details>` summary 行：**汇总** chain 总 cost（如 `查看推理链 · 4 events · $0.045`）
- 展开后 row body：**省略 per-row cost**，或 hover 才显示
- `<ProposalCard>` 上**保留** per-event cost（用户正在做 accept/dismiss = 成本决策，必显）

加一个 Tweaks 项：**chain-row cost 显示**：summary-only / hover-on-row / always-show。默认 summary-only。

---

## 2. Knowledge mesh —— ADR-0010 大补（v2 完全没画）

**背景**：v2 generated 后我加了 ADR-0010 knowledge mesh：parent_id tree backbone **+ knowledge_edge 表** with typed cross-relations。"tree 是骨架，mesh 是肌肉"。

v2 完全没反映。本轮要补四块：

### 2.1 Knowledge schema 扩展

`data.jsx` 加：

```js
// material · knowledge_edge (新增 mesh table)
const KNOWLEDGE_EDGES = [
  {
    id: 'kedge_01',
    from_id: 'k_xuci_zhi',   // 之-用法
    to_id: 'k_xuci',          // 文言虚词（父节点）—— 但这是 tree 已有的
    relation_type: 'derived_from',
    weight: 1.0,
    created_by: { actor_kind: 'user' },
    created_at: NOW - 7 * DAY,
  },
  {
    id: 'kedge_02',
    from_id: 'k_shici',       // 实词词义
    to_id: 'k_fanyi',         // 翻译
    relation_type: 'prerequisite',  // 学翻译先学实词
    weight: 0.9,
    created_by: { actor_kind: 'agent', actor_ref: 'review' },
    reasoning: '近 30 天翻译错答 78% 涉及实词词义不准',
    created_at: NOW - 3 * DAY,
  },
  {
    id: 'kedge_03',
    from_id: 'k_xuci_zhi',
    to_id: 'k_xuci_yu',
    relation_type: 'contrasts_with',
    weight: 0.7,
    created_by: { actor_kind: 'user' },
    created_at: NOW - 12 * DAY,
  },
  {
    id: 'kedge_04',
    from_id: 'k_shici',
    to_id: 'k_juedu',
    relation_type: 'applied_in',
    weight: 0.6,
    created_by: { actor_kind: 'agent', actor_ref: 'review' },
    reasoning: '词义不准导致断句错位的 case study',
    created_at: NOW - 2 * DAY,
  },
];
```

**5 个 core relation_type**（per ADR-0010）：`prerequisite | related_to | contrasts_with | applied_in | derived_from`，外加 `experimental:*` 命名空间。

### 2.2 新 Event 类型 — Propose / Generate / Rate `knowledge_edge`

`event.subject_kind` 加 `'knowledge_edge'`。SEED 数据加：

```js
// e_50: AI agent (review) 提议加 k_shici --prerequisite--> k_fanyi
{
  id: 'e_50', session_id: null,
  actor_kind: 'agent', actor_ref: 'review', action: 'propose',
  subject_kind: 'knowledge_edge', subject_id: 'kedge_pending_01',
  outcome: 'success',
  payload: {
    from_id: 'k_shici', to_id: 'k_fanyi',
    relation_type: 'prerequisite',
    weight: 0.9,
    reasoning: '近 30 天翻译错答 78% 涉及实词词义不准',
  },
  caused_by_event_id: 'e_dream_scan',
  task_run_id: 't_050', cost_micro_usd: 8500,
  created_at: NOW - 4 * HR,
}
```

`describeEvent()` in primitives.jsx 加 `propose × knowledge_edge` 路径的描述。

### 2.3 `/knowledge` 新 UI 元素

**a. 节点旁显示 mesh edges**：

每个 knowledge 节点的 detail panel（点节点展开）含一个 "关系" 区段：

```
关系
  ↓ prerequisite 之前：(无)
  ↑ prerequisite 之后：翻译 (0.9)
  ↔ contrasts_with：之 (用法), 而 (用法)
  ↳ derived_from：（无 / 自动从 tree）
```

每条关系右侧 hover 显示 reasoning + actor + cost；user 可点 "撤销" 写 `event(action='rate', subject='knowledge_edge', payload.rating='dismiss')`。

**b. Force-directed graph 视图（toggle）**：

`/knowledge` 顶栏加 `[ Tree | Graph ]` toggle。Graph 视图：

- < 1000 节点 / ~5000 edges 规模
- 节点 = 圆，半径按 mistake_count（被错答过多少道题）
- edge 按 `relation_type` 分色：
  - `prerequisite` → coral（重要，有方向 arrow）
  - `related_to` → ink-4（弱，无方向）
  - `contrasts_with` → 紫色（明显，无方向）
  - `applied_in` → blue（绿叶，有方向）
  - `derived_from` → ink-5（淡，有方向）
- node click → 同 tree 视图的 detail panel
- 用 D3 / cytoscape / vis-network（**designer 提议哪个最合身**）

**c. 节点页内嵌 Edge Proposal 区**：

当 AI 提议加一条以该节点为 from/to 的 edge：

```
┌─ AI 建议关系 ─────────────────────────────────┐
│ 实词词义 ──prerequisite──→ 翻译                │
│ 推理：近 30 天翻译错答 78% 涉及实词词义不准    │
│ agent:review · t_050 · $0.0085                 │
│ [ 接受 ]  [ 改方向 ]  [ 改关系 ]  [ 忽略 ]     │
└────────────────────────────────────────────────┘
```

四个动作都写 `event(action='rate', subject='knowledge_edge')` —— payload.rating ∈ `{accept, reverse, change_type, dismiss}`。

### 2.4 `/today` Inbox strip 含 edge 提议

`<InboxStrip>` 当前列 last-night Dreaming 产出的 variant / note / propose-knowledge。**加 propose-edge 计数**：

```
昨晚 Dreaming · 跑了 47 分钟 · $0.23
  3 道变式题 · 2 篇笔记 · 1 个新知识点 · 2 条关系建议   ← 新
                                            [ 集中审批 → ]
```

---

## 3. 落地路径

把这 5 + 1 + Tweaks 项做成 `docs/design/loom-design-v2.1/`。保留 v2 结构（4 jsx + 2 css + index.html），diff-style 修改：

- `primitives.jsx`：EventChain summary cost + 加 mesh-related primitives（`<KnowledgeRelation>` / `<EdgeProposalCard>`）
- `pages.jsx`：knowledge graph toggle / today KPI 替换 / record Vision rescue cost 分行 / mistakes EventChain inline-keep / knowledge popover-or-drawer
- `data.jsx`：加 `KNOWLEDGE_EDGES` + edge-related events
- `tweaks-panel.jsx`：proactive trigger 默认 30s + 新 tweak "chain-row cost"
- `tokens.css`：可能新增 `--prerequisite` / `--contrasts` / `--applied` / `--derived` 关系色（或复用现有 semantic tints）
- `README.md`：写 v2.1 改了什么 + grill 时新 hot-spots

---

## 4. 7 个 grill 问题里 **不动** 的 2 个

回答 designer 在 v2 README 提的问题：

- **§Q2 inbox 双入口**：保留双入口。today strip = "yesterday's haul peek"，`/inbox` = "all unhandled"。strip 加 "see all (N) →" 跳路由——职责清楚。
- **§Q6 force-directed graph**：本轮要做（见 §2.3.b）。

---

## 5. Files to read (in order, refresh)

1. **This brief v2.1** ← you are here
2. **`docs/design/loom-design-v2/`** —— v2 落地，要 refine 它，不要重画
3. **`docs/adr/0010-knowledge-mesh.md`** ← mesh 大补（必读）
4. **`docs/adr/0006-encounter-replaces-mistake.md`** v2 节 + event.subject_kind 含 'knowledge_edge' 修订
5. **`docs/design/2026-05-15-design-brief.md`** —— v1 brief（参考，本 brief v2.1 是 delta）

`docs/design/loom-design/` 旧 v1 mistake-centric design **不要看**——审美仅通过 v2 间接继承。

---

## 6. Done 是什么

`docs/design/loom-design-v2.1/` 含：

- v2 全部文件，diff-改过
- Mesh 数据 + UI（schema in data.jsx + KnowledgeRelation primitive + Graph toggle + EdgeProposalCard）
- 5 处 refinement 落地
- README 列出 v2 → v2.1 改了什么 + 新 hot-spots
- 1 个新 C 档场景（mesh edge proposal accept 流）
- 1 个 D 档场景延续 v2（不必重画 Copilot drawer，可保留）

如果你看完发现某条 refinement 我说错了/路径不对，可以 push back——本 brief 不是 final word，是 grill 后 starting point。
