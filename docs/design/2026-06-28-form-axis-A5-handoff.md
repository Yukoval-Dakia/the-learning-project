# 形态轴 A5 — /knowledge 探索面 felt-experience 功能 handoff（给 claude design）

- **date**: 2026-06-28
- **status**: functional handoff（**零风格规定**）—— 视觉稿由 claude design (claude.ai/design) 出，回来 slice-by-slice 实现
- **epic**: 形态轴 epic（YUK-354）/ gate doc `docs/design/2026-06-15-rethink-implementation-gate.md` §2.5
- **scope 一句话**: 把 /knowledge 从「会转的关系图 + 一堆裸百分比节点」升成**可探索的双层异构认知图**——节点的 mastery/难度永远带置信、来源（硬轨校准 vs 先验回吐）可分、能从一个节点下钻到它的诊断画像，且图大了仍可读。

> 这是**功能** handoff：只描述探索面该让 owner**理解什么、能做什么**，**不规定任何视觉风格/布局/配色/组件选型**——那是 claude design 的活。所有呈现构建于既有 **loom design 系统**（mesh 节点三层结构、typed-edge 非颜色 cue、MasteryRing、drawer 形态都已存在，见下文锚点）。实现回来后按项目 design tokens/primitives 落地，并走 design-doc pre-flight。

---

## 0. owner 想解决的问题

知识图是这个工具的「认知地图」。今天它已经能画出来（树 + 5 类 typed 关系的 mesh，可平移缩放），但它在三件事上撒谎或失语：

1. **裸数字撒谎**：每个节点渲染一个干净的「78」百分比（`MeshGraph.tsx:219`、`MasteryRing.tsx:60`），但 mastery 是**慢热 n=1 估计**——刚开始全是冷启先验，根本不可信。一个从没练过的节点和一个练了 20 次稳定在 0% 的节点，今天**长得一模一样**（都红、都显「0」）。owner 看不出哪个数字能信。
2. **来源不分**：节点的 θ̂ 可能来自 owner 真实作答（硬轨 firm-up），也可能来自 LLM 先验回吐 / 图上邻居借来的软估计（prior-echo）。今天屏幕上无法区分——一个借来的猜测和一个挣来的事实显示成同一个数。
3. **下钻断头**：节点详情页能看到笔记/邻居/时间线，但看不到**诊断画像**——「这个 KC 我到底错在哪个认知 attribute」「这道题区分度如何」。四引擎全实例化付了「诊断丰富度」的成本，但这层数据没有入口。

再加两个结构性缺口：**误区（misconception）节点**是双层异构图的另一层（错误也是认知地图的一部分），今天图上根本没有它；**图大了会崩**——5000 节点 OOM 截断 + 全量灌进一个 SVG。

A5 = 把这张图从「装饰性关系图」变成「**诚实、可下钻、可承载规模**的认知探索面」。

---

## 1. 现状锚点（先 Read，再设计——这些是真代码，不是设想）

