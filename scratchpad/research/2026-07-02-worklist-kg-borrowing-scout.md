# Scout: `kg-borrowing-prereq-propagation-sprawl` 重接地 @ main 0291987e

register 锚点：`docs/design/2026-07-02-project-logic-master-register.md:620-628`。任务：①定位四套机制 + #693(YUK-543) 影响；②语义差异矩阵；③merge vs 显式分工选项空间。外部指针 ≤3。

## ① 四套机制定位（逐个重接地，均对 main@0291987e 直接验证）

| # | 机制 | Pure 半 (core/) | IO/wiring 半 | Flag (module const, 均 `false`) | 消费面 |
|---|---|---|---|---|---|
| A5 | 邻域平滑 (neighbor-smoothing) | `src/core/graph-laplacian.ts:1-263`（`buildLaplacian`/`gmrfPosteriorMean`/`smoothTheta`） | `src/server/mastery/state.ts:462-581` `applyKgSoftLayer`（同 A6 共用） | `GRAPH_LAPLACIAN_ENABLED`（graph-laplacian.ts:56） | `getMasteryProjection` → 唯一实际读者是 learnable-frontier B3（见下） |
| A6 | 前向记分/下压 (forward-credit / downstream-press) | `src/core/prereq-propagation.ts:1-149`（`prereqAdjustments`/`propagatePrereq`） | 同上 `applyKgSoftLayer`（state.ts:511-532：A5 先跑、A6 在平滑后的 θ̃ 上再跑） | `PREREQ_THETA_PROPAGATION_ENABLED`（prereq-propagation.ts:57，**renamed from `PREREQ_PROPAGATION_ENABLED`**，见 §纳斯sprawl证据） | 同上 |
| C | 冷启先验 (cold-start-prior) | Rust `propagate_priors` kernel（`crates/calibration-native`，未读，TS 侧只声明 napi 接口） | `src/server/coldstart/propagate-priors.ts:1-252` `loadDayOnePriors`（YUK-513 Phase 2 / #123 / inc-E） | `DAY_ONE_PRIOR_ENABLED`（定义在 `src/core/theta-grid.ts:84`，**故意不叫** `PREREQ_PROPAGATION_ENABLED`，见下） | `src/capabilities/practice/api/placement-profile.ts:67,116` 已接线（把 dark 字段挂上 API response），但**至今零 UI 消费者**（PR-3 design-gated，theta-grid.ts:80「Still no UI consumer until PR-3」） |
| D | 向后诊断 (backward-diagnosis) | `src/core/prereq-risk.ts:1-127`（`prereqRiskFromAttempt`，纯闭包→风险折算） | `src/server/mastery/prereq-propagation.ts:1-261`（`loadPrereqClosure` SQL 递归闭包 + `emitPrereqRiskSignal` 写 outbox 事件） | `PREREQ_RISK_EMIT_ENABLED`（prereq-propagation.ts:51，**renamed from `PREREQ_PROPAGATION_ENABLED`**） | call site `src/capabilities/practice/api/submit.ts:837` + `.../server/paper-submit.ts:866`（gate = flag && outcome==='failure'）；写出 `experimental:prereq_risk` 事件后**零下游读者**（`threshold_deferred:true`，emit 侧显式声明不 gate 任何 live 行为） |

**文件名/目录本身即是"sprawl"的物证**：两个模块字面同名 `prereq-propagation.ts`（一个在 `src/core/`，一个在 `src/server/mastery/`，语义完全不同——A6 vs D）。且**三个 flag 都一度想叫 `PREREQ_PROPAGATION_ENABLED`**：A6 与 D 各自 renamed 离开这个名字（prereq-propagation.ts:54-56 / server/mastery/prereq-propagation.ts:48-51 互相指名对方），theta-grid.ts:61-67 明确写"YUK-455 shipped two flags of that name first... this one gates ONLY the day-one prior read surface, so it carries a distinct, specific name **to avoid a three-way same-name collision**"——即 C 的命名是刻意绕开的第三次撞名。这比 register 原文"命名各异"的描述更精确：不是四个团队各自随意起名，是**同一撞名反复发生、每次靠人工改名规避**，无编译期/lint 防线。

## ② #693 / YUK-543 edge 改动是否影响四套机制之一

