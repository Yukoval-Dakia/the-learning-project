# 知识（/knowledge、/knowledge/$id）：M3E 呈现

YUK-1473 · 2026-11-03 · 交付阶段：第一天能用（删旧界面，逐页迁移）

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:95`（§5「其余真实页面」）：「其后 notes/knowledge/coach/profile/admin 等按原功能票、真实修改面逐页圈定」；`:98`「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」；`:100`「作用域、无全局污染、同源资源、无业务规则等承重限制保留。」
   - `docs/design/2026-10-07-ui-visual-direction.md`：`:244`「L5 历史与次要长列表默认折叠」；`:300`「T3 玻璃只给浮层」；`:323`「M1 只在变化时动」；`:359`「M14 三态：每个区域都设计载入（与布局一致的骨架…）、空（带进入动作）、出错（区域隔离、可重试、已保存的工作不受影响）」。
   - 协调裁定（2026-11-03）：只换呈现。查询、query key、改动（建关系、AI 关系提议的四种决定、误区“判错了”）、失效、跳转目标、图的布局计算（`layout.ts`、`label-layout.ts`、`node-dims.ts`、`ghost-endpoints.ts`、`relation-cue.ts`、`mastery-tone.ts`）、数据整理（`knowledge-api.ts`、`knowledge-client.tsx`、`knowledge-node-query.ts`、`humanize-activity.ts`）行为一律不变。掌握度的颜色值可以换成 M3 角色，但哪种状态用哪种色调不变。有副作用的切换不能改成单选组（`Segmented`）。不新增 `useEffect`，不加测试。
2. 组件类型：page（`/knowledge` 树 / 图谱页、`/knowledge/$id` 知识点详情页）+ drawer（图谱页上已有的知识点抽屉）。没有新路由、弹窗或抽屉。
3. 文件：
   - 新建：`src/capabilities/knowledge/ui/knowledge-m3e.css`、`MasteryDial.tsx`（替代旧共享 `MasteryRing`）、`KnowledgeChips.tsx`（记忆状态、关系类型、校验状态三种小标签）、`KnowledgeEmpty.tsx`（空状态）、本文件。
   - 修改（只改呈现）：`KnowledgePage.tsx`、`KnowledgeDetailPage.tsx`、`NodeDrawer.tsx`、`MeshGraph.tsx`、`FrontierRail.tsx`、`MisconceptionList.tsx`、`NodeComposite.tsx`、`BandChip.tsx`（只改 class 名）、`web/src/globals.css`（只删规则）。
   - 删除：`src/capabilities/knowledge/ui/knowledge.css`；`src/ui/primitives/MasteryRing.tsx` 与 `src/ui/components/SubjectFilterTabs.tsx`（这两页是它们仅有的使用者，迁移后没有任何引用）。
   - 两页渲染到的展示件：`KnowledgePage` → `FrontierRail`、`BandChip`、`MeshGraph`（懒加载）、`NodeDrawer`；`KnowledgeDetailPage` → `BandChip`、`NodeComposite`（含 `TransferList`、`DiagnosticDrill`）、`MisconceptionList`；`NodeDrawer` 复用 `KnowledgeDetailPage` 导出的 `InteractiveArtifactDiscovery`。知识能力之外没有人引用这些组件；`ui-public.ts` 的导出（`getTree`、`projectKnowledgeEdges`、`masteryTone`、两个页面加载器、`KnowledgeClientProvider`）未改。`KnowledgeDetailPage` 的 `InteractiveArtifactDiscovery`、`knowledgeBacklinkHref`、`knowledgeReviewRequest`，`KnowledgePage` 的 `KNOWLEDGE_INBOX_HREF`，`MisconceptionList` 的 `applyVeto` / `MisconceptionCardView` / `MisconceptionCard`，`NodeDrawer` 的 `decayCue`，签名都不变。

## 做了什么

- **外壳**：两页都用 `<UiNextRoot className="kn-page">` 加 `<main className="… un-m3e-bridge">` 和 `<ToastHost />`，做法同题库页。样式都限定在 `[data-ui-next].kn-page` 下，颜色走 M3 角色。掌握度色调的对应关系不变：good / hard / again 分别是 positive / caution / critical（`masteryTone` 和 `decayCue` 的阈值一个字没动）。
- **换掉的旧件**：`Btn` / `IconBtn` / `LoomIcon` / `EmptyState` / `CollapsibleList` / `SectionLabel` / `MasteryRing` / `SubjectFilterTabs`，以及全局类 `page` / `page-head` / `eyebrow` / `serif` / `card` / `meta` / `badge` / `quiet-empty` / `seg` / `drawer*` / `scrim` / `rel-*` / `verify-badge` / `note-kind-*` / `kd-*` / `know-*` / `kg-svg*` / `mesh-*` / `event-*` / `thread-arrow` / `nowrap-meta`。替换成 ui-next 的 `Button`、`IconButton`、`ChipToggle`、`Segmented`、`FoldList`、`RetryLine`、`SkeletonLines`、`SectionHead`、`ToastHost`，图标用 lucide。
- **树 / 图谱页**：标题“知识”，右侧树 / 图谱切换改为 `Segmented`（纯视图切换，见下面“交互变化”）。下面一句状态“共 N 个知识点 · M 条关系”（第一次读完树之前留空），一句说明，科目筛选是一排 `ChipToggle`（同笔记页）。“下一步，你学得动这些”是一块浅底区域，卡片是带细线的白卡；AI 关系提议是一条细线框提示，按钮“集中审批”。树是一张白卡里带分隔线的行：层级缩进、掌握环（或容器图标）、名称、记忆状态标签、档位芯片、学习依据数、关系数、到期数、右箭头；衰减中的行保留淡红底，容器行保留浅灰底。加载 / 出错 / 为空 / 树 / 图谱依旧一次只显示一种，顺序和原来一样。
- **图谱**：点阵底舞台、缩放控件、图例、跨科连接计数都在，换成 M3 角色：前置用 primary，对比和跨科连接用 secondary，应用用 positive，派生用 caution，相关用 outline；虚线和箭头这两个不靠颜色的线索不变。节点的填充 / 底环 / 掌握弧三层不变，去掉了投影；选中用 primary 描边，键盘聚焦时节点外多一圈焦点环。每个节点多了一个透明的命中圈（比可见圆大 6px），小节点更好点。缩放控件浮在图上，是这页除抽屉外唯一用玻璃的地方。
- **知识点抽屉**：玻璃浮层（T3），右侧悬浮，圆角；遮罩用 `--un-scrim`。打开时有一次短促的淡入右移，用户设置了减少动效时不播放。焦点陷阱、Esc 关闭、点遮罩关闭照旧（`useFocusTrap`）。各段用小标题（层级、其他关系、互动产物、AI 提议的关系变更、建立关系），指标区改成 `dl`。AI 提议的“建立关系 / 确认归档”从实心色按钮改为次要按钮（归档那个用 critical 色字），“反向 / 忽略 / 保留关系”是幽灵按钮；整页只留底部“打开知识点详情”一个主按钮。
- **详情页**：返回链接、标题区（掌握环、名称、记忆状态、档位、学习依据数、“复习此点”）、综合掌握状态卡（展开判断依据）、两栏（1080px 以下合成一栏）。主栏各段用 `SectionHead`：可能相关的误区、可能带动它的知识（含“进一步诊断”折叠条）、笔记（主笔记卡 + 按类型分组的链接行）、互动产物、邻居 · 按关系分组；侧栏：关联内容 · 按来源分组（`FoldList`）、活动（`FoldList` 时间线）。误区卡：已确认且复发中的那种保留暖色警示底，候选 / 消退中 / 已纠偏是虚线中性卡。
- **嵌套三元**：树页的加载 / 出错 / 空 / 树 / 图谱链改成 `body()` 的 if 链；图谱节点中心文字改成 `nodeCenterText`，边的虚线改成 `edgeDash`；时间线圆点颜色改成 `outcomeTone`；详情页外壳抽成 `DetailFrame`。

## 删除旧样式

- 删除了 `knowledge.css`。
- `web/src/globals.css`：删掉 143 条规则，91 个类从文件里消失，少了 962 行（12352 → 11390）。删除前用严格的整词匹配（类名只能作为完整的 `[A-Za-z0-9_-]` 词出现），在全部 `.ts` / `.tsx` 里确认这些类的使用次数都是 0；模板前缀逐个看过（`tone-${…}`、`tone-chip-${…}`、`tone-dot-${…}`、`is-${…}`、`note-${…}`、`verify-${…}`），只有 `tone-chip-*`、`tone-dot-*`、`tone-contrasts` 可能被其他页面的模板拼出来，所以保留；其余前缀拼出的是锚点 id、测试数据或其他页的状态值，不会生成被删的类。
  - 删掉的类有两组。一组是知识页迁移后归零的：`knowledge-loom`、`know-*`、`kd-grid` / `kd-side` / `kd-rel-*` / `kd-note-*` / `kd-primary-*`、`rel-row` / `rel-kind` / `rel-tag*`、`bl-*`、`verify-badge`、`note-kind-*`、`note-link-*`、`decay-bucket`、`event-rail` / `event-dot` / `event-line` / `event-body` / `event-head` / `event-chain` / `event-row`、`drawer-head` / `drawer-body` / `drawer-foot` / `drawer-title` / `drawer-sec*`、`node-metrics` / `nm*`、`edge-prop*`、`hero-cta`、`mastery-ring*`、`mesh-empty-state` / `mesh-node-label*`、`kg-svg` / `kg-svg-stage`、`seg-sm`、`subject-filter-row`。另一组是同一知识详情分区里早就没人用的原型遗留：`kd-head`、`kd-metrics`、`decay-retr`、`edge-form`、`chip-set`、`dir-row`、`event-label`、`event-note`、`rel-arrow` / `rel-info` / `rel-target` / `rel-type` / `rel-weight`。
  - 有几个类只出现在这些规则的复合选择器里，所以跟着一起消失：`hot`、`is-container`、`draft` / `verified`、`resolved`、`title`、`context-chip`、`filter-row-l`（`.subject-filter-row .filter-row-l`）。题库架子页 `PfShelf` 用到 `filter-row-l`，但它不在 `.subject-filter-row` 里，从来没被这条规则命中，外观不变。`event-chain` / `event-row` 在代码里只出现在注释里。
  - 因为还有别处在用而**保留**的：`nowrap-meta`、`dot-sep`、`quiet-empty`、`back-link`、`thread-arrow`、`field-label`（集中到一个说明“只因别处在用而保留”的小分区）、`scrim` / `drawer`（外壳在用）、`seg`、`topbar-spacer`、`card` / `card-pad` / `card-icon`、`badge` / `tone-*`、`chip` / `is-on`、`meta`、`mono`、`serif`、`eyebrow`、`page*`、`wenyan`、`note-interactive-shell` / `note-interactive-frame`。
  - 删除后清掉了留下的空分区注释（知识详情、知识列表、知识抽屉三层的标题与小节注释，`.seg-sm` 和点阵舞台的说明注释），“笔记阅读器”分区标题改成只说互动内容框。
  - **旧版 Loom v2.1 分区（第二个提交，协调裁定 2026-11-03）**：`/knowledge — Loom v2.1 tree + mesh surface` 是这两页的上一代实现，按同样方法删除：分区里 90 个类整词匹配为 0（`kg-*`、`knowledge-page`、`knowledge-btn-*`、`dd-*`、`ep-*`、`tree-hook` / `tree-title`、`relations-*`、`quality-strip` 等；`is-*` 状态类逐个核对过，其他页模板 `is-${tier}` / `is-${direction}` 拼不出它们），删掉 143 条规则和 2 个随之无人引用的 `@keyframes`（`kg-node-fade`、`knowledge-slide-in`），少了 1010 行（11390 → 10380）。`activity`、`name`、`indent`、`item`、`proposed`、`rescue`、`dashed` 只出现在和死类组合的选择器里（如 `.tree-node .name`），跟着一起消失。分区里**保留** 9 条：`.knowledge-tree`、`.relation`、`.edge-proposal`（含 5 个 `tone-*` 变体和 `.edge-proposal .meta-row`），因为这些名字在 `.ts/.tsx` 里仍以整词出现（query key `'knowledge-tree'`、`edge-proposal-*` 模块名、单词 `relation`），按规则不删；分区标题改成说明这一点。分区外还有 7 个同样零引用的旧知识类（`tree-node`、`kg-stage`、`detail-drawer`、`dd-head`、`has-proposal`、`knowledge-proposal-strip`、`ep-actions`），它们在共用的“Gradient finish pass”分区和一处 `@media` 里，不在本次范围，没有动。
- **与 `src/ui-next/AGENTS.md` I4 的冲突**：I4 说“不要编辑 `src/ui/`、`web/src/globals.css`”。这一线有书面例外：owner 要求删除全部旧界面（2026-10-20），根 `AGENTS.md` 的 S13 规定“DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除”，m3e 方向文档 `:98` 也要求“每片消费 M3E 后退出自己的旧样式”。这次只**删除**了知识页专用的全局规则和两个只剩这两页使用的旧组件（`MasteryRing`、`SubjectFilterTabs`），没有新增或修改任何全局规则；新样式全部放在限定作用域的 `knowledge-m3e.css` 里。

## 逻辑未变的证明

方法同笔记页：先从 HEAD 存一份原文件。对新旧两版分别用 TypeScript 编译器去掉 import 和注释，把每个最外层 JSX 表达式换成占位符 `JSX` 再打印出来，逐行比对（第一遍）。第二遍把所有 JSX 属性中的函数 / ref / `on*` 表达式提出来，排序后比对。脚本在仓库外：`tlp-status/_work/yuk1473/strip_logic.cjs`、`jsx_handlers.cjs`，结果在 `tlp-status/_work/yuk1473/knowledge/logic/`。

第一遍（JSX 之外的代码）剩下的差异，全是呈现层面的：
- `BandChip`：class 字符串 `band-chip …` → `kn-band …`。
- `FrontierRail`、`MisconceptionList`：出错分支原来是一段 JSX 里 `{onRetry && 重试按钮}`，现在是 `if (onRetry) return <RetryLine/>; return <p/>`，有无重试的条件不变。`MisconceptionList` 的 `cardClass` 字符串改成 `cardTone`（同一个三元，用作 `data-tone`）。
- `KnowledgePage`：新增 `VIEW_OPTIONS`、`countSentence`、`SubjectChips`、`treeRow`（原来 map 里的行，`decayCue`、`isKnowledgeContainer`、`meshCount`、到期判断逐字不变）、`body()`（原来的五段嵌套三元，顺序不变）。
- `KnowledgeDetailPage`：删掉只用于拼 class 名的 `noteKindShort`；`BL_META` 的图标从字符串换成 lucide 元素；新增 `outcomeTone`（替代原来时间线里的嵌套三元，failure / success / 其他 三种情况不变）和 `DetailFrame`。
- `MeshGraph`：新增 `edgeDash`、`nodeCenterText`（替代两处嵌套三元，取值不变）。
- `NodeComposite`、`NodeDrawer`：**没有差异**。

第二遍（JSX 里的处理函数）剩下的差异：
- `KnowledgePage`：树 / 图谱从两个按钮各自的 `onClick={() => setView('tree' | 'graph')}` 变成 `Segmented onChange={setView}`；科目从 `SubjectFilterTabs` 里的 `onClick={() => onChange(option.id)}` 变成 `ChipToggle onPressedChange={() => onChange(option.id)}`；**新增** 树出错时的 `onRetry={() => void treeQ.refetch()}`（只重新读取，不写）。
- `FrontierRail`、`MisconceptionList`：`onClick={onRetry}` → `RetryLine onRetry={onRetry}`，同一个函数。
- `NodeDrawer`：关系类型从 `onClick={() => setRel(k)}` 变成 `ChipToggle onPressedChange={() => setRel(k)}`，函数体相同。
- `BandChip`、`KnowledgeDetailPage`、`MeshGraph`、`MisconceptionList`（其余）、`NodeComposite`：**没有差异**。

query key（`['knowledge-tree', …]`、`['knowledge-edges', …]`、`['knowledge-edge-proposals']`、`['knowledge-frontier']`、`['knowledge-due-summary']`、`['knowledge-misconceptions', id]`、节点页 / 抽屉的 `knowledgeNode*QueryOptions`）、三处改动（`createEdge`、`decideEdgeProposal`、`vetoMisconception`）、它们的失效调用、`applyVeto` 的乐观与回滚、所有跳转地址（含 `?entry=`）、`useFocusTrap`、图的拖动 / 滚轮 / 键盘选点：都在“无差异”部分。没有新增任何 effect。

## 交互变化（键盘、焦点、由哪个元素触发）

- **树 / 图谱切换**改成 `Segmented`（单选组）：Tab 只停一次，方向键直接切换视图。切换没有副作用：不清选中的知识点、不关抽屉、不丢输入，只是换一种看法，符合“`Segmented` 只用于纯视图切换”的裁定。
- **关系类型**（抽屉里“建立关系”）没有用 `Segmented`：仍是只响应点击的按钮，从 `role="tab"` + `aria-selected` 改成 `aria-pressed`，放进带“关系类型”说明的 `fieldset`。方向键不会悄悄改掉要建的关系类型。
- **科目筛选**：仍是只响应点击、用 `aria-pressed` 标当前项的按钮，和原来一样。
- **树出错**多了一个“重试”（只重新读取知识树）。
- **图谱 Tab 顺序**：缩放控件挪进了图的舞台里，所以没有关系时“查看 AI 关系提议”按钮排在缩放控件前面（原来在后面）。
- **图谱节点**多了透明命中圈：点在可见圆外 6px 以内也会选中该节点（原来会被当成在空白处拖动的起点后什么也不选）。
- 装饰性的层级符号“└”、关系类型前的符号、各处图标对读屏隐藏；掌握环原本就对读屏隐藏，不变。
- AI 提议按钮、建立关系、误区“判错了 / 追溯 / 针对性练习”、返回、复习此点、所有跳转：触发元素和顺序都没变。

## 文案调整

- 去掉眉标“知识网络 · N 个知识点 · M 条关系”，改成标题下一句状态“共 N 个知识点 · M 条关系”，读取完成前留空。
- 加载文字改成骨架屏，读屏读到的分别是：“正在取知识网”（原“取知识网…”）、“正在看你学得动什么”（原“正在看你学得动什么…”）、“正在看有没有指向此点的误区”（原同句加省略号）、“正在取节点”（原“取节点…”）。
- 树出错文字不变（“知识图加载失败：…”），后面多了“重试”。
- 树行的关系数芯片加了悬停提示“N 条关系”。
- 新增几个读屏名称：图例“关系图例”、提议提示“AI 关系提议”、树 / 图谱区域“知识树 / 知识关系图”、综合卡“综合掌握状态”、详情侧栏“关联内容与活动”。
- 其他文字（按钮、空态、误区卡、“下一步”说明、提议、抽屉各段、aria 标签）一字未改。

## 审查与验收

- 本机检查：`pnpm typecheck`、`pnpm lint`、`pnpm build` 和完整本地闸门（对比 merge-base）。结果见提交说明 / 汇报。
- 独立审查重点（写入路径）：抽屉里“建立关系”（关系类型、目标、建立后清空目标并刷新关系）；AI 提议的“建立关系 / 反向 / 忽略”与归档提议的“确认归档 / 保留关系”（忙碌时禁用、失败提示、成功后行内显示结果并刷新）；详情页候选误区“判错了”（乐观显示“已纠偏”、失败回滚并提示），已确认误区的“判错了”仍禁用。
- 真实页面检查（由协调线负责，8788 dev 独立库）：树 / 图谱切换（键盘方向键）、科目筛选、空态、出错重试；图谱拖动 / 滚轮 / 缩放按钮 / 复位、键盘 Tab 到节点后回车 / 空格打开抽屉、选中描边、跨科连接；抽屉 Esc / 点遮罩关闭、焦点回到原处；上面三类写入各走一遍；详情页 → 笔记链接带 `?entry=`、上下级与关系邻居跳转、反链 / 活动折叠、“复习此点”打开学习伙伴；亮色 / 暗色；1080px 与 720px 两个断点；减少动效时抽屉不动画。
