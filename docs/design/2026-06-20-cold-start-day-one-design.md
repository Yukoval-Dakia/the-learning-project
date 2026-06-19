# Cold-Start-First · 第一天就可用的学习者画像 + 私人教研团（n=1）

**Status**: Design doc（方向 + 落地接线，非实现 PR）
**Date**: 2026-06-20
**Principle owner-ratified**: 2026-06-19（COLD-START-FIRST）
**Part of**: YUK-203 · B1 掌握诊断 / 产品重想（私人教研团愿景）
**Scope**: 单用户（n=1）AI 学习工具。owner 一人、每知识点稀疏作答、无 cohort。
**Upstream（被本文服务 / 约束本文的既有决策）**:
- `docs/design/2026-06-14-b1-diagnostic-engines-foundation.md`（四诊断器 n=1 可辨识性地基；本文的 §3 红线直接继承它）
- `docs/design/2026-06-15-difficulty-data-driven-research.md` + `docs/design/2026-06-15-b-anchor-feasibility-spike.md`（LLM 难度估计的诚实天花板）
- `docs/adr/0035-...`（三轴正交：FSRS=R 调度 / mastery_state=p(L) 诊断 / item_calibration=b 锚）、`0042`（MFI 选题三层引擎）、`0043`（半数据驱动 b）
- `src/core/theta.ts` / `src/core/theta-grid.ts` / `src/server/mastery/state.ts`（θ̂ / p(L) / 不确定性的活代码）

> **这是什么**：把 owner 2026-06-19 拍板的 **COLD-START-FIRST** 原则落成一份「第一天就能用、靠先验、随数据 refine」的设计。它不是新引擎——B1 的四诊断器、θ̂ Elo、PFA p(L)、KLP 冷启选题、softmax 编排都**已落地或已 dark-ship**。本文做三件事：(1) 把冷启栈逐件**映到现有代码**（什么已有、什么缺）；(2) 写出**第一天新用户旅程**的具体接线；(3) 把 n=1 红线 + LLM 先验诚实天花板钉成**可断言的不变量**，防止后人把冷启「修」成 forbidden 的总体标定。

---

## §0 原则 + n=1 试金石

### 0.1 COLD-START-FIRST（owner 拍板）

学习者画像（θ 能力 / item 难度 b / 每 KC 掌握 p(L) / typed 错误观念）+ 私人教研团（LLM 推断引擎）**必须在第一天、零累积作答数据下就有用**——靠**先验**，随数据到来只是 **refine**。

- **n=1 firm-up 是 refinement story，不是前置条件。** 「攒够 owner 自己的作答后才校准」是慢热的第二段，绝不是「画像可用」的门槛。冷启段的画像必须独立成立。
- 推论：任何「需要先攒 N 条作答才能给出第一个估计」的设计都**违反**本原则。每个量都必须有一个**先验形态**，从第 0 次作答起就有有限、稳定、带显式不确定性的值。

### 0.2 n=1 试金石（每个信号 / 参数过这一关才合法）

> 每个信号 / 参数必须是以下三类之一，**绝不能是跨考生方差分量**：
> 1. **已知常数 / owner 固定先验**（module const、owner 手填锚、LLM 返回的先验分布）；
> 2. **单学习者自状态**（θ̂、success/fail 计数、错因复发 tally——都是 THIS learner 的充分统计量）；
> 3. **结构常数**（KG prereq 深度、题型固有难度 d 设计常数）。
>
> **绝不能**是：IRT 区分度 `a`、猜测 `c`、CDM 的 slip / guess——这些是**跨考生方差的函数**，n=1 无总体可积，结构性不可识别（核心判据：Stocking 1990，见 B1 地基 §2/§4）。

代码里这条红线已经物理落地：`src/core/theta.ts:27` 的 ICC 是 `P = σ(θ - b)`——纯 1PL/Rasch，**没有 a、没有 c**。`item_calibration` 表（`src/db/schema.ts:830`）只有 `b` 半边，且 `b` 永不被 θ̂ Elo 回写（G4 红线，`state.ts:475-476`「item-半边锁死: READ-ONLY」）。

---

## §1 冷启栈 → 映到我们的代码（逐件：机制 | 现有代码 | 还缺什么）

每件给三栏。**「现有」引文件:行，「缺」诚实标 ABSENT。**

### 1.1 难度 b —— LLM 学生模拟 / 成对比较 elicitation（不是 1-10 直评）

