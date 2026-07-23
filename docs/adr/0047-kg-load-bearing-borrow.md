# ADR-0047 — KG 承重借用：relation_type→机制映射 + 诊断向后传播 + 借用 provenance 契约

**Status**: Accepted — governance/contract ratified; empirical decisions and runtime activation deferred (YUK-675, 2026-07-23). This acceptance does not authorize any flag flip.
**Part of**: YUK-441（A5 图-Laplacian 平滑先验）+ YUK-442（A6 prereq 有向 θ̂ 传播）+ YUK-455（A13 prereq 诊断向后传播 producer）+ YUK-559（kg-borrowing 借用纪律加固：provenance 契约 / 分量守卫 / shadow 遥测）。P4「KG 承重」里程碑——让知识图谱的边数学承重于 per-KC mastery。
**Partially supersedes:** [ADR-0036](0036-dual-layer-heterogeneous-knowledge-graph.md) Decision 4 (RT2) only. ADR-0036’s remaining decisions stay authoritative.
**Decision source**: 数学 dossier `docs/superpowers/research/2026-06-20-axis2-calibration-math-dossier.md` §1(a)/§2 A5 行 + YUK-441/442「数学 dossier 裁决」comment（2026-06-20）+「🛠 实施讨论 · grounded」comment（2026-06-27）+ YUK-452 §6 Q5（A13 owner 裁决）+ `docs/design/2026-07-04-kg-borrowing-spec.md`（reconcile 终稿：M1 撤回 / 半径纪律从 A13 移到 A5 / 遥测重做 shadow）。
**Related**: ADR-0010（knowledge_edge typed mesh / relation_type 核心集合）· ADR-0021（event memory-ingestion outbox opt-out）· ADR-0034（结构一致性闸 + `archived_at` 软归档，取代 bi-temporal）· ADR-0035（三轴正交 + p(L) 诊断轴 + 不确定性必过校准闸 corollary）· ADR-0036（双层异构 KG）· ADR-0040（决定2「先埋点 N 周再定阈」）· YUK-357 `audit:relations`（KG 死边反向审计）· YUK-539（evidence-floor，已关 register P1 判据）· YUK-551（frontier-gate 借用侧 UI/tone）· YUK-559（本单元）。

> 合并记录（YUK-559 / S5，2026-07-04）：本文合并原两篇 on-topic 的 ADR-0047 草案
> （`0047-relation-type-to-calibration-mechanism-mapping.md` A5/A6 映射 +
> `0047-prereq-diagnostic-backward-propagation.md` A13 诊断向后传播），并补齐 kg-borrowing
> 单元的 provenance 契约 / A5 分量守卫 / shadow 遥测 / F′ 前置链。无关的 A11 速度-精度描述符
> 已从 0047 重编号为 `0048-a11-caution-speed-accuracy-axis-ez-diffusion.md`。

---

## 背景

`knowledge_edge.relation_type`（ADR-0010 核心集合）有 5 个有意义的 type：`prerequisite`、`related_to`、`contrasts_with`、`applied_in`、`derived_from`。P4 之前这些边只被三类消费：creation-validation（rubric-validator 提议时校验）、generic-read（copilot 邻域一把灌）、少量 specialized（topology-gate 仅 prerequisite 环检测、hub-mesh 笔记上下文）。**没有任何「按 relation_type 驱动 mastery 诊断」的消费**——图在长但不影响 per-KC 能力估计。

「KG 承重借用」把边接进 mastery 诊断轴（`mastery_state.theta_hat` 的读侧投影 `getMasteryProjection`，`src/server/mastery/state.ts`）。这催生了**四个同名异实的「prerequisite propagation」机制**，全 dark（flag 默认 false），语义/半径各异：

