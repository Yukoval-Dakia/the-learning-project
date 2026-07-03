# Cold-Start First-Session UI — 功能 Design Handoff（2026-06-21）

> **给 claude design 的功能 handoff**（记忆 `feedback_claude_design_workflow`）：本文只给 **WHAT**（每屏干什么、显示什么数据形状+sample、交互、状态、硬契约=路由/数据/行为/无障碍）。**视觉全交给你**——palette / 字体 / 间距 / 动效 / 密度 / 图标 / 明暗一律你定。
>
> **构建于既有 loom 设计系统**：`docs/design/loom-design-v2.1`（tokens / primitives / HANDOFF.md）是当前设计系统；`docs/design/loom-prototype` 有稳态屏（today / practice / review / **record** / mistakes / knowledge / coach …）。**本 handoff 的屏是冷启首会流——prototype 里 ABSENT 的部分**。沿用 v2.1 的 tokens/primitives + 与既有 `screen-today` / `screen-record` 视觉连续。
>
> 上游：`docs/design/2026-06-20-cold-start-day-one-design.md` §2（第一天旅程）+ §6 七问（owner 锁定）。后端**已全部落地**（见下每屏的「数据契约」）。

## 0. 背景：为什么需要这些屏

冷库新用户（`goal` + `learning_item` + `mastery_state` 三表皆空）今天**直撞空 `/today`**。day-one 后端链路已通（上传→抽题→建KC→生成答案→active / goal 直写 / placement 引擎 / θ̂·FSRS·judge 全 live），**就差把它串成能点的首会流**。本 handoff = 这条流的 4 个新屏 + 1 个复用屏（record）。

**流程**：冷库 `/today` → **① Welcome/Setup** →（分叉）**②a 上传材料**（复用 `screen-record`）/ **②b 从起始集开始** → **③ Placement 作答环** → **④ 起始档案露出** → 进入稳态 `/today`。

视觉连续性要求：这是用户**第一次见到产品**的流——比稳态屏更需要「轻、引导、不吓人」。空/错/加载态是一等公民（冷启全是「还没有数据」的态）。

---

## 屏 ① Welcome / Setup（NEW route，建议 `/welcome` 或 `/setup`）

**干什么**：冷库落地的第一屏。问两件事 →（轻）自述 +（核心）「你想学什么」。

**显示**：
- 欢迎语 + 一句话产品意图（占位文案，你可改：「带上你的材料，我为你备一套个人化的练习」）。
- **自述（§6 Q1，轻）**：一个粗粒度阶段选择，如「高中 / 初中 / 大学 / 自定义」+ 可选学科倾向。**非长问卷**——一两个选择即可。
- **目标输入**：自由文本「你想学什么？」+ 可选 subject 提示 chip（数学 / 物理 / 文言文 …，来自支持的 subject 列表）。
- **分叉 CTA**：「上传我的材料」（→ ②a）/「从起始集开始」（→ ②b）。

**数据契约**：
- 支持的 subject 列表：`['wenyan','math','physics']`（`KNOWN_SUBJECT_IDS`）+ 各自 displayName（如「文言文」「数学」「物理」）。subject 是**视角不是必选**——目标可跨科。
- 提交目标 → `POST /api/goals`，body `{ title: string, subjectId?: string|null, knowledgeIds?: string[] }` → 200 `{ id, title, subjectId, scopeKnowledgeIds: string[], status:'active' }`。（`scopeKnowledgeIds` = 这个目标圈定的 KG 子图 = placement 走的范围。）
- 自述目前**不落库**（轻引导用；未来可喂 θ 先验）——UI 收集即可，提交时不强制后端字段。

**状态**：首次（全空，默认态）。无加载（纯输入）。提交失败（400，如目标无法解析 scope）→ 行内错误 + 重试。

**a11y**：键盘可走完；目标输入有 label；分叉 CTA 是两个明确按钮非隐藏手势。

---

## 屏 ②a 上传材料（复用既有 `screen-record` + 冷启语境包装）

**干什么**：用户带自己的错题本 / 卷子 / 课本题 → 上传 → 抽题（OCR 默认 / VLM 兜底）→ 自动入池。**这是 day-one 主内容路。**

**复用**：`docs/design/loom-prototype/screen-record.jsx` 已是录入屏——本 handoff **不重设计录入本体**，只要 claude design 给冷启语境的**包装/引导态**（首会第一次上传比稳态多一层「这是在为你建题库」的解释 + 完成后「→ 去做定位练习」的衔接 CTA）。

