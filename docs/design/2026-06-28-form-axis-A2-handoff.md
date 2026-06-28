# 形态轴 A2 · 自主滑块（hint-first 阶梯）—— 功能 handoff（给 claude design）

- **date**: 2026-06-28
- **status**: functional handoff（零风格规定）—— 视觉稿由 claude design (claude.ai/design) 出，回来 slice-by-slice 实现
- **epic**: 形态轴 epic（YUK-354），缺口 A2「自主滑块」
- **gate 出处**: `docs/design/2026-06-15-rethink-implementation-gate.md` §2 第 2 条 —— 「自主滑块『从 hint 滑到完整解』的功能形态（几阶/每阶给什么/逃生口/交还控制）—— **须先给功能规约再交视觉**」
- **构建于**: 既有 loom design 系统 + 现存「解题会话」抽屉（`PfSolo.tsx` `PfCoach`）

> 这是**功能** handoff：只描述自主滑块该让 owner**理解什么、能做什么、每一阶给什么**，**不规定任何视觉风格/布局/配色/组件选型**——那是 claude design 的活。实现回来后按项目 design tokens/primitives 落地。

---

## owner 想解决的问题

练习时卡住，owner 要的不是「点一下直接给答案」（养成依赖、毁掉独立提取的学习价值），也不是「强制苏格拉底、永远不许看答案」（Khanmigo 被诟病的反模式 —— 决策总账 `2026-06-14-product-rethink-decisions-ledger.md`:106）。

owner 要的是**一个自己掌控出手档位的滑块**：默认 **hint-first**（先给最轻的提示），不够再要下一阶、再下一阶，**逐级逼近**；任何时刻都能**一次性滑到完整解**（不被关在苏格拉底牢笼里），但「看完整解」**记为非独立完成**（不是免费滑到答案 —— 看了就标记这道题不是你独立做出来的，掌握度按非独立计）。同时每一次「要了几阶提示」要被**留痕**，让系统日后能算「提示依赖度 / 流畅度幻觉」信号（这道题你是真会，还是靠喂提示才做出来的）。

一句话：**把「卡住时给多少帮助」的控制权交给 owner，同时诚实记录帮助用了多少、是否独立完成。**

---

## 现状反模式（锚真代码）

当前练习单题面 `src/capabilities/practice/ui/PfSolo.tsx` 已有一个「解题会话」抽屉 `PfCoach`（lines 540-645），由顶部「卡住了？解题会话」按钮（line 320-322）触发。它**已经是递进 hint 的雏形**，但形态不到位：

1. **递进是「无级裸数字」，不是「分阶有语义」**。`PfCoach.nextHint()`（lines 565-581）每点一次就 `solveHint(question.id, sid, hints.length)`，把 `hints.length` 当 `hintIndex` 递增。后端 `planSolveHint`（`src/capabilities/practice/server/solve-session.ts`:200-236）的提示词只是按 index 泛泛升级——`buildSolveHintInput`（:141-163）第 0 阶发「给我一个不剧透答案的最小提示」，之后每阶都发同一句「还是不会，给下一个更具体的提示（第 N 个）」。**没有「元认知 / 方向 / 概念 / 错因 / 部分示范 / 完整解」这种每阶语义分层**——只有「再具体一点」的线性加压。owner 看不到自己在阶梯的哪一档、下一档会给什么。

2. **没有「看完整解」出口**。抽屉里唯一的动作是「再提示一点」（`PfSolo.tsx`:623-636），上限 `MAX_HINT_INDEX=20`（`src/core/schema/event/known.ts`:26）撞顶后只显示「提示用完了。回到题面把你的思路写进作答框试试。」（:638）。**完整解从不在解题会话里出现**——它只在用户**提交作答后**经判分流回显（`solve-session.ts`:448 `revealed_solution_md`，且那是 `solve-submit` 路径，PfSolo 主流走的是 `review/submit`，根本不经过它）。所以现状下「滑到完整解」这个 owner 明确要的能力**完全不存在**。