- **机制（settled）**：直接让 LLM 打 1-10 难度 ≈ 噪声（研究：Pearson -0.14~+0.14；中文 Qwen-max/GLM 甚至低于随机，ZPD-SCA）。改用 **抽教学特征→推 b** 或 **学生模拟 / 成对比较** elicitation。把 b 当**宽方差先验**：信**相对排序**不信绝对值；用少量 **owner 固定锚题**校准 offset。KG prereq 深度作**独立的结构难度信号**。
- **现有代码**：
  - `ItemPriorTask` 已实现且**已经躲开直评陷阱**。prompt（`src/ai/task-prompts.ts:776-795`）强制「**先抽教学特征（认知步骤数 / 前置链长 / 典型错误隐蔽度 / 题型固有难度），再由特征推 b**，reasoning 必须引用特征，禁止只写『我觉得难』」。输出 schema `ItemPriorDraft`（`src/core/schema/item_prior.ts:8-17`）= `{ b_logit ∈ [-6,6], confidence ∈ [0,1], reasoning }`。registry 条目（`src/ai/registry.ts:699-714`）注明「⚠️ 不直接 prompt 估难度（文献 r≈0），propose-only 冷启锚」。
  - 写入 `item_calibration`（`src/db/schema.ts:830-890`）：`b`（legacy）→ `b_anchor`（冷启锚，与 `b` 同源，migration 0038 回填，`schema.ts:851-859`）。`source='llm_prior'`、`track='hard'`。
  - **宽方差 / 弱锚降权已在线**：选题与 θ̂ 更新读 `effectiveB = b_calib ?? b_anchor ?? b`（`recalibration.ts` / `state.ts:492`）；无标定时回落 `difficultyToLogitB(1-5)`（`theta.ts:132`，注释自标「占位、非真值」），且**弱锚 update 降权 `DIFFICULTY_PROXY_WEIGHT=0.3`**（`theta.ts:137`、`state.ts:500`）。
  - **相对排序而非绝对**：p(L) 投影用的是 KC 的**代表 β = 该 KC 全部 hard-track item 的 b 中位数**（`state.ts:353-389`），中位数对单题误锚稳健——这是「信相对不信绝对」的工程体现。
  - **prompt 已能吃 anchored_b**：`buildItemPriorPrompt` 的 `knowledge_context: [{ name, anchored_b? }]`（`task-prompts.ts:777`）——已标定知识点的 b 锚可作参考，offset 校准的接缝已在。
- **还缺什么**：
  - **owner 固定锚题（fixed-anchor）机制 ABSENT**。`item_calibration.source` 的注释列了 `'fixed_anchor'` 槽位但**无写入路径**——没有「owner 钦定这 ~5-10 道题的 b 是 X」的录入面。这是 §1.1 校准 offset 的硬前置，也是冷启段唯一能对抗系统性 under-estimation 的杠杆（见 §4.1）。
  - **学生模拟 / 成对比较 elicitation ABSENT**。当前只有「特征→b」单题路线（已比直评好）。LLaSA 式学生模拟、成对比较两两定序是 spike 点名的更强冷启法（`b-anchor-feasibility-spike.md` §2.2 ④），但**未实现**。
  - **KG prereq 深度作独立难度信号 ABSENT**。prereq 边只在写入期做 acyclicity 校验（见 1.5），**不喂任何难度/选题信号**。

### 1.2 能力 θ —— EAP / 贝叶斯（N(0,1) 重释为单学习者信念）

- **机制（settled）**：用 EAP / 贝叶斯，把 N(0,1) 重释为 **owner 固定的单学习者信念先验**（不是总体分布）——从**1 次作答**就给出有限、稳定的 θ̂ + 显式方差。θ=0 种子。选题必须降到 **1PL/Rasch（a≡1）**，**绝不**用吃 a/c 的 Fisher-info 选题。
- **现有代码**：
  - **θ=0 冷启种子已在线**：`mastery_state` 无行 → `theta=0`（`state.ts:549`、`candidate-signals.ts:96 COLD_START_THETA=0`）。logit 原点 = p(correct)@b=0 恰 0.5，中性先验。
  - **从 1 次作答即更新**：`updateTheta`（`theta.ts:78-87`）是纯函数 Elo，冷启段高 K（`eloK`：前 4 次 `kCold=0.4`，之后 `kFloor=0.12`，`theta.ts:65-70`）——单次作答就实质移动 θ̂。
  - **显式方差已在线**：YUK-361 Phase 2 给点估计 θ̂ 配了 **Rasch Fisher information 累积** `theta_precision`，SE 现算 `thetaSe = 1/√precision`（`theta.ts:388-416`）。冷启 `precision=1`（弱先验 1 单位信息，SE=1）。p(L) 投影据此给**置信带** `mastery_lo/hi` + `low_confidence` 标志（`state.ts:258-272, 304-331`）。
  - **离散网格贝叶斯（EAP 雏形）已写、dark-ship**：`src/core/theta-grid.ts` 是 θ_KC offset 的 41 点离散后验（`uniformPrior` / `gridUpdate` 序贯贝叶斯 / `posteriorSe` 校准 SE）。**但 `THETA_GRID_ENABLED=false`（`theta-grid.ts:54`）+ 仅 shadow 写、无下游读者**（`state.ts:738-789`）。这是「AutoElicit 式 LLM 返回先验分布」最接近的现有载体，目前是纯影子。
  - **1PL 而非 Fisher-info 选题已在线**：MFI = `p(1−p)`，注释明确「IRT 2PL 在 **a=1** 时的 item information」（`selection-signals.ts:8, 77`）——即 a 被钉死 1，不估。冷启段更进一步用 **KLP**（后验加权 Fisher 网格积分，不押 volatile θ̂ 单点；`selection-signals.ts:82-127`，`EARLY_KLP_ENABLED=true` LIVE），warm KC 才回落点 MFI。
