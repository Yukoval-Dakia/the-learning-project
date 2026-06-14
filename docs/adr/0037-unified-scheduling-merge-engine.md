# ADR-0037 — 调度合并引擎统一今日流（review_plan 退役）

**Status**: Accepted (2026-06-14)
**Part of**: YUK-203（领域模型重构）·调度轴 B3。
**Decision source**: `docs/design/2026-06-14-product-rethink-decisions-ledger.md` §1 B3（调度拍板原文，最高权威）+ `docs/design/2026-06-14-product-rethink-phase2-synthesis.md` §2.2（A2 练习旅程·流为脊柱）/ §3.4（调度合并引擎 grounded 现状 + 目标）/ §7.1 H2（owner 拍板「推翻双通道」）。
**Related**: ADR-0028（知识级 FSRS，仍是 *when* 真相源，本 ADR 不改其调度数学）/ ADR-0013（review-session lifecycle，仍是运行中 attempt 容器）/ ADR-0029（review-engine-lands-on-existing-primitives——**本 ADR amends 它**：§3.4 决定 4「Coach → brief → ReviewPlanTask 两级流水线」被合并引擎取代，ReviewPlanTask/review_plan 退化为 proposer 后直接退役，详见下文「§与 ADR-0029 的关系」）/ ADR-0012（mastery 派生 view，被 B1 `mastery_state` 重写但 frontier/排序读它）/ ADR-0030（variant-rotation probe selector，作为复习侧子步骤保留）。

---

## 背景

Phase 0 现状（`...phase2-synthesis.md` §3.4 grounded 复核）暴露调度面的双脑分裂与三重重复：

- **三套近重复 FSRS-due 选题逐行手抄**——`src/server/review/due-list.ts`、review-session、`src/capabilities/practice/server/stream-store.ts` 各自抄一遍「读 due 知识点 → 选一道非 draft 题」的 ADR-0028 §3 确定性 seam，三处会漂移。
- **AI `review_plan` job 另开 paper channel**（ADR-0029 决定 4 的 Coach→brief→ReviewPlanTask 两级流水线）旁路 due 选题——它产出独立 paper artifact，与 `/api/review/due` 的确定性队列**不对账**，Phase 0 因此出现「due 通道 + review_plan 通道双轨」反模式（决策总账综合主线：把「编排」甩给了用户）。
- **frontier 无一等公民实现**——`learnable_frontier`（prerequisite-gating）从未落地；`variant-rotation` 自称「唯一 AI seam」但 AI 实际没接进。

决策总账综合主线把这定性为**同一反模式**：编排劳动散落在三套手抄 + 一个旁路 job 里，没有单一编排者。应然不是造新引擎，而是「**收敛 + 接通**」——把已长在仓库里的 FSRS 卡 / prereq 边 / mem0 调和层收敛成一致形态，由 D14 单编排者通盘吃成一条「今日流」。本 ADR 记录调度轴 B3 的合并裁决：一个 AI 编排引擎取代三套手抄选题 + review_plan 旁路通道，`review_plan` 退役。Phase 2 §6.1 F1 与 §7.1 H2 已显式认定这是**推翻已锁决策的真重构**（非「接通」），工程量如实标，但据决策总账 §0「不计代价 ≠ 不计有效性」不作否决理由。

## 决定

1. **一个 AI 编排引擎通盘产今日流**。输入 = `FSRS due（R）+ frontier（KG）+ mastery p(L，B1 `mastery_state`）+ mem0 prior + AI 判断`，输出经 `composeDailyStream` **物化进 `practice_stream_item`**（落点见 `src/capabilities/practice/server/stream-composer.ts` + `stream-store.ts`，A2「流为脊柱」的脊柱产出）。三套手抄 due 选题（`due-list` / review-session / `stream-store`）收敛到这一个 picker，AI 真接进 `variant-rotation` seam（ADR-0030 的 `pickProbeForKnowledge` 降为复习侧子步骤，不再是「唯一 seam」空壳）。

