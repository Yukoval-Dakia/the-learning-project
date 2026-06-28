# 知识图谱 — 图重写 + 渐进披露 + 误区层形态 功能 handoff（本批，接 YUK-297）

- **date**: 2026-06-28
- **status**: functional handoff（**零风格规定**）—— 视觉稿由 claude design (claude.ai/design) 出，回来 slice-by-slice 实现
- **epic / 上游**: 形态轴 A5（gate doc `docs/design/2026-06-15-rethink-implementation-gate.md` §2.5 第 5 条）；本 handoff 是 A5 中 **owner 已锁定的本批切片**
- **owner 锁定（不重新论证、不稀释、不扩 scope）**: ① 知识图谱图重写 + 渐进披露 **接 YUK-297，现在就接**；② 双层异构图的**误区层本批出形态、数据后填**；③ ⑥ 硬约束 **mastery 裸数字必带置信 / 低置信标记**（与 YUK-476 协调）。
- **scope 一句话**: 在既有 /knowledge 图谱面上，加三个**新体验维度**——(a) 图从「一次性全量摊开」变成「**起手稀疏、按需展开**」的渐进披露交互；(b) 在同一张图里叠上**误区层**（错误也是认知地图的实体，本批先出形态、先空层）；(c) 节点的 mastery **永远带置信**呈现，干掉裸百分比。

---

## 0. 这是既有屏增量 —— 不是重画整屏（读这段，再往下）

/knowledge 图谱面**已经存在并在跑**：树/图双视图、5 类 typed 关系的 mesh（可平移缩放）、节点详情抽屉、节点详情页、AI 边提议横幅都已落地，构建在既有 **loom design 系统**上（mesh 三层节点结构、`REL_CUE` typed-edge 非颜色 cue、MasteryRing、drawer 形态都已存在，锚点见 §2）。

claude design 要画的是**这三个新维度的视觉形态**，并与既有 loom 视觉语言**协调**，不是推倒重来：

- **渐进披露**：YUK-297 的 SVG 重写 + 布局求解器**已经做完且在线**（`layout.ts` 是 YUK-297 引擎，已被 `MeshGraph.tsx:46` 调用，cytoscape→SVG 重写已完成）。要画的是「起手该显示什么 / 怎么展开一个簇 / 展开态长什么样 / 折叠回去」的**披露交互形态**——求解器已经支持稀疏披露（见 §6），缺的是它上面的交互层。
- **误区层**：在既有 KC 图上叠的**第二类语义实体**的视觉形态（KC 节点 vs 误区节点要可视区分）。
- **置信呈现**：替换掉今天 MasteryRing / mesh 节点中心 / 详情页 hero 里那个干净的「78」的形态。

**这是功能** handoff：只描述该让 owner**理解什么、能做什么** + 硬功能约束 + 各种态。**不规定任何视觉风格 / 布局 / 配色 / 组件选型 / 间距 / 动效**——那是 claude design 的活。实现回来后按项目 design tokens / primitives 落地，并走 design-doc pre-flight。

---

## 1. owner 想解决的问题

知识图是这个工具的「认知地图」。今天它能画出来，但在本批要解决的三件事上失语：

1. **图大了就崩、且一次性全摊开**：`KnowledgePage.tsx:212` 把**全量** `nodes` 直接喂给 `MeshGraph`，MeshGraph 把每个节点渲进一个 SVG（`MeshGraph.tsx:173-233`，无视口剔除、无披露门）。后端 `loadTreeSnapshot` 一次性灌入整个图（`tree.ts:39` `LOAD_TREE_SNAPSHOT_LIMIT = 5000`，超出任意 5000 行截断）。结果：几百节点就开始卡 + 不可读，几千节点 OOM 截断。YUK-297 的布局求解器**本就是为「披露集很小」而设计的**（`layout.ts:210/286` 注释明说「只有被披露/可见的节点才会传进来」），但实际调用把全图灌进去了——**披露引擎在那、披露交互不在**。
2. **误区没有位置**：双层异构图的第二层——误区（misconception）节点（「我总把 A 误当 B」）——是认知地图的一部分，但今天图上**根本没有它的形态**。
3. **裸数字撒谎**：每个节点渲染一个干净的「78」（`MasteryRing.tsx:59`、`MeshGraph.tsx:219`），但 mastery 是**慢热 n=1 估计**——刚开始全是冷启先验，不可信。一个从没练过的节点和一个练到稳定 0% 的节点今天**长得一模一样**（都红、都显「0」/「—」）。owner 看不出哪个数字能信。