- **还缺什么**：
  - **AutoElicit 式「LLM 返回 θ 先验分布」ABSENT**。冷启 θ 先验现在硬编码 N(0,1)/precision=1，**不是** owner-/LLM-elicited。可让 LLM 据 goal + 自述背景给一个**单学习者先验分布**（重释 N(μ,σ²)），喂 `theta_grid` 的初始 prior 或 θ̂/precision 种子。
  - **grid 后验未接 SoT**。EAP 校准 SE 的真收益要等 inc-2 grid→SoT 切换（`theta-grid.ts:42-52`，须排在 A3 之后），目前 Elo 点估计 + Fisher SE 仍是真相源。

### 1.3 掌握 p(L) —— ALEKS 式知识结构 + 沿 prereq 边传播掌握风险

- **机制（settled）**：ALEKS 式 knowledge-structure + half-split，用**我们的 KG 当 surmise relation**；沿 prereq 边传播掌握风险；状态先验 = uniform 或 LLM/owner-elicited（**不是总体**）。
- **现有代码**：
  - **p(L) 引擎已是 LIVE 真相源**：`getMasteryProjection`（`state.ts:274-332`）= 难度感知 PFA：`logit(p(L)) = γ·success + ρ·fail − β`（`src/core/pfa.ts`），冷启（success=0,fail=0,β=0）→ 0.5。这是「单 PFA logistic 吸收 IRT-b + CDM per-skill 在 n=1 可估部分」的 B1 正解（地基 §1）。
  - **状态先验 = uniform/中性**：冷启 0.5 + uniform grid prior（`theta-grid.ts:104 uniformPrior`，注释「不用 Gaussian-at-0，保持 assumption-light」）。**绝不是总体先验**——n=1 合法。
  - **per-domain 冷启继承已 LIVE**：A2 层级 Elo（`HIERARCHICAL_ELO_ENABLED=true`，`theta.ts:184`）让某域强的学习者，该域一个**没见过的新 KC** 从 `θ_global(domain)` 起步而非冷 0（`state.ts:148-220`）。这是「沿结构传播能力」的一种已落地形态（按 domain 而非按 prereq 边）。
- **还缺什么**：
  - **沿 prereq 边传播掌握风险 ABSENT**。掌握继承现在只按 **effective_domain**（A2），**不沿 prerequisite 边**。「答错 B → B 的前置 A 掌握风险上调」「A 未掌握 → 锁/降权依赖 A 的 KC」这类 surmise 传播**未实现**。
  - **ALEKS 式 knowledge-structure / half-split / surmise ABSENT**。全仓库 0 命中 `surmise` / `knowledge_space` / `half-split` / `ALEKS`。prereq 边存在但只做 acyclicity（见 1.5）。把 KG 当 surmise relation 是本文最大的「缺」。

### 1.4 错误观念 —— 学科声明的错因目录 + LLM 锚定推断（约束到 taxonomy）

- **机制（settled）**：学科声明的 misconception/cause **目录**（像 AAAS/Eedi 专家目录种子）+ LLM **推断**（从 题 + 正确答案 + 学习者**具体错答**），**锚定到正确答案 + 约束到学科错因 taxonomy**（retrieve-then-rerank-with-rationale）。保留「unknown/novel」逃生口。**错误观念是 HYPOTHESES 不是 labels。**
- **现有代码**：
  - **学科声明的错因目录已在线**：`causeCategories`（`src/subjects/<name>/profile.ts`，如 `math/profile.ts:45-87` 七类 concept/knowledge_gap/calculation/method/reading/memory/expression；`general/profile.ts:52+`）。schema `CauseCategoryDeclaration`（`src/core/schema/profile-decl.ts:5-21`）带 `id/label/description/review_priority/variant_targetable/`**`source_pack{id,version}`** ——`source_pack` 槽位**正是为「AAAS/Eedi 式专家目录包」provenance 准备的**（虽然现在 inline 手写、未挂外部包）。
  - **LLM 推断已在线、约束到 taxonomy、锚到错答**：`AttributionTask`（registry `src/ai/registry.ts:75-86`）输入 `{ prompt_md, reference_md, wrong_answer_md, knowledge_context }`，输出 `{ primary_category（profile taxonomy 之一）, secondary_categories[], analysis_md, confidence }`。接线 `runAttributionAndWriteJudgeEvent`（`src/capabilities/knowledge/server/attribute.ts:83, 138`），结果写 judge event（`action='judge'`，`payload.cause`）。
  - **「unknown/novel」逃生口已在线**：registry prompt 注「低信心走 profile 的 **other**（若存在）或最接近类别，并写详细 analysis_md」；`validateCauseAgainstProfile`（`src/core/schema/cause.ts:35-50`）primary 不在 taxonomy → 回落 `'other'` / 首类。
  - **HYPOTHESES 不是 labels 已物理体现**：错因带 `confidence`；`mistake_variant.status` 生命周期 `draft → active → broken / dismissed`（`src/core/schema/business.ts:273`）——AI 提议是 `draft`，用户接受才 `active`，dismiss/broken 是软撤销。这就是「假设而非标签」的状态机。
