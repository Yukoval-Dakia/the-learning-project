# YUK-297 视觉 refinement 实施 plan — 知识图谱 SVG 重写 + 全局精修层

- **Linear**: YUK-297（Medium / Improvement / Backlog）
- **Branch**: `yuk-297-visual-refinement`
- **Worktree**: `/Users/yukoval/yukoval-projects/the-learning-project/.claude/worktrees/yuk297-visual-refine`
- **Design source**: `/tmp/design-graph/loom-refresh/project/`（`refine.css` / `screen-knowledge.jsx` / `screens-2b.css` / `Loom.html` 原型）
- **作者**: 架构师（plan-only pass，不动代码）

---

## 0 · 勘察后的关键架构事实（决定整份 plan 的形状）

1. **cytoscape→SVG 的切面是干净的**。`src/ui/KnowledgeGraph.tsx` 对外暴露稳定 props（`nodes / edges / selectedId / onNodeClick / mistakeCounts / dueCounts / proposals / onProposalDecision`，见 `KnowledgeGraphProps` L214-243）。NodeDrawer、所有 edge/node proposal mutation、tree↔graph 视图切换、数据 fetch 全在 `app/(app)/knowledge/page.tsx`，通过这套 props 与图组件连接（render 块 page.tsx L619-630）。**SVG 重写只换 KnowledgeGraph 内部渲染，不动 props 契约、不动 page.tsx 的抽屉/proposal/数据流** → 硬约束①自动满足。

2. **纯领域函数必须原样存活**。当前 `KnowledgeGraph.tsx` 里 rendering-agnostic 且被 `src/ui/KnowledgeGraph.test.ts` 单测覆盖的：`masteryBand` / `isWeakish` / `passesFilter` / `distinctDomains` / `nodeRadius` / `RELATION_VISUAL` / `RELATION_LABEL` / `MASTERY_BAND_TOKEN` / `MASTERY_BAND_LABEL` / `FilterState` / 所有 interface。这些 **保留不变**。被替换的只有 cytoscape 专属的 `buildElements`（返回 `ElementDefinition[]`）/ `buildStylesheet`（返回 `StylesheetJson`）/ `buildProposedEdgeElements`、`TOKEN_NAMES` / `readTokens` / `TokenMap`、以及组件 body 里的 cytoscape `useEffect`。

3. **所有 design token 在生产 light+dark 都已定义**（核实：`--good-soft/-line`、`--hard-soft/-line`、`--again-soft/-line`、`--coral-line`、`--line-soft/-strong`、`--paper-raised/-sunk`、`--r-pill/-2/-3`、`--s-3`、`--dur-fast`、`--ease-out`、`--fs-meta` 均见 globals.css L114-376 light+dark）。SVG 可以直接 `var(--x)` 引用 → **彻底删掉 cytoscape 时代的 `readTokens()` + `MutationObserver(data-theme)` + `matchMedia` restyle 间接层**（SVG 用 CSS var 天然跟随主题）。硬约束③（沿用现有 token）自动满足。

4. **布局是唯一真风险**。design 的 radial-by-depth（screen-knowledge.jsx L29-37）对 7 个 mock 节点漂亮，但生产是数百节点（page.tsx L309 注释 "200 nodes × 300 edges"）。**布局算法是核心决策，见 §Part 2.2 与 layout_decision 字段。**

5. **行号已核实**：recon C 的 globals.css 行号与本 worktree 实际文件高保真匹配（shadow L107-109/225-227/330-332/389-391；btn-primary L5692；card-hover L5886；topbar L5576-5578；nav-item.is-active L5453；hero L7605；section-label L7723；strip L7918；kpi-val L7687）。globals.css 实际 12385 行（recon C 写 10113 是旧快照，不影响编辑点行号）。

6. **design refine.css 全部 gated 在 `[data-refine="on"]`**。owner 拍板**不做开关** → 落地时**剥掉 gate 前缀，直接写进既有规则块**（不是新增 `[data-refine]` 选择器）。

---

# Part 1 · 全局精修层（refine.css 9 类 → 直接写进 globals.css 作默认）

**性质**：纯 CSS，低风险，无组件改动，可独立先 ship（见 pr_split）。
**落地原则**：design 的 `[data-refine="on"] X { ... }` → 找到生产里 `X` 的既有规则块，原地改属性 / 补属性。不新增 gate 选择器。

## 1.1 编辑点清单（按 globals.css 行号升序）

