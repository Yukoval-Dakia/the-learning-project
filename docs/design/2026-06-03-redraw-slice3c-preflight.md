# Redraw Slice 3c — design pre-flight（knowledge EdgeCreateForm + graph chrome）

> **Status**: Pre-flight, awaiting user approval（CLAUDE.md UI 规则）。
> **Source**: loom-prototype `screen-knowledge.jsx`（EdgeCreateForm L121-155），cytoscape 保留。YUK-169 slice 3c / YUK-203 P5。
> **Base**: branch `yuk-169-redraw-slice3c`（自 slice-3b baeed169，stacked 在 #286 上；#286 merge 后 rebase 到 main）。

---

## 0. 范围（slice-3 的最后一块）

knowledge-list 收尾：

- **本刀 slice-3c** = ① EdgeCreateForm（新建关系表单）loom 化 · ② cytoscape graph **周边**（loading 态 + 容器）最小 loom 化（**cytoscape 本身保留**，已定）。
- **之后单独 cleanup pass** = 退役已停用的 legacy CSS（`.detail-drawer`/`.dd-*`/`.edge-proposal`/`.ep-*`/`.proposal`/`.relation`/`.kf-*` —— grep 确认无其它页面引用后删）。

完成后 knowledge-list 全 loom（chrome+tree+banner+drawer+提议+建表单+graph 周边），只剩 cytoscape 内部 + legacy CSS 死代码。

## 1. 待你定的设计选择 ⚠️（EdgeCreateForm 形态）

当前是**页级表单**：3 个 `<select>`（from / relation / to）+ reasoning `<textarea>`，由 chrome CTA「新建关系/取消」(showEdgeCreate) 切换，POST `/api/knowledge/edges`（含 reasoning）。
loom 设计是**抽屉内 per-node 表单**：`.chip-set` 关系 chips + 1 个 target `<select>` + `.dir-row` 方向切换，**无 from-picker**（prefill from=当前节点）、**无 reasoning**。

| 选项 | 取舍 |
|---|---|
| **A（推荐）页级表单 restyle 就地** | 保留现有自由 from/to + reasoning（功能更全、接线不动、低风险），只换 loom 类（`.edge-form`/`.field-label`/`.field-input` + relation 改 `.chip-set` chips）。**偏离 loom 的"抽屉内 per-node"位置**，但保留更强的自由建边能力。 |
| **B loom per-node 抽屉内** | 完全贴 loom：把建表单移进 NodeDrawer，prefill from=节点、relation chip-set + dir-toggle、**丢 reasoning**、丢自由 from-picker。改动大、丢功能（reasoning + 任意 from）。 |

**用户已选 B**（loom per-node 抽屉内）。实施按 B：
- 建表单移进 **NodeDrawer**（slice-3b 已 loom 化的抽屉）新增一个 `.drawer-sec` > `.edge-form`：relation `.chip-set` + target `<select className="field-input">`（from prefill = 当前 `selected.id`）+ `.dir-row`（有向关系切换）+ `<Btn primary block icon=plus>建立 {label} 边`。
- `createEdgeM.mutate({ from_knowledge_id: selected.id, to_knowledge_id: target, relation_type })`（**丢 reasoning**）。
- **移除**页级 `<EdgeCreateForm>` render + 其 `Card` 包裹 + chrome CTA「新建关系/取消」+ `showEdgeCreate` state + `createEdgeM.onSuccess` 里的 `setShowEdgeCreate(false)`。chrome 的 loom CTA「新建节点」未接线 → 暂移除该 CTA（node-create 接线后再加）。
- 旧 `EdgeCreateForm` 组件（`.kf-*` 3-select+reasoning）整体替换为抽屉内 loom 版。

## 2. 逐字引 loom（EdgeCreateForm L121-155，取其视觉语汇用于 A）

`.edge-form` · `.field-label`「新建关系边」· `.chip-set`（relation chips：`.chip` + `.is-on` 选中，`.mono` glyph + label）· `<select className="field-input">`（target，option 显示 `{title} ({tag})`）· 条件 `.dir-row`（有向关系时：`.meta`「方向」+ `.chip.is-on`（from→to wenyan + arrow）+ `<IconBtn icon="reverse">`）· `<Btn variant="primary" size="sm" icon="plus" block>建立 {label} 边`。