- **还缺什么**：
  - **retrieve-then-rerank-with-rationale ABSENT**（弱形态）。现在是一发 LLM 直接从全 taxonomy 选 primary，**没有**先检索 top-k 候选错因再带 rationale 重排的两段式。taxonomy 小（~7 类/科）时影响有限，但这是 settled 机制点。
  - **外部专家目录包未挂**。`source_pack` 槽位空着；目录是 profile 作者手写，未从 AAAS/Eedi 式包种子化。
  - **冷启第一天的错因画像**：第一天无错答 → 错因 tally 为空（`misconceptionRecurrence` 返回 undefined，`candidate-signals.ts:307`，**NEVER zero-fill**）。这是**正确的冷启形态**（无数据 ≠ 测得为零），但意味着 typed-misconception 画像确实是「随数据到来才长出来」的——与 §3 红线一致（misconception 软、不喂 θ）。

### 1.5 第一会话选题 —— 短 1PL 自适应 placement probe（走 KG frontier）

- **机制（settled）**：短的 **1PL 自适应 placement probe**（**cap ~10-30 题防疲劳**）沿 KG frontier 走；judge 当场判分 + 归因；EAP 每答一题收紧 θ/p(L)。调度用 **FSRS 默认参数**（承重——低数据下默认胜过 per-user 优化）；judge grade → FSRS first-rating → S0。
- **现有代码**：
  - **1PL 选题 / KLP 冷启 / softmax 编排已 LIVE**：`composeDailyStream`（确定性 lane，`stream-composer.ts:60`）+ `softmax_mfi`（LLM 编排 lane，**default-ON**，`resolveSelectionPolicy` 读 `SELECTION_POLICY`，`stream-store.ts:339-396`）。候选信号 `collectCandidateSignals`（`candidate-signals.ts:443`，已 wire 进 `collectComposerInputs`，`stream-store.ts:34`——其文件头「不接进 composeDailyStream」注释**已陈旧**，实际经 softmax lane 消费）。冷启 KC 走 KLP（`candidate-signals.ts:356-365`），warm 才点 MFI。
  - **FSRS 默认参数承重已在线**：`const scheduler = fsrs();`（`src/capabilities/practice/server/fsrs.ts:28`）——**零自定义参数**，纯 ts-fsrs 默认 w[]。首评 `createEmptyCard(now)`（`fsrs.ts:40, 62`）给默认 S0。**无任何 per-user generatorParameters / w[] 优化**——正是 settled 机制要的。
  - **judge grade → FSRS rating 已在线**：`ratingFromCoarseOutcome`（`src/core/capability/schedulers/fsrs.ts:43-54`）`correct→good / partial→hard / incorrect→again`（`fsrs.ts:8-12 RATING_MAP`）→ `scheduler.next` → S0/dueAt。
  - **judge 当场判分已在线**：submit 路径同步调 judge（`src/capabilities/practice/api/submit.ts`），归因则 attempt commit 后**异步** enqueue `attribution_followup`（per agent 勘察：`solve-submit.ts` 异步 job + `paper-submit.ts:297` 占位 `attribution_pending`）。
  - **EAP 每答收紧已在线**：每次 attempt 经 `updateThetaForAttempt`（`state.ts:453`）更新 θ̂ + precision（收紧 SE）+ PFA 计数（收紧 p(L)）。
- **还缺什么**：
  - **「placement probe」作为一个有界、有终止条件的会话概念 ABSENT**。现有 daily stream 是稳态的「今日之线」，**没有**「第一会话专门跑 ~10-30 题、走 frontier、答完即落 θ/p(L) 画像」的**有始有终的 placement 流**。冷启第一天的选题会从空候选池退化为空流（见 §1.6 / §2）。
  - **沿 KG frontier 走 ABSENT**：选题走的是 `mastery_state`/`material_fsrs_state` 在场性 + θ̂（target-discovery `COVERAGE_DEPTH_THRESHOLD`），**不沿 prereq 边的 frontier**（同 1.3 / 1.5 的 prereq-未消费问题）。

### 1.6 入口 / 引导 / 目标 elicitation —— 现状

- **现有代码**：
  - **入口是 `/today`**（`web/src/router.tsx:191-199` 全部重定向到 today）。TodayPage（`src/capabilities/shell/ui/TodayPage.tsx`）= workbench summary（KPI / 今日之线 / sessions / proposals / cost / agent notes）。
  - **goal 实体存在**：`goal` 表（`src/db/schema.ts`，title / subject_id? / scope_knowledge_ids / status），由 `goal_scope` AiProposal 接受后物化（`agency/server/goals/`）；`runGoalScopeAndWrite`（`scope.ts:55`）是**反应式、按需**触发，**不在入口**。`learning_item` 表承载「学了哪些主题/书/题集」。
