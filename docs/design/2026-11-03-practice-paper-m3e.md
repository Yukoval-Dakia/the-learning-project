# 练习页（/practice）整卷作答：M3E 呈现

YUK-1473（练习页最后一块旧样式：整卷作答页）· 2026-11-03 · 交付阶段：第一天能用（删旧界面，逐页迁移）。接续卷架 / 流 / 复盘那一片（`docs/design/2026-11-03-practice-face-m3e.md`）。

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:18`（§1）：「M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。」；`:79`（§4 Shape / containment）：「取消玻璃高光作为全局视觉依据；不把所有题目、消息和列表都包成同一种大圆角卡」；`:81`（§4 Motion）：「`prefers-reduced-motion: reduce` 取消非必要飞行、弹跳、形变」「关闭动画不改变提交、取消、焦点或完成时机」；`:98`（§5）：「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」；`:100`：「作用域、无全局污染、同源资源、无业务规则等承重限制保留。」
   - `docs/design/2026-10-27-m3e-practice-page.md:34`（原生文本作答）：「outlined text field 的 CornerExtraSmall 4、onSurface/outline/primary」「hover/focus/disabled 可区分」；`:35`（作答操作栏）：「surfaceContainerHigh 与 large 形状，实色背景替代玻璃」「原 DOM 顺序、sticky 位置、快捷键、提交禁用判据不变」；`:37`（取题失败、草稿冲突）：「失败 errorContainer/onErrorContainer；冲突 secondaryContainer/onSecondaryContainer 和双方对照区」「现有 alert/live、retry、自评、保留草稿/另一版本操作不变」；`:38`：「窄屏减少内边距并让长文本/状态换行」「取消本页旧整页入场，不新增 spring 参数」。
   - `docs/design/2026-10-30-practice-studio-requirements.md:10`（§3）：「附件、补充思路、引用与提示属于主任务之后的辅助工具，不允许出现在作答控件和主操作之间。」（本片没能做到，见「没做的」）；`:55`：「每片沿原真实consumer/数据契约，不新建演示入口」。
   - `docs/design/2026-10-07-ui-visual-direction.md`：`:297`「T1 组件只引用语义 token」；`:323`「M1 只在变化时动」；`:359`「M14 三态：每个区域都设计载入…、空（带进入动作）、出错（区域隔离、可重试、已保存的工作不受影响）」；`:366`「A2 触控目标：触屏上每个可点击目标的点击区 ≥ 44×44px」。
   - 卷模式自己的规矩（`PfPaper.tsx` 文件头，设计基准 `docs/design/loom-refresh/project/pface-paper.jsx` §6.4）：「作答全程零语义色（pip 只有「已答」的中性墨点），颜色在交卷瞬间才进场」。
   - 协调裁定（2026-11-03）：只换呈现。这是作答保存路径：任何数据调用、写入、query key、失效、hook 与 hook 调用顺序（`savePaperAnswer`、`startPaperSession`、`startTimingSegment`、`startCurrentSegment`、`submitPaperSlot`、`submitAll`、`endPaperSession`、`submitPayloadFor`、草稿自动保存、`usePagehideTransition`、计时、ref、`key`）一律不变；有状态组件的树位置不变、不包进新的条件父节点；禁用条件、键盘、输入焦点、退出与「进度保留」、pagehide flush、何时允许交卷都不变。不新增 `useEffect`，不加测试，不用 `Segmented` 做有副作用的事，不写嵌套三元。`src/ui/components/response/*` 不在本片（下一片）。
2. 组件类型：page（`/practice` 已有路由里的卷模式视图 `mode.kind === 'paper'`）。没有新路由、弹窗或抽屉。路由宿主 `server/start/routes/practice.tsx` 没有改。
3. 文件：
   - 新建：`src/capabilities/practice/ui/practice-paper-m3e.css`、本文件。
   - 修改（只改呈现）：`src/capabilities/practice/ui/PfPaper.tsx`、`PracticeFacePage.tsx`（卷模式页面根、导入新样式）、`practice-face-m3e.css`（出错行在单题页的内边距、文件头说明）、`practice-face.css`（只删规则、改文件头说明）、`web/src/globals.css`（只删没人用的规则、改两处提到已删类名的注释）。
   - 删除：无（`Btn`、`Card`、`LoomIcon` 仍有别的使用者，见下）。

## 卷模式页面上有什么

| 区域 | 迁移前 | 本片 |
| --- | --- | --- |
| 页面根 | 旧 `main.page.wide` | 与列表、复盘同一个 M3E 根 |
| 顶栏：退出 / 卷名 / 保存状态 | 旧 `Btn` + `span` + `SaveStateChip` | ui-next `Button` + `h1`；`SaveStateChip` 不动 |
| 反馈缓冲说明 | 旧 `LoomIcon` + 旧底色 | 换 |
| 刷新失败、不能整卷作答的提示 | `quiet-empty` | 换 |
| 题目导航（题号按钮） | `pfp-pip` | 换 |
| 题目区 | 旧 `Card` | 白色面板 |
| 题干 / 材料 | `pfs-stem` | 换 |
| 作答控件（选择、文本、附件、改绑、信心自评、题面块） | `src/ui/components/response/*`、`blocks/*` | **不动**（下一片），只换外面的容器 |
| 在别处交过的提示、草稿冲突面板 | 旧 `LoomIcon` / `Btn` | 换 |
| 「你这次写的（已放下）」 | 旧 `Btn` | 换 |
| 记下你的思路 | `pfs-trace*` + `.pface-root .composer` | 换 |
| 上一题 / 下一题 / 已答 / 交卷 / 确认 | 旧 `Btn` + `nowrap-meta` | 换 |
| 底部提示行 | `key-hints mono` | 换 |
| 取卷中 / 卷加载失败 | `quiet-empty` + 旧 `Btn` | 换 |

## 做了什么

- **页面根**：`pageClass` 现在只分两支——单题作答仍是 `pface-loom pface-next`，其余（列表、卷模式、复盘）都是 `un-root un-pq-page pface-loom`，并带 `data-ui-next` 与 `data-un-m3e="practice-foundation"`（`m3ePage = mode.kind !== 'solo'`）。只是同一个 `<main>` 换属性，没有新增或去掉元素，切换视图时不重挂任何东西。宽度、留白、页面底色、16px / 1.6 正文和 48px 胶囊按钮都沿用 `queue.css`。卷模式的根 `div` 带 `un-m3e-bridge`，ui-next 原件读到 M3 角色。
  - 为什么这对作答控件的样子没有影响：作答控件（`.rs-*`）只读旧 token（`--ink*`、`--paper*`、`--line*`），不读任何 `--un-*`；它们继承的字号、行高、字体、文字色，原来来自外壳 `.un-st`（16px / 1.6 / `--un-font-sans` / on-surface），现在来自 `.un-pq-page`，取值一样。所有 `[data-ui-next]` 的基础规则（标题/段落去边距、按钮去底色等）原来就经外壳生效。外壳给 `--un-focus` 的值是 M3 primary，新根会把它重置成默认值，但卷模式根上的 `un-m3e-bridge` 又把它设回 primary，所以焦点框颜色不变。题面块（`PresentationBlocks`）有自己的 `UiNextRoot`，前后都从自己的根重新取 token。`.un-pq-page .un-btn` 只作用于 ui-next 按钮，题面块和作答控件里没有 ui-next 按钮。
- **顶栏**：幽灵按钮「← 退出 · 进度保留」（三种文案和禁用条件不变）、卷名（现在是 `h1`，headline-small 24/32，窄屏 22）、保存状态 chip。会换行，触屏时行距 16px。
- **反馈缓冲说明**：一行浅底说明（surface-container-low、16px 圆角、14px 次要文字色），左侧钟表图标。文案不变，三种情形（可作答 / 历史卷只能查看 / 正在准备）照旧。
- **题目导航**：每题一个 40px 圆形按钮（`role="tab"`、`aria-selected` 不变）。没答：细描边 + 次要文字色；已答：文字变深，下面一个 4px 中性墨点；当前题：secondary-container 底。全程没有对错色（§6.4）。按钮带 `un-hit`（触屏 44px 点击区，墨点改用 `::before`，因为 `::after` 归 `un-hit`），行距 8px，触屏 12px，点击区不重叠。
- **题目区**：白色面板（surface-container-lowest、24px 圆角、28px 内边距，窄屏 20 / 16px 与 20px 圆角），单列网格（`minmax(0, 1fr)`），子项间距 12px。顶部是题号「**3**/10」（原来前面还有题目 ID 的前 12 位，那是内部代码，去掉了）。题干 18px / 1.8（窄屏 17px），与单题作答页一致。
- **在别处交过 / 草稿冲突**：secondary-container 面板（16px 圆角），左上警示三角图标；两份作答并排放在白底小卡里（自动换成一列，最窄 220px），下面一行说明和两个按钮「用服务器上的」（描边）/「保留我的」（实心）。附件上传中两个按钮禁用并说明，与原来一样。
- **你这次写的（已放下）**：浅底折叠块，摘要行 48px 高，右侧「+ / −」；展开后是原文、附件说明和「复制这段」。仍是原生 `details`。
- **记下你的思路**：收起时是一个 primary 色的文字按钮（40px 高，`un-hit`）；展开后是一个描边文本框（outline 色 1px、12px 圆角，聚焦时 2px primary）。圆角取 12px 而不是设计文档里的 4px，是为了和单题作答页现在的文本框（`studio.css` 的 `.un-st-field-label textarea`）一样。`maxLength`、占位文字、`aria-label` 不变。
- **交卷栏**：surface-container-high 底、16px 圆角的一条实色栏（不是玻璃，不吸底）。上一题 / 下一题是描边胶囊（页面根把按钮阴影去掉了，所以描边在本文件里补上），「已答 x / y」靠右，「交卷 · 统一判分」是本页唯一常驻的实心按钮。点了交卷还有题空着时，原地换成「还有 N 题空着——仍要交？」+ 实心「交卷」+ 幽灵「再看看」。窄屏：上一题 / 下一题各占半行，已答一行，交卷一整行。
  - **判分中**：按钮文字照旧变成「判分中…」；另外交卷栏顶边出现一条 3px 的进度线（栏上新加的 `data-busy={submitting || undefined}` 属性控制）。没有要求减少动效时，一段亮色在线上来回扫；要求减少动效时只是一条静止的浅色线。提交过程、禁用和结束时机完全不受它影响。