| 现状对象 | 文件:行 | 它今天做什么 / 反模式 |
|---|---|---|
| 图谱视图 | `src/capabilities/knowledge/ui/MeshGraph.tsx` | 轻量 SVG mesh，pan/zoom，5 类 typed 边非颜色 cue（`REL_CUE` L23-32：glyph + dash + 箭头）。三层节点：填充 disc → 满轨底环 → 掌握度弧（L195-217）。**反模式**：节点中心渲染裸 `pct`（L177 `Math.round(m*100)`、L219 `{pct == null ? '—' : pct}`）。 |
| 节点详情抽屉 | `src/capabilities/knowledge/ui/NodeDrawer.tsx` | 头部 MasteryRing + 三指标（掌握度/evidence/decay，L213-231）、层级/typed 关系分离、AI 边提议四动作、建边表单。**反模式**：`pct = Math.round(node.mastery*100)`（L182）→ node-metrics 显「78%」裸值（L215）。 |
| 节点详情页 | `src/capabilities/knowledge/ui/KnowledgeDetailPage.tsx` | hero（MasteryRing + decay bucket + evidence）+ 两栏（笔记按 kind 分组 / 邻居按关系分组 / 反链 / 活动时间线）。**反模式**：`pct = Math.round(node.mastery*100)`（L159）→ hero badge 显「M 78%」（L193）。 |
| 图谱页 host | `src/capabilities/knowledge/ui/KnowledgePage.tsx` | 树/图谱 seg 双视图 + AI 边提议横幅 + 树行（MasteryRing + decay Badge + evidence/mesh 计数）+ NodeDrawer。 |
| 共享掌握度环 | `src/ui/primitives/MasteryRing.tsx` | **裸数字病灶的根**：L23 `pct = Math.round(m*100)`，L60 把 `{pct}` 渲进环心，L36 `aria-label="掌握度 ${pct}%"`。树行/抽屉头/节点页 hero/子节点行**全用它**——替裸数字得从这个 primitive 改起。 |
| 掌握度→色调 | `src/capabilities/knowledge/ui/mastery-tone.ts` | `masteryTone`：≥0.67 good / ≥0.45 hard / else again。**反模式**：`NULL（从没练）→ 0 → 'again'/红`（L17-19 + 注释明说「证据不足那个灰被故意丢了」）——冷启节点和真·0% 节点**同色同数**，来源/置信全抹平。 |
| 树快照加载 | `src/capabilities/knowledge/server/tree.ts:37` | `LOAD_TREE_SNAPSHOT_LIMIT = 5000` —— 全量灌内存 + 全量喂 MeshGraph。>5000 节点 → 任意 5000 行截断（已加 `ORDER BY id` 让截断确定，L84）。**这是大图可读性退化的根**（详见 §5 基础设施缺口）。 |

**裸数字违规——gate doc §1.5.2 点名的真违规，确证 4 处**：
`MeshGraph.tsx:177/219`、`NodeDrawer.tsx:182/215`、`KnowledgeDetailPage.tsx:159/193`、`MasteryRing.tsx:23/60`。这些全是 `Math.round(node.mastery * 100)` 渲染干净「78%」。handoff 要求**替它为带置信的呈现**（见 §4 ⑥）。

---

## 2. 探索面应呈现什么（功能层，非视觉）

> 下面是 gate doc §2.5 列的整轴功能面。每条只说「该让 owner 理解/做什么」，不说怎么画。

### 2.1 双层异构图（KC 层 + 误区层）
图今天只有**一层**：知识点（KC）节点 + 5 类 typed 边。双层异构 = 在同一张图里**叠上误区（misconception）层**——误区也是认知地图的实体（「我总把 A 误当 B」），它挂在相关 KC 上。功能要求：
- 两类节点**可视区分**（KC vs 误区是不同语义实体，不是同一类节点的状态）。
- 误区节点连到它所诊断的 KC（关系语义：这个误区是这些 KC 上的典型错误）。
- **关键约束**：误区层今天**无读路径**（misconception 表是 dormant skeleton，无 writer/route，见 §5）。视觉稿应**设计这一层的位置与形态**，但实现时它会先是**空层**——空态见 §3。

### 2.2 frontier 可供性（「下一步学什么」的可供性）
图不只是回顾已学，还要指出**可达前沿**——哪些 KC 是「prerequisite 已掌握、自己还没碰」的下一步候选。功能要求：把这种「frontier 节点」在图上**标记为可供性**（owner 一眼看到「这几个是我现在该去的地方」），并提供「去练它」的动作入口。**注意**：frontier 的判定逻辑（哪些算 frontier）属算法侧，本 handoff 只要视觉承载「这是 frontier，这里有个入口」。