3. **没有「交还控制」/「非独立」标记**。看了帮助之后，作答仍按完全独立判分，**没有任何「这道题用了帮助 / 看了完整解 = 非独立完成」的语义**。owner 要的「完整解标非独立完成」无落点。

4. **提示计数在 solo 主流被丢弃**（基础设施缺口，详见末尾）。`PfCoach` 数着 `hints.length`，但 PfSolo 的 `commit()`（:172-232）调 `submitReview`（`practice-api.ts`:303-321）**不携带 `hints_used` / `final_hint_level`**。只有另一条 `solve-submit` 路径（`api/solve-submit.ts`:27-50）串了这两个字段。结果：YUK-352 想留痕的「提示依赖度」信号，在真实的散题练习流里**根本没采到**。

> 反模式总结：现状是「无级线性加压 + 无完整解出口 + 无非独立标记 + 计数在主流丢失」。A2 要把它升级成「**分阶有语义的滑块 + 可控的完整解逃生口 + 非独立标记 + 计数真留痕**」。

---

## 推荐阶梯设计（**待 owner 拍** —— gate §7 / 决策总账 §5 未定稿）

> **这是 A2 唯一悬而未决的产品决策**，必须 owner 在出视觉稿**前**拍定。决策总账有**内部张力**，handoff 须如实标出：
> - `2026-06-14-product-rethink-decisions-ledger.md`:168（§6 gap 裁定）**倾向「GPT H0-H5 全 6 阶」**：元认知 / 方向 / 概念 / 错因 / 部分示范 / 完整解（完整解标非独立完成）。
> - 但同文档 :154（§5 未拍清单）仍把「自主滑块提示具体形态（几阶递进）」列为**未定**。
> - synthesis 系列（`2026-06-14-product-rethink-phase2-synthesis.md`:407、synthesis-lanes:979/1149）**建议「3 阶 v0」**（方向提示 / 关键步骤 / 完整解），埋 revert/escalate 率后再调。
>
> 即：owner 最新一次表态偏 6 阶，但工程 synthesis 建议先上 3 阶 v0。**这道题留给 owner 拍**。下面给两套都成立的功能规约，owner 选一套（或微调），claude design 据此出稿。

### 共同的阶梯不变式（无论几阶，都成立）

- **单调递进**：每阶比上一阶更接近答案。owner 永远只能往下一阶走，**不能跳级**（要看完整解 = 直接走逃生口，见下节，是显式独立动作，不是「滑到底」）。
- **每阶都是「按需召唤」**：默认只显示当前能要的下一阶按钮，不预先铺开所有阶（防剧透）。
- **当前位置可见**：owner 任何时刻看得出「我在第几阶 / 共几阶 / 下一阶大概给什么性质的帮助」（不是给具体内容预览，是给**性质标签**，如「下一阶：指方向」）。
- **每阶内容 AI 实时生成**（非静态预存）：基于题面 + 参考解，按阶的「性质」生成该阶帮助（现有 `TeachingTurnTask` 链已是此形态，只是缺分阶语义）。
- **逐阶留痕**：要到第几阶必须被记录（`hints_used` / `final_hint_level`），见数据契约。

### 方案 A（owner §6 倾向）—— 6 阶 H0-H5

| 阶 | 名 | 给什么（性质，非具体内容） | 独立性 |
|---|---|---|---|
| H0 | 元认知 | 不碰题目内容，问「你卡在哪一步 / 先想想这类题一般怎么下手」 | 独立 |
| H1 | 方向 | 指一个大方向 / 该调用哪块知识，不给具体步骤 | 独立 |
| H2 | 概念 | 点明关键概念 / 定理 / 公式，仍不代入本题 | 独立 |
| H3 | 错因 | 针对 owner 当前思路指出卡点 / 常见误区（需 owner 已写了部分思路才有料） | 独立 |
| H4 | 部分示范 | 演示第一步 / 关键一步怎么做，留剩下给 owner | **半独立**（建议标记，owner 拍） |
| H5 | 完整解 | 完整解答（= 逃生口的「看完整解」） | **非独立** |