- **底部提示行**：14px 次要文字色，跟在交卷栏下面。原来的等宽字体去掉了。六种文案和判断顺序不变。
- **取卷中 / 卷加载失败**：用卷架同款的浅底状态面板（`pf-m3-state`）。取卷中多了 `role="status"`；加载失败上方是幽灵按钮「← 返回流」，下面是「卷加载失败或没有题。」。
- **页面出错行**（`RetryLine`，开始练习 / 完成练习等失败时）：
  - 卷模式：页面根现在带 `data-ui-next` 与 M3 角色，出错行和列表页一模一样。
  - 单题作答：先核对了原因。`/practice` 的外壳 `RootShell` 本身就是 `[data-ui-next][data-un-m3e="practice-studio"]`（`web/src/RootShell.tsx:185-188`），所以 `[data-ui-next] .pface-root .pf-m3-error .un-retry` 这条规则在单题页也命中，颜色、圆角、按钮都在。真正的问题是位置：单题页的 `<main class="pface-next">` 没有内边距（内边距在里面的 `.un-st-page` 上），出错条贴着内容区左右边缘、宽度也和题目不一样。这次只给这一行加了限定作用域的样式（`.pf-m3-error:where(.pface-next *)`）：和 `.un-st-page` 一样的 1040px 最大宽度、32 / 24 / 16px 左右内边距（≥1200 / <1200 / <600），上边距 24 / 20 / 18px。没有给单题页的 `<main>` 加 `data-ui-next`：那样会把外壳 `.un-st` 设好的 `--un-accent` 等别名重置回默认的珊瑚色，单题作答页的颜色会变。元素一个没加、一个没删。
