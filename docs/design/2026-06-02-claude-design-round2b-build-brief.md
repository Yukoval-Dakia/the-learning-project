# Loom UI 重绘 · Round-2b 构建稿（给 claude.ai/design）

> **怎么读**：贴进**同一个 claude design 会话**继续。round-2a 已验收通过（今日/复习/录入/收件箱/错题全部达标）；这一轮做**剩下的全部 surface**。
> **性质**：2b 大多是**净新建/替换占位**（不像 2a 是改既有屏）。但纪律不变——**视觉语言完全不动**，复用你已建的 tokens / primitives / `Stateful`(loading-empty-error) / `Card·Btn·Badge·Ring·EmptyState·Icon` / `CopilotDrawer` 模式 / mesh 样式 / `KIND_META`·`REL_LABEL`。
> **范围（本轮全做）**：D 知识(图升级 + `/knowledge/[id]`) · F 学习项(意图拆解 + 状态 + `/learning-items/[id]`) · G block-tree 笔记编辑器 · I `/coach` · J `/learning-sessions` + `/[id]` · E `/events/[id]` · 教学抽屉 TeachingDrawer · K `/admin/*`。
> **现状已核对** round-2a 交付的 jsx（不是猜）。契约源头：同目录 `2026-06-02-claude-design-handoff-full-redraw.md` §3 D/F/G/I/J/K + §3E 详情页。日期 2026-06-02 · YUK-169。

---

## 0. 视觉 & 复用（不要重做外观）

保留整套 round-2a 视觉。**所有新屏用现有 primitives 拼**：`Stateful` 包每个数据块（loading 骨架 / empty / error+重试，可用 Tweaks「数据态」demo 驱动）；`Card/Btn/Badge/Ring/EmptyState/SectionLabel/Icon`；新抽屉（TeachingDrawer）照 `CopilotDrawer` 的结构 + 已做好的 focus trap/restore/Esc 复制；知识图复用 `mesh-*` 样式但要升级成可交互（见 D）。

> 注：handoff 把 `block_merge` 标为 "(new)"，但它的 **inbox 卡已在 round-2a 交付**（primary + 待并入块预览 + 连续性理由，已验收）。本轮**不碰 inbox、不重做 block_merge**——它不是 2b 的孤儿需求。

---

## 1. 全局（2b 相关）

1. **新增路由**（替换 2a 的 stub / 新建）：`/knowledge/[id]` · `/learning-items/[id]` · `/learning-sessions` · `/learning-sessions/[id]` · `/events/[id]`（2a 是 `ScreenStub`，替成真页）· `/coach`（同，替真页）· `(admin) /admin/runs /admin/cost /admin/failures`。
2. **入口**：`/coach` 已由今日 C-lane 链入；`/events/[id]` 错题卡的 `→ events:id` **链接是活的**，只是目标页 2a 还是 stub；`/knowledge/[id]` 从知识树/图节点进；`/learning-items/[id]` 从学习项卡进；**`/learning-sessions` 列表**目前无入口——在今日「可恢复会话条」加一个「查看历史 →」或复习完成卡加入口。admin 是**独立 shell**（不同 chrome，nav = Runs / Cost / Failures），从主 app 不必显眼链接。
3. **5 类 typed 关系**（知识边）必须**视觉可区分且非颜色单独承载**：`prerequisite 前置 · related_to 相关 · contrasts_with 对比 · applied_in 应用 · derived_from 派生`（沿用 2a `REL_LABEL`）。每类要有形状/图标/标签线索。
4. **状态 enum（全 11 值，全部要非颜色线索）**：`pending / in_progress / done / resting / dismissed / archived / extracted / partial / failed / queued / extracting`。前 6 个是学习项状态（**F 的过滤 tabs 只用这 6 个**）；后 5 个（extracted / partial / failed / queued / extracting）是**会话 / ingestion 生命周期**状态，出现在 **J 学习会话**与录入/事件流——设计这些 surface 时别漏它们的非颜色态。
5. 抽屉/弹层 focus 管理（TeachingDrawer 同 CopilotDrawer）。每个数据块三态。中文文案。
6. **样例统一用文言文域**（与 2a 一致：之/虚词/判断句/史记选读），不要用 handoff 里残留的物理样例（圆周运动等）。

---

## 2. 逐屏（round-2b）

### D · 知识 `/knowledge`（升级）+ `/knowledge/[id]`（新）

**round-2a 现状**（`screen-knowledge.jsx`，自 round-1 未改）：树列表（depth 缩进 + 错/mesh badge）；`MeshGraph` 是**装饰性 SVG**——手摆 % 坐标、**不可平移/缩放、节点不可点**；AI 提议 banner 跳 inbox；「新建节点」按钮无功能。无节点详情、无 typed 关系区分、无掌握度、无 `/[id]`。**⚠️ 2a 重写 `data.jsx` 时删了顶层 `DATA.knowledge` 数组**（screen-knowledge.jsx:33 仍 `DATA.knowledge.map`），所以这屏在 2a bundle 里会报错/空白——2b 要**同时重建屏 + 补 `DATA.knowledge` 数据**（节点带 mastery/evidence/decay + typed 边）。