| # | 行号 | R# | 当前 | 改为 | 备注 |
|---|------|-----|------|------|------|
| 1 | L107-109 | R1 | `--shadow-1/2/3` 两层（@theme light） | 三层暖色（见下方值块 A） | 与 #2 完全同值，**必须同步** |
| 2 | L225-227 | R1 | 同上（`:root` light） | 同 #1 | |
| 3 | L330-332 | R1 | 深色两层（`@media prefers dark`） | 三层深色（值块 B） | |
| 4 | L389-391 | R1 | 深色两层（`[data-theme="dark"]`） | 同 #3 | |
| 5 | L5453 块后 | R5 (hi) | `.nav-item.is-active` 仅背景高亮 | 块后**新增** `::before` coral tick + `.rail-collapsed` 变体（值块 C） | `.nav-item` 已 `position:relative`（L5415 区）；须确认无 `overflow:hidden` |
| 6 | L5576 | R4 | `color-mix(... 84%, transparent)` | `78%` | |
| 7 | L5577 | R4 | `backdrop-filter: blur(12px)` | `blur(16px) saturate(1.4)` | |
| 8 | L5578 | R4 | `-webkit-backdrop-filter: blur(12px)` | `blur(16px) saturate(1.4)` | |
| 9 | L5579 | R4 | `border-bottom: 1px solid var(--line)` | `var(--line-soft)` | design 用 `border-bottom-color`，等效改色即可 |
| 10 | L5692-5695 | R6 (hi) | `.btn-primary { box-shadow: var(--shadow-1) }` | coral 两层（值块 D base） | |
| 11 | L5697-5699 | R6 (hi) | `.btn-primary:hover` 仅 `background` | 补 `box-shadow`（值块 D hover） | |
| 12 | L5700-5701 | R6 (hi) | `.btn-primary:active` 仅 `background` | 补 `box-shadow`（值块 D active） | |
| 13 | L5892 | R2 | `transform: translateY(-2px)` | `translateY(-3px)` | （可选）L5891 border-color `--line-strong`→`--line` |
| 14 | L7608 | R3 | `background: linear-gradient(135deg, --paper-raised, --paper-sunk)` | `background: var(--paper-raised)` | |
| 15 | L7605-7609 块内 | R3 | （loom-hero 无 box-shadow） | 补 `box-shadow: var(--shadow-1), var(--shadow-inset)` | |
| 16 | L7615 | R3 | `.hero-weave { opacity: 0.9 }` | `0.8` | |
| 17 | L7687-7694 区 | R7 | kpi-val `letter-spacing: var(--ls-tight)` (-0.015em) | 改/覆盖为 `-0.02em`（today-loom 作用域内） | |
| 18 | L7694 后 | R7 | （hero-title/prop-summary-n/cost-amt/ring-val 无 tightening） | 新增规则给这 4 个补 `letter-spacing:-0.02em; font-variant-numeric:tabular-nums`（值块 E） | `.item-stat .s-n`/`.mistake-count .mc-n` **TSX 中不存在**（已 grep 确认）→ **本次不加**，记为 forward-looking |
| 19 | L7727 | R8 | `margin: var(--s-10) 0 var(--s-4)`（today-loom .section-label） | `var(--s-8) 0 var(--s-4)` | 只改 today-loom flex 版；legacy 裸版 L1258 / items-loom L9249 不动 |
| 20 | L7738 | R8 | `.rule { background: var(--line) }` | `var(--line-soft)` | |
| 21 | L7744 块内 | R8 | `.count { ... }` 无 nowrap | 补 `flex: none; white-space: nowrap`（修"3 缕"断行） | |
| 22 | L7923 | R9 | `.today-loom .strip { border-bottom: 1px solid var(--line) }` | `var(--line-soft)` | `.tl-row` TSX 中不存在 → 不加 |

### 值块 A — shadow light（#1 #2，L107-109 / L225-227 同步）
```css
--shadow-1: 0 0.5px 1px rgba(60,50,30,.04), 0 1px 2px rgba(60,50,30,.035);
--shadow-2: 0 1px 2px rgba(60,50,30,.04), 0 5px 14px -4px rgba(60,50,30,.08), 0 14px 30px -12px rgba(60,50,30,.07);
--shadow-3: 0 2px 4px rgba(60,50,30,.05), 0 14px 30px -10px rgba(60,50,30,.12), 0 38px 64px -20px rgba(60,50,30,.16);
```

