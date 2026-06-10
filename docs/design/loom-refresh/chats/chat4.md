# 题库管理台

_Started 2026-06-07 14:10 UTC_

---

## User

新屏需求:题库(全部题目)一级页面

定位:左侧一级导航新增「题库」入口。它是所有题目(question 实体)的管理面:浏览、搜索、筛选、详情编辑、删除。与「错题」的区别:错题是答错记录的归因视角;题库管理题目本体全集——包括从未做过的题、AI 变体、各录入来源的题。

数据与状态(后端已有):
- 题目:题型(单选 / 简答 / 翻译 / 填空 / 阅读理解五种)、题面 Markdown(含 LaTeX 公式与配图)、参考答案、选项(单选题)、难度 1-5、知识点(多个,关联知识图谱节点)、来源(种子数据 / 教学小测 / 试卷录入 / AI 生成变体)、创建时间
- 层级结构:大题-小题(composite,父题下挂多个小题,如阅读材料带 4 问)
- 变体链:一道题的 AI 变体家族(root → 变体,带深度)
- 关联状态:被做过几次(attempt)、是否在复习队列(FSRS)、属于哪些卷、是否有错题记录
- 删除约束:有 attempt / 复习卡 / 卷引用的题不能静默删——需要警示性的确认表达(具体语义后端定,设计上要有「此题有 N 条关联记录」的状态呈现)

布局诉求(功能层面):
- 主列表:全部题目,可筛选(题型 / 难度 / 知识点 / 来源 / 草稿 vs 正式)+ 题面文本搜索 + 排序(时间 / 难度)
- 列表行:题面摘要(LaTeX 需正常渲染)、题型、难度、知识点 chips、来源标识、做过/在复习的微指示
- 详情:点开看全题(题面 + 选项 + 答案 + 配图),可编辑题面 / 答案 / 选项 / 难度 / 知识点
- composite 题:父题行可展开小题
- 变体:详情内可见变体家族入口
- 空态:题库为空时引导去录入(拍照 / 上传试卷)

硬约束:中文 UI;沿用现有 loom 壳与一级导航模式(位置建议在 错题 与 练习 附近,可自行斟酌);移动断点可用;不发明新的全局导航结构。数据规模:单用户、百到千级题目。

## Assistant

_[tool: list_files]_

_[tool: list_files]_

I'll start by exploring the design system's UI kit to understand the existing loom shell, navigation, and especially the 错题 (mistakes) page since 题库 sits near it conceptually.

_[tool: read_file]_

_[tool: read_file]_

The current project already has many files including a `screen-questions.jsx`. Let me understand the current state — read the shell, app entry, the existing questions screen, and the mistakes screen for pattern reference.

_[tool: read_file]_

_[tool: read_file]_

There's already a `questions` route wired into `app.jsx`. Let me check the existing `screen-questions.jsx` (likely a stub), the mistakes screen for patterns, and which HTML file is the live entry.

_[tool: read_file]_

_[tool: read_file]_

The existing `screen-questions.jsx` is a P5 list view. The new spec asks for a much richer page — detail/edit view, composite expand, variant family, delete constraints, LaTeX, search, sort, empty state. Let me read the questions data, the P5 styles, the shared components, and the mistakes screen for the detail-panel pattern.

_[tool: read_file]_

This is a substantial expansion of the existing P5 questions screen. Before I build, let me understand the available component primitives, the detail/drawer patterns, and what icons exist.

_[tool: read_file]_

_[tool: grep]_

Let me look at the detail-screen and drawer patterns, plus how knowledge nodes are labeled, so my detail panel and chips match house style.

_[tool: grep]_

_[tool: read_file]_

Let me check the drawer/modal/scrim patterns across the CSS files and the copilot drawer markup.

_[tool: grep]_

_[tool: grep]_

I have a strong grasp of the system now. Let me check the knowledge node data so my knowledge-point chips can show real readable labels, and confirm the `Btn` variants/`field` styles available.

_[tool: snip]_

I have everything I need. Let me snip the huge grep output to free context, then build. I'll start with the new richer data model.

