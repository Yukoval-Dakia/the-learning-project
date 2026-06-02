# Loom UI 重绘 · Round-2a 纠偏稿（给 claude.ai/design）

> **怎么读**：这是给 claude.ai/design 的**续作指令**，直接贴进**上一轮那个会话**继续（你还留着 `loom.css` 和各 screen 的上下文，增量补最省事）。
> **这一轮要做什么**：你 round-1 的**视觉获批——整套设计语言保留，不要重做外观**。这一轮是**外科式、只增不改**：保留你建的每一屏的视觉，补上缺的功能、修下列契约违背，别回退已跑通的屏。
> **为什么有这一轮**：round-1 你没能找到那份完整功能 handoff（它当时在一个未合并分支上、GitHub main 上没有），所以你照旧的 `2026-05-30` brief + 会话里口头收窄的范围建的。完整功能契约在下面复述了——**行为以它为准**。
> **范围**：round-2 拆两轮。**本稿是 round-2a** = P0 契约修复 + 日常高频屏（**今日 / 复习 / 录入 / 收件箱 / 错题**）。更重的屏（知识详情、学习项详情、`/coach`、`/learning-sessions`、block-tree 笔记编辑器、`/events/[id]`、`/admin`）放 **round-2b**——**这一轮不要建**，见 §5。
> **关于下文的"round-1 现状"**：每条都核对过你交付的 jsx/CSS（`screen-*.jsx` / `data.jsx` / `loom.css`），不是看截图猜的。日期 2026-06-02 · YUK-169。

---

## 0. 视觉：原样保留，不要重做

你的 round-1 视觉是认可的。**完整保留**：warm-paper 暖纸底 + 单一 coral/赭石强调 + Source-Serif 大标题/hero + 织/三缕线隐喻（含 woven 字标）+ 完整 dark mode + motion + `loom.css` 全套 token。**不要**改调色、改隐喻、改排版方向。下面所有"补"和"换"都用你**已有的** tokens / primitives / 组件去落地。本稿改的是**功能与内容语义**，不是外观。

---

## 1. 全局不变量（处处适用，硬契约）

1. **路由**（精确、不可变）：`/today /record /review /mistakes /learning-items /learning-items/[id] /learning-sessions /learning-sessions/[id] /knowledge /knowledge/[id] /events/[id] /inbox /coach`；根 `/`→`/today`；**`/study-log` → `/record` 重定向**；`/health`；`(admin)` `/admin/runs /admin/cost /admin/failures`。（本轮只实现 today/record/review/mistakes/inbox + 它们指向的路由；其余先占位。）
2. **FSRS 评分只有三档**：`again`(不会) · `hard`(模糊) · `good`(会了)。你的 design system 本身就只定义这三档（`colors_and_type.css` 里只有 `--again/--hard/--good`，无 `--easy`）。**但 round-1 的第 4 档 `easy` 是四处联动的，要全清，否则会半删后复发**：
   - `data.jsx:33-38` 的 `grades` 数组删掉第 4 项 `{ g:"easy", label:"简单", when:"26天", cls:"g-easy" }`（评分是 `c.grades.map` data-driven，源头在这）
   - `loom.css:390` 的 `.grade-btn.g-easy` 规则删掉（它借 `--info-line/--info-ink` 上色，根本不是 FSRS token）
   - `screen-review.jsx:24` 键位 map 从 `{1:again,2:hard,3:good,4:easy}` 收到 1-3
   - `screen-review.jsx:85` reveal 提示「空格翻面 · 1-4 评分」改「…1-3 评分」（键盘本身见 §2C 还要改）
3. **状态绝不能只靠颜色区分**。FSRS 三档、归因（AI-caused vs user-caused）、知识边 5 类关系、各种 status，**每个都要有非颜色线索**（形状/标签/图标/文字），叠加在颜色之上。
4. **抽屉/弹层 focus 管理**：trap + restore + 键盘可关闭（Esc）。**这是针对 round-1 实物的待修项，不是抽象约束**——你的 `CopilotDrawer`（`copilot.jsx:75-118`）目前只有 `aria-hidden={!open}` + scrim onClick，**没有 focus trap、没有 focus restore、没有 Esc 关闭**。补上（handoff §4 硬契约）。
5. **每个数据区块**都要有 loading / empty / error 三态。下文逐屏会点名 round-1 缺哪一态。
6. **UI 文案是简体中文**（下文样例字符串即真实文案）。代码标识符 / ID / 时间戳 / 成本 / 版本串当前走等宽、round-1 也已用 `tnum`/`.mono`——**保持这个做法，但字体细节仍由你定**（handoff 把等宽留作设计自由）。