### 方案 B（synthesis 建议）—— 3 阶 v0

| 阶 | 名 | 给什么 | 独立性 |
|---|---|---|---|
| L0 | 方向提示 | 指方向 / 调哪块知识 | 独立 |
| L1 | 关键步骤 | 点关键步骤 / 概念，演示一步 | 独立 |
| L2 | 完整解 | 完整解答（= 看完整解） | **非独立** |

> 两套都把**最后一阶 = 完整解**，且**完整解 = 非独立**。差别只在中间分得多细。owner 拍。建议：若拿不准，按 synthesis 上 **3 阶 v0**，先采 revert/escalate 率数据再决定要不要细分到 6 阶（B2 标 known-limitation，synthesis:476）。

---

## 逃生口 + 交还控制 + 「看完整解 = 非独立」（显式功能约束）

这三件是 gate §2 A2 点名要规约的，**单列**：

1. **逃生口（escape hatch）= 任意阶都能一步看完整解**。owner 不必逐阶点到底——阶梯面上**始终有一个独立的「直接看完整解」入口**（与「再要一阶提示」并列）。点它 = 直接跳到末阶（完整解），跳过中间所有阶。这是**防 Khanmigo 强制苏格拉底**的核心保证：owner 永远不被关在「只能一阶一阶挪」的牢笼里。

2. **「看完整解」是非独立动作，须二次确认其后果**。点「看完整解」**不是免费滑到答案**：它会把这道题标记为**非独立完成**（影响掌握度 credit）。功能约束：点击时须让 owner**清楚知道**「看了 = 这题记为非独立」（视觉如何呈现交 claude design，但**语义必须传达**，不能让 owner 以为白嫖）。owner 确认后才展示完整解。

3. **「交还控制」= 看完/用完帮助后，控制权回到 owner 手里继续作答**。不是看了完整解就强制结束这道题——owner 可以：
   - 看了帮助后**回到作答框自己写**（独立性按用了第几阶帮助记，见数据契约）；
   - 或看了完整解后**直接进入下一题**（这题记为非独立完成）。
   阶梯帮助是**叠加在作答流之上的可选层**，不抢走作答主权（现状 `PfCoach` 抽屉「会话不计入判分」的隔离感是对的方向，但缺「帮助用量回灌作答判定」的连接）。

4. **独立性分级映射**（功能语义，owner 可微调）：
   - 没要任何帮助（`hints_used=0`）→ **完全独立**。
   - 要到「独立」阶（H0-H3 / L0-L1）→ 仍算**独立完成**，但留痕「用了 N 阶提示」（提示依赖度信号）。
   - 看了「部分示范」阶（H4，若采方案 A）→ **半独立**（建议标记，owner 拍是否单列此档）。
   - 看了「完整解」（末阶）→ **非独立完成**。

---

## 数据契约（wire 形状 + 真实字段，no-mock）

A2 复用既有 solve 链 + review 提交链。**所有 endpoint 已存在**，缺的只是「分阶语义 + 完整解出口 + 计数回灌主流」（见基础设施缺口）。

### 启动解题会话
`POST /api/questions/:id/solve` → `{ session_id, generated, generation_error }`
（`practice-api.ts`:328-332；`generated`=本次懒生成了参考解，`generation_error`=生成失败降级态）

### 要一阶提示
`POST /api/questions/:id/solve/:sid/hint`，body `{ hint_index: number }`（0-based，cap 在 `MAX_HINT_INDEX=20`）
→ `{ text_md: string }`（该阶提示的 markdown 正文；`practice-api.ts`:334-338）

真实返回 sample（现状无级 hint，第 0 阶）：
```json
{ "text_md": "先别急着算。这道题给的是『匀变速直线运动』，先问自己：题目给了哪几个已知量？它们分别对应运动学公式里的哪个符号？" }
```

