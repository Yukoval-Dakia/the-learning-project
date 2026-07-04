# kg-borrowing 单元 — 设计终稿（reconcile 后）

- **Worklist**: #6 `kg-borrowing-prereq-propagation-sprawl`
- **Base-ref（code-ground）**: `main` @ `cb0abb09`（`fix(practice): YUK-558 …`）。本终稿所有 file:line 由 reconcile 终裁**独立重核**（arbiter 所在 worktree 与 cb0abb09 在全部涉案文件逐字相同，唯 `src/server/memory/triggers.ts` 有差异——该文件全部引用走 `git show cb0abb09:`）。schema 引用统一 `git show cb0abb09:src/db/schema.ts`。
- **Reconcile provenance**: designer draft + Lens A（语义/图谱正确性）+ Lens B（传播落点/工程运行时）两路对抗 review → 本终裁逐条裁决（附录 B ledger）。**12 条 findings 全部 ACCEPT**（A2 的一个子论证降级），其中 5 条 MAJOR 推翻了 draft 的两处承重判断：**M1 撤回**（把自洽双轴误诊为矛盾）、**Q2a 半径判决反转**（纪律从 A13 移到 A5）、**M5 遥测形态重做**（per-read emit → shadow 周 sweep）。
- **输入盘点**: master register（`docs/design/2026-07-02-project-logic-master-register.md` L620-628 单元 + L58/L222/L1185 worklist 行 + L1142 起 grounding addendum）已通读；research scout 原文在磁盘不存在（scratchpad gitignore 未落盘），其四锚点 + tracked-trigger 实质由任务摘要承载并已逐条 code-ground（§1.3）。

---

## 1. 现状与问题（reconcile 后接地 cb0abb09）

### 1.0 一句话现状

register 原 P1 判据（借用分支在**零证据**上翻 frontier mastered-gate）**已被同日更早的 YUK-539 evidence-floor(=4) 关闭**，并被 YUK-551（worklist #4 frontier-gate）落成文 + DB gate 测试 + 借用侧 UI/tone。**止血已完成**。本单元重心 = **翻 flag 前的形态收敛**：把「四个同名异实的 prereq 传播机制 + 无统一 provenance 契约 + 一处被误诊的双轴语义 + 一处真实的可扩展性悬崖」收敛成语义自洽、observed/inferred 结构分离、可观测可回滚、且**翻 flag 硬前置清晰成文**的形态。

### 1.1 子系统实体清单（四个「prerequisite propagation」机制，全 dark）

| # | 机制 | 方向 | 数值形态 | **影响半径（终裁修正）** | 遇环 | flag（全 false） | 落点 |
|---|---|---|---|---|---|---|---|
| A5 | 图-Laplacian 平滑先验 | 对称（`related_to`） | proper GMRF **联合稠密解**（Gauss 消元，`solveDense` O(n³)） | **request-shaped，无结构上界**：联合解耦合 requested-诱导连通分量全域。单 KC 请求（node-page/detail）≈1 跳星图；tree 全树请求（≤5000）= 整个连通分量。见 RP8 | 线性解天然抗环 | `GRAPH_LAPLACIAN_ENABLED`（`graph-laplacian.ts:56`） | `src/core/graph-laplacian.ts:164`（`gmrfPosteriorMean`）+ `solveDense`（:218） |
| A6 | prereq 有向 θ̂ 传播 | 有向（`prerequisite`/`derived_from`） | **单趟 O(E) 加性** Δθ（序违背驱动） | **真 1 跳**：单趟同时更新、读原始 θ̂、无传递再传播（`core/prereq-propagation.ts:104-128,134-149`） | `max(0,·)` 互斥、拓扑无关终止 | `PREREQ_THETA_PROPAGATION_ENABLED`（`core/prereq-propagation.ts:57`） | `src/core/prereq-propagation.ts` |
| A13 / inc-E | prereq 诊断**向后**风险 emit | 有向逆走（答错→上溯前置） | 传递闭包 + 几何衰减（0.5^(d−1)），**MAX 聚合**，emit 事件 | 闭包 walk，**depth≤16 + node-cap 10k + path-array 环卫，overflow fail-safe-to-[]**（`server/mastery/prereq-propagation.ts:59,65,108-152`） | path guard + depth bound | `PREREQ_RISK_EMIT_ENABLED`（`server/mastery/prereq-propagation.ts:51`） | `src/core/prereq-risk.ts` + `src/server/mastery/prereq-propagation.ts` |
| Rust coldstart | day-one(n=0) **向前** DAG 先验 | 有向（`prerequisite`） | Kahn 拓扑前向，probabilistic-AND，grid posterior | 全 DAG 前向 | **reject**（Kahn 检测 → `Err`，`lib.rs:742`） | `DAY_ONE_PRIOR_ENABLED` | `crates/calibration-native/src/lib.rs:650`（inner）/`:822`（pub）+ `src/server/coldstart/propagate-priors.ts:116`（`loadDayOnePriors`） |

A5+A6 经 `applyKgSoftLayer`（`src/server/mastery/state.ts:462`）挂进读侧投影 `getMasteryProjection`（:367）；A13 是独立 event producer（两个 call site 在 practice submit / paper-submit，gate `PREREQ_RISK_EMIT_ENABLED && outcome==='failure' && wroteNewAttempt`，dark 契约成文于 `server/mastery/prereq-propagation.ts:9-21`）；Rust coldstart 是独立 day-one 先验读，产 display-tier 标量，不进 `getMasteryProjection`。

**`getMasteryProjection` 直接 live call site（终裁 grep 实数，9 处）**：`agency/jobs/research_meeting_nightly.ts:210`、`notes/server/mastery-progress-signal.ts:68`、`knowledge/server/node-page.ts:235`、`knowledge/server/frontier-read.ts:251`、`knowledge/server/tree.ts:99`、`practice/server/learnable-frontier.ts:303`、`practice/api/placement-profile.ts:107`、`ai/tools/knowledge-readers.ts:163`、`questions/detail.ts:308`；另有下游传递消费（如 `conjectures/evidence.ts` 收 caller 解析好的 projection）。draft 的「~24 consumer」按文件级含注释/测试计，实核直接调用是 9。

### 1.2 register 判据已关 / 相邻单元已 ship（结论保留自 draft，均经终裁复核为真）