- **动效**：只在变化时动。题号按钮、思路按钮、描边按钮的悬停底色读 `--un-t-feedback`（减少动效时 1ms）；交卷进度线只在 `prefers-reduced-motion: no-preference` 下扫动。没有入场动画，没有玻璃。
- **触控**：ui-next 按钮自带 `un-hit`；题号按钮、思路按钮加了 `un-hit`。会换行的行在 `pointer: coarse` 下拉开行距：顶栏、冲突面板按钮行、交卷栏、确认组 16px，题号 12px。
- **横向溢出**：页面、题目区、冲突面板都是单列 `minmax(0, 1fr)` 网格；卷名、冲突两侧、提示行都 `overflow-wrap: anywhere`；交卷栏里最长的不换行文字（「交卷 · 统一判分」「← 退出 · 进度保留」）在 320px 宽时也放得下（320 − 2×16 页边 − 2×16 栏内边距 = 256px）。

## 删除旧样式

- `practice-face.css`：603 → 373 行。删掉 `key-hints`、`pfs-stem`、`pfs-trace`、`pfs-trace-toggle`、`pfs-trace-composer`、全部 `pfp-*`（含 `.pfp-buffer .ico`、`.pfp-pip.answered / .current`、`.pfp-conflict-msg .ico`）和 `.pface-root .composer*`。方法同前几片：`tlp-status/_work/yuk1473/class_usage.py` 对文件里每个类名做整词匹配（只算完整的 `[A-Za-z0-9_-]` 词），在全部 `.ts` / `.tsx` 里确认 0 使用；`composer`、`ico`、`answered`、`current` 这类常见词逐个看了父类（都只挂在已死的 `pfp-*` / `.pface-root .composer` 下），并另外确认仓库里没有任何 `className` 带 `composer` 这个词。没有模板前缀能拼出这些类。结果在 `tlp-status/_work/yuk1473/practice-b/usage-pf.json`，删前原文件在 `practice-b/practice-face.before.css`。剩下的全是解题提示梯（`ladder-*`，HintLadder 在用），所以文件和它在 `PracticeFacePage` 的导入都保留。
- `web/src/globals.css`：删掉 `.section-label`、`.empty`（含 `.empty-ico / -title / -text`）、`.future-tag`、`.errorstate`（含 `-ic / -text / .compact`），共 83 行。整词检查：`section-label`、`empty-ico`、`empty-title`、`empty-text`、`future-tag`、`errorstate*` 在 `.ts` / `.tsx` 里 0 使用；`empty` 和 `compact` 作为普通单词到处都有，逐个看了所有把它们放进 `className` 的可能（字面量、模板、条件拼接、状态值转类名），没有任何元素带 `empty` 或 `compact` 类。两处说明「`.section-label` 已经存在」的旧注释同时改掉。删前原文件在 `practice-b/globals.before.css`。
- 旧组件：`Btn`（ColdStart 仍在用）、`Card`（`ProposalCard`、题库各视图仍在用）、`LoomIcon`（HintLadder、作答组件、外壳旧件等仍在用）都**保留**。`scripts/audit-learner-copy.ts` 不用改（没有删文件）。
- **与 `src/ui-next/AGENTS.md` I4 的冲突**：I4 说「不要编辑 `src/ui/`、`web/src/globals.css`」。这一线有书面例外：owner 要求删除全部旧界面（2026-10-20），根 `AGENTS.md` 的 S13 规定「DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除」，m3e 方向文档 `:98` 要求「每片消费 M3E 后退出自己的旧样式」，协调线也明确授权这次清理 `globals.css` 里的四组规则。这次在 `web/src/globals.css` 只**删除**了失去最后使用者的规则并改了两处因此失实的注释，没有新增或改写任何规则；`src/ui/` 没有动。新样式全部在限定作用域的 `practice-paper-m3e.css`（`[data-ui-next] .pface-root` 之下）和 `practice-face-m3e.css` 里。