**数据契约**（后端已建，U-bridge YUK-478）：
- 上传 → ingestion 管道：`POST /api/ingestion`（建会话）→ `POST /api/ingestion/pdf|docx` 或 assets multipart → `POST /api/ingestion/[id]/extract`。
- **进度**：`GET /api/ingestion/[id]/events`（SSE）——抽题进度逐条推。UI 显示进度（「抽到 N 题…」）。
- 抽出题后端自动：LLM 分类 subject + 在科目根下建子 KC + tag + （OCR 没答案则）AI 生成参考答案 + 结构校验过自动 active。**UI 无需处理这些**——只需展示「抽到 N 题、已就绪」+ 衔接到 ③。
- 完成信号：抽题落库 active；UI 可轮询 `GET /api/ingestion/[id]/blocks` 看结果或据 SSE 终止事件。

**状态**：上传中（进度）· 抽题中（SSE 进度，**可能慢**，要有耐心态/预估）· 完成（N 题就绪 + CTA）· 失败/无法抽题（兜底文案 + 重试或转 ②b）· **冷子图无题**（抽不出 → 提示可换材料或走起始集）。

**a11y**：上传支持文件选择（非仅拖拽）；进度有文字态非仅动画；SSE 断线有重连/兜底。

---

## 屏 ②b 从起始集开始（轻分支）

**干什么**：没材料可传的用户 → 直接用 subject 起始集走 placement（兜底路径）。

**显示**：极简——确认 subject/goal（来自 ① 的 goal）→ 直接进 ③ placement。若该 subject 子图当前无题（薄 seed 只有科目根、还没题），提示「正在为你准备起始题」（后端 nightly quiz_gen / 按需生成）+ 可稍后再来。

**数据契约**：goal 已由 ① 创建（`scopeKnowledgeIds` 在）→ 直接 `POST /api/placement/start`（见 ③）。`sourcingNeeded:true` 表示子图冷、需供题。

---

## 屏 ③ Placement 作答环（NEW route，建议 `/placement` 或会话内 `/placement/:id`）

**干什么**：有界的第一会话——逐题作答，judge+θ̂+FSRS 在线收紧画像，到 cap 或收敛即止。**这是从「什么都没有」走到「画像落地」的核心交互。**

**显示**（每题）：
- 进度：「第 k / 最多 N 题」（**N = 每科 8 题固定 cap，§6 Q1**）。**有界感**很重要——用户要知道这是短的、会结束的。
- 题干（`prompt_md`，markdown）+ 按题型的作答区：
  - 客观题（`true_false` / `single_choice` / `multiple_choice`）→ 选项；
  - 开放题（`short_answer` / `translation` / `reading` / `essay`）→ 文本输入（+ 可选图片作答，沿用既有作答组件）。
  - 题型来自 question.kind（8 值闭集，正交化后 = 结构轴 + answer-class）。
- 作答后：判分反馈（对/错/部分 + 可选 judge 反馈），然后「下一题」。可设「即时反馈」或「攒到末尾」——冷启建议**即时**（首会要即时正反馈建立信心）。

**数据契约**（后端已建，inc-B YUK-468 + 硬化 YUK-470）：
- **起始**：`POST /api/placement/start`，body `{ goalId?: string|null, knowledgeIds?: string[] }` → 200 `{ sessionId, knowledgeIds, question: PlacementSelection|null, sourcingNeeded: boolean }`。
  - `PlacementSelection` ≈ `{ questionId, kind, scoreKind }`（选中题的标识 + 题型；题干等内容据 questionId 取 question 详情渲染）。
  - `question === null` + `sourcingNeeded:true` → 子图冷、没题：显示「备题中」态（②b 同源）。
- **作答**：复用**既有** `POST /api/review/submit`，body 携 `session_id = <该 probe>` + `activity_ref:{kind:'question', id:questionId}` + 作答内容（+ `latency_ms` 计时）→ judge + θ̂ + FSRS 全在这条跑（**placement 不另建 submit**）。
- **下一题 / 终止**：`POST /api/placement/[id]/next`，body `{ knowledgeIds, cap?, seThreshold? }` → `{ done: boolean, reason?: 'cap'|'se_converged', question?: PlacementSelection|null, answeredCount: number, sourcingNeeded?: boolean }`。`done:true` → 收束到 ④。
- **收尾**：`POST /api/placement/[id]/end`，body `{ status?:'completed'|'abandoned' }`（正常完成 / 中途退走；sendBeacon 容错）。

