# 练习页（/practice）卷架、流、复盘：M3E 呈现

YUK-1473（练习页仍有一半是旧样式：卷架、交卷后的复盘、页面出错行与提示条）· 2026-11-03 · 交付阶段：第一天能用（删旧界面，逐页迁移）

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:18`（§1）：「M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。」；`:79`（§4 Shape / containment）：「取消玻璃高光作为全局视觉依据；不把所有题目、消息和列表都包成同一种大圆角卡」；`:81`（§4 Motion）：「`prefers-reduced-motion: reduce` 取消非必要飞行、弹跳、形变」；`:98`（§5）：「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」；`:100`：「作用域、无全局污染、同源资源、无业务规则等承重限制保留。」
   - `docs/design/2026-10-30-practice-studio-requirements.md:55`（§其它真实页面迁移顺序）：「随后顺序：练习列表/今日任务 → 题目库/详情 → …每片沿原真实consumer/数据契约，不新建演示入口」。
   - `docs/design/2026-10-27-m3e-practice-page.md:36`（判分、确认与参考）：「正确/部分/未知文字和原状态色保留，不用 error 代表答错」；`:37`（取题失败）：「失败 errorContainer/onErrorContainer」；`:38`：「取消本页旧整页入场，不新增 spring 参数」。
   - `docs/design/2026-10-07-ui-visual-direction.md`：`:244`「L5 历史与次要长列表默认折叠」；`:297`「T1 组件只引用语义 token」；`:323`「M1 只在变化时动」；`:359`「M14 三态：每个区域都设计载入…、空（带进入动作）、出错（区域隔离、可重试、已保存的工作不受影响）」；`:366`「A2 触控目标：触屏上每个可点击目标的点击区 ≥ 44×44px」。
   - 协调裁定（2026-11-03）：只换呈现。任何数据调用、写入、query key、失效、hook 调用顺序、会话与流逻辑（`advanceStreamItem` / `advanceLive` / `advanceInPlace` / `endAdvance`、`recomposeStream`、morph / 动效辅助、URL 与查询参数、所有跳转目标）一律不变。不新增 `useEffect`，不加测试，不用 `Segmented` 做有副作用的事，不写嵌套三元。`PfPaper.tsx`、`src/ui/components/response/*`、`HintLadder.tsx`、ColdStart、命令面板、TokenGate 不在本片。
2. 组件类型：page（`/practice` 已有路由的整页：列表模式里的卷架视图、交卷后 / 从卷架进入的复盘视图、页面级出错行与提示条）。没有新路由、弹窗或抽屉。路由宿主 `server/start/routes/practice.tsx` 没有改。
3. 文件：
   - 新建：`src/capabilities/practice/ui/practice-face-m3e.css`、本文件。
   - 修改（只改呈现）：`src/capabilities/practice/ui/PracticeFacePage.tsx`、`PfShelf.tsx`、`PfStream.tsx`、`PfRetro.tsx`、`solo/PracticeSolo.tsx`（只换 `CollapsibleList`）、`solo/practice-solo.css`（只提高折叠按钮对齐规则的优先级）、`practice-face.css`（只删规则、改文件头说明）、`scripts/audit-learner-copy.ts`（学习者文案清单去掉已删的文件）。
   - 删除：`src/ui/primitives/EmptyState.tsx`、`ErrorState.tsx`、`SectionLabel.tsx`、`CollapsibleList.tsx`、`collapsible-list.css`。

## 先查清楚练习页渲染了什么

| 视图 | 组件 | 迁移前 | 本片 |
| --- | --- | --- | --- |
| 列表页头（今日练习 / 练习卷切换） | `PracticeListHeader`（`src/ui-next/practice-studio/`） | 已是 M3E | 不动 |
| 今日练习（流） | `PfStream` → `PracticeQueue` | 已是 M3E；文件里还留着一个没人用的旧 `PfSrcBadge`（旧 `LoomIcon`） | 删掉 `PfSrcBadge` |
| 练习卷（卷架，`?view=shelf`） | `PfShelf` | 旧（`Btn`、`Card`、`EmptyState`、`SectionLabel`、`LoomIcon`） | 换 |
| 单题作答 | `PracticeSolo` → `PracticePresentation` | 已是 M3E，作答记录的折叠还用旧 `CollapsibleList` | 换成 `FoldList` |
| 卷模式作答 | `PfPaper` | 旧 | 不在本片（下一片，作答保存路径） |
| 复盘 | `PfRetro`（含 `PfrQRow`） | 旧（`Btn`、`EmptyState`、`ErrorState`、`LoomIcon`）；作答控件来自 `src/ui/components/response/*` | 换外壳；作答控件不动（下一片） |
| 页面出错行、提示条 | `PracticeFacePage` | 旧（`ErrorState`、`LoomIcon`） | 换 |

## 做了什么

- **页面根**：复盘视图改用列表视图同一个 M3E 根（`main[data-ui-next][data-un-m3e="practice-foundation"].un-root.un-pq-page`，宽度、留白、页面底色和 48px 胶囊按钮都沿用 `queue.css`）。单题作答仍是 `pface-loom pface-next`，卷模式仍是旧的 `page wide`（PfPaper 迁移前不动）。原来写在 `className` 里的嵌套三元改成 `pageClass(kind)`，判断顺序不变（作答 → 列表 / 复盘 → 其余）。卷架和复盘的内容容器带 `un-m3e-bridge`，ui-next 原件（按钮、芯片、重试行）读到的是 M3 角色。
- **页面出错行**（开始练习 / 完成练习 / 刷新失败等，`actionFailure`）：从旧 `ErrorState` 换成 ui-next `RetryLine`，外面一层 errorContainer 浅红条（16px 圆角，文字 onErrorContainer，“重试”是带下划线的文字按钮）。消息、重试函数、外层 `aria-live="assertive"`、`role="alert"` 都不变；作答页、卷模式、列表、复盘上都能显示。
- **提示条**（`addToast`）：图标从旧 `LoomIcon` 换成 lucide（`alert` → 圆形感叹号、`check` → 勾、`clock` → 钟、`layers` → 层叠，没给或认不出的名字 → 星光，与原默认 `sparkle` 一致）。外观是浮层：surface-container-highest 底、on-surface 文字、level 1 阴影、4px 圆角（Material snackbar 的 extra-small 形状）。项目 token 里还没有 inverse-surface 角色，所以没有用反色底；这是项目映射，不是完整的 Material snackbar。`info` 提示的图标是 secondary 色，其余 primary 色。出现时淡入上移一次（`--un-t-small`），只在没有要求减少动效时存在；位置仍由 `renderers.css` 的 `bottom: 88px` 决定，6 秒后消失的逻辑不变。
- **卷架**：
  - 来源筛选：“来源”标签 + 四个 ui-next `ChipToggle`（加 `un-m3e-control`，即 M3 filter chip：32px 高、8px 圆角、选中时 secondary-container 底并显示勾）。选中状态现在由 `aria-pressed` 读给读屏（原来没有）。点击仍是 `setSrc(k)`，只改本地筛选，没有副作用，所以用的是芯片而不是 `Segmented`。计数仍只在非“全部”且非 0 时显示。
  - 分区：“待做 / 在做 / 已完成 · 可复盘”仍是 `h2`，后面跟数量（原 `SectionLabel` 也是 h2 + 数量），外层是 `section`。
  - 卷卡：白色面板（surface-container-lowest、16px 圆角、细线、无阴影），网格 `auto-fill, minmax(min(100%, 400px), 1fr)`，宽屏两列、窄了一列（原来 920px 以下一列）。卡头：40px 圆形来源图标（AI 打包 = secondary-container 层叠图标，导入 = 下载图标 primary 色，点播 = 发送图标中性）、卷名（`h3`）、“来源 · 日期”、右侧“N 题”。知识点是静态 `Chip`（最多 4 个，同原来）。在做的卷：6px 进度条（primary）+“已答 x/y · 草稿已存”。已完成的卷：分布条 + “N 对 · N 待巩固” + 右侧正确率。卡底一条细线分隔：状态字 + 一个按钮。排卷中：禁用的“等待生成”（钟图标）；已完成：描边按钮“复盘 · 逐题与去向 →”；在做：实心主按钮“继续”（回转图标）；待做：描边按钮“开始”（闪电图标）。原来“开始”也是实心；改成描边是因为一页里只该有少数几个实心按钮，与流里只有“接着做”那一行是实心的做法一致。排卷中的卡标题是 on-surface-variant 色。
  - 读取中 / 出错 / 空：浅底状态面板（surface-container-low、20px 圆角）。读取中是“取卷架…”（`role="status"`），出错是“卷架加载失败：…”（`role="alert"`），空是 `h2`“这个来源下还没有卷”+ 说明。
- **复盘**：
  - 顶部：幽灵按钮“← 返回卷架”+ 卷名“{卷名} · 复盘”（现在是 `h1`，headline-small 24/32）。
  - 分数区：浅底面板（surface-container-low、24px 圆角）：56px 的“对的题数 / 总数”、“对 · 已交卷”；右侧 10px 分布条和说明“N 对 · N 部分 · N 错/未答”。窄屏（≤640px）上下排列，分数 44px。
  - 整卷小结：secondary-container 色的整块面板，左侧 36px 圆形星光图标，正文 16px、行高 1.7，下面一行小字“交卷统一判分”。
  - 逐题：白色面板里的分隔线列表。每题一行按钮（`aria-expanded`，至少 56px 高）：两位题号、题干单行省略、状态徽标（`SlotResultBadge` 不动；未作答是静态 `Chip`“未作答”）、一个向下箭头（收起时转 -90°，只在没有要求减少动效时有转动过渡）。展开后是“标签 + 内容”的两列：你的作答（选择题仍是只读的 `ChoiceSetResponse`）、作答附件、AI 反馈、参考，以及不能重判的说明。展开仍是条件渲染（没有换成 `Expand`：`Expand` 会提前挂载内容，提前去读题目配图）。窄屏时标签和内容上下排列。
  - 底部：描边按钮“← 返回卷架”。
  - 读取中“取卷中…”（`role="status"`）；出错是返回按钮 + 浅红出错条“复盘加载失败。· 重试”；空（含 404）是状态面板“还没有复盘”+ 说明 + 返回按钮。三态的判定（`isLoadingError && !isNotFound`、`!detail`）不变。
- **分布条的颜色**：对 = `--un-positive`，部分 = `--un-caution` 的 50%，错 / 未答 = `--un-caution`。按设计文档，答错不用 error 色；三档颜色都有对应文字，颜色不是唯一信号。
- **作答记录折叠**（单题页）：`CollapsibleList` 换成 ui-next 的 `FoldList`。两者接口与行为一模一样（最新 3 条，其余收进“全部 N 条”/“收起”，`aria-expanded` / `aria-controls`，折叠的项不渲染）；箭头从旧图标换成 lucide。为了让按钮在任何样式加载顺序下都对齐时间线文字，`practice-solo.css` 的对齐规则多带一个类（`button.un-fold-toggle.un-ps-history-toggle`），取值不变。
- **嵌套三元**：页面根的类名改用 `pageClass`；卷卡底部的三段（排卷中 → 已完成 → 待做 / 在做）改用 `paperFoot`，顺序不变；来源图标与色调的嵌套三元改成查表 `SRC_LOOK`（三个来源一一对应）。复盘里原有的两处嵌套三元（作答内容、徽标）只换了末端元素，结构和顺序没动。新代码没有嵌套三元。
- **动效**：只在变化时动。按钮、芯片、逐题行的悬停底色读 `--un-t-feedback`（减少动效时为 1ms）；逐题箭头转动和提示条入场只在 `prefers-reduced-motion: no-preference` 下存在。没有入场动画、没有玻璃。
- **触控**：ui-next 按钮、芯片、重试按钮自带 `un-hit`；`un-m3e-control` 的芯片在布局里预留 48px 点击区。会换行的行在 `pointer: coarse` 下行距 16px：来源筛选行、卷卡底部、复盘顶部、出错条。页面根的规则把所有 ui-next 按钮设成 48px 高的胶囊（`queue.css`），卷架和复盘上的按钮因此和流里的按钮一样大（原 `size="sm"` 去掉了，避免 48px 高配窄边距）。

## 删除旧样式与旧组件

- `practice-face.css`：1541 → 603 行。方法同前几片：对文件里每个类名做严格整词匹配（只算完整的 `[A-Za-z0-9_-]` 词），在全部 `.ts` / `.tsx` 里确认 0 使用，再逐个看复合选择器（像 `current`、`full`、`good`、`bar`、`ico` 这类常见词，只看它前面的父类是否还活着）。模板前缀逐个看过：仓库里拼 `tone-${…}` / `src-${…}` 的地方都在别处，本文件里带这些类的规则都挂在已死的父类下。文件里没有 CSS 嵌套（唯一的 `&` 在注释里），按核对过的行号整段保留，没有用按模式删行的脚本。脚本：`tlp-status/_work/yuk1473/class_usage.py`；结果在 `tlp-status/_work/yuk1473/practice-a/usage-pf*.json`，删前原文件在 `practice-a/practice-face.before.css`。
  - 删掉的（迁移后或更早就没人用）：旧流的全部 `pf-open*`、`pf-prog*`、`pf-notice`、`pf-thread`、`pf-row`、`pf-node`、`pf-item*`、`pf-reason`、`pf-skip`、`pf-paper-facts`、`pf-paper-note`、旧 `pf-paper-title`、`pf-done*`、`pf-skipped-label`、`is-new`、`pf-ondemand*`、`pf-gen*`、`pf-close*`、`kind-paper` 叠纸、`.pface`、`pface-head-row`；旧单题外壳 `pfs`、`pfs-top`；`pfp-saved`（含 `is-failed`）；复盘的全部 `pfr*`、`cmp-label`；卷架的 `pfh-filter`、`filter-row-l` 和 `.pface-root` 下全部 `paper-*`、`dist-*`、`g-right` / `g-wrong`、`dot-sep`、`tone-coral` / `tone-info` / `tone-good`；旧提示条 `pf-toasts` / `pf-toast` / `t-info`（不删的话会和新提示条叠在一起）；720px 断点块；关键帧 `pf-rise`、`pf-glow`、`pf-node-pulse`、`pf-toast-in`。`pf-gen` 规则里引用的 `paper-gen` 关键帧定义在 `web/src/globals.css`，本片没动。
  - 保留的（仍有使用者）：`key-hints`、`pfs-stem`、`pfs-trace*`、`pfp-*`（除 `pfp-saved`）、`.pface-root .composer*`（PfPaper）；整段 `ladder-*`（HintLadder）。减少动效的总登记处重写到文件末尾，只剩 `.ladder-card`（关掉）和 `.ladder-spin`（减速到 3s）两条。`practice-face.css` 仍由 `PracticeFacePage` 导入，因为 PfPaper 和 HintLadder 还要用。
- 删掉的旧组件：`EmptyState`（最后的使用者是卷架、复盘）、`ErrorState`（复盘、页面出错行）、`SectionLabel`（卷架）、`CollapsibleList` 和它的 `collapsible-list.css`（单题作答记录）。`src/ui/primitives/` 没有 `index.ts`，不用改导出；`scripts/audit-learner-copy.ts` 里去掉了 `CollapsibleList.tsx` 一行。
- 因为还有别处在用而**保留**的：`Btn`（PfPaper、ColdStart）、`Card`（PfPaper、`ProposalCard`、题库的几个视图）、`LoomIcon`（PfPaper、HintLadder、作答组件、外壳旧件、onboarding 等）。
- **没删、留给后续**：`web/src/globals.css` 里 `.errorstate*`、`.empty*`、`.future-tag`、`.section-label` 等规则，组件删掉以后已经没有元素会带这些类，但本片只授权清理 `practice-face.css`。
- **与 `src/ui-next/AGENTS.md` I4 的冲突**：I4 说“不要编辑 `src/ui/`、`web/src/globals.css`”。这一线有书面例外：owner 要求删除全部旧界面（2026-10-20），根 `AGENTS.md` 的 S13 规定“DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除”，m3e 方向文档 `:98` 也要求“每片消费 M3E 后退出自己的旧样式”。这次在 `src/ui/` 只**删除**了失去最后使用者的四个旧组件和一个样式文件，没有新增或修改任何文件；`web/src/globals.css` 没有动。新样式全部在限定作用域的 `practice-face-m3e.css` 里（`[data-ui-next] .pface-root` 与 `[data-ui-next].un-st-portal` 之下）。

## 逻辑未变的证明

方法同前几片：原文件用 `git show origin/main:<file>` 存到仓库外（`tlp-status/_work/yuk1473/practice-a/orig/`，脚本会先核对它们与 origin/main 逐字一致）。第一遍用 TypeScript 编译器去掉 import 和注释，把每个最外层 JSX 换成占位符 `JSX` 再逐行比对；第二遍把所有 JSX 属性里的函数 / ref / `on*` 表达式提出来，排序后比对；第三遍比对表单 / 写入相关属性（`disabled`、`value`、`type`、`id`、`title`、`name`、`aria-*`（除 `aria-hidden`）等）。脚本：`tlp-status/_work/yuk1473/strip_logic.cjs`、`jsx_handlers.cjs`、`admin-b/jsx_attrs.cjs`，入口 `practice-a/logic.sh`，结果在 `practice-a/logic-diff.txt` 与 `practice-a/attrs-diff.txt`。

第一遍（JSX 之外）剩下的差异：
- `PracticeFacePage`：新增 `TOAST_ICON`（图标名 → lucide，用 `Map`，原型上的键查不到）和渲染用的 `ToastIcon`；新增 `pageClass`（原嵌套三元，复盘归到列表那一支）；`return` 前新增 `const m3ePage`（列表或复盘时给根加 M3E 标记）。查询、`streamForRequestedScope`、`?item=` 跟随、`commitStreamItem`、`openItem`、`continueAfterSolo`、`advanceInPlace` / `continueInPlace` / `swapInPlace` / `advanceLive` / `endAdvance` / `cancelAdvance`、`exitToList`、`prefetchNext`、`markSoloDoneAndExit`、`landView` / `attachHost`、`addToast` 的 6 秒计时，逐字不变；hook 的个数和顺序不变。
- `PfShelf`：新增查表 `SRC_LOOK` 和 `paperFoot`（原卡底的嵌套三元，顺序不变；里面的 `const sess = p.session` 与卡片里的同名变量取值相同）；卡片里新增 `look`、`SrcIcon`、`state`（`data-state`，先判排卷中、再判已完成）；两处 `return JSX` 变成 `return (JSX)`（只是读取中 / 出错的 JSX 换了行）。`useQuery(['papers'])`、`useState` 的筛选、`shelfSource`、分区、计数、`fil` 逐字不变。
- `PfStream`：删掉了没人用的 `PfSrcBadge`（仓库里没有任何导入，只在旧设计文档里被提到）。`SRC_META` 的 `tone` / `icon` 字段因此没人读了，但为了不动数据，原样保留。`recomposeStream`、`skip` / `unskip`、`handoffDemand`、队列行逐字不变。
- `PfRetro`：一处 `return JSX` 变成 `return (JSX)`（读取中的 JSX 换了行）。`useQuery(['paper', artifactId, 'retro'])`、404 判定、判定统计、小结文案选择逐字不变。
- `PracticeSolo`：**没有差异**。

第二遍（JSX 里的处理函数）：只有一处差异——卷架来源筛选从 `onClick={() => setSrc(k)}` 变成 `ChipToggle` 的 `onPressedChange={() => setSrc(k)}`。`ChipToggle` 在原生按钮的 `onClick` 里调用它，参数被忽略，所以点击仍然只执行 `setSrc(k)`（点已选中的芯片也一样，不会取消选中）。其余处理函数（`openPaper` / `openRetro`、`onBack`、`refetch`、`setOpen`、`setZoomAsset`、`onRetry`、流与作答页的全部回调）一字未变，只是卷卡底部的两个挪进了 `paperFoot`。

第三遍（表单 / 写入属性）剩下的差异：
- 各文件少掉的 `name=…` 都是旧 `LoomIcon` 的图标名，不是表单属性（提示条的 `name` 现在传给 `ToastIcon`）。
- `PfShelf` / `PfRetro` 少掉的 `title=…` 是旧 `EmptyState` 的标题属性，现在是可见的 `h2`，文字不变。
- `PfShelf` 少一个 `type="button"`：筛选芯片从原生按钮换成 `ChipToggle`，它自己写了 `type="button"`。
- `disabled`（等待生成）、`aria-expanded`（逐题行）、`aria-label`（选项组）、`aria-live` **全部不变**。

没有新增任何 effect；没有用 `Segmented`；新代码里没有嵌套三元。

## 练习页上的每一个写入

- **开始练习 / 开始下一题 / 完成练习 / 跳过 / 恢复**（`advanceStreamItem` 的 PATCH，经 `commitStreamItem`）：调用、回执写缓存、失败记录与重试函数都不变；本片只换了失败时显示它的那一行。
- **按当前信号重排**（`recomposeStream`）：没动。
- **卷模式开卷 / 作答保存 / 交卷**：在 PfPaper 里，本片没动。卷架“开始 / 继续”仍只调用 `openPaper(artifactId)`。
- **跳转**：卷架“开始 / 继续”→ 卷模式，“复盘”→ 复盘，复盘“返回卷架”→ 列表并 `switchView('shelf')`（写 `?view=shelf`），都不变。

## 交互变化（键盘、焦点、由哪个元素触发）

- 卷架来源芯片多了 `aria-pressed`；读取中 / 出错面板多了 `role="status"` / `role="alert"`。
- 复盘卷名从 `span` 变成 `h1`；卷卡标题从 `div` 变成 `h3`，卡片外层从 `div` 变成 `article`，分区外层变成 `section`。
- 出错从旧 `ErrorState`（带图标的次要按钮“重试”）换成 `RetryLine`（文字按钮“重试”），都是 `role="alert"`。
- 复盘读取中改为 `role="status"`。
- 卷架“开始”从实心按钮变成描边按钮（“继续”仍是实心）；卷架和复盘的按钮从小号变成页面统一的 48px 胶囊。
- 逐题行的箭头从“收起 → 右箭头 / 展开 → 下箭头”两个图标换成同一个下箭头转 -90°，并对读屏隐藏。
- 作答记录的“全部 N 条”按钮：元素、属性、行为不变，只是箭头换成 lucide。

## 文案调整

- 复盘小结下面的小字从“paper.judge · 交卷统一判分”改为“交卷统一判分”（`paper.judge` 是内部代码）。
- 其余标题、说明、按钮、空态、出错文案一字未改。
- 没改、但可能需要处理：卷架在做卷的“draft · 可恢复”是英文词；复盘“对 · …”在会话没有完成时直接显示会话状态原值（如 `paused`）。后者是数据显示逻辑，本片不改。

## 审查与验收

- 本机检查：完整本地闸门（对比 merge-base，含 typecheck / lint / build / 各 audit / lint ratchet）。结果见提交汇报。
- 独立审查重点：页面根在复盘时的 M3E 标记不影响作答页与卷模式；出错行在四种视图下都显示且重试有效；卷架筛选、分区、计数与三种卡底；复盘三态与逐题展开；提示条图标映射与 6 秒消失；作答记录折叠与对齐。
- 真实页面检查（由协调线负责，独立开发库）：卷架和复盘的读取 / 空 / 出错 / 有数据；亮色 / 暗色；1440px、1024px、768px、390px、320px 无横向滚动；触屏下换行的按钮点击区不重叠；键盘焦点可见；减少动效时没有转动和入场动画。

## 2026-11-07 更新：做题结果页（YUK-1920，Refs YUK-1475）

Owner 2026-11-06：分割线符合 Material 3e 吗，作答记录超级丑，padding 和对齐全部打磨一遍。

- **阅读顺序：** 判定 → 依据和参考答案 → 「觉得判得不对？」 → 下一题，都在同一张卡里。只有看完依据才判断得了判得对不对，所以申诉排在后面，降为一行文字链接。
- **分割线：** 只留一种，M3 的 outline-variant，1px 实线，只用在可展开的行上；其他地方靠间距分开。虚线去掉，M3 没有这种样式。
- **作答记录：** 去掉时间线（竖线和圆点）。默认收起成一行「之前做过 N 次 · 上次做对了」，同一个错因出现过两次以上时写「这个错出现过 N 次：概念理解」；点开是最新 3 条的日期、对错和错因，其余收进「全部 N 条」。不写用时。只列这次之前的作答。
- **判定：** 带颜色和图标的圆形标记，文字同色。
- **状态行：** 判定已经说明答案交上去了，所以此时不再写「作答已保存」；保存失败和进行中的提示不变。
- **内部词：** 「点播」「导入」不再显示；提示阶梯不再写 H0–H5、「第 H2 阶」，改说「第 3 个提示」，几档改叫怎么下手、卡点、示范一步。
- **配对题：** 选项自带的序号和位置序号相同时只显示一次（`① Cl⁻` 在第 1 行显示为 `Cl⁻`，`A．稀盐酸` 同理）；不同时保留，不改内容。