- **YUK-539 evidence-floor 已关 register P1**：`isMasteredForFrontier(mastery, evidenceCount)` = `mastery ≥ 0.7 AND evidenceCount ≥ 4`（`learnable-frontier.ts:125-127`）；借用条目 `evidence_count:0`（`state.ts:573`）永远过不了 floor。耦合已就地成文（`learnable-frontier.ts:112-119` BORROW-BRANCH INTERACTION docblock）。
- **YUK-551 已 ship** 借用侧 UI/gate 诉求（PfSrcBadge 硬化 / overflow 单点 warn `learnable-frontier.ts:268-279` / 阈值联合记录 docblock :62-93，含「p(L)=σ(PFA logit)、NOT BKT」构念声明 :81-85 / kg-borrow × evidence-floor DB gate 测试 / tone neutral）。
- **相邻缝**：#1 kc-dedup（fold-owned 表纪律）；#5 SoT-flip（`knowledge_edge` LIVE fold-owned，写边唯一 throat = `edges.ts`，含 `reactivateKnowledgeEdge` @ :175——**任何借用逻辑绝不 raw-UPDATE 边**）；#4 frontier-gate（如上）。终裁复核：三处借用读边（`loadEdgesForProjection`/`loadPrereqClosure`/`loadDayOnePriors`）全 SELECT 只读，无违例。

### 1.3 scout 四锚点 + tracked-trigger 复核（终裁修正版）

| scout 锚点 | 终裁结论 |
|---|---|
| Graphiti 矛盾边失效**影响半径=0**（刻意本地化） | **draft 结论反转（Lens A A1）**：A5 恰是 Graphiti 本地化精神的**反面**——GMRF 联合解让一条矛盾 `related_to` 边的失效移动整个 requested-诱导连通分量的后验均值。`loadEdgesForProjection`（`state.ts:598-636`）只载 incident-to-requested 边，这界定的是**载边范围**非**影响半径**；当 requested = 全树（`tree.ts:99`，`LOAD_TREE_SNAPSHOT_LIMIT=5000` @ :43），全图入解。衰减由 κ/λ 与沿途观测精度决定：λ=0.5/κ=0.01 下未观测链单跳保留 ≈0.87（5 跳仍 ~50%）；高精度观测节点会屏蔽传播——但冷启（借用的目标场景）恰恰是无观测、衰减最慢的 regime。A6 是真 1 跳（draft 把 A5/A6 并称掩盖了 A5）。register「13 call site 广扇出」被证伪的结论保留（rename 撞号是 A6↔D 命名，非扇出）。 |
| prerequisite-structures 三旋钮：RefD 连续置信 / ≤2 跳硬上界 / 遇环删最低置信边 | ① 连续置信**已在**：`knowledge_edge.weight ∈ [0,1]`（schema :1311-1312「0-1 confidence」；CONFIDENCE-only 红线同 misconception 簇 :115/159——**draft 引 L130/176 是 misconception 表的 weight，已修正**）modulates A5（`graph-laplacian.ts:115`）/A6（`core/prereq-propagation.ts:118`）。② ≤2 跳上界：**不采**为统一旋钮——真正无界的是 A5（见上行），A13 反而是最有界的（16/10k/path-guard）；对 A13 加 ≤2 硬 cap 是**实质行为变更**（depth-3 贡献 = 0.5²=0.25，经 MAX 聚合可为某前置唯一贡献——非「衰减到微」），且会在 owner 定阈**之前**改变埋点分布（`prereq-risk.ts:22-25`「先埋点再定阈」）。③ 遇环：四机制各自已安全（§1.1 表），**没有任何机制「删最低置信边」**（那是写 fold-owned 边 → 违 #5）。 |
| PyKEEN + AL-CPL **observed-vs-inferred 分表** + authored 边偏序闸 | 印证真问题：存储层已分（inferred 从不落 `mastery_state`）；投影层混装——借用条目 `projection.set(...)` 进同一 `Map`（`state.ts:565`），仅 `low_confidence:true`+`evidence_count:0` 区分；9 个直接 caller 里只有 frontier 侧读 evidence floor。**终裁补刀（Lens A A4）**：二元分离还不够——图层也**就地覆写观测 KC 的 theta_hat**（`state.ts:545` `existing.theta_hat = tilde`），弱观测 KC（低 precision）的均值可被邻居主导却仍标 observed。 |
| Rust 核落点初判 = 扩展既有 `propagate_priors` @ `lib.rs:822` | **部分推翻维持**（终裁核实 :822 = pub fn，:650 = inner，probabilistic-AND grid posterior + Kahn + cycle-Err @ :742）：与 A5 GMRF 稠密解 / A6 单趟 Δθ 是不同数值核，共享的仅 DAG 拓扑/dedup/cycle-reject 基建。「出处标记 + gating 留 TS」成立。**理由修正（Lens A A5）**：A5 不 port Rust 的原因不是「邻域极小无刚需」——那前提是假的（tree 请求 n≈5000 ⇒ solveDense ~10¹¹ flops + n² 稠密阵 = 可扩展性悬崖）；正确表述是「A5 在 batch-read 尺寸下当前**不可扩展**，翻 flag 的真前置是**界定解规模**，port 语言在其后才谈」。 |
| tracked-trigger 归入本单元 | = A13。定位保留：四机制里最干净的一支（emit-only、绝不写 mastery_state @ `prereq-risk.ts:17-20`、`threshold_deferred:true`）。**终裁补刀（Lens B F1 引申）**：它 emit 走 `writeEvent` 未设 `ingest_at` → 每条事件默认进 memory-ingestion outbox，brief-regen 扇出**不被** extraction gate 挡（见 RP9）——dark 今日无害，翻 flag 前须决。 |

### 1.4 真问题清单（reconcile 后）