---

## 2. 现状锚点（先 Read，再设计——这些是真代码，不是设想）

| 现状对象 | 文件:行 | 它今天做什么 / 反模式 |
|---|---|---|
| 图谱页 host | `KnowledgePage.tsx:212` | `<MeshGraph nodes={nodes} edges={edges}>` —— **全量** `nodes` 直传，无披露/视口门。树/图 seg 双视图 + AI 边提议横幅 + know-node 树行 + NodeDrawer。 |
| 图谱视图 | `MeshGraph.tsx:173-233` | 轻量 SVG mesh（YUK-297 重写产物），pan/zoom，5 类 typed 边非颜色 cue（`REL_CUE` L23-32：glyph + dash + 箭头）。三层节点：填充 disc → 满轨底环 → 掌握度弧（L195-217）。**反模式**：节点中心渲染裸 `pct`（L177 `Math.round(m*100)`、L219 `{pct == null ? '—' : pct}`）；无视口剔除。 |
| 布局求解器 | `layout.ts:1` / `:7` / `:210` / `:286` | **YUK-297 引擎，已在线**：纯坐标求解，与渲染解耦。两支——小披露集走确定性 `tidyTree`；宽兄弟扇（> `FORCE_THRESHOLD=60`）走 cytoscape+fcose headless 径向铺开。注释明说**为「披露集很小」而设计**。**它已具备承接渐进披露的能力，只是上游没做披露交互。** |
| 节点详情抽屉 | `NodeDrawer.tsx:204/215` | 头部 MasteryRing + 三指标（掌握度/evidence/decay）、层级/typed 关系分离、AI 边提议四动作、建边表单。**反模式**：`pct = Math.round(node.mastery*100)`（L182）→ node-metrics 显「78%」（L215）。 |
| 节点详情页 | `KnowledgeDetailPage.tsx:159/193` | hero（MasteryRing + decay bucket + evidence）+ 两栏。**反模式**：`pct = Math.round(node.mastery*100)`（L159）→ hero badge 显「M 78%」（L193）。 |
| 共享掌握度环 | `MasteryRing.tsx:23/59` | **裸数字病灶的根**：L23 `pct = Math.round(m*100)`，L59 把 `{pct}` 渲进环心，L35 `aria-label="掌握度 ${pct}%"`。树行/抽屉头/节点页 hero/子节点行**全用它**——替裸数字得从这个 primitive 改起。 |
| 掌握度→色调 | `mastery-tone.ts:17-19` | `masteryTone`：≥0.67 good / ≥0.45 hard / else again。**反模式**：`NULL（从没练）→ 0 → 'again'/红`（L17-19 + docstring 明说「证据不足那个灰被故意丢了」）——冷启节点和真·0% 节点**同色同数**，置信被抹平。 |

**裸数字违规——确证 4 处（全是 `Math.round(node.mastery * 100)` 渲染干净「78」）**：
`MasteryRing.tsx:23/59`（根，最优先）、`MeshGraph.tsx:177/219`、`NodeDrawer.tsx:182/215`、`KnowledgeDetailPage.tsx:159/193`。本批 ⑥ 硬约束要求**替它为带置信的呈现**（见 §4）。

---

## 3. 本批该呈现什么（三个新维度，功能层非视觉）

### 维度 A — 渐进披露（接 YUK-297，现在就接）
图不再一次性把所有节点摊开；它**起手稀疏**，owner 通过**展开（disclose）**逐步揭开更多。功能要求：