- **还缺什么（本文最大的产品缺口）**：
  - **onboarding / goal-elicitation / placement 流 完全 ABSENT**。全仓库无 welcome / setup / 「你想学什么」/ placement test。冷库新用户登陆 `/today` 看到的是**全零 KPI + 空流**，opening line：「今天流里还没有东西——录几道题，或向我点播一份卷。」（`stream-store.ts:610`）。
  - **无 per-user 学科 enrollment**：subject profile 是无状态 domain 查表（`src/subjects/profile.ts`），**不是**用户选定的科目行。
  - 结论：**应用假设画像已被填充**。第一天的画像组装 + placement 是必须新建的层（§2 / §5）。

### §1 速览表

| 冷启件 | 现有（file:line） | 缺（ABSENT / 弱） |
|---|---|---|
| **b 难度先验** | ItemPriorTask 特征→b（task-prompts.ts:776；item_prior.ts:8）；b_anchor + 弱锚降权 0.3（state.ts:500）；代表 β 取中位数 | owner 固定锚题写路径（`source='fixed_anchor'` 无 writer）；学生模拟/成对比较；prereq 深度作难度信号 |
| **θ 能力** | θ=0 种子 + Elo（theta.ts:78）；Fisher precision/SE（theta.ts:388）；grid 贝叶斯 dark-ship（theta-grid.ts:54）；KLP≠Fisher-info 选题（selection-signals.ts:82） | AutoElicit 式 LLM 返回 θ 先验分布；grid→SoT 切换 |
| **p(L) 掌握** | 难度感知 PFA LIVE（state.ts:274）；uniform 先验；per-domain 冷启继承 A2 LIVE（state.ts:148） | 沿 prereq 边传播掌握风险；ALEKS surmise/half-split |
| **错误观念** | 学科 causeCategories 目录（math/profile.ts:45）+ source_pack 槽位；AttributionTask 约束 taxonomy + other 逃生口（registry.ts:75；cause.ts:35）；draft/active 状态机 = 假设 | retrieve-then-rerank；外部专家目录包；冷启第一天画像为空（正确但需说明） |
| **第一会话选题** | softmax_mfi default-ON + KLP 冷启（stream-store.ts:339；candidate-signals.ts:356）；FSRS 默认参数（fsrs.ts:28）；grade→rating→S0（schedulers/fsrs.ts:43） | 有界 placement probe 概念；沿 KG frontier 走 |
| **入口/引导/目标** | /today（router.tsx:191）；goal/learning_item 实体（schema.ts；scope.ts:55） | onboarding / goal-elicitation / placement 流**全缺**；无 subject enrollment |

---

## §2 第一天新用户旅程（具体接线，逐步）

目标：让一个**冷库新用户**在一个会话内，从「什么都没有」走到「画像落地（带不确定性）+ 第一份教学/调度排好」。每步标**接哪个现有接缝**。

### 步骤 1 — Onboarding + 目标 elicitation（NEW）

- UI：`/today` 检测到冷库（`goal` + `learning_item` + `mastery_state` 三表皆空）→ 不再渲染空流，改渲染 **welcome / setup**（NEW shell page）。
- 一问：「你想学什么？」自由文本 + 可选 subject 提示。
- 接线：复用既有 `runGoalScopeAndWrite`（`agency/server/goals/scope.ts:55`）→ `goal_scope` LLM 提议 → 物化 `goal` + `scope_knowledge_ids`（确定该用户的 KG 子图 = placement 走的范围）。**这是把「反应式 goal 创建」前移到入口**，不是新引擎。

### 步骤 2 — 先验组装（NEW 编排，复用既有 task）

对 goal 圈定的 KG 子图，组装第一天先验：
- **b 先验**：对子图内未标定的题跑 `ItemPriorTask`（`registry.ts:699`）→ 写 `item_calibration.b_anchor`（`source='llm_prior'`，弱锚、宽方差）。**叠 owner 固定锚题**（NEW，§5 inc-A）校 offset。
- **θ 先验**：默认 θ=0 / precision=1（已在线）。**可选**（NEW，§5 inc-D）：AutoElicit 式 LLM 据 goal + 自述背景返回单学习者 θ 先验分布 → 种 `theta_grid` 初始 prior 或 θ̂/precision。
- **p(L) 先验**：uniform / 0.5（已在线，无需动）。
- **错误观念目录**：加载 goal 科目的 `causeCategories`（已在线）——目录第一天就在，**实例**（typed misconception）等错答才长。

### 步骤 3 — Placement probe（NEW，~10-30 题，有界有终止）

- 一个**有始有终的会话**（不同于稳态 daily stream）：沿 goal 子图的 frontier 选 ~10-30 题。
- 每题选题：复用 **KLP 冷启选题**（`candidate-signals.ts:356-365`，冷启 KC evidence<EARLY_KLP_N 走 KLP 后验加权 Fisher 网格积分，**不押 volatile θ̂ 单点**）——这正是为「θ̂ 还没稳时怎么选下一题」设计的，placement 直接用。
- frontier 走法：MVP 用现有 target-discovery 的覆盖/θ̂ frontier（`target-discovery.ts`）；**沿 prereq 边的 frontier 是 §5 inc-C 的增量**。
- 终止：题数 cap（防疲劳，settled）+ 可选 θ precision 阈值（SE 收够即停）。
- 每答一题：judge 当场判分（`submit.ts` 同步）→ `updateThetaForAttempt`（`state.ts:453`）收紧 θ̂/precision/p(L) → judge grade → FSRS first-rating → S0（`schedulers/fsrs.ts:43`，`createEmptyCard`）。归因异步 enqueue（`attribution_followup`）。**EAP 每答收紧**这条已经是现成行为。

