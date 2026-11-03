# 共用作答控件（src/ui/components/response）：M3E 呈现

YUK-1473（作答控件是练习页最后一块旧样式，整卷、复盘、定级、对话内确认题、今日探针都在用）· 2026-11-03 · 交付阶段：第一天能用（删旧界面，逐页迁移）。接续整卷作答页那一片（`docs/design/2026-11-03-practice-paper-m3e.md`），那一片把这些控件明确留给本片。

## 设计 preflight

1. 设计依据（逐字）：
   - `docs/design/2026-10-27-m3e-direction-and-migration.md:18`（§1）：「M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。」；`:79`（§4 Shape / containment）：「取消玻璃高光作为全局视觉依据；不把所有题目、消息和列表都包成同一种大圆角卡」；`:81`（§4 Motion）：「`prefers-reduced-motion: reduce` 取消非必要飞行、弹跳、形变」「关闭动画不改变提交、取消、焦点或完成时机」；`:83`（§4 Keyboard / focus）：「`IconButton` 必有可访问名称。模态层复用现有 focus trap」「错误/选中/保存均有非颜色说明」；`:98`（§5）：「未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。」；`:100`：「作用域、无全局污染、同源资源、无业务规则等承重限制保留。」
   - `docs/design/2026-10-27-m3e-practice-page.md:34`（原生文本作答）：「outlined text field 的 CornerExtraSmall 4、onSurface/outline/primary」「hover/focus/disabled 可区分」；`:36`（判分、确认与参考）：「正确/部分/未知文字和原状态色保留，不用 error 代表答错」；`:37`（草稿冲突）：「冲突 secondaryContainer/onSecondaryContainer」。
   - `docs/design/2026-10-30-practice-studio-requirements.md:12`：「选项只展示一个标签」「不剥合法数字、数学文本、选项ID或提交值」（本片不动 `display-option-content.ts`）；`:55`：「每片沿原真实consumer/数据契约，不新建演示入口」。
   - `docs/design/2026-10-07-ui-visual-direction.md`：`:297`「T1 组件只引用语义 token」；`:323`「M1 只在变化时动」；`:366`「A2 触控目标：触屏上每个可点击目标的点击区 ≥ 44×44px」。
   - 单题作答页（solo）在 `src/ui-next/practice-studio/renderers.css` 里已经把这些控件改成了 M3E（`.un-st-page` 下的 `rs-*` 规则）；协调线指定它作为作答控件 M3E 外观的参照，且单题页的样子不能变。
   - 协调裁定（2026-11-03）：只换呈现。`value` / `onChange` / `onSelect` / `onReorder` / `onMatch` 与发出的数据（作答条目、选项 id、排序、配对）、禁用 / 只读规则、键盘（单选方向键、排序键、回车）、焦点管理、id 与 `aria-*` 关联、上传与证据逻辑（`EvidenceComposer` 上传、`onEvidenceChange`、改绑）、放大查看的开关状态、`SaveStateChip` 的保存状态含义、`response-types.ts` 与 `display-option-content.ts` 一律不动。有状态的元素不挪位置、不包进新的条件父节点、不改 `key`。不新增 `useEffect`，不加测试，不用 `Segmented`，不写新的嵌套三元。
2. 组件类型：other（多个页面共用的作答控件）+ 一个已有 modal（证据放大查看 `EvidenceLightbox`）。没有新路由、页面、弹窗或抽屉。
3. 文件：
   - 新建：本文件。
   - 修改（只改呈现）：`src/ui/components/response/` 下的 `AssetEvidencePreview.tsx`、`AttachmentStrip.tsx`、`ChoiceSetResponse.tsx`、`EvaluationGroupPanel.tsx`、`EvidenceComposer.tsx`、`EvidenceLightbox.tsx`、`OrderingResponse.tsx`、`SaveStateChip.tsx`、`SelfConfidenceField.tsx`（只加 `un-hit`、改文件头说明）、`SlotResultBadge.tsx`、`response.css`；`src/ui-next/practice-studio/renderers.css`（只删规则、加一段说明）。
   - 没改：`MatchingResponse.tsx`、`ResponseSlotField.tsx`、`StimulusFigure.tsx`、`TextResponse.tsx`（外观全在 `response.css`）、`response-types.ts`、`display-option-content.ts`，以及所有使用这些控件的页面。
   - 删除：`src/ui/primitives/IconBtn.tsx`、`src/ui/primitives/Card.tsx`（都已 0 导入，见下）。