**不影响**。`fb487c3d`（YUK-543 PR #693 review 修复）的 O1-O8/C1 全部落在 KC 合并/去重域（`src/capabilities/knowledge/server/{edges,proposals,merge-attribution-backfill}.ts`、`src/core/projections/learning_item.ts`、`src/core/schema/event/known.ts` 的 `MergeRepairEntry`、`src/server/conjectures/typed-state.ts`），语义是"合并两个 KC 时怎么重写/墓碑化 `knowledge_edge` 行"，与 A5/A6/C/D 四个传播机制**零重叠函数**（grep 确认无一处改动触及 `graph-laplacian.ts` / `prereq-propagation.ts`(两个) / `prereq-risk.ts` / `propagate-priors.ts`）。

唯一间接关联：O1 给 `reactivateKnowledgeEdge` 补了 tombstone-only 守卫（`WHERE archived_at IS NOT NULL` + 0 行 throw 409），防止合并重写误覆写一条**LIVE**边。四套传播机制全部靠 `archived_at IS NULL` 过滤器读边（graph-laplacian 消费者、prereq-propagation 消费者、propagate-priors.ts:145、prereq-propagation.ts(server):117,131），O1 加固的是这个共享基底表的写入正确性——是四套机制"上游地基"更结实了一点，不是它们自身的逻辑改动。#693 与本 register 单元是正交变更。

## ③ 语义差异矩阵

| 维度 | A5 邻域平滑 | A6 前向记分/下压 | C 冷启先验 | D 向后诊断 |
|---|---|---|---|---|
| 消费的 `relation_type` | `related_to`（对称，唯一） | `prerequisite`（有向）+ `derived_from`（有向，方向翻转：to 是 base） | `prerequisite`（有向） | `prerequisite`（有向） |
| 信息流方向 | 双向对称（GMRF 联合解，全节点一次线性系统） | 双向但不对称：违反序时 dependent 被压低（λ_down） + prereq 被记高（λ_up，更弱），单跳、逐边独立叠加 | 单向：仅 prereq → dependent（dependent 先验被 prereq 的期望掌握"概率与"收缩） | 单向：仅失败 KC → 祖先 prereq（answer 错误从不影响后代） |
| 衰减模型 | 精度加权（边权 + κ 岭 + 观测精度 dₖ），**无跳数衰减**——是全图一次联合解，非链式传播 | 逐边一次性 Δθ，**无跳数衰减**（不是递归多跳，是单跳边贡献的线性叠加） | 概率-AND（结构性收缩，non-additive，经原生 Rust 核一次联合解整条可达前置子-DAG），无显式"深度衰减常数"——衰减内生于 AND 复合概率 | **显式几何衰减**：`risk = BASE_WEIGHT · DECAY^(depth-1)`，SQL 递归闭包沿链逐跳算（cap 16 跳 / 10k 节点） |
| 触发时机 | READ-side，`getMasteryProjection` 每次调用惰性算 | 同 A5（在 A5 平滑后的 θ̃ 上链式再跑） | READ-side，`placement-profile` API 每次读惰性算（原生插件缺失/flag off → NO-OP） | **WRITE-side**：`submit`/`paper-submit` 提交答案 outcome=failure 时同步触发（post-commit best-effort emit） |
| 落点 | 就地改写 `projection.theta_hat`（mean-only）+ append 合成的 borrowed 低置信条目 | 同一个 projection map（链在 A5 后） | 独立 `Map<KC, DayOnePrior>`（`mean_mastery` + `weakest_prereq` 归因），不进 mastery projection | 独立 `experimental:prereq_risk` 事件行（每前置 KC 一条），**不进任何 projection map** |
| 写 `mastery_state`? | 从不 | 从不 | 从不（纯读） | 从不（只 `writeEvent` 进通用 outbox） |
| 今日下游消费者 | `getMasteryProjection` → learnable-frontier B3（`isMasteredForFrontier`，YUK-539 起加了 evidence-floor=4 门，见 §④） | 同 A5 | `placement-profile.ts` API 字段已接线但**零 UI 读者**（PR-3 design-gated） | **零消费者**（emit 后无一处读该事件；`threshold_deferred:true` 是显式声明） |
| 对应 ADR | `0047-relation-type-to-calibration-mechanism-mapping.md`（与 A6 共用，Proposed 未 ratify） | 同左 | 无专属 ADR（只有 YUK-513 Phase 2 源码注释级文档） | `0047-prereq-diagnostic-backward-propagation.md`（Proposed 未 ratify） |
| n=1 admissibility 依据 | owner 固定 λ/κ | owner 固定 λ_down/λ_up | owner 固定 shrink_coeff=1.0，b=0/θ_global=0（纯拓扑） | owner 固定 BASE_WEIGHT/DECAY |

