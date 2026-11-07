# 收件箱（/inbox）、AI 之间的观察（/agent-notes）、事件证据（/events/$id）：M3E 呈现

YUK-1473 · 2026-11-03 · 交付阶段：第一天能用（删旧界面，逐页迁移）

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:95`（§5「其余真实页面」）：「其后 notes/knowledge/coach/profile/admin 等按原功能票、真实修改面逐页圈定」；`:98`「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」；`:100`「作用域、无全局污染、同源资源、无业务规则等承重限制保留。」
   - `docs/design/2026-10-07-ui-visual-direction.md`：`:244`「L5 历史与次要长列表默认折叠」；`:300`「T3 玻璃只给浮层」；`:323`「M1 只在变化时动」；`:359`「M14 三态：每个区域都设计载入（与布局一致的骨架…）、空（带进入动作）、出错（区域隔离、可重试、已保存的工作不受影响）」；`:360`「M15 提示条」；`:366`「A2 触控目标：触屏上每个可点击目标的点击区 ≥ 44×44px」。
   - 协调裁定（2026-11-03）：只换呈现。查询与 query key、提议裁决（接受 / 改方向 / 改关系 / 忽略 / 合并确认）、自动应用撤销、裁决积压的逐页补齐（`DecisionBacklogDrain`）、撤销倒计时（`UndoClock`）、三档分桶与 lane 排序、事件纠正（撤回 / 标记为错误 / 恢复）与它的失效、AI 观察的筛选 / 分组 / 已读，行为一律不变；不新增 `useEffect`，不加测试。`Segmented` 只用于纯视图切换；会换行的写按钮行在触屏上要留够行距。
2. 组件类型：page（三页都是已有路由的整页），没有新路由、弹窗或抽屉。路由宿主 `server/start/routes/inbox.tsx`、`agent-notes.tsx`、`events.$id.tsx` 没有改。
3. 文件：
   - 新建：`src/capabilities/shell/ui/inbox-m3e.css`、`src/capabilities/shell/ui/inbox-look.ts`、`src/capabilities/agency/ui/AgentNoteGroupRow.tsx`、`src/capabilities/agency/ui/agent-notes-m3e.css`、`src/capabilities/observability/ui/event-detail-m3e.css`、本文件。
   - 修改（只改呈现）：`src/capabilities/shell/ui/InboxPage.tsx`、`ProposalCard.tsx`、`src/capabilities/agency/ui/page.tsx`、`src/capabilities/observability/ui/EventDetailPage.tsx`；`src/capabilities/shell/ui/shell.css` 与 `web/src/globals.css`（只删规则）；`src/capabilities/agency/ui/derive.ts`（删掉已无人用的 `anInlineMd`）；`scripts/audit-learner-copy.ts`（学习者文案清单跟着删掉 / 新增的文件改一行）。
   - 删除：`src/capabilities/agency/ui/AgentNoteCard.tsx`（迁移前就没有任何地方引用）、`src/ui/primitives/SuggestionKindTag.tsx`（最后一个使用者是提议卡）。

## 先查清楚谁在用什么

- `/inbox` 渲染 `InboxPage` → `ProposalCard`；`inbox-tier.ts`、`inbox-api.ts` 是逻辑，没动。今日页的 `ProposalStrip` 只用 `inbox-tier.ts` 的 `isMovedOutKind`，不碰这两个组件。`shell.css` 同时由 `InboxPage` 和 `TodayPage` 引入，所以只删收件箱用过、现在 0 引用的规则，今日页的晨报 / 费用 / 起始画像规则原样保留。
- `/agent-notes` 渲染 `page.tsx` → `AgentNoteGroupCard`。今日页的 `AgentNotesBoard` 也用 `AgentNoteGroupCard`，今日页这一片还没迁，所以 **`AgentNoteGroupCard` 一字未改**，`/agent-notes` 改用新的 `AgentNoteGroupRow`（数据、推导、链接与原卡相同，见下面逻辑证明）。今日页仍用的 `.an-scope` / `.an-*` 规则全部保留。
- `/events/$id` 只渲染 `EventDetailPage`；`event-detail-model.ts`、`event-detail-client.ts` 没动。
- 教练页（`/coach`、`CoachHub.tsx` 及其面板）不在这一批，它用到的东西都没碰。

## 做了什么

- **外壳**：三页都用 `<UiNextRoot className="ib-page | ag-page | ed-page">` 加 `<main className="… un-m3e-bridge">`，做法同题库页。样式都限定在 `[data-ui-next].xx-page` 下，颜色走 M3 角色。原来的色调对应为：info → accent（primary），coral → secondary，good / hard / again → positive / caution / critical，neutral 不变。
- **换掉的旧件**：`Btn` / `LoomIcon` / `LoomCard` / `LoomBadge` / `EmptyState` / `ErrorState` / `SkLines` / `Stateful` / `SectionLabel` / `CollapsibleList` / `SuggestionKindTag`，以及全局类 `page` / `page-head` / `eyebrow` / `serif` / `meta` / `badge` / `chip` / `seg` / `back-link` / `pf-toast(s)` / `field-label` / `raw-toggle` 等。替换成 ui-next 的 `Button`、`Card`、`ChipButton`、`ChipToggle`、`FoldList`、`RetryLine`、`SkeletonLines`、`SectionHead`、`ToastHost` / `showToast`，图标用 lucide。
- **收件箱**：标题“收件箱”加一句说明。三档各是一个带细线的分区头：字母标（A / B / C，保留——熔断提示里写着“下面 B 档的项”）、档名、“N 项”、一句说明。
  - A 档：熔断状态是一块浅底条（正常是绿色勾，触顶是暖色底加警示图标），下面一条细进度；“这些已经替你做了”一行；自动应用的卡合在一张白卡里，用细线分隔，每行是图标、类型标签、标题、说明、撤销窗口状态、“撤销”（次要按钮）和“追溯”（安静按钮，展开 / 收起追溯信息，带 `aria-expanded`）。
  - B 档：每种提议一个小标题（类型图标 + 名称 + 未裁决数）。提议卡是白卡：类型标签、“AI 建议”描边标签、修正类“修正”虚线标签、标题、已裁决时的“已接受”之类的标记；理由正文里的技术引用仍是可点的小灰块（点了复制原 ID）；变更摘要、学习主线、图题候选、合并预览、知识关系预览、合并确认都在原来的位置。底部一行是裁决按钮，右边是置信条和费用。整页没有实心主按钮：“接受 / 建立关系”是次要按钮，“确认归档”与“确认合并”是次要按钮配 critical 色字，“改方向 / 改关系 / 忽略 / 保留关系 / 先不合并”是幽灵按钮。已裁决的卡淡到 55%，裁决按钮隐藏（和原来一样）。
    2026-11-07 更新（YUK-1905）：提议卡正文改为给学习者的一句话 `presentation.learner_summary`；内部理由 `reason_md` 和证据芯片进「查看依据」折叠。旧提议没有这一句，正文仍是理由本身，保留技术引用折叠；超过 80 字截成两行，全文在折叠里。
    2026-11-07 再更新（YUK-1905）：旧提议正文不放技术引用，引用和全文在折叠里；自动应用开关（`auto_apply_enabled`）关着时，页头不说「已替你处理」，A 块只在有开关打开时留下的卡片或读取出错时出现，不显示熔断。
    2026-11-07 第三次更新（YUK-1905）：判断条件是有没有 `learner_summary`，不看新旧。没有这一句的卡，正文不放理由，靠标题和变更明细判断，理由和证据都在「查看依据」里，上面两条里「正文仍是理由本身」不再适用。例外是拿掉理由就判断不了的卡，仍显示去掉 id 的理由，超过 80 字截成两行：卡上没写作用对象的种类（知识结构调整、记录关联、整理学习记录、完成、重学、笔记更新）；诊断推测，它的理由就是要确认的判断；端点名读不到的知识关系。
    2026-11-07 第四次更新（YUK-1958）：知识结构调整的卡显示作用对象的名字（并走 → 留下、移动 → 放到、拆开 → 拆成），名字都读得到时理由进「查看依据」，有找不到的仍留在正文。节点找不到、已归档、已并走，或要放到最顶层时，这张接受不了，不显示接受按钮并说明原因；找不到可能只是暂时读不到，不说成已删除。合并知识点和合并题块一样，接受前要确认。能否接受由服务端判断（`blocked`），包括节点版本已变（「这个知识点后来改过，这张建议可能过时了」），页面只负责显示；版本比对只用于显示，接受门的版本检查仍是最后防线。
    2026-11-07 三更新（YUK-1905 S6a-2）：自动应用区是摘要：按今天、昨天、近 7 天看替你做了什么，可批量撤销。能不能撤只看服务端 `undo.status`，`blocked` 显示服务端原因；页面不再按 10 分钟判断。旧 completion 卡（`not_auto_applied`）不显示原因也没有撤销入口。
  - C 档：一条可展开的细线框条（眼睛图标 + 汇总 + 说明 + 箭头），展开后是分隔线列表和“去 AI 观察面回看”。
  - 各档里的“正在加载 / 暂时无法加载 / 分页上限”等提示统一成浅底提示条；A 档读取失败改用 `RetryLine`。
- **AI 之间的观察**：返回“今日”、标题、说明。一块浅底概览：活跃观察数（大号数字）+ 主题数 / 涉及 AI 数、“全部标为已读（N）”、一排信号筛选（`ChipToggle`，`fieldset` + “信号”，单选，`aria-pressed` 标当前项），以及“重复观察已合并…”一句。按天分组，每天一个 `SectionHead`（“今天 · N 组”），组内是一张带分隔线的白卡，每行：信号色的来源头像（未读时右上角一个小圆点）、来源 → 目标、“新”、信号标签、主题标题、摘要、关注度 / 解决状态两个标签、运行次数 / 记录数 / 最新时间 / 到期、可展开的“查看本次运行与证据”（原生 `details`，展开后浅底列表，每条有序号、结果、时间、置信、证据链接）。
- **事件证据**：返回来源、“证据记录 · 动作”小字、标题“事件证据”、说明。链条是“由这条记录触发”节点 → 细竖线 → 当前记录卡（加粗描边的白卡：结果色标签“当前记录”、执行者、纠正状态、时间、动作标题、“涉及：…”、“查看相关…”、可展开的技术详情）→ 细竖线 →“之后发生 · N 条”（`FoldList`，默认 3 条）。下面是浅底的纠正面板（标题、说明原因的输入框、两个次要按钮），再下面是“纠正记录”（`SectionHead` + `FoldList` 分隔线列表）。404 / 403 是带图标的空态和“返回来源”按钮，其他错误是 `RetryLine`。
- **嵌套三元**：提议卡的置信度改由 `confidenceOf` 决定；AI 观察页的状态改由 `boardStatus` 决定；运行行的事件链接改由 `runEventHref` 决定；到期提示改成 `TtlLine`。
- **动效**：只在变化时动。C 档展开、合并确认出现、追溯展开、AI 观察的运行展开、事件技术详情展开时短促淡入一次；已裁决卡、撤销窗口变化用透明度过渡。关键帧只在用户没有要求减少动效时存在。没有入场动画（原提议卡的 50ms 逐张上浮去掉了）。玻璃只在 `ToastHost` 的提示条上。
- **触控**：会换行的写按钮行都在 `pointer: coarse` 下加了行距，44px 点击区不会叠到上一行：提议卡的裁决行和撤销行（`.ib-acts`，行距 16px）、改关系的关系芯片（24px）、证据芯片（16px）、AI 观察的筛选芯片（24px）、运行里的证据链接（24px）、事件纠正的按钮行（16px）。

## 删除旧样式

- 方法同笔记页：用严格整词匹配（类名只能作为完整的 `[A-Za-z0-9_-]` 词出现）在全部 `.ts` / `.tsx` 里确认使用次数为 0，再用 `drop_css_classes.py` 删规则（复合选择器列表只删死掉的那一项）。模板前缀逐个看过：`tone-${…}`、`tone-chip-${…}`（今日页的 `AgentNoteGroupCard`、`ProposalStrip`、`LoomBadge` 等还在拼）都还活着，所以所有 `tone-*` 类本身一个都没删；只有作用域类已死的规则（如 `.an-scope .an-fdot.tone-dot-*`、`.inbox-loom .tone-chip-*`）随作用域一起消失。被删的选择器里没有把死类放在 `:not()` 里的情况。
- `web/src/globals.css`：删掉 66 个类涉及的规则，共 123 条规则（含随之变空的 `@media` 块），另有 2 个选择器列表被裁掉一项（`.proposal-actions` 和 `.inbox-node-proposal`），少了 770 行（10380 → 9610）。删掉后留下的空分区注释也清掉了；原“/inbox v2.1”分区标题改成说明剩下的 `.section` 与 `.edge-proposal` 规则。
  - 三页迁移后归零的：`inbox-loom`、`agentnotes-loom`、`events-loom`、`page-narrow`、`ai-tag`、`meta-row`、`proposal-actions`、`field-label`、`raw-toggle`、`raw-payload`、`corr-row`、`ec-correction-panel`、`ec-correction-actions`、`ev-*`（`ev-actor`、`ev-connector`、`ev-dot`、`ev-focal*`、`ev-lane*`、`ev-node`）、`an-*` 里只有整页用的（`an-overview*`、`an-ov-*`、`an-filterbar`、`an-fchip`、`an-fdot`、`an-group-feed`）、`sug-kind*`。
  - 同一批页面里早就没人用的旧版遗留：旧收件箱 v2.1 的 `inbox-page`、`inbox-section*`、`inbox-card-list`、`inbox-card-meta`、`inbox-meta-line`、`inbox-empty`、`inbox-error`、`inbox-inline-link`、`inbox-node-proposal`、`proposal-generic`、`proposal-summary`、`proposal-json`、`proposal-kind-*`、`proposal-status-row`、`proposal-retract`；事件页的 `ev-cause`、`ev-actor-mini`、`ec-correction-head`、`ec-muted`、`ec-error`；以及只给已删的 `AgentNoteCard` 用的 `an-note`、`an-rail`、`an-route`、`an-main`、`an-conf`、`an-evi-static`、`an-to-sep`、`an-body-b`、`an-code`。
- `src/capabilities/shell/ui/shell.css`：删掉 95 个收件箱类涉及的全部规则（176 条，含随之变空的 `@media` 块），1215 → 125 行。剩下的只有今日页还在用的晨报（`digest-*`）、费用摘要（`overnight-cost*`）、起始画像（`pf-*`），文件头改成说明这一点。
- 因为还有别处在用而**保留**的：今日页 AI 观察块的 `.an-scope` / `an-board` / `an-head*` / `an-sig` / `an-avatar` / `an-group-card` / `an-ag` / `an-from` / `an-to` / `an-flow` / `an-new` / `an-body` / `an-meta` / `an-evi` / `an-ttl` / `an-expire` / `an-empty` 等；全部 `tone-*`；`page*`、`eyebrow`、`serif`、`meta`、`badge`、`card`、`chip`、`seg`、`back-link`、`section`、`edge-proposal`、`pf-toast(s)`（做题页在用）；`katex-display`（KaTeX 生成的类，原规则随 `.inbox-loom` 作用域一起删了，新规则在 `inbox-m3e.css`）。`shell.css` 里零引用但属于今日页的 `pf-band*` / `pf-empty` / `pf-lead`，以及 `globals.css` 里其他页面的零引用规则，不在本片范围，没有动。
- 删掉的旧组件：`src/ui/primitives/SuggestionKindTag.tsx`（最后一个使用者是提议卡，现在提议卡直接渲染“修正”标签）、`src/capabilities/agency/ui/AgentNoteCard.tsx`（迁移前已无任何引用）和只给它用的 `derive.ts` 中的 `anInlineMd`。`Stateful`、`LoomCard`、`SectionLabel`、`SkLines`、`EmptyState`、`Btn`、`LoomBadge`、`CollapsibleList`、`ErrorState`、`LoomIcon` 仍有其他页面在用，保留。
- **与 `src/ui-next/AGENTS.md` I4 的冲突**：I4 说“不要编辑 `src/ui/`、`web/src/globals.css`”。这一线有书面例外：owner 要求删除全部旧界面（2026-10-20），根 `AGENTS.md` 的 S13 规定“DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除”，m3e 方向文档 `:98` 也要求“每片消费 M3E 后退出自己的旧样式”。这次只**删除**了这三页专用（或已无人用）的全局规则和一个失去最后使用者的旧组件（`SuggestionKindTag`），没有新增或修改任何全局规则；新样式全部放在限定作用域的三个 `*-m3e.css` 里。

## 逻辑未变的证明

方法同前两片：先把原文件存到仓库外。第一遍用 TypeScript 编译器去掉 import 和注释，把每个最外层 JSX 换成占位符 `JSX` 再逐行比对；第二遍把所有 JSX 属性里的函数 / ref / `on*` 表达式提出来，排序后比对。`/agent-notes` 的组卡拿原 `AgentNoteGroupCard` 和新 `AgentNoteGroupRow` 比。脚本：`tlp-status/_work/yuk1473/strip_logic.cjs`、`jsx_handlers.cjs`。

第一遍（JSX 之外）剩下的差异：
- `InboxPage`：删掉 `tierIcon`（图标名强转，换成 `inbox-look.ts` 的 `kindIcon`）；`TierHead` 多一个 `id` 参数（给 `aria-labelledby`）；`AutoAppliedCard` / `TierCBlock` 各多一个 `useId()`（给 `aria-controls`）；`AutoAppliedCard` 多一个局部 `KindIcon`；新增 `TierNote`、`InboxGate`（加载 → 出错 → 空 → 内容，顺序与原 `Stateful` 相同）和 `InboxStatus` 类型（与原 `StatefulStatus` 同一组取值，`resolveInboxStatus` 的函数体不变）；删掉 `toast` 状态和 `dismissToastLater`，`showError` 的函数体从 `setToast(…)` 改成 `showToast({ message: msg })`。查询、`DecisionBacklogDrain`、`UndoClock`、分桶、lane 排序、`onRevert`、`status` 计算逐字不变。
- `ProposalCard`：`EV_ICON` 的值从图标名换成 lucide 组件，`EvidenceChip` 多一个局部 `EvIcon`；置信度的嵌套三元改成 `confidenceOf`（同样三步：猜想 → null，payload 有数用它，合并卡用 proposed_change 的数，否则 null）；不再解构 `index`（只用于去掉的入场动画延迟，props 接口不变）；多一个局部 `CardIcon`。`decide`、合并确认、`locked`、各种标签推导逐字不变。
- `agency/ui/page.tsx`：状态的嵌套三元改成 `boardStatus`（同样的顺序和条件）；新增 `BoardGate`。筛选、计数、分组、已读逐字不变。
- `AgentNoteGroupRow` 对比 `AgentNoteGroupCard`：新增图标映射 `AGENT_ICON` 和色调映射 `signalToneRole`；`RESOLUTION_META` / `ATTENTION_META` 的文字不变，色调值换成 ui-next 的名字；事件链接的嵌套三元改成 `runEventHref`（同样：先 `caused_by_event_id`，再事件证据，否则 null）；到期提示改成 `TtlLine`。
- `EventDetailPage`：新增 `ACTOR_ICON`、`toneRole`、`ActorTag`（执行者的 `actorMeta` 调用从两个组件里挪进这里）、`Blocked`（404 / 403 的空态）。查询、`errorStatus`、`eyebrow`、纠正 mutation（参数、`retry: false`、`onSuccess` 里清空并失效）、`canSubmit` 逐字不变。

第二遍（JSX 里的处理函数）剩下的差异：
- `InboxPage`：A 档重试从按钮的 `onClick={() => void aaQ.refetch()}` 变成 `RetryLine` 的 `onRetry`，函数体相同；整页重试从 `Stateful` 的 `onRetry` 变成 `InboxGate` 的 `onRetry`，函数体相同；去掉了提示条的 `ref={dismissToastLater}`。
- `ProposalCard`、`AgentNoteGroupRow`：**没有差异**。
- `agency/ui/page.tsx`：两个筛选按钮从 `onClick` 变成 `ChipToggle` 的 `onPressedChange`，函数体逐字相同（`setFilter('all')`、`setFilter(filter === k ? 'all' : k)`）；重试从 `Stateful` 变成 `BoardGate`，函数体相同。
- `EventDetailPage`：404 / 403 的“返回来源”从两个按钮的 `onClick={onBack}` 变成 `Blocked` 组件的 `onBack` 再传给按钮；`FoldList` 的 `renderItem` 只多了括号。

没有新增任何 effect。

## 交互变化（键盘、焦点、由哪个元素触发）

- **改关系**：原来是 `role="tablist"` 里的 `role="tab"` 按钮（浏览器不给 tab 角色加方向键行为）。现在是 `fieldset`（说明“改为关系类型”）里的一排 `ChipButton`，当前关系用强调色并带 `aria-current`。每个芯片仍是点一下就提交 `change_type`，没有用 `Segmented`，方向键不会改关系。
- **改关系 / 追溯 / C 档展开**的按钮加了 `aria-expanded`（C 档和追溯还加了 `aria-controls`）；只是读屏信息，行为不变。
- **修正标签**的悬停提示从“suggestion_kind=corrective · 修正类建议不计入接受率”改成“修正类建议不计入接受率”。
- **AI 观察的信号筛选**：仍是只响应点击的按钮，现在用 `aria-pressed` 标出当前项（原来只有视觉高亮），包在“信号”`fieldset` 里。纯视图筛选，没有写入。
- **事件页顺序**：纠正面板从“当前记录”正下方挪到“之后发生”下面，让因果链连成一条（Tab 顺序随之变化：先经过“之后发生”的节点，再到纠正输入框）。纠正的写入方式、按钮和禁用条件不变，输入不会因此丢失。
- **页级错误提示**：收件箱的错误从页内自己的提示条（5 秒消失）改为 ui-next 的全站提示条（`ToastHost`，玻璃，右下角，4.5 秒，可手动关闭）。文案不变。
- **A 档读取失败**：改用 `RetryLine`（多了 `role="alert"`），按钮文字仍是“重试”。
- **加载中**：骨架改成 ui-next 的 `SkeletonLines`，读屏读到“正在读取收件箱 / 正在读取 AI 观察 / 正在读取事件证据”。

## 文案调整

- 去掉英文眉标“INBOX · AI 提议 · 按出手强度分流”和“AI 协作观察 · 只读”（说明句里已经讲了只读旁观）。事件页的“证据记录 · 动作”保留为标题上方的小字。
- 收件箱 B 档的 lane 计数、A / B / C 字母、所有提示、按钮、空态文案一字未改；事件页、AI 观察页的文案一字未改（概览里的统计还是“N 活跃观察 · 聚合为 M 个主题 · 涉及 K 项 AI 工作”）。
- 修正标签的悬停提示去掉了内部字段名（见上）。
- 新增的只有读屏用的名字：骨架的“正在读取 …”、筛选的“信号”、关系选择的“改为关系类型”（原来是 `aria-label`，现在是可见的小字说明）、概览区域的“观察概览”。

## 审查与验收

- 本机检查：`pnpm typecheck`、`pnpm lint`、`pnpm build` 和完整本地闸门（对比 merge-base）。结果见提交汇报。
- 独立审查重点：提议裁决（接受、改方向、改关系、忽略、归档、合并的确认与 409 `confirm_required`、过期合并的提示）、已裁决锁定、自动应用撤销与倒计时、裁决积压逐页补齐与“继续加载”、事件纠正的提交 / 清空 / 失效，逐一对照 main 上的旧组件。
- 真实页面检查（由协调线负责，独立开发库）：三页的加载 / 空 / 出错；收件箱每种写入（见汇报里的造数方法）；AI 观察的筛选、全部已读、展开运行与证据跳转；事件页的因果链跳转、技术详情、纠正三种写入；亮色 / 暗色；720px 与 560px 断点；触屏下写按钮换行时点击区不重叠；键盘焦点可见。