| 机制 | 方向 | 数值形态 | 影响半径 | flag |
|---|---|---|---|---|
| **A5** 图-Laplacian 平滑 | 对称（`related_to`） | proper GMRF 联合稠密解（`solveDense` O(n³)） | **request-shaped，无结构上界**（见决定 6/8） | `GRAPH_LAPLACIAN_ENABLED` |
| **A6** prereq 有向 θ̂ 传播 | 有向（`prerequisite`/`derived_from`） | 单趟 O(E) 加性 Δθ | 真 1 跳 | `PREREQ_THETA_PROPAGATION_ENABLED` |
| **A13** prereq 诊断向后 emit | 有向逆走（答错→上溯前置） | 闭包 + 当前 dark provisional 几何衰减 0.5^(d−1)，MAX 聚合，emit 事件 | 当前 dark 行为 depth≤16 + node-cap 10k + path-guard，overflow fail-safe→[]；这些界值未获 live ratification | `PREREQ_RISK_EMIT_ENABLED` |
| Rust coldstart | day-one(n=0) 向前 DAG 先验 | Kahn 拓扑前向，probabilistic-AND | 全 DAG，遇环 reject | `DAY_ONE_PRIOR_ENABLED` |

不同 relation_type 的数学语义不同，混用会污染 firm-up：对称平滑假设同质，有向边假设序，对立边是反向信号。本 ADR 钉死映射 + 承重借用的 provenance / 半径 / 环 / 衰减契约。

## 决定

### 1. relation_type → 机制映射表（钉死）

| relation_type | 方向性 | 喂的机制 | 进 A5（对称平滑）| 进 A6（有向传播）| 依据 |
|---|---|---|---|---|---|
| `related_to` | 对称 | **A5** 图-Laplacian GMRF 平滑先验 | ✅ | ❌ | L 必须无向/对称/PSD。`related_to` 是唯一对称同质边。 |
| `prerequisite` | 有向（from 是 to 的前置）| **A6** 有向软序先验（读侧）+ **A13** 诊断向后（emit） | ❌ | ✅ | 有向序 P(掌握 from) ≥ P(掌握 to)。 |
| `derived_from` | 有向（from 派生自 to ⇒ base=to）| **A6** 有向继承（base `to` 当 prereq-like）| ❌ | ✅ | ADR-0010：`from 派生自 to`，base 是先导。orientation 翻转 vs prerequisite。 |
| `contrasts_with` | 对立 | **两者都不进** | ❌ | ❌ | **反向信号**：易混项混入平滑会把对立项当同类 → 污染 firm-up。 |
| `applied_in` | 有向 | 暂不进（有意死边候选，YUK-357）| ❌ | ❌ | 无明确序/平滑语义。 |

**钉死三句**：① `related_to` → A5（且仅 A5）；② `prerequisite` → A6 读侧 + A13 诊断向后，`derived_from` 仅以反向 orientation（`to` 为 base）进 A6；③ `contrasts_with` A5/A6/A13 都不进。relation_type 不相交、不双计；`derived_from` 若要进入 A5/A13，须另立 ADR 并由 owner disposition。

### 2. A5 = proper GMRF，不是裸 improper prior

裸 `p(θ) ∝ exp(−½ λ θᵀLθ)` 是 improper：图 Laplacian 有零空间（常数平移 L·c·1=0），整体 level 不可识别，全未观测分量永不 firm up。**必须**升级成 proper GMRF `θ ~ N(μ₀, (λL + κI)⁻¹)`——κI 让精度矩阵正定，锚在先验均值 μ₀（默认 0）。后验均值解 SPD 系统 `(D + λL + κI) θ̃ = D θ̂ + κμ₀`（D=每 KC 观测精度对角阵）。

### 3. A6 = 软序先验/惩罚，不是硬序约束

prereq 边 k₁→k₂ 编码软序信念 P(掌握 k₁) ≥ P(掌握 k₂)，落成加性、单向的惩罚/credit（按 ordering 违背量 `max(0, θ̂_dep − θ̂_pre)` 驱动）：答错先修/前置弱 → 压下游；答对高阶 → retro-credit 先修。硬序约束在 LLM 生成的错边上太强——错边会静默腐蚀 firm-up。软化 + 读侧重算 ⇒ 边可修订。

### 4. A13 = prereq 诊断「向后传播」producer（dark，emit-only）