- **RP1′ — 双轴并存的可读性/误读风险（原 RP1「内部自相矛盾」撤回）**。终裁裁定（Lens A A2 / Lens B F4）：借用条目 `mastery=σ(−β)`（冷 PFA counts=0）+ `theta_hat=θ̃` **不是矛盾而是 by-design 双轴**——观测条目同样是 `.mastery`=σ(PFA counts logit)、`.theta_hat`=Elo/平滑 两个正交数字（`state.ts:544-545` + :450-457 docblock：soft layer 只动均值、observed 的 p(L) band 保持 count 轴）。band 全系统从不读 θ（观测路径 pointLogit 也是纯 `pfaLogit` @ :403）。draft M1 所引 `learnable-frontier.ts:81-85` 白纸黑字「p(L) = σ(PFA logit)」= σ(γs+ρf−β)，**不是** σ(θ̂−b)——draft 是构念张冠李戴。剩余真问题 = 双轴语义**未成文**，consumer 会困惑（读 `.theta_hat` 见借用、读 `.mastery` 不见）。修法 = M2′ provenance + M4′ 成文，**不改数值**（θ̃ 进 band 降级为 owner 选项 F′，见 Q1′）。
- **RP2 — observed/inferred 投影层混装 + 就地平滑不可见**（§1.3 第三行，含 A4 补刀）。
- **RP3 — 四机制无统一 doc / ADR-0047 三文件撞号**（`0047-relation-type-to-calibration-mechanism-mapping.md` + `0047-prereq-diagnostic-backward-propagation.md` 两 on-topic 均 Proposed；`0047-a11-caution-speed-accuracy-axis-ez-diffusion.md` 误号——终裁 ls 确认三文件在场）。register L627 明确 diagnosis §4「applyKgSoftLayer never assigns .mastery/.theta_se」是**假**（借用块确实合成 .mastery/.theta_se/band）——新 ADR 须写对。
- **RP4 — 传播形态旋钮跨机制不统一**：终裁修正——**不设统一 radius 旋钮**；各机制半径契约按其数学形态各表成文（§1.1 表），纪律落点在 A5（RP8）。
- **RP5 — Rust 落点**：本单元零 Rust 改动维持；理由修正见 §1.3 第四行；S6 defer 前置扩充（F6：deployment-aware loader）。
- **RP6 — inferred 衰减/复核**：维持 draft 结论——读侧重算 = 自衰减（`graph-laplacian.ts:36-40` dₖ→∞ ⇒ θ̃→θ̂），无陈旧无需独立 time-decay；authored 边仅 `archived_at`（schema :1316，无 bi-temporal）；生命周期正交。
- **RP7 — 可观测/回滚**：借用零遥测维持为真问题；**draft 的 per-read emit 方案被推翻**（Lens B F1/F2）——(a) `writeEvent` 默认 `ingest_at:null` 进 memory outbox，brief-regen 扇出对 extraction-gated 事件**照跑**（cb0abb09 `triggers.ts:320-329`「the brief regen fan-out STILL runs for gated events」+ `queries.ts` WriteEventInput.ingest_at docblock），热读路径 emit = brief-regen 风暴；(b) per-read cadence 对 console.log 同样错（9 caller 每渲染/每 AI 读/每 nightly 刷日志，且 `learnable-frontier.ts:297-303` 跑在 attempt compose tx 内）；(c) draft 方案 flag-on 才 emit ⇒ dark 期零数据，「看数据再翻 flag」死循环。修法 = M5′ shadow 周 sweep（flag 无关计算，dark 期就出数据）。回滚故事维持：flag OFF byte-identical、无持久借用态。
- **RP8（新增，Lens A A1/A5）— A5 解规模可扩展性悬崖**：`solveDense` O(n³)/O(n²) 内存跑在整个 requested 集上；tree.ts 全树请求 n≈5000 ⇒ 每次树读 ~10¹¹ flops。`graph-laplacian.ts:161-162` docblock「small neighbourhoods … a few KCs」对 tree caller 是 **stale 假话**（须修）。界定解规模是 **A5 翻 flag 硬前置**。
- **RP9（新增，Lens B F1 引申）— A13 emit 未设 `ingest_at`**：翻 flag 后每答错 × N 前置事件 × affected_scopes 全部触发 brief-regen（extraction gate 挡不住扇出）。dark 今日零影响；须在翻 flag 前决定 opt-out（M3′）。

---

## 2. 目标 / 非目标

### 目标
1. **RP2 结构分离**：provenance 判别式 + 就地平滑可见性（raw mean 保留）+ 审计——consumer 无法把借用/被平滑值静默当实测 surface。
2. **RP1′ 语义成文**：双轴（count 轴 p(L) / ability 轴 θ）契约写进 ADR；θ̃ 进 band 作为 owner 选项带完整前置链呈报，不默认采。
3. **RP3 收敛一份 ratify-ready ADR-0047**（撞号解决 + 四机制 radius/cycle/provenance/decay 契约表 + register 假句修正）。
4. **RP8 翻 flag 硬前置成文 + 守卫落码选项**：A5 解规模界定（component cap / 稀疏 solver）两案并呈。
5. **RP7 可观测**：shadow 周 sweep 让 owner 在 dark 期就拿到「翻 A5/A6 会改多少、幅度多大、分量多大」的分布数据（数据门只 gate 翻转不 gate build——埋点先通电，且不耦合热读路径、不污染 memory outbox）。
6. **RP9 收口**：A13 事件 memory-ingestion opt-out（owner-ratifiable 保守默认）。
7. 每个决策**轻量案 + 完整案并呈 owner**（反过度工程协议已撤回）。

### 非目标
- **不翻任何 flag**（A5/A6/A13/Rust coldstart 保持 dark）；act-flip 绑各自 validation gate（V-A5-LOKO 等）+ 本稿新增硬前置。
- **不拟合 item 参数 / 不引入 cohort 维度**（DROP-7 红线）；所有常量 owner-fixed，标「未经数据校准的保守初值」。
- **不做 GGM/chain-graph 全统一、不 EM/MLE**（register L625 两 adversary 已否）。
- **不给实体加 subject 列、不动树**；**不 raw-UPDATE fold-owned `knowledge_edge`**；不实现「删最低置信边」。
- 不建 C/D satellite 消费路径（register defer）。
- **不改借用数值语义**（M1 撤回后本单元零算法数值变更——全部改动是 provenance/观测性/守卫/文档）。

---

## 3. 决策表（reconcile 后）

> 每决策点轻量案 (L) / 完整案 (F) 并呈；判决 = 推荐默认；owner 可覆盖。

### Q1′ — observed/inferred 分离形态（原 Q1 + A4 补刀 + M1 撤回归并）

| 选项 | 形态 |
|---|---|
| **L（推荐默认）** | ① `MasteryProjection`（`state.ts:348-365`）加 `provenance: 'observed' \| 'inferred'`（观测组装 :397-425 set `'observed'`；借用块 :565-578 set `'inferred'`）+ 纯 helper `isObserved(p)`。② **就地平滑可见性（A4）**：加可选字段 `theta_hat_raw?: number`——soft layer 移动观测 KC 均值时（:545）保留原 θ̂；flag-off 该块不入 ⇒ 字段缺席；借用条目无 raw（provenance 已标 inferred）。③ 静态审计 `pnpm audit:mastery-provenance`（report-only，mirror `audit:relations`）：读 `.mastery`/`.theta_hat` 而同作用域无 provenance/isObserved/evidence_count 检查的站点报 STALE，allowlist 带 `resolves_when{kind,ref,expected_by}`。④ **借用数值语义不动**：band 保持冷 σ(−β)（双轴 by design，RP1′）。 |
| **F** | `getMasteryProjection` 返回 `{observed, inferred}` 判别联合，编译期强制 opt-in。blast radius = 9 caller 全解构改造；收益到翻 flag 才兑现。 |
| **F′（owner 选项：θ̃ 进借用 band）** | borrowed band point = σ(θ̃−β)——**诚实框架**：这是 1PL ICC（`theta.ts` 家族），因 counts=0 使 PFA 退化为 σ(−β) 而用异族模型承接；同一 `.mastery` 字段从此双模型（observed=PFA、borrowed=1PL），β↔b 需 linking（ADR-0035 决定#1、`pfa.ts:17-22`）。**硬前置链（顺序不可换）**：(a) audit 升 hard-gate 且 9 caller 全过审（否则在护栏强制前抬高今日天然保守的 mastery 轴——Lens A A3）；(b) M5′ shadow 数据 ≥N 周 owner 审过背离分布；(c) ADR 显式记双模型 + linking caveat。 |