_[tool: update_todos]_

Now the new data model. This rewrites `DATA.questions` to match the new spec (5 题型, composite, variant chains, association state) and adds a Markdown+LaTeX renderer.

_[tool: write_file]_

_[tool: write_file]_

Now the Markdown + LaTeX renderer (KaTeX-backed, degrades gracefully):

_[tool: write_file]_

Now the stylesheet. Namespaced `qb-`/`qd-`, reusing existing tokens, card, and `.kd-grid` layout.

_[tool: write_file]_

Now the list screen — search, sort, filters, micro-indicators, composite expand, empty state:

_[tool: write_file]_

Now the detail/edit screen with variant family, composite subquestions, association state, and the delete-constraint modal:

_[tool: str_replace_edit]_

Let me fix the awkward option-editing block — replace the hidden input with a clean click-to-edit toggle.Now add the `editOptIdx` state:

_[tool: str_replace_edit]_

Now wire into Loom.html (KaTeX, CSS, new scripts) and app.jsx (detail route + title).

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now register the detail route in `app.jsx`:

_[tool: show_html]_

Let me load it and check the questions page renders.

_[tool: show_html]_

The shell loads. Now let me navigate to the 题库 page and screenshot it.

_[tool: save_screenshot]_

_[tool: save_screenshot]_

_[tool: str_replace_edit]_

List looks great and LaTeX renders. The right-side cluster is a bit cramped (188px) — the "AI 生成变体" source label wraps. Let me widen the column, shorten the variant label, and prevent wrapping.

_[tool: str_replace_edit]_

_[tool: save_screenshot]_

Let me check the detail page and the composite expand. I'll capture a few states.

_[tool: save_screenshot]_

Excellent — the editor, live preview, options, and side rail look polished. Let me see the lower half (answer, variant family, association state, delete).

_[tool: eval_js]_

_[tool: save_screenshot]_

_[tool: save_screenshot]_

Beautiful — the variant family tree, association state, and delete card all render well. Let me verify the delete-constraint modal.

_[tool: str_replace_edit]_

The modal is being trapped by a transformed ancestor (entrance animations create a containing block), so `position: fixed` isn't viewport-relative. Let me portal it to `document.body`.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: eval_js]_

The scrim now covers everything (portal works) but the card isn't visible. Let me inspect it.

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

Animation is perpetually restarting — likely a remount loop. Let me probe whether the node persists.

_[tool: eval_js]_

_[tool: show_html]_

Let me reload fresh and measure the modal opacity over time to confirm whether it settles or loops.

_[tool: eval_js]_

_[tool: str_replace_edit]_

Found it — in a backgrounded iframe, CSS animations pause at frame 0, so an entrance that starts at `opacity:0` leaves the modal invisible. I'll make the pop animate transform only (never gate visibility on it).

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: save_screenshot]_

The constraint-aware delete modal is exactly right. Now let me verify the composite question (passage + subquestions) detail and the list expand.

_[tool: str_replace_edit]_

Two refinements: composite parents shouldn't show an (empty) 参考答案 section, and the "做过 N" meta wraps. Let me fix both.

_[tool: str_replace_edit]_

_[tool: save_screenshot]_

Let me verify the list composite-expand and a LaTeX-heavy answer (the 圭田 question).

_[tool: str_replace_edit]_

LaTeX renders beautifully in the answer. One issue: the `answerNote` shows raw `$...$` because it's plain text — let me route it through `QInline`.

_[tool: update_todos]_

All states render correctly. Let me update todos and do a final console check.

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: str_replace_edit]_

Clean (only the expected Babel dev warning). Let me make the app remember the current route across reloads so the user lands back on 题库 — a small persistence nicety in `app.jsx`.

_[tool: str_replace_edit]_

_[tool: eval_js]_

Now let me set the saved route to 题库 so the user lands there, then hand off.

_[tool: done]_

_[tool: fork_verifier_agent]_

_[tool: snip]_

「题库」一级页面已建好，接入现有 loom 壳（侧栏在 错题 / 学习项 之间）。