## 这些控件出现在哪里

| 页面 | 使用的控件 | 所在的 M3 根 |
| --- | --- | --- |
| 整卷作答 `PfPaper` | 选择、文本 / 数值 / 公式、配对、排序（经 `ResponseSlotField`）、附件（`EvidenceComposer`）、证据归属（`EvaluationGroupPanel`）、信心自评、保存状态、题目配图（`StimulusFigure` + 放大查看） | `main[data-un-m3e="practice-foundation"]` |
| 复盘 `PfRetro` | 只读选择（判分后）、作答附件条、状态徽标、放大查看 | 同上 |
| 单题作答 `PracticePresentation` / 题面块 `blocks/*` | 选择、文本、配对、排序、附件、题目材料图、题面块里的配图与自由作答 | 外壳 `RootShell` 的 `[data-un-m3e="practice-studio"]` |
| 定级 `ScreenPlacement` | 题面图、保存状态、作答槽、附件 | `UiNextRoot[data-un-m3e="practice-foundation"]` |
| 对话内确认题 `ConfirmationAssessment` | 题目配图、作答槽 | 学习伙伴面板 `[data-un-m3e="companion-content"]` |
| 今日探针 `ProbeAnswers` | 附件（只收图片） | 今日页 `main[data-un-m3e="practice-foundation"]` |
| 题目库 `QuestionFigures`、单题放大 `FigureLightbox` | 只用 `AssetEvidencePreview` 的内联图 | 外壳的 M3 根 |

整个应用外壳本身就是 M3 根，所以每个使用者都读得到 `--un-md-sys-*` 角色（嵌套的 `UiNextRoot` 不重设它们，变量会继承下来）。唯一的例外是放大查看：它用 portal 挂到 `<body>`，在任何页面作用域之外，所以遮罩自己带 `data-ui-next` 与 `data-un-m3e="practice-foundation"`，对话框带 `un-m3e-bridge`（这样 ui-next 的关闭按钮读到 M3 角色，焦点框是 primary 色）。只加了属性，没有加元素。

## 做了什么

样式全部写在 `response.css`，挂在 `[data-ui-next]` 之下（比原来的裸 `.rs-*` 多一层作用域，能稳定胜过 `[data-ui-next] :where(button)` 这类基础重置，不再依赖样式表加载顺序）。原则：**单题作答页现在的样子就是目标**——尺寸、间距、行高保留它现在的像素值；颜色、圆角、字体族换成 M3 角色和形状。