学习者答错 KC B → 沿 prereq 边向上找 B 的 transitive 前置 A → 上调 A 的掌握风险增量 `risk_delta = base_weight · decay^(depth−1)`（depth 1 = 直接前置，MAX 聚合），作为**独立 `experimental:prereq_risk` event 投影**喂画像。

- **承载 = 通用 event outbox（零新表）**：`subject_kind='knowledge'`、`subject_id=前置 A`、`caused_by=触发的 attempt event`，经 ADR-0005 single-owner `writeEvent` 写入。避开 5 面登记 + 写者纪律。
- **只做诊断向后**；选题 gating（A 未掌握 ⇒ 降权/锁依赖 A 的 KC 选题）缓做（改 live 练习流，单拎后议）。
- **红线（ADR-0035）**：向后风险**绝不**折进 `mastery_state.theta_hat / fail_count`——前置 A 从未被作答，写「假 fail」会污染 Elo 充分统计量。
- **threshold_deferred**：`base_weight`/`decay` 是 owner 固定先验，精确取值 N 周埋点后定（ADR-0040 决定2）；每条事件带 `threshold_deferred:true`，埋点期不 gate 任何 live 行为。
- **memory-ingestion opt-out（YUK-559 S4 / RP9）**：`emitPrereqRiskSignal` 的 writeEvent 带 `ingest_at:now`（ADR-0021 opt-out，YUK-190 先例）——否则翻 flag 后「每答错 × N 前置 × affected_scopes」会触发 brief-regen 风暴（extraction gate 挡不住扇出）。owner-ratifiable：要 prereq_risk 进 memory 可撤（见开放问题）。

### 5. soft layer — mean-only + 借用 provenance 契约（YUK-559 S1）

A5/A6 都 ship 成软层：**只移 surfaced `theta_hat`（能力后验均值），不缩 `theta_se`/`theta_precision`**（ADR-0035 corollary——图-shrunk 方差在 V-A5-LOKO 过闸前未校准，不当硬用）。观测 KC 的 p(L) 置信带仍由 PFA success/fail 计数驱动。**绝不写 `mastery_state`**——读侧重算，三维正交校准轴不被污染。

**双轴 by-design（M1 撤回，修正 register 假句）**：一个 `MasteryProjection` 条目携带两个正交数字：
- **count 轴 p(L)**：`.mastery` = σ(γ·success + ρ·fail − β)（观测）/ σ(−β)（借用冷启 counts=0）；band 全系统**从不读 θ**。
- **ability 轴 θ**：`.theta_hat` = Elo/平滑后的 θ̃。

借用条目（请求但未观测的 KC）**确实合成** `.mastery`/`.theta_se`/band（冷 σ(−β)，`low_confidence:true`，`evidence_count:0`）——`applyKgSoftLayer` **NOT** 「never assigns .mastery/.theta_se」（修正 gap-analysis §4 假句 / register red-line note）。这不是矛盾而是自洽双轴：读 `.theta_hat` 见借用移动、读 `.mastery` 见冷 band。

**provenance 契约（S1 落地）**：`MasteryProjection` 加 `provenance:'observed'|'inferred'`（required）+ `theta_hat_raw?`（观测 KC 被就地平滑时保留原 θ̂）+ `isObserved(p)` 纯 helper。**红线**：`provenance`/`theta_hat_raw` 是**读模型字段，绝不入 `mastery_state` schema**（加列诱导落库 → 污染三轴正交）。consumer 纪律由 `audit:mastery-provenance`（report-only，S2）反查，升 hard-gate 绑「任一借用 flag 翻转」前置（见开放问题）。

### 6. 四机制 radius / cycle / provenance / decay 契约表