**判决**：**L**。draft 的 M1-L（默认改 band）**撤回**——它把自洽双轴误诊为矛盾、miscite p(L) 构念、且与 RP2 排序对冲（在 report-only 审计强制之前抬高借用 `.mastery`，让 9 个无门 caller 看到从未作答 KC 的「自信高掌握」，而今日 σ(−β) 恒保守水密）。F′ 保留为 owner 选项。F（判别联合）绑 V-A5-LOKO GO 记开放问题。**红线**：`provenance`/`theta_hat_raw` 是读模型字段，**不入 `mastery_state` schema**（加列诱导落库 → 污染三轴正交）。draft M1-F（band 宽度纳入传播不确定性）维持被 ADR-0035 corollary（`graph-laplacian.ts:28-34` mean-only，方差不可信）挡住，绑 V-A5-LOKO 过闸后重议。

### Q2′ — 保守传播形态（半径判决反转）

**Q2a 影响半径**

| 选项 | 形态 |
|---|---|
| **L** | 纯成文：§1.1 半径真相表进 ADR（A5 request-shaped 无上界 + 冷启衰减最慢；A6 真 1 跳；A13 16/10k fail-safe；Rust 全 DAG）；修 `graph-laplacian.ts:161-162` stale docblock；A5 解规模界定列为翻 flag 硬前置（届时再落码）。 |
| **F（推荐默认）** | L 全部 + **现在落 A5 分量守卫**：`applyKgSoftLayer` 内按 `related_to` 连通分量分块求解，加 `GRAPH_SMOOTH_COMPONENT_CAP`（owner-fixed 保守初值，建议 256，标「未经数据校准」）——超界分量 **fail-safe-to-no-smoothing + 单点结构化 warn**（mirror `learnable-frontier.ts:268-279` overflow warn 形态）。flag dark ⇒ 块不入 ⇒ 零行为变更；翻 flag 时悬崖守卫已在。分块本身也把 O(n³) 降为 ΣO(nᵢ³)（nᵢ=分量尺寸；分量间本就零耦合，分块是纯等价重排）。 |

**判决**：**F**（守卫代码近零险、翻 flag 硬前置提前落位）。**A13 的 ≤2 跳硬 cap（draft M3）撤回**：它是实质行为变更（depth-3=0.25 经 MAX 可为唯一贡献）、会在 owner 定阈前改变埋点分布、且把纪律加错了机制（Lens A A6——真正无界的是 A5）。cap 保留为 owner 选项，**绑 emit 分布数据后再议**。

**Q2b 连续置信**：**保持连续（已实现），仅成文**。`knowledge_edge.weight`（schema :1311-1312）modulates A5/A6；CONFIDENCE-only、永不当 mastery。**A13 乘 weight（draft M3）撤回为默认**（Lens B F3）：闭包 CTE 只载 `(prereq_kc, source_kc, depth)` + `SELECT DISTINCT` 折叠（`server/mastery/prereq-propagation.ts:108-139`），「edgeWeight」对 depth-d 闭包边欠定义（即时边 vs 路径乘积）；若取路径乘积须在递归里累积乘积列 → 破坏 DISTINCT 折叠 → 改 MAX 语义。owner 若将来采：**定义 = 路径 weight 乘积，在 CTE path 旁累积，聚合改为对 (prereq,source) 取最大乘积权路径**——成本与语义写进 ADR，默认不做（A13 尚无 live 消费者，确定性负担收益薄）。

**Q2c 遇环**：**维持 draft L**——成文四机制各自环契约 + 显式「借用侧永不修图（删边/改权），遇环只读容忍或 fail-safe-to-noop，绝不写 fold-owned edge」。自愈删边 job（经事件层、mirror `merge_attribution_sweep` 的 forensic+可回滚形态）划归图治理单元，记开放问题。

### Q3′ — 落点（Rust vs TS）

**判决维持：本单元零 Rust 改动；出处标记 + gating 留 TS**。理由修正（Lens A A5）：A6 kernel 平凡（O(E) 加法）零收益；A5 GMRF 是唯一重数值，但它的问题不是「port 提速 nicety」而是「解形态在 batch-read 尺寸下不可扩展」——**先界定解规模（Q2a-F 分量守卫 / 将来稀疏 CG solver / per-request 局部化），再谈 port 语言**。S6 defer 触发条件 =（A5 flag 翻 + bit-exact 跨端一致或大分量性能需求），前置 =（YUK-501 wasm CI skip 接通 + **deployment-aware loader**——`propagate-priors.ts:73-76` 白纸黑字：cwd-relative `NODE_PATH`（:76）下「a deployment-aware loader is an explicit PREREQUISITE of flipping the flag on in a deployed server」，连 coldstart Rust 都未接生产，任何新 port 继承同 gap（Lens B F6）+ wasm32-wasip1-threads/napi 双构建面 + crate `napi.targets:["wasm32-wasip1-threads"]` per `napi WASM loader recipe`）。

### Q4′ — tracked-trigger（A13）处置

**判决**：A13 数值/拓扑行为**零改动**（≤2 cap 与 weight 均撤回，见 Q2′）。仅两件事：① 纳入统一 ADR-0047（「四机制之一/诊断向后半」，`risk_delta` 标 inferred 信号，将来消费须走 provenance 契约）；② **`ingest_at: now` opt-out（M3′，RP9）**：`emitPrereqRiskSignal` 的 writeEvent 加 `ingest_at: now`——观测类 experimental 事件不喂 memory/brief（YUK-190 auto-enroll 先例；`queries.ts` WriteEventInput docblock「never spawns a Mem0 add or brief-regen」）；这不改事件本体/payload/时序，只挡翻 flag 后「每答错 × N 前置 × scopes」的 brief-regen 扇出。owner-ratifiable：若 owner 要 prereq_risk 进 memory 可撤。消费侧阈值维持 owner deferred（「先埋点 N 周再定阈」，`prereq-risk.ts:22-25` / ADR-0040 决定2）。

### Q5 — 衰减/复核

**判决维持 draft L**：inferred 靠读侧重算自衰减（真证据一到 likelihood 盖过借用），无独立 time-decay——加了反而引入持久借用态、破坏 flag-OFF byte-identical；authored 边靠 `archived_at` 软归档；二者生命周期正交，成文进 ADR。A13 事件消费侧时间窗（若将来消费）落消费侧读时衰减，绑消费解锁。

### Q6′ — 可观测与回滚（形态重做）