四者恰好对应 register 外部基线段落点名的"forward-credit / backward-diagnosis / cold-start-prior / neighbor-smoothing"四查询：A6=forward-credit，D=backward-diagnosis，C=cold-start-prior，A5=neighbor-smoothing——这个映射在 register 原文是断言，本次重接地**逐文件核实成立**。

## ④ 关键新发现：register 自身 P1 判据已被同日更早的 commit 部分关闭（未反映进 register 文本）

register 判决（line 624-628）把"borrow branch 合成 `.mastery`/`low_confidence:true`，B3 (`learnable-frontier.ts`) 的 mastered-gate 不读 `low_confidence`，易前置 (β≲−0.85) 可在零直证下 flip gate"定为**留存的 P1**（唯一未被两个对抗方推翻的具体缺陷）。

重接地发现：`src/capabilities/practice/server/learnable-frontier.ts:61-93` 现有 `isMasteredForFrontier(mastery, evidenceCount)`，**AND 了 `evidenceCount >= FRONTIER_MASTERY_MIN_EVIDENCE(=4)`**（YUK-539，commit `8ef0917d`，"frontier evidence-floor(=4)"）。borrow branch 合成条目永远 `evidence_count: 0`（`state.ts:573`）——`0 >= 4` 恒假，**gate 恒不过**。更关键：`learnable-frontier.ts:78-85` 有一段**逐字点名本 register 单元**的 docblock：

> "BORROW-BRANCH INTERACTION (kg-borrowing register unit): getMasteryProjection's borrow branch... synthesizes entries with evidence_count:0. That branch is DARK today... Once either flag flips, a borrowed prereq (evidence_count:0) can NEVER pass this floor... That is conservative by intent... but is a deliberate coupling to flag when the borrow branch is activated."

**时序核实**（`git show -s --format="%H %ad %s" --date=iso`）：
- YUK-539 evidence-floor fix：`8ef0917d`，**2026-07-02 17:34:17 +0800**
- register 文档落库 commit：`0291987e`，**2026-07-02 23:16:05 +0800**（晚 ~5h42m，且是 YUK-539 的下游祖先——`git log --oneline main` 确认 8ef0917d 在 0291987e 之前 21 个 commit）

即：register 文本定稿/落库时，它标注为"real, flag-gated, and unguarded — enough to keep this P1"的那个具体缺陷，在代码里其实**已经被同一天更早的一次独立提交（YUK-539，且该提交明确知道并引用了这个 register 单元）修到不可复现**——不是"未来会被顺手修"，是落库时点已经是既成事实。这不是重新推翻 register 的 RESHAPE 判决（ADR 合并 / 文档 ratify 那部分仍成立），而是**register 的 Priority/Red-line-note 措辞已经对不上 main 的当下状态**，需要一次文本更新（不是重新分析）：P1 的"具体缺陷"分句应改写为"已被 YUK-539 evidence-floor 门关闭（`evidence_count:0` 恒不过 gate）"，剩余判据收窄回"两份 ADR 草案未合并/未 ratify + C/D 零消费者"这些纯文档/治理层面的 P2 级别待办。

（旁证：`FRONTIER_MASTERY_MIN_EVIDENCE` 常数本身的立项理由是另一个 bug——"3 次幸运连对就能在 p(L) 单独判据下被判 mastered"——evidence-floor 是为了堵那个洞而加的，堵住 borrow-branch 洞是**副作用式**的，不是专门为它设计；这意味着"两个独立机制的交互面被第三个不相关的修复意外关闭"本身也是一种脆弱性——没有专门测试锁定"borrow branch + evidence-floor"这个交互不变量，如果日后 evidence-floor 的默认值被下调、或 borrow branch 改成合成非零 evidence_count，洞会无声重开。这点值得作为独立 follow-up，而非 register 本单元的收尾判据。）

## ⑤ merge vs 显式分工：选项空间

register 已就"是否 GGM/chain-graph 统一"给出初判（拒绝，DROP-7 风险），本次重接地补出更细的选项谱：