| 机制 | 影响半径（终裁修正）| 遇环 | provenance 标记 | 衰减/复核 |
|---|---|---|---|---|
| A5 | **request-shaped，无结构上界**：GMRF 联合解耦合 requested-诱导 `related_to` 连通分量全域（单 KC 请求 ≈1 跳星图；全树请求 = 整个连通分量）。冷启衰减最慢（λ=0.5/κ=0.01 下未观测链单跳保留 ≈0.87，5 跳仍 ~50%）。 | 线性解天然抗环 | 借用条目 `inferred`；被平滑观测 KC 保留 `theta_hat_raw` | 读侧重算自衰减（真证据一到 likelihood 盖过借用）；无独立 time-decay |
| A6 | 真 1 跳（单趟同时更新、读原始 θ̂、无传递再传播）| `max(0,·)` 互斥、拓扑无关终止 | 同上（θ̂ 均值移动，band 不动）| 同 A5（读侧重算）|
| A13 | **当前 dark provisional**：闭包 depth≤16 + node-cap 10k + path-guard，overflow fail-safe→[]；live radius/bounds 仍按 YUK-675 #4 deferred，须后续 owner disposition | path guard + depth bound | `risk_delta` 标 inferred 信号（event 投影，将来消费须走 provenance 契约）| 消费侧读时衰减（绑消费解锁；本单元不消费）|
| Rust coldstart | 全 DAG 前向 | Kahn 检测 → `Err`（reject）| day-one 先验读，产 display-tier 标量，不进 `getMasteryProjection` | n=0 先验，真数据一到即被 likelihood 盖过 |

**借用侧永不修图**：三处读边（`loadEdgesForProjection`/`loadPrereqClosure`/shadow sweep）全 SELECT 只读，遇环只读容忍或 fail-safe-to-noop，**绝不 raw-UPDATE fold-owned `knowledge_edge`**（写边唯一 throat = `edges.ts`）。自愈删边（环检测 → archive 最低 weight 边）归**图治理单元**（经事件层、mirror `merge_attribution_sweep` forensic 形态），不在本 ADR。

**连续置信**：`knowledge_edge.weight ∈ [0,1]`（schema「0-1 confidence」）modulates A5（buildLaplacian 权）/A6（Δθ 乘 weight）；CONFIDENCE-only，永不当 mastery。**A13 × edge.weight 默认不做**：闭包 CTE 只载 `(prereq,source,depth)` + `SELECT DISTINCT` 折叠，路径乘积欠定义且破坏 DISTINCT/MAX——owner 若将来采，定义 = 路径 weight 乘积（在 CTE path 旁累积，聚合改为对 (prereq,source) 取最大乘积权路径），成本写此（默认不做，A13 尚无 live 消费者）。

### 7. dark-ship + flag-off byte-identical

各 flag 默认 false（module-level const，仿 `THETA_GRID_ENABLED`，无 config 表/env）。flag-off → `getMasteryProjection` 不拉边、不平滑、不加借条目 = byte-identical 今日（回归锚）。λ/κ/λ_down/λ_up 是 owner 供给的固定 n=1 先验；现有 λ=0.5、κ=0.01、λ_down=0.3、λ_up=0.15 仅是 **dark provisional placeholders**，不是经验证或获准 live 的默认值，数值 ratification 仍 deferred。

**S1 形状变更说明**：`MasteryProjection` 加 required `provenance` 字段是 flag 无关的**类型形状变更**——flag-off 回归锚更新为「新形状下，soft-layer 不变量 = 无借用条目、无 theta 移动、无 theta_hat_raw」（数值仍 byte-identical）。

### 8. act-flip 闸（defer-flip not defer-build）+ A5 翻 flag 硬前置包