| 选项 | 形态 |
|---|---|
| **L（推荐默认）— shadow 周 sweep** | 新 job `kg_borrow_shadow_sweep`（`src/capabilities/knowledge/jobs/`，manifest 登记，weekly cron 错开 `projection_oracle_sweep` 的 `'30 4 * * 1'`，同其 REPORT-ONLY 纪律）：**flag 无关**读 live `mastery_state` + `related_to`/`prerequisite` 边，按连通分量（≤`SHADOW_BORROW_COMPONENT_CAP`，超界 skip+记尺寸——这本身就是 RP8 要的规模数据）跑 `smoothTheta`/`propagatePrereq` 纯函数 shadow 计算，产**一条**汇总事件 `experimental:kg_borrow_shadow`，**`ingest_at: now`**（F1 opt-out，零 memory/brief 扇出）。payload 顶层 `observed_count` + **三 variant 归因** `{a5_only, a6_only, joint}`（**共享单次 A5 稠密解**：a5_only 直接总结 smoothed θ̃、a6_only=`propagatePrereq(裸 θ̂)`、joint=`propagatePrereq(smoothed θ̃)`——owner 分别看每 flag 的边际效应与联合），每 variant `{observed_moved_count, would_borrow_count, delta_theta, borrowed_theta}`；**分量统计只顶层一份**（`component_count / component_size_max / component_size_histogram / skipped_*`——A5 结构量，非 per-variant）+ `flags/常量 snapshot` + `threshold_deferred:true`。分位数 = **type-7 线性插值**（`@/core/theta` `quantile`，与全仓一致；min/max 取排序端点）；直方图桶**随 component cap 派生**（2 的幂至首个 ≥cap + 一个 overflow 桶）。失败自吞 log（mirror `propagate-priors.ts` DARK-SHIP RESILIENCE）。 |
| **F** | L + 专用 admin observability 面（直方图/趋势）——绑 owner 认真评估翻 A5 时再建；L 的事件可被 `admin/logs` 现有面查询。 |

**判决**：**L**。draft 的 per-read emit（含 console.log 退路）**整体撤回**——三重错：memory-outbox/brief-regen 扇出（extraction gate 挡不住）、per-read cadence（9 caller 热路径 + attempt compose tx 内耦合）、flag-on 才有数据的死循环。shadow sweep 三重对：dark 期就出数据（「数据门只 gate 翻转」的正解）、有界 cadence、零读路径耦合。回滚成文维持：flag = module const（无 config 表无 env），读侧重算 ⇒ OFF 瞬时 byte-identical；sweep 事件 fold-inert（无 gather 读）+ threshold_deferred，回滚后成孤儿无害。

---

## 4. 机制设计（file:line 级，reconcile 后）

> 全部 dark（不翻 flag）、不写 fold-owned 表、**零借用数值语义变更**。新常量一律标「owner-fixed / 未经数据校准的保守初值」。

### M2′ — provenance 判别式 + 就地平滑可见性（Q1′-L；取代 draft M1+M2.1/M2.2）
- `state.ts:348-365` `MasteryProjection` 加 `provenance`（required）+ `theta_hat_raw?`（optional）；观测组装（:397-425）set `'observed'`；soft layer 移动观测均值处（:545）同时 set `theta_hat_raw = 原 θ̂`；借用块（:565-578）set `'inferred'`。
- 导出 `isObserved(p)` 纯 helper。
- **触及全部 MasteryProjection literal 构造点（Lens B F5）**：两个测试 factory——`src/capabilities/agency/jobs/research_meeting_nightly.unit.test.ts:49-60` 与 `src/server/conjectures/evidence.test.ts:57` 的 `projection(...)` helper——required 字段 typecheck 会 fail，入 S1 touch 清单。
- byte-identical 锚说明：加 required 字段是 flag 无关的**类型形状变更**，flag-off 回归锚更新为「新形状下，soft-layer 不变量 = 无借用条目、无 theta 移动、无 theta_hat_raw」。
- **红线**：字段只在读模型，不入 `mastery_state` schema。

### M2″ — provenance 审计（draft M2.3 保留）
- `scripts/audit-mastery-provenance.ts` + allowlist + `pnpm audit:mastery-provenance`；fs-walk 9 个直接 caller 文件 + 传递消费者；**默认 report-only（exit 0）**（今日全 dark 无 live 误用）；升 hard-gate 绑「任一借用 flag 翻转」前置（开放问题 4，含 guarded 启发式残留限制）。`docs/design/2026-05-15-data-assumptions.md` 补节。
- **判据硬化（C1/C2）**：scan 先 `stripCommentsAndStrings`（注释/字符串/模板剥离），guard 收紧为 **code-shaped**（`.provenance`/`isObserved`/`.evidence_count`，非裸 substring）——注释里的同名 token 不再假 guarded（`knowledge-readers.ts`/`conjectures/evidence.ts` 因此正确翻 unguarded，已进 allowlist）。**tracked 文件缺失 ⇒ MISSING ⇒ ok=false**（`--strict` 非零 exit）——手维护的 tracked 列表是契约，改名/删除的 consumer 须重新接地不静默跳过。

### M3′ — 卫生与守卫（取代 draft M3）
- **A5 分量守卫（Q2a-F）**：`applyKgSoftLayer`（`state.ts:462`）按 `related_to` 连通分量分块调 `smoothTheta`；新 `GRAPH_SMOOTH_COMPONENT_CAP = 256`（core 层 const，owner-fixed 保守初值）；超界分量 no-smoothing + 单点结构化 warn。flag dark ⇒ 零行为。
- **A13 memory opt-out（Q4′/RP9）**：`emitPrereqRiskSignal`（`server/mastery/prereq-propagation.ts:174-261`）writeEvent 加 `ingest_at: now` + docblock（YUK-190 先例引用）。dark 期 emit 恒 0，行为不变。
- **stale docblock 修**：`graph-laplacian.ts:161-162`「small neighbourhoods … a few KCs」改为如实描述 request-shaped 解规模 + 指向 component cap；`state.ts` `applyKgSoftLayer` docblock 补半径真相一句。
- **撤回项（不实施）**：A13 ≤2 跳 cap、A13 × edge.weight——语义与成本写进 ADR 供 owner 将来按 emit 分布决。

### M4′ — ADR-0047 收敛（draft M4 + 增量）
- 纯文档：① A11 文件重编号（扫 `docs/adr/` max+1，更新交叉引用）；② 两 on-topic 0047 合并成 ratify-ready「KG 承重借用：relation_type→机制映射 + 诊断向后传播 + 借用 provenance 契约」，章节：borrow×B3 交互（evidence-floor 已关 + 双轴语义成文——**修正 register L627 假句**：借用块确实合成 .mastery/.theta_se/band）、四机制 radius/cycle/provenance/decay 契约表（§1.1 真相表）、**A5 翻 flag 硬前置包**（分量守卫/解规模 + provenance audit 升 hard-gate + shadow 数据 ≥N 周）、Rust 落点与触发条件 + S6 前置（deployment loader + YUK-501 + 双构建面）、A13 opt-out 决策记录、F′（θ̃ 进 band）前置链。③ Status 保持 Proposed，owner ratify。