### 2.3 节点详情承载三类诊断（B1 三维 + RT2 credit + RT1 误区）
节点详情（抽屉 + 详情页）今天承载 mastery/evidence/decay/笔记/邻居/时间线。A5 要它**额外承载**：
- **B1 三维**：mastery 不是一个数，是 (掌握度点估计 + 置信区间 + 来源)。见 §4 ⑥。
- **RT2 credit**：这个 KC 的 mastery 是**多 KC 归因**摊来的（一道题挂多个 KC，答对/错按 credit-assignment 分摊，见 `mastery/state.ts` updateThetaForAttempt 多 KC 语义）。owner 想理解「这个数有多少是这个 KC 自己挣的 vs 连坐来的」——至少要能看到该 KC 的 evidence 构成。
- **RT1 误区**：这个 KC 上挂了哪些误区（来自 §2.1 的误区层），以及该误区的典型表现。

### 2.4 诊断下钻入口（CDM attribute 画像 / IRT 区分度）
节点详情页要提供**下钻入口**，承载更深的诊断：
- **CDM attribute 画像**：这个 KC/题的认知 attribute 分解（slip/guess 画像，来自 `item_calibration.cdm_json`）。
- **IRT 区分度**：题目区分度（`item_calibration.irt_a`）。
- **诚实约束（重要）**：这两层在 n=1 下**结构性不可估**——schema 注释明说「`irt_a` 区分度——Stocking 1990 不可估」「`cdm_json` CDM slip/guess 画像」当前是 NULL 占位列（`schema.ts:1097-1099`，audit allowlist `kind:'manual'`）。所以诊断下钻**今天大概率是空的/「不可估」态**。视觉稿要**设计这个下钻入口与画像的形态**，但它必须能优雅地表达「此维度在 n=1 下不可估」而不是显示一个假的区分度数字。空态/不可估态见 §3。

### 2.5 大图可读性（规模退化）
见 §5 基础设施缺口——这条**需要后端先做视口化/分页**才能在前端真正解决；视觉稿可以**设计聚合视图/分层展开的形态**（如「先看 domain 簇，点开再看 KC」），这本身是 progressive disclosure 的形态问题（连到 §6 owner 留白：是否接 YUK-297）。

---

## 3. 空态 / 失信兜底 / 故障态（显式功能约束，非可选）

A5 是异构图 + 多数据源 + 慢热估计，每一处都有「数据还没来 / 来了不可信 / 取数失败」三态。这些**不是边角，是核心功能约束**——视觉稿必须为每一条出态。

### 3.1 空态（数据结构上还没有）
| 场景 | 真实触发条件 | 功能要求 |
|---|---|---|
| **空图** | `nodes.length === 0`（`KnowledgePage.tsx:155`，新用户/空库） | 已有 EmptyState「知识网为空 · 录入材料后 AI 抽取节点」。保留语义，但要接「冷启 day-one 靠先验也得能用」的产品线——即便空库，引导去录入/去看 seed root。 |
| **误区层空** | misconception 表无任何行（**今天恒成立**，dormant） | 双层图的误区层是**空层**。不是错误，是「还没诊断出误区」。视觉稿设计的误区层在此态下应**优雅退化为不显示/占位**，不能留一个空壳框。 |
| **诊断下钻空/不可估** | `item_calibration.cdm_json` / `irt_a` 为 NULL（**当前几乎全部如此**） | 下钻入口存在，但内容是「此维度在 n=1 下结构性不可估」的诚实说明，**不是**一个假数字、不是 loading 转圈、不是空白。 |
| **节点无 evidence** | `evidence_count === 0`（从没练过的 KC，cold-start 盲区） | 这是 gate doc 强调的「冷启盲区」——突出「从没练过」让 owner 可去补练（行为驱动）。**绝不**显示成红色「0%」（那是 `masteryTone` NULL→0→again 的现行 bug，见 §4 ⑥）。 |
| **节点无笔记/无邻居/无反链/无活动** | 各 section 数组空 | 已有 quiet-empty 文案（`KnowledgeDetailPage.tsx:330/373/409/445`），保留。 |

