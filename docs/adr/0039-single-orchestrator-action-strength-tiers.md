# ADR-0039 — 单编排者 D14 + 全局出手强度表 A/B/C + 上下文两层契约（形态层统一出手契约）

**Status**: Accepted (2026-06-14)
**Part of**: YUK-203（领域模型重构）· 「整个产品重新想」形态轴 A3/A4。
**Decision source**: `docs/design/2026-06-14-product-rethink-decisions-ledger.md`（决策总账，最高权威）§0「全局出手强度表」+ §2 A3/A4；`docs/design/2026-06-14-product-rethink-phase2-synthesis.md`（Phase 2 综合）§2.3/§2.4/§4.2 + §7 硬决策 H6（编排者输出永不进 extraction）/ H8（到期项 hard constraint）/ §6.3 C3（confirmation loop 五防破口）。
**Related**: ADR-0025 ND-5（proposal-only 正主，只管破坏性改动——本 ADR 把它从「单一裁决 lane」扩成 A/B/C 三档落点，不改其破坏性走提案的内核）· ADR-0017（memory = mem0 facts + brief layer，记忆是 attention prior 非 SoT——本 ADR 的「长时 attention prior 只读旁路」直接继承其 §read pattern / one-line summary）· ADR-0032（DomainTool 面 = copilot 全集并 + 面级 allowlist——本 ADR 把「前台 copilot 面 / 后台 task 窄面」重述为单编排者的不同召唤姿势，actor_ref 分轨；ADR-0032 D0-2「面-copilot 原则」是本契约的工具面前提）· **ADR-0029（Coach → ReviewPlanTask 两级流水线 + review_plan 独立 surface）—— 本 ADR §决定 1 把 review_plan 等 4 个后台 job 收编进同一 D14 编排者，ReviewPlanTask 不再是独立人格，故 partial-supersede ADR-0029 §决定 4 的「Coach 不进热循环 + ReviewPlanTask 独立边界」叙事中『四个 agent 各有独立人格 surface』那一面；其窄工具面 / 不读记忆 / FSRS when 独立的约束保留**。

---

## 背景

Phase 0 现状地图认定四处现状是**同一反模式的不同切面——把「编排」这件劳动甩给了用户**（决策总账「综合主线」）：(1) `/today` 聚合仪表盘把全量状态平铺给一个假想的全知用户；(2) due / review_plan 双通道不对账；(3) Copilot 死占位；(4) 18-kind inbox 均一钉死必须逐条 accept。应然 = 编排收归单编排者（D14），人保留**裁决权与方向盘，不是编排劳动**。

但现状的「AI 角色」本身就是碎的：前台 Copilot（D14）是唯一对话 agent、第一人称「我」、常驻 Drawer；后台 `agency` 4 个独立 job handler（dreaming / coach_daily+weekly / goal_scope）各有独立 actor surface，**4 个人格互不知情**（Phase 2 §2.3 grounded）。同时 inbox 把 17 个 kind 全压进一条 accept/dismiss lane，其中 `defer`/`archive`/`judge_retraction` 三个本质是状态/旁观动作却占着裁决 lane（accept applier 从未实现，YUK-44）。而 `ambient_context` 只是 `chat.ts` 的私有入参，雏形未成契约。

本 ADR 把形态轴 A3（AI 角色）+ A4（读 vs 判）合为一条**形态层统一出手契约**：单编排者把全集状态合成为「今日之线 / 练习流 / inbox 裁决」三个面里的一句话主线 + 可下钻全量，所有写入按「可逆性 × 后果」分 A/B/C 三档出手，并以两层上下文契约为输入底座。算法侧（B1-B5）不在本 ADR——它只钉**形态层的出手与上下文契约**。

## 决定

1. **单编排者 D14 = 前台 Copilot + 后台 4 job 合为同一编排者的不同召唤姿势**。前台 Copilot（`actor_ref=copilot`）/ 夜链 dreaming（`actor_ref=dreaming`，产交班缕）/ coach daily+weekly（`actor_ref=coach`）/ goal scope（`actor_ref=goal_scope`）是**同一个 D14 的四个召唤姿势**，对用户讲一条连贯故事——前台对话能引用昨夜后台想的（A1 交班缕），后台 job 写会话级工作记忆供前台读。**合为一个叙事 ≠ 丢可观测性**：留痕仍按 `actor_ref` 分轨（evidence-first / runs log 到 `src/server/ai/log.ts` 延续）。这 **partial-supersede ADR-0029 §决定 4** 的「四 agent 各持独立人格 surface」那一面——ReviewPlanTask / Coach 不再是互不知情的独立人格，而是 D14 的召唤姿势；但 ADR-0029 的实质约束（review_plan 面窄、不读记忆、checkpoint 自适应不让编排者进 FSRS 热循环、FSRS *when* 独立真相源）原样保留，工具面分轨经 ADR-0032 的面级 allowlist 落地（`review_plan` / `ingestion_block_edit` 保持窄是为约束自主 task，同时也授予 copilot——ADR-0032 D0-2 RP-5）。