### 值块 B — shadow dark（#3 #4，L330-332 / L389-391 同步）
```css
--shadow-1: 0 0.5px 1px rgba(0,0,0,.22), 0 1px 2px rgba(0,0,0,.20);
--shadow-2: 0 1px 2px rgba(0,0,0,.24), 0 6px 16px -4px rgba(0,0,0,.42), 0 16px 34px -12px rgba(0,0,0,.34);
--shadow-3: 0 2px 4px rgba(0,0,0,.26), 0 16px 34px -10px rgba(0,0,0,.50), 0 40px 70px -20px rgba(0,0,0,.55);
```
> design dark `--shadow-1` 仅给了 2 层（refine.css L30）；生产 dark shadow-1 当前是 2 层硬边线，**统一改成 design 的 2 层模糊值**（与 light 一致地把第一层从 `0 1px 0` 硬线换成真实模糊）。shadow-2/3 各补第三层大 spread。

### 值块 C — nav tick（#5，L5453 `.nav-item.is-active {…}` 块后新增）
```css
.nav-item.is-active::before {
  content: ""; position: absolute; left: -2px; top: 50%;
  width: 3px; height: 17px; transform: translateY(-50%);
  border-radius: var(--r-pill); background: var(--coral);
}
.rail-collapsed .nav-item.is-active::before { left: 2px; height: 14px; }
```

### 值块 D — btn-primary coral shadow（#10/#11/#12）
```css
/* base   */ box-shadow: 0 1px 2px rgba(169,63,38,.22), 0 2px 8px -2px rgba(169,63,38,.20);
/* :hover */ box-shadow: 0 1px 2px rgba(169,63,38,.26), 0 4px 14px -3px rgba(169,63,38,.26);
/* :active*/ box-shadow: 0 1px 2px rgba(169,63,38,.24);
```
> **R6 dark-mode 补丁（recon C 高风险点，必做）**：coral shadow 是硬编码 `rgba(169,63,38)`，不跟 `--coral` token（dark 下 coral=`#e89572`）。深色背景上原值会过曝。**在 `[data-theme="dark"]` block + `@media prefers dark` block 各加一条** `.btn-primary { box-shadow: ... }` 把三段 opacity 降一档（建议 base `.16/.14`、hover `.20/.18`、active `.16`）。视觉环 dark 截图核查 glow 不过亮。

### 值块 E — numerals（#18，kpi-val 块后新增）
```css
.today-loom .hero-title,
.today-loom .prop-summary-n,
.today-loom .cost-amt,
.ring .ring-val { letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
```

## 1.2 design refine.css 里超出 recon C 9 类的额外条目 — 处置决定

refine.css 还有 4 条 recon C 未列：

- **`.card` border-soft + shadow-1（L36-39）**：建议**纳入**（与 R2 同族，纯 hairline 柔化，低风险）。生产 `.card` 当前若无 shadow，补 `box-shadow: var(--shadow-1); border-color: var(--line-soft)`。impl 阶段先 grep `.card {` 定位再决定。
- **`.sidebar` border-right `--line-soft`（L63）/ `.searchbox` hover（L64-69）**：建议**纳入**（chrome 一致性）。
- **`.eyebrow` letter-spacing 0.06em（L110）**：建议**纳入**（engraved 质感，零风险）。
- **`.field-input` border `--line` / `.composer` shadow-1（L118-119）**：建议**纳入**。

> 这 4 条都是 design refine 层的一部分，owner 要的是"对齐 design"，不纳入就是偏离。但它们 recon 未逐行核实生产现状 → **impl 阶段每条先 grep 生产现值，对齐到 design，再改**；找不到对应选择器则跳过并在 commit body 注明。**不发明新选择器**。

## 1.3 Part 1 风险点

- **R1 四处同步**：漏改任一处 → 主题切换阴影退化。验证：改后 grep `--shadow-[123]:` 必须恰好 4×3=12 行，light 3 层 / dark 3 层成对。
- **R1 加深波及面**：shadow-2/3 被全局 ~15 处 `box-shadow` 引用（recon C：L656/L2432/L3843/L5890/L6000…）。dark 下值更深 → 视觉环 dark 多视角核查无过曝。
- **R5 tick 裁剪**：`.nav-item` 容器须无 `overflow:hidden`，`left:-2px` 会轻微溢出 rail 左边界。impl 先核 rail padding / overflow；若被 clip 则 tick 不可见 → 退化为 `left:0`。
- **R6 dark glow**：见值块 D 补丁，**不补必过曝**。
- **R7 紧排**：`-0.02em` 对 `--fs-display`(48px) serif 数字明显收紧，中英文字符集都要目测无碰撞。

---

# Part 2 · 知识图谱 SVG 重写（弃 cytoscape，还原 design MeshGraph）

## 2.1 组件架构 — 文件级 touch 清单

**核心原则**：拆出"纯渲染无关领域逻辑"与"SVG 渲染层"，保留前者的测试，重写后者。