### 3.2 失信兜底（数据来了但不可信——这是 A5 的灵魂）
| 场景 | 真实触发条件 | 功能要求 |
|---|---|---|
| **冷启低置信** | `theta_se` 大 / `cold_start === true`（evidence < 4 OR precision ≤ 1，见 `calibration-maturity.ts:39-47`） | mastery **不渲染干净点估计**——渲染区间/低置信标记。owner 只该读「相对排序 + 可信/不可信」，不读精确百分比（ADR-0035 §决定1）。见 §4 ⑥。 |
| **来源是 prior-echo** | mastery 来自 LLM 先验 / 图借（`applyKgSoftLayer` 的 borrowed 条目 `low_confidence:true`，`mastery/state.ts:499-526`），非真实作答 | 数值旁**来源二态可分**：硬轨 firm-up（挣来的）vs 软轨 prior-echo（借来/猜来的）。见 §4 ⑥。 |
| **截断图** | `loadTreeSnapshot` 命中 5000 cap（`tree.ts:88` warn `tree_snapshot_truncated`） | 图**不能假装完整**——必须告知 owner「这张图被截断了，你看到的不是全部」。否则 owner 在一张少了节点的图上做判断。 |

### 3.3 故障态（取数失败）
| 场景 | 真实触发条件 | 功能要求 |
|---|---|---|
| **树/边加载失败** | `treeQ.isError`（`KnowledgePage.tsx:153`） | 已有「知识图加载失败：{message}」。保留，但 A5 多源后要分清「树挂了」vs「诊断画像挂了」——局部失败不该让整图白屏。 |
| **节点页取数失败** | `getNodePage` reject（`KnowledgeDetailPage.tsx:148` → 「节点不存在或已归档」） | 区分「节点真不存在/已归档」（404 语义）vs「取数网络失败」（可重试）——今天两者都落到同一句。 |
| **抽屉内 node-page best-effort 失败** | `nodePageQ` error（`NodeDrawer.tsx:159-164`，互动产物 section 取数） | 已有 best-effort 语义（空/失败整块不渲染）。A5 的诊断下钻若也走抽屉内取数，沿用 best-effort，但**不可信**与**取数失败**是两回事，别混。 |

---

## 4. ⑥ 硬约束（A5 重灾区 —— owner 选最强档，gate doc §1.5.2 升为前端必须渲染）

> 这一节是 A5 与别条形态轴最不同的地方。owner 明确裁定：mastery/难度的呈现是**硬约束**，不是建议。视觉稿**必须**为这四条出形态，否则视觉稿不合格。

### ⑥-1 mastery / 难度绝不裸数字
- **禁止**：任何地方渲染干净的「掌握 78%」「难度 3.2」点估计。
- **要求**：绝对值一律带**置信区间 / 低置信标记**呈现。成熟度是「可信/不可信 + 相对位置」，不是精确百分比。
- **当前违规**（必须替换）：`MasteryRing.tsx:60`（环心 `{pct}`）、`MeshGraph.tsx:219`、`NodeDrawer.tsx:215`、`KnowledgeDetailPage.tsx:193`。
- **wire 已就绪**：后端 `MasteryProjection`（`mastery/state.ts:294-311`）已算出 `mastery` + `mastery_lo` + `mastery_hi` + `low_confidence` + `theta_se`——但**这些 CI 字段在 wire 边界被丢弃**（tree/node-page 只透 `mastery`，见 §5）。视觉稿按「点 + 区间 + 低置信标记」设计；wire 补字段是 §6 基础设施活。

### ⑥-2 来源二态可分（硬轨校准 vs prior-echo）
- **要求**：数值旁至少**二态可视区分**：① 硬轨真实作答校准（firm-up，owner 挣来的）vs ② 软轨 LLM 先验回吐 / 图借（prior-echo，借/猜来的）。
- **判据来源**：firm = 有 mastery_state 行 AND evidence ≥ 4 AND precision > 1（`calibration-maturity.ts:42-47` `isColdStart` 取反）；prior-echo = 无 mastery_state 行（冷启先验）或 KG 软层 borrowed 条目（`low_confidence:true`）。
- **当前违规**：`masteryTone`（`mastery-tone.ts:17-19`）把 NULL（从没练）→ 0 → 'again'/红——**冷启先验节点和真·失败节点同色同数**，来源被抹平。视觉稿要让这两类**永远不同形**。