### 步骤 4 — 画像落地（带不确定性）

- probe 结束，画像即有：
  - **θ̂ + SE**（`thetaSe`，`theta.ts:397`）——有限、稳定、显式方差。
  - **per-KC p(L) + 置信带** `mastery_lo/hi` + `low_confidence`（`state.ts:304-331`）——**可见不确定性**（§4.3）。
  - **b 锚**（宽方差先验，弱锚标记 `bSource='difficulty_proxy'` vs `'item_calibration'`，`candidate-signals.ts:73`）。
  - **错误观念**：probe 中的错答经 AttributionTask 长出 0..N 条 `draft`/`active` typed misconception（假设态）。
- 关键：画像**第一天就落地**，每个数都带不确定性标注——这就是 COLD-START-FIRST 的交付物。

### 步骤 5 — 第一份教学 + 调度

- placement 落的 FSRS new 卡进入稳态 daily stream（`composeDailyStream` / `softmax_mfi`，已 LIVE）——第二天起 `/today` 就有真实的「今日之线」。
- 私人教研团（LLM 编排者 `SelectionOrchestratorTask`，`registry.ts:724`）据画像（分桶 mfi/diagnostic/misconceptionRecurrence 信号）排非到期项 + 给理由——「为你而备」的异步教研在画像之上立刻可跑。
- session 复盘（`registry.ts:201` 的复盘 task）给量化总结 + 模式观察 + 下次建议。

> **冷启 fail-safe**：步骤 3 若候选池空（goal 子图无题），softmax lane 两级回落到确定性空流（per agent 勘察），用户回到「录题/点卷」提示——不崩、不假装有画像。

---

## §3 n=1 红线（可断言的不变量）

以下每条都是**可写成测试断言**的不变量。括号内是现有的物理保证点。

1. **永不估计 `a` / `c` / slip / guess。** ICC 恒为 `P = σ(θ − b)`（1PL，`theta.ts:27`），无 a、无 c 参数；`item_calibration` 只有 b 半边（`schema.ts:830`）。任何引入 per-item 区分度/猜测的 PR 直接违例。
   - *断言*：`UpdateThetaForAttemptInput`（`state.ts:391-434`）字段集里**没有** a/c/slip/guess 任何承载位（结构性切断）。

2. **选题用 1PL，不用吃 a/c 的 Fisher-info。** MFI = `p(1−p)` = 2PL 在 **a≡1** 时的 information（`selection-signals.ts:8, 77`）；冷启走 KLP（后验加权，`selection-signals.ts:82`）。不得引入需要 a 的 item-information 选题。

3. **b 是只读外部锚，θ̂ Elo 永不回写 b（G4）。** `state.ts:475-476` 注「item-半边锁死: READ-ONLY」；`updateTheta`（`theta.ts:78-87`）无任何 b 出口；`b_calib` 只由批量 `recalibrateQuestion` 写（`schema.ts:860-866`），在线 attempt 路径绝不写。
   - 推论：冷启「修 offset」**只能**靠 owner 固定锚题（§4.1），**绝不能**用「攒 owner 作答反推总体均值」——那是 forbidden 的总体标定。

4. **misconception 软、不喂 θ/p(L)/FSRS。** 错因是 selection-only + 诊断展示信号，**绝不**进 θ̂/p(L)/调度。
   - *断言（已有测试）*：`candidate-signals.db.test.ts:1051-1092`「misconceptionRecurrence never feeds the θ path」——`UpdateThetaForAttemptInput` 无错因承载位，错因计算后 `theta_hat/precision/evidence_count` 不变。

5. **每个冷启先验是「常数/owner 固定/单学习者自状态」之一，绝非跨考生方差分量**（§0.2 试金石）。`misconceptionRecurrence` 的归一化常数是 owner-fixed module const（`candidate-signals.ts:240 RECURRENCE_NORM`，注「NOT inferred from any cross-examinee distribution」）；θ 先验 N(0,1) 重释为单学习者信念，**不是**总体分布。

6. **错误观念是 HYPOTHESES 不是 labels。** 带 `confidence`；走 `draft → active`（用户接受才确认）状态机（`business.ts:273`）；保留 `other` 逃生口。不得把 LLM 推断的错因当确定标签直接驱动硬决策。

7. **不从 LLM student-simulation 播种 typed-misconception。** 错因目录来自学科声明（`causeCategories`），错因**实例**来自 live judge 对**真实错答**的归因（`attribute.ts`）——**不是**从模拟学生猜「这题会触发哪个 distractor」（那是最弱的一环，§4.2）。

---

## §4 诚实天花板的缓解（owner 在意「别过度信任 LLM 先验」）