### 修改 `src/ui/KnowledgeGraph.tsx`
- **保留不动**（领域逻辑，仍导出供 test + page）：
  - 全部 `interface`（`KnowledgeGraphNode/Edge/Props`、`NodeDueSummary`、`KnowledgeEdgeProposal`）
  - `RELATION_VISUAL` / `RELATION_LABEL` / `MASTERY_BAND_TOKEN` / `MASTERY_BAND_LABEL`
  - `masteryBand` / `isWeakish` / `nodeRadius` / `distinctDomains` / `passesFilter` / `FilterState` / `MasteryFilter`
- **删除**（cytoscape 专属）：
  - `import cytoscape / fcose`、`ensureFcose`、`FCOSE_LAYOUT`
  - `TOKEN_NAMES` / `readTokens` / `TokenMap`（SVG 用 var() 不需要）
  - `buildElements` / `buildStylesheet` / `buildProposedEdgeElements`（返回 cytoscape 形态）
  - 组件 body 里 cytoscape `useEffect`（L808-926）、`MutationObserver` / `matchMedia` restyle、`applyFocus` 的 cytoscape 实现
- **新增**（SVG 层，建议拆到 `src/ui/knowledge-graph/` 子目录）：
  - `layout.ts` — `computeLayout(nodes, edges): Map<id, {x,y}>`（见 §2.2）+ 单测
  - `KnowledgeGraphSvg.tsx`（或就地重写 `KnowledgeGraph` body）— SVG 渲染 + pan/zoom + focus + inline proposal
  - 节点/边渲染辅助（disc/track/arc/label、edge path + 中点 label、marker defs）
- **package.json**：移除 `cytoscape` + `cytoscape-fcose` 依赖（**除非**选布局方案②保留 fcose headless，见 layout_decision）。

### 不改但需理解的契约
- `app/(app)/knowledge/page.tsx` L619-630 render 块 + L28-38 `next/dynamic ssr:false` import：**props 一字不动**，所以 page 无需改（SVG 重写后理论上可去掉 `ssr:false`，但保留更稳——cytoscape 没了，SVG 可 SSR，**本次不动 dynamic import，记为 follow-up**）。
- NodeDrawer / EdgeProposalCard / 所有 mutation（page.tsx L636-870、L189-251）：**零改动**。

### 修改 `app/globals.css` 图谱 CSS 段（L3624-~3900 `kg-*` 区）
- 现有 `.kg-stage / .kg-canvas / .kg-controls / .kg-chip / .kg-legend / .kg-proposal-*` 大部分**保留**（controls/chip/legend/proposal popover 是 React 层，不依赖 cytoscape）。
- **替换** `.kg-canvas`（L3634，当前是给 cytoscape `<canvas>` 的 520px 容器）→ 改为 SVG stage：dot-grid 背景、`cursor:grab/grabbing`、`overflow:hidden`、`user-select:none`。
- **新增** design MeshGraph 的 CSS（来自 `screens-2b.css` L1-129/L323）：`.mesh-disc.tone-*`、`.mesh-track`、`.mesh-arc`、`.mesh-node-pct`、`.mesh-node-label`、`.mesh-node2`（入场 `node-fade` + hover scale + focus-visible coral）、`.mesh-edge2.rel-*`、`.mesh-edge-label`、zoom controls pill。**全部用生产已有 token**（§0.3 已核 token 齐全）。

## 2.2 布局方案（核心决策 — 详见 layout_decision 字段）

**推荐：方案② — 保留 cytoscape/fcose 作 headless 布局引擎算坐标，SVG 做渲染层。**

理由摘要（完整论证见 layout_decision）：
- design 的 radial-by-depth 是给 7 节点 mock 的确定性算法，生产数百节点会**横向溢出 + 同深度大量重叠**（x 公式 `130 + i*(760/rowLen)`，rowLen 大时节点挤成一条线）→ 退化不可接受，违背"彻底还原"的视觉目标（还原的是节点/边/动画的**视觉语言**，不是 7 点布局本身）。
- fcose 已在生产验证过 200 节点 O(N²) 优化路径，布局质量稳定，零新依赖、零新风险。
- 用法：`cytoscape({ headless: true, elements, layout: fcose }).run()` → 读 `node.position()` 得 `{x,y}` Map → `cy.destroy()`。**只借坐标，不借渲染**。CSS animation 失效问题（owner 抱怨根因）彻底解决，因为渲染全在我们的 SVG DOM。
- 布局结果喂给 SVG 的 `<g transform="translate(x y)">`。pan/zoom 是我们自己的 `view` state（design 的 drag+wheel 实现，screen-knowledge.jsx L39-45），不用 cytoscape 的。

