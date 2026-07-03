# 单元 #4 frontier-gate — Research Dossier（synthesis）

- 打磨 program：YUK-538
- 单元：`learnable-frontier-gate`（master register `docs/design/2026-07-02-project-logic-master-register.md` line 366-379）
- main 基线：`0291987e`；关键相关 PR：#691（YUK-539，commits `8ef0917d`→`a75f9cb3`→`fde68fcf`→`2718a8a7`，已 merge）
- 三条 lane：code-ground / 学术文献 / 产品先例（OSS 源码）
- 红线复述：n=1 不拟合 item 参数；misconception/θ̂ 信号不写 mastery/p(L)/FSRS/difficulty；evidence-first 可追溯可回滚

---

## 单元与打磨目标

Register 对 `learnable-frontier-gate` 的原始 target shape（三条）：

1. `stream-store.ts:205` 应区分 overflow / sparse 两种运行态，overflow 时 log/emit；`frontier_fill_nightly.ts` 保持不动（已正确）。
2. 三个（当时认为）magic threshold（0.7 / 16 / 10k）应作为一个整体记录/决策，而非只谈 0.7。
3. `masteryTone` 的 0.67 与 `MASTERED_PL_THRESHOLD` 的 0.7 跨面不一致，需要显式决策（框定为跨面非紧急活 bug）。

Register line 368 对"Current shape"的描述（单一 0.7 标量门）已被 PR#691 事实性 supersede——这是三条 lane 一致确认的起点，本 dossier 据此重新定位"本单元现在还剩什么"。

---

## Code-ground（现状 + stale 标注 + 残留缺口）

### 已被 PR#691（YUK-539）覆盖，不要重做

- `FRONTIER_MASTERY_MIN_EVIDENCE = 4`（`src/capabilities/practice/server/learnable-frontier.ts:87`，PR#691 新增）+ `isMasteredForFrontier(mastery, evidenceCount)`（:91-93）= `mastery >= 0.7 && evidenceCount >= 4`，在 :254/:260-261 对 self 与每个 prereq **统一**应用（不再是裸 `pL(kc) >= 0.7`）。
- `MASTERED_PL_THRESHOLD = 0.7`（:65）补了警告注释（"never compare raw p(L) against this alone — use isMasteredForFrontier"），并记录了与 kg-borrowing borrow-branch 的交互点名（:78-85）。
- `frontier-read.ts`（`loadFrontierRail`，A5 S2/YUK-354）的 `isMastered()`（:103-112）同步从裸阈值换成 `isMasteredForFrontier`，self-not-mastered propose 过滤门（:125）同步吃 evidence floor。
- 关联单元 `pfa-plearn-formula`：`src/core/pfa.ts` `PFA_GAMMA 0.4→0.5`、`PFA_RHO -0.2→-0.25`（:64-65，保 2:1 比），docblock（:45-62）把"PHASE-DEFERRED 待 YUK-361 refit"的假声明换成"OWNER-FIXED PRIORS"诚实声明。**register `pfa-plearn-formula` Executive Summary #2（"β=0 时 3 连对翻 mastered 掉出 frontier pool"）现已闭合，但闭合机制不在 γ retune 里，而是 `learnable-frontier.ts` 的 `FRONTIER_MASTERY_MIN_EVIDENCE`**——pfa.ts 自身 docblock（:54-56）明说该场景"由 learnable-frontier 的 evidence-count floor 独立挡住"。核算：新 γ=0.5 下 3 连对 σ(1.5)=0.8176≥0.7（比旧 γ 更容易假触发），但 `evidence_count=3 < 4` 挡住。**这条闭合横跨两个 register 行，建议两处交叉引用。**
- `pnpm audit:relations` 实跑核验：`prerequisite` marker 在 `CONSUMER_REGISTRY` 标 `specialized`，无 STALE 报告，registry↔代码未漂移（唯一 DEAD 边是 `applied_in`，与本单元无关）。

### Register 三条诉求逐条判定（本次 code-ground 复核）

| # | 诉求 | 判定 |
|---|---|---|
| (1) overflow/sparse 区分 | **FRESH，仍是唯一实质 P1 残留**——`stream-store.ts:205` 本次核实仍调薄壳 `learnableFrontier(db)`（仅拿 `.ids`），overflow（递归闭包撞 depth/node-cap fail-safe，`FRONTIER_DEPTH_LIMIT+1`/`FRONTIER_NODE_CAP+1` 越界即 `{kind:'overflow', ids:[]}`，:222-224）与 sparse（空闭包，:227）被无差别坍缩成 `[]`，调用点周边（:201-217）零日志。`gh pr diff 691` 文件列表确认只碰了 3 个 `.db.test.ts` fixture 数值，未碰 `stream-store.ts` 生产代码。`frontier_fill_nightly.ts`（用 `learnableFrontierResolved`，按 `.kind` 分支，:224-225 计 `skipped_overflow`、:425 全量 log）确认依旧正确、未受影响。 |
| (2) 四阈值联合记录 | **底层诉求已被更好满足，字面诉求仍 OPEN**——四个常量（`MASTERED_PL_THRESHOLD=0.7`、`FRONTIER_MASTERY_MIN_EVIDENCE=4`、`FRONTIER_DEPTH_LIMIT=16`、`FRONTIER_NODE_CAP=10_000`）现在**各自**都有详实 docblock，register 原"0.7 undocumented"前提已不成立；但**没有任何单一 artifact 把四者作为一次联合决策交叉引用**，属低紧迫性风格项。 |
| (3) 0.67 vs 0.7 跨面 | **FRESH，且缺口比 register 写作时更宽**——`mastery-tone.ts:17-22` 阈值仍是 0.67/0.45，PR#691 未触碰。本次端到端追踪确认路由链路：`tree.ts`/`node-page.ts` 的 `getMasteryProjection()` → `KnowledgePage.tsx`(`n.mastery`)/`NodeDrawer.tsx`+`KnowledgeDetailPage.tsx`(`node.mastery`) → `MasteryRing.tsx`(`masteryTone`)——同一个 canonical `mastery` scalar 同时喂 render tone（0.67 门槛，一维）和 frontier gate（0.7 AND evidence≥4，PR#691 后已是二维）。一个 prereq KC 可以 UI 显示"good"（mastery≥0.67）同时因 `evidence_count<4` 仍未满足下游 frontier 门——**register 原本框定的"解决两个数字"现在实质是"解决两个数字 + 一个 evidence 维度的可见性缺口"**。 |

其它 register 表述新鲜度：line 368"Current shape"描述已 **stale**（门谓词已是复合判据，非单一标量比较）；line 371/372 的 overflow 定位纠错（指向 `stream-store.ts:205` 而非 nightly job）**依旧准确**；line 374"route-handler not traced end-to-end"置信度脚注**本次已端到端追踪确认**，可上调为 confirmed。