**本轮做什么**：
- **保留树↔图 toggle 两视图**（2a 已有）：树 = 纯 parent/child 层级；图 = **5 类 typed 边**的 mesh；两视图都要留。
- **mesh 升级为可交互**：可平移 / 缩放的 node-link 图（viz 库你定，但必须真交互）。边按 **5 类 typed 关系**视觉区分（非颜色单独承载）。**点节点 → 右侧节点详情抽屉**。
- **掌握度在节点级就要可见**（不止抽屉里）：每个树/图节点带 mastery %（环）+ evidence 数 + decay 衰减——这是 handoff §3D 要求的"per-node"指标。
- **节点详情抽屉**：**层级（parent/child）与关系（typed edges）两块视觉分开**。边提议就地决策：`接受 / 反向 / 改类型 / 忽略`（复用 2a inbox 的 edge action 视觉）。一个**建边表单**：选关系类型 + 目标节点 + **方向（source→target；prerequisite/derived_from/applied_in 等有向关系必须能指定方向，与"反向"控件一致）**。
- **`/knowledge/[id]` 深度页**：节点 metadata + 掌握度；**邻居按关系类型分组**列出；节点**主笔记内联**（只读渲染，用 G 的渲染能力）；**backlinks 按类型**（atomic / hub / long / quiz）；活动时间线。
- 样例：`之 · 用法 (k_xuci_zhi)` · 掌握度 62% · 9 evidence · 衰减中；前置=`文言虚词 (k_xuci)`；派生=`之attr (k_xuci_zhi_attr)`；对比=`主谓取独 (k_zhi_subj)`、相关=`其 · 用法 (k_xuci_qi)`（后两个节点 2a 图里还没有，重建 `DATA.knowledge` 时一并补，别凭空画无 id 的节点）。

### F · 学习项 `/learning-items`（升级）+ `/learning-items/[id]`（新）

**round-2a 现状**（`screen-items.jsx`，自 round-1 未改）：浅卡片（Ring + 卡片/掌握/待巩固 stats）+ 顶部 `筛选`/`新建学习项` 两个**无功能**按钮 + 一个「笔记编排」`textarea`（"@提及 即将上线"占位）。**无意图拆解、无状态 tabs、无状态流转、无 `/[id]`、无 origin proposal、无 artifact**。**⚠️ 同 knowledge：2a 重写 `data.jsx` 把顶层 `DATA.items` 也删了**（screen-items.jsx:18 仍 `DATA.items.map`），2a bundle 里这屏会报错/空白——2b 重建屏 + 补 `DATA.items` 数据。

**本轮做什么**：
- **意图 → 拆解**：输入一个学习意图（topic）→ AI 提议**拆成 hub + atomic 子项** → **接受**（这是本屏灵魂，2a 完全没有）。拆解提议是 `learning_item` kind（已在 `KIND_META`）。
- **状态过滤 tabs**：`全部 / pending / in_progress / done / resting / dismissed / archived`。
- **学习项卡**：带**状态流转**动作（如 开始/搁置/完成/归档）；内联知识点编辑。保留你已有的 Ring + stats 视觉。
- **`/learning-items/[id]` 全编辑器**：标题/内容内联编辑；状态流转；知识点 chips；**origin proposal 块**（含**撤回 retract + 原因**）；**可搜索的父节点选择器**；**artifact 视图**（block-tree 笔记 + 生成/校验 badge——见 G）；**children 列表**；右侧**教学抽屉**入口（见 TeachingDrawer）。

### G · block-tree 笔记编辑器（在 `/learning-items/[id]` 内）

**round-2a 现状**：只有 items 屏那个 `textarea` 占位。**整块未建。**

**本轮做什么**（这是全 app 最重的交互件，慢慢做）：一个 block 化笔记编辑器（参照 TipTap/ProseMirror 心智模型），必须有：
- **slash 命令插入块**（`/` 唤出块类型菜单）——**修复点：slash 插入的块不能非法嵌套**（如不能把块插进不该嵌的容器）。
- **拖拽手柄重排块**——**修复点：拖拽手柄只在真正可拖的块上出现**。
- **交叉链选择器**（链到知识节点 / 其它笔记）。
- **内嵌测验块**（"embedded check" 互动小测）。
- **校验 badge**（生成/已校验）。
- **渲染**：LaTeX / 文言文 / 纯文本 / 代码 四种都要渲染正确。
- **只读 + 可编辑**两种呈现都要（`/knowledge/[id]` 和 artifact 只读处复用只读渲染）。

### I · `/coach` 分析（替换 2a stub）

**round-2a 现状**：`ScreenCoach = ScreenStub`（占位 EmptyState）。