**design radial-by-depth 仍保留**作为**小图回退/确定性模式**：节点数 ≤ 阈值（建议 ~12，覆盖 mock + synthetic seed 的 7-9 点）时用 radial-by-depth（视觉最贴 design 原型），超阈值用 fcose headless。`computeLayout` 内部分支，`layout.ts` 单测覆盖两条路径。

> 若 impl 阶段验证 fcose headless 因 SSR/bundle 体积仍想彻底去依赖 → 退路是方案③ d3-force（`d3-force` 仅 ~10KB，纯函数易测），但**默认按②**，因为零迁移成本 + 已验证。

## 2.3 pan/zoom 实现（design 还原）

照搬 screen-knowledge.jsx L39-45 + screens-2b.css ⑥：
- state `view = {x, y, k}`，`drag = useRef`
- `.mesh-stage2` div 挂 `onMouseDown/Move/Up/Leave/Wheel`；`onWheel` 内 `e.preventDefault()`（防页面滚动）
- `zoom(d)`：`k` clamp `[0.5, 2]`，步进 0.1，`toFixed(2)` 防漂移
- SVG 内容 `<g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>`，viewBox `0 0 1000 560`
- cursor `grab`/`grabbing`（`:active`）
- zoom controls pill（缩小/百分比/放大/分隔/复位，`shadow-2`）

**保留生产语义**：pan/zoom 时**关闭 inline proposal popover**（当前 cytoscape `cy.on('pan zoom', …)` L885 的等价——SVG 版在 `onMove`/`zoom` 里 `setActiveProposal(null)`）。

## 2.4 节点 / 边 / 动画渲染（design 还原 + 生产数据映射）

**节点**（design screen-knowledge.jsx L81-104，5 层 `<g>`）：
1. disc：`<circle r filter="url(#nodeShadow)" class="mesh-disc tone-{tone}">`，hub r=24 / leaf r=18
2. track ring：`<circle class="mesh-track">`（paper-raised 底环）
3. mastery arc：`stroke-dasharray=circ` `dashoffset=circ*(1-mastery/100)` `rotate(-90)`，`transition: stroke-dashoffset 1s`
4. 中心数字 `.mesh-node-pct`
5. 圆外 label `.mesh-node-label`（paint-order stroke 白描边）
- `<g class="mesh-node2 tone-{tone}" tabIndex=0 role=button style={animationDelay: i*50ms}>` → 入场 `node-fade .4s` 错峰

**生产数据 → 节点视觉的 adapter（关键，硬约束①）**：
- design 的 `tone`（good/hard/again，按 0-100 mastery 阈值）**不照搬** → 用生产的 `masteryBand(node.mastery, node.evidence_count)`（5 band：weak/learning/mastered/untrained/insufficient，含 evidence gate + 0.5 sentinel，见当前 L83-94），fill 走 `MASTERY_BAND_TOKEN`。arc 进度用 `node.mastery ?? 0`（NULL=0）。**保留生产的诊断语义**（band fill + insufficient 0.4 opacity + untrained 受抑），不退回 design 的 3-tone。
- `hub` vs `atomic`：design 按 `n.kind`；生产无 kind 字段 → 用 `node.parent_id == null`（root=hub r=24）或有无 children 判定。**或**直接沿用生产现行 `nodeRadius(mistakeCount)`（12 + min(20, mistakes*4)，半径∝错题，design-brief §半径∝mistake_count，已被单测锁）。**决定：半径继续用 `nodeRadius`（保留生产语义），不引入 design 的 hub/leaf 固定半径**——这是生产刻意的诊断编码。arc/track 的 r 跟随该半径。
- 三信号叠加（保留生产 Slice 2 编码）：band fill（背景）+ shaky-prereq `--again` double ring（border）+ overdue coral halo（underlay/外圈）。SVG 版：halo = disc 外再画一个低 opacity coral `<circle>`；shaky ring = focus 时给 prereq 源节点加 `--again` 描边 class。