### 与 mastery/θ̂ 耦合、与 topology-gate 的关系（供设计相评估红线合规性）

- `pL()`/`evidenceOf()` 都读同一个 `getMasteryProjection()`（`state.ts`）。冷启动无 `mastery_state` 行 → `COLD_START_PL=0.5` + 隐式 `evidence=0`（`?? 0`，:248）→ 天然挂在 floor 下，保守正确。
- **kg-borrowing 交互**：借值分支显式写 `evidence_count: 0`（`state.ts:573`，本次核实），且 `GRAPH_LAPLACIAN_ENABLED`/`PREREQ_THETA_PROPAGATION_ENABLED` 当前**都是 `false`**（`graph-laplacian.ts:56`/`prereq-propagation.ts:57`），故该耦合今日不可达；`FRONTIER_MASTERY_MIN_EVIDENCE` docblock（:78-85）已把这条 forward-looking 依赖自文档化（"once either flag flips, a borrowed prereq can NEVER pass this floor — deliberate coupling to flag"），但**没有绑定到任何 tracked trigger**（Linear/PLAN.md）——只是行内注释级提醒，flag 翻转时容易被遗忘重新发现。**此点是 code lane 独家发现，lit/OSS 两条 lane 均未涉及。**
- `topology-gate.ts`（ADR-0034 §2）是**写时**结构一致性门（仅对 `prerequisite` 边做自环/方向矛盾/环/传递冗余四检，单趟 O(E)），`learnable-frontier.ts` 是**读时**门（对已落库边做递归闭包，自带独立环防御：anchor-guard + SET walk + depth/node cap fail-safe），**不依赖**前者已清图的假设——纵深防御，两层各自正确 scope，PR#691 未触碰 `topology-gate.ts`，无耦合缺陷或漂移。

### 残留缺口清单（code lane 汇总）

1. **[P1，唯一实质缺口]** `stream-store.ts:205` 静默折叠 overflow/sparse，composer 调用点零可观测性。
2. **[P2，未闭合]** `masteryTone`(0.67/0.45) vs `MASTERED_PL_THRESHOLD`(0.7)+`FRONTIER_MASTERY_MIN_EVIDENCE`(4) 跨面不一致，需 owner 显式决策；范围因 evidence-floor 新增而变宽。
3. **[P3/backlog，未变]** 0.7 阈值的 calibration-replay（`audit:calibration` report-only）——预期大概率 `INSUFFICIENT`（稀疏图），维持原判定不升级。
4. **[风格/低紧迫，部分闭合]** 四阈值联合记录字面诉求未满足（个体文档化已充分）；可作轻量 follow-up（`learnable-frontier.ts` 顶部加一段交叉引用四常量的联合注释），纯 docs 动作。
5. **[新浮现，非阻塞]** `FRONTIER_MASTERY_MIN_EVIDENCE` 的 borrow-branch 前瞻耦合无 tracked trigger，建议与 `kg-borrowing-prereq-propagation-sprawl` register 单元的最终 remediation 交叉引用，非现在动代码（两个 flag 目前都是 `false`，无 live 触达路径）。

### 改动面预估（code lane）

- **残留项 1（overflow 日志）**：触碰 `stream-store.ts`（把 `learnableFrontier(db)` 换成 `learnableFrontierResolved(db)`，按 `.kind` 分支）+ `stream-store.db.test.ts`（补 overflow 路径断言）。风险低，加性改动，`dense`/`sparse` 路径行为不变，仅 `overflow` 分支新增可观测性输出。预估 ~10-20 行 diff + 1-2 条新测试，单文件，无 schema/migration。若选择往 `composeDailyStream` 返回值加 warning 字段，需额外检查所有消费该返回值的调用点（目前看只有 route handler 直接透传给前端）。
- **残留项 2（0.67/0.7 决策）**：需先有 owner 决策再定改动面。若只对齐数值：单常量 + 测试快照，改动面小。若要把 evidence-floor 维度也在渲染侧可见（类似 FrontierRail 的"建议·低置信"视觉态）：触碰 `MasteryRing.tsx`、`mastery-tone.ts`（或新增复合状态函数）+ 四个消费点（`KnowledgePage.tsx`/`NodeDrawer.tsx`/`KnowledgeDetailPage.tsx`/`MeshGraph.tsx`，目前只传 `mastery` 标量，需额外传 `evidence_count`），改动面中等（~50-100 行，跨 5-6 文件），**且会触发 CLAUDE.md「UI Design Compliance」pre-flight**（动手前需先做 design-doc 逐字引用 + 组件类型声明）。

### 核心文件锚点

`src/capabilities/practice/server/learnable-frontier.ts:41-93,124-227,254-265`；`src/capabilities/practice/server/stream-store.ts:201-217`（residual）；`src/capabilities/knowledge/jobs/frontier_fill_nightly.ts:217-225,424-425`（已正确未变）；`src/capabilities/knowledge/server/frontier-read.ts:103-112,125`；`src/capabilities/knowledge/ui/mastery-tone.ts:17-22`（residual）；`src/core/pfa.ts:45-65`；`src/server/mastery/state.ts:427-573`（borrow-branch）；`src/capabilities/knowledge/server/topology-gate.ts:1-52`；`src/capabilities/practice/server/softmax-selection.ts:93-96`；PR#691 = commits `8ef0917d`/`a75f9cb3`/`fde68fcf`/`2718a8a7`（YUK-539，已在 main）。

---

## 文献（带权威分级）

### 方向① 知识空间理论（KST）—— fringe / outer-fringe