**一条健壮性提醒（非具体 bug）**：round-1 已给侧栏 nav label 加了 `white-space:nowrap` 防中文竖排成单字。**把同样的 nowrap + min-width + 溢出兜底，覆盖到所有内容区/metadata/badge 行**（KPI foot、ThreadCard sub、知识树的「N 错」+mesh badge 行、收件箱 lane label 等），免得它们在平板中宽下也竖排崩掉。

---

## 2. 逐屏（round-2a）

> 每屏格式：**round-1 现状 → 契约要求 → 本轮做什么（保留/替换/新增/修）**。视觉外观一律保留。

### A · 今日 `/today`

**round-1 现状**（`screen-today.jsx` + `data.jsx`）：LoomHero（日期 eyebrow + 「开始今日复习」+「问问 Copilot」两个 CTA）、4 个 KPI、3 个 ThreadCard、本周编织热力图(WeekHeat)、活动流(timeline)。

**契约要求**（handoff §3A）：Header（标题 + meta 行 `TODAY · 2026-06-02 · phase 1c` + 一句产品口吻副标 + 动作 `打开 Copilot / 刷新 / 录入`）、**4 KPI**、**活动会话条**、**AI 改动 24h 撤销条**、**提议收件箱条**、**三 lane**、**成本条**。

**本轮做什么**：
- **保留** hero 的织/三缕线视觉、热力图（你的发挥，留着无妨）。
- **替换 · KPI**：round-1 的 4 个是**错的四个**（今日待复习 38 / 连续学习 64天 / 记忆留存率 91% / 今日专注 47分——没一个在契约里）。**整组换成契约四 KPI**，每个可点跳转：
  - `FSRS · 到期` → **12**（→`/review`）
  - `错题 · 待归因` → **3** · "attempt:failure 无 judge"（→`/mistakes`）
  - `AI 提议 · 待审` → **9** · "block_merge 2 · knowledge_edge 3 · note_update 4"（→`/inbox`）
  - `知识点` → **48** · "tree + mesh"（→`/knowledge`）
- **替换 · 三缕线内容**：round-1 是 复习/录入/收件箱；**契约三 lane 是**：A `复习队列·FSRS`（badge 12 到期，CTA 开始 review_session →`/review`）· B `学习意图`（badge 5 在途，CTA 打开 →`/learning-items`）· C `Coach·周度报表`（badge 7d，CTA 查看 →`/coach`）。织的视觉留着，内容换成这三条。
- **新增 · 活动会话条**：可续/被中断的复习会话。例「`review · started · 已复习 7 · again1/hard2/good4 · 14m · 物理·圆周运动`」带 **Resume →**；被遗弃的带 **恢复**。空态「没有进行中的复习会话。」（round-1 完全没有。）
- **新增 · AI 改动 24h 撤销条**（产品灵魂："人可回滚 AI"）：近 24h AI 对笔记/artifact 的改动，每条带 provenance + **撤销**。例「`dreaming 改了 artifact · 3 ops · +1 block · v4→v5 · 2h 前` [撤销]」。空态「过去 24 小时没有 AI 改动。」（round-1 的 timeline 活动流接近但**没有撤销动作**——要么给 AI-caused 条目加撤销把它升级成这条，要么单列一条；撤销必须在。）
- **新增 · 提议收件箱条**：今日待审总数 + 按 kind 拆分（`9 待审 = block_merge 2 · knowledge_edge 3 · note_update 4`）→`/inbox`。作为一条可点的 strip，与上面 KPI 那格的数字呼应、但别和 KPI 重复堆两遍同样信息。
- **新增 · 成本条**（**净新建，round-1 今日屏没有任何成本元素**）：今日 AI 花费 vs $5 预算，例 **$1.84 / $5.00** + per-task 拆分（`dreaming $0.71 · vision_extract $0.52 · …`）+ tokens in/out + tool calls。弱化但清晰，含 loading + error 态。
- **修 · header 动作**：hero 现在只有「开始今日复习/问问 Copilot」；契约要 `刷新` + `录入`（Copilot 已在）——补上。