1. **完全统一（单一联合 GGM/链图模型，四查询变一个模型的四种推断）**——**不推荐**，register + 两个对抗方已一致否决。四机制的"衰减模型"栏在 §③ 里根本不同构：A5 是一次线性系统解、A6 是无衰减单跳叠加、C 是概率-AND 复合、D 是显式几何衰减——统一成一个模型意味着要么削掉某些机制现有的、已过 n=1 litmus 的具体形状，要么隐式引入跨机制共享参数（DROP-7 红线：population-level 拟合）。且四者中只有 A5+A6 真实共享一个 wiring 点（`applyKgSoftLayer`）；C/D 从未与 A5/A6 交互过（各自独立 API/事件出口）——不是"四个机构各管一段的同一个模型"，是四个真正独立的问题。
2. **纯命名/目录整顿（零数学改动）**——把四个模块搬进同一父目录（如 `src/core/kg-propagation/{laplacian,prereq-theta,day-one-prior}.ts` + `src/server/.../prereq-risk-emit.ts`）+ 统一 flag 命名前缀（如 `KG_PROP_*`），解决"字面同名文件在两个目录""三次同名 flag 撞车"这个具体、廉价、机械的 sprossl 症状，不碰任何数学/语义。成本低、风险低，但 register 判决与两个对抗方都没把这个当作省事，可能因为纯重命名对单用户 n=1 项目收益也薄——仅供选项空间完整性列出。
3. **文档层显式分工（register 已选的方向）**——不动代码结构，只（a）合并两份在题 0047 草案为一份 ratified ADR，钉死"哪个 relation_type 喂哪个机制"这张表（已在 `0047-relation-type-to-calibration-mechanism-mapping.md` 草稿里，只差 ratify）；（b）A11 文件从 0047 撤号；（c）加一段跨机制索引（可以就是本 scout 的 §①③ 表格搬进 ADR 或 CONTEXT.md），让"四个不同问题、四个不同 flag、各自的验证闸"这件事本身被记录成一个**故意的架构决定**而非未言明的历史沉积。这是当前 register 判决实际选的路径，本次重接地未发现推翻它的新证据。
4. **不动，仅补一条监管测试**——针对 §④ 发现的脆弱交互面，加一条 characterization test（GRAPH_LAPLACIAN_ENABLED=true 或 PREREQ_THETA_PROPAGATION_ENABLED=true 场景下，borrow-branch 合成条目在 `isMasteredForFrontier` 前必然 evidence_count=0 恒不过）锁定这个"意外关闭的洞"不会因未来改动无声重开——比统一 ADR 更具体，成本最低，是本次重接地给 register 补的一条新候选，原文未提出。

## 外部指针（≤3，图上传播标准形态）

1. **Zhu, Ghahramani & Lafferty (2003)**, *Semi-Supervised Learning Using Gaussian Fields and Harmonic Functions*, ICML 2003, pp. 912–919. 真实性：dblp + ACM DL + Semantic Scholar 均可查到会议论文条目（非编造）。Venue：ICML，机器学习顶会（CORE A*）。同行评审：是（会议 proceedings）。Preprint：否。引用量：数据源不一致——ACM DL 官方索引给 454，SciSpace/Semantic Scholar 系给 ~4468（更接近常用的 Google Scholar 口径，此类经典文常见千级引用）；口径差异本身已标注，不采信单一数字为精确值，但两个来源均确认"高引用经典"这一定性判断。**对应关系**：这是图-Laplacian/GMRF 标签传播的奠基性范式论文——A5 的"proper GMRF `θ~N(μ₀,(λL+κI)⁻¹)`"正是这一支的标准数学形状（该文用的是 harmonic function + absorbing boundary，A5 额外加了 κ 岭项解决可识别性，是同一族的变体，非该文本身）。
2. **Doignon & Falmagne (1985)**, *Spaces for the assessment of knowledge*, International Journal of Man-Machine Studies, 23, pp. 175–196. 真实性：多个独立来源（ScienceDirect/ResearchGate/学术书目页）均确认此期刊条目，是 Knowledge Space Theory / surmise relation 的奠基文献。Venue：同行评审期刊（International Journal of Man-Machine Studies，人机交互/认知科学交叉刊）。Preprint：否。引用量：搜索结果确认"被广泛引用、教育心理学/知识评估领域的奠基工作"但未能拿到独立可核的精确数字——**标注 UNVERIFIED（精确引用数）**，仅引用"foundational/highly-cited by reputation"这一定性表述，降权处理，不当作精确数据使用。**对应关系**：mechanism C（`propagate-priors.ts` 源码注释自己就写了"ALEKS / Knowledge Space Theory surmise relation"）的"prerequisite 子-DAG 概率-AND 收缩"直接是这篇奠基文的工程实现思路，非本次调研新引入。
3. **Yang, Shen, Qu, Liu, Wang, Zhu, Zhang & Yu (2020)**, *GIKT: A Graph-Based Interaction Model for Knowledge Tracing*, ECML-PKDD 2020 (Springer LNCS). 真实性：Springer 官方 DOI 链接 + ACM DL 镜像 + 官方 GitHub 代码仓（ApexEDM/GIKT）均可查，非编造。Venue：ECML-PKDD，机器学习会议（CORE A 级）。同行评审：是。Preprint：否（会议正式收录版）。引用量：本次检索未拿到独立可核数字——**标注 UNVERIFIED（精确引用数）**，仅能确认存在多篇后续工作引用其命名/框架（如"GCN and GAT-based interpretable knowledge tracing model"等在同批检索结果里出现），弱佐证有持续影响力，但不据此断言具体引用量。**对应关系**：代表"图传播用于知识追踪前置结构"这一问题在学界的**当代标准做法**是端到端 GCN embedding 传播（单一联合模型），与本仓库四个独立闭式/规则化模块的做法形成对比——支持 §⑤ 选项 1（完全统一）在"业界确实存在这种做法"意义上不是无中生有，但学界方案通常伴随population-level 参数学习（GCN 权重训练），与本仓库 n=1/DROP-7 红线（禁止跨学习者拟合）直接冲突，是 register「统计答案对上了架构问题」判词的具体反例支撑。