## 逻辑未变的证明

脚本入口 `tlp-status/_work/yuk1473/practice-b/logic.sh`：原文件用 `git show origin/main:<file>` 存到 `practice-b/orig/`（脚本先核对逐字一致），然后对每个改过的 `.tsx` 跑三遍（`strip_logic.cjs` 去掉 import / 注释、把最外层 JSX 换成占位符后比对；`jsx_handlers.cjs` 比对所有函数 / ref / `on*` 属性；`admin-b/jsx_attrs.cjs` 比对表单 / 写入属性），再对 PfPaper 跑树位置检查（`practice-b/jsx_tree.cjs`）。结果在 `practice-b/logic-diff.txt`、`attrs-diff.txt`、`tree-diff.txt`。

第一遍（JSX 之外）剩下的差异：
- `PfPaper`：一处 `return JSX` 变成 `return (JSX)`（取卷中那行 JSX 换了行）。其余——草稿保存、冲突处理、交卷前核对、提交、计时、pagehide、退出、hook 的个数和顺序——逐字不变。
- `PracticeFacePage`：`pageClass` 少了一支（卷模式并入列表 / 复盘那支，判断顺序仍是「单题 → 其余」）；`m3ePage` 从「列表或复盘」变成「不是单题」。两者都只决定 `<main>` 的类名和两个 data 属性。