### M5′ — shadow 借用遥测 sweep（Q6′-L；取代 draft M5）
- 见 Q6′-L 形态。落点 `src/capabilities/knowledge/jobs/kg_borrow_shadow_sweep.ts`，manifest jobs 登记；queue 跟 `projection_oracle_sweep` 同 bucket 纪律（写 evidence 走 DLQ/retry 家族）；`SHADOW_BORROW_COMPONENT_CAP` 与 M3′ 的 cap 对齐。零新表（复用 event，experimental:* 过 `parseEvent`）⇒ `FK_ORDER`/`SCHEMA_VERSION` 不 bump、`audit:schema` 不触发（Lens B U3——draft S4 的「audit:schema 若涉事件类型」是虚惊）。

---

## 5. 实施切片（PR 粒度 + pre-flight）

> 全部 dark；零 Rust；零 schema/新表。并行度：S1 独立；S2 依赖 S1；S3/S4 独立；S5 收口。

| 切片 | 范围 | 关键 pre-flight |
|---|---|---|
| **S1 — provenance + raw-mean 可见性**（M2′） | `state.ts` 类型 + 三处 set + `isObserved`；**两个测试 factory 同 PR 修**（F5）。 | 全量 `pnpm typecheck`（required 字段 → 全 consumer 编译面，**在所有 edit 之后跑**）；`pnpm test:db:watch state.db.test.ts learnable-frontier.db.test.ts`（borrow×floor 交互 + byte-identical 锚重钉）；`pnpm test:unit:watch graph-laplacian prereq-propagation`；触及文件 biome。 |
| **S2 — provenance 审计**（M2″） | audit 脚本 + allowlist + package.json script + data-assumptions 补节。report-only。 | 自测（种「读 .mastery 无检查」fixture 报 STALE / allowlisted pass）；`pnpm audit:partition`。 |
| **S3 — shadow sweep**（M5′） | 新 job + manifest 登记 + db 测试（种边+mastery_state → 断言一条汇总事件、`ingest_at` 非空、超界分量 skip 计数）。 | `pnpm test:db:watch` 新 job 测试；`parseEvent` experimental shape 放行确认；`pnpm audit:schema`（应零触发）；cron 与 oracle sweep 错开。 |
| **S4 — 卫生守卫**（M3′） | A5 分量分块 + cap + warn；A13 `ingest_at:now`；两处 stale docblock。 | `pnpm test:unit:watch graph-laplacian`（分块解 = 全解逐分量一致断言 + cap 新行为单测）；`pnpm test:db:watch submit.db.test.ts`（dark 断言：emit 仍 0）；`pnpm audit:relations` 跑一遍（relation_type 过滤未动 ⇒ registry **零改动**——draft S4「须补 registry 一条」撤回，Lens B F3 注）。 |
| **S5 — ADR 收敛**（M4′） | 三文件重编号/合并；ratify-ready。 | `/audit-drift` 核 ADR↔代码；交叉引用 grep 清零。 |
| **S6（deferred，非本单元 build）— Rust A5 GMRF port** | 触发 =（A5 flag 翻 + bit-exact 或大分量性能）。 | 前置四件套：**deployment-aware loader（非 cwd-relative）+ .node/.wasm 进部署镜像**（F6）；YUK-501 CI 接通（否则 parity 无 gate）；wasm32-wasip1-threads + napi 双构建面；crate `napi.targets`。parity test mirror `native-parity.unit.test.ts`。 |

**全单元 pre-PR gate**（per CLAUDE.md）：`pnpm typecheck` + `pnpm lint` + `pnpm audit:schema` + `pnpm audit:partition` + `pnpm audit:profile` + `pnpm audit:draft-status` + 新 `pnpm audit:mastery-provenance` + `pnpm test` + `pnpm build`。fan-out lane 跑**全量** gate（含全仓 biome + audit-docs-invariant），非 targeted。

---

## 6. 测试与 gate

- **S1**：实测条目 `provenance:'observed'`、借用条目 `'inferred'`；soft layer 移动观测均值时 `theta_hat_raw` = 原 θ̂、未移动/flag-off 时缺席；借用条目 band 仍 = 冷 σ(−β)（**数值不变回归锚**——M1 撤回的 pin）；两 flag dark 时 soft-layer 不变量成立（新形状下重钉 byte-identical 锚，mirror `graph-laplacian.ts:51-54` 契约）。
- **S2**：STALE fixture / allowlist pass 自测。
- **S3**：shadow sweep 在 flag dark 下**照常出数**（设计要点）；一条事件、`ingest_at` 非空、payload 分位数确定性；无 mastery_state/knowledge_edge 写。**per-flag 归因断言**（db 测按 a5_only / a6_only / joint 分别钉 observed_moved_count/would_borrow_count——related_to-only ⇒ a6_only=0∧joint≡a5_only；prerequisite-only ⇒ a5_only=0∧joint≡a6_only；over-cap skip ⇒ 各 variant 皆 0）+ **分位数 convention pin**（unit 测钉 type-7：`[0..9] p50=4.5` + histogram 桶随 cap 派生 + `SHADOW_BORROW_COMPONENT_CAP===GRAPH_SMOOTH_COMPONENT_CAP`）。
- **S4**：分块 GMRF 与整解逐分量一致（分量间零耦合，纯重排）；超界分量 no-smoothing + warn 一次；A13 dark emit=0 不回归；A13 事件（测试直调 `emitPrereqRiskSignal`）`ingest_at` 非空。
- **gate 证据契约**：workflow agent 报 gate 须含原始命令输出尾部；degenerate 证据主 session 本地重跑。

---

## 7. 开放问题（owner 级）

1. **F′（θ̃ 进借用 band，1PL ICC）采不采**：前置链 =（audit 升 hard-gate → shadow 数据 N 周 → ADR 双模型+linking 成文），顺序不可换；不采则双轴现状 + 成文即终态。
2. **A5 翻 flag 硬前置包 ratify**：分量守卫 cap 值（初值 256）/ 将来稀疏 solver vs per-request 局部化的取舍、audit 升 hard-gate、shadow 数据周数 N。
3. **Q1′-F 判别联合升级**：绑 V-A5-LOKO GO。
4. **audit:mastery-provenance 升 hard-gate 时点**：建议绑「任一借用 flag 翻转」前置。**残留限制**：`guarded` 判据是「剥离注释/字符串后的 code-shaped token（`.provenance`/`isObserved`/`.evidence_count`）」启发式，非 AST 作用域——DTO-surfacing / 无关同名字段仍可能假 guarded（node-page/tree/detail/placement-profile 携同名字段却未真正 gate 本 projection 借用行为）。升 `--strict` hard-gate 须配人工复核 flagged/guarded verdict（AST 语义检测超本轮修复，归 owner flip 前置）。
5. **A13 三件**：`ingest_at:now` opt-out ratify（S4 默认落，owner 可撤）；≤2 跳 cap 与 edge.weight modulation 是否将来按 emit 分布采（语义已在 ADR 定义）。
6. **图自愈 job**（环检测 → 事件层 archive 最低 weight 边）归口图治理单元——确认归口。
7. **Rust port 触发条件 + S6 四前置**确认。
8. **ADR-0047 合并稿 ratify**（勿自行 ratify）。
9. **M1-F（band 宽度纳入传播不确定性）**：维持被 ADR-0035 corollary 挡住，绑 V-A5-LOKO 过闸后重议。