- **起手态**：图打开时只显示一个**稀疏的入口集**（如 domain 根簇 / 当前焦点节点 + 其直接邻域），而不是全量。owner 一眼能读，不被几百个节点淹没。
- **展开可供性**：某个簇/节点能被「展开」以揭开它的子节点 / 邻域；展开后被披露的集合仍保持小而稀疏。这正是 `layout.ts` 求解器假设的输入形态（小披露集 → `tidyTree`；一次展开出宽兄弟扇 → fcose 径向铺开）。
- **折叠可供性**：展开的能收回去，让 owner 控制「我现在看多大一片」。
- **聚合视图形态**：「先看 domain 簇、点开再看 KC」这种**分层展开**本身是渐进披露要画的核心形态。
- **承接关系**：视觉稿设计「披露/展开/折叠」的交互与态，落地时与既有 `layout.ts`（坐标）+ MeshGraph SVG 渲染层对接。**注意**：哪些节点算「入口集」、展开揭开哪些邻域属算法/数据侧（部分需后端子树加载，见 §7），视觉稿只承载「这里能展开 / 这是已展开 / 这是折叠态」。

### 维度 B — 误区层（双层异构图第二层，本批出形态、数据后填）
在同一张图里**叠上误区（misconception）层**——误区是与 KC 不同的语义实体（不是 KC 节点的某个状态）。功能要求：

- 两类节点**可视区分**：KC 节点 vs 误区节点是不同语义实体。
- 误区节点连到它所诊断的 KC（关系语义：这个误区是这些 KC 上的典型错误）。
- **本批关键约束（owner 已锁）**：误区层**本批出形态、数据后填**。misconception 表今天是 dormant skeleton（无 writer / 无 route / 无 wire，写路径 gated 在 ADR-0034 promotion flow 后，属 separate heavier issue，**不在本批**）。所以视觉稿要**设计这一层的位置与形态**，但实现时它**先是空层**——空态见 §5.1，必须能优雅退化为「不显示 / 占位」，不能留空壳框。

### 维度 C — mastery 诚实呈现（⑥ 硬约束）
节点的 mastery **永远带置信**，不再渲染干净点估计。功能要求：

- **禁止**：任何地方渲染干净的「掌握 78%」点估计（当前 4 处违规，§2）。
- **要求**：绝对值一律带**置信区间 / 低置信标记**呈现。owner 该读到的是「**可信 / 不可信 + 相对位置**」，不是精确百分比。一个 evidence=0 的冷启节点必须**永远不长成**一个练过 12 次稳定节点的样子。
- **覆盖面**：mesh 图节点、树行、抽屉头、详情页 hero、子节点行——凡今天用 `MasteryRing` 或裸 `pct` 的地方都要换成带置信的形态。
- **与 YUK-476 协调**：置信 / 低置信的判据与（可能的）来源区分由 YUK-476 统筹，本视觉稿按「点估计 + 区间 + 低置信标记」设计即可（数据前置见 §7）。

---

## 4. 硬功能约束（owner 已升为前端必须渲染，非建议）

1. **mastery / 难度绝不裸数字**：见维度 C。当前违规 4 处必须替换：`MasteryRing.tsx:59`、`MeshGraph.tsx:219`、`NodeDrawer.tsx:215`、`KnowledgeDetailPage.tsx:193`。
2. **冷启 ≠ 失败**：从没练过的节点（`evidence_count === 0`）**绝不**显示成红色「0%」（那是 `mastery-tone.ts:17-19` NULL→0→again 的现行 bug）。「没数据」与「数据是 0」是两个语义，必须不同形。
3. **截断不可隐瞒**：图命中 5000 cap 时（`tree.ts` warn `tree_snapshot_truncated`），UI 必须**显式告知 owner 图被截断**——你看到的不是全部节点。（渐进披露会大幅缓解这条，但披露式加载下「还有未加载的子树」同样要可感知，别让 owner 在一张不完整的图上误判。）
4. **误区层空态不留空壳**：误区层本批无数据，空态必须优雅退化（§5.1），不能是一个永远空的框。
5. **typed-edge 非颜色 cue 不可退化**：既有 `REL_CUE`（glyph + dash + 箭头，`MeshGraph.tsx:23-32`）让 5 类关系即便色盲也能解码——新维度叠加后必须保留这个非颜色可解码性，误区层的边/节点区分也不能只靠颜色。

---