2. **合并 what + mix，FSRS *when* 数学不并进 AI**（独立真相源，三轴正交红线 §4.1 R 轴）。AI 决定 **what**（今日学哪些知识点/题）+ **mix**（block↔interleave 配比、新知/巩固比，A2 由 B1 p(L) 掌握阶段驱动）；**FSRS 决定 when**——引擎只**读** ADR-0028 的 due 列表作约束输入，绝不把 FSRS 的间隔数学并进 AI 步骤，`material_fsrs_state` 仍是单 writer 的 *when* 真相源。复习配比 = AI 每日建议（非固定公式）。

3. **三约束嵌入引擎**（决策总账 §1 B3 + §7.1 H5/H8，§6.2 B6）：
   - ① **确定性硬约束嵌入**：到期必复习 + 孤儿 draft 排除作 **hard constraint**，AI **不能违反**。落地走**代码侧 post-filter**（LLM 产出今日流后确定性裁剪/补齐），**非 prompt 约束**（prompt 软约束会被 LLM 软化，§6.2 B6 处置）。到期项是 hard constraint——AI 只能改呈现顺序/主推不主推，**不能从队列删除**（H8 拍板，落代码 invariant + 测试，杜绝 §6.3 C1「what 决策隐性回灌 due 队列」正交破口）。
   - ② **可解释可追溯**：每条流项带 AI 理由，接 propose-only 留痕三表（evidence-first 红线，runs log 到 `src/server/ai/log.ts`）。
   - ③ **fallback**：AI 挂了退化到确定性 due 队列（先做确定性 fallback 兜底再叠 AI 层，§6.2 B6；degenerate 态设计）。

4. **frontier 一等公民 + 空 frontier LLM 填充**。`learnable_frontier` = prerequisite-gating **递归 CTE**（复用已有 prereq 边 + 一条 CTE，**不重建** ALEKS 式全局 knowledge space）作引擎的 what 候选来源之一。**空 frontier LLM 填充**：图稀疏/冷启动时 LLM 用语义 + 课程结构猜临时 frontier，**低置信 propose-only**，慢热期被真实边替换（§6.5 E4 known-limitation：临时边只做软建议不做硬 gating，先埋点测临时边 vs 真实边吻合率）。

5. **复习配比 = AI 每日建议；`review_plan` 退役并入引擎**。`review_plan` job 从 ADR-0029 的 separate paper channel **先降为引擎内的 proposer 角色，随即直接退役/全删**（不再独立注册、不再另开 paper channel）；ReviewPlanTask 同步退场，其「读 brief / knowledge snapshot / candidates → 写 plan」窄 surface 的产品 intent（知识点排期、复习配比）由合并引擎吸收。详见下文「§与 ADR-0029 的关系」。

6. **FIRe 不单独加**（决策总账 §1 B3 + §3「FIRe 砍」）。A 面（涨掌握）= B1 transfer credit 已做（只进 p(L)，RT2）；B 面（抵扣 due）**砍/押后**——地基软（仅 justinmath.com，无学术论文）+ 耦合 R 制造信号混乱。信号保持三轴正交：`R`（FSRS 调度）/ `p(L) + transfer credit`（掌握诊断）/ `difficulty`，互不污染。

## 与 ADR-0029 的关系（amends）

ADR-0029「Coach 复习引擎落在既有原语上」的存储与证据裁决（决定 1/2/3/5/6——知识级 FSRS 复用、`tool_quiz` 单容器、答案判分留 event 流、judge event 钉版本、治理归位）**全部存续不变**。本 ADR 只 **amends 其决定 4**：

- ADR-0029 决定 4 = **Coach → brief → ReviewPlanTask 两级流水线**（Coach 出战略 brief，ReviewPlanTask 独立注册窄 surface 输出 paper artifact，checkpoint 自适应归 ReviewPlanTask，记忆经 Coach brief 单通道下传）。
- 本 ADR：两级流水线**被合并引擎取代**。`review_plan` 先退化为引擎的 proposer，**随即退役**；ReviewPlanTask 不再独立注册。理由 = Phase 2 §7.1 H2 owner 拍板「推翻双通道」——双通道（due 确定性队列 + review_plan AI paper channel）是 Phase 0 反模式的调度切面，合并引擎收编后单一编排者一处产流，消除双轨不对账。
- ADR-0029 决定 4 内「ReviewPlanTask 不读记忆」的治理意图**升级延续**：合并引擎的 mem0 prior 走 §7.1 H5「只读软提示进 prompt 上下文，不进数值权重」+ §6.3 C2/C3 防循环注入（编排者自身输出永不进 mem0 extraction 源，H6），比原单通道更严。