## 结论摘要（供上游 orchestrator）

- register 对四套机制的定位**基本准确**，本次逐文件重接地未发现文件路径/flag 名/消费面的事实性错误；补充了 register 未写出的"三次同名 flag 撞车"证据链（比"命名各异"更精确）。
- #693(YUK-543) **不影响**四套机制中任何一个的逻辑；唯一交集是共享的 `knowledge_edge` 表读取基底（`archived_at IS NULL`过滤器）被 O1 的 tombstone 守卫加固，属正交改动。
- **新发现（register 需要更新，非推翻）**：register 保留的 P1 判据（borrow-branch × B3 low_confidence 未读）在 register commit 落库前 ~6 小时已被 YUK-539 的 evidence-floor 门（副作用式）关闭；代码里甚至有逐字点名本 register 单元的 docblock 佐证维护者已知情。建议 register 文本更新 Priority/Red-line-note 分句，并新增一条 characterization test 候选（§⑤ 选项 4）锁定这个目前无专属测试保护的交互面。
- merge vs 显式分工：现有 register 判决（选项 3：文档层显式分工 + ADR 合并/ratify）在本次重接地下依然是最站得住脚的选项；完全统一（选项 1）有具体反证支撑其不可取（四机制衰减模型不同构 + 学界对应做法需要 population-level 拟合，撞 DROP-7 红线）。

## 追加(2026-07-03,来自 #4/YUK-551 spec 捕获门)

- **tracked-trigger 交叉引用归本单元**:#4 设计裁定 kg-borrowing 的 flag 翻转 trigger 交叉引用归 #6 处理(#4 的切片 4 已落 borrow-branch × evidence-floor 的 DB gate 特性测试,code 侧交叉引用已钉;剩「trigger 条件钉进 tracked 面」的部分在 #6 设计相裁)。见 docs/design/2026-07-03-frontier-gate-spec.md 决策表 Q4 与捕获门节。

## 附录 — OSS 腿 + Rust 核 code-ground 回填(2026-07-03,critic P1)

> Opus critic 判本 scout 缺两条设计相升格硬前置:**OSS 产品一手源码腿** + **本仓库 Rust 同构核 code-ground**。本附录 append 补齐。每个 OSS 锚点均真实打开过源文件(GitHub blob/raw,给行号);找不到即如实标注。Rust 核只读未改。

### 腿 1 — OSS 一手源码:图谱边/证据的跨域借用与保守传播

四个锚点覆盖三个类别:temporal-KG(Graphiti)、KG 补全/负采样(PyKEEN,DGL-KE 同类交叉印证)、教育侧 prerequisite 图 authored-vs-inferred(AL-CPL + prerequisite-structures)。