> **缺口**：`hint` route 当前**不接受「阶语义/阶名」参数**，也**不返回「当前第几阶/共几阶/下一阶性质」**。A2 的分阶要么前端按 `hint_index` 映射阶名（轻量，前端定 ladder 表），要么后端 route 扩参（重，基础设施 issue）。推荐**前端持 ladder 定义**（阶数/阶名/阶性质标签是产品配置，不必进后端），`hint_index` 仍是唯一与后端的接口量。

### 提交作答（含帮助用量留痕）
`POST /api/review/submit`，现有 body（`practice-api.ts`:303-321）携带 `question_id` / `rating` / `response_md` / `referenced_knowledge_ids` / `stream_item_id?` / `auto_rate?` / `latency_ms?`。

**A2 要新增的字段**（功能契约，需后端接线 —— 见基础设施缺口）：
- `hints_used?: number` —— 本题要到第几阶提示（0 = 没要）。schema 已定义在事件层（`src/core/schema/event/known.ts`:88，`AttemptOnQuestion.payload.hints_used`，cap `MAX_HINT_INDEX`）。
- `final_hint_level?: number` —— 达到的最高阶（同上 :89）。
- `independence?: 'independent' | 'semi' | 'non_independent'`（**新语义，owner 拍命名**）—— 由「看了第几阶」推导出的独立性标记。**当前 schema 无此字段**，是 A2 引入的新留痕维度。

> 现状证据：solo 路径的 `review/submit` body **完全没有** hint 相关字段；只有 `solve-submit` 路径（`api/solve-submit.ts`:27-50）串了 `hints_used`/`final_hint_level`。所以「分阶 + 完整解 + 非独立」要真正落数据，**必须给 `review/submit` 接上这几个字段**（不是新建表，是给现有 attempt payload 补已在 schema 定义好的字段 + 一个新 independence 维度）。

---

## 空态 / 失信兜底 / 故障态（显式功能约束）

每条都是**功能约束**（决策总账 §6②「故障态治理」把退化形态列为每个 deliverable 必备项）：

1. **参考解未就绪 / 懒生成失败**（`solve` 返回 `generation_error=true` 或 `generated=false` 且无既存参考解）：
   - 阶梯**仍可起跑前几阶**（元认知/方向阶不依赖完整参考解），但「看完整解」逃生口**必须显式置不可用**并说明「这道题暂时没有可展示的完整解（自动生成失败）」——**不能给一个点了没反应的死按钮，也不能假装有完整解**。owner 看得出是「暂时没有」而非「系统坏了」。

2. **某一阶 hint 生成失败 / 超时**（`hint` route 返回 502 `upstream_error` / `llm_parse_failed`，见 `solve-hint.ts`:34-36，或网络超时）：
   - 当前阶显示**可重试**的失败态（「这一阶提示没生成出来，再试一次？」），**不静默吞**、**不自动跳到下一阶**（跳级会破坏单调递进语义）。owner 可重试本阶或直接走逃生口看完整解。

3. **滑到末阶仍不会**（要到完整解、看了，还是不懂）：
   - 末阶（完整解）之后**不是死路**。须有「仍不懂」的去向——建议接通既有的「解题会话」苏格拉底追问（继续对话）或「标记为错题 + 进复习」。**功能约束**：完整解不是这道题的终点墙，owner 看完仍能继续追问或把它推进复习闭环（具体接哪条 owner/claude design 定，但**不能让 owner 卡在「看了完整解还是不会」的死胡同**）。

4. **逃生口被滥用（每题都直接看完整解）**：
   - 这是**留痕问题，不是阻拦问题**。**不得**用配额/冷却/弹窗惩罚拦截 owner 看完整解（违反 owner「控制权在我」+「护栏只告知不卡死」原则，见 `feedback_guardrail_warning_vs_hard_limit`）。约束是：**每次看完整解都诚实记为非独立完成**，让「非独立完成率」成为**可观测信号**（owner 自己日后看「我有多少题是直接看答案做的」），驱动 owner 自我调节——而非系统强行限制。视觉上**不羞辱**（不是红色警告/扣分动画），是**中性留痕**。