1. **Doignon, J.-P. & Falmagne, J.-C. (1985). "Spaces for the Assessment of Knowledge." *International Journal of Man-Machine Studies*, 23, 175–196.** 一手奠基论文，peer-reviewed 期刊，KST 领域创始文献。定义"outer fringe"= 状态 K 之外、加入后仍构成合法知识状态的 item 集合——即"学生现在准备好学的东西"，是 frontier-gate 概念的**数学原型**（AND-closure 判据的理论源头）。局限：原始判据是确定性集合成员判据，前提是知识结构已被大样本实证校验；不直接回答"用概率化 p(L) 阈值近似 fringe 时阈值该定多少"。
2. **Falmagne, J.-C. & Doignon, J.-P. (2011). *Learning Spaces*. Springer.** 权威专著（1999 版 *Knowledge Spaces* 修订扩展）。**Fringe Theorem**（Thm 4.1.7）：知识状态由 inner fringe + outer fringe 唯一确定，形式化"outer fringe = ready to learn"。仍是纯拓扑/组合判据，不涉及概率阈值或证据量。
3. **Cosyn, E., Uzun, H., Doble, C. & Matayoshi, J. (2021). "A practical perspective on knowledge space theory: ALEKS and its data." *Journal of Mathematical Psychology*, 101, 102512.** peer-reviewed 期刊（数理心理学领域旗舰期刊，Elsevier），**作者含 ALEKS 内部研发团队——利益关联需注意**，但非 preprint，已在 Elsevier 索引页确认发表信息。**关键实证数据**：outer fringe（"ready to learn"）item 在**初次遇到时**正确率仅约 **27%**（outer layer 1），越往外层越低趋近 0。**直接纠正常见误读**："in outer fringe" ≠ "大概率能答对"，而是"结构上可达"——frontier 是拓扑可达性信号，非表现预测信号，与本项目"misconception/θ̂ 信号不能等同 mastery/p(L)"红线同构。
4. **ALEKS 官方页（aleks.com/about_aleks, /about_aleks/knowledge_space_theory）** 厂商一手材料，**非独立 peer-review，明确降权**。声称"当 ALEKS 判定 ready to learn 时，实际掌握成功率 ≥90%，部分课程>95%"——但这是**学习模式（练习之后）最终掌握成功率**，与③的"27% 初遇正确率"是**不同的量**（zero-shot vs 最终习得），不矛盾但引用时须标注清楚衡量的是哪个阶段。标记 **UNVERIFIED-independent-replication**。
5. Wikipedia "Knowledge space" 条目——三级来源，仅用于定义交叉核对，不作为结论依据。

### 方向② 前置图上的 mastery 传播与解锁判据（BKT/DKT × prerequisite gating）

1. **Corbett, A.T. & Anderson, J.R. (1994). "Knowledge Tracing: Modeling the Acquisition of Procedural Knowledge." *User Modeling and User-Adapted Interaction*, 4, 253–278.** BKT 奠基一手论文，peer-reviewed（UMUAI/Springer），领域高引用（具体数字未独立核验）。四参数模型 p(L₀)/p(T)/p(S)/p(G)，本身不规定操作阈值。
2. **行业惯例阈值 0.95**：多篇二手/综述交叉印证（非单一一手论文，如实标注）——Cognitive Tutor / Carnegie Learning 传统上用 **p(mastery) ≥ 0.95** 作"停止练习/mastered"操作阈值；**Schmucker et al., arXiv:2205.02333**（preprint，降权）实验设置沿用 `Threshold(0.95)`，印证近年仍是事实标准。**本单元最值得设计 doc 正面回应的一条**——项目 `MASTERED_PL_THRESHOLD=0.7` 明显低于该惯例，但目前 docblock 未正面解释差距理由（frontier-readiness vs mastery-retirement 是否为不同决策点，需显式写明）。
3. **Chen, P., Lu, Y., Zheng, V.W. & Pian, Y. (2018). "Prerequisite-Driven Deep Knowledge Tracing." *ICDM 2018*, 39–48.** peer-reviewed 会议论文，ICDM 为数据挖掘领域 CCF-B/高认可度会议，已被多篇后续论文引用。验证"用前置关系约束/门控 mastery 估计"方向本身活跃有效，但该论文做的是**训练期模型约束**（影响参数估计），非**推断期硬门**（本项目 frontier-gate 属于后者），不能直接搬阈值。
4. **Cen, H., Koedinger, K. & Junker, B. (2008). "Comparing Two IRT Models for Conjunctive Skills." *ITS 2008*, LNCS 5091, 796–798. Springer.** peer-reviewed 会议论文（ITS 是 AIED/ITS 核心会议），作者含 Koedinger（CMU，领域权威）。对比 AFM（可补偿式）与 CFM（合取式）在多技能条目上的拟合，实验显示 **CFM 与 AFM 至少同等好、多数更优**。**直接支撑本项目现有的 ALL-前置-AND 判据设计**——此前 register/代码注释均未引用到这层文献支持，值得设计 doc 补一笔。
5. **Slater, S. & Baker, R.S. (2018). "Degree of error in Bayesian knowledge tracing estimates from differences in sample sizes." *Behaviormetrika*, 45(2), 475–493.** peer-reviewed 期刊（中等偏权威，领域内被引用作样本量-可靠性标准引用）。BKT 参数估计误差随样本量 ~1/√n 衰减（平滑曲线，无锐利拐点）；操作性转述（经 Botelho/Baker EDM'21 引用链）——**BKT 不应在每个技能少于约 3 次练习机会时被认为可靠拟合**。**是 `FRONTIER_MASTERY_MIN_EVIDENCE=4` 最接近的文献锚点**，但须标注两处不完全对应：(a) 研究的是**群体层面** BKT 参数拟合可靠性，非**单个学习者的 point-estimate 可信度**（本项目 n=1 场景的真实决策对象）；(b) "≥3" 是经验性 rule-of-thumb，非理论最优解——n=4 比 rule-of-thumb 更保守 1 单位，属"与文献相容、非文献直接推导"。
6. **Coetzee, D. (2014). "Choosing Sample Size for Knowledge Tracing Models." CEUR Workshop Proceedings, BKT20y Workshop @ EDM 2014, 117–121.** workshop 论文，**peer-review 程度较弱，标注降权**，但被后续正式论文引用为实证起点。误差标准差 ~n^(-0.5)。与⑤同源支撑"n=4 是曲线上合理但非唯一正确取点"，不单独提供新结论。

### 方向③ ZPD（最近发展区）操作化

1. **Vygotsky, L.S. (1978). *Mind in Society*. Harvard University Press.** ZPD 概念创始来源，但是编译/翻译合集（非单篇 peer-review），定性隐喻性表述，**不含任何数值操作化**。只能作概念溯源引用，不能为任何具体阈值背书。
2. **Wood, D., Bruner, J.S. & Ross, G. (1976). "The Role of Tutoring in Problem Solving." *Journal of Child Psychology and Psychiatry*, 17(2), 89–100.** peer-reviewed 期刊，"scaffolding"概念经典一手论文，引用量级达数千（近似值未核验）。脚手架应"随能力提升逐步撤除"（动态支持撤除），与项目当前"一次性静态二值门"设计存在哲学取向张力（非错，是简化）。
3. **Murray, T. & Arroyo, I. (2002). "Toward Measuring and Maintaining the ZPD in Adaptive Instructional Systems." *ITS 2002*, LNCS 2363, 749–758. Springer.** peer-reviewed 会议论文（经 ERIC 综述文 EJ1081990 转述确认存在与方法）。ZPD 判据拆两层——mastery criterion（"M-out-of-P"式，可替换、非强求某数字）+ challenge-level criterion（从失败/提示频次推断）。说明学界普遍采用宽松可替换经验判据，非声称理论最优——与项目"0.7/evidence-4 是 owner-fixed 常数、非拟合值"立场方法论气质一致。
4. **Wilson, R.C., Shenhav, A., Straccia, M. & Cohen, J.D. (2019). "The Eighty Five Percent Rule for Optimal Learning." *Nature Communications*, 10, 4646.** peer-reviewed 高影响力期刊（多学科顶级，高 IF），理论推导+三重仿真验证+既往动物学习文献回溯校验一致。二分类梯度下降学习算法最优训练**错误率**约 15.87%（准确率约 85%）时学习速率最大。**权威等级本次调研最高、方法最严谨，但构念粒度不匹配**：衡量的是"已在做某任务时逐题成功率该多高"（session 内/item 级配速），frontier-gate 回答的是"KC 整体该不该纳入可学池子"（topic 级门控）——**若被用来为 frontier 阈值背书是范畴误用，需明确拒绝**；真正适用落点是 practice-selection/难度配速层，非本单元。
5. 二手/综述来源（仅佐证"ZPD 缺乏数值共识"元判断，不作结论依据）：`files.eric.ed.gov/EJ1081990`、`simplypsychology.org`、`structural-learning.com`——多源交叉指出 ZPD"measurement problem"是学界公认批评点。