### ⑥-3 诊断下钻入口（承载 CDM attribute 画像 / IRT 区分度）
- **要求**：节点详情页提供**下钻入口**，承载 CDM attribute 画像（`cdm_json`）/ IRT 区分度（`irt_a`）。
- **诚实约束**：这两维在 n=1 下**结构性不可估**（`schema.ts:1097` 注释 + B1 foundation §6.3）。当前列几乎全 NULL。下钻态必须能表达「**此维度不可估**」而非伪造数字。视觉稿设计入口与「可估时的画像形态」+「不可估时的诚实退化」两态。

### ⑥-4 截断不可隐瞒
- **要求**：图命中 5000 cap 时（`tree.ts:88` warn），UI 必须**显式告知 owner 图被截断**——你看到的不是全部节点。这是失信兜底（§3.2）里最容易被忽略、但 gate doc 点名的硬约束。

---

## 5. 数据契约（wire 形状 + 真实 sample，no-mock）

### 5.1 树快照 wire（图谱 + 树视图喂数据）— `GET /api/knowledge`
当前 wire 类型 `KnowledgeTreeNode`（`knowledge-api.ts:8-16`）：
```ts
interface KnowledgeTreeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  effective_domain: string | null;
  mastery: number | null;       // 0..1，点估计
  evidence_count: number;
}
```
真实 sample（一行）：
```json
{ "id": "k_3f2a", "name": "等比数列求和", "domain": null, "parent_id": "k_root_math",
  "effective_domain": "math", "mastery": 0.78, "evidence_count": 12 }
```
**契约缺口（⑥ 要的字段不在 wire 上）**：`mastery_lo` / `mastery_hi` / `low_confidence` / `theta_se` / `cold_start` / 来源二态标记**全部缺失**。后端 `getMasteryProjection`（`mastery/state.ts`）算出了前四个，但 `tree.ts:105` 只取 `proj.mastery`，丢了 CI 字段。误区层节点 + frontier 标记也无 wire。→ §6 基础设施缺口。

### 5.2 节点页 wire（详情抽屉 + 详情页）— `GET /api/knowledge/:id`
当前 wire 类型 `KnowledgeNodePage`（`knowledge-api.ts:85-118` / `node-page.ts:101-128`），关键字段：
```ts
{
  id, name, domain, parent_id, parent_name, effective_domain,
  mastery: number | null,            // 0..1 点估计
  evidence_count: number,
  last_evidence_at: string | null,
  mastery_decay_bucket: 'untrained' | 'fresh' | 'mild' | 'stale' | 'unknown',
  children: { id, name, mastery }[],
  mesh_neighbors: { edge_id, knowledge_id, name, relation_type, direction: 'out'|'in', weight }[],
  primary_atomic, notes, interactive_artifacts, backlinks, backlinks_by_type, timeline
}
```
真实 sample（节点 metadata 部分）：
```json
{ "id": "k_3f2a", "name": "等比数列求和", "effective_domain": "math",
  "mastery": 0.78, "evidence_count": 12, "last_evidence_at": "2026-06-25T08:14:00.000Z",
  "mastery_decay_bucket": "fresh",
  "children": [{ "id": "k_8b1", "name": "无穷等比", "mastery": null }],
  "mesh_neighbors": [{ "edge_id": "e_91", "knowledge_id": "k_2c0", "name": "等差数列",
    "relation_type": "contrasts_with", "direction": "out", "weight": 0.6 }] }
```
**契约缺口**：同 §5.1——`mastery_lo/hi`、`low_confidence`、`theta_se`、`cold_start`、来源二态**缺失**；CDM 画像（`cdm_json`）/ IRT 区分度（`irt_a`）**无下钻 wire**；误区（misconception）**无 wire**。

