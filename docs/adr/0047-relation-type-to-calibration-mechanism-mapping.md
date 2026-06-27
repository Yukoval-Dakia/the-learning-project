# ADR-0047 — relation_type → 校准机制映射（A5 图-Laplacian / A6 prereq 有向传播）

**Status**: Proposed（草案，待 owner ratify — 勿自行 ratify）
**Part of**: YUK-441（A5 图-Laplacian 先验）+ YUK-442（A6 prereq 有向传播）。P4「KG 承重」里程碑——让知识图谱的边数学承重于 per-KC mastery。
**Decision source**: 数学 dossier `docs/superpowers/research/2026-06-20-axis2-calibration-math-dossier.md` §1(a)/§2 A5 行 + YUK-441/YUK-442 「数学 dossier 裁决」comment（2026-06-20）+ 「🛠 实施讨论 · grounded」comment（2026-06-27）。
**Related**: ADR-0010（knowledge_edge typed mesh / relation_type 核心集合）· ADR-0034（结构一致性闸 + `archived_at` 软归档，取代 bi-temporal）· ADR-0035（三轴正交 + p(L) 诊断轴 + 不确定性必过校准闸 corollary）· ADR-0036（双层异构 KG）· YUK-357 `audit:relations`（KG 死边反向审计）.

---

## 背景

`knowledge_edge.relation_type`（ADR-0010 核心集合）有 5 个有意义的 type：`prerequisite`、`related_to`、`contrasts_with`、`applied_in`、`derived_from`。在 P4 之前这些边只被三类消费：creation-validation（rubric-validator 提议时校验）、generic-read（copilot 邻域一把灌）、以及少量 specialized（topology-gate 仅 prerequisite 环检测、hub-mesh 笔记上下文）。**没有任何「按 relation_type 驱动 mastery 诊断」的消费**——图在长但不影响 per-KC 能力估计。

A5/A6 把 KG 接进 mastery 诊断轴（`mastery_state.theta_hat` 的读侧投影 `getMasteryProjection`）。但**不同 relation_type 的数学语义不同，混用会污染 firm-up**：对称平滑假设同质，有向边假设序，对立边是反向信号。落地前必须钉死「哪个 type 喂哪个机制」，否则错误的边语义会静默腐蚀单学习者的 n=1 校准。本 ADR 钉这张映射表。

## 决定

### 1. 映射表（钉死）

| relation_type | 方向性 | 喂的机制 | 进 A5（对称平滑）| 进 A6（有向传播）| 依据 |
|---|---|---|---|---|---|
| `related_to` | 对称 | **A5** 图-Laplacian GMRF 平滑先验 | ✅ | ❌ | L 必须无向/对称/PSD（Borovitskiy AISTATS 2021；GPG）。`related_to` 是唯一对称同质边。 |
| `prerequisite` | 有向（from 是 to 的前置）| **A6** 有向软序先验 | ❌ | ✅ | 有向序 P(掌握 from) ≥ P(掌握 to)。对称平滑搞错方向。 |
| `derived_from` | 有向（from 派生自 to ⇒ base=to）| **A6** 有向继承（base `to` 当 prereq-like）| ❌ | ✅ | ADR-0010：`from 派生自 to`，base 是先导。orientation 翻转 vs prerequisite。 |
| `contrasts_with` | 对立 | **两者都不进** | ❌ | ❌ | **反向信号**：易混项混入平滑会把对立项当同类 → 污染 firm-up（数学 dossier 最锐的对）。 |
| `applied_in` | 有向 | 暂不进（保持现状死边候选）| ❌ | ❌ | 无明确序/平滑语义；YUK-357 已记为有意死边，不在本 ADR 扩。 |

**钉死三句**：① `related_to` → A5（且仅 A5）；② `prerequisite`(+`derived_from`) → A6（且仅 A6）；③ `contrasts_with` A5/A6 都不进。relation_type 不相交、不双计。

### 2. A5 = proper GMRF，**不是裸 improper prior**

裸 `p(θ) ∝ exp(−½ λ θᵀLθ)` 是 **improper**：图 Laplacian 有零空间（常数平移 L·c·1=0），整体 level 不可识别，全未观测分量永不 firm up。**必须**升级成 proper GMRF `θ ~ N(μ₀, (λL + κI)⁻¹)`——κI 让精度矩阵正定（可识别 level），锚在先验均值 μ₀（默认 0）。后验均值解 SPD 系统 `(D + λL + κI) θ̃ = D θ̂ + κμ₀`（D=每 KC 观测精度对角阵）。