---

## 产品先例（带一手引用）

### Oppia（`oppia/oppia`）—— 一手源码

`core/domain/story_domain.py` `StoryNode`（`prerequisite_skill_ids`/`acquired_skill_ids`，单跳手工声明）+ `core/domain/story_services.py::validate_prerequisite_skills_in_story_contents(...)`：对 story node 图做 BFS，维护累积集合 `simulated_skill_ids`，到每个 destination node 断言 `prerequisite_skill_ids ⊆ simulated_skill_ids`，否则**在 story 保存时**抛 `ValidationError`；同时 `is_node_visited` 禁止环。**这套一致性校验跑在内容作者保存 story 时（写时/慢路径），不是运行时按学习者即时状态算**。运行时解锁只是 `record_completed_node_in_story_context` 记账，不重算前置。（Skill 侧另有独立 `degree_of_mastery`/`SkillMasteryModel`，本轮未展开验证，不作已核实结论。）
**适配判断**：不存在"递归闭包+overflow fail-safe"问题，因为一致性证明一次性做在人工/慢路径；与本项目"AI 持续增量产出 knowledge_edge、图在活着生长"场景根本不同，不能直接照搬，但揭示"写时校验/物化，读时只读结果"这一可选设计轴。

### Open edX（`openedx/openedx-platform`）—— 一手源码

**Subsection gating**：`lms/djangoapps/gating/api.py::evaluate_prerequisite` → `openedx/core/lib/gating/api.py::update_milestone`——按 `min_score`/`min_completion` 判定，阈值**由课程作者在 Studio 逐 gate 填写**（`_validate_min_score` 只校验 0-100 整数区间），非全局 magic number。**Fail-closed 默认**：`_get_minimum_required_percentage` 若 requirements 缺失/畸形，`min_score`/`min_completion` 默认 **100**（要求满分才算过），非默认 0——"宁可锁死不误放"，与本项目"overflow → fail-safe 到 `[]`"同一哲学（宁可空不给半成品），但取值方向相反（他们默认最严，我们默认最空）。
**课程级前置**：`common/djangoapps/util/milestones_helpers.py` + `edx-milestones` 子系统——课程完成二元全有全无，`fulfills` 关系一旦达成即 `add_user_milestone`，**不是递归 SQL 闭包实时算出来的，而是事件驱动物化写库**，多跳链靠链式物化状态自然传递，从不在读路径做 transitive walk。
**适配判断**：gating 子系统完全不存在"递归闭包"概念——单跳评估 + 事件驱动物化。这是本项目 `stream-store.ts:205` 问题的一面镜子：我们选"读时 SQL `WITH RECURSIVE` 现算闭包 + fail-safe-to-empty"，Open edX 选"写时物化每一跳，读时只读已存事实"——后者天然没有 overflow 失效态（从不在读路径无界遍历）。不是我们选错（实时闭包换取"新边落地即生效、无需额外物化 job"的简单性，n=1 场景合理 tradeoff），但明确"triple threshold + overflow fail-safe"复杂度是"选择实时闭包而非物化"架构决策的代价，非可调参消掉。阈值治理方式（per-gate 人工输入）不适用本项目（n=1 场景"作者"=owner 自己，per-gate 手填维护成本远高于全局 code const）。

### 老 Khan Academy（`avh4/khan-academy`，2012 年 GAE 主站 hg 仓库第三方镜像）—— 一手源码，**需显式标注：历史/已下线，非当前产品**

镜像可信度说明：`Khan/khan-exercises`（官方现存，README 自述已 deprecated）只含前端渲染框架；`beneater/kmap-editor`（前员工个人工具）只含知识图编辑器 UI，无阈值逻辑。真正解锁算法在当年短暂开源、后转私有的 GAE 主站代码，`avh4/khan-academy` 是第三方 git 镜像，**2012 年快照，与当前产品行为可能严重脱节**，仅作历史参考。
**机制**（`models.py:104-250,2139-2420`，`consts.py` 全文）：`Exercise.prerequisites`（单跳手工声明）+ 两套 proficiency 模型——(a) **streak 模型**：`REQUIRED_STREAK=10`（连对 10 题算 proficient，答错清零，但展示层 `STREAK_RESET_FACTOR=0.25` 软化进度条只回退到 75%）——底层严格、UI 层软化，是"底层判据≠展示判据"分裂的又一先例；(b) **accuracy 模型**：`AccuracyModel`（IRT 风格）+ `PROFICIENCY_ACCURACY_THRESHOLD=0.94` + `_MIN_PROBLEMS_FROM_ACCURACY_MODEL`（从阈值反推最小观测题数下限）+ `MIN_PROBLEMS_IMPOSED=5`（无论走哪个模型都至少做够 5 题才有资格被判 proficiency）——**与本项目 `FRONTIER_MASTERY_MIN_EVIDENCE=4`（p(L) 达阈但 evidence 不够不算数）几乎同构的先例**，是外部产品史上确有先例的强佐证。
"learnable frontier"直接对应物：`UserExerciseGraph.generate`（`models.py:2308-2420`）——整张 exercise 图（几百节点）一次性载入内存，跑两遍带记忆化的递归 DFS：①`set_implicit_proficiency`——**是 kg-borrowing 单元的直接先例**：从未做过的题也可能被判"隐式 proficient"，条件是自身 streak==total_done 且存在 proficient 的"覆盖祖先"，纯靠继承不看自身直接证据；cycle 安全靠 sentinel（递归入口先置 `False`，二次调用因非 `None` 短路），不用深度/节点上限（图本就有界）。②`set_suggested`——该不该推荐学，条件自身未 proficient 且无已 suggested 的覆盖祖先吸收且**全部直接**（非递归传递）prerequisite 已 proficient——只查直接前置的已缓存布尔值，**没有对 prerequisite 再做一次递归闭包**，多跳传递性靠第①遍已把每节点算成含链路影响的布尔值隐式满足。
`consts.py` 治理：十几个阈值全部模块顶层具名常量+单行注释紧邻放置，**与本项目 `learnable-frontier.ts` 顶部"具名 export const + docblock"治理形状几乎一致**。
**适配判断**：同样不存在 overflow 失效态——非设计更好，而是问题规模天然有界（人工编排固定课程树，几百节点）。再次印证"overflow-fail-safe 问题族是图无界增长+读时现算闭包组合的必然产物"；对应地，本单元 P1 修法（让 fail-safe 触发时可观测而非静默）是最小正确修法，"消灭 overflow 概念"需换架构（物化/常驻内存/图加边界），代价远超本批次范围，不建议做。

