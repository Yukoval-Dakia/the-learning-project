# 最后一批旧界面：冷启动 / 命令面板 / 令牌页 / 提示阶梯换成 M3E，修伙伴角标报错

YUK-1473（删旧界面，逐页迁移的最后一片）、YUK-1693（外壳每页报「No queryFn was passed」）· 2026-11-03 · 交付阶段：第一天能用（删旧界面，逐页迁移）。这一片之后，`src/ui/primitives/` 只剩不画任何东西的 `useFocusTrap`，`src/ui/shell/` 整个目录删除，仓库里不再有 `LoomIcon` / `Btn` / `BrandMark` / 旧 `Button` / `Icon`。

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:18`（§1）：「M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。」；`:79`（§4 Shape / containment）：「取消玻璃高光作为全局视觉依据；不把所有题目、消息和列表都包成同一种大圆角卡」；`:81`（§4 Motion）：「`prefers-reduced-motion: reduce` 取消非必要飞行、弹跳、形变」「关闭动画不改变提交、取消、焦点或完成时机」；`:83`（§4 Keyboard / focus）：「`IconButton` 必有可访问名称。模态层复用现有 focus trap」「不抢输入法按键，不改快捷键合同」「错误/选中/保存均有非颜色说明」；`:98`（§5）：「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」；`:100`：「作用域、无全局污染、同源资源、无业务规则等承重限制保留。」
   - `docs/design/2026-10-07-ui-visual-direction.md`：`:133`「**N4 命令面板**：`⌘K` 打开，玻璃浮层。……方向键选择，回车执行，`Esc` 关闭。」；`:134`「**N5 快捷键**：……按钮内显示快捷键，触屏隐藏；只有图标的按钮必须有可访问名称。」；`:297`「**T1** 组件只引用语义 token」；`:313`「**T7** 层级使用命名 token：……命令面板 50 / 提示条 60。组件不写裸 z-index。」；`:323`「**M1 只在变化时动**」；`:366`「**A2 触控目标**：触屏上每个可点击目标的点击区 ≥ 44×44px」。
   - 协调裁定（2026-11-03）：只换呈现，YUK-1693 除外。数据调用、写入、query key、失效不动；`HintLadder` 的 `solveStart` / `solveHint` 调用、顺序和状态机不动；`TokenGate` 的令牌存取与校验流程不动；命令面板的搜索结果、跳转目标和键盘（⌘K、上下键、回车、Esc）完全一致。有状态的元素（提示阶梯的状态、面板输入框、令牌输入框）不挪位置、不改 `key`。不新增 `useEffect`，不加测试，不用 `Segmented`，不写新的嵌套三元。`src/ui/components/response/*`、`InteractiveArtifactRenderer`、`useFocusTrap` 的位置不在本片。
2. 组件类型：
   - 冷启动 `ColdStart`：page（`/today` 已有路由在「什么都还没学」时的整页拦截，由 `TodayPage` 渲染）。
   - 命令面板 `CommandPalette`：modal（已有的 ⌘K 对话框）。
   - 令牌页 `TokenGate`：page（外壳之外的整页门）。
   - 提示阶梯 `HintLadder`：other（已有抽屉「解题提示」里的内容）。
   - 重算核对组件 `RecomputeComponents`、事件证据页 / AI 观察 / 复盘中枢的图标：other（已有页面里的部件）。
   - 没有新路由、页面、弹窗或抽屉。
3. 文件：
   - 新建：`web/src/command-palette.css`、`web/src/token-gate.css`、`src/capabilities/practice/ui/hint-ladder.css`、本文件。
   - 挪位置：`src/ui/shell/CommandPalette.tsx` → `web/src/CommandPalette.tsx`（git 识别为改名）；`src/ui/shell/nav-config.ts` → `web/src/nav-config.ts`；`src/ui/shell/ShellMain.tsx` 并入 `web/src/RootShell.tsx`（同名本地组件，原样）。
   - 修改（只改呈现）：`src/capabilities/onboarding/ui/ColdStart.tsx`、`onboarding-m3e.css`（加冷启动一段）、`recompute/RecomputeComponents.tsx`、`recompute/recompute.css`（重写成 M3E）；`src/capabilities/practice/ui/HintLadder.tsx`、`PracticeFacePage.tsx`（只去掉 `practice-face.css` 导入）、`solo/practice-solo.css`（只删死规则）；`web/src/TokenGate.tsx`、`web/src/RootShell.tsx`（导入路径、`ShellMain` 并入、YUK-1693）、`web/src/globals.css`（只删规则与随之空掉的注释）；`src/capabilities/agency/ui/meta.ts`、`AgentNoteGroupRow.tsx`、`src/capabilities/observability/ui/event-detail-model.ts`、`EventDetailPage.tsx`、`src/capabilities/shell/ui/coach-hub-view.ts`、`CoachHub.tsx`（图标词表换成 lucide 组件，使用处去掉转换表）；`src/capabilities/shell/ui/inbox-api.ts`（只改一行指向已删 `LoomIcon` 的注释）。
   - 删除：`src/ui/primitives/LoomIcon.tsx`、`Icon.tsx`、`Button.tsx`、`Btn.tsx`、`BrandMark.tsx`；`src/ui/shell/`（整目录）；`src/capabilities/practice/ui/practice-face.css`；`src/capabilities/onboarding/ui/onboarding.css`。

## 各处换成了什么样

所有新样式都挂在 `[data-ui-next]` 之下，颜色读 Google M3 角色（`--un-md-sys-*`）；「对 / 已核对 / 交还」用 positive，「完整解 / 非独立完成 / 不同步」用 caution（两者没有 M3 角色，沿用前几片的做法），失败用 error-container。图标全部是 lucide，并对读屏隐藏。

- **冷启动（`/today`，什么都还没学时）**：根换成和 `/welcome` 一样的首次使用根 `UiNextRoot.un-ob[data-un-m3e="practice-foundation"] > main.un-ob-main.un-m3e-bridge`。居中一列：吉祥物（原来是 Loom 的织纹标志）、32px 标题、说明、M3 实心主按钮「开始设定 · 约 2 分钟 →」（56px 高）、一行灰字「当前还没有学习目标……」。下面三张浅底（surface-container-low、16px 圆角）提示卡，每张左上一个 40px 圆形图标（secondary-container），标题 + 说明；≤720px 变成单列 `minmax(0, 1fr)`、图标在左。去掉了旧的整块入场上浮动画（M1：打开页面不是「变化」，前几片也都去掉了整页入场）。
- **命令面板（⌘K）**：遮罩 + surface-container-high 的对话框（24px 圆角，≤600px 时贴边 8px、16px 圆角）。上面是搜索行（64px 高，22px 搜索图标，正文 16px 输入框），聚焦时底部分隔线变 primary 并加粗一像素（形状变化，不只换色），所以输入框本身不再画焦点框。结果是 M3 单行列表项（56px 高、16px 圆角、24px 图标位），选中行 = secondary-container 底，箭头只在选中行出现；分组标题 14px/500。底部一行键位提示。触屏（`pointer: coarse`）上隐藏 `esc` 键帽和键位提示（N5）。打开时遮罩淡入、面板上浮 8px，仅在没有要求减少动效时。
  - 层级：保留原来的 `z-index: 90`，没有改成 T7 的「命令面板 50」。原因：面板在外壳里，外壳不建层叠上下文，面板和挂在 `<body>` 下的证据放大层（70）、题图放大层（50）同层比较；改成 50 会让 ⌘K 在放大层打开时被压在下面，是行为变化。CSS 里注明了。
  - 结果列表故意不设 `position`：面板用选中行的 `offsetTop` 保持它在可视区内，这个值仍然相对对话框测量，和原来完全一样。
- **令牌页**：门在外壳之外渲染，所以 `<main>` 本身带 `data-ui-next` 与 `data-un-m3e="practice-foundation"`（加属性，不加元素）。整屏 surface 底，居中一列最宽 420px，距顶 15vh：标题「Loom」、说明、标签、M3 描边输入框（56px 高、12px 圆角，聚焦 3px primary 外框，禁用浅底，出错时边框变 on-error-container）、出错提示条（error-container）、全宽 M3 实心主按钮（ui-next `Button` + `un-m3e-control`）。「正在验证……」那一屏用同样的标题和说明样式。
- **提示阶梯（解题提示抽屉里）**：类名 `ladder-*` 改成 `un-hl-*`，样式在新的 `hint-ladder.css`。自主程度轨：六个 16px 圆点，连线 outline-variant → 已到达为 primary；当前一阶实心 primary + 4px secondary-container 光圈；完整解那一阶是方点（形状区别），当前时为 caution 实心 + caution-soft 光圈；刻度字 13px（原来 10px，低于设计系统 13px 下限）。阶卡 surface-container-low、16px 圆角、无阴影；完整解卡 caution-soft。三种按钮：「给我第一阶 / 再给一阶」M3 实心 primary；「直接看完整解」描边 + caution 字色；「我自己来」描边中性色，仍靠右。都是 40px 高胶囊，带 `un-hit`（触屏 44px），触屏下换行间距 12px。失败框 error-container，确认门 caution-soft，交还回执 positive-soft，「暂时给不出」中性 surface-container-high。阶卡出现时淡入一次、取下一阶时转圈；减少动效时两者都不动（原来转圈改为 3s 一圈，现在静止，旁边的文字「正在想下一阶提示…」照常显示）。
- **重算核对（`/profile` 画像、`/coach` 校准视图顶部徽章）**：`recompute.css` 原地重写成 M3E（原来整份读旧 token，`/profile`、`/coach` 已迁，这里是这两页最后的旧外观）。核对条与徽章的状态图标在 36px 圆底里，已核对 positive、不同步 caution；离线芯片、每个知识点的核对芯片、账本表、不同步明细、边界说明都换成角色色和 M3 形状。「查看核对明细」是 primary 文字按钮（40px），「重新核对」是 40px 圆形图标按钮（原 30px 方框），两者加 `un-hit`。开始核对时图标转一圈、明细展开时淡入、画像条扫光，都只在没有要求减少动效时。
- **事件证据页、AI 观察、复盘中枢**：图标词表（`event-detail-model.ts` 的执行者、`meta.ts` 的 AI 来源、`coach-hub-view.ts` 的三个视图）直接存 lucide 组件，使用处去掉了「旧图标名 → lucide」的转换表。每个值和原转换表一一对应，未知执行者 / 来源的兜底图标（闪电 / 星光）也一样，所以页面上看到的图标完全不变。

## YUK-1693：伙伴角标不再报「No queryFn was passed」

原因：`RootShell` 为了读伙伴建议的条数，挂了一个 `enabled: false`、没有 `queryFn` 的 `useQuery`（key 与学习伙伴里 `useCopilotNudges` 相同）。同一个 key 上最后一个设置选项的观察者没有 `queryFn`，伙伴的 60 秒轮询或失效重取就会打出这条报错。

做法（选了第二种）：`RootShell` 不再挂 query 观察者，改为用 `useSyncExternalStore` 订阅 `queryClient.getQueryCache()`，读这条缓存里 `nudges` 的条数（没有缓存时 0；服务端快照 0）。订阅回调包在 `notifyManager.batchCalls` 里，和 react-query 自己的 `useIsFetching` 写法一样，所以缓存事件不会在别的组件渲染中途同步触发更新。

- 不发请求、不另起轮询：轮询（60s）和点「×」「看看」后的失效仍只由学习伙伴里那个 query 负责。
- 角标行为不变：缓存里有几条就显示几，没有就不显示；令牌失效时 `queryClient.clear()` 清掉缓存，角标归零，和原来一样。
- 没有新增 `useEffect`，没有新增能力之间的导入（key 仍是 `RootShell` 里的同值常量），`pnpm audit:capability-boundaries` 见下方闸门。

## 删除与保留

- **旧原件**：删除 `LoomIcon.tsx`、`Icon.tsx`、`Button.tsx`、`Btn.tsx`、`BrandMark.tsx`。删前在全部 `.ts` / `.tsx` / `.css` / 脚本里查过（含相对路径导入），没有任何引用；`src/ui/primitives/` 没有 `index.ts`。**保留** `useFocusTrap.ts`（8 处使用：命令面板、外壳导航、伙伴面板、会话列表、知识点抽屉、题图放大、证据放大、解题提示抽屉），它不画任何东西。
- **`src/ui/shell/`**：整个目录删除。`nav-config.ts` 里没有使用者的 `MOBILE_NAV`、`titleFromPath`、`breadcrumbParamFromPath` 随之删掉（新外壳的导航与标题不用它们）；导航与搜索入口仍从 `UI_SURFACES` 投影，规则不变。新文件放在 `web/src/`，与它唯一的使用者 `RootShell` 同处：面板要按需读知识树（`knowledge/ui-public`），所以不能放进 `ui-next`（I1：不取数据）；放进某个 capability 又会多一条能力之间的导入。
- **`practice-face.css`**：只剩提示阶梯的 `ladder-*`，挪进 `hint-ladder.css` 后整份删除，`PracticeFacePage` 去掉导入。
- **`onboarding.css`**：只剩冷启动，挪进 `onboarding-m3e.css` 后整份删除。
- **`practice-solo.css` 里的死 `.un-ps` 作用域**：仓库里没有任何元素带完整的 `un-ps` 类（整词搜索全部 `.ts` / `.tsx`，含模板字符串，0 处；单题页的根是 `practice-studio`），挂在它下面的规则从不生效。删掉 12 条：`.un-ps` 本身（两条，含 `--un-ps-no` / `--un-ps-gutter` / `--un-ps-line` 变量定义和整段 `rs-*` 嵌套块）、两个媒体查询里的 `.un-ps`、M3 段里的 `.un-ps` 和 7 条 `.un-ps :is(.rs-textarea, .un-ps-textarea)…` / `.un-ps .rs-…`。1375 → 1062 行。用的是认得括号的脚本（选择器只在顶层逗号处切分，`:is(a, b)` 不会被切坏），嵌套块随父规则一起删；删后手工去掉了空出来的分区注释和空行。那三个变量原本就从未生效，别处的 `var(--un-ps-no)` 等照旧取不到值，外观不变。
- **`globals.css`**：1668 → 787 行。方法：对文件里每一个类做严格整词匹配（`tlp-status/_work/yuk1473/sweep/ui_class_use.py` 只算 UI 代码字符串里的完整词，`class_usage.py` 算全部 `.ts` / `.tsx`），对出现次数大于 0 的通用词（`page`、`meta`、`section`、`chip`……）逐条看上下文（`last/str_ctx.py`），确认全是数据值、query key、`aria-current="page"` 或注释，不是类名；再与改动前（`7640e9920`）对比哪些是本片变成 0 的。模板前缀：`btn-${…}` 只在已删的 `Btn.tsx` 里；`tone-${…}` 仍有人拼，但带 `tone-*` 的规则都挂在已死的 `.badge` 下。用 `last/drop_css_classes.py`（同上，认得括号）删规则，复合选择器列表只删死掉的那一项（`small, .caption` → `small`）。
  - 本片变成 0 使用的：`cmdk*`（命令面板）、`btn` / `btn-sm` / `btn-lg` / `btn-block` 与整组 `btn-*`（旧 `Btn`）、`page` / `page-title` / `serif` / `meta`（冷启动与令牌页）。
  - 改动前就已 0 使用、同在这些分区里的：`icon-btn*`、`wenyan`、`caption`、`seg`、`lane`、`section`、`slider`、`knowledge-tree`、`relation`、`loom-card`、`li`、`proposal`、`tnum`、`app`、`nav`、`badge`（含 `.badge.tone-*`、`.badge .dot`）、`chip` / `chip-k` / `button.chip`、`card-icon`、`bar`、`nowrap-meta`、`dot-sep`、`quiet-empty`、`wide`、`prose`、`dot`，以及随之失效的 `.pface-loom .page-title`、`.pface-loom .seg*`、两处 `.btn-primary` 暗色微调。
  - 同时删掉：随之空掉的媒体查询、`cmdk-fade` / `cmdk-rise` 两个关键帧、早已无人用的 `paper-gen` 关键帧，以及只剩注释的分区标题。两段提到 `.btn-primary` 的注释改写成不点名。
  - 保留（仍有使用者）：`.main`（`RootShell` 的内容列）、`.mono`（重算核对组件）、`.visually-hidden`、`.note-interactive-*`、`.pface-loom` 本身、所有元素选择器与 token，以及不是类规则的 `@mixin loom-dark-tokens` 占位块（不在本次清理范围）。
- **与 `src/ui-next/AGENTS.md` I4 的冲突**：I4（`src/ui-next/AGENTS.md:10-11`）说「never edit `src/ui/`, `web/src/globals.css`」。这一线有书面例外：owner 要求删除全部旧界面（2026-10-20），根 `AGENTS.md` 规定「S13 DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除」，m3e 方向文档 `:98` 要求「每片消费 M3E 后退出自己的旧样式」，协调线明确把这些旧原件、`src/ui/shell/` 与 `globals.css` 的死规则指定为本片。本片在 `src/ui/` 只做**删除**（五个旧原件和 `shell/` 目录）；在 `globals.css` 只**删除**无人使用的规则和随之空掉的注释、改写两段点名已删类的注释，没有新增或修改任何仍生效的全局规则；新样式全部在限定作用域的 css 文件里。`ui-next` 目录没有改动。

## 逻辑未变的证明

脚本入口 `tlp-status/_work/yuk1473/last/logic.sh`（由 `response/logic.sh` 改来）：原文件存在 `last/orig/`，脚本先逐字核对它与 `git show 7640e9920:<原路径>` 相同；挪了位置的文件按「原路径 → 新路径」配对（`ShellMain` 配 `RootShell`）。每个改过的 `.ts` / `.tsx`（16 对）跑三遍：`strip_logic.cjs`（去掉 import / 注释、把最外层 JSX 换成占位符后比对）、`jsx_handlers.cjs`（所有函数 / ref / `on*` 属性）、`admin-b/jsx_attrs.cjs`（表单 / 写入属性），再跑树位置检查 `last/jsx_tree.cjs`。结果在 `last/logic-diff.txt`、`attrs-diff.txt`、`tree-diff.txt`。

第一遍（JSX 之外）剩下的差异，以及为什么行为一样：
- `ColdStart`、`CommandPalette`、`nav-config`、`meta.ts`、`event-detail-model.ts`、`coach-hub-view.ts`：图标字段的类型从旧图标名换成 `LucideIcon`，值从图标名字符串换成对应的 lucide 组件。只用来画图标，没有任何判断读它。
- `nav-config`：图标表多一项 `notes`（原来落到兜底的箭头，现在是笔记图标）；删掉无人使用的 `MOBILE_NAV`、`titleFromPath`、`breadcrumbParamFromPath`。`NAV`、`SEARCH_PAGE_ITEMS`、`activeFromPath`、占位文字、排序与分组逐字不变，所以面板的结果集与顺序不变。
- `AgentNoteGroupRow`、`EventDetailPage`、`CoachHub`：删掉「图标名 → lucide」的转换表，直接用词表里的组件。原表对每个名字给出的组件与现在词表里的一一相同，兜底一样，渲染出的图标不变。
- `RecomputeComponents`：`RcVerify` 里原有的三层嵌套三元（结果从图标名换成 lucide 组件，判断与顺序不变）；`RcMaturityBadge` 里原来写在 `name=` 属性里的同一个三元挪到函数体里赋给 `StateIcon`，在同一次渲染里求值，判断与顺序不变。
- `RootShell`：YUK-1693 的改动（上节）；`ShellMain` 原样并入为本地组件（只少了 `export`），DOM 与属性不变。
- `HintLadder`、`TokenGate`、`PracticeFacePage`、`inbox-api`：**没有差异**。

第二遍（处理函数）：16 对**全部没有差异**。提示阶梯的 `advance` / `revealFull` / `returnToAnswer` 与每个按钮的 `onClick`、面板的 `onKey` / `changeQuery` / `pick` / `onMouseEnter` / `selectedRowRef` / `trapRef`、令牌页的 `submit` / `onChange`、外壳的 ⌘K / ⌘J 监听逐字不变。

第三遍（表单 / 写入属性）：少掉的 `name=…` 全是旧 `LoomIcon` 的图标名。`disabled`、`value`、`type`、`id`、`htmlFor`、`autoComplete`、`placeholder`、`aria-*`、`role`、`tabIndex`、`title` 全部不变。令牌页的提交按钮多一个 `variant="primary"`（旧 `Button` 默认就是 primary），它仍是 `type="submit"`。

### 树位置检查

`last/jsx_tree.cjs` 列出每个带 `key=` / `ref=` 的元素和每个有状态的元素（`input`、`textarea`、`MathMarkdown`、`OpenCommandPalette`、`TokenForm`、`HintStageCard`、`ShellMain`、`StudioNavigation`、`CompanionMount`、`CommandPalette` 等），给出从组件根到它的每一级：宿主元素、`key`、在父元素子节点里的序号，以及中间每一个条件。ui-next `Button` 按 `button` 记，`UiNextRoot` 按 `div` 记。

- `HintLadder`：**完全一致**（阶梯根、六个 `key=s.key` 刻度、`HintStageCard[key=s.key]`、所有 `MathMarkdown`、`returned` 分支都在原位）。
- `CommandPalette`：**完全一致**（`OpenCommandPalette` 仍只在 `open` 时挂载；对话框 `ref=trapRef`、输入框、`Fragment[key=group:route]`、`button[ref=selectedRowRef]` 位置不变）。
- `TokenGate`：**完全一致**（`TokenForm[key=epoch]`、`input#loom-internal-token` 位置不变）。
- `RootShell`：**完全一致**。
- `ColdStart`：根从 `div` 换成 `UiNextRoot > main`，提示卡的 `key=l.t` 从根 #1 挪到 `main` #1；多一个 `Mascot`。这一页没有任何状态（没有 hook，卡片里只有文字），所以位置变化不影响任何东西。
- `RecomputeComponents`：只多了两个图标元素 `StateIcon`，其余一致。

## 交互变化（键盘、焦点、由哪个元素触发）

- **命令面板**：搜索结果、顺序、跳转目标、⌘K 开关、上下键、回车、Esc（含阻止冒泡）、点遮罩关闭、焦点陷阱与关闭后焦点回到触发处都不变。输入框不再画自己的焦点框，改为搜索行底线变 primary 并加粗；用 Tab 移到结果行时仍是外壳统一的 3px primary 焦点框。触屏上隐藏 `esc` 键帽和键位提示。
- **冷启动**：多了一个 `main` 地标（原来整页没有）；「开始设定」从旧 `Btn` 换成 ui-next `Button`（仍是 `button type="button"`，同一个 `onClick`）；原来的 Loom 织纹标志带 `role="img" aria-label="Loom"`，现在的吉祥物对读屏隐藏，所以读屏少读一个「Loom」。
- **令牌页**：元素、属性、回车提交、禁用与出错关联都不变；按钮从旧 `Button` 换成 ui-next `Button`。
- **提示阶梯**：按钮、顺序、禁用（「完整解暂不可用」、「取完整解…」时的确认按钮）都不变；按钮在触屏上有 44px 点击区。`fullError` 那一行多了一个类名。
- **重算核对**：两个按钮变大（40px）并有触屏点击区。
- **伙伴角标**：行为不变，控制台不再出现「No queryFn was passed」。

## 文案调整

- 没有。所有标题、说明、按钮文字、占位文字、出错与加载文案一字未改（`tree-diff.txt` 的「learner-visible text」一节只有图标名换成 `aria-hidden`、新增作用域属性和 `variant`）。

## 没做的

- `practice-solo.css` 里 `.un-ps` 作用域之外的其他 `.un-ps-*` 规则是否还有使用者，没有在本片核对（本片只删确定不生效的 `.un-ps` 作用域）。
- `globals.css` 里的元素级旧规则（`h1`–`h6`、`p`、`a`、`code`、`pre`、焦点环、表单重置）和旧 token 仍在，它们仍作用于全站元素，不是「无人使用的类规则」，不在本片。
- `src/ui/components/response/*`（已迁成 M3E，但按路径仍在 `src/ui/components/`）与 `InteractiveArtifactRenderer` 不在本片；旧 UI 清单里剩下的 19 个模块就是它们和 `useFocusTrap`。

## 审查与验收

- 本机检查：完整本地闸门（对比 merge-base，含 typecheck / lint / build / 各 audit / lint ratchet）。结果见提交汇报。
- 独立审查重点：三遍比对与树检查；YUK-1693 的缓存订阅（不发请求、不多轮询、令牌失效后归零）；面板 `z-index` 与结果列表不设定位的理由；`globals.css` 删掉的每个类确实 0 使用。
- 真实页面检查（由协调线负责，独立开发库）：冷启动 `/today`、⌘K 面板、令牌页、提示阶梯、`/profile` 与 `/coach` 的核对组件、事件证据页与 AI 观察的图标、复盘中枢的视图标签；亮色 / 暗色；320、375、640、760、880、1240、1440px 无横向滚动；触屏下换行的按钮点击区不重叠；键盘焦点可见；减少动效时没有动画；控制台没有「No queryFn」。