### 4.1 LLM 难度至多中等，且系统性 under-estimation，n=1 修不掉 offset

- **诚实陈述**：LLM 难度估计**至多中等**（最好 Spearman ρ~0.43-0.50；系统性**低估**难度；prompt-sensitive）。逐题精确预测**不可行**（BEA 2024 RMSE≈0.29 几乎打平常数 baseline；BERT ρ≈0.01-0.21，`b-anchor-feasibility-spike.md` §①）。中文阅读/语文×开放题甚至**低于随机**（ZPD-SCA）。
- **为什么 n=1 修不掉 offset**：修 offset 的标准做法是「对总体校准」——**这正是 §3 红线 3/5 禁止的 forbidden 总体标定**。n=1 无总体可积。
- **缓解（必须做）**：
  1. **owner 固定锚题**（§5 inc-A）：owner 钦定 ~5-10 道题的 b，作共同原点+单位的标尺，校 LLM 锚的系统 offset。这是冷启段唯一不违红线的 offset 杠杆。
  2. **宽方差先验**：b_anchor 当宽方差先验（已有弱锚降权 0.3，`state.ts:500`）；代表 β 取**中位数**抗单题误锚（`state.ts:353-389`）。
  3. **可见不确定性**（§4.3）：UI 显示 b 来源（真锚 vs difficulty_proxy）+ 宽带，不让 owner 误把弱锚当真值。
  4. **信相对排序不信绝对值**：p(L) / 选题用 b 的**相对**位置（KC 间难易序），不依赖绝对 logit 校准。

### 4.2 错误观念推断是最弱的一环

- **诚实陈述**：模拟学生命中人类选定的 distractor 仅 **31-47%**。错因推断是整个冷启栈**最弱的一环**。
- **缓解（必须做）**：
  1. **目录来自学科声明**（`causeCategories`，专家种子，可挂 `source_pack` 外部包），**不从 LLM 模拟生成**。
  2. **实例来自 live judge 对真实错答的归因**（`attribute.ts`），约束到 taxonomy + 锚到正确答案 + `other` 逃生口。
  3. **绝不从 student-simulation 播种 typed-misconception**（§3 红线 7）。
  4. **保持假设态**：`confidence` + `draft/active` 状态机 = 永远当假设，用户可 dismiss。冷启第一天错因画像为空是**正确的**（无数据≠零，`candidate-signals.ts` NEVER zero-fill）。

### 4.3 可见不确定性（贯穿）

- 已有载体：`mastery_lo/hi` + `low_confidence`（`state.ts:258-272`）、`theta_se`（`theta.ts:397`）、`bSource` 弱锚标注（`candidate-signals.ts:73`）、错因 `confidence`。
- 要求：**任何展示画像数字的读面，cold/low-confidence 时必须显式呈现带宽或不确定标志**，不显示干净的点估计假装确定（B1 地基「呈现置信区间非干净 78%」）。

### 4.4 强模型悖论（note）

- **诚实陈述**：**更强的模型模拟挣扎中的学习者更差**（strong-model paradox）→ 我们的 judge 若跑 Opus，可能**高估学习者成功率**（把题判得比真实学习者更容易答对，或在学生模拟里高估命中）。
- **本项目的具体暴露面**：judge 任务（`SemanticJudgeTask` 等）+ AttributionTask 默认走 `mimo-v2.5-pro`（`registry.ts:75, 291`），但 **YUK-365 切换 lane** 设 `AI_PROVIDER_OVERRIDE=anthropic-sub` 会把**全部** AI 任务切到 **Opus 4.8**——此时强模型悖论直接命中 placement probe 的 judge 判分与任何学生模拟式 b elicitation。
- **缓解（note，非硬 gate）**：
  1. **不假设「最强模型 = 最好的学生模拟器」**。b elicitation 的学生模拟（若实现 §5 inc-B）应实测对比模型档，不默认用最强。
  2. judge 判分的 outcome 是**真实学习者答案**（不是模拟），强模型悖论主要伤的是 b/能力的**模拟式 elicitation**，judge 真实判分相对稳——但仍需留意 Opus judge 可能对 partial 判得偏宽。
  3. 把这条记进 §6 待 owner 决策：placement 期是否锁定 judge 模型档。

---

## §5 增量拆解（先做什么；触 live 路径处 dark-ship/flag；各自可独立 ship）

按「能独立交付价值 + 不破坏既有 LIVE 行为」排序。每个增量标 flag/dark-ship 策略。

- **inc-A · owner 固定锚题写路径**（最高杠杆，§4.1 缓解 1 的硬前置）。
  给 `item_calibration.source='fixed_anchor'` 加 owner 录入面（owner 钦定 ~5-10 题的 b）。**纯加写路径**，不改 θ̂ 读路径（`effectiveB` 已会优先非 NULL 锚）。可独立 ship；无需 flag（新 source 值，旧题不受影响）。