- **选择题**：每个选项一行（最小 64px 高、14 / 18px 内边距、12px 圆角、outline 色 1px 边、surface-container-lowest 底），字母 15px / 600 次要文字色，正文 17px / 1.7。选中：secondary-container 底 + primary 色边 + 1px 内圈（形状上多一圈，不只是换色）。多选的勾选框换成 M3 复选框（18px、2px 边、选中 primary 填充 + 白勾）。判分后：对 = positive 色实边 + 内圈，字母变成实心圆；错 = caution 色**虚线**边，字母变成空心圈。按设计文档，答错不用 error 色。「清除选择」是 primary 色文字按钮（40px 高）。窄屏（< 600px）每行 60px 高、12px 内边距。
- **文本 / 数值 / 公式、配对的下拉框、排序的序号框**：同一种描边输入框——12px 圆角、outline 色边、surface-container-low 底、最小 48px 高、12 / 16px 内边距、字体跟随页面；聚焦时是全应用统一的 3px primary 外框（偏移 3px）；禁用时 surface-container-high 底、次要文字色；占位文字次要色。公式预览是浅底虚线框，上面一行 12px 小字说明（原来是等宽字体）。
- **配对**：每行一个白底细边圆角块，左边题项、右边下拉框；720px 以下上下排列。
- **排序**：每行浅底圆角块：序号、内容、上移 / 下移（40px 圆形图标按钮，lucide 箭头）、序号框。行太窄放不下时，按钮和序号框换到内容下面一行（原来会把内容挤到很窄）。
- **附件条**：每个附件是一个浅底小块（8px 圆角）：缩略图、归属说明（「整组」/ 题号 / 「未绑定」）、末尾一个 32px 圆形移除按钮。移除按钮原来是压在缩略图右上角的 20px 小圆，现在排在块里，触屏点击区不会盖到旁边的附件。缩略图可点开放大（原来写在行内样式里的按钮外观挪进了 `rs-attach-zoom` 类）。「添加附件」换成 ui-next 的幽灵按钮（相机图标），上传失败的提示是 error-container 浅红条。
- **媒体证据**：内联图 8px 圆角细边；PDF / 无法内联的文件是 primary 色的描边胶囊下载链接（40px 高）；纯文本证据是浅底框；「加载附件…」「附件加载失败」是 13px 次要文字（原来是等宽字体）。
- **题目配图**：浅底细边、16px 圆角的块，图可点开放大，下面是图注和「点开可放大」。
- **放大查看**：遮罩用 `--un-scrim`；对话框 surface-container-high 底、28px 圆角（M3 对话框形状）、无阴影；标题 16 / 24 / 500（原来是等宽小字），右边是 ui-next 的关闭图标按钮。焦点陷阱、Esc、点遮罩关闭、关闭后焦点回到触发处，全部沿用原来的 `useFocusTrap` 与处理函数。
- **信心自评**：1–5 和「不评」是 40px 的圆形描边按钮；选中的分数是 secondary-container 实心底 + 粗体数字。整行和刻度会换行。
- **保存状态**：平时是一行 14px 次要文字 + 图标（勾 / 钟 / 感叹号）；保存失败是 error-container 色的小块（有重试时它就是按钮，点它重试，与原来一样）；版本冲突是 secondary-container 色的小块（按设计文档 `:37`）。文案、状态与重试逻辑不变。
- **状态徽标**（复盘每题、作答槽标签旁）：8px 圆角小标签，图标 + 原文字。草稿 / 已被替代 = 中性；已提交 · 待评 / 暂定 = secondary-container；已生效 / 对 = positive；部分对 / 待复核 / 错 / 暂时没法自动判 = caution。每种都有自己的文字和图标，颜色不是唯一信号。原来用的是全局旧样式 `.badge.tone-*`，现在是自己的 `rs-badge` + `data-tone`。
- **证据归属面板**：浅底 16px 圆角面板，标题行（层叠图标 +「证据归属 · 默认整页绑定全组」），每个附件下面一排 M3 筛选芯片（32px 高、8px 圆角）：「整组」和各题号；选中的芯片是 secondary-container 底并在前面显示 ✓（✓ 对读屏隐藏，选中状态仍由 `aria-pressed` 读出）。
- **作答槽标签**：13px 次要文字（原来是等宽字体、加宽字距），标签和徽标同一行，放不下时换行。
- **触控**：所有小号可点元素加 `un-hit`（触屏 44px 点击区）：清除选择、上移 / 下移、移除附件、缩略图放大、下载链接、信心按钮、保存重试、归属芯片。会换行的行在 `pointer: coarse` 下拉开间距：附件条、信心自评、归属芯片 12px，排序行的换行距离 12px。
- **动效**：只在变化时动。悬停与选中的颜色过渡读 `--un-t-feedback`（减少动效时 1ms）；没有入场动画、没有玻璃。
- **横向溢出**：选项、配对、排序、附件、徽标、下载链接都允许长文字换行（`overflow-wrap: anywhere`），选项和公式预览里的公式块可以横向滚动，网格都是 `minmax(0, 1fr)`，放大查看最宽 92vw。