---

## 附 A：红线自查

- **n=1 不拟合 item 参数**：`GRAPH_SMOOTH_COMPONENT_CAP`/`SHADOW_BORROW_COMPONENT_CAP`、λ/κ/λ_down/λ_up、A13 base/decay 全 owner-fixed 标「未经数据校准的保守初值」；无 cohort、无 slip/guess/discrimination。✅
- **科目是视角非结构**：零 subject 列、零动树；借用读 `knowledge_edge` 拓扑，subject 经 domain 派生不涉。✅
- **fold-owned `knowledge_edge` 不 raw-UPDATE**：三处读边全 SELECT（终裁核实）；「借用侧永不修图」显式红线；删边（图治理 F 案）走事件层独立 job 且不在本单元。✅
- **反过度工程协议已撤回**：Q1′/Q2a/Q6′ L/F 两案并呈，F′ 单列。✅
- **evidence-first 可追溯可回滚**：shadow sweep 事件留痕（常量/flag snapshot 随事件）；flag OFF byte-identical、无持久借用态；sweep REPORT-ONLY。✅
- **数据门只 gate 翻转不 gate build**：全 dark 实现 + shadow 埋点 **dark 期就通电出数**（修正 draft 的 flag-on-才有数据死循环）。✅
- **推断边 vs authored 边语义分离**：provenance 判别式 + theta_hat_raw + 「inferred 读侧重算自衰减 / authored archived_at 软归档」正交成文；OSS 三锚点印证（Graphiti 锚点按 A1 修正后仍指向「失效本地化」目标——A5 分量守卫即其落地）。✅
- **Rust 同构核 wasm/napi 双面**：本单元零 Rust；S6 明标双构建面 + YUK-501 + deployment-aware loader。✅

---

## 附 B：Attack 裁决 ledger

| # | Lens | 裁决 | 理由（终裁独立 code-ground） |
|---|---|---|---|
| A1 | A | **ACCEPT（MAJOR）** | 核实 `tree.ts:99` 全树（≤5000）入 `getMasteryProjection`、`loadEdgesForProjection` 载边范围≠影响半径、GMRF 联合解耦合全分量。draft「A5/A6=1 跳」对 A5 假（单 KC 请求才 ≈1 跳）；半径纪律移到 A5、撤 A13 cap。**一处数值精化**：A1 的「每跳保留 ≈0.98」不准——未观测链衰减因子 r 解 λr²−(2λ+κ)r+λ=0，λ=0.5/κ=0.01 下 r≈0.87（5 跳 ~50%）；实质结论（远超 1-2 跳、冷启最慢衰减）不受影响。 |
| A2 | A | **ACCEPT（MAJOR；一子论证降级）** | 双轴 by-design 核实（`state.ts:544-545`、:450-457 docblock、:403 观测 band 同样纯 PFA——band 全系统从不读 θ）；miscite 核实（`learnable-frontier.ts:81-85` = σ(PFA logit)，非 σ(θ̂−b)）。**降级子论证**：「M1 违反 MEAN-ONLY 契约」按契约原文（scope 到 observed KCs 的 band/variance）不成立——真约束是模型构念分离 + β↔b linking，非 MEAN-ONLY 字面。net 结论不变：M1 默认撤回、RP1 降级为 RP1′。 |
| A3 | A | **ACCEPT（MAJOR）** | 今日借用 `.mastery`=σ(−β) 恒保守；M1 会在 audit 仍 report-only 时抬高 9 个无门 caller 看到的借用 mastery。F′ 前置链固定「enforce 先于数值变更」。 |
| A4 | A | **ACCEPT（MED）** | `state.ts:545` 就地覆写核实；二元 provenance 不覆盖被邻居主导的弱观测均值。修入 M2′ `theta_hat_raw`。 |
| A5 | A | **ACCEPT（MED）** | `solveDense`（`graph-laplacian.ts:218`）O(n³) + tree n≈5000 核实；`graph-laplacian.ts:161-162` docblock stale 核实。Q3 结论不变、理由翻转；解规模界定 = A5-flip 硬 gate + M3′ 分量守卫。 |
| A6 | A | **ACCEPT（MED）** | `PREREQ_RISK_DEPTH_DECAY=0.5`/`BASE=1`/MAX 聚合（`prereq-risk.ts:35,28,115`）核实：depth-3=0.25 非「微」；`prereq-risk.ts:22-25` 先埋点再定阈——cap 会预污染分布。≤2 cap 撤回为默认，owner 选项绑 emit 分布。 |
| F1 | B | **ACCEPT（MAJOR）** | `writeEvent` 默认 `ingest_at:null`（`queries.ts` WriteEventInput docblock + insert :1058）、cb0abb09 `triggers.ts:320-329` brief-regen 扇出对 extraction-gated 事件照跑——全部核实。遥测事件路径必须 `ingest_at:now`；A13 同款 latent → M3′ opt-out（RP9）。 |
| F2 | B | **ACCEPT（MAJOR，终裁增强）** | per-read cadence 对任何 sink 都错（9 caller + `learnable-frontier.ts:297-303` attempt-tx 内）核实；`projection_oracle_sweep` 范式核实（weekly、REPORT-ONLY、fold-inert breadcrumb）。**增强**：sweep 做成 **shadow（flag 无关）**计算——draft 的 flag-on-才 emit 在 dark 期零数据，是「等数据翻 flag」死循环；shadow 直接修掉，且 skipped-component 计数顺手产出 RP8 要的规模数据。 |
| F3 | B | **ACCEPT（MED-LOW）** | CTE 无 weight 列 + `SELECT DISTINCT (prereq,source,depth)`（`server/mastery/prereq-propagation.ts:108-139`）核实；weight-through-closure 欠定义 + DISTINCT/MAX 冲突成立。默认不乘（与 A6 裁决同向）；路径乘积语义写 ADR 供 opt-in。audit:relations registry 零改动（relation_type 过滤未触）——draft S4 该句撤回。 |
| F4 | B | **ACCEPT（MAJOR，与 A2 合并）** | miscite 同 A2 核实；「同一 Map 双 recall 模型」后果成立——若 owner 采 F′ 必须诚实框架为 1PL ICC 承接 PFA 退化 + 双模型标注。 |
| F5 | B | **ACCEPT（LOW）** | 两个 `MasteryProjection` literal factory 核实（`agency/jobs/research_meeting_nightly.unit.test.ts:49-60`；`src/server/conjectures/evidence.test.ts:57`）。入 S1 touch 清单。 |
| F6 | B | **ACCEPT（LOW）** | `propagate-priors.ts:73-76` deployment-aware loader = flip 显式 PREREQUISITE、`NODE_PATH` cwd-relative（:76）核实。入 S6 前置。 |