**A1 — Graphiti(`getzep/graphiti`,Apache-2.0,已核 LICENSE 首行)** — bi-temporal 边失效的影响半径。
- `graphiti_core/edges.py:163-273` `EntityEdge`:bi-temporal 字段 `valid_at`(fact became true)、`invalid_at`(fact stopped being true)、`expired_at`(edge invalidated)、`created_at`、`reference_time`,外加 `episodes: list[str]`(:168-171,**证据出处**——哪些 episode 产出了这条边)与 `fact`/`fact_embedding`。
- `graphiti_core/utils/maintenance/edge_operations.py:545-574` `resolve_edge_contradictions(resolved_edge, invalidation_candidates)` + `:606-803` `resolve_extracted_edge(...)`。
- 机制一句话:新抽取的边与既存边矛盾时,失效**只落在那一对矛盾边上**(`invalid_at = resolved_edge.valid_at`,`expired_at = now`),**不 cascade 到邻接实体/边**——影响半径 = 0(刻意本地化)。
- 与 #6 映射:这是"bi-temporal 边失效时对邻接实体的影响半径怎么控"的工业答案——一个成熟 temporal-KG 记忆层**不把边失效向邻居传播**。直接印证 #6 的保守传播本能(register §⑤ 拒绝全图统一);且 `episodes` = 每条边自带证据出处,正是 #6 borrow-branch 需要的"借自哪里"provenance 原语。
- 权威性:活跃维护的生产级 temporal-KG memory 层,一手源码打开+真实行号。High。

**A2 — PyKEEN(`pykeen/pykeen`,MIT,已核 LICENSE 首行)** — 给推断边打"非实测"标记的 KGE 标准做法。
- `src/pykeen/sampling/negative_sampler.py:44-85` `NegativeSampler`。docstring(:44-45):"Whether proposed corrupted triples that are in the training data should be filtered." `filtered=True`(:50-51)实例化 filterer,把恰好命中已知训练三元组的负样本剔除(false-negative 处理);其余未观测三元组一律默认为负(closed-world / local-closed-world,:81-83)。
- 机制一句话:任一未观测/推断三元组的**默认态是"非实测负例"**,只有显式观测到的 positives 被豁免——"非实测"是缺省,不是需要额外打的标记。
- 与 #6 映射:KGE 界"给推断边打非实测标记"是**反过来做**——未观测边默认不带正向 credit,除非它在 authored/observed 集里。#6 的 borrow-branch 给推断掌握合成 low-confidence 条目;PyKEEN 的纪律提示:未观测/推断关系的安全缺省是"当作非证据",而不是"当作软正例"。且 PyKEEN 把 observed triples(KG 事实)与 scored candidate triples(带连续分的预测)严格分表、从不混淆,同构于 #6 需要的 `evidence_count>0` 实测掌握 vs `evidence_count:0` 借用条目的分离。
- 权威性:被广泛引用的 KGE 库(JMLR 发表),一手源码+真实行号。High。**DGL-KE(`awslabs/dgl-ke`,Apache-2.0)属同类(KGE + closed-world 负采样)**,本次未逐文件深挖,仅作同模式交叉印证列出(诚实披露:未打开 dgl-ke 源文件)。

**A3 — AL-CPL(`harrylclc/AL-CPL-dataset`,CC-BY-NC-SA 4.0,已从 repo 页确认 license)** — authored 边的结构完整性闸。
- 文件:`data/*.pairs`(全部 concept pair,正+负)、`data/*.preqs`(仅 prerequisite 正例);`features/`(SVM-light 特征文件);四域(Data Mining/Geometry/Physics/Precalculus),89-224 concepts,826-2060 pairs/域。
- 机制一句话:**authored gold prerequisite 边**——人工标注,且预处理阶段**验证每条 prerequisite 关系满足 strict partial order 的必需性质**(acyclic + 偏序纪律),domain expert 手工纠正标签。
- 与 #6 映射:这是"authored 边"参照系——gold 集在任何推断叠加之前先过 DAG/偏序完整性验证。映射到 #6/register 里 authored `prerequisite` 边是四套传播机制读取的可信基底(`archived_at IS NULL`),且结构完整性(无环)是前置——与 Rust 核的 cycle-rejection 守卫同气。
- 权威性:Liang et al. 研究数据集(concept prerequisite learning 主线),打开 repo 页确认结构+license。Medium-High。