### 5.3 已存在的相邻 read model（可复用/可参照）— `GET /api/observability/calibration-maturity`
`calibration-maturity.ts` 已经算出了 A5 ⑥ 需要的大部分置信/来源信号，但它是**独立 observability 端点**，按 `knowledge_id` 列出，**没接进 /knowledge 探索面**：
```ts
CalibrationMaturityRow {
  knowledge_id, name,
  evidence_count: number,
  theta_se: number | null,        // 现算（不持久化），无 mastery_state 行 → null
  confidence: number | null,      // 该 KC 关联题的平均标定置信度
  track: string | null,           // 主导标定轨道（hard/soft）
  cold_start: boolean             // firm ⟺ evidence≥4 AND precision>1
}
```
真实 sample：
```json
{ "knowledge_id": "k_3f2a", "name": "等比数列求和", "evidence_count": 12,
  "theta_se": 0.41, "confidence": 0.83, "track": "hard", "cold_start": false }
```
冷启盲区行（从没练）：
```json
{ "knowledge_id": "k_9d7", "name": "数学归纳法", "evidence_count": 0,
  "theta_se": null, "confidence": null, "track": null, "cold_start": true }
```
→ **设计含义**：A5 的置信/来源呈现**不需要新算法**——这些信号已存在。缺的是把它们**接进 /knowledge 节点 wire**（§6）。视觉稿可把 `theta_se` / `cold_start` / `track` 当作「将会在每个节点上可用」的字段来设计。

---

## 6. 基础设施缺口（needs issue）

A5 有真实的后端缺口，**不要在视觉稿/前端硬塞**——它们需要独立后端工单。返回草案如下：

### 缺口 1（gate doc 明确点名）— 大图可读性：视口化 / 分页 / 聚合加载
- **现状锚点**：`src/capabilities/knowledge/server/tree.ts:37` `LOAD_TREE_SNAPSHOT_LIMIT = 5000` —— `loadTreeSnapshot` 全量灌内存（`tree.ts:58-125` 建 byId map + walk parent chain），再**全量喂** MeshGraph（`KnowledgePage.tsx:212` `<MeshGraph nodes={nodes} ...>`），MeshGraph 把每个节点渲进一个 SVG（`MeshGraph.tsx:173-233`，无视口剔除）。
- **问题**：>5000 节点 → 任意 5000 行截断（`tree.ts:88` warn `tree_snapshot_truncated`）；即便 <5000，全量 SVG 在数百节点就开始卡 + 不可读。
- **已存在的 phase-deferred 计划**：`tree.ts:22-37` docblock 指向 **YUK-236** 的 recursive-CTE / 增量 walk 重写。
- **需要**：① 后端视口化/按需子树加载（CTE-based，子树/邻域 scope）；② 聚合视图（先 domain 簇、点开再 KC）；③ 前端视口剔除（只渲可见 + 邻接节点）。
- **建议**：新建 Linear issue「A5 大图可读性 — 知识图视口化/分页加载」，挂 form-axis epic（YUK-354），关联/可能合并 **YUK-236**（已是 CTE-rewrite follow-up）。area: knowledge。

### 缺口 2 — 置信/来源 wire：把 CI 字段 + cold_start + 来源二态接进 /knowledge 节点 wire
- **现状锚点**：`getMasteryProjection`（`mastery/state.ts:294-393`）已算 `mastery_lo/hi/low_confidence/theta_se/beta`；`calibration-maturity.ts` 已算 `cold_start/theta_se/confidence/track`。但 `tree.ts:105` 只透 `proj.mastery`、`node-page.ts:394` 只透 `nodeMastery?.mastery`——**CI/来源字段在 wire 边界被丢弃**。
- **需要**：扩 `KnowledgeTreeNode` + `KnowledgeNodePage` wire，携带 `mastery_lo/hi`、`low_confidence`、`theta_se`、`cold_start`、来源二态标记（firm vs prior-echo）。否则 ⑥-1/⑥-2 前端无米下锅。
- **建议**：新建 Linear issue「A5 — mastery 置信/来源字段接入 /knowledge 节点 wire」，挂 YUK-354。area: knowledge。**这是 ⑥ 硬约束落地的前置依赖**。