- **inc-B · placement probe 会话**（§2 步骤 3 的核心 NEW 概念）。
  一个有界（~10-30 题）、走 frontier、有终止条件的第一会话流。**复用** KLP 选题 + judge + EAP 收紧（全已 LIVE）。新加的是「会话编排 + 终止」薄层。**Flag**：`PLACEMENT_PROBE_ENABLED`（module const，dark-ship），冷库才触发，不碰稳态 daily stream。可独立 ship。
- **inc-C · onboarding + 目标 elicitation 前移**（§2 步骤 1）。
  `/today` 冷库检测 → welcome page → 复用 `runGoalScopeAndWrite`。**UI 改动**（需走 design-doc pre-flight）。可独立 ship（无 placement 也能让冷库用户先建 goal）。与 inc-B 组合成完整第一天旅程。
- **inc-D · AutoElicit 式 LLM θ 先验分布**（§1.2 缺口）。
  LLM 据 goal + 自述返回单学习者 θ 先验分布 → 种 `theta_grid` prior / θ̂ precision。**Dark-ship**：搭在已 dark 的 `THETA_GRID_ENABLED` 上（`theta-grid.ts:54`），不动 Elo SoT。最低优先（θ=0 种子已够用）。
- **inc-E · 沿 prereq 边传播掌握风险 + frontier**（§1.3 / §1.5 最大缺口，最重）。
  把 KG prereq 边接成 surmise relation：掌握风险沿边传播 + frontier 沿边走。**触多个 LIVE 引擎**（target-discovery / 选题 / p(L)）→ 必须 **flag dark-ship**（如 `PREREQ_PROPAGATION_ENABLED`，默认 false，byte-identical 回归锚）。最大、最该最后做、最需独立审计（参 audit:relations 死边审计——`applied_in` 已是死边，prereq 接消费正好补一条 specialized consumer）。
- **inc-F · LLM 学生模拟 / 成对比较 b elicitation**（§1.1 缺口）。
  比「特征→b」更强的冷启 b 法。**实测对比模型档**（强模型悖论，§4.4）。独立于 inc-A（两者都只产 b_anchor 先验，PPI 去偏在 Phase 6）。低优先（特征→b 已躲开直评陷阱）。

> **排序建议**：inc-A → inc-C → inc-B（凑成第一天旅程 MVP）→ inc-E（最大价值但最重，dark-ship 慢热）→ inc-D / inc-F（锦上添花）。

---

## §6 待 owner 决策的开放问题

1. **placement probe 题数 cap**：~10-30 是 settled 区间，但 owner 的疲劳容忍 + 想要的 θ 收敛精度具体定多少？是否用 θ precision/SE 阈值动态终止（SE 收够即停）而非固定题数？
2. **owner 固定锚题（inc-A）的规模与录入方式**：~5-10 题够不够校 offset？是 owner 手填 logit b，还是 owner 对锚题作答后用 fixed-anchor IRT 反推？后者更省心但需要一点接线。
3. **冷库无题怎么办**：goal 子图第一天可能根本没题（用户还没录任何题）。placement 是否需要一个「种子题库」来源（如按 goal 现生成题），还是冷库就先走「录题/点卷」提示、placement 等有题再触发？
4. **强模型悖论下 placement 期是否锁 judge 模型档**（§4.4）：`AI_PROVIDER_OVERRIDE=anthropic-sub` 时全切 Opus；placement 的 judge 是否该强制留在 mimo（避免 Opus 高估），还是无所谓（judge 判真实答案，悖论主伤模拟）？
5. **inc-E（prereq 传播）的语义**：掌握风险沿 prereq 边传播的具体形态——是「答错 B → 上调 B 全部前置 A 的掌握风险」，还是「A 未掌握 → 降权/锁依赖 A 的 KC 的选题」？两者都做还是只做诊断侧（不锁选题）？
6. **AutoElicit θ 先验（inc-D）值不值得做**：θ=0 种子 + 冷启高 K 已能从 1 题快速移动 θ̂。LLM 返回单学习者 θ 先验分布的边际收益，相对它的 prompt-sensitivity 风险，是否划算？
7. **retrieve-then-rerank 错因（§1.4 缺口）**：taxonomy 只有 ~7 类/科时，一发 LLM 直选 vs 两段式 retrieve-rerank 的差异可能很小。值得为它加一段检索吗，还是留着等 taxonomy 长大？

---

## Linear issue 捕获门

本文为只读勘察 + 设计（无代码变更）。可执行 follow-up 已结构化为 §5 的 inc-A~inc-F，建议落 **YUK-203 · B1** 子项（COLD-START-FIRST 系列），而非散落顶层 issue：

- inc-A（owner 固定锚题写路径）+ inc-B（placement probe）+ inc-C（onboarding/goal 前移）构成「第一天旅程 MVP」，建议合成一个 epic 下三个可独立 ship 的子 issue。
- inc-E（prereq 传播）触多 LIVE 引擎 + 与 `audit:relations` 死边审计（`applied_in` 死边 / prereq specialized consumer 缺口）相关，建议独立子 issue 并标 dark-ship gate。
- inc-D / inc-F 为 gated-future，可作 backlog 子项，优先级低于 MVP。

owner 决策前（§6 七问）不建议开实现 issue——先定 placement 形态再拆。