**draft 侧自纠（终裁发现，非两 lens 提出）**：① `knowledge_edge.weight` schema 引用修正为 :1311-1312（draft 引的 L130/176 是 misconception/misconception_edge 的 weight）；② consumer 计数 ~24 → 9 个直接 call site；③ A13 call site 行号改引 dark 契约 docblock（`server/mastery/prereq-propagation.ts:9-21`）而非易漂移的 submit 行号。

---

## 附 C：独立 review 环裁决（2026-07-04）

S1-S5 实施后跑独立 review 环（8 finder 广度扇出 + fable 终裁逐簇实读代码/实跑 audit 复现）。**全部修复零触 live 算法数值**（C3/C9 位等价重排；C4-C7 只改 fold-inert 零消费者 shadow 观测 payload；C1/C2 是审计工装）——S1/S4 的 byte-identical 锚测试（`state.db.test.ts` / graph-laplacian「分块=整解」单测）期望值零改动、原样绿。裁决者 = 8 finder + fable 终裁。

**修入（C1-C11，一行一条）**：
- **C1**：audit guard-token 假 guarded（五方收敛，最重）——`stripCommentsAndStrings`（注释/字符串/模板剥离）+ GUARD 收紧为 code-shaped regex（`.provenance`/`isObserved`/`.evidence_count`）；verdict 位移**恰**为 `knowledge-readers.ts` + `conjectures/evidence.ts` 翻 unguarded → 补 allowlist（其余 6 tracked 维持 guarded，实跑 `audit:mastery-provenance` 核验位移）；self-test 补注释/字符串 token fixture。
- **C2**：missing verdict 翻 fail——result 加 `missing[]`，非空 ⇒ ok=false + `--strict` 非零 exit；self-test missing 场景断言 ok=false。
- **C3**：`partitionByComponent` O(E) 桶化（`graph-laplacian.ts`）——union-find 后一趟 O(E) 分桶，`connectedComponents` 变薄 wrapper（公开 API 零变），`smoothThetaByComponent` 消费桶；位等价（边序保持 ⇒ 浮点 bit-identical）。
- **C4**：分位数 type-7——`quantileSummary` p50/p90/p99 改调 `@/core/theta` `quantile`，min/max 取排序端点。
- **C5**：sweep 三 variant 归因——`computeShadowBorrowStats` 产 `{a5_only, a6_only, joint}`（共享单次 A5 稠密解），payload 顶层 `observed_count` + per-variant 计数/分位数 + 分量统计只顶层一份；db 测 + console.log 同步。
- **C6**：`component_size_max` 由 `Math.max(...spread)` → reduce-based（防大数组 RangeError）。
- **C7**：`componentHistogram(sizes, cap)` 桶由 cap 派生（2 的幂至首个 ≥cap + overflow；cap=256 逐字节同旧）。
- **C8**：测试强度——新 sweep 单测（type-7 pins `[0..9] p50=4.5` / histogram cap 派生 / 三 variant 归因 + `component_size_max`）+ 共享 splitter `derived_from` 翻向 + 准入 type 单测 + `SHADOW_BORROW_COMPONENT_CAP===GRAPH_SMOOTH_COMPONENT_CAP` + `isObserved` 单测（放 mastery 单测文件）+ self-test c.ts allowlist redundant fixture。
- **C9**：edge-split/eps 单源化——`state.ts` 导出 `PROJECTION_EDGE_RELATION_TYPES` / `splitProjectionEdgeRows` / `BORROW_EPS`，live `loadEdgesForProjection` 与 sweep 双双消费，删 sweep `SHADOW_EPS`；纯 code motion，live 位等价。
- **C10**：ADR-0047 ratify 清单追加 Q1′-F 判别联合升级（绑 V-A5-LOKO GO，spec §7-3）。
- **C11**：worktree CLAUDE.md Commands 节补 `audit:mastery-provenance` 行。

**REFUTE 留档**：257 节点 default-cap 实跳测试提议——现有引用赋值 + 等式断言（over-cap skip + 「分块=整解」逐分量一致）已足够钉住 cap 语义与位等价，无需额外大规模跳测。

**降级留档（归 owner flip 前置 / docs-low）**：① DTO-surfacing 假 guard（node-page/tree/detail/placement-profile 携同名字段却未真正 gate 本 projection）——AST 语义检测超本修复轮，归 owner 升 `--strict` hard-gate 前置 + 人工复核（成文进 §7 Q4 + audit docblock）；② conventions 混合先例——`audit:projection` 同缺统一 quantile convention，按 docs/low 记，非本轮硬修。

**不翻案确认**：register L552 / §7 九项 ratify / S6（Rust A5 GMRF port，deferred）/ executor 4 条声明偏离（scout 原文磁盘不存在等）/ 数值对抗面 CLEAN（M1 撤回后零算法数值变更，byte-identical 锚原样绿）——均维持终稿结论，本 review 环不翻案。

---

**关键交付说明（给 orchestrator）**：scout 原文件磁盘不存在（gitignore 未落盘），四锚点已由终裁独立 code-ground（§1.3，其中 Graphiti 锚点结论对 draft 反转）。本终稿相对 draft 的三大改判：**M1 撤回**（双轴 by-design，θ̃ 进 band 降级为带硬前置链的 owner 选项 F′）、**半径纪律从 A13 移到 A5**（A5 request-shaped 无界 + O(n³) 悬崖 = 翻 flag 硬前置，落 M3′ 分量守卫；A13 ≤2 cap 与 weight 撤回）、**遥测重做为 shadow 周 sweep**（flag 无关、`ingest_at:now`、一条汇总事件——修 memory 扇出 + per-read cadence + dark 期零数据三重错）。收敛后本单元**零算法数值变更、零 Rust、零 schema**：S1 provenance、S2 审计、S3 shadow sweep、S4 卫生守卫、S5 ADR、S6 deferred Rust。

---

## 附录 — 决策处置实录(2026-07-04)

本单元 reconcile 终稿的 9 个开放问题**全部是未来翻转的 owner-ratify 项,无一 gate 当前 dark 实施波**(零算法数值变更/零 Rust/零 schema/全 dark)。按 owner 全自主授权(小决策静默+记录,只大分歧 surface)直接推进 S1-S5 实施;9 项 ratify 清单原样保留在 §7 与 Linear YUK-559,owner 可随时否决或翻转。S6(Rust A5 GMRF port)deferred,不在本 PR。

Linear:YUK-559(parent YUK-538)。