第二遍（JSX 里的处理函数）：两个文件都**没有差异**。

第三遍（表单 / 写入属性）：只少了三个 `name="alert" / "clock"`，那是旧 `LoomIcon` 的图标名，不是表单属性。`disabled`（退出、上一题、下一题、两个交卷、冲突两按钮、复制）、`aria-*`、`value`、`maxLength`、`placeholder`、`rows`、`type` 全部不变。

JSX 里的其他表达式（条件、map 回调体、值；`className` / `style` 除外）只有这些差异：图标的 `size`；题号前面去掉的 `cur.question_id.slice(0, 12)`；交卷栏新增的 `data-busy={submitting || undefined}`。

### 组件树位置检查（PfPaper）

`jsx_tree.cjs` 列出每个带 `key=` / `ref=` 的元素和每个有状态的子组件（`PaperVisit`、`PresentationBlocks`、`ResponseSlotField`、`EvidenceComposer`、`ChoiceSetResponse`、`SelfConfidenceField`、`EvaluationGroupPanel`、`PaperDraftConflict`、`DiscardedDraft`、`SaveStateChip`、`StimulusFigure`、`AssetEvidencePreview`、`MathMarkdown`、`AnswerText`、思路 `textarea`、`details`），给出从组件根到它的每一级：宿主元素、`key`、它在父元素子节点里的序号，以及中间每一个条件（`&&`、三元的哪一支、`map` 的来源）。旧原件按它渲染出的宿主元素记（`Card` → `div`，`Btn` / `Button` → `button`）。

结果：新旧两份**完全一致**（`tree-diff.txt` 第一段 "no difference"），共 25 个元素。例如：

- `PaperVisit[key=nativeOccurrenceId ?? '']` 仍是 `PfPaper` 的返回根。
- 根 `div[ref=attachVisit]`、顶栏 `div[ref=attachTop]`（根的第 0 个子节点）不变。
- 题号按钮 `button[key=slotKey(s)]`：根 #3 → `div` #0 → `map[slots]`。
- `PresentationBlocks[key=curKey]`：根 #4 → 题目区 #1 → `?[curPresentation && cur.assessment]:then`。
- `ResponseSlotField[key=slot.slot_id]`：根 #4 → 题目区 #5 → `?[cur.assessment]:then` → 片段 #0 → `map[…response_spec.slots]`；后面的 `EvidenceComposer` 是同一片段的 #1。
- 思路 `textarea`：根 #4 → 题目区 #8（同样的 `&&` 条件）→ `div` #0 → `?[traceOpen[curKey]]:then` → `div` #0。
- `SelfConfidenceField`：根 #4 → 题目区 #9（同样的 `&&` 条件）。
- `PaperDraftConflict`：根 #4 → 题目区 #3 → `&&[curConflict]`；`DiscardedDraft`：#6；`EvaluationGroupPanel`：#7。

不按宿主元素、按组件名直接比的话（`tree-diff.txt` 第三段），唯一的差别是题目区那一级从 `Card` 变成 `div`。`Card` 只是一个无状态、无条件、总是渲染一个 `div` 的包装：React 树里少了这一层，但这是代码里固定的结构，同一个版本运行时每次渲染都一样，不会在作答中途让任何东西重挂；它下面每个有状态子组件的父元素链、序号、`key` 和条件都没变。失败视图里的「返回流」按钮被放进了一个新的 `div.pf-pp-top`，它是无状态按钮，不在检查清单里。