2. **全局出手强度表 A/B/C（统一出手契约，按「可逆性 × 后果」分档）**，管 D14 对所有面（inbox kind / mem0 extraction / inline 动作 / Today 交班缕 / 练习流提议）的出手：
   - **A 档（自动 + 撤销窗口）**：乐观应用、不打断不强制确认、后台静默 apply + 顶部可撤销提示 + 一键 revert，不进 inbox lane。落 `record_links` / 某些 completion 这类静态可逆 kind + mem0 episodic 客观事件。健康指标 = **revert 率**。
   - **B 档（逐条人审）**：结构性 / 破坏性写入逐条裁决，走现状 inbox accept/dismiss lane。落 knowledge_node/edge/mutation、variant_question、learning_item transition、relearn、goal_scope、block_merge、question_draft/edit + mem0 semantic-trait（偏好/习惯/弱点）。健康指标 = **dismiss 率**。
   - **C 档（纯状态不进队列）**：本就不是结构写入提议，移出裁决面。`defer → snooze 控件` / `archive → 直接软归档` / `judge_retraction → agent-notes 旁观`。这同时解决「三 kind 只能 dismiss」死占位（YUK-44）——**不是补 accept applier，是它们本就不该在裁决面**。
3. **A 档判据 = 静态可逆性兜底，不靠 confidence**。现状 confidence 只覆盖 1/18 kind 且校准从未验证，数据基础不足。A 档用 kind 级零成本静态硬判据先拿 80% 价值且完全可解释；软 triage 推迟到埋点观测真实分布、confidence 校准验证后才迁。**单用户硬顶熔断**：单位时间 auto-apply 上限超限即退回全人审（护栏两层语义的 A 档落点——warning 水位只告知，硬顶 3-5× 只防事故）。指标只落两档健康信号（A 档 revert 率 / B 档 dismiss 率），**不追抽象 appropriate-rate**（n=1 无 cohort 无法校准）。

4. **`defer` / `archive` / `judge_retraction` 移出裁决面**（落 C 档）。它们是状态 / 旁观动作不是「需人审的结构写入」，本不该占裁决 lane。

5. **自主滑块默认 hint-first**。inline 解题默认给提示而非完整解，**可一次性走到完整答案后交还用户控制**（防 Khanmigo 强制 Socratic 教训）。提示阶数 owner 后续拍（Phase 2 §7 软决策：3 阶 v0 借 GPT 稿 Hint Ladder H0-H5，埋 revert/escalate 率后调）；本 ADR 只钉「默认 hint-first + 有完整答案逃生口」这条形态不变量。

6. **上下文升级为两层正式契约**：
   - **(a) 会话级工作记忆（Postgres，所有 surface 写入 / 编排者读取）**：把 `ambient_context` 从 `chat.ts` 私有入参升格为正式表，存当前面 / focused_entity / 上一轮练习结果 / **刚 dismiss 哪条**。「刚 dismiss 哪条」直接服务 A4 的 B 档回流——编排者下次不重复同类提议。
   - **(b) 长时 attention prior（mem0，编排者只读旁路）**：经 ADR-0017 dual-layer + P3 `searchMemories` 读路径取用，**永不偏置 judge / FSRS，只读非真相源**（ADR-0017 one-line summary 延续）。
7. **防循环注入五防必守**（注入事实非上一轮 prompt 装配物 / ambient 不进历史 / 鲜读 digest 不进历史 / 双层截断 / 专项单测）。两条 invariant 落代码 + 单测（Phase 2 §7 H6 / §6.3 C3）：**(i) 只有用户作答 / 陈述类 event 可喂 mem0 extraction，编排者自身输出永不进 extraction 源**（堵 confirmation loop：编排者输出 → event → mem0 抽 semantic-trait → 下轮喂回）；**(ii)** mem0 prior 只进 prompt 软上下文不进数值权重（Phase 2 §7 H5）。