### 3. A6 = 软序先验/惩罚，**不是硬序约束**

prereq 边 k₁→k₂ 编码软序信念 P(掌握 k₁) ≥ P(掌握 k₂)，落成**加性、单向**的惩罚/credit（按 ordering 违背量 `max(0, θ̂_dep − θ̂_pre)` 驱动）：答错先修/前置弱 → 压下游；答对高阶 → retro-credit 先修。**硬序约束在 LLM 生成的错边上太强——错边会静默腐蚀 firm-up**。软化 + 读侧重算 ⇒ 边可修订（改一条边即重投影）。

### 4. soft layer — 只移后验均值、不缩方差

A5/A6 都 ship 成软层：**只移 surfaced `theta_hat`（能力后验均值），不缩 `theta_se`/`theta_precision`**（ADR-0035 corollary——图-shrunk 方差在 V-A5-LOKO 过闸前未校准，不当硬用）。观测 KC 的 p(L) 置信带仍由 PFA success/fail 计数驱动、不被 A5/A6 改。借来的未观测 KC 标 `low_confidence=true`。**绝不写 `mastery_state`**——读侧重算，三维正交校准轴不被污染。

### 5. dark-ship + flag-off byte-identical

`GRAPH_LAPLACIAN_ENABLED` / `PREREQ_PROPAGATION_ENABLED` 默认 false（module-level const，仿 `THETA_GRID_ENABLED`/`HIERARCHICAL_ELO_ENABLED`，无 config 表/env）。flag-off → `getMasteryProjection` 不拉边、不平滑、不加借条目 = **byte-identical 今日**（回归锚）。λ/κ/λ_down/λ_up 是 owner 供给的**保守固定先验**（n=1 admissible），PHASE-DEFERRED 待各自验证闸调。

### 6. act-flip 闸（defer-flip not defer-build）

代码建 + 接线 + 电到 live 已完成；**只 defer 最终 flag 翻转**：
- **A5**：gated on **V-A5-LOKO**（leave-one-KC-out：MSE < λ=0 独立基线 ∧ 90% 覆盖 ∈ [85%,95%] ∧ λ 后验 > 0）。过闸前 shadow/UI-only。
- **A6**：gated on A6 验证闸（owner 定；最小为「传播方向在合成 KG + attempt 序列上正确」+ 不与 B3 frontier 既有 0.7 gate 双压制重复计）。

## n=1 admissibility（litmus）

A5/A6 都只吃：**单学习者自身 θ̂**（mastery_state）+ **KG `edge.weight`（owner/LLM 供给的固定先验）** + **owner 固定 λ/κ 常量**。无 a/slip/guess/φ/discrimination 任何跨被试参数。**λ 必须保持 owner 供给**——「从数据学 λ」需跨人方差 → inadmissible（红线）。故 hardcode + flag。

## 后果

- **正向**：`related_to` 获得首个 specialized 诊断消费者（此前零按-type mastery 消费）；`prerequisite`/`derived_from` 获得诊断轴 specialized 消费者（补结构轴之外）。`audit:relations` CONSUMER_REGISTRY 已补 3 条 `state.ts:marker` 证据。
- **风险/护栏**：① λ 过大抹平真 misconception（V-A5-LOKO 守）；② A6 与 B3 frontier（YUK-349）既有下游压制可能双计——owner 决策点（见下）；③ 借来的未观测 KC「凭空多出投影条目」——已标 low_confidence，下游/UI 是否需进一步处理待定。

## 待 owner 决策（不在本 lane 拍）

1. **传播目标**：A5/A6 当前只移 surfaced `theta_hat`（能力均值），**不改 p(L) `mastery` 带**（PFA 计数驱动，保持 byte-identical）。是否要让 θ̃ 也进 p(L) logit 当能力项 / 驱动 frontier 选题？owner grounding comment 建议「先只进选题/frontier 读，显示 p(L) 暂不动」——本草案取最保守（仅 theta_hat），把 p(L)/frontier 耦合留作 follow-up。
2. **A6 × B3 frontier 双压制去重**（learnable-frontier.ts 已有 0.7 gate）。
3. λ/κ/λ_down/λ_up 具体默认值（当前保守占位：λ=0.5, κ=0.01, λ_down=0.3, λ_up=0.15）。
4. `derived_from` 是否与 prerequisite 同闭包（本草案纳入），还是先只 prerequisite。
5. 各自验证闸（V-A5-LOKO 已定；A6 闸待定）的 owner-data harness 接线。