## 3. 数据映射（A：页级，全已接线）

| 字段 | 来源 |
|---|---|
| relation chip-set | `RELATION_TYPES`（5 类，glyph+label；选中 `.is-on`） |
| from / to select | `nodes`（option label `{name} ({id.slice(0,8)})`；保留自由选择） |
| reasoning | 现有 textarea（**保留**，backend 接受，作为 provenance） |
| 方向 dir-row | 有向关系（`RELATION_TYPES[rel].directed`）时显示 from→to + reverse toggle（沿用现有 directed 标记） |
| submit | `createEdgeM.mutate({from_knowledge_id,to_knowledge_id,relation_type,reasoning?})`（不动） |
| 校验/错误 | 现有 `fromId===toId` / `error` → loom `.field-*` 错误态 |

## 4. graph 周边（最小 loom 化）

- `.kg-stage` / `.kg-canvas` 加载 fallback（page L38）→ loom paper/border/圆角；loading 文案不变。
- **cytoscape 内部不动**（`src/ui/KnowledgeGraph.tsx` 的节点配色/布局留作可选后续；本刀不碰其文件，避免风险）。
- 不引入 loom 的 SVG `.mesh-*`（cytoscape 保留，已定）。

## 5. Touch 文件清单

**MODIFY**：`app/globals.css`（追加 `.edge-form`/`.field-label`/`.field-input`/`.chip-set`/`.dir-row` —— grep 确认全不在 globals；从 screens.css L237/271-273 + screens-2b.css L84-86 port；banner「LOOM KD-EDGEFORM LAYER — Slice 3c」；+ `.kg-stage`/`.kg-canvas-loading` 若要 loom 化容器）· `app/(app)/knowledge/page.tsx`（重写 `EdgeCreateForm` 组件 JSX：`.kf-*` → loom `.edge-form`/`.field-*`/`.chip-set`/`.dir-row` + `Btn`/`IconBtn`/`LoomIcon`；graph loading fallback 容器换 loom 类）。
**REUSE（不动）**：`createEdgeM`/`showEdgeCreate`/chrome CTA 接线 · cytoscape `KnowledgeGraph` 渲染 + graphProposals · slice-1/2/3/3b 的 loom primitives + CSS（`.chip`/`.chip.is-on` 已有）。
**KEEP-LEGACY**：`Button`/`Card`（EdgeCreateForm 外的 Card 包裹？确认；submit 换 `Btn` 后若 Card/Button 不再被任何块引用则退役 import，grep 后定）。
**KEEP-LEGACY-CSS（不删）**：`.kf-*`/`.detail-drawer`/`.edge-proposal` 等 —— 本刀只停用，单独 cleanup pass 删。

## 6. 风险 + 缓解

- **A vs B 设计选择**：见 §1，默认 A（低风险保功能）。等你确认。
- **CSS 冲突**：`.edge-form`/`.field-*`/`.chip-set`/`.dir-row` grep 确认 globals 无（全 0）→ 全局 port 安全。`.chip`/`.chip.is-on` 已有 → 复用不重定义。
- **建边接线**：只换表单 JSX/类，`createEdgeM.mutate` 入参不变；build + 手验「新建关系 toggle → 选 from/relation/to + reasoning → 提交 → 边出现」。
- **graph 最小动**：只动 page 的 loading fallback 容器 + 可选 kg-stage 容器样式；不碰 KnowledgeGraph.tsx（cytoscape config）→ 零图功能风险。
- **build = CSS+route gate**；手验建边流 + graph 加载态。

## 7. Build order + verify gate

新 CSS（globals：edge-form/field-*/chip-set/dir-row[+kg 容器]）→ 重写 EdgeCreateForm（loom 表单）+ graph loading 容器 → **verify**：typecheck / lint / audit×3 / build / 建边流（toggle→填→提交→边出现）· graph 加载态 · tree↔graph 切换仍 working。独立 review + push + PR（**你 merge**）。
之后另起 **cleanup pass** 退役 legacy CSS。

---

*批准（并确认 A/B）后按 build order 实施。本刀收尾 knowledge-list；cytoscape 内部 + legacy CSS 删除留后。*