**A4 — prerequisite-structures(`prajnaupadhyay/prerequisite-structures`,**无 license** → 默认 all-rights-reserved,仅供设计借鉴不可抄码)** — 推断边的 graded 置信 + 循环软化传播。
- 文件:`findRefDScoresForInputConcepts1.py`(BFS,给≤2 跳内所有概念算 RefD 置信分 ∈[0,1])、`generateRefDTrees1.py`(按阈值 r 与/或 top-k 选 children)、`generateReadingOrder.py`(拓扑排序;**发现 cycle 时删 RefD 值最小的那条边**,再返回 reading order)。
- 机制一句话:推断边带**连续置信标量**(RefD ∈[0,1],非 boolean);推断图**不假定是干净 DAG**——遇环删**最低置信边**再拓扑;传播**硬上界 ≤2 跳**。
- 与 #6 映射:直接就是"推断边 vs authored 边 + 推断边独立处理"模式,三条可迁移:(a) 推断边带显式置信标量(非布尔)——比 #6 的 `low_confidence:true` 更细,是 graded;(b) 传播 hop-bounded(≤2),保守半径——对比 A5 全图联合解、D 的 16 跳闭包;(c) 推断产生环时删最弱置信边、而非 throw——是 Rust 核硬 cycle-rejection 的**软化替代**。**本 scout 与 #6 核心问题映射最强的单个锚点。**
- 权威性:学术代码(IIT Delhi 组),打开 repo 页确认脚本+循环处理逻辑;**无 license → 仅设计灵感,禁止拷贝代码**。Medium。

### 腿 2 — 本仓库 Rust 同构核 code-ground(`crates/calibration-native/src/lib.rs`,1191 行,只读)

crate 定位:napi v3 + `wasm32-wasip1-threads` 单文件核(`src/lib.rs`),standalone(无 workspace root),`[profile.release] lto=true`。其余 worktree 下的副本是并行 lane 的镜像,以 repo 根 `crates/` 为准。

**已在 Rust 核里的计算(签名 + 文件:行号):**
| 域 | 函数 | 位置 | 性质 |
|---|---|---|---|
| 校准(离线) | `mulberry32_draws(seed,n)` / `forward_auc(scores,labels)` / `resolve_bootstrap_b(pooled_n,requested_b)` / `percentile` / `delta_auc_cluster_bootstrap(...)` | lib.rs:67 / :161 / :193 / :198-222 / :258 | YUK-493 校准滩头,JS oracle 平价 |
| 冷启单 KC 求解 | `solve_theta_one_kc(b_prime, answers) -> OneKcSolution` | lib.rs:522 | grid posterior,`coldstart-solver.ts` 平价 |
| 共享数值原语 | `poly_exp_batch` / `poly_sigmoid_batch` / `poly_sigmoid_scalar` | lib.rs:461 / :468 / (inline) | frozen GRID,no-FMA,bit-exact |
| **图/传播(唯一)** | **`propagate_priors(kc_ids, prereq_edges, b_per_kc, domain_theta_global, shrink_coeff) -> Vec<GridPosterior>`** | **lib.rs:822**(inner `propagate_priors_inner` :650-814) | **mechanism C** |

**`propagate_priors` 就是 crate 的第一个也是唯一一个 GRAPH 算法**(lib.rs:575-576 自述)。它已具备:
- prereq DAG 的**确定性 Kahn 拓扑前向遍历**(:718-746,升序 seed + 升序 extend,任意合法拓扑序 f64 逐 bit 相同);
- **cycle 硬 rejection**(:740-744,`order.len()!=n` → throw "prereq graph has a cycle");
- **重复边 dedup 守卫**(:704-715,防 ∏ E_mastery 双计过度收缩);
- **跨域坐标无关 E_mastery**(:627-642,`e_mastery_of` 在 prereq 自己的 (θg,b) frame 里算标量,prereq↔dep grid **永不需要对齐**——lib.rs:596-598 明写"dissolves the offset-grid risk instead of colliding with it");
- 概率-AND 收缩 `gap = 1 − ∏ E_mastery` + weakest-prereq argmin 归因(:761-795);
- **owner-fixed 非拟合常数** `shrink_coeff`(TS 侧 `DAY_ONE_SHRINK_COEFF=1.0`),DROP-7 红线内生(:600-601,no item-parameter fit,no cohort dim)。

TS wiring:`src/server/coldstart/propagate-priors.ts:116` `loadDayOnePriors(db, scope)`——skip-if-absent loader(:77-92)、flag `DAY_ONE_PRIOR_ENABLED`(default FALSE)、只读 active `prerequisite` 边(`archived_at IS NULL` + 两端点都在 scope,:136-149)、调 `addon.propagatePriors`。native binding 是 opt-in dev/CI artifact,**prod 今日 NO-OP**(binding 缺失即 null,live 路径不受影响)。