## 5. 空态 / 失信兜底 / 故障态（显式功能约束，非可选）

### 5.1 空态
| 场景 | 真实触发条件 | 功能要求 |
|---|---|---|
| **空图** | `nodes.length === 0`（`KnowledgePage.tsx:155`） | 已有 EmptyState「知识网为空 · 录入材料后 AI 抽取节点」。保留语义，接「冷启 day-one 靠先验也得能用」产品线（引导去录入 / 看 seed root）。 |
| **误区层空** | misconception 表无任何行（**本批恒成立**，dormant） | 误区层是**空层**——不是错误，是「还没诊断出误区」。优雅退化为不显示 / 占位，**不留空壳框**。 |
| **节点无 evidence** | `evidence_count === 0`（冷启盲区） | 突出「从没练过」让 owner 可去补练（行为驱动）。**绝不**显示成红色「0%」（见 §4 约束 2）。 |
| **披露起手为空 / 展开后无子** | 入口集为空，或某节点展开后无可披露邻域 | 渐进披露下「这个簇没有更多可展开」要可感知，别让展开手势点了没反应像坏了。 |

### 5.2 失信兜底（数据来了但不可信——本批 ⑥ 的灵魂）
| 场景 | 真实触发条件 | 功能要求 |
|---|---|---|
| **冷启低置信** | mastery 来自冷启先验 / evidence 不足（YUK-476 判据） | mastery **不渲染干净点估计**——渲染区间 / 低置信标记。owner 只读「相对排序 + 可信/不可信」，不读精确百分比。 |
| **截断 / 未披露图** | 图命中 5000 cap，或披露式加载下尚有未加载子树 | 图**不能假装完整**——必须告知 owner「这不是全部」。否则 owner 在缺节点的图上做判断。 |

### 5.3 故障态
| 场景 | 真实触发条件 | 功能要求 |
|---|---|---|
| **树/边加载失败** | `treeQ.isError`（`KnowledgePage.tsx:153`） | 已有「知识图加载失败：{message}」。保留。 |
| **子树/披露加载失败** | 渐进披露按需取子树时网络失败 | 局部失败（展开某簇失败）**不该让整图白屏**——退化为「这个簇没展开成功，可重试」，已显示的部分保持。 |
| **节点页取数失败** | `getNodePage` reject（`KnowledgeDetailPage.tsx:148`→「节点不存在或已归档」） | 区分「节点真不存在 / 已归档」（404 语义）vs「取数网络失败」（可重试）。 |

---

## 6. 不在本批范围（防 scope creep —— A5 有更多维度，但 owner 本批只锁这三个）

以下属更广的 A5 形态轴，**不在本批 handoff**，视觉稿**不要画成「现在就做」**：

- **frontier 可供性**（「下一步学什么」的可达前沿标记 + 去练入口）—— A5 §2.2，独立批次。
- **节点详情承载 B1 三维 / RT2 credit 归因 / RT1 误区清单** —— A5 §2.3，独立批次。
- **诊断下钻入口（CDM attribute 画像 / IRT 区分度）** —— A5 §2.4，且这两维 n=1 下结构性不可估（`schema.ts` 占位列多为 NULL），独立批次。
- **mastery 来源二态可分（硬轨 firm-up vs 软轨 prior-echo）** —— A5 ⑥-2。本批 ⑥ 只锁「带置信 / 低置信标记」；来源区分由 YUK-476 统筹，**本视觉稿不强求**画来源二态（若 claude design 自然带出可作 nice-to-have，但非本批硬约束，别当锁定项设计）。
- **误区层的真实数据 / writer / 读路径** —— 本批只出形态，数据填充是 separate heavier issue（ADR-0034 / ADR-0036），不在本批。

后端：本批不要求前端硬塞算法——披露入口集判定、误区数据、置信 wire 扩展都是后端工单（§7）。

---

## 7. 数据前置（哪个 infra 就位、哪个待补）