### 缺口 3 — 误区（misconception）层读路径
- **现状锚点**：`schema.ts:109-131` misconception 表是 **dormant skeleton**——「no writer, NO route/job/copilotTool/manifest wiring」，写路径 gated 在 ADR-0034 promotion flow 后。
- **需要**：misconception 节点的 writer + 读路径 + 挂 KC 的关系 wire，双层异构图的误区层才有数据。
- **建议**：新建 Linear issue「A5 — misconception 层读路径（双层异构图第二层）」，挂 YUK-354，依赖 ADR-0036 身份层 / ADR-0034 promotion gate。area: knowledge。视觉稿先按「空层优雅退化」设计（§3.1）。

### 缺口 4 — 诊断下钻 wire（CDM 画像 / IRT 区分度）
- **现状锚点**：`schema.ts:1097-1099` `irt_a`（区分度，「Stocking 1990 不可估」）/ `cdm_json`（slip/guess 画像）/ `kt_json` 是**软轨占位列，本 wave NULL**（audit allowlist `kind:'manual'`）。无下钻 wire。
- **需要**：诊断下钻的读路径（即便多数返回「不可估」）。**注意诚实约束**：n=1 下这些结构性不可估，工单要明确「先做能表达『不可估』的入口，不是伪造可估」。
- **建议**：新建 Linear issue「A5 — 诊断下钻 wire（CDM/IRT，含 n=1 不可估态）」，挂 YUK-354。area: knowledge。**低优先**（数据多为 NULL，是「入口先到位」而非「数据已到位」）。

---

## 7. 留给 owner 拍的开放决策

> 视觉稿/实现都卡在这条之前不必停，但 owner 需要拍。

### 留白 1（gate §2.5 明确问、未决）— A5 是否接 YUK-297？
- **YUK-297** = 知识图谱 SVG 重写 + **渐进披露（progressive disclosure）布局引擎**（已造好）。
- gate doc §2.5 原文问：「已造好的 progressive disclosure 布局引擎（YUK-297）该不该接通」。
- **决策含义**：缺口 1（大图可读性）的「聚合视图 / 分层展开」形态，本质就是 progressive disclosure。如果接 YUK-297，A5 的图重绘 + 大图可读性可能合并到那条引擎上做；如果不接，A5 自己做轻量视口化。
- **需 owner 拍**：(a) A5 直接接通 YUK-297 引擎；(b) A5 做独立轻量视口化、YUK-297 另议；(c) 先视觉稿探形态、接不接后定。**建议把这条交 owner 在看到 claude design 视觉稿后定**（视觉稿会让「分层展开值不值得上重引擎」变具体）。

### 留白 2 — 双层异构图的误区层：本期出形态还是押后？
- 误区层今天**无数据**（缺口 3 dormant）。视觉稿是「现在就设计误区层的位置/形态（即便先空）」还是「KC 层先做扎实，误区层等 misconception writer ship 再设计」？建议 owner 拍。

---

## 8. 边界提醒（给实现者，非 claude design）

- 这是 `src/capabilities/knowledge/` 域的 UI（图谱页/抽屉/详情页/共享 MasteryRing primitive）。
- 构建于既有 loom design 系统：mesh 三层节点、`REL_CUE` typed-edge 非颜色 cue、MasteryRing、drawer 形态都已存在——A5 是**在它们之上加置信/来源/下钻/规模**，不是推倒重画（除非 owner 接 YUK-297 决定重写 SVG 层）。
- ⑥ 硬约束的落地**依赖缺口 2 的 wire 扩展**——前端实现前确认 wire 字段已接，否则只能渲染今天就有的 `mastery` 点估计（= 继续违规）。
- 动 UI 代码前仍走项目 design-doc pre-flight；本 handoff + claude design 视觉稿 = pre-flight 的输入。
