# 今日页（/today）其余部分：M3E 呈现，修横向溢出

YUK-1713（夜链 · 交班带、今日 AI 成本、AI 失败提示、7 天热力仍是旧样式）、YUK-1324（`.today-page::before` 用 100vw 让页面比视口宽约 51px）· 上级 YUK-1473 · 2026-11-03 · 交付阶段：第一天能用（删旧界面，逐页迁移）

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:95`（§5「其余真实页面」）：「其后 notes/knowledge/coach/profile/admin 等按原功能票、真实修改面逐页圈定」；`:98`「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」；`:100`「作用域、无全局污染、同源资源、无业务规则等承重限制保留。」
   - `docs/design/2026-10-07-ui-visual-direction.md`：`:244`「L5 历史与次要长列表默认折叠」；`:297`「T1 组件只引用语义 token」；`:300`「T3 玻璃只给浮层」；`:323`「M1 只在变化时动」；`:359`「M14 三态：每个区域都设计载入（与布局一致的骨架…）、空（带进入动作）、出错（区域隔离、可重试、已保存的工作不受影响）」；`:366`「A2 触控目标：触屏上每个可点击目标的点击区 ≥ 44×44px」。
   - 协调裁定（2026-11-03）：只换呈现。查询与 query key（`queryKeys` 及 `['cost-today']`、`['agent-notes','board']`、`['placement-profile', id]`）、每一处写入（AI 改动撤销：`onSettled` 里的 `invalidateAfterAiChangeUndo`、按行记录的失败 id；生成学习路径；AI 观察的已读与展开存 localStorage）、请求内容、在途时禁用、出错提示、跳转目标、计数与求和，行为一律不变。不用 `Segmented` 做有副作用的事；学习主题输入框的状态、提交、回车提交保持原样；会换行的写按钮行在触屏上留够行距。不新增 `useEffect`，不加测试，不碰服务端、`ui-public.ts` 导出、`src/ui/components/response/*`、`write-invalidation.ts` 和 #2392 已迁的块；不写嵌套三元。
2. 组件类型：page（`/today` 是已有路由的整页）。没有新路由、弹窗或抽屉。路由宿主 `server/start/routes/today.tsx` 没有改。
3. 文件：
   - 新建：`src/capabilities/shell/ui/today-m3e.css`、本文件。
   - 修改（只改呈现）：`src/capabilities/shell/ui/TodayPage.tsx`；`blocks/AiChangesStrip.tsx`、`KpiRow.tsx`、`ProfileBand.tsx`、`ProposalStrip.tsx`、`SessionsStrip.tsx`、`WeekHeat.tsx`；`src/capabilities/agency/ui/AgentNotesBoard.tsx`、`LearningIntentComposer.tsx`、`learning-intent.css`（重写）、`agent-notes-m3e.css`（作用域放宽到今日页的观察块，加块自己的外框）、`AgentNoteGroupRow.tsx`（只改文件头注释）；`src/capabilities/observability/ui/event-detail-model.ts`（旧徽章的色调类型挪进本文件，见下）；`src/ui/primitives/index.ts`（去掉已删组件的导出）；`scripts/audit-learner-copy.ts`（学习者文案清单去掉已删的文件）；`web/src/globals.css`（只删规则、改两段分区说明）。
   - 删除：`src/capabilities/agency/ui/AgentNoteGroupCard.tsx`、`src/capabilities/shell/ui/shell.css`、`src/ui/primitives/LoomCard.tsx`、`Stateful.tsx`、`SkLines.tsx`、`LoomBadge.tsx`。

## 先查清楚今日页渲染了什么

从上到下（`TodayPage.tsx`）：

| 位置 | 组件 | 迁移前 | 本片 |
| --- | --- | --- | --- |
| 页头 | `TodayHeader`（`src/ui-next/today/`） | 已是 M3E | 不动 |
| 整页载入 / 出错 | `Stateful` + `SkLines` | 旧 | `AreaGate` + `SkeletonLines` |
| 1 | `DegradedKindsFlags`（AI 任务失败提示） | 旧（`LoomBadge`） | 换 |
| 2 | `TeachingBriefBand`（为你而备） | #2392 已迁 | 不动 |
| 3 | `OvernightDigestBand`（夜链 · 交班）：卡壳、三个展开芯片、去裁决 | 旧 | 换 |
| 3 内 | `PrepDeskConjectures`、`ProbeAnswers`、`OvernightCostSummary` | #2392 已迁 | 不动 |
| 4 | `KpiRow` 四个数字块 | 已是 M3E，只剩旧箭头图标 | 换图标 |
| 5 | `ProfileBand`（学习画像与依据） | 已是 M3E，载入 / 出错仍是 `Stateful` | 换 |
| 6 | `LearningIntentComposer`（下一条学习主线，agency 注入） | 旧 | 换 |
| 7 | 接下来做什么（`ThreadCard`） | 已是 M3E，只剩旧箭头图标 | 换图标 |
| 8 | 两列：`SessionsStrip`、`AiChangesStrip` / `ProposalStrip`、`CostRibbon` | 旧 | 换 |
| 9 | `AgentNotesBoard`（AI 观察，agency 注入）→ `AgentNoteGroupCard` | 旧 | 换成 `/agent-notes` 已用的 `AgentNoteGroupRow` |
| 10 | 过去 7 天：卡壳 + `WeekHeat` | 旧 | 换 |
| 冷启 | `ColdStart`（onboarding 注入） | 旧 | 不在本片（onboarding） |

`workbench-api.ts`、`workbench-client.tsx`、`inbox-api.ts`、`inbox-tier.ts`、`inbox-look.ts`、agency 的 `derive.ts` / `meta.ts` / `useAgentReads.ts` / `learning-intent-api.ts` 是逻辑，没动。

## 做了什么

- **外壳**：根仍是原来的 `main[data-ui-next][data-un-m3e="practice-foundation"].un-root.un-today-page`（去掉了旧的 `today-page today-loom` 两个类）。页头之下所有内容包进一个 `div.td-flow.un-m3e-bridge`，所以 ui-next 原件（按钮、芯片、骨架、重试行、折叠列表）读到的是今日页根上的 M3 角色。注入的两个 agency 组件根节点也各带 `un-m3e-bridge`，自身也成立。页面宽度、留白、标题、数字块、下一步卡、画像面板沿用 `src/ui-next/today/today.css`，没有改。
- **横向溢出（YUK-1324）**：原来的淡色铺底是 `.today-page::before`，宽 `100vw`、左边 `calc(50% - 50vw)`。今日页在侧栏右边、内容列居中，这个盒子按视口算宽度，又从内容列中点往左右各伸半个视口，于是右边伸出去约一个侧栏宽度的一半加滚动条，出现横向滚动。现在铺底改成页面根自己的背景层（`today-m3e.css` 第一条规则：secondary-container 55% → 透明，高 440px，不重复）。背景层只画在根自己的盒子里，根是 `width: 100%; box-sizing: border-box`，所以任何宽度下都不可能比页面宽，也不需要靠外壳裁切。旧的 `.today-page` / `::before` / `> *` 三条规则删掉了。其余可能撑宽的地方一并处理：行、卡、芯片、标签都是 `min-width: 0` 并允许换行（原会话条和改动条的 `nowrap-meta` 不再用），热力的星期轴是 `minmax(0, 1fr)` 七等分。
- **卡片**：两列的四张卡、夜链卡、7 天热力卡统一成今日页的白色面板（surface-container-lowest、24px 圆角、细线、无阴影；≤760px 时内边距 16px）。卡头是一个 36px 圆形图标（夜链、AI 改动、热力是 secondary-container，其余中性）+ 真实 `h3` 标题 + 右侧一项（计数说明、“可回滚”、“去收件箱”按钮、“共 N 次活动”）。
- **AI 失败提示**：见文末 2026-11-07 更新，取代这里原来「每个失败的任务类型一行浅红条」的做法。
- **夜链 · 交班**：分区标题“夜链 · 交班”（原 `SectionLabel` 也是 h2）+ 卡“昨夜 AI 替你做了什么”（月亮图标）。卡里是 `AreaGate`（载入骨架、出错重试、内容）。安静的夜晚是一行灰字；有活动时是一个带细边的展开按钮“昨夜 AI 还替你做了这些”（`aria-expanded`，展开后变 secondary-container，箭头转 180°），展开后是一排计数芯片（夜间任务 / 笔记精炼 / 图谱提议 / AI 观察是静态芯片，“备课猜想 N”是同样的展开按钮）、备课猜想面板、“去裁决 →”次要按钮。卡底是已迁的“昨日 AI 用量与费用”。卡下方独立的“待你试做 N”也是同样的展开按钮。所有展开仍是条件渲染（没有换成 `Expand`：`Expand` 会提前挂载内容，提前发起备课猜想 / 试做题的查询）。
- **AI 改动 · 近 24h**：行是“图标块 + 标题（执行者等宽 + 改了笔记）+ 等宽小字（ops · blocks · 版本 · 时间）+ 右侧”。没撤销的是幽灵按钮“撤销”（撤销图标），已撤销的是绿色勾“已撤销”，整行正文淡到 62%。撤销失败的提示在该行下方（红字，`role="alert"`）。最近 3 条在前，其余收进“全部 N 条”（`FoldList`，与原 `CollapsibleList` 同一套接口和行为）。
- **进行中的会话**：同样的行；图标块进行中为 positive、其他为 caution；小字前是状态芯片（进行中 / 已完成 / 已中断）；右侧“继续 →”（主按钮）或“恢复 →”（次要按钮）。
- **提议收件箱**：大号数字（40px，等宽数字）+ 扫描上限提示 + 各类提议的色调标签（类型色调经 `inbox-look.ts` 的 `inboxTone`，与收件箱一致）。没有待审时一行灰字。
- **今日 AI 成本**：28px 金额、说明、按任务的芯片（悬停仍显示该任务的费用说明）、“共 N 次 AI 工作”。
- **下一条学习主线**：分区标题 h2 + 白色面板：圆形目标图标、h3 标题、说明；已有待确认路径时是一块浅暖色提示加“去收件箱 →”；否则是输入框 + “生成学习路径”（次要按钮，生成中图标换成刷新、文字换成“正在生成…”）。输入框是 M3 描边输入框（48px 高、12px 圆角、聚焦时 primary 描边，禁用时浅底）。出错是浅红提示条（`role="alert"`）。生成后的预览：小字“待你确认的主线”、主线标题、positive 芯片“已生成提议”、摘要、编号步骤（长期项的编号是 primary 色）、“确认前不会改动…”和主按钮“去收件箱确认 →”。
- **AI 观察**：分区标题“AI 观察”+ 右侧“N 组 · M 条”。块是一个浅底（surface-container-low）面板：头部是可点的标题区（眼睛图标 + “AI 之间的观察” + 说明，`aria-expanded`）、未读标签“N 新”（不再闪烁）、“看全部 →”、展开 / 收起图标按钮（`aria-label` 收起 / 展开，箭头转 180°）。展开后是一张白色分隔线列表，每行就是 `/agent-notes` 的 `AgentNoteGroupRow`（同样的来源头像、来源 → 目标、信号标签、标题、摘要、关注度 / 解决状态、运行与证据折叠），下面一行“只读旁观 · 过期信号自动消失”、“还有 N 组 · 看全部 →”、“全部已读”。收起时是一行可点的预览（最新一条：来源 → 目标 提到「信号」· 时间）。空时仍只有一行灰字。
- **7 天活动热力**：七个 40px 高的圆角块一行排开，颜色按原分档（0 为 surface-container-high，1–5 逐级混入 primary，5 为实色 primary）；下面一行“星期 · 次数”。去掉了原来逐格弹出的入场动画。
- **嵌套三元**：整页状态、AI 观察状态改用已有的 `statefulStatus`（同样两步）；成本卡状态 `costStatus`、改动条状态 `stripStatus`（载入 → 出错 → 空 → 内容）；会话状态文字 `statusLabelOf`；提议数字 `proposalsValue`（数字块）/ `decisionCountText`（提议卡）（不带上限 → 精确数；带上限且 > 0 → “≥N”；否则“?”）；AI 观察的主体改成 if / else 依次赋值。顺序与条件都不变。
- **动效**：只在变化时动。展开按钮底色与箭头、行与按钮的悬停底色、输入框描边都读 `--un-t-*`（减少动效时为 1ms）；学习者打开的展开区（`.td-reveal`）和观察块里打开的运行列表淡入一次，关键帧只在没有要求减少动效时存在。去掉了热力弹出动画和未读标签的闪烁点。没有入场动画。玻璃不出现在页面上（T3）。
- **触控**：展开按钮、观察块的展开图标按钮、“还有 N 组”都加了 `un-hit`；ui-next 按钮自带。会换行的行在 `pointer: coarse` 下行距 16px：夜链的计数芯片行（含“备课猜想”展开按钮）、“去裁决”所在行、观察块头部（标题区 / 看全部 / 展开）和底部（还有 N 组 / 全部已读）。学习主题表单在窄屏上下排列，输入框与按钮都是 48px 高，间距 8px，点击区不重叠。今日页自己的规则把根下所有 ui-next 按钮设成 48px 高的胶囊（`today.css`），所以小号按钮在今日页上也是 48px，这是今日页已有的语言，没有改。

## 删除旧样式与旧组件

- 方法同前几片：严格整词匹配（类名只算完整的 `[A-Za-z0-9_-]` 词）在全部 `.ts` / `.tsx` 里确认 0 使用，再用 `drop_css_classes.py` 删规则（复合选择器列表只删死掉的那一项）。模板前缀逐个看过：`tone-${…}` 仍有别处在拼，所有 `tone-*` 一个没删；`digest-${…}` 只出现在一个测试的字符串里，不是类名；`is-${…}` 已无人在拼。被删的选择器里没有把死类放在 `:not()` 里的情况。脚本：`tlp-status/_work/yuk1473/class_usage.py`、`tlp-status/_work/yuk1465/drop_css_classes.py`；清单在 `tlp-status/_work/yuk1473/today/dead-globals*.txt`。
- `web/src/globals.css`：7319 → 5884 行。删掉 108 个类涉及的规则（含随之变空的 `@media` 块）共 221 条，另有 2 个选择器列表被裁掉一项（`.inbox-strip` 与 `.lane-item`），再手工删了 6 处只剩空壳的东西：孤立的 `@keyframes loom-weave-draw`、`heat-pop`、`an-feed-in`（连同它变空的 `@media`）、`loom-sk`、`loom-pulse-dot` 和 `.badge .dot.pulse`。旧今日页的 7A / 7B 两大分区、`.today-page` 铺底、夜链芯片分区、AI 观察 `.an-*` 整个分区及其空注释都清掉了；`loom-rise` 关键帧还被 `.items-loom` 用着，留下并注明。
  - 本片迁移后归零的：`today-page`、`today-loom`、`an-*`（全部 37 个）、`strip-*`、`is-undone`、`prop-summary*`、`cost-amt` / `cost-top` / `cost-tasks` / `cost-foot`、`week-heat`、`heat-row`、`chip-toggle`、`is-open`、`pd-chev`、`prep-desk-expand`、`tb-degraded-flags`、`card-title`；随 `LoomCard` / `SkLines` / `LoomBadge` 删掉而归零的 `card-pad`、`card-pad-lg`、`card-hover`、`card-sunk`、`sk-stack`、`sk-line`、`pulse`。
  - 同一批今日页分区里早就没人用的遗留：`loom-hero`、`hero-*`、`wv*`、`kpi-row`、`thread-*`、`threads-grid`、`dash-grid`、`dash-col`、`cost-budget`，旧“/today lanes + cost ribbon”分区的 `inbox-strip*`、`inbox-text`、`ai-change-strip*`、`lane-head` / `lane-eyebrow` / `lane-empty` / `lane-body` / `lane-item` / `lane-cta`、`is-stub`、`cost-ribbon`。
  - 人工核对（只在注释里出现，没有元素会带这些类）：`card-head`、`probe-queue`、`heat-axis`、`heat-cell`、`strip-title`；`sk` 的 3 处“使用”都是变量名或 API key 前缀。
- `src/capabilities/shell/ui/shell.css`：整个文件删掉。它最后的导入者是今日页，剩下的 12 个类（`digest-chips`、`digest-foot`、`pf-*`、`is-soft`）全部 0 使用。
- `learning-intent.css` 原地重写成 M3E，旧的 `.li-intent-section` 等写法随之消失。
- 删掉的旧组件：`AgentNoteGroupCard`（最后一个使用者是今日页的观察块）、`LoomCard`、`Stateful`、`SkLines`（最后的使用者都在今日页，`SkLines` 另一个使用者是 `Stateful`）、`LoomBadge`（最后一个渲染它的是今日页；事件证据页的 `event-detail-model.ts` 只借用了它的色调类型，类型已原样挪进该文件，取值不变，事件页照旧把它映射到 ui-next 色调）。
- 因为还有别处在用而**保留**的：`Btn`（做题页 `PfShelf` / `PfPaper` / `PfRetro`、`ColdStart`、`ErrorState`）、`LoomIcon`（外壳旧件、作答组件、做题页、onboarding、`meta.ts` 等的图标名类型）、`SectionLabel`（`PfShelf`）、`CollapsibleList`（`PracticeSolo`）、`EmptyState`（`PfShelf` / `PfRetro`）、`ErrorState`（`PfRetro`、`PracticeFacePage`）。全局类 `quiet-empty`、`nowrap-meta`、`card`、`card-icon`、`chip`、`badge`、`meta`、`serif`、`mono`、`tnum`、`tone-*`、`lanes` / `lane` 等仍有别处在用（或作为词出现），没删。`globals.css` 里其他页面的零引用规则（如 `app-shell*`、会话页的 `ss-*`）不在本片范围。
- **与 `src/ui-next/AGENTS.md` I4 的冲突**：I4 说“不要编辑 `src/ui/`、`web/src/globals.css`”。这一线有书面例外：owner 要求删除全部旧界面（2026-10-20），根 `AGENTS.md` 的 S13 规定“DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除”，m3e 方向文档 `:98` 也要求“每片消费 M3E 后退出自己的旧样式”。这次在 `globals.css` 只**删除**了今日页专用（或已无人用）的规则、改了两段分区说明，没有新增或修改任何全局规则；在 `src/ui/` 只删除了失去最后使用者的四个旧组件和它们在 `index.ts` 里的导出。新样式全部在限定作用域的 `today-m3e.css`、`learning-intent.css`、`agent-notes-m3e.css` 里。

## 逻辑未变的证明

方法同前几片：原文件先存到仓库外（`tlp-status/_work/yuk1473/today/orig/`）。第一遍用 TypeScript 编译器去掉 import 和注释，把每个最外层 JSX 换成占位符 `JSX` 再逐行比对；第二遍把所有 JSX 属性里的函数 / ref / `on*` 表达式提出来，排序后比对；第三遍把表单 / 写入相关属性（`disabled`、`value`、`type`、`id`、`htmlFor`、`maxLength`、`placeholder`、`title`、`aria-*` 等）提出来比对。观察块的组卡拿原 `AgentNoteGroupCard` 和 `AgentNoteGroupRow` 比。脚本：`tlp-status/_work/yuk1473/strip_logic.cjs`、`jsx_handlers.cjs`、`admin-b/jsx_attrs.cjs`，入口 `today/logic.sh`，结果在 `today/logic-diff.txt` 与 `today/attrs-diff.txt`。

第一遍（JSX 之外）剩下的差异：
- `TodayPage`：`Thread.icon` 类型从 `LoomIconName` 换成同值的 `'review' | 'inbox'`；`DigestChip.icon` 换成同值的 `DigestIcon`，新增 `DIGEST_ICON`（名字 → lucide）和渲染用的 `DigestGlyph`；成本卡状态的嵌套三元改成 `costStatus`；`statefulStatus` 的返回类型换成同值的 `Exclude<AreaStatus, 'empty'>`；整页状态的嵌套三元改成调用 `statefulStatus`。查询、`useOvernightDigest`、`buildDigestChips`、`deriveThreads`、`aiTaskLabel`、`learnerFailureSummary`、两处渲染中自动收起、`canDecide` / `hasActivity` / `hasProbes`、冷启判断逐字不变。
- `AiChangesStrip`：新增 `stripStatus`（原嵌套三元）。`failedIds`、`clearFailed`、`undoM`（`onMutate` / `onError` / `onSuccess` / `onSettled` 里的 `invalidateAfterAiChangeUndo`）逐字不变。
- `KpiRow`：`icon` 类型换成同值的字面量联合；新增 `proposalsValue`（原嵌套三元）。
- `ProfileBand`：`queryStatus` 返回类型换成同值的 `AreaStatus`。
- `ProposalStrip`：新增 `decisionCountText`（原写在 JSX 里的嵌套三元）。
- `SessionsStrip`：新增 `statusLabelOf`（原嵌套三元）。
- `AgentNotesBoard`：新增按顺序赋值的 `body`（原 JSX 里的四层嵌套三元）。
- `WeekHeat`、`LearningIntentComposer`：**没有差异**。
- `AgentNoteGroupRow` 对比 `AgentNoteGroupCard`：与上一片记录的相同（图标与色调映射、色调值改名、`runEventHref`、`TtlLine`），这次没改这个文件的代码。
- `event-detail-model.ts`：多一行本地类型 `LoomBadgeTone`（与原导入的类型同值）。

第二遍（JSX 里的处理函数）：**全部没有差异**（11 个文件）。撤销的 `onClick`、各展开按钮的 `onClick`、`onRetry`、`navigate(...)` 的目标、`markAllRead(notes)`、`toggleOpen`、学习主题的 `onSubmit` / `onChange` 一字未变。

第三遍（表单 / 写入属性）剩下的差异：
- 各文件少掉的 `name="…"` 都是旧 `LoomIcon` 的图标名，不是表单属性。
- `TodayPage` 少一个 `title=learnerFailureSummary(…)`：原因改成了可见文字（见上）。
- `AgentNotesBoard` 少一个 `type="button"`：“看全部”从原生按钮换成 ui-next `Button`，它默认就是 `type="button"`。
- `disabled`（撤销、生成学习路径、输入框）、`value`、`maxLength`、`placeholder`、`id` / `htmlFor`、`aria-expanded`、`aria-label`、`aria-live`、`role` **全部不变**。

没有新增任何 effect；没有用 `Segmented`；新代码里没有嵌套三元。

## 今日页上的每一个写入

- **撤销 AI 改动**（`AiChangesStrip`）：同一个 `useMutation`，`mutate({ artifactId, eventId })` 的参数不变；在途时所有撤销按钮禁用（`undoM.isPending`）；开始时清掉本行的失败标记，失败时把本行加进失败集合，成功时清掉；`onSettled` 里 `void invalidateAfterAiChangeUndo(qc, { artifactId })`。失败提示仍只在本行下方，`role="alert"`。
- **生成学习路径**（`LearningIntentComposer`）：`topic` 的 `useState`、`submit` 里的 `preventDefault` + `trim` + 在途拦截、`mutation.mutate(normalized)` 不变；表单 `onSubmit` 不变，所以回车照样提交；输入框禁用条件 `isPending || plan`、按钮禁用条件 `!topic.trim() || isPending || plan` 不变；输入时有错误就 `reset()` 不变。
- **AI 观察已读 / 展开**（`AgentNotesBoard` → `useAgentReads`）：`toggleOpen` 与 `markAllRead(notes)` 原样调用（标题区和图标按钮都切换展开、预览行点开、“全部已读”），localStorage 的键与格式在 `useAgentReads.ts` 里没动。
- **为你而备 / 备课猜想 / 待你试做 / 费用展开**：#2392 已迁的块，没动；它们在今日页上的挂载条件（展开才挂载）不变。
- **跳转**：`/practice`、`/record`、`/inbox`、`/mistakes`、`/knowledge`、`/knowledge/:id`、`/profile?goal=`、`/agent-notes`、`/events/:id` 与证据链接，目标与触发元素都不变。“学习伙伴”与“提出异议”仍调用 `openCopilot`（异议仍 `send: false`，只填入）。

## 交互变化（键盘、焦点、由哪个元素触发）

- **标题层级**：卡片标题从无语义的 `div` 变成 `h3`（AI 观察块的“AI 之间的观察”仍在按钮里，没改）；“夜链 · 交班”“下一条学习主线”“AI 观察”仍是 `h2`。几张卡的外层从 `div` 变成 `section`（没有命名，不会多出地标）。
- **出错态**：整页、夜链、成本、改动、画像、AI 观察的出错从旧 `ErrorState`（带图标的次要按钮“重试”）改成 `RetryLine`（文字按钮“重试”），两者都是 `role="alert"`，文案不变。
- **载入**：骨架换成 `SkeletonLines`（`role="status"`），读屏读到“正在读取今日工作台 / 昨夜交班 / 今日 AI 成本 / AI 改动 / 学习画像 / AI 观察”。
- **AI 失败提示**：原因从悬停提示变成可见文字，不再有 `title`。
- **AI 观察**：“看全部”从原生按钮换成 ui-next 按钮（元素、名称、目标不变）；未读标签不再闪烁；收起时的预览行、展开图标按钮的 `aria-label` 不变。展开后每组是 `/agent-notes` 的行：来源头像改为读屏隐藏（来源名就在旁边的文字里），“查看本次运行与证据”多一个随展开旋转的箭头，证据链接在触屏上有 44px 点击区。
- **热力**：每格仍有 `aria-label` 与 `title`；去掉了入场弹出动画。
- **学习主题输入**：读屏标签从旧的 `sr-only` 换成 ui-next 的 `un-sr-only`（同效果）；元素、`id`、属性、回车提交都不变。

## 文案调整

- 新增：读屏用的骨架名称（见上）。
- 其余标题、说明、按钮、空态、出错文案一字未改；AI 失败原因原来就有，只是改为直接显示。

## 审查与验收

- 本机检查：`pnpm typecheck`、`pnpm lint`、`pnpm build` 和完整本地闸门（对比 merge-base）。结果见提交汇报。
- 独立审查重点：撤销的按行失败 / 在途禁用 / 失效；学习主题的提交、回车、禁用与出错重置；AI 观察展开 / 已读与 `/agent-notes` 共用 localStorage；夜链三处展开的条件挂载与自动收起；冷启门不变。
- 真实页面检查（由协调线负责，独立开发库）：每一块的载入 / 空 / 出错 / 有数据；亮色 / 暗色；1440px、1240px、880px、760px、640px、375px、320px 下 `document.documentElement.scrollWidth === clientWidth`（无横向滚动）；触屏下换行的按钮点击区不重叠；键盘焦点可见。

## 2026-11-07 更新：AI 失败提示（YUK-1965）

Owner 2026-11-06 在 TEST 今日页：「AI运行错误提示能不能手动消掉啊」。协调线 2026-11-07 裁决：今日页只提示学习者感受得到的任务，内部任务只留 `/admin/runs`。

- 只有一条提示：「有些 AI 工作没做完 · 相关的结果可能晚点到。」，带「知道了」。不写任务名、次数和原因，这些在 `/admin/runs`。语气是提醒（caution），不用红色，学习者不需要处理。
- 算学习者感受得到的（明确名单）：学习伙伴、教学回合、判分、材料录入、笔记生成和修改。其他（出题、解题、核验、知识整理、夜间任务等）不提示，新增任务默认也不提示。
- 「知道了」写到服务端，换设备也不再出现。同一段连续失败不算新的；成功后又连续失败，或第二天夜间窗口又有失败，才再出现。
- 关闭失败时提示还在，并写「刚才没有关掉，再点一次试试。」。
- 联网搜索不可用的提示仍是单独一行，文字由服务端给，同样可以关。这类提示没有固定的故障编号，超过 7 天的故障最多每周提醒一次。
- 学习伙伴底部的发送错误也有「知道了」，只影响当前显示。