**边**（design L47-58 + ⑤）：
- `<path d="M{A} L{B}" class="mesh-edge2 rel-{rel}" strokeDasharray={dash} markerEnd={arrow?url(#arrow)}>`
- 中点 label `<text class="mesh-edge-label">{glyph} {label}</text>`
- **token 校正（issue 明确要求，recon B §⑤）**：生产 `RELATION_VISUAL`（L27-33）是真相源，**不退回 design data.jsx 的 tone**：
  - `prerequisite` → `--coral` solid arrow ✓
  - `applied_in` → `--info` solid arrow（生产）；design mock 写 good，**用生产 --info**
  - `derived_from` → `--ink-5` solid arrow（生产）；design mock 写 hard，**用生产 --ink-5**
  - `contrasts_with` → `--contrasts`(#8a5a9e purple) no-arrow（生产）；design mock 写 hard(amber)，**用生产 --contrasts**（token 已核存在 globals.css L172 light / L325 dark）
  - `related_to` → `--ink-4` dashed no-arrow ✓
- design 的 glyph（→ — ⇆ ↦ ↳）+ 中文 label（前置/相关/对照/应用于/派生自）= 生产 `RELATION_LABEL`（L43-49）。建一个 `REL_CUE` 等价表融合 `RELATION_VISUAL`（色/dash/arrow）+ glyph + label。
- **tree edge（parent_id 骨架）保留**：design 没画 tree-as-edge（它树视图单列），但生产图谱要 mesh-over-tree（`--ink-5` dashed 低 opacity z 底层）。SVG 按 z 顺序：先画 tree path，再 mesh path，再 proposed，最后 node `<g>`。

**proposed edge（AI 提议，硬约束① + Slice 3）**：
- design 没有 on-graph proposed edge（它的 proposals 只在抽屉）→ **保留生产独有的 on-graph 渲染**：dotted、opacity 0.5、`--info` source marker、per-relation 色 tint、z just-above-mesh（当前 buildStylesheet L514-565 的语义）。
- 点 proposed edge → inline accept/dismiss popover at 边中点（生产 L859-874）。SVG 版中点 = `((Ax+Bx)/2, (Ay+By)/2)` 经 `view` transform 换算到容器 px（替代 cytoscape `edge.renderedMidpoint()`）。

**marker / filter defs**（design L71-78）：
- `<marker id="arrow">` 三角箭头
- `<filter id="nodeShadow"><feDropShadow dy=2 stdDeviation=3 floodColor="rgba(60,50,30,0.18)">`
- **id 唯一性**：页面只一个图实例，但 `next/dynamic` + 潜在多 mount → 用稳定但唯一的 id（如 `kg-arrow` / `kg-nodeShadow`），或 `useId()` 前缀。recon A §关键注意①。

## 2.5 交互保留接法（硬约束① 全清单 → SVG 实现映射）

| 生产交互 | cytoscape 现状 | SVG 重写实现 |
|---------|---------------|-------------|
| tap 节点 → 开抽屉 + focus | `cy.on('tap','node')` → `onNodeClick(id)` + `setFocusId` | 节点 `<g onClick>` → 同 `onNodeClickRef.current(id)` + `setFocusId` |
| selectedId → 节点高亮 | 独立 effect `node.select()` (L929-939) | `selectedId` prop → SVG class 条件（coral 描边），React 渲染即反映，无独立 effect |
| focus mode（1-hop 邻域高亮 + 其余 fade + fit） | `closedNeighborhood` + `cy.animate fit` (L771-804) | 自算邻居集（filter edges by from/to == focusId）→ 非邻域节点/边加 `kg-faded` class；fit = 计算邻域 bbox 设 `view`（带 CSS transition 或 rAF 插值，280ms） |
| shaky-prereq ring | `incomers('edge[rel=prereq]').sources()` + isWeakish | 自 filter prereq edges where to==focus → 源节点 isWeakish → 加 `--again` ring class |
| due halo | underlay (L460-467) | disc 外画 coral 低 opacity `<circle>`（overdue>0） |
| domain/mastery/dueOnly/看我哪里弱 chip | React state（已与 cytoscape 解耦） | **零改动**（`filter` state + `passesFilter` 保留；`visibleNodes/Edges/Proposals` memo 保留，只是消费方从 buildElements 变 SVG map） |
| focusBar ←返回全图 | React | 零改动 |
| 点 proposed 边 → inline accept/dismiss | `cy.on('tap','edge[proposed]')` + renderedMidpoint | path `onClick` → `setActiveProposal` at 自算中点；popover JSX 零改动（L1054-1089） |
| 点空画布 → exit focus + close proposal | `cy.on('tap', cy)` | stage div `onClick`（target==stage，非节点/边）→ `setFocusId(null)+setActiveProposal(null)` |
| pan/zoom → close proposal | `cy.on('pan zoom')` | `onMove`/`zoom` → `setActiveProposal(null)` |
| 暗色模式 | MutationObserver restyle | **删除**——SVG `var()` 天然跟随 `data-theme`，零 JS |
| 拖拽保留位置不 rebuild | cytoscape 内建 | layout 算一次缓存（useMemo by nodes/edges）；pan = view transform，不重算坐标 |

**未来 YUK-249 subject 派生轴留口**（硬约束①）：`distinctDomains` 用 `effective_domain ?? domain`（L583-590），domain chip 已是派生轴消费方。SVG 重写**不动这条派生链**，subject 改名时 domain filter 自动跟随。注释标注此处为 YUK-249 接入点。

## 2.6 Part 2 风险点

- **布局退化**（最高）：fcose headless 在生产真实图的稳定性 + 初始 fit 缩放。缓解：§2.2 阈值分支 + 视觉环用 synthetic seed（7-9 点）+ 构造 ~50/200 点 fixture 多规模截图。
- **初始 zoom 过大**：生产已有 "点太大了" 修复（clampInitialZoom k≤1，L831-844）→ SVG 版同样在 fit 后 clamp `view.k ≤ 1`。
- **hit-test 细线**：边 path 细，点击难命中。SVG 加透明粗 stroke 兄弟 path（clickable 区扩展），或 `stroke-width` hit-area。recon B §④。
- **中点 px 换算**：proposed popover 锚点需把 SVG 坐标经 `view`（translate+scale）+ 容器 offset 换算，替代 `renderedMidpoint`。单测 + 手测拖拽后位置。
- **animationDelay 错峰**：节点多时 `i*50ms` 尾部延迟过长（200 点 = 10s）→ 给 delay 设上限（如 `min(i*50, 800)ms`）或仅首屏可见节点动画。
- **依赖移除连锁**：移 cytoscape 前 grep 全仓引用（确认仅 KnowledgeGraph.tsx + 其 test）。若选方案②保留 fcose headless 则**不移依赖**，只移 `cytoscape` 的渲染用法。

---

# 测试计划

## Part 1（CSS）
- 无单测（纯样式）。验证 = `pnpm build`（globals.css 编译）+ 视觉环（见 §视觉验收）。
- 防回归：改后 grep `--shadow-[123]:` = 12 行；grep `nav-item.is-active::before` 存在；`btn-primary` dark 覆盖存在。

## Part 2（组件 + 纯函数）
- **保留并必须仍绿**：`src/ui/KnowledgeGraph.test.ts` 中 rendering-agnostic 部分（`masteryBand`/`isWeakish`/`passesFilter`/`distinctDomains`/`nodeRadius`/`RELATION_VISUAL` 形态）。
- **删除/重写**：`buildElements`/`buildStylesheet`/`buildProposedEdgeElements` 的测试（这些函数被删）→ 替换为 SVG 层的等价断言。
- **新增** `src/ui/knowledge-graph/layout.test.ts`：
  - radial-by-depth 分支：同 design 公式，小图确定性坐标
  - fcose-headless 分支：给定 nodes/edges 返回每节点有限 `{x,y}`、无 NaN、节点数守恒
  - 阈值切换正确
- **新增** SVG 渲染层单测（`@testing-library/react`，jsdom）：
  - 渲染 N 节点 → N 个 `.mesh-node2 <g>`，band class 正确，arc dashoffset = circ*(1-mastery)
  - tree/mesh/proposed edge path 数 + z 顺序（DOM 顺序）
  - 5 类 rel 的 dash/arrow/color 映射（用生产 RELATION_VISUAL，**不是** design mock tone）
  - tap 节点 → onNodeClick 调用；点空白 → exit focus；点 proposed → onProposalDecision 路径
  - pan/zoom transform 更新；zoom clamp [0.5,2]；wheel preventDefault
  - selectedId / focus / due-halo / shaky-prereq class 条件
- **分区正确（CLAUDE.md 铁律）**：全部新测试**无** DB/R2/AI/PgBoss/drizzle/postgres import → **unit 分区**（`src/ui/**/*.test.ts`）。jsdom 在 unit config。改后跑 `pnpm audit:partition`。
- watch loop：`pnpm test:unit:watch src/ui/knowledge-graph`。

## Pre-PR gate（两 Part 共用）
`pnpm typecheck` → `pnpm lint` → `pnpm audit:partition` → `pnpm test:unit`（图谱）→ `pnpm build`（CSS + Next route export，YUK-67 必跑）。schema/profile audit 与本任务无关但 gate 含。

---

# 视觉验收（边做边看，对照 design 原型）

参照项目惯例（playwright 截图 + 原生视觉 + visual-verdict 对照 `/tmp/design-graph/loom-refresh/project/Loom.html`）：
- **Part 1**：topbar / nav active tick / btn-primary / hero / section-label / 卡片阴影，light+dark 双主题截图，逐项对 refine.css 目标。
- **Part 2**：图谱节点入场错峰淡入、arc 增长动画、hover scale、5 类边 dash/glyph/箭头、pan/zoom、zoom controls pill、dot-grid 背景、legend。多规模（synthetic 7 点 / 构造 50 / 200 点）核布局不退化。light+dark。
- **先查 :3000 谁占着再 pnpm dev:local**（OrbStack 容器长期占 :3000，会跳 :3001；curl :3000 拿的是容器旧 build）。本地入口用 `pnpm dev:local`（compose Postgres :5433 真相源）。

---

# Commit 切分

**Part 1（精修，1 commit 或按 R 族 2-3 commit）**：
1. `style(globals): premium shadow layering + dark sync (R1) (Refs YUK-297)` — shadow 四处 + btn dark 覆盖
2. `style(globals): chrome refinements — nav tick, topbar, btn-primary coral lift (R4/R5/R6) (Refs YUK-297)`
3. `style(globals): rhythm + numerals + hairlines (R2/R3/R7/R8/R9 + card/sidebar/eyebrow) (Refs YUK-297)`

**Part 2（图谱重写，按依赖顺序）**：
4. `refactor(knowledge-graph): extract layout engine + radial/fcose-headless (Refs YUK-297)` — layout.ts + 单测
5. `feat(knowledge-graph): SVG render layer replacing cytoscape (Refs YUK-297)` — KnowledgeGraphSvg + node/edge/arc/animation
6. `feat(knowledge-graph): port pan/zoom + focus + inline proposal to SVG (Refs YUK-297)` — 交互保留
7. `style(globals): mesh SVG styles — disc/track/arc/edge/zoom-pill (Refs YUK-297)` — kg CSS 段
8. `test(knowledge-graph): SVG render + layout tests; drop cytoscape element tests (Refs YUK-297)`
9. `chore(deps): remove cytoscape (Refs YUK-297)` — **仅当**选纯 SVG 去依赖；选方案②保留 fcose 则此 commit 不存在
10. `style(globals): edge token correction note + YUK-249 derived-axis seam comment (Refs YUK-297)`（小）

> 末 commit 前补 Linear gate + `Closes YUK-297`（若整 issue 完成）。trailer 含 Co-Authored-By。

---

# 风险点汇总（跨 Part）

| 风险 | Part | 级别 | 缓解 |
|------|------|------|------|
| R1 shadow 四处漏同步 | 1 | 中 | grep 计数 12 行；light/dark 成对核 |
| R1 加深波及 15+ 引用 | 1 | 中 | dark 视觉环多视角 |
| R5 nav tick 被 overflow 裁剪 | 1 | 高 | impl 先核 rail overflow/padding，退路 left:0 |
| R6 coral glow dark 过曝 | 1 | 高 | dark block 覆盖低 opacity（值块 D 补丁）必做 |
| 布局退化（真实图数百点） | 2 | 高 | 方案②fcose headless + 阈值分支 + 多规模 fixture 视觉环 |
| 初始 fit 缩放过大 | 2 | 中 | clamp view.k≤1（沿用生产修复语义） |
| 细边 hit-test | 2 | 中 | 透明粗 stroke clickable 兄弟 path |
| proposed 中点 px 换算 | 2 | 中 | 自算中点经 view transform；单测+手测 |
| animationDelay 尾部过长 | 2 | 低 | delay 上限 |
| 删 cytoscape 连锁 | 2 | 低 | grep 全仓引用；方案②不删依赖 |
| 抽屉/proposal mutation 误伤 | 2 | 中（硬约束①） | page.tsx 零改动；props 契约不变；SVG 仅替换图内部 |
| 丢失生产诊断编码（band/sentinel/三信号叠加） | 2 | 高（硬约束①） | adapter 用生产 masteryBand/MASTERY_BAND_TOKEN，不退回 design 3-tone |

---

# 附：硬约束逐条核对

- **① 不丢生产功能**：§2.1 props 契约不变 + §2.5 全交互映射表 + §2.4 adapter 保留 band/三信号/proposed + page.tsx 抽屉零改动。YUK-249 派生轴 §2.5 留口注释。✅
- **② 精修写 globals.css 作默认**：Part 1 剥 `[data-refine]` gate 直写既有块。✅
- **③ 沿用现有 token**：§0.3 核全部 token 存在；§2.4 edge 用生产 RELATION_VISUAL；无新色。✅
- **④ shadow 四处同步**：Part1 #1-4 + dark btn 覆盖，§风险 R1。✅