5. **会话隔离**：解题帮助本身**不计入判分**（现状 `PfCoach`「会话不计入判分」:609 是对的）——帮助内容不进判分上下文，只「用了第几阶」这个**计数**回灌作答的独立性标记。两者分离：帮助是过程，独立性标记是结果。

---

## 不在本缺口范围

- 不改判分/掌握度的**计算**（那是 B1）；A2 只负责「采到 hints_used / independence 信号 + 控制完整解出口」，掌握度怎么吃这些信号是 B1 的事。
- 不做「提示依赖度 / 流畅度幻觉」的**诊断展示面**（那是成效轴/诊断面的后续）；A2 只保证信号被**采集**（YUK-352 的零依赖留痕目标）。
- 不改后端 hint 生成的**提示工程质量**（每阶 prompt 措辞优化是后续）；A2 给的是**分阶骨架 + 出口 + 留痕**，每阶 prompt 内容是增量。

---

## 边界提醒（给实现者，非 claude design）

- 这是**练习单题面内**的交互升级（`PfSolo.tsx`），与 D14 对话面（A3）、流（PfStream）同侧；按既有 practice 面的落地方式接入。
- 动 UI 代码前仍走项目的 design-doc pre-flight；本 handoff + claude design 视觉稿 = pre-flight 的输入。
- 阶梯 ladder 定义（阶数/阶名/阶性质标签）建议作**前端产品配置**，不进后端——后端接口量始终是 `hint_index` 单一数字 + 提交时的 `hints_used`/`final_hint_level`/`independence`。

---

## 基础设施缺口（needs issue）

A2 的「分阶骨架 + 完整解出口」是纯前端 + 既有 endpoint 复用，**无新基础设施**。但有**一条真实的接线缺口**必须开 issue，否则 A2 的留痕语义落不了地：

### 缺口 1（必开）—— solo 练习流的 hint 留痕断链 + independence 新字段

**现状**：`PfSolo` 的解题会话（`PfCoach`）数着 `hints.length`，但 PfSolo 的 `commit()` 走 `review/submit`（`practice-api.ts`:303-321），该 body **不携带 `hints_used` / `final_hint_level`**。只有另一条 `solve-submit` 路径（`api/solve-submit.ts`:27-50）串了它们。结果：YUK-352 想留痕的提示依赖度信号，在**真实散题练习流里被静默丢弃**。同时 A2 新引入的 `independence`（独立/半独立/非独立）**schema 里还没有这个字段**。

**要做**：
1. 给 `review/submit` 的 body schema（`src/server/review/` 的 submit 契约）+ `practice-api.ts` 的 `submitReview` 签名接上 `hints_used` / `final_hint_level`（schema 事件层已定义，`known.ts`:88-89，只是 review 提交路径没透传）。
2. 引入 `independence` 留痕维度（新字段，命名 owner 拍）——写进 attempt event payload，供 B1/诊断后续消费。
3. PfSolo 把 `PfCoach` 的帮助用量（最高阶 + 是否看了完整解）回灌到 `commit()`，提交时带上。

**为何不在 A2 doc 内顺手做**：这是后端 schema/route 接线（review submit 契约 + 新字段 + 事件 payload），跨 UI 边界，且 `independence` 字段命名要 owner 拍——属独立可验收的后端工，不该混进 claude design 视觉实现 lane。

**关联**：YUK-352（hint 留痕，零依赖先做，已注「hint 计数现被丢弃」）—— 本缺口正是 YUK-352 在 solo 流的未竟接线 + A2 的 independence 扩展。建议作 YUK-352 的子工单或紧邻 follow-up。

### 缺口 2（可选 / 押后）—— hint route 是否返回「阶位置元数据」

若 owner 希望「当前第几阶/共几阶/下一阶性质」由**后端权威返回**（而非前端 ladder 表推导），需扩 `hint` route 返回 `{ text_md, stage_index, total_stages, next_stage_kind }`。**推荐不做**（ladder 是产品配置，前端持有更轻，后端接口量保持 `hint_index` 单数字）。仅当后续要让 AI **动态决定阶数**（按题难度变阶梯长度）才需要——押后，标 known-limitation。