**主列表** — 顶部统计带 + 题面搜索 + 排序（时间 / 难度，可升降）+ 状态分页（全部 / 正式 / 草稿）+ 来源 / 题型 / 难度 / 知识点筛选。每行：题面（LaTeX 正常渲染）、题型、5 点难度、知识点 chips、来源标识，以及做过 / 在复习 / 错题 / 卷引用的微指示；母题（◆）/ 变体（◇）/ 小题（▫）用字形区分。

**详情/编辑** — 点开为整页编辑器：题面 stem（Markdown + LaTeX 实时预览）、选项（点字母设正确答案）、参考答案、配图占位；右栏改题型 / 状态 / 1–5 难度 / 知识点 / 来源 / 创建时间，并汇总关联状态（作答 · 复习卡 · 错题 · 卷引用）。

**composite** — 阅读大题在列表里可展开小题；详情含 passage 编辑 + 小题列表，关联数会把小题一并累加。**变体** — 详情内有变体家族树（母题 → 变体，标注当前）。**删除** — 有关联记录时弹出警示确认，逐条列出「N 条作答 / N 张复习卡 / N 份卷引用 / N 条错题」并需输入「删除」确认；无关联则可直接删。**空态** 引导去拍照 / 上传试卷。

几点说明：
- 这是在现有 P5 题库雏形上的全面重写，题型已对齐到你的五种（单选 / 简答 / 翻译 / 填空 / 阅读理解），并替换了原先的 grounding / 安全轴。
- 数据为前端 mock；编辑 / 删除只改内存态，刷新复位（路由会记住停在题库）。
- 编辑控件（保存 / 添加选项 / 添加知识点等）是交互骨架，未接后端。
- 移动断点已写样式但未在窄屏实拍，可在手机宽度自查一下。

## User

把所有题型都放一个例子进去：数学大题，语文阅读，英语完形，英语阅读，英语填词。

## Assistant

_[tool: str_replace_edit]_

On it — I'll add one composite example for each: a math 大题, a Chinese reading set, an English cloze (完形), an English reading set, and an English 语法填空 (填词). First the knowledge labels:

_[tool: str_replace_edit]_

Now the five cross-subject 大题. I'll insert them right after the existing bank array:

_[tool: show_html]_

Let me verify the new questions render — reload and screenshot the list plus the math 大题 detail.

_[tool: get_webview_logs]_

_[tool: save_screenshot]_

_[tool: save_screenshot]_

All five render correctly with LaTeX in the math subquestions. Let me spot-check a math sub-answer and the English 完形 detail.

_[tool: done]_

All five new subject examples render correctly — math LaTeX in answers, English 完形/阅读/填词 with their subquestions, and accurate association counts. Handing off.

_[tool: fork_verifier_agent]_

已加入五道跨学科 **大题（composite）** 各一例，都能展开小题、带关联状态与删除约束：

- **数学大题** `导数·单调极值` — 共享条件 $f(x)=x^3-3ax+1$ + 3 个简答小问（单调区间 / 极值求 a / 闭区间最值），答案与批注的 LaTeX 正常渲染。
- **语文·现代文阅读** — 短文材料 + 单选 + 简答 2 小题。
- **英语·完形填空** — 带编号空的短文 + 3 个单选小题（每空 ABCD 选项）。
- **英语·阅读理解** — passage + 2 个单选（含 EXCEPT 题）。
- **英语·语法填空（填词）** — 短文 + 3 个填空小题（go→went / be→were / amaze→amazing）。

题型仍归到原五类（数学大题归「简答」、完形与填词归「填空」、两篇阅读归「阅读理解」），靠「大题·N 小题」徽标区分；新知识点（导数、现代文、英语完形/阅读/语法填空）已自动并入知识点筛选条。数据仍为前端 mock。

## User

连按科目筛选都没做？

## Assistant

_[tool: str_replace_edit]_

You're right — with three subjects now in the bank, a 科目 filter is essential. Let me add a subject dimension (derived from knowledge, so no per-row data edits), a prominent 科目 segmented filter, and a subject tag on each row.