## 后果

**正面**
- 三套手抄 due 选题（`due-list` / review-session / `stream-store`）收敛到单一 picker，`variant-rotation` seam 真接进 AI——调度逻辑漂移源被消除。
- due 通道 + review_plan paper channel 双轨不对账被合并引擎一处产流取代，Phase 0「编排甩给用户」反模式的调度切面闭合；今日流是 A1 `/today` 今日主缕（`...phase2-synthesis.md` §2.1）+ A2 `/practice` 流脊柱（§2.2）的统一数据源。
- frontier 升一等公民（递归 CTE，零新基建复用 prereq 边），冷启动空 frontier 有 LLM 填充兜底，新知学习路径不再无人定义（§4.5 冷启动空池缺口的调度侧落点）。
- 三约束（hard constraint post-filter + 留痕 + fallback）让 AI 编排在「到期必复习」不可违反的前提下自由出手，evidence-first / propose-only 红线延续，AI 挂了有确定性退化态。

**代价 / 风险**
- **这是推翻已锁决策的真重构，不是「接通」**（§6.1 F1 / §7.1 H2 裁决）：三套手抄收敛 + AI 真接入 variant-rotation seam + review_plan 退役是实打实的工程量，决策总账「不计代价」下不作否决理由但如实登记。
- **三约束具体形态欠规约**（§6.2 B6 升 blocker）：硬约束 post-filter 的裁剪/补齐规则、fallback 触发条件、mem0 prior 进 prompt 的权重契约（H5）落地前须定；先做确定性 fallback 兜底再叠 AI 层，硬约束走代码侧 post-filter 非 prompt 约束——否则 LLM 软化硬约束。
- **正交破口需代码 invariant 守**：C1（credit「进 p(L)」经 what 决策隐性裁掉 due 队列项）由 H8「到期项 hard constraint，只能改呈现不能删队列」落代码 invariant + 测试防住；C2/C3（mem0 经曝光偏置/confirmation loop 污染 p(L)）由 H5/H6 + 防循环注入五防守住。
- **空 frontier LLM 填充有效性天花板**（§6.5 E4）：冷启动期 LLM 猜古文知识点先后序无验证，临时边只做软建议不做硬 gating，先埋点测吻合率——古文为主科目下 frontier 填充质量是 known-limitation。
- **review_plan 退役需迁移**：`review_plan` job 注销 + ReviewPlanTask 退场 + 其窄 surface intent 迁入引擎，是一次性 migration + 测试覆盖；ADR-0029 decision 4 的 paper-channel 调用方须改读合并引擎产出。

## 备选（已否决）

- **保留 ADR-0029 双通道**（due 确定性队列 + review_plan AI paper channel 并存，Phase 0 §5 locked，Phase 1 建议不合并）——否决（§7.1 H2）：双轨不对账是 Phase 0 反模式的调度切面，单编排者一处产流才能闭合「编排收归 AI」主线。
- **review_plan 降为 proposer 长期保留**（不退役，作引擎前的一道独立 propose 步骤）——否决：合并引擎已通盘吃 5 输入，独立 review_plan proposer 与引擎职责重叠、徒增一层旁路，先降 proposer 只是过渡，终态直接退役。
- **FSRS *when* 数学并进 AI**（让 AI 一并决定复习间隔）——否决（决定 2）：FSRS 是 `R` 轴单一真相源（三轴正交红线），间隔数学并进 AI 会让 mem0/accuracy/credit 污染调度，破坏 ADR-0028 单 writer 契约。
- **FIRe 抵扣 due（B 面）**——否决（决定 6）：地基软（无学术论文）+ 耦合 R 制造信号混乱，违反三轴正交。
- **frontier 重建 ALEKS 全局 knowledge space**——否决（决定 4）：递归 CTE 复用已有 prereq 边即可，全局 knowledge space 是新基建，违背「零新基建」安心结论（决策总账综合主线）。