### C · 复习 `/review` —— 功能缺口最大

**round-1 现状**（`screen-review.jsx`）：直接「显示答案 → 评分」的裸 flashcard；reveal 后显示参考答案 `c.a` + FSRS pills（稳定度/难度/可提取性）+ 4 个评分按钮（含 easy）；键盘 = 空格/Enter 翻面 + 1~4 评分；**有一个做好的"复习完成"终态卡**（`今日复习已织完` + 张数/留存 delta/用时/明日到期 + CTA 回今日/看错题）。

**契约要求**（handoff §3C）：两段式——**作答态**（题面 + 自由文本作答框 + reveal + skip）；**反馈态**（用户答 vs 参考答案对照 split、错因归因、attempt 时间线、AI 判定、评分建议）。键盘 `Ctrl/Cmd+Enter` reveal · `s` skip · `1/2/3` rate · `a` advice。会话生命周期（进入即创建/tab 隐藏即关/URL 带 id 可恢复/可暂停）。

**本轮做什么**：
- **保留** 卡片外壳 + 翻面动效 + FSRS pills + **复习完成终态卡**（重新皮肤化即可，**别删**）。
- **保留 · 真实后端字段**：FSRS stat 行（`稳定度/难度/可提取性` + `due`，`data.jsx:32`）和每个评分按钮的"下次间隔"预览（`when`）——这些是真后端字段，折进新的反馈面板里，别丢。
- **新增 · 作答态**：题面 + 一个**自由文本作答框**（用户先打字答）+ reveal + **skip**。注意：**round-1 完全没有输入框、数据里也没有"用户答案"字段**——作答框要把用户输入**留存**带进反馈态。
- **新增 · 反馈态**：用户答 vs 参考答案**对照 split**（左用户答、右参考 `a`）、错误的**归因/错因**、一条 **attempt 时间线**、**AI 判定结果**、**评分建议(advisor)**；然后评 again/hard/good。
- **修 · 三档**：删 easy（§1.2 的四处全清）。
- **修 · 键盘**：从 空格/1-4 改成契约 `Ctrl/Cmd+Enter` reveal · `s` skip · `1/2/3` rate · `a` advice；reveal 提示文案同步改。
- **新增 · 会话态**：设计"已暂停/可恢复"态（进入即创建、tab 隐藏即关、URL 带 session id 可恢复）。
- 样例（沿用你的文言样例，保持真实密度）：头部 `7/38 · 逾期 12 · deck 文言虚词 · k_xuci_zhi`；作答框 → reveal 后判定面板：错因「混淆『之·定语助词』与『之·代词』」、attempt 时间线（2 次历史）、AI 判定「部分正确」、建议「建议 hard」。

### B · 录入 `/record`

**round-1 现状**（`screen-record.jsx`）：4 个录入来源卡（粘贴文本/拍照 OCR/语音口述/导入链接）+ 一个草稿「报任安书」→「AI 抽取知识点」动画列表；底部一个「自动入队（即将上线）OC-5」的 EmptyState。有 loading（抽取骨架）+ empty，但**无 error 态**。