### ALEKS —— 官方发表论文（二手；Falmagne, Cosyn, Doignon, Thiéry, *"The Assessment of Knowledge, in Theory and in Practice"*, aleks.com/about_aleks/Science_Behind_ALEKS.pdf；作者含两位 ALEKS Corporation 员工）

基于 KST，"outer fringe"（论文原文用此名，与本模块名 `learnable-frontier` 概念直接对应）定义：给定当前知识状态 K，outer fringe = 所有满足 `K∪{p}` 本身也是知识结构 𝒦 里合法可行状态的问题 p——比"p 的全部直接前置都在 K 里"严格得多，𝒦 是从大量真实学生作答数据统计推导+专家访谈校准出的完整组合结构（例：仅"Arithmetic"一域 108 题型就有 **57,147** 个合法状态；Beginning Algebra 约 6 万状态、数十亿合法学习路径）。评估过程纯 Bayesian：对全部候选状态维护似然分布，每题选信息量最大的（预计答对概率接近 50%），停止判据是**双条件**（熵降到临界值以下 **且** 无信息量足够大的候选题）——非单一固定标量阈值，实际案例（Fig. 8）平均约 24 题定位唯一知识态。治理方式：初版靠专家访谈构建，随后**必须**用大规模真实作答数据经验校正（验证指标：预测 vs 实际相关系数目标 0.7-0.8），声明"几千用户"级数据积累是必要前提。
**适配判断**：整套验证方法论（专家结构+大样本经验校正）与本项目 n=1/不拟合 item 参数红线**直接冲突**，不能整体照搬。唯一可迁移、且本项目已在做的子集：退化到"人工声明先决 DAG+单跳传递闭包"这个特例（当知识结构恰好由简单前置图生成时，outer fringe 退化成"全部直接前置都在 K 里"，即本项目当前做法）。**一个值得注意的强设计信号**：论文开篇批判"一两个数值分数代表学生能力"不精确，其成果展示形式（Table 2）刻意只给两份问题清单（内圈"会什么"+外圈"该学什么"），**完全不展示任何单一数值 mastery 分数**——对"单一标量阈值驱动 UI 展示"这类设计的明确批判先例，对 0.67-vs-0.7 跨界面阈值不一致是有分量的旁证：根因（同一 p(L) 被两条独立阈值线切两刀）本身就是 ALEKS 设计哲学会点名批评的模式。

### Duolingo —— 官方 Engineering Blog / 发表论文（二手）

已核实一手来源：Settles & Meeder（ACL 2016，"A Trainable Spaced Repetition Model for Language Learning"，Half-Life Regression）+ 官方 blog 复述——per-word/skill"半衰期"h，`p=2^(-Δ/h)`，h 由回归模型个性化估计、持续更新非固定阈值，驱动**review 调度轴**，非"下一个 skill 何时解锁"轴。`blog.duolingo.com/.../introducing-birdbrain/`（官方，2020）：Birdbrain 用内部 ML 模型估计 proficiency 挑"难度刚好"练习——**未公开具体模型形态/阈值数字**（第三方转述提到借鉴 IRT/logistic regression，属二手中的二手，不作已核实结论）。**Skill tree "下一行何时解锁"机制本轮未能在官方来源找到直接说明**——唯一线索是第三方社区 wiki（"完成本行全部 skill 到 Level 1 才解锁下一行"），**未经官方信源核实，明确标注未核实**。
**适配判断**：已核实官方材料呈现一致结构性分工——复杂概率/IRT 模型（HLR、Birdbrain）严格限定在**已解锁内容内部**决策（复习时机、练习难度），无官方材料显示该模型被用作"整个新 skill 要不要解锁"判据。与本项目已有原则（"Topology 在 SQL、mastery 判据在 TS、不在 SQL 里重编码 PFA"）方向一致：结构/拓扑层与点位达标层分开，复杂概率估计不越界决定结构层问题——独立观察到的可信设计惯例（证据链比 ALEKS/Khan/Open edX 略薄）。

---

## 三腿冲突与一致点

### 一致点（三腿独立收敛，互相印证）

1. **P1 是唯一实质残留、三腿零异议**：`stream-store.ts:205` 静默坍缩 overflow/sparse 是三条 lane 独立到达的共同判定；OSS lane 补充"Oppia/Open edX/Khan 三家的架构选择使它们根本不存在这个问题类别，没有一家把两种运行态坍缩成同一空结果、零日志"，作为外部先例对该判定的加固。
2. **evidence-floor（n=4）有独立外部先例支持，且与文献方向一致**：lit lane（Slater & Baker 2018，"≥3"经验 rule-of-thumb，群体层面 BKT 拟合可靠性）与 OSS lane（老 Khan `MIN_PROBLEMS_IMPOSED=5` + `_MIN_PROBLEMS_FROM_ACCURACY_MODEL`）**各自独立找到的两条先例互相印证同一个模式**——"阈值达标但样本/证据量不够则不算数"，且都明确标注了构念不完全对应（前者是群体统计可靠性非单用户 point-estimate；后者阈值/场景不同但结构同构）。这是本次调研里最强的三腿汇聚点之一，但值得注意：#2（YUK-539/PR#691）已经独立实现了 evidence floor，这两条先例是**事后补强**，非事前指导，不改变已 ship 的设计，只增加文档依据。
3. **ALL-prereq-AND（合取）判据被正面支持**：lit lane 引 Cen/Koedinger/Junker（2008）CFM 实证优于/至少同等于 AFM；OSS lane 的老 Khan `set_suggested` 同样是"全部直接前置已 proficient"的合取判据。两条独立来源都支持现有设计不需要改成加权/补偿式。
4. **0.67/0.7 跨面问题的"非紧急、需决策"定性一致**：code lane 判定为 P2 未闭合且范围因 evidence-floor 新增变宽；OSS lane 用 ALEKS 论文"拒绝单一数值展示"的设计哲学作为旁证支持"这不是我们独有的坏味道，但确实值得显式决策"；三腿都不建议立即代码改动，只建议决策/文档。