| 维度 | 数据/引擎现状 | 前置状态 |
|---|---|---|
| **A 渐进披露 — 布局求解器** | `layout.ts`（YUK-297）**已建且在线**，已被 MeshGraph 调用；求解器本就为「小披露集」设计（tidyTree + fcose 径向）。 | ✅ **就位**——视觉稿的披露/展开形态可直接落到现有求解器上。 |
| **A 渐进披露 — 披露交互状态** | 当前**无**：`KnowledgePage.tsx:212` 全量灌入，无 disclose/collapse 状态。 | ⚠️ **本批前端实现**（在已就位的求解器上加披露态 UX）。 |
| **A 渐进披露 — 后端按需子树加载** | `tree.ts:39` 仍是 load-all + 5000 cap；CTE / 增量 walk 是 **phase-deferred，tracked in YUK-236**（`tree.ts:31-37` docblock）。 | ⛔ **后端工单（YUK-236）**——大图真正可读需后端视口化/子树加载。建议新建 Linear issue「A5 大图可读性 — 知识图视口化/分页加载」挂 epic、关联/可能合并 YUK-236，area: knowledge。视觉稿可先按「分层展开」设计，前端先做轻量披露 + 截断告知兜底。 |
| **B 误区层 — 数据** | misconception 表 **dormant skeleton**，无 writer / route / wire（写路径 gated 在 ADR-0034 promotion flow，依赖 ADR-0036 身份层）。 | ⛔ **未就位（owner 已知，本批仅出形态）**——视觉稿按「空层优雅退化」设计（§5.1）。数据填充另立 heavier issue。 |
| **C 置信呈现 — 数据** | 后端 `getMasteryProjection`（`mastery/state.ts`）**已算** `mastery_lo/hi` + `low_confidence` + `theta_se`；相邻 `calibration-maturity` 端点已算 `cold_start/theta_se/confidence/track`。 | ⚠️ **算了但没上 wire**：`knowledge-api.ts` 的 `KnowledgeTreeNode` 与 `KnowledgeNodePage` **只透 `mastery: number\|null`**，CI / 低置信 / cold_start 字段在 wire 边界被丢弃。→ **需 wire 扩展（与 YUK-476 协调）**。建议新建/挂 Linear issue「A5 — mastery 置信字段接入 /knowledge 节点 wire」，area: knowledge。**这是 ⑥ 硬约束前端落地的前置依赖**——视觉稿可现在设计（数据已算出），但实现前确认 wire 字段已接，否则只能继续渲染裸 `mastery`（= 继续违规）。 |

---

## 8. 留给 owner 拍的开放决策（大方向已锁，仅余下游微决策）

> **两个原大留白已被 owner 锁定，不再开放**：① 是否接 YUK-297 →**接，现在就接**；② 误区层本批 or 押后 →**本批出形态、数据后填**。下面只是落地中的下游微决策，不触及锁定框架。

- **披露起手集的粒度**：起手只显 domain 根簇，还是「焦点节点 + 一跳邻域」？这影响视觉稿的入口态密度。**建议交 owner 在看到 claude design 披露形态稿后定**（看到具体形态才好判断起手该多稀疏）。
- **截断/未披露告知的强度**：是常驻提示还是触达边界时才提示？属体验权衡，可在视觉稿出后定。

（以上两条都不阻塞视觉稿——claude design 可先出形态，owner 在稿上拍。）

---

## 9. 边界提醒（给实现者，非 claude design）

- 这是 `src/capabilities/knowledge/` 域 UI（图谱页 / 抽屉 / 详情页 / 共享 `MasteryRing` primitive + `layout.ts` + `MeshGraph` SVG 层）。
- 构建于既有 loom design 系统：mesh 三层节点、`REL_CUE` typed-edge 非颜色 cue、MasteryRing、drawer 形态、YUK-297 SVG + 布局求解器都已存在——本批是**在它们之上加披露交互 / 误区层 / 置信呈现**，不是推倒重画。
- ⑥ 置信落地**依赖 wire 扩展（§7 维度 C）**——前端实现前确认 wire 字段已接，否则只能渲染今天的 `mastery` 点估计（= 继续违规）。
- 误区层本批**先空层**——别为了「有东西显示」去伪造误区数据。
- 动 UI 代码前仍走项目 design-doc pre-flight；本 handoff + claude design 视觉稿 = pre-flight 的输入。