代码建 + 接线 + 电到 live 已完成；**本次 ratification 不授权任何 activation**。所有 flag 保持当前状态，最终翻转仍 deferred：
- **A5**：gated on **V-A5-LOKO**（leave-one-KC-out：MSE < λ=0 独立基线 ∧ 90% 覆盖 ∈ [85%,95%] ∧ λ 后验 > 0）。**外加 YUK-559 硬前置包**（顺序前置，翻 flag 前必全绿）：
  1. **A5 解规模界定**（RP8）——`solveDense` O(n³)/O(n²) 跑在整个 requested 集上，全树请求 n≈5000 ⇒ 每次树读 ~10¹¹ flops，是**可扩展性悬崖**。已落 **分量守卫**（`smoothThetaByComponent` 按 `related_to` 连通分量分块求解——GMRF precision 块对角 ⇒ 逐分量解与整解逐分量一致的纯重排；超界分量 `GRAPH_SMOOTH_COMPONENT_CAP`=256 fail-safe-to-no-smoothing + 单点 warn）。cap 值 / 将来稀疏 CG solver vs per-request 局部化的取舍 = owner 决策。
  2. **provenance audit 升 hard-gate**（`audit:mastery-provenance` 从 report-only → `--strict` CI gate），9 caller 全过审。
  3. **shadow 数据 ≥N 周**——`kg_borrow_shadow_sweep`（S3）dark 期就产「翻 A5/A6 会改多少 θ、多少 KC 借、分量多大」的分布，**按 `a5_only` / `a6_only` / `joint` 三 variant 归因**（共享单次 A5 稠密解：a5_only=smoothed θ̃、a6_only=propagate(裸 θ̂)、joint=propagate(smoothed θ̃)），owner 分别审每 flag 边际 + 联合的背离分布。
- **A6**：gated on A6 验证闸（owner 定；最小为「传播方向在合成 KG + attempt 序列上正确」+ 不与 B3 frontier 既有 0.7 gate 双压制重复计）。
- **A13**：emit 埋点 N 周 → owner 从 `risk_delta` 分布定阈 → 才考虑下游消费（选题 gating 单拎）。

### 9. Rust 落点与 S6 前置

**本单元零 Rust 改动**。A6 kernel 平凡（O(E) 加法）零收益；A5 GMRF 是唯一重数值，但问题是「解形态在 batch-read 尺寸下不可扩展」——**先界定解规模（决定 8 分量守卫 / 将来稀疏 solver），再谈 port 语言**。S6（Rust A5 GMRF port）defer 触发 =（A5 flag 翻 + bit-exact 跨端一致或大分量性能需求），前置四件套：
1. **deployment-aware loader（非 cwd-relative）+ .node/.wasm 进部署镜像**——`propagate-priors.ts` 白纸黑字：cwd-relative `NODE_PATH` 下 deployment-aware loader 是翻 flag 显式 PREREQUISITE；连 coldstart Rust 都未接生产，任何新 port 继承同 gap。
2. YUK-501 wasm CI skip 接通（否则 parity 无 gate）。
3. wasm32-wasip1-threads + napi 双构建面。
4. crate `napi.targets:["wasm32-wasip1-threads"]`。

### 10. n=1 admissibility（litmus）

A5/A6/A13 都只吃：**单学习者自身 θ̂/outcome**（mastery_state）+ **KG `edge.weight`（owner/LLM 供给的固定先验）** + **owner 固定 λ/κ/λ_down/λ_up/base/decay 常量**。无 a/slip/guess/φ/discrimination 任何跨被试参数。**λ 等必须保持 owner 供给**——「从数据学」需跨人方差 → inadmissible（红线）。`GRAPH_SMOOTH_COMPONENT_CAP` / `SHADOW_BORROW_COMPONENT_CAP`（=256）是**未经数据校准的保守结构初值**（非拟合 item 参数），同 litmus。

### 11. F′（θ̃ 进借用 band，1PL ICC）— owner 选项，前置链（不默认采）

owner 可选让 borrowed band point = σ(θ̃−β)——**诚实框架**：这是 1PL ICC（`theta.ts` 家族），因 counts=0 使 PFA 退化为 σ(−β) 而用**异族模型**承接；同一 `.mastery` 字段从此双模型（observed=PFA、borrowed=1PL），β↔b 需 linking（ADR-0035 决定#1）。**硬前置链（顺序不可换）**：(a) `audit:mastery-provenance` 升 hard-gate 且 9 caller 全过审（否则在护栏强制前抬高今日天然保守的 mastery 轴）；(b) shadow 数据 ≥N 周 owner 审过背离分布；(c) 本 ADR 显式记双模型 + linking caveat。**不采则双轴现状 + 成文即终态**。

## YUK-675 split ratification（owner disposition，1–11 原号保留）