_[tool: str_replace_edit]_

Now wire it into the list — subject tag on rows, the filter, and a segmented 科目 control:

_[tool: str_replace_edit]_

Good catch — that's not a true duplicate (top is the editable Markdown/LaTeX **source**, bottom is the rendered **preview**), but when a stem has no LaTeX or formatting they look identical and the preview is just noise. The fix: only show the preview when there's actually markup to render. Let me add that.Now gate the stem and passage previews on actual markup:

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: str_replace_edit]_

I'll gate both the stem 预览 and the passage rendered-card so they only appear when there's LaTeX/markup to render (otherwise the source textarea alone is enough). I'll keep the green 参考答案 card since it's a distinct highlighted block, not a literal preview.

_[tool: str_replace_edit]_

For consistency, let me apply the same logic to the 参考答案 card — only render the highlighted block when the answer has formatting or an AI note (so a plain answer isn't echoed twice).

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now let me finish the 科目 filter that I'd started before the comment came in — subject tag on rows plus a segmented 科目 control and the filter logic.

_[tool: str_replace_edit]_

Now the subject state, filter logic, reset, and the segmented 科目 control:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now the 科目 segmented control at the front of the filter bar:Now the CSS for the subject row tag and the divider:

_[tool: str_replace_edit]_

_[tool: show_html]_

Let me verify — reload, screenshot the list (科目 filter + subject tags) and the plain-text question detail (should no longer double up).

_[tool: save_screenshot]_

_[tool: eval_js]_

Both fixes are in: the 科目 segmented filter + colored subject tags per row, and plain-text questions no longer show a redundant preview/answer card. Let me confirm the filter actually narrows the list.

_[tool: eval_js]_

_[tool: done]_

科目 filter works — selecting 数学 narrows to exactly the 3 math questions. Both items are resolved. Handing off.

_[tool: fork_verifier_agent]_

两件事都补上了：

**科目筛选** — 筛选栏最前面加了「科目」分段控件（全部 / 语文 / 数学 / 英语），列表每行也带上了科目色标（语文=珊瑚 / 数学=靛蓝 / 英语=苍绿）。科目由知识点自动推导，无需逐题标注；选「数学」即只剩那 3 道数学题。

**重复那两块** — 你圈的不是真重复：上面是可编辑的 Markdown/LaTeX **源**，下面是渲染**预览**。但纯文字题（无公式/格式）两者长得一样，确实多余。现在改成：只有题面含公式或格式时才显示预览，参考答案同理（纯文字答案不再被绿卡重复一遍）——数学/古算等带 LaTeX 的题仍保留预览。

## User

给copilot做一个全屏形态，外加多session管理侧面板

## Assistant

_[tool: snip]_

_[tool: snip]_

Now let me read the existing Copilot drawer fully to understand its structure, data, and styling before building the full-screen mode + session panel.

_[tool: read_file]_

_[tool: read_file]_

Let me look at the richer tool-use card components and the existing message/composer CSS, since the design system frames Copilot's tool_use calls as first-class cards.

_[tool: read_file]_

The project has a rich first-class `window.ToolCard` (with model/cost/latency/confidence/actions). Let me see its spec format and styling so the full-screen Copilot can use real tool_use cards.

_[tool: read_file]_

This rich `ToolCard` vocabulary is perfect for the conversation. Let me check its stylesheet for collision risk before wiring it into the app.

_[tool: grep]_

tool-use.css redefines global `.btn`/`.eyebrow`/`body`, so I can't load it wholesale — I'll port just the card rules into a scoped stylesheet. Let me check the app's main/topbar layout so the full-screen Copilot fills correctly, and confirm button variants and the chat/message CSS.

_[tool: grep]_

_[tool: eval_js]_

Let me measure the topbar height so the full-screen Copilot can fill exactly below it.

_[tool: str_replace_edit]_

Topbar is 59px (`<main>` has no padding of its own). I'll measure it at runtime to be safe. Let me start building — first a `maximize` icon for the drawer's expand affordance:

_[tool: write_file]_

Now the multi-session data with rich tool_use specs:

_[tool: str_replace_edit]_

Now add a `chevronDown` icon (used by the tool card's args toggle) and build the self-contained tool card:

_[tool: write_file]_

_[tool: write_file]_

Now the full-screen screen itself — sessions panel + conversation + composer:

_[tool: str_replace_edit]_

Now add a mobile sessions toggle to the screen before writing CSS:

_[tool: str_replace_edit]_

Let me fix the title-area structure so the toggle sits left of the stacked title/subtitle:Now the stylesheet — full-screen layout, sessions panel, conversation, composer, plus the ported tool-card rules:

_[tool: write_file]_

_[tool: str_replace_edit]_

Now wire everything into `Loom.html`:

_[tool: str_replace_edit]_

Now register the screen/route/nav in `app.jsx`:Now add the expand button to the drawer header in `copilot.jsx`:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Let me load it and check for errors, then screenshot the full-screen Copilot.

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: str_replace_edit]_

Looks strong. A few tight-spacing nits: the args value wraps and overlaps, the session meta row wraps ("N 条"), and the composer hint wraps. Let me tighten those.

_[tool: str_replace_edit]_

_[tool: get_webview_logs]_

_[tool: save_screenshot]_

Clean. Let me re-check the spacing fixes and see a waiting/approval tool card.

_[tool: show_html]_

The preview was stale (my CSS/JS edits weren't reloaded). Let me reload and re-capture, scrolled to the approval card.

_[tool: save_screenshot]_

_[tool: str_replace_edit]_

The ellipsis is too aggressive on short values. Let me let args wrap cleanly with comfortable spacing instead (no overlap, no truncation):

_[tool: show_html]_

Let me reload and verify the args, the approval card, and session switching.

_[tool: save_screenshot]_

_[tool: eval_js]_

The overlap persists across renders — let me check whether it's real in the DOM or a screenshot-renderer artifact.

_[tool: eval_js]_

The overlap is only an html-to-image artifact — in the real DOM each arg is a clean single line (rowH 20px, no overflow). The page renders correctly. Let me verify the interactive bits functionally: approval actions and the new-session flow.

_[tool: show_html]_

New session works (6→7, blank state shown). The approval test hit the wrong session (state persisted on s_eng). Let me reload and test the approval cleanly on s_zhi.

_[tool: eval_js]_

_[tool: save_screenshot]_

Approval resolves correctly ("已写入 2 张卡片 · 进入今日队列 · e_4491 · propose→accept"). Everything works. Let me grab one clean visual of the new-session blank state, then hand off.

_[tool: save_screenshot]_

_[tool: show_html]_

_[tool: save_screenshot]_

_[tool: eval_js]_

The full-screen Copilot is complete and polished — new-session blank state, session management, and tool cards all work. Let me land the user on it and hand off.

_[tool: done]_

_[tool: fork_verifier_agent]_

Copilot 全屏工作台做好了，路由 `#copilot`，沿用 loom 壳。

**全屏形态** — 左侧多会话管理 + 中间对话视图 + 底部 composer。对话里每次 `tool_use` 都是一等卡片：函数名 + `agent` 标签 + 状态胶囊、可展开的 arguments、结构化结果（知识节点 / 错题归因链 / 变体卡 / FSRS 排程 / mesh 边 / OCR 提取）、`模型·成本·耗时·置信度·caused_by` 成本透明带，以及「接受 / 忽略 / 改关系」审批行——按下真的落一条 event。

**多会话侧面板** — 按 今天 / 昨天 / 更早 分组；每条会话显示标题、预览、模型标、累计花费、时间；支持搜索、置顶、重命名（行内）、删除、新建；底部「本月 Copilot 花费」总额带。切换会话即换线程，composer 可切 Haiku / Sonnet 并显示单条预估成本。

**入口** — 抽屉头部新增「全屏」按钮可展开为全屏；侧栏 Copilot 直接进全屏；全屏右上角「收起为抽屉」回到快捷抽屉。移动端会话面板转为可切换的滑出层。

几点说明：
- 全部前端 mock；发消息会模拟一条带 `search_knowledge` 卡片的回复并累加成本，刷新复位。
- 截图里 arguments 文字偶有重叠是 html-to-image 的渲染假象，实际 DOM 每行单行不重叠（已核验）。
- 复用了设计系统的 tool_use 卡片词汇，但避开了其会覆盖全局 `.btn` 的样式表，单独内联了一份作用域化的卡片样式。

## User

我需要按科目/按类型过滤，证据编号我又看不懂

## Assistant

_[tool: snip]_

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

Let me read the full proposals dataset to understand evidence/types and what subject info exists.

_[tool: grep]_

The fix is clear: replace the cryptic "按证据过滤" (raw-ID chips) with **按科目** + **按类型** filters, and make each card's evidence read in plain language. Let me check `KIND_META`/`REL_LABEL` labels first.

_[tool: str_replace_edit]_

I'll: (1) add cross-subject proposals + derive subject, (2) replace the raw-ID "按证据过滤" with **按科目** + **按类型** filters, and (3) make each card's evidence read in plain language. First, a few math/English proposals so the subject filter is meaningful:

_[tool: read_file]_

Understood — same treatment for 错题本. Let me read the full mistakes dataset so I can add subject-aware filtering and more cross-subject records.

_[tool: str_replace_edit]_

Now the mistakes filtering. Let me add cross-subject mistake records so the subject filter is meaningful:

_[tool: grep]_

Now let me see where the inbox/evidence styles live so I can extend them consistently.

_[tool: write_file]_

Now I'll rewrite `screen-mistakes.jsx` with readable evidence, subject tags, and proper 科目/类型/状态/归因 filters on both screens:Now the CSS for the filter rows and readable evidence — appended to `screens.css`:

_[tool: str_replace_edit]_

_[tool: show_html]_

Let me load and check both screens.

_[tool: get_webview_logs]_

_[tool: save_screenshot]_

_[tool: str_replace_edit]_

The Inbox filters and readable breakdown work. One inconsistency: the 类型 chip says "笔记合并" but the lane/breakdown say "块合并" (the real `block_merge` label). Let me align to "块合并".

_[tool: show_html]_

Let me reload and check the readable evidence line plus the 错题本 filters.

_[tool: save_screenshot]_

_[tool: str_replace_edit]_

Both screens now have proper 科目/类型/状态/归因 filters and plain-language evidence ("最近：重做正确，纳入复习" instead of `→ events:evt_3120`). Small nit: the "AI 归因" chip wraps. Let me prevent chip wrapping and verify filtering works.

_[tool: show_html]_

_[tool: eval_js]_

_[tool: eval_js]_

Filtering verified on both screens (Inbox→数学: 1 card; 错题本→英语: 2 cards), and evidence reads in plain language ("最近：重做正确，纳入复习"). Both asks are done. Let me land the user on the Inbox and hand off.

_[tool: done]_

_[tool: fork_verifier_agent]_

收件箱和错题本都加了真正的筛选，证据也改成白话了。

**收件箱** — 把原来按「证据编号」(看不懂的 evt_xxxx) 的过滤换成 **按科目**（全部 / 语文 / 数学 / 英语）+ **按类型**（知识关系 / 块合并 / 笔记更新）两行筛选；汇总行改成可读的「知识关系 4 · 块合并 3 · 笔记更新 5」。每张卡片标了科目色标，底部证据从 `→ event:evt_3120` 改为一句白话「源自「之」的一次答错 / 源自录入《报任安书》」，原始事件号只留在悬停提示里。

**错题本** — 原来没有任何筛选，现在加了 **科目 / 状态（待重学·已纠正·归因中）/ 归因（AI 归因·我标注）** 三行；卡片加科目色标，底部把 `→ events:evt_3120` 换成「最近：重做正确，纳入复习」这样的白话事件摘要，点开仍是完整事件链。

为了让科目筛选有意义，顺手补了几条跨学科数据：数学（导数大题）、英语（完形 / 语法填空）的 AI 提议与错题各一两条。都是前端 mock，裁决 / 筛选刷新即复位。