**交互协议**（重要）：**答一题 → 提交（/review/submit）→ 调 /next → 渲染下一题或 done**。/next 已做并发锁 + 服务端 scope 持久化（client 不必每次传完整 knowledgeIds，但 API 仍接受）。

**状态**：加载首题 · 答题中 · 判分中（judge 可能几秒）· 下一题 · **done（cap 到 / SE 收敛）→ ④** · 中途退走（end abandoned）· **备题中**（sourcingNeeded，题没生成好）· judge 失败（降级/重试）。

**a11y**：键盘作答（选项 + 提交）；进度对读屏可见；判分反馈非仅颜色（文字 + 图标）。

---

## 屏 ④ 起始档案露出（NEW，建议 `/profile` 或会话末嵌入 + 入 `/today`）

**干什么**：placement 后给用户看「我们现在怎么看你」——per-KC 能力/掌握画像，**带可见的不确定性**（这是冷启诚实性的核心：先验质量有限，必须把不确定摆出来，不假装精确）。

**显示**：
- 每个 placement 触及的 KC：名称 + **掌握/能力指示**（θ̂ → 一个直觉化的水平指示，你定如何视觉化：进度/段位/热度均可）+ **不确定带**（`mastery_lo` / `mastery_hi` 区间 + `low_confidence` 标志）。**不确定性必须显眼**——冷启大多 `low_confidence:true`（precision 低、SE 大）。
- 一句话叙述（可选，占位）：「基于你的 N 道答题，初步看到…（带『还需更多练习确认』的诚实限定）」。
- CTA：「开始日常练习」→ 进稳态 `/today`（此时 /today 不再空）。

**数据契约**（后端 compute 全 live，P4 = 露出层）：
- per-KC：`mastery_state` 行 → `{ theta_hat, theta_precision, p_l (p learned), mastery_lo, mastery_hi, low_confidence, evidence_count }`。`SE = 1/√theta_precision`；冷启 `precision≈1 → SE≈1 → low_confidence:true`。
- **读端点**：placement 触及的 KC 集 → 各自 mastery_state。（若无现成聚合读 API，实现时加一个 `GET` 读这批 KC 的 mastery——这是本屏要后端补的薄读层；compute 已在，只是露出。）
- **诚实约束（硬）**：θ̂/p(L) 是**带方差的信念**不是分数；UI **绝不**展示成精确百分比/排名而不带不确定带。`low_confidence` 必须有视觉表达。

**状态**：placement 刚完（数据新鲜）· 数据稀疏（只答了几题 → 大不确定带，正常）· 某 KC 无 evidence（冷，显示「未测」而非 0）。

**a11y**：不确定性非仅视觉（文字「低置信」）；能力指示有文字等价。

---

## 跨屏硬契约（claude design 须保留）

1. **路由/流**：冷库 `/today` → welcome → (upload | starter) → placement → profile → 稳态 `/today`。新 route：welcome、placement、profile（record 复用）。
2. **数据形状**：以上每屏「数据契约」的字段名/类型是后端真实形状（已建 API），sample 见各屏。
3. **状态完整**：每屏的空/加载/判分中/失败/「备题中」态都是一等需求（冷启 = 大量「还没数据」态），不可只画 happy path。
4. **不确定性可见**（④ 红线）：先验质量有限是产品诚实性核心，不确定带 + low_confidence 必须有视觉表达。
5. **有界感**（③）：placement 是短的、会结束的（≤8/科）——进度与终止要让用户安心。
6. **视觉/风格全交给你**：构建于 loom-design-v2.1 tokens/primitives，与既有 screen-today/screen-record 连续。本文不规定任何 palette/字体/间距/动效。

## 实现侧（claude design 出稿后，Claude Code 落地）

设计稿回来后 slice-by-slice 实现：每片走 CLAUDE.md design-doc pre-flight（逐字引用稿子段落 + 声明组件类型 + 列 touch 文件，等 owner 批）+ 视觉环（playwright 截图对照稿子）。Linear：U 的 `/record 入 onboarding`（YUK-478 余项）· P1 onboarding（YUK-473）· P3 placement UI + 翻 `PLACEMENT_PROBE_ENABLED`（YUK-475，翻 flag 前先 YUK-479）· P4 profile（YUK-476）。