本表是本文的 owner disposition 真相源。`Ratified now` 只批准治理/契约；`Deferred` 保留当前行为，达到 unlock evidence 后仍须 owner 再次显式 disposition，**不会自动翻 flag、改 runtime 或升级 gate**。

| # | Ratified now | Deferred | Unlock evidence + later owner disposition | Runtime impact now |
|---|---|---|---|---|
| 1 | 无；F′ 整体 deferred。 | borrowed `.mastery` 是否改用 θ̃ 的 1PL ICC，以及 PFA/1PL 双模型。 | `audit:mastery-provenance --strict` + heuristic guarded verdicts 的人工语义复核完成；shadow 满 N 周且 owner 审过背离；owner 显式决定 β↔b linking 后再拍采/不采。 | 无；borrowed `.mastery` 继续 cold PFA σ(−β)，未重开前即终态。 |
| 2 | A5 pre-flip 包的类别与顺序：bounded solve/fail-safe → strict provenance gate → shadow window → V-A5-LOKO GO。 | 最终 component cap、sparse CG vs request-localization、N，以及 CI/runtime 工作。`256` 仅当前 dark 保守 safety bound。 | 四类证据完成后，owner 分别 disposition cap、solver/localization、N 与 activation；不得把 `256` 当 validated/live default。 | 无；A5 不获 activation。 |
| 3 | 第一只 A5/A6 borrow flag 前，必须通过 `audit:mastery-provenance --strict`，并人工复核 heuristic guarded verdicts。 | package/CI 接线与首次执行时点。 | strict 结果与人工复核记录齐备后，owner disposition 接线和 flag。 | 无；本次不改 audit/package/CI。 |
| 4 | 现有 `ingest_at:now` memory opt-out；A13 保持 emit-only、无 live consumer。 | ≤2-hop alternative、A13 `edge.weight` modulation、flag 与下游消费。当前 depth≤16/node-cap 10k/base/decay 都只是 dark 行为/owner-fixed unratified priors。 | owner 审阅 emitted distributions 后，逐项 disposition 半径、modulation、参数、activation 与消费。 | 无；A13 不获 activation 或 consumer。 |
| 5 | A6 与 B3 既有 0.7 frontier gate 不得静默双重压制同一 dependency signal；pre-flip 设计须选 authoritative stage 或提供经测试的 bounded composition。 | 具体公式、owner stage 与 harness。 | shadow/pre-flip review 产出双压制分析和测试证据后，owner disposition。 | 无；A6/B3 行为不变。 |
| 6 | 图自愈归图治理；必须经 event-owned write path。借用读路径只读、fail-safe，永不 raw archive/update。 | self-heal job 本身。 | 图治理另案明确事件契约与 owner 批准后才可实施。 | 无；无 job、写路径或修图变化。 |
| 7 | Rust port 仅在 A5 activation 后，且出现已证明的性能需求或 required cross-runtime consistency 时进入；四前置为 deployment-aware non-cwd loader/artifact packaging、YUK-501 CI parity、wasm32-wasip1-threads + napi surfaces、crate target declaration。 | port、量化 trigger threshold 与所有实现。 | activation + need evidence + 四前置全绿后，owner disposition 是否 port 及阈值。 | 无；零 Rust/loader/package/CI 改动。 |
| 8 | `derived_from` 仅进 A6，orientation 反转（`to` 为 base）；不进 A5/A13，除非后续 ADR。常量必须保持 owner-fixed n=1 priors。 | λ/κ/λ_down/λ_up 数值 ratification/tuning；当前 0.5/0.01/0.3/0.15 仅 dark provisional placeholders。 | 各机制验证证据完成后，owner 逐值 disposition；任何从跨人数据学习参数的方案仍 inadmissible。 | 无；常量与 flags 均不改。 |
| 9 | 无；M1-F 整体 deferred，mean-only 是当前契约。 | graph uncertainty 进入 `theta_se`/`theta_precision`/p(L) band。 | V-A5-LOKO GO + graph uncertainty calibration 后，owner 显式 disposition。 | 无；uncertainty 与 band 不变。 |
| 10 | A5 V-A5-LOKO gate 钉死为：MSE < λ=0 baseline **且** 90% coverage ∈ [85%,95%] **且** λ posterior > 0；synthetic correctness 不足以解锁。A6/A13 各须 owner-data gate。 | A6/A13 gate 的定义/阈值，以及全部 harness 接线/执行。 | A5 三条件全过后 owner disposition A5；A6/A13 各自 owner-data evidence 完成后另行 disposition。 | 无；无 harness、gate 接线或 activation。 |
| 11 | 无；保留 required provenance union field + `isObserved` helper 的当前契约。 | Q1′-F 判别联合升级与 9 caller 迁移。 | V-A5-LOKO GO 后，由 owner 显式 disposition 是否迁移；GO 本身不自动触发。 | 无；无 caller/type migration。 |