## 单题作答页：哪些不变、哪些变了

`renderers.css` 里给 `rs-*` 写的规则，凡是现在 `response.css` 里有同样取值的都删了：`.rs-opts`、`.rs-opt`（含悬停、禁用、窄屏）、`.rs-opt-k`（含窄屏）、`.rs-opt-t`、`.rs-opt p`（`[data-ui-next] :where(p)` 本来就把段落边距清零）、三种输入框（含占位、聚焦、禁用）、`.rs-preview` / `.rs-order-row` / `.rs-attach-item` 的底色和边色。另外删了两个没人用的类：`.rs-input`、`.rs-evidence` / `.rs-evidence-add`（全仓库 0 使用）。`--st-*` 变量就是 M3 角色（`studio.css` 开头：`--st-outline` = outline、`--st-panel` = surface-container-lowest、`--st-soft` = surface-container-low 等），所以换成 `--un-md-sys-*` 取值相同。

**留下的一条**：选中态 `.un-st-page .rs-opt[aria-checked="true"]` / `[aria-pressed="true"]`。单题页判分后还要把你选的那项显示为选中，而控件自己的 `.is-sel` 在判分后会让位（单题页不给 `selectionOutcome`，所以也不会出现对错色）。这条和 `.un-blk-opt[data-on]` 共用，取值与 `.is-sel` 相同。

逐项核对（单题页每个属性由哪条规则胜出，前后取值）：被 `renderers.css` 显式设过的属性，取值全部不变；`studio.css` 的全应用规则（`.un-st :focus-visible` 的 3px 焦点框、`.un-st textarea` 的 `font: inherit`）照旧起作用。题面块的自由作答框高度仍由 `blocks.css` 的 `.un-blk-free .rs-textarea` 决定（它现在比控件自己的规则更具体，不再依赖加载顺序）。

单题页上**会变**的，都是原来没被 `renderers.css` 覆盖、从旧样式漏进来的部分：

- 选项字母原来是等宽字体（旧 `.rs-opt-k` 的 `--font-mono`），现在和旁边题面块里的选项一样用正文字体。
- 选中项的字母原来很可能是旧珊瑚墨色（旧 `.rs-opt.is-sel .rs-opt-k` 与 `renderers.css` 的字母规则同优先级，谁赢取决于样式表加载顺序；作答控件的样式表随练习页后加载，所以多半是它赢）。现在是 `renderers.css` 本来写的次要文字色。
- 选项正文颜色从旧 `--ink` 换成 on-surface（亮色 `#1f1e1d` → `#1d1b20`；暗色 `#f0e8d8` → `#e6e0e9`）。
- 多选勾选框：14px 旧珊瑚色 → 18px M3 复选框。
- 「清除选择」：旧等宽灰字 → primary 色文字按钮。
- 选项的颜色过渡 120ms → 90ms（`--un-t-feedback`）。
- 选项列表从 `1fr` 改成 `minmax(0, 1fr)`：只在内容比容器还宽时有区别（原来会撑出横向滚动）。
- 作答槽标签、公式预览说明、附件文件名 / 归属、「加载附件…」：等宽字体 → 正文字体，颜色换成角色色。
- 圆角：公式预览、附件块 6 → 8px；排序行、配对行 6 → 12px；内联图 6 → 8px。
- 附件移除按钮从右上角小圆改成块内的 32px 按钮；「添加附件」从旧 `.btn-ghost` 换成 ui-next 幽灵按钮。
- 排序：上移 / 下移从 26px 方框换成 40px 圆形图标按钮，行窄时换行；配对行底色、边色换成角色色。
- 题目配图块、放大查看对话框整体换成 M3E；配图按钮聚焦时原来除了 3px 焦点框还叠着一圈旧珊瑚色阴影，现在只有焦点框。

