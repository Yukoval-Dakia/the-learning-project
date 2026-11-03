# 管理后台只读页：M3E 呈现（运行 / 成本 / 失败 / 覆盖 / 猜想评分）

YUK-1473 · 2026-11-03 · 交付阶段：第一天能用（删旧界面，逐页迁移）

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:95`（§5「其余真实页面」）：「其后 notes/knowledge/coach/profile/admin 等按原功能票、真实修改面逐页圈定」；`:98`「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」；`:100`「作用域、无全局污染、同源资源、无业务规则等承重限制保留。」
   - `docs/design/2026-10-07-ui-visual-direction.md`：`:297`「T1 组件只引用语义 token」；`:300`「T3 玻璃只给浮层」；`:323`「M1 只在变化时动」；`:359`「M14 三态：每个区域都设计载入（与布局一致的骨架…）、空（带进入动作）、出错（区域隔离、可重试、已保存的工作不受影响）」；`:366`「A2 触控目标：触屏上每个可点击目标的点击区 ≥ 44×44px」。
   - 协调裁定（2026-11-03）：本片只做管理后台的五个只读页（批次 A）；`/admin/subjects`、`/admin/subjects/$id`、`/admin/config` 是批次 B，另开 PR。只换呈现：查询、query key、轮询间隔、刷新 / 重新扫描的失效、运行记录的选中对账、费用与 Brier 的计算、跳转目标一律不变；不新增 `useEffect`，不加测试，不碰服务端、`ui-public.ts` 导出、`src/ui/components/response/*`、`write-invalidation.ts`；保留所有截断（错误摘要 180 字、id 前 10 位）；不出现嵌套三元；表格保持表格。
2. 组件类型：page（五个已有路由的整页）。没有新路由、弹窗或抽屉。路由宿主 `server/start/routes/admin.*.tsx` 一个都没改。
3. 文件：
   - 新建：`src/capabilities/observability/ui/admin-frame.tsx`（五页共用的外壳、页内导航、页头、数字块、面板、载入 / 出错）、`src/capabilities/observability/ui/admin-m3e.css`、本文件。
   - 修改（只改呈现）：`admin-runs.tsx`、`admin-cost.tsx`、`admin-failures.tsx`、`coverage-lattice.tsx`、`conjecture-scores.tsx`、`observability-shared.tsx`；`web/src/globals.css`（只删规则）。
   - 删除：无文件。

## 先查清楚谁在用什么

- 五个路由宿主都经 `ui-public.ts` 的 `loadAdmin…Surface` 懒加载页面组件，传 `navigate` 与 `startAdminClient`。宿主不变。
- 五页都是只读页。页面上的动作只有：运行 / 成本 / 失败的「刷新」（`invalidateQueries` 本页的 key；运行页另失效当前选中运行的详情）、覆盖页的「重新扫描」（同样是失效，扫描期间禁用）、运行详情里的「复制错误摘要」（写剪贴板）、出错时的「重试」（`refetch`，覆盖 / 猜想两页）、选中某条运行、页内导航。没有任何服务端写入。
- `observability-shared.tsx`：`AdminLinks` 还被 `/admin/config`（批次 B）用，**保持原样**；`LoadingCard`、`ErrorCard`、`Kpi`、`sectionHeadStyle`、`sectionTitleStyle`、`mutedTextStyle` 只有本片五页在用，随迁移删除；`formatMoney`、`formatTime`、`shortId`、`statusTone` 留在原处（`statusTone` 换成 ui-next 的色调名）。`currencySymbol` 本来就没人用，不在本片范围，没动。
- `observability.tsx` 是一个没有任何导入者的兼容出口，只做再导出；导出的名字都还在，文件没改。
- `subjects.tsx`、`subject-traits.tsx`、`config*.tsx` 各自有本地样式和旧 primitives，本片不碰。

## 做了什么

- **外壳**：`<UiNextRoot className="adm-page">` + `<main className="adm-main un-m3e-bridge">` + `<ToastHost />`，做法同题库页和教练页（`AdminFrame`）。宽度与留白同教练页（最宽 1240px，左右 `clamp(16px, 4vw, 48px)`），样式都限定在 `[data-ui-next].adm-page` 下，颜色走 M3 角色。
- **页内导航**（`AdminNav`）：页面最上方一排胶囊链接，当前页是 secondary-container 底色并带 `aria-current="page"`，窄屏横向滚动。链接目标和顺序与原来完全一致：运行 / 成本 / 失败三页仍是原 `AdminLinks` 的七个（含配置），覆盖 / 猜想两页仍是各自的六个（不含配置）。点击仍是 `preventDefault` + `navigate(to)`。
- **页头**（`AdminHead`）：小字（原 eyebrow）、标题、动作按钮（刷新 / 重新扫描，次要按钮 + 刷新图标）、说明。
- **数字块**（`AdminKpis` / `AdminKpi`）：四格，surface-container-low、16px 圆角、24px 等宽数字；760px 以下两列。标签、数值、注释与原来逐字相同。
- **面板**（`AdminPanel`）：白底 + 细线 + 16px 圆角，没有阴影（T3）；左边真 `h2`、右边计数 / 状态芯片，整块是 `section aria-labelledby`。放表格的面板（`flush`）里表格贴边：表头一行浅底，行间细线，id / 金额 / 分数 / 时间是等宽字体并右对齐数字列。只有面板是卡片，表格行不是。
- **运行记录**：左「最近运行」表格 + 右「Timeline」（960px 以下上下排列）。选中的行有浅色底 + 左侧 3px primary 边，任务名变 primary。Timeline 里：运行信息块（run / job / 时长 / 费用）、结果与结束原因芯片、错误摘要（error-container 底色的等宽块）+「复制错误摘要」、事件列表（类型芯片 + 标签 + 等宽的时间 / 延迟 / 费用 / token）。「刷新后已离开当前列表」的提示是 caution 色小条。
- **成本**：同样的左右两栏，每行是「日期 · 币种 / 任务 · 币种」+ 进度条（primary 填充，宽度算法不变）+ 金额，下一行是口径说明；760px 以下金额移到第一行右侧、进度条独占一行。
- **失败聚类**：每个聚类一个面板，标题是错误前缀（等宽），下面是「latest … · n samples shown」，右侧 critical 芯片「finish_reason · 次数」；样本从无表头的四格网格改成带表头的紧凑表格（run / task / model / started）。没有失败时是一个 positive「clear」小面板。
- **供题覆盖**：每科一个面板 + 表格；缺口从属于知识点那一格，仍是「芯片 + wants 行 + 派发记录」，脚手架坐标仍是灰色斜体，冷却到期时间是 caution 色。判词格：✓ / critical「gap」/ 中性「未评估·空池」。
- **猜想评分**：页头下面是 score_basis 诚实栏（等宽浅底小条，可换行，原来是一个会撑破的长芯片）；数据质量提醒是 caution 底色块（仍在原来那个 `role="status"` 区域里）；两张表格的单元格都是等宽字体。
- **色调**：旧 Badge 色调换成 ui-next `Chip` 色调：good → positive、again → critical、info → accent、coral → caution、neutral 不变。涉及 `statusTone`、`timelineTone`、`coverageScanStateTone`、`gapTone`、`resolutionTone`、结果 / lifecycle 芯片。
- **载入 / 出错**：运行 / 成本 / 失败的载入换成 `SkeletonLines`（读屏名「runs 加载中」等），出错换成 `AdminError`（error-container 色块，`role="alert"`，仍显示原错误消息）。覆盖 / 猜想原来用 `Stateful`，现在用同顺序的 `AdminArea`：载入 → 骨架（「覆盖细目扫描中」「加载中」），出错 → `RetryLine`（原文案 +「重试」，仍是 `q.refetch()`）。
- **嵌套三元**：复制按钮文案改成 `COPY_LABEL` 查表；覆盖 / 猜想的 `Stateful` 状态改成 `adminAreaStatus`（载入 → 出错 → 正常，同顺序）；「KCs with gaps」的注释改成 `kcsWithGapsNote`（未扫描 → not evaluated，有缺口 → needs supply，否则 clear，同顺序）。
- **动效**：只在变化时动。导航、行内按钮的颜色过渡，成本条宽度在刷新后变化时的过渡，都读 `--un-t-*`（减少动效时是 1ms）。没有入场动画、没有关键帧、没有转圈；玻璃只在 `ToastHost` 上。
- **触控**：导航链接、运行行里的选择按钮加了 `un-hit`；ui-next 的 `Button` 自带。五页没有会换行的写入按钮行，所以不需要额外行距。

## 删除旧样式

- 方法同前几片：严格整词匹配（类名只算完整的 `[A-Za-z0-9_-]` 词）在全部 `.ts` / `.tsx` 里确认 0 使用，且原五个页面文件用过，再用 `drop_css_classes.py` 删规则。没有模板前缀拼出这些类名。脚本：`tlp-status/_work/yuk1473/class_usage.py`、`tlp-status/_work/yuk1465/drop_css_classes.py`，结果在 `tlp-status/_work/yuk1473/admin/usage-globals.json`。
- `web/src/globals.css`：删掉 10 个类涉及的 30 条规则，另有 1 个选择器列表被裁掉死项（「Gradient finish pass」里 `.kpi, .lane, .loom-card, …` 去掉 `.kpi`），7550 → 7374 行：
  - `kpi`、`kpi-strip`、`kpi-num`（含 `small`）、`kpi-label`、`kpi-trend`（含 `.up` / `.down`）：最后的使用者是本片五页的 `Kpi`。人工核对：严格整词扫描里 `kpi` 还有 5 处「使用」，全是今日摘要数据里叫 `kpi` 的字段（`s.kpi.due_count`、`WorkbenchSummary['kpi']`、服务端 / 生成的类型），不是类名；今日页的数字块早已改用 `un-today-metric`。所以 `.kpi.kpi-clickable*` 和今日页旧分区里的 `.today-loom .kpi`、`.kpi:hover`、`.kpi .kpi-label` / `.kpi-val`（含 `.unit` 与 900px 断点）/ `.kpi-foot` / `.kpi-go` 也都已无元素可命中，一并删掉。
  - `admin-two-column`、`admin-bar-row`、`admin-bar-track`、`admin-sample-grid`（含 759.98px 断点里的四条）：只有本片在用。
  - 空掉的「/admin — observability surfaces」分区说明删掉；「/today — KPI strip + lanes + cost ribbon」改成「/today — lanes + cost ribbon」；今日 KPI row 说明里关于 `.kpi` 的一句删掉。
- 因为还有别处在用（或不是本片页面用过）而**保留**的：`page`、`wide`、`page-head*`、`meta`、`sub` 等通用类；`.today-loom .kpi-row`（不是本片页面用过的类，留给今日页那一片）。
- 批次 B 仍在用、本片**没有动**的：`AdminLinks`（`/admin/config`）、`subjects.tsx` / `subject-traits.tsx` 的本地样式和它们用的旧 primitives。
- 旧组件：`Badge`、`Card`、`PageHeader`、`Stateful`、旧 `Button` 仍有其他页面在用（批次 B 管理页、今日页、`TokenGate` 等），一个都没删。
- **与 `src/ui-next/AGENTS.md` I4 的冲突**：I4 说「never edit `src/ui/`, `web/src/globals.css`」。这一线有书面例外：owner 要求删除全部旧界面（2026-10-20），根 `AGENTS.md` 的 S13 规定「DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除」，m3e 方向文档 `:98` 也要求「每片消费 M3E 后退出自己的旧样式」。这次只**删除**了本片专用（或已无人用）的全局规则和一段空分区注释，没有新增或修改任何全局规则，`src/ui/` 一个文件都没碰；新样式全部在限定作用域的 `admin-m3e.css` 里。

## 逻辑未变的证明

方法同前几片：原文件先存到仓库外（`tlp-status/_work/yuk1473/admin/orig/`）。第一遍用 TypeScript 编译器去掉 import 和注释，把每个最外层 JSX 换成占位符 `JSX` 再逐行比对；第二遍把所有 JSX 属性里的函数 / ref / `on*` 表达式提出来，排序后比对。脚本：`tlp-status/_work/yuk1473/strip_logic.cjs`、`jsx_handlers.cjs`，结果在 `tlp-status/_work/yuk1473/admin/logic-diff.txt`。

第一遍（JSX 之外）剩下的差异：
- `admin-runs.tsx`：`timelineTone` 的返回类型换成 `ChipTone`，返回值按上面的色调对照换名（判断条件和顺序不变）；新增 `COPY_LABEL`（原复制按钮文案的嵌套三元，同样三种状态）；删掉内联样式常量。选中对账（`reconciledRuns` / `staleRunId` / `selectedRunId`）、`selectRun`、`refreshRuns`、两个查询及 key、`totals`、`taskLabel`、`formatDuration`、`shortErrorSummary`（180 字截断）、`failedWindowNote`、`copyError` 逐字不变。
- `admin-cost.tsx`：只删了内联样式常量。`maxByCurrency`、`barWidthPct`、`formatTokens`、`describeCosts` 的用法、查询及 key 逐字不变。
- `admin-failures.tsx`：只删了内联样式常量。
- `coverage-lattice.tsx`：`coverageScanStateTone`、`gapTone` 的返回类型与色调换名；`NAV` 的类型换成 `AdminNavLink[]`、标签换成中文（目标与顺序不变）；去掉本地 `link` 帮手（同样的 `preventDefault` + `navigate` 挪进 `AdminNav`）和本地 `Kpi`；新增 `kcsWithGapsNote`（见上）；删掉内联样式常量。`classifyCoverageScanState`、`coverageScanStateLabel`、`daysAgo`、`formatTime`、`gapKindSummary`、无轮询的查询逐字不变。
- `conjecture-scores.tsx`：`resolutionTone` 的返回类型与色调换名；`NAV` 同上；去掉本地 `link` 和 `Kpi`；删掉内联样式常量。`fmt`、`mean`、`pairedBrier`（只在 model 与 baseline 都有值的同一批行上聚合）、`diagnosticWarnings`、`openStates` 逐字不变。
- `observability-shared.tsx`：`statusTone` 的返回类型与色调换名；删掉 `LoadingCard`、`ErrorCard`（错误消息的取法原样挪进 `AdminError`）、`Kpi` 与三个样式常量。
- `observability.tsx`：**没有差异**。

第二遍（JSX 里的处理函数）剩下的差异：
- `admin-cost.tsx`、`admin-failures.tsx`：多一行 `actions=JSX`——刷新按钮现在作为 `AdminHead` 的 `actions` 传入，里面的 `onClick`（失效本页 key）与原来相同。
- `coverage-lattice.tsx`：多 `actions=JSX`（重新扫描按钮，`disabled={q.isFetching}` 与失效原样）和 `aside=JSX`（科目面板的计数芯片，不含处理函数）；少一行导航链接的 `onClick`（挪进 `AdminNav`，表达式相同）。
- `conjecture-scores.tsx`：少一行导航链接的 `onClick`（同上）。
- `admin-runs.tsx`、`observability-shared.tsx`、`observability.tsx`：**没有差异**。

没有新增任何 effect。

## 交互变化（键盘、焦点、由哪个元素触发）

- **页内导航**：仍是普通 `<a href>` + 点击时 `navigate`；新增当前页的 `aria-current="page"`；包在 `nav aria-label="管理后台"` 里。它从页头右侧挪到了页面最上方。
- **运行记录的选择**：仍是行内第一格的按钮，点一下才选；选中项新增 `aria-current="true"`（原来只有颜色）。
- **出错态**：运行 / 成本 / 失败的出错块新增 `role="alert"`，消息不变，仍没有重试按钮（刷新在页头）。覆盖 / 猜想从旧 `ErrorState`（带图标的次要按钮）换成 `RetryLine`（文字按钮「重试」，`role="alert"`），文案不变。
- **载入**：骨架换成 `SkeletonLines`（`role="status"` + 读屏名）。原来写在卡片里的可见文字「… 加载中...」「运行时间线加载中…」「覆盖细目扫描中...」变成骨架的读屏名，不再显示为文字。
- **结构**：面板从无语义的 `div` 变成 `section aria-labelledby`；表头加了 `scope="col"`；运行时间线从一串 `div` 变成 `ol` / `li`；成本两列从 `div` 变成 `ul` / `li`；覆盖页的缺口列表变成 `ul` / `li`；失败样本从无表头网格变成带表头的表格。
- **猜想页的数据质量区**：仍是同一个 `role="status" aria-live="polite" aria-atomic="true"` 的 `div`，空时仍挂着。原来那条 `biome-ignore` 已经不起作用（lint 报「无效抑制」），换成了一句普通说明。
- **运行详情的错误摘要**：`code` 上的 `aria-label="错误摘要"` 原样保留（lint 原本就对它有一条提示，main 上也有）。

## 文案调整

- 页内导航标签从英文短名换成侧栏 / 命令面板里同一页的名字（`src/kernel/ui-surfaces.ts`）：配置、运行记录、成本、失败记录、学科配置、供题覆盖、猜想评分。
- 失败样本表新增表头 run / task / model / started。
- 加载提示变成读屏名（见上）。
- 其余标题、小字、说明、数字块、空态、出错、诚实栏文案一字未改。页标题「Cost」「Failures」「Coverage Lattice」「Conjecture Scores」保留英文，要不要改成和侧栏一致的中文名，留到批次 B 和侧栏一起定。

## 审查与验收

- 本机检查：`pnpm typecheck`、`pnpm lint`、`pnpm build` 和完整本地闸门（对比 merge-base）。结果见提交汇报。
- 独立审查重点：运行记录的选中对账（刷新后选中项消失 → 显示「已离开当前列表」并选第一条；刷新失败不清选中）、刷新同时失效详情、复制错误摘要的三种状态、覆盖页重新扫描期间禁用且不自动轮询、猜想页 Brier 只用成对行、错误摘要截断与 id 截断仍在。
- 真实页面检查（由协调线负责，独立开发库）：五页的载入 / 空 / 出错 / 有数据；亮色 / 暗色；960px、760px、640px 断点；运行表与覆盖表的横向滚动；键盘焦点可见；触屏下导航与运行行的点击区。