### 冲突与需要显式裁决的分歧点（不抹平）

1. **"frontier 是否等价于容易/高正确率"上，lit lane 与直觉/OSS lane 的默认假设有张力**：lit lane 明确指出 Cosyn et al.（2021, JMP）实证——outer fringe 初遇正确率仅约 27%，frontier 是拓扑可达性信号非表现预测信号；OSS lane 在讨论 ALEKS/Khan 先例时未触及这层区分（聚焦于"门的形状"而非"门内题目难度分布"）。**这不是两条 lane 相互矛盾的结论，而是 lit lane 提出了一个 OSS/code 两条 lane 都未曾检验的隐含假设风险**——若后续设计 doc 或 UI 文案（如 FrontierRail 卡片）暗中假设"进 frontier 的题应该更容易/正确率更高"，lit lane 的证据明确不支持，需要在设计阶段主动排查这个假设是否已经渗入现有 UI 文案或 composer 优先级逻辑（三条 lane 均未逐一核查现有 FrontierRail UI 文案是否已含此类隐含承诺，这是一个遗留的核查缺口）。
2. **ALEKS 来源深度不对等，两条 lane 引用了不同权威层级的 ALEKS 材料，未互相校对**：lit lane 主要引用 ALEKS **官方营销页**（aleks.com/about_aleks，明确标注"厂商材料，非独立 peer-review，降权"）得到"90-95% 最终掌握成功率"这个数字；OSS lane 引用的是 **ALEKS 官方发表论文**（Science Behind ALEKS PDF，作者含 ALEKS Corp 员工但是正式发表的方法论文档，含 57,147 状态空间、Bayesian entropy 停止判据等定量细节），权威层级明显更高、细节更丰富。两条 lane 各自独立完成调研、未交叉引用对方的 ALEKS 来源，因此**这不是矛盾而是互补缺口**——设计 doc 引用 ALEKS 相关结论时应优先用 OSS lane 找到的官方论文（层级更高），营销页数字（90-95%）仅在明确区分"这是最终掌握成功率、非初遇正确率"的前提下谨慎使用，且不应与 lit lane 独立发现的 Cosyn et al. 27%（真正 peer-reviewed 期刊来源）混为同一构念。
3. **对"是否需要重新审视 0.7 阈值本身"的紧迫性判断，lit lane 略强于 code/OSS 两条 lane**：lit lane 把"0.7 vs BKT 惯例 0.95"列为"本单元最值得设计 doc 正面回应的一条"（近乎主动建议动作）；code lane 把同一问题归入"P2，未闭合，非紧急"；OSS lane 未独立提出 0.95 这个数字，但用 Khan 的 `PROFICIENCY_ACCURACY_THRESHOLD=0.94` 间接印证了"行业惯例确实更接近 0.94-0.95"这一事实，语气上偏向"值得记录差距理由"而非"需要重新调值"。**三腿在"要不要写一段解释"上一致，但在紧迫度措辞上有梯度差异**，设计相裁决时不应默认取最强（lit lane）或最弱（code lane）的措辞，需明确表态。
4. **OSS lane 提出了一个 code/lit 两条 lane 都未讨论的架构级反事实**："overflow-fail-safe 问题族本质是'图无界增长+读时现算闭包'架构选择的代价，Oppia/Open edX/Khan 均通过写时物化或有界图规避了这整个问题类别"。这不是对 P1 修法本身的反对（OSS lane 明确说"不建议在本单元里做"架构级改动），而是一个**未被 code lane 的改动面预估提及的备选方案维度**——code lane 只给了"在 composer 路径加 log/分支"这一种修法的成本估算，没有讨论"要不要在 nightly job 里捎带物化 frontier 状态、composer 只读物化结果"这个可能更根本但更贵的替代方案。设计相如果只看 code lane 会漏掉这个已经被 OSS lane 提出又主动否决的选项——**需要显式记录"考虑过、否决"，而非默认没考虑过**。

---

## 设计相输入（净指引 + 开放问题 + 建议的对抗验证角度）

### 净指引（三腿收敛，可直接采纳）

1. P1（`stream-store.ts:205` overflow/sparse 区分 + log）是本单元唯一应该现在做的代码改动，三腿零异议；`frontier_fill_nightly.ts` 保持不动。改动面：单文件 + 测试，~10-20 行，低风险，若加 warning 字段需检查所有 `composeDailyStream` 返回值消费点。
2. 不建议为规避 overflow fail-safe 而做写时物化/架构级改动（OSS lane 已提出又主动否决，code lane 未独立考虑过但结论一致）——这是"考虑过、代价超本批次范围"，非遗漏。
3. `FRONTIER_MASTERY_MIN_EVIDENCE=4` 与 ALL-prereq-AND 合取判据两个已 ship 的设计决策，均有独立文献 + 独立产品先例双重支持，无需改动，只需在设计 doc/代码注释里把这两条外部依据显式引用一次（提升可追溯性，不改行为）。
4. 四阈值（0.7/4/16/10k）联合记录、0.67/0.7 跨面决策：三腿一致认为这是"需要一次显式决策/文档动作"，不是"需要立即改代码"；后者若升级为 UI 改动需先过 CLAUDE.md UI pre-flight。

### 开放问题（需要设计相/owner 裁决，三腿均未拍板具体方案）

1. **P1 的具体接口设计**：`stream-store.ts:205` 区分 overflow/sparse 后，是纯 server-side log（最小方案），还是要把 warning/kind 信息传播进 `composeDailyStream` 返回值供前端/composer 消费（需要额外排查所有下游消费点）？三腿都指出这是唯一残留代码工作，但都没有给出接口形状的推荐。
2. **0.67 vs 0.7 跨面阈值的裁决方向**：(a) 对齐数值（谁向谁靠拢，且靠拢到哪个值——0.67？0.7？还是都改成介于两者或对齐 BKT 惯例的第三个数？）；(b) 保留两条独立阈值 + 补一段"分工理由"注释（最小方案，OSS lane 用 ALEKS 论文旁证支持"这本身可以保留，但要显式记录"）；(c) 把 evidence-floor 维度也在 UI 层暴露（`MasteryRing` 加类似 FrontierRail"建议·低置信"视觉态，改动面中等且触发 UI pre-flight）。三腿均未给出推荐选项，且方案 (c) 的必要性本身依赖于开放问题③的排查结果。
3. **`MASTERED_PL_THRESHOLD=0.7` 是否需要正面回应 BKT 领域惯例 0.95（及 Khan 的 0.94）**：是仅在 docblock 补一句"frontier-readiness ≠ mastery-retirement，二者故意不同，理由是 X"（纯文档，lit/OSS 两条 lane 倾向的方案），还是需要更进一步的显式论证/甚至重新评估数值本身（lit lane 措辞更强，但未主张真的调值）？0.7 本身的数值合理性不在本单元的既定 target shape 内，需要设计相明确"本轮只补文档，不重新拟合数值"或反之。