## 删除与保留

- **删除** `src/ui/primitives/IconBtn.tsx`（最后的使用者是放大查看的关闭按钮，已换成 ui-next `IconButton`）与 `src/ui/primitives/Card.tsx`（整卷作答页那一片之后已经 0 导入）。删前在全部 `.ts` / `.tsx` / `.css` / 脚本里查过（含相对路径导入），没有任何引用；`src/ui/primitives/` 没有 `index.ts`；`scripts/audit-learner-copy.ts` 不列这些文件。
- **保留**：
  - `Icon.tsx` 与旧 `Button.tsx`：`web/src/TokenGate.tsx` 用旧 `Button`，`Button` 里用 `Icon`。作答控件从来没用过它们；TokenGate 不在本片，所以两者都留着。
  - `LoomIcon.tsx`：ColdStart、`recompute/RecomputeComponents.tsx`、`HintLadder`、命令面板、`nav-config.ts`、`coach-hub-view.ts`、`agency/ui/meta.ts`、`event-detail-model.ts`、旧 `Btn` 还在用。作答控件里已经一处不剩。
  - `Btn.tsx`、`BrandMark.tsx`（ColdStart）、`useFocusTrap.ts`（放大查看等 8 处）。
- **没删、留给后续**：
  - `web/src/globals.css` 里 `.icon-btn*`（`IconBtn` 删了以后已经没有元素带这个类）、`.btn*` 与 `.badge.tone-*`（作答控件不再用；别处是否还用没在本片核对）。本片没有授权改 `globals.css`。
  - `src/capabilities/practice/ui/solo/practice-solo.css` 里挂在 `.un-ps` 下的整段 `rs-*` 规则：仓库里已经没有任何元素带 `un-ps` 类（单题页换成了 `practice-studio`），这些规则不生效。它们和该文件里别的 `.un-ps-*` 规则混在一起，整文件清理应单独一片。
- **与 `src/ui-next/AGENTS.md` I4 的冲突**：I4 说「不要编辑 `src/ui/`、`web/src/globals.css`」。这一线有书面例外：owner 要求删除全部旧界面（2026-10-20），根 `AGENTS.md` 的 S13 规定「DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除」，m3e 方向文档 `:98` 要求「每片消费 M3E 后退出自己的旧样式」，协调线也明确把 `src/ui/components/response/*` 指定为本片、并要求删掉失去使用者的旧原件。这次在 `src/ui/` 修改了作答控件（只改呈现：类名、图标、`un-hit`、放大查看的作用域属性）和 `response.css`，并**删除**了两个 0 导入的旧原件；`web/src/globals.css` 没有动。`renderers.css` 只删规则、加一段说明。

## 逻辑未变的证明

脚本入口 `tlp-status/_work/yuk1473/response/logic.sh`：原文件用 `git show origin/main:<file>` 存到 `response/orig/`（脚本先逐字核对），然后对每个改过的 `.tsx`（10 个）跑三遍：`strip_logic.cjs`（去掉 import / 注释、把最外层 JSX 换成占位符后比对）、`jsx_handlers.cjs`（所有函数 / ref / `on*` 属性）、`admin-b/jsx_attrs.cjs`（表单 / 写入属性），再跑树位置检查（`response/jsx_tree.cjs`，由 `practice-b/jsx_tree.cjs` 改来）。结果在 `response/logic-diff.txt`、`attrs-diff.txt`、`tree-diff.txt`。