## 后果

- **正向**：`related_to` 获得首个 specialized 诊断消费者；`prerequisite` 获得诊断轴 specialized 消费者（A6 读侧 + A13 emit），`derived_from` 仅获 A6 读侧消费者。`audit:relations` CONSUMER_REGISTRY 已补相应 `state.ts` / `prereq-propagation.ts` marker 证据（本单元 registry 零改动——relation_type 过滤未触）。observed/inferred 结构分离 + `audit:mastery-provenance` 埋点。
- **风险/护栏**：① λ 过大抹平真 misconception（V-A5-LOKO 守）；② A5 解规模悬崖（分量守卫 + shadow 规模数据守）；③ A6 与 B3 frontier 既有下游压制可能双计（owner 决策点）；④ 借用条目「凭空多出投影条目」——已标 `inferred` + `low_confidence`，provenance audit 防静默误用；⑤ A13 翻 flag 后 brief-regen 扇出（`ingest_at:now` opt-out 守）。

## Owner disposition 索引（历史问题 → YUK-675 表格）

以下原 1–11 议题已由上表逐号处置；其 Ratified/Deferred 边界、unlock evidence 与「仍须 later owner disposition」以该表为准，不再把它们统称为未拍开放问题：

1. **F′（θ̃ 进借用 band，1PL ICC）采不采**：前置链 =（audit 升 hard-gate → shadow 数据 N 周 → ADR 双模型+linking 成文），顺序不可换。
2. **A5 翻 flag 硬前置包 ratify**：分量守卫 cap 值（初值 256）/ 稀疏 solver vs per-request 局部化取舍 / audit 升 hard-gate / shadow 数据周数 N。
3. **`audit:mastery-provenance` 升 hard-gate 时点**：建议绑「任一借用 flag 翻转」前置。
4. **A13 三件**：`ingest_at:now` opt-out ratify（S4 默认落，owner 可撤）；≤2 跳 cap 与 edge.weight modulation 是否将来按 emit 分布采（语义已在决定 6 定义）。
5. **A6 × B3 frontier 双压制去重**（learnable-frontier.ts 已有 0.7 gate）。
6. **图自愈 job**（环检测 → 事件层 archive 最低 weight 边）归口图治理单元——确认归口。
7. **Rust port 触发条件 + S6 四前置**确认。
8. λ/κ/λ_down/λ_up 具体默认值（当前保守占位：λ=0.5, κ=0.01, λ_down=0.3, λ_up=0.15）+ `derived_from` 是否与 prerequisite 同闭包（本草案纳入）。
9. **M1-F（band 宽度纳入传播不确定性）**：维持被 ADR-0035 corollary 挡住（`graph-laplacian.ts` mean-only，方差不可信），绑 V-A5-LOKO 过闸后重议。
10. 各自验证闸（V-A5-LOKO 已定；A6/A13 闸待定）的 owner-data harness 接线。
11. **Q1′-F 判别联合升级**（`getMasteryProjection` → `{observed, inferred}` 判别联合，provenance 编译期不可忽略——9 caller 全解构改造，收益到翻 flag 才兑现）：绑 **V-A5-LOKO GO**（kg-borrowing spec §7 开放问题 3）。与决定 5/11 的读模型 provenance 判别式（软 helper `isObserved`）正交——后者已落 live，前者是把软 helper 升成编译期强制的类型升级。