### 建议的对抗验证角度

1. **对抗"frontier=容易/高正确率"隐含假设**：逐一核查现有 FrontierRail UI 文案（`frontier-read.ts`/相关 UI 组件）与 composer 侧的优先级/展示逻辑，是否已经隐含承诺"frontier 里的题更容易/正确率更高"。如果有，需要依据 Cosyn et al.（2021, JMP）的 27% 初遇正确率实证改措辞或优先级逻辑；如果没有，在设计 doc 里显式记录"已核查，无此假设"，防止未来渗入。
2. **对抗 Cosyn 2021 的可类比性本身**：ALEKS 的 27% 数字来自大规模题库+统计校验过的知识结构（几万到几十万合法状态空间），本项目前置图是 AI 生成、n=1、未经统计校验的边。质疑：这个具体数字（27%）能否类比到本项目，还是只能借用"frontier≠预期高正确率"这个定性结论、拒绝引用具体百分比？建议设计 doc 只采纳定性结论，明确拒绝把 27% 当作本项目的可比基准值。
3. **对抗"三腿都认为不需要新代码"这个共识本身的盲点**：code lane 独家发现的 kg-borrowing 前瞻耦合（`FRONTIER_MASTERY_MIN_EVIDENCE` 的 borrow-branch 依赖，`state.ts:427-573`，目前只是行内注释级提醒，未绑定 tracked trigger）未被 lit/OSS 两条 lane 触及。质疑：这个"三腿共识"是否只是因为另外两条 lane 没去看这段代码，而非真的验证过它不需要现在处理？建议：即便暂不改代码（两个 flag 目前均为 `false`，无 live 触达路径，核实确认），也应该现在就把"`GRAPH_LAPLACIAN_ENABLED`/`PREREQ_THETA_PROPAGATION_ENABLED` 翻转时必须重新审视 evidence-floor 语义"这个 trigger 显式钉进 Linear 或 `PLAN.md`（而非仅留代码注释），并在 `kg-borrowing-prereq-propagation-sprawl` register 单元的最终 remediation 里交叉引用，防止 flag 翻转时被遗忘重新发现。
4. **对抗 OSS lane 否决的"写时物化"方案是否真的成本过高**：OSS lane 的否决基于"架构级改动，代价远超本批次范围"的定性判断，未给出具体改动面估算。若设计相认为这个方向值得认真评估（而非直接采信否决），可以用一个具体反例攻一下：`frontier_fill_nightly.ts` 本身已经在做全量重算（`:60,127,141,146,164` 一路调用 `learnableFrontierResolved`），是否可以捎带把 frontier 状态物化到一张表，composer 路径只读物化结果、彻底不需要 overflow fail-safe？如果这个方案的边际成本实际很低（因为 nightly job 已经在算），否决理由需要重新论证；如果确实高（例如物化状态的陈旧度/一致性代价），则应把否决理由显式写入设计 doc 而非仅停留在本次调研的口头判断。

---

**Linear 捕获门**：本单元两个剩余动作（P1 composer 路径 overflow 日志、P2 三重阈值+0.67/0.7 决策归档）已在 master register `learnable-frontier-gate` 条目里是既定 target shape，本次三腿调研未发现需要新开的独立 Linear follow-up；kg-borrowing 前瞻耦合的 tracked-trigger 缺口（对抗验证角度 3）建议在设计 doc 落地时一并登记到 `kg-borrowing-prereq-propagation-sprawl` 单元或新开一条轻量 Linear sub-task，不在本 dossier 阶段抢先创建。

---

## P1 回填：UI 文案核查 + ALEKS 双源校对（2026-07-03）

只读回填，worklist #4 前置任务，对应「对抗验证角度 1」（GAP-1）与「三腿冲突分歧点 2」（GAP-2）。

### 1. FrontierRail / frontier UI 文案核查（GAP-1）

**方法**：grep 全仓 `frontier|Frontier`（`web/`、`src/ui/`、`src/capabilities/**/ui/`），逐个命中文件读全文，锁定用户可见文案（非注释/变量名）；追加检查 AI 生成文案是否会流入用户可见字段。

**全部用户可见文案露出面**（逐处引用 + 判定）：

| # | file:line | 原文案 | 判定 |
|---|---|---|---|
| 1 | `src/capabilities/knowledge/ui/FrontierRail.tsx:99` | 标题「下一步，你学得动这些」 | **中性/正确**——"学得动"（structurally able to attempt）≠"会做对"，未承诺正确率 |
| 2 | `FrontierRail.tsx:101` | 副标题「learnable_frontier · 前置都满足了 · 这是**建议**不是必经路，随时忽略」 | **中性/正确**——"前置都满足了"精确对应 KST outer-fringe 定义（结构可达），且显式弱化承诺（建议/可忽略） |
| 3 | `FrontierRail.tsx:70` / `:72` | 卡片 tag「建议 · 低置信」/「下一步」 | **中性**——"下一步"是顺序词非难度词；propose 半区已标"低置信" |
| 4 | `FrontierRail.tsx:56` | 空态「暂无明确下一步——多录入 / 练习后会逐步浮现」 | 中性，与本判定无关 |
| 5 | `src/capabilities/knowledge/server/frontier-read.ts:83`（`denseReason`） | 「已掌握全部 N 个前置」/「前置已满足」 | **中性/正确**——陈述的是"前置"状态，不对目标 KC 本身的难度/正确率做任何断言 |
| 6 | `frontier-read.ts:91-100`（`proposeReason`） | 「AI 提议前置：X、Y · 待确认」/「AI 提议的下一步 · 待确认」 | **中性/正确**——"待确认"显式标注低置信，不含"容易/该会"措辞 |
| 7 | `src/capabilities/practice/server/softmax-selection.ts:206-208`（`frontierReasoning`，与 `stream-composer.ts:137-141` 单一真相同文案） | 「${knowledgeLabel}的前置你都拿下了，可以开这块新内容了」 | **中性/正确，且是全场最贴合 Cosyn et al. 语义的一处**——"可以开"（you may now start）是纯粹的结构可达性措辞，不含任何"容易/该会/正确率高"暗示 |
| 8 | `FrontierRail.tsx:77`（`<BandChip input={f} />`，读 `frontier-read.ts` 的 `bandFields`） | 渲染的是**目标 KC 自身**当前 mastery band（未掌握态，通常「萌芽」/「未知」，见 `mastery-band.ts:26` A5_BANDS） | **正确，且方向上加固而非削弱**——视觉上明确显示"你还不会这个"，与"进 frontier=已经会"的错误假设相反 |