第一遍（JSX 之外）剩下的差异：
- `AssetEvidencePreview`：`const icon = … ? 'mic' : … ? 'record' : 'doc'` 变成 `const FileIcon = … ? Mic : … ? Video : FileText`。同一个原有三元、同样的判断顺序，只是结果从旧图标名换成 lucide 组件。
- `SlotResultBadge`：`LIFECYCLE_ICON` 的值从旧图标名换成 lucide 组件（六个状态一一对应：草稿 → 铅笔、待评 → 钟、暂定 → 层叠、待复核 → 圆形感叹号、已生效 → 勾、已被替代 → 回退）；渲染前多一行 `const LifecycleIcon = LIFECYCLE_ICON[lifecycle]`（JSX 里组件名必须大写）。
- 其余 8 个文件没有差异。

第二遍（处理函数）：10 个文件**全部没有差异**。

第三遍（表单 / 写入属性）：少掉的 `name=…` 全是旧 `LoomIcon` 的图标名；`EvidenceComposer` 少一个 `type="button"`（「添加附件」换成 ui-next `Button`，它默认就是 `type="button"`）；`EvidenceLightbox` 少一个 `title="关闭"`（关闭按钮换成 `IconButton label="关闭"`，它渲染出 `title="关闭"` 和 `aria-label="关闭"`——原来没有 `aria-label`，可访问名称来自 `title`，同样是「关闭」）。`disabled`、`value`、`id`、`aria-*`、`role`、`tabIndex`、`accept`、`multiple`、`inputMode`、`maxLength`、`placeholder`、`rows` 全部不变。

JSX 里其他表达式（`className` / `style` 除外）的差异：图标的 `size`；三处原有的嵌套三元（附件类型图标、保存状态图标、徽标图标）原样保留判断，只是末端从图标名字符串换成 lucide 元素；`SlotResultBadge` 新增 `data-tone`（原来写在类名里的同一个值）；`EvidenceLightbox` 的 `icon` 属性。新增的字符串属性只有 `aria-hidden="true"`（每个图标）、遮罩的 `data-ui-next` / `data-un-m3e`、`Button` 的 `variant` / `size`。行内样式只删不加：缩略图放大按钮、证据归属的两层 `div`、附件区外层 `div` 和上传失败行的行内样式都换成了类名，取值搬进 `response.css`（`EvaluationGroupPanel` 里 `rs-attach-item` 的 `display: inline-flex` 原本就和类里的一样）。

### 树位置检查

`response/jsx_tree.cjs` 列出每个带 `key=` / `ref=` 的元素，以及每个有状态的元素（`textarea`、`input`、`select`、`option`、`audio`、`video`、`img`、`AssetEvidencePreview`、`TextEvidence`、`EvidenceLightbox`、`AttachmentStrip`、`TextResponse`、`ChoiceSetResponse`、`MatchingResponse`、`OrderingResponse`、`SlotResultBadge`、`MathMarkdown`、`StimulusFigure`），给出从组件根到它的每一级：宿主元素、`key`、它在父元素子节点里的序号，以及中间每一个条件（`&&`、三元的哪一支、`map` 的来源）。ui-next `Button` / `IconButton` 与旧 `IconBtn` 都按它们渲染出的 `button` 记。

结果：10 个文件里 9 个**完全一致**。例如 `EvidenceComposer` 的文件输入 `input[ref=fileRef]` 仍是根 `div` #2 → `&&[!disabled]` → `div` #0（外层 `div` 只是行内样式换成了类名）；`TextResponse` 仍是根 #0 → `&&[showText]`；排序的 `li[key=id]`、上移按钮 `button[ref=…]`、序号 `input` 的位置不变；放大查看的对话框（`ref=trapRef`）仍在遮罩下的同一位置。

唯一的差别在 `ChoiceSetResponse`，就是修 key 警告那一处（见下）。

## 「Each child in a list should have a unique key prop」

原因：`options.map` 每一项返回的是一个**没有 key 的片段** `<>…</>`，`key={opt.id}` 写在片段里面的按钮上（那里它没有作用），React 于是退回用序号当 key 并报警告。