没有新增任何 effect；没有用 `Segmented`；新代码里没有嵌套三元（退出按钮文案、保存状态、缓冲说明、底部提示行里原有的嵌套三元原样保留，只换了外面的元素）。

## 整卷作答页上的每一个写入

- **开卷**（`startPaperSession`，在根元素挂上页面时，每次作答只发一次）、**草稿自动保存**（`savePaperAnswer`，每题 800ms 防抖，附件变化同样调度）、**冲突时重读**（`getPaperDetail`）、**保留我的 / 用服务器上的**、**保存失败 · 重试**、**退出**（flush + 等待 + `pausePaperSession`）、**关页 / 刷新**（pagehide：keepalive 补发 + 暂停）、**站内跳走**（卸载 flush）、**交卷**（先核对服务器草稿，再逐题 `submitPaperSlot`，最后 `endPaperSession`）：调用、参数、顺序、ref 与时机都没动。本片只换了显示它们的按钮、面板和文字的外观。
- **跳转**：退出 → 列表（提示「进度已保留——卷在流里等你回来。」或「已退出——有 N 处草稿未保存」）；交卷成功 → 复盘。都不变。

## 交互变化（键盘、焦点、由哪个元素触发）

- 卷名从 `span` 变成 `h1`。
- 取卷中多了 `role="status"`。
- 题号按钮多了 `un-hit`（触屏点击区 44px）；思路按钮同样。
- 所有按钮从旧 `Btn`（小号）换成 ui-next `Button`（页面统一的 48px 胶囊）；元素仍是 `button type="button"`，处理函数、禁用条件和顺序一字不变。图标从旧 `LoomIcon` 换成 lucide，并对读屏隐藏。
- 「上一题」「下一题」从次要按钮变成描边按钮；「交卷」仍是实心。
- 交卷栏多了 `data-busy`（只用于画进度线）。
- 失败视图里「返回流」按钮外面多了一层 `div`。
- 没有改：Tab 顺序（DOM 顺序没变）、任何快捷键（本页没有）、输入框焦点、退出与「进度保留」的判断、pagehide、交卷何时可用。

## 文案调整

- 题号前面的题目 ID 前 12 位（内部代码）去掉了，只留「3/10」。
- 其余标题、说明、按钮、提示、出错文案一字未改，包括「反馈缓冲：这张卷不给即时对错——交卷后统一判分。和散题的节奏是反着的，刻意的。」。

## 没做的（需要动有状态组件的位置，按规则停下）

- 需求文档 `docs/design/2026-10-30-practice-studio-requirements.md:10` 要求附件、补充思路等辅助工具不夹在作答控件和主操作之间。卷模式里附件（`EvidenceComposer`）、改绑（`EvaluationGroupPanel`）、记下你的思路（`textarea`）、信心自评（`SelfConfidenceField`）都在作答控件之后、交卷栏之前。要挪它们，就得改这些有状态组件的父元素或序号，作答中的本地状态（附件上传、思路文字、自评）会有丢失风险，所以本片没挪。要做的话需要单独一片，先把这些状态的归属理清。
- 题号导航仍是 `role="tablist"` 但没有方向键切换（原来就没有）；没加，因为那是新交互。

## 审查与验收

- 本机检查：完整本地闸门（对比 merge-base，含 typecheck / lint / build / 各 audit / lint ratchet）。结果见提交汇报。
- 独立审查重点：保存路径的树位置与处理函数（上面三遍比对 + 树检查）；`<main>` 在卷模式换根后，作答控件和题面块的外观是否真的没变；出错行在四种视图下的位置；交卷进度线在减少动效时不动。
- 真实页面检查（由协调线负责，独立开发库）：作答 → 刷新 → 草稿仍在 → 交卷 → 复盘；作答中关掉标签页再打开；判分中刷新。亮色 / 暗色；320、375、640、760、880、1240、1440px 无横向滚动；触屏下换行的按钮点击区不重叠；键盘焦点可见。