**本轮做什么**（只读分析）：
- **时间窗 toggle**：7 / 30 / 90 天。
- **KPI strip**：reviews · 正确率% · 新增错题 · AI 成本。
- **评分分布条**：again / hard / good（**三档**，与全局一致；handoff 里写的 easy 忽略）。
- **逐日堆叠柱**（按天的复习量/评分构成）。
- **失败排行**：按知识点的失败次数 top N。
- **归因分布**：按 cause 的占比。
- 样例（7d）：84 reviews · 71% 正确 · 6 新错题 · $4.10；失败 top：`之·用法 (5)` · `判断句 (4)`。

### J · `/learning-sessions`（新）+ `/learning-sessions/[id]`（新）

**round-2a 现状**：路由不存在；今日有「可恢复会话条」（数据 `DATA.sessions`）但没有历史列表页。

**本轮做什么**：
- **列表**：过往复习会话——状态 · 已复习数 · 评分构成(again/hard/good) · 时长 · 知识点 chips；动作 `详情 / 重开 / 恢复`。
- **详情 `/[id]`**：会话摘要（类型/状态/时长/计数/成本）· 评分分布条 · **一段 AI 会话总结** · **逐事件流**（每条链到 `/events/[id]`）。
- 入口：今日「可恢复会话条」加「查看历史 →」。

### E · `/events/[id]` 事件页（替换 2a stub）

**round-2a 现状**：`ScreenEvents = ScreenStub`；错题卡的 `→ events:id` 链向它。

**本轮做什么**（event-sourced 因果链可视化）：
- **focal event**（焦点事件）+ **caused_by**（什么导致了它）+ **它导致了什么**（下游）+ **corrections**（纠正）。
- 一个**添加纠正**的控件。
- **可折叠的 raw payload**（原始事件 JSON 折叠展开）。
- 样例：focal=`attempt:failure · 之`（evt_3120）；caused_by=`review_session rs_41`；caused=`judge:attribute(概念混淆) → mistake m1`；correction=`重做正确`。

### TeachingDrawer（"对话教学"，在 `/learning-items/[id]`）

**本轮做什么**：一个右侧 AI 1-on-1 教学抽屉——**结构照 CopilotDrawer**（转写流 + 流式回复 + 可展开工具卡），但聚焦"针对这个学习项教学"。要有**idle 空闲态**（还没开始对话时的引导态）。复用 CopilotDrawer 已做好的 focus trap/restore/Esc。

### K · `/admin/*`（独立 shell · 最低优先）

**本轮做什么**：独立 chrome（不同于主 app 的侧栏），nav = `Runs / Cost / Failures`：
- `/admin/runs`：AI run 日志（表格/可观测：task · 状态 · 成本 · 时延 · 时间）。
- `/admin/cost`：花费（按 task/天聚合）。
- `/admin/failures`：失败 job 列表（job · 错误 · 重试）。
- 表格/observability 风格即可，最后画、密度可高。

---

## 3. 数据形状（消费既有后端；以下几处标出、勿擅自假设）

1. **知识掌握度**：节点需 mastery%(/evidence/decay) 字段——核后端是否已算。
2. **typed backlinks**：`/knowledge/[id]` 的 backlinks 要按 atomic/hub/long/quiz 分类。
3. **意图拆解提议**：`learning_item` kind 的 hub+atomic 拆解 proposal 形状。
4. **会话 AI 总结 + 逐事件流**：sessions 详情要 session-summary 文本 + caused_by 事件流。
5. **events raw payload**：`/events/[id]` 要原始事件 payload + caused_by 链。
6. **admin 可观测**：runs/cost/failures 来自 AI run log + cost ledger——核现有形状。
7. **节点活动时间线**：`/knowledge/[id]` 需要 per-node 事件/活动流（样例：14 天前 attempt:failure·之 → 昨日 judge:概念混淆 → 今日 correction）。
8. **coach 聚合**：per-day 复习/评分桶 + top-N 失败知识点 + cause 分布——核后端是否已暴露，否则标为客户端 rollup。
9. **重建 `DATA.knowledge` / `DATA.items`**：2a 的 data.jsx 重写丢了这两个顶层数组，2b 重建知识/学习项屏时要补回（knowledge 节点带 mastery/evidence/decay/typed 边；items 带 hub/atomic/status/children）。

若布局需要改数据/路由，**标出来**。

## 4. 无障碍

全键盘可达；TeachingDrawer focus trap+restore+Esc；知识图节点键盘可达 + 焦点可见；5 类关系 / 状态 enum 非颜色线索；表格语义化（admin）。

---

## 5. 交回

更新后的原型（或屏规格），覆盖以上所有 surface 的 desktop + mobile、light + dark，含 loading/empty/error，用文言文域真实样例。标注 §3 各处数据形状改动、以及 block 编辑器的交互细节（slash 菜单/拖拽/交叉链/内嵌测验的状态）。**至此全 app 11 个 surface(A–K) 设计完成**，Claude Code 接着 slice-by-slice 落地。

---

*视觉是你的、已认可。2b 把剩下的 surface 补齐——交互忠于契约，外观忠于你 round-1/2a 建立的系统。*