修法：去掉片段，让 `map` 直接返回带 `key={opt.id}` 的按钮（biome 的忽略注释挪到 `return (` 里面、紧贴按钮）。树检查里这一项从 `div` #0 → `map[options]` → `<>` #0 → `button[key=opt.id]` 变成 `div` #0 → `map[options]` → `button[key=opt.id]`，按钮下面的子节点和序号都没变。

为什么安全：
- 被改 key 的是选项按钮这一整棵小树，里面没有任何本地状态：两个 `span`、勾选图标、`MathMarkdown`。`MathMarkdown` 只用 `useSyncExternalStore` 读模块级的公式插件缓存；它里面的图片读的是全局共享的资源缓存（`useAssetUrl`）。没有 `useState` / `useRef`，没有输入框。
- 新 key 是选项 id：由内容派生、同一题内去重（`deriveOptionIds` 给重复文本加 `-2`、`-3` 后缀；原生题的 schema 校验也拒绝重复的 `option_id`），同一题渲染期间不变。选中状态本来就按 id 记，组件的点击、方向键（按 DOM 顺序找 `.rs-opt`）、数字键、`onChange` 发出的值都不受影响。
- 唯一可能的差别：如果同一个组件实例在某个选项按钮**有焦点时**换成另一组选项，原来按序号复用按钮，现在会换成新按钮。没有这样的路径：整卷、单题、定级、对话内确认题都按 `slot_id` 给作答槽加了 key，换题时整个作答槽会重新挂载；整卷页旧的直接选择题路径换题要先点题号或上一题 / 下一题按钮，焦点已经在那个按钮上。

## 交互变化（键盘、焦点、由哪个元素触发）

- 所有处理函数、禁用条件、键盘处理、焦点陷阱和 DOM 顺序不变，所以 Tab 顺序不变。
- 放大查看的关闭按钮多了 `aria-label="关闭"`（名称不变，原来来自 `title`）。
- 「添加附件」从原生按钮 + 旧 `btn` 类换成 ui-next `Button`（仍是 `button type="button"`，处理函数与禁用条件不变）。
- 附件移除按钮从缩略图右上角挪到附件块的末尾（同一个元素，DOM 顺序本来就在最后）。
- 所有图标换成 lucide 并对读屏隐藏（旧 `LoomIcon` 是装饰性 svg）。
- 焦点框：各控件统一是 3px primary 外框（偏移 3px），与应用外壳的 `.un-st :focus-visible` 一致；原来选项、输入框、配图按钮在外壳之外的页面上是旧珊瑚色光圈。
- 选项列表的 key 从序号换成选项 id（上节）。

## 文案调整

- 没有。所有标签、说明、按钮文字、占位文字、出错与加载文案一字未改。

## 没做的

- 「漏选」（正确但没选的选项）在控件里没有对应的类或数据，复盘里也只传所选集合的对错，所以无法单独显示；要显示需要宿主多传一份数据，是新行为，不在本片。
- 文本框没有悬停态：单题页的设计没有，本片以它为准。
- 见上「没删、留给后续」。

## 审查与验收

- 本机检查：完整本地闸门（对比 merge-base，含 typecheck / lint / build / 各 audit / lint ratchet）。结果见提交汇报。
- 独立审查重点：三遍比对与树检查；`ChoiceSetResponse` 的 key 修法；单题页每个控件在 `renderers.css` 删规则后取值是否真的不变（尤其是选项、三种输入框、判分后的选中态）；放大查看在 `<body>` 下的作用域与暗色；保存状态三种外观与重试。
- 真实页面检查（由协调线负责，独立开发库）：整卷、复盘、单题、定级、对话内确认题、今日探针各走一遍选择 / 文本 / 排序 / 配对 / 附件与放大 / 信心 / 保存状态；作答 → 刷新 → 草稿仍在 → 交卷 → 已判分；作答中关掉标签页再打开；判分中刷新。亮色 / 暗色；320、375、640、760、880、1240、1440px 无横向滚动；触屏下换行的按钮点击区不重叠；键盘焦点可见；减少动效时没有过渡。