**不在 Rust 核、纯 TS 的三套(已 grep 确认零 napi/native 引用):**
- A5 邻域平滑:`src/core/graph-laplacian.ts`(GMRF 全图一次线性系统联合解);
- A6 前向记分:`src/core/prereq-propagation.ts`(单跳 Δθ 线性叠加);
- D 向后诊断:`src/core/prereq-risk.ts` + `src/server/mastery/prereq-propagation.ts`(SQL 递归闭包 + 显式几何衰减)。

**Rust 核落点初判(借用逻辑该落 Rust 还是 TS):**
- 借用的**数值传播核**(沿 authored `prerequisite` 边确定性前向传一个保守标量/先验,owner-const、无 per-user 拟合)→ **落 Rust,扩展 `propagate_priors`**,别新写并行 TS 传播器。理由:(a) 确定性/bit-exact 正是 crate 存在的目的;(b) 跨域坐标无关标量已在核里解决(正是"跨域借用"的安全性质);(c) DROP-7(禁 cohort 拟合)已由 `shrink_coeff=owner-const` 契约强制;(d) 核自述"crate 的第一个 GRAPH 算法"——借用传播器是自然的第二个。扩展方向:泛化 per-node combinator + 在输出 `GridPosterior` 加 "borrowed vs measured" tag。
- 借用的**证据出处标记 + 低置信 gating 策略**(把 projection 条目标 borrowed+low-confidence、按 `evidence_count` gate、决定哪些边算 live)→ **落 TS**(`src/server/mastery/state.ts` `applyKgSoftLayer` + `learnable-frontier.ts`)。这是 IO/wiring/policy,不是数值。三个 OSS 锚点(Graphiti provenance、PyKEEN observed-vs-inferred 分表、RefD 置信标量)也都把"这是借来的、要保守对待"的语义放在数值核**之外**。
- 一句话:**借用数值核落 Rust(扩展 `propagate_priors`),借用出处标记 + 低置信 gating 策略落 TS(`applyKgSoftLayer` + `learnable-frontier`),用现有 dark-flag + skip-if-absent 缝对接——与 C 机制现有的 Rust-核/TS-wiring 二分完全同构。**

### 给设计相的可执行启示(5 条)

1. **影响半径默认取零/有界,而非全图**:Graphiti 生产实践对边失效**不做邻接 cascade**(局部于矛盾边对),prerequisite-structures 推断传播**硬上界 ≤2 跳**。#6 若引入"借用传播",默认半径应向这两者看齐(局部/有界),而非 A5 的全图联合解——把"保守"落到 hop-bound 这个具体旋钮上,是有 OSS 先例的。
2. **推断/借用边用 graded confidence 标量,别用 boolean**:RefD 给推断边 ∈[0,1] 连续分、PyKEEN 把 observed positives 与 scored candidates 严格分表、Graphiti 每边挂 `episodes` 出处。#6 当前 borrow-branch 只有 `low_confidence:true`;升级成"连续 borrowed-confidence + provenance(借自哪条边/哪个 KC)"能同时喂 §④ 的 evidence-floor 门(graded 分可与 evidence_count 一起进 gate)和 PR-3 badge。
3. **authored 边过结构完整性闸(硬),推断边遇环删最弱边(软)——分层**:AL-CPL 对 authored 边验 strict-partial-order 后才建;prerequisite-structures 对推断图遇 cycle 删最低 RefD 边。#6 的 Rust 核对 cycle 现在是**硬 throw**(对 authored 边正确);若未来把"推断/借用边"混入 prereq 图,应在 authored(硬 throw)与 inferred(删最弱边软化)之间分层——两个 education 锚点正好给出这条分界。
4. **借用数值核 → Rust `propagate_priors` 扩展;借用标记/gating → TS 策略层**(见腿 2 落点初判)。这是把 register §⑤ 选项谱与 code-ground 接上的最关键一条:**不是新写传播器,是复用已过 n=1 litmus 的 Rust 图核 + 现有 TS 二分缝。**
5. **(治理)Rust/TS 分界应在 ADR-0047 ratify 时一并钉死**:四机制里唯一进 Rust 的是 C(`propagate_priors`),A5/A6/D 纯 TS。若 #6 选择把"借用"实现成 Rust 核扩展,Rust 核就成了"结构性传播"的规范落点——须在 ADR 里明写"哪类传播落核、哪类落 TS 策略",否则会重演 register §① 记录的 sprawl(同名 flag/文件三次撞车)。