**结论（GAP-1）**：**未发现任何文案或视觉元素暗示"frontier 内的题=容易/该会/高正确率"**。三条独立文案源（FrontierRail 静态文案、frontier-read.ts 的 reason 生成器、practice 流的 frontierReasoning 模板）全部一致收敛于"结构可达"（前置满足→可以开始）框架，无一处触及"正确率"或"难度"措辞。这与 Cosyn et al. (2021) 的核心论点（frontier 是拓扑可达性信号非表现预测信号）**天然同构**，无需因本次核查修改任何现有文案。

**新发现的独立缺陷（非本次判定目标，但在同一「frontier UI 露出面」范围内浮现，值得记录）**：`src/capabilities/practice/ui/PfStream.tsx:22-29`（`SRC_META: Record<StreamSource, {...}>`）与 `src/capabilities/practice/ui/practice-api.ts:15`（`export type StreamSource = 'decay' | 'variant' | 'new_check' | 'paper' | 'on_demand' | 'import'`）**均缺失 `'frontier'` 分支**，但后端已经真实产出 `source: 'frontier'` 的 StreamItem——`src/db/schema.ts:1443-1446`（`practice_stream_item.source` 的 `$type` 显式含 `'frontier'`，列本身是无约束 `text`）、`stream-composer.ts:44/137-141`、`softmax-selection.ts:115/122/132` 均已按 5 源（含 frontier）实现，且 `stream-store.ts:205,243` 端到端确认 `learnableFrontier(db)` 是**实时活查**（非 flag 挡死，"NO-OP" 只是当前图稀疏的偶然结果，不是设计上的永久防线——一旦 KG 前置边稠密到某 KC 前置全掌握，下一次 compose 就会产出 `source:'frontier'` 的 StreamItem）。`PfSrcBadge`（`PfStream.tsx:31-38`）对缺失 key 做 `SRC_META[source].tone`，无 optional chaining/fallback，一旦命中即 `TypeError: Cannot read properties of undefined`——**是前后端类型漂移导致的潜伏 UI 崩溃 bug，不是文案假设问题，但同属本次「frontier 在前端全部露出面」核查范围**，建议单独提给 owner 决定是否登记 Linear（不在本次只读任务内创建）。

### 2. ALEKS 双源交叉校对（GAP-2）

**方法**：WebFetch `aleks.com/about_aleks`（营销页，逐字取 90-95% 原句）+ WebFetch/Read Cosyn et al. (2021) 官方 preprint PDF（`jmatayoshi.github.io/publications/JMP2021_KST_ALEKS_preprint.pdf`，31 页，读第 1-3 页背景定义 + 第 15-24 页 Section 2 尾（assessment 正确率）与 Section 3.1（learning mode 成功率）+ WebFetch `aleks.com/about_aleks/knowledge_space_theory` 核实该数字不在理论页出现）。

**营销页原文**（`aleks.com/about_aleks`，2026-07-03 抓取）：
> "when ALEKS determines that a student is ready to learn a concept, the student is able to master it at least 90% of the time. In many ALEKS course products this success rate is greater than 95%!"

**论文里两个不同构念的数字**（均来自 Cosyn, Uzun, Doble & Matayoshi, 2021, *Journal of Mathematical Psychology* 101, 102512）：

1. **27% ——「outer layer 1」在 ASSESSMENT 阶段的冷启首答正确率**（论文 p.15-16，§2 尾，对应 Figure 3a）：「correct rate essentially starts at zero for the outermost layers, and then begins to increase around outer layer 8, eventually arriving at a value of roughly **0.27 for outer layer 1**」。outer layer 1 ≡ outer fringe（论文 p.3 §1.1 显式定义："The outer fringe of a state K is the set of items q not in K such that K∪{q} is also a knowledge state ... may be thought of as the set of items the student is **'ready to learn'**"）。测的是：assessment 里给学生一道分类到其 outer fringe 的「extra problem」，**零指导、单次作答**的正确率。
2. **80.9%–94.3%（营销页 90-95% 的疑似原型）——LEARNING MODE 里一次「学习尝试」的最终 Success 比例**（论文 p.21 Table 4，§3.1）：ALEKS 学习模式里，学生从 outer fringe 挑一项练习后，该 item 被系统判定「provisionally learned」（计入知识状态）的比例——Sixth-Grade Math 0.809（剔除中断重来的话 0.845）、Algebra I 0.841（0.884）、College Algebra 0.943（0.927）。这是**先给例题讲解、允许多次练习尝试、最终判定是否学会**的结果，不是单次冷启作答。

**校对结论**：**两个数字不矛盾，因为测的是漏斗上两个不同的点**——27% 是"零指导单次冷启作答"，90-95%（更精确说 80.9-94.3%，营销页取的是三门课里表现最好的 College Algebra 那头，且四舍五入/措辞往上取整）是"给了例题+允许练习后的最终学会率"。营销页数字**并非编造**——它与论文 Table 4 的 Success 列构念一致、量级吻合，可信是同一批内部统计的公关重述，但存在**选择性框定**：三门示例课程里有两门（80.9%、84.1%）实际低于「at least 90%」的措辞，营销页只강调了 College Algebra 这头的数字并把整体说成"至少 90%"，是乐观化陈述而非虚假陈述。

**设计引用建议**：
- **正面引用 27%（Cosyn et al. 2021, JMP，peer-reviewed 一手）**，用于支撑"frontier ≠ 高首答正确率"——理由：本项目当前 frontier 尾（`stream-store.ts:205-217`）是**直接发一道题**，中间没有"先给例题讲解"这一步（不同于 ALEKS learning mode 的 worked-example 流程），结构上更接近论文里"assessment 冷启单次作答"这个场景，而非"learning mode 练习后最终判定"场景。27% 是构念上更贴近本项目实际交互形态的锚点。
- **90-95%（营销页）降权，不建议作为反例引用**——若要引用，必须显式标注"这是‘讲解+练习后最终学会率’，不是‘首次冷启正确率’"，否则容易被误读成与 27% 矛盾、或被误用来暗示"frontier 题目应该容易答对"（恰是 GAP-1 要防的假设）。
- 沿用 dossier 主体已有的"只采纳定性结论、拒绝把具体数字当本项目可比基准值"立场（27% 和 90-95% 均来自 ALEKS 的百万级学生 + 统计校验知识结构，本项目 n=1 + AI 生成边，两个数字都不能直接套用为本项目阈值），文档里引用时两个数字都只作为"结构性证据"而非"目标数值"。

Sources:
- [ALEKS — About ALEKS](https://www.aleks.com/about_aleks)
- [ALEKS — Knowledge Space Theory](https://www.aleks.com/about_aleks/knowledge_space_theory)
- [Cosyn, Uzun, Doble & Matayoshi (2021) preprint PDF](https://jmatayoshi.github.io/publications/JMP2021_KST_ALEKS_preprint.pdf)
