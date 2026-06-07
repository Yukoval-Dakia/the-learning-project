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