## 后果

**正面**
- 四个面（A1 入口 / A2 练习 / A3 角色 / A4 读判）经 D14 单编排者 + A/B/C 契约 + 两层上下文串成一个连贯叙事；A/B/C 不是第四个面，是贯穿前三面的统一出手契约（Phase 2 §2 形态层主线）。
- A4 三档里 A 档（静态可逆性兜底）+ C 档（三 kind 移出裁决）**零算法依赖、可立即做**（Phase 2 §5 软决策 + 依赖图）；不卡在 B1 mastery 重写 / 一致性闸地基的关键路径上。
- 「刚 dismiss 哪条」入会话级工作记忆 → A4 的 B 档 dismiss 回流闭环，编排者不复读同类提议；后台 4 job 收编进 D14 → A1 交班缕有连贯来源；指标收敛到两档可观测健康信号（revert / dismiss 率），不追无法 n=1 校准的抽象 rate。
- 长时 attention prior 走 ADR-0017 只读旁路 + 五防 invariant，记忆「写了没人读」的半环（P3 未接、被取代 fact 仍被检索）随 `searchMemories` wrapper（YUK-322 / task #23）接通而闭合。

**代价 / 风险**
- 后台 4 job 收编进同一 D14 与现状「copilotTools 贡献制实质 no-op、CORE_TOOLS bootstrap 全量先到」张力直接相撞（Phase 2 §6.6 F3）：须先让 copilotTools 贡献制真生效（退役 CORE_TOOLS latch）再谈 job 收编，否则「合为同一 D14」只是叙事不是真相源。actor_ref 分轨是对的可观测前提，但不能替代工具面真相源收口。
- 会话级工作记忆从私有入参升格为正式表 = 一次 schema 迁移 + 写边界；纳入「刚 dismiss 哪条」须保证它本身不被 mem0 extraction 当作 event 喂回（五防 invariant (i) 的边界要把工作记忆也算进「编排者自身输出」侧）。
- A 档静态可逆性判据要为每个 inbox kind 标 A/B/C 一张 ~18 行归档表（Phase 2 §6.2 B3，低风险高确定性，Phase 2 收口拍）；归档表错判 = 把不可逆动作放进 A 档自动应用，靠熔断 + revert 兜底但首次仍已 apply——故归档默认偏保守（拿不准归 B）。
- hint-first 提示阶数未定（Phase 2 §6.2 B2）暂以 3 阶 v0 起步，阻塞 A3 交互层细化；交互 / 像素层整体留白交 claude design（Phase 2 §6.6 G1），本 ADR 只到结构形态。

## 备选（已否决）
- **保留 4 个互不知情后台人格 + 前台 Copilot 五个独立 agent**——否决：现状反模式的根因就是「AI 角色碎成多人格、叙事不连贯」，与「编排收归单编排者、人只裁决」的应然主线直接冲突（决策总账综合主线 + §2 A3）。
- **A 档准入靠 confidence 阈值**（GPT 稿 / 工业 HOTL 路径）——否决：confidence 现状只覆盖 1/18 kind 且校准从未验证，单用户无 cohort 无法 n=1 校准；改用静态可逆性兜底 + 熔断（决策总账 §2 A4 + Phase 2 §4.2 / §6.3 G3）。软 triage 不删除，是推迟到有校准方案后再迁。
- **给 `defer`/`archive`/`judge_retraction` 补 accept applier 让它们留在裁决 lane**（YUK-44 字面解法）——否决：它们本质不是需人审的结构写入，补 applier 是在错误前提上加工；正解是移出裁决面（C 档）。
- **自主滑块默认完整解 / 默认强制 Socratic**——否决：前者放弃教学价值，后者重蹈 Khanmigo 强制 Socratic 教训；折中 = hint-first 默认 + 完整答案逃生口（决策总账 §2 A3）。
- **mem0 prior 进数值权重 / 编排者输出可作 extraction 源**——否决：前者破三轴正交（mem0 永不偏置 judge/FSRS，ADR-0017），后者制造 confirmation loop 破防循环注入五防（Phase 2 §7 H5/H6 + §6.3 C3）。
- **bi-temporal 工作记忆 / 把长时 attention prior 当真相源**——否决：记忆是 attention prior 非 SoT（ADR-0017 内核延续）；SoT 仍是 event（ADR-0006 v2）+ 派生 view。