**契约要求**（handoff §3B）：mode tabs `context / manual / vision_single / vision_paper`；manual 错题表单；vision 拍照/文档 → 抽取 → 确认步；`(new) auto_enrolled` 复审 surface（列 AI 自动/拟录入项：route · confidence · suggested knowledge，每项带 revert）；AI 路由块的确认步把建议知识 + 草稿(outcome/difficulty/cause)作可编辑预填。Loading/empty/**error** throughout。

**本轮做什么**：
- **保留** 来源卡 + 草稿→抽取动画（≈ vision 路径）。注意"来源"和"mode"是两个轴：来源卡是粘贴/拍照/语音/链接；mode 是下面四类。
- **新增 · mode tabs**：`context / manual / vision_single / vision_paper`。
  - **context（学习记录）**：录 `疑问 / 顿悟 / 反思 / 资料` 类记录 + **知识点选择器**。
  - **manual（错题录入）**：表单 `题型 · 题面 · 参考答案 · 错答 · 难度(slider 1-5) · 知识点(多选) · 错因(多选)`。**这条路整块缺失，加上**（字段已和后端 `mistake_enroll` schema 对齐：difficulty int 1-5 + outcome + cause）。
  - **vision_single**（单题拍照）vs **vision_paper**（整页/多题文档）：两者都要有相机/文档录入入口喂给抽取；你的抽取流 ≈ 这条，**补一个抽取确认步**（提交前确认 AI 抽出的 question block）。
- **替换 · auto_enrolled（重要纠正）**：round-1 把它做成了「即将上线」占位——**不对，要真建这个复审 surface**。后端机制已在（`runAutoEnrollForSession` + `POST /api/ingestion/[id]/revert` + `revert-auto-enroll.ts`，YUK-145/OC-5）。建成：列出 AI 自动/拟录入项，每行 `route · confidence(等宽) · 建议知识点`，每项一个 **撤销/revert** 控件，含 loading/empty/error。
  - **但要注意当前生产是 observe-only**（`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` 默认 OFF = 只观察、不写域行、块全留 draft）——所以**空态/observe 态是当前最常见的真实态**，要设计一个有意义的空态（"AI 正在观察，尚未自动录入"），但 populated 列表 + revert 必须设计出来（数据形状与 revert 路径都是真的）。
- **新增 · error 态**：抽取/录入失败 + 重试（round-1 只有 loading+empty）。

### H · 收件箱 `/inbox`

**round-1 现状**（`screen-mistakes.jsx` 的 `ScreenInbox`）：3 条 lane（`KIND_META`：`knowledge_edge / review_enroll / mistake_link`）、ProposalCard（AI·from / title / body / actions / 置信度 / 成本）、`全部接受/全部忽略` 批量、汇总条；只有 empty 态。

**契约要求**（handoff §3H + §1）：按 **12 类 kind** 分组（`knowledge_node · knowledge_edge · knowledge_mutation · learning_item · note_update · variant_question · record_promotion · record_links · completion · relearn · goal_scope · block_merge`(新)）；每卡：提议改动 + **证据回链(→来源 event/record)** + 决策控件 `接受/忽略` + kind 专属（边：`改方向/改关系类型`；部分：`撤回`）；`block_merge` 预览 primary + 待并入块 + 连续性理由；按证据记录过滤。

**本轮做什么**：
- **保留** lane 分组结构 + ProposalCard 的 置信度/成本。
- **替换 · kind**：round-1 三条 lane 里**只有 `knowledge_edge` 是契约真 kind**；`review_enroll` 与 `mistake_link` 不是 12 类里的，**换成契约真 kind**（如 `note_update / block_merge / knowledge_node` 等）。卡片框架做成能渲染各 kind（不必 12 套独立视觉，但 lane/标签要反映真实 kind）。
- **新增 · 证据回链（净新增，round-1 没有）**：每卡加一个可见的「→ 来源 event/record」链接。`data.jsx` 的 proposals 当前**没有 evidence/source 字段**——这要**在 §3 标为一处数据形状改动**，别假设已有。
- **新增 · `block_merge`**（特别标注，新，YUK-202）：AI 提议把两个其实是同一道被拆开的题的录入块合并。卡片**预览 primary 块 + 待并入块**，给一条**连续性理由**（"题干在 A 块、解析在 B 块"；"(1)(2) 跨块续写"；"承接前题"）。
- **新增** 按证据记录过滤（只看挂在某条 evidence 上的提议）。
- **新增 · loading/error 态**（round-1 只有 empty）：lane 骨架 + 提议加载失败+重试。
- **收敛 · 批量**：round-1 的 `全部接受/全部忽略` 是它自己加的、不在契约里，且一键群接受 evidence-backed 提议**与"AI 提议、人逐条裁决"原则相悖**。要么去掉「全部接受」，要么把批量收敛（限定在某置信度阈值内，或改成"先选再批"流程）。样例：9 条待审 = block_merge 2 · knowledge_edge 3 · note_update 4。

### E · 错题 `/mistakes`

**round-1 现状**（`screen-mistakes.jsx` 的 `ScreenMistakes` + `data.jsx:81-85`）：**count 聚合卡**（`{ q, wrong, right, deck, count, last, tone }`，渲染「N 次错」）；每卡只有一个 `deck` 来源 badge（文言虚词/史记选读/廉颇蔺相如）；**无归因、无知识点 badge、无纠错状态、无事件链**；直接 map，无 loading/empty/error。

**契约要求**（handoff §3E）：错题以**单条记录**为卡——题面 · 错答 · **知识点 badges** · **归因(AI-caused vs user-caused**，含瞬时"归因中…"态) · **纠错状态**；内联可展开事件链（event-sourced，`caused_by` 串联）；跳 `/events/[id]` 链接。

**本轮做什么**：
- **flag · 数据形状（按 §3 标出，别默认沿用）**：round-1 是 count 聚合卡，契约是逐条 attempt:failure 事件（per-event 的 `caused_by` 因果链套不进聚合计数）。claude design 要明确每张卡是**一条错题**还是聚合——倾向按契约做成单条记录卡：内容 = 题面 / 错答 / 知识点 badges / 归因 / 纠错状态。
- **新增 · 知识点 badges**：round-1 只有一个 `deck`（来源/分类）badge，**那不是知识点 badge**。加**知识点 badges（可多个，链入知识图）**，与 deck 标签区分开。
- **新增 · 归因**：AI-caused vs user-caused（含瞬时"归因中…"pending 态），带非颜色线索。
- **新增 · 纠错状态** + **内联可展开事件链**（展开内联显示纠错/因果链）；一个跳完整事件页 `/events/[id]` 的链接——但**事件页本身是 round-2b**，本轮该链接先 stub。
- **新增 · loading/error 态**（round-1 两态全无）：list 骨架 + 拉取失败态。空态 CTA → `/record`。

---

## 3. 数据形状（消费后端固定形状，不重塑模型）

样例反映真实形状。**本轮有两处布局会触及数据形状，标出来、别擅自假设**：
1. **收件箱证据回链**：proposals 需要一个 evidence/source 引用字段（round-1 mock 没有）。
2. **错题单事件 vs 聚合**：错题卡要承载 per-event 归因 + `caused_by` 链，与 round-1 的 count 聚合形状不同。

若其它布局也需要改数据或路由，**标出来**别擅自改。

## 4. 无障碍（重申 + round-1 实物待修）

全键盘可达；**CopilotDrawer 补 focus trap + restore + Esc 关闭（§1.4，round-1 实缺）**；语义 role/label；FSRS 三档 / 归因 / 关系类型 / 状态都要**非颜色线索**。

---

## 5. 本轮**不要**建（round-2b）

以下保持现状 / stub，**这一轮别碰**：

- 知识：节点详情抽屉 + 可平移/缩放交互 mesh + 5 类 typed 关系 + 每节点掌握度 + `/knowledge/[id]`
- 学习项：意图→拆解流程 + 状态 tabs + `/learning-items/[id]`（origin-proposal+retract、父节点选择器、artifact 视图、children、teaching 抽屉）
- **block-tree 笔记编辑器**（slash/drag/cross-link/quiz-block/verification/LaTeX）——现在的 textarea 暂时够用
- `/coach` 分析 · `/learning-sessions` 列表+详情 · `/events/[id]` 事件页 · `/admin/*`
- TeachingDrawer（超出现有图标 stub 的部分）

> 提醒：今日的 C lane 指向 `/coach`、错题卡指向 `/events/[id]`——这两个目标页是 2b，本轮**链接先占位**，别因为要补链接就把目标页一起建了。

---

## 6. 交回

照旧——更新后的原型（或屏规格），覆盖 round-2a 这几屏的 desktop + mobile、light + dark，用真实样例数据，含 loading/empty/error。标注任何新的 state/交互细节、以及上面 §3 两处数据形状改动。Claude Code 会 slice-by-slice 落地到 Next.js + React + Tailwind v4。

---

*视觉是你的、且已认可——本稿只补功能、修契约、纠正 round-1 与契约不符的内容语义。*
