# B1 难度模型 · n=1 difficulty 数据驱动校准研究（完整落盘）

**Date**: 2026-06-15

**Status**: Research-complete（文献研究 + 统合裁决，喂 deferred recalibration #45 + ADR）

**生成**: workflow `difficulty-data-driven-research`（6 agent / 420k tokens / 5 路并行文献 + 1 统合，全 opus，纯文本绕 StructuredOutput model 坑，来源权威性逐条核验）

**触发**: owner 2026-06-15 两问 —— (Q1) n=1 下 difficulty 要不要更精细乃至数据驱动以贴合？(Q2) 若要，需要什么数学模型？

**Related**: ADR-0035（三维 mastery + 四引擎）· ADR-0042（MFI 调度信号，b 来源）· `2026-06-14-b1-diagnostic-engines-foundation.md`（被本研究修补 §3/§5.2/§7.3/§7.4/§8）· `2026-06-15-b1-calibration-carrier`（PR #414，本研究确认其 b 锁死是正确阶段②形态）· deferred recalibration #45（本研究是其设计输入）


---

# 第一部分 · 统合裁决（权威版，回答 owner 两问）


# B1 难度模型统合裁决：n=1 下 item 难度 b 的数据驱动校准

## 0. 统合判据（一句话）

五路研究在数学骨架上**完全收敛**，无矛盾：n=1 下 b **不能**从 owner 自己的作答流被估为独立可识别量，但**能**在「外部锚定尺度 + owner 真值去偏」的半数据驱动框架内被合法更新。当前 wave（G4 红线锁 b、theta 走 Elo）是**正确的阶段②形态**，无需改动；b 的数据驱动校准是 deferred recalibration（#45）的设计输入，应在慢热**阶段③**启动，路线为 **active-PPI（IPW rectifier）+ PPI++ power-tuning**，θ 快 / b 慢靠**两时间尺度随机逼近**保证识别性。

---

## 1. 识别性裁决：n=1 下 b 数据驱动的严格边界

### 能做（合法的「半数据驱动」）

| 操作 | 凭什么 | 数学机制 |
|---|---|---|
| **数据驱动地去偏 LLM 锚的难度标尺**（系统性平移/标尺层） | PPI rectifier `Δ = E[f−Y]` 精确就是「LLM 预测 b 相对真值的平均偏差」 | PPI / control-variate，纠**分布泛函**非逐题 |
| **在已知（锚定）θ 上反推单题 b**（CI 宽） | b 是**位置参数**，可靠锚借标尺定位（fixed-anchor linking 逆用，Kolen & Brennan 2004） | normal-normal 后验平移 |
| **逐题 b̂ 朝 KC 群体均值 shrinkage 降 MSE** | 经验贝叶斯 borrow-strength（Mislevy 1986/1988） | `b_post=(1−w)b_anchor+w·b̂`，`w=n·τ²/(n·τ²+σ²)` |
| **从题面内容 feature-based 预测 b** | b 的信息源（题面）与 θ 的信息源（作答）**正交**，结构上不可能与 θ 混淆 | explanatory IRT 监督学习，绕开识别性墙 |

### 禁止（结构性不可行，不是数据不够）

| 操作 | 凭什么禁 |
|---|---|
| **owner 一人作答内部自证 b**（既估 θ 又估 b） | logit 平移不变 `θ→θ+c, b→b+c` 似然不变；n=1 无总体可积（MMLE 路径定义上不可用），退化为 N=1 校准样本 |
| **θ 与 b 同时间尺度自由在线互估** | JMLE incidental-parameters 不一致（Kiefer-Wolfowitz，偏差 (I−1)/I）；二者互相追逐进垃圾（elo-urnings 核验一致） |
| **Elo/Urnings 的 item 更新半边用于单 agent** | 其合法性**完全依赖多人打同题**做跨学习者平均；n=1 该半边失效，β 会吸收本属 θ 的方差 |
| **数据驱动估 a / c / slip / guess** | 形状/尾部参数，信息**结构性只来自跨考生能力方差**，n=1 在定义上不提供——**连锚都救不了**（无方差可借） |

### 分水岭（最关键的一条线）

**b 是位置参数（可锚可推）；a/c/slip/guess 是形状/尾部参数（结构性不可识别）。** Stocking 1990 只支撑 a/c 那一行，**不延伸到 b**。b 那一行的承重是 Kolen-Brennan（linking）+ incidental-parameters 的 cohort 依赖（说明 owner 自证不行）。这条二分必须在 foundation §3 保留并标清承重出处。

**「锁 b」的精确含义**：锁的是**尺度不定性**（外部供给原点+单位、不可 owner 自证），**不是 b 数值永久冻结**。b 可在 PPI 框架内随真值去偏而动——「固定」≠「不能动」。

---

## 2. 推荐数学模型：四路线收敛成一个连贯的 b 演化模型

### 裁决：四路线**不是同一模型的四个视角，是三件正交的事 + 一个搬运器**，有清晰分工，不可合并成单一估计器

| 路线 | 数学身份 | 解什么问题 | 在 b 演化中的位置 |
|---|---|---|---|
| **feature-based** | explanatory IRT 监督学习 | 把 b 从「无解识别性问题」转成「有解监督学习」 | **锚的来源**（产 `b_anchor`） |
| **shrinkage** | 经验贝叶斯（有偏低 MSE） | 单题稀疏数据借群体信息降方差 | **逐题先验结构**（可选层） |
| **PPI** | control-variate / AIPW（无偏半参数） | 预测有偏怎么用真值无偏地修 | **去偏引擎**（校锚标尺） |
| **state-space** | 隐状态滤波 | 追**时间漂移** | **只用于 θ，不用于 b**（b 静态） |

**PPI vs shrinkage 的精确关系**（回答 owner「PPI 是 shrinkage 频率派对应？」）：**目标同构（都降方差）、机制对偶（PPI 守无偏控制变量 / shrinkage 用偏差换 MSE）、可统一不可等同**。PPI++ 的 power-tuning λ 把这条对偶显式参数化：λ=0 退纯频率派、λ=1=标准 PPI、λ* 由协方差比定（=control-variate 最优系数）。

### 连贯的 b 演化模型（一个数据流，三件事各司其职）

```
b_anchor_i  ← feature-based explanatory IRT（题面内容预测）         [锚源]
            ↓  先验：b_i ~ Normal(b_anchor_i, τ_i²)，τ_i 按锚置信分级固定（不估）
b_prior_i   ← 可选 shrinkage：逐题朝 KC 均值收缩降 MSE              [先验结构]
            ↓
b_calib_i   ← active-PPI 批量去偏：用 owner 真值 rectify 锚的系统偏差 [去偏，慢]
            ↓
θ_t         ← Elo 在线更新，视 b_calib 为固定锚                     [快]
```

### θ 快 / b 慢的具体数学形态 + 识别性保证

**两时间尺度随机逼近（two-timescale stochastic approximation）**：

- **θ（快，O(1) 每作答）**：Elo `θ ← θ + K(S−E)`，**视 b 为固定常数**。item 更新半边锁死（G4）。
- **b（慢，批量/周期）**：active-PPI 点估计，IPW 加权 rectifier
  ```
  b̂ = b̂_L + (1/n) Σ_i [ Y_i − m̂(x_i) ] / π_i      （π_i = 题 i 被选标概率，MFI/分歧分归一）
  ```
  power-tuning：`θ̂^λ = argmin [ L_n(θ) + λ(L̃_N^f − L_n^f) ]`，λ* 自适配锚质量。
- **识别性怎么靠它保证**：
  1. **尺度分离硬条件** `b 的 PPI 校准频率 ≪ θ 的 Elo 频率`——慢变量（b）对快变量（θ）呈**准静态**，每次 θ 更新视 b 为常数，避免二者同频互相追逐（绕开 JMLE incidental-parameters 墙）。
  2. **每次 PPI 更新 b 后，θ 标尺做一次 Kolen-Brennan linking 重对齐**。
  3. **b 的信息源完全在单人在线回路之外**（锚=题面/外部题库，去偏=客观题真值），这是 n=1 尺度分离的**结构性切分**，不靠两套过程噪声自动保证。
  4. **active-learning 选锚非 i.i.d. → 必须用 IPW-加权 rectifier**（每项 ÷π_i）；基础 PPI 的均值 rectifier 在此**有偏**，会把锚标尺校歪。

### τ（shrinkage 旋钮）的硬约束

**n=1 下 τ 不可从数据估**（与 σ 共线不可分），必须**先验固定**，按 LLM 锚置信分级：中段强锚 τ≈0.4–0.6，极端 item 弱锚 τ≈1.0–1.5。**n=1 没有「自由估的安全甜区」——甜区在样本积累不在 τ**：单次作答只「记一笔」（~5–10% 位移），3–8 次同 item 才解锁可感知位移；硬顶 `|b_post−b_anchor| ≤ 3τ` 防全对/全错把 b 拉到 ±∞。

---

## 3. 分阶段落地

| 慢热阶段 | b 状态 | θ 状态 | PPI | 凭什么 |
|---|---|---|---|---|
| **① 纯先验** | LLM 先验硬钉（全软轨） | 未启动 | **不能启动**（真值=0，rectifier 无数据） | 真值未攒 |
| **② Elo 追 θ（≈当前 wave）** | **锁外部锚**（G4 红线） | Elo 在线追，剧烈收敛 | **不启动**（真值太少，rectifier 方差爆炸） | n=1 item 在线更新失效，b 必须锁；θ 还没稳 |
| **③ fixed-anchor + active-PPI** | **数据驱动去偏锚标尺**（迁入硬轨校准） | 已大致稳，继续快追 | **启动**：active-PPI IPW rectifier + PPI++ λ*（+ 可选 shrinkage / cross-fitting） | 真值攒到最小批量（IPW 省样，~数十题级），θ 已稳 |
| **④ 开放题外推** | propose-only | — | **无法兜底**（开放题真值非客观闭环，Y 不干净） | §7.2 G1 零文献 + §7.3 中文 K12 偏负面直证 |

### 与当前 wave 的关系

**本 wave 不改。** 当前 `item_calibration.b = LLM 先验锚 + G4 永不回写`、`theta 走 Elo` 是**正确的阶段②形态**——n=1 下 item 在线更新结构性失效，b 锁死是识别性的必要条件，不是保守。b 的数据驱动校准属**阶段③**，是 **deferred recalibration（#45）的设计输入**，不是本 wave 的实现项。

---

## 4. 诚实天花板：结构性不可超越 vs 工程可改善

### 结构性不可超越（n=1 的硬墙，任何工程都救不了）

1. **b 永远不能脱离外部锚成为 owner 自证的量。** 最强形态止于「半数据驱动」（数据去偏、锚定尺度），不是「全数据驱动」（数据从零定 b）。**硬轨地基质量 = 锚质量**，n=1 无法靠自身数据救一个坏锚。
2. **a / c / slip / guess 结构性不可识别**——需要跨考生能力方差，n=1 定义上不提供，连锚都救不了。
3. **逐题 b_j 单点 n=1 无法被数据精确定**——PPI 纠的是分布/标尺层，单题只能退回 fixed-anchor 反推（CI 宽）。
4. **非平稳过渡态（正在学习时）θ/b 分离**仍需外部结构；BKT 渐近识别性依赖**足够长序列**，n=1 细粒度知识点（往往个位数作答）常不满足。

### 工程可改善（值得投入）

1. **锚质量本身**：feature-based explanatory IRT（英文域 r=0.75–0.87）比 direct-prompt（r≈0）稳得多；用 in-context examples + owner 残差兜底改善中文域偏差。
2. **去偏有效性**：active-PPI 比 i.i.d. 标注更省真值、CI 更窄；power-tuning λ* 在锚迁移失效时自动归零，绝不被烂先验拖累。
3. **MSE**：逐题 shrinkage 朝 KC 均值收缩。
4. **锚循环防护**：LLM 同充预测器+锚先验时叠加 cross-fitting（K-fold）。
5. **可观测**：per-item 记 `(n_i, w_i, π_i, |b_post−b_anchor|)`，让「哪些题正被推离锚」可见。

### 最薄的两环（已知缺口，须标 propose-only）

**「中文域」×「开放/主观题型」的交叉格**——既无正向 r 值，又有 ZPD-SCA 2025 负面直证（Qwen-max/GLM zero-shot 评中文 K12 认知难度**低于随机猜测**，且这两个模型正是本项目栈近亲）。这一格 PPI 无法兜底（开放题真值非客观闭环）。

---

## 5. 对当前 wave 的影响

**纯 deferred 设计输入，本 wave 不要求改 schema / theta 更新。**

- **`mastery_state` / `item_calibration` schema**：本 wave **不改**。当前 `b`=LLM 锚 + G4 锁死正确。
- **theta 更新**：本 wave **不改**。Elo 视 b 为固定锚是阶段②正确形态。
- **deferred recalibration（#45）的设计输入清单**（阶段③启动时需要，建议现在记进 spec，不现在实现）：
  1. 持久化每道锚题的**选中概率 π_i**（active-PPI 的 IPW rectifier 必需；当前只标「诚实边界」未给解法——这是实施层硬缺口）。
  2. `item_calibration` 未来需容纳 `b_anchor`（先验）与 `b_calib`（去偏后）分离 + `(n_i, w_i)` 元数据（阶段③才写，现在留注释占位，标明 #45 解除）。
  3. PPI++ power-tuning λ* 作为锚质量自适配兜底写进 calibration spec。
  4. b 校准与 θ 更新的**两时间尺度分离 + 每次 b 更新后 Kolen-Brennan linking 重对齐**写进 ADR。
  5. 开放题 / 中文域格保持 **propose-only**，标 ZPD-SCA 负面直证。

---

## 附：foundation 文档建议修补点（均为内联订正，非新 feature）

定位：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-b1-diagnostic-engines-foundation.md`

1. **§3 矩阵**：保留 b/a/c 二分，标清 b 那一行承重是 Kolen-Brennan + incidental-parameters（**非 Stocking**）；「锁 b」明确为「尺度锚外部供给、不可 owner 自证」非「数值冻结」。
2. **§5.2/§5.3**：PPI 在阶段③**首要身份 = 数据驱动去偏 LLM 锚标尺**（CI 收窄是副产品）；「⚠️诚实边界」从「落地细节」升级为**明确指定 active-PPI（Zrnic & Candès, ICML 2024）IPW 加权 rectifier + 持久化 π_i**；落地用 PPI++ power-tuning（λ*）。
3. **§7.3 G2**：从「中文 K12 零直证」改为「**有直证且偏负面**（ZPD-SCA 2508.14377）」，缺口严重度升级。
4. **§7.4 G3**：锚标尺现可被 owner 客观题 PPI 持续 rectify——硬轨地基不再纯软，但仍受「锚质量」上限约束。
5. **§8 来源表补**：Deonovic et al. 2018（BKT↔IRT 桥）、Wauters 2012（两段式奠基）、AutoIRT 2024（工业实例）、Active Statistical Inference（ICML 2024）、PPI++、ZPD-SCA、D-BIRD、Cooperman 2025。

---

## Linear

本任务为 B1 难度模型识别性 + 数学模型的文献统合裁决，**无代码 / schema 改动**（裁决结论即「本 wave 不改，纯 deferred 设计输入」）。actionable 跟进全部属既有 B1 / YUK-203 P3 calibration 子 issue 与 deferred recalibration #45 的**内联订正**：

- foundation 文档 §3/§5.2/§5.3/§7.3/§7.4/§8 的上述修补点 → 追加为既有 B1 issue 的 comment；
- #45 deferred recalibration 的 5 项设计输入清单 → 追加为 #45 的设计输入 comment。

**无需新建独立 Linear issue**——与五路研究各自的 Linear 处置一致（均判「内联订正、不新建」）。


---

# 第二部分 · 五路原始研究（完整存盘，供追溯）



## §A 识别性边界（n=1 下 θ 与 b 能否同时估）


All confirmations are now in. I have verified every load-bearing piece independently. Let me note the key Deonovic et al. 2018 correction: the document §8 should attribute the "Learning meets Assessment" Urnings-adjacent group correctly — the authors are Deonovic, Yudelson, Bolsinova, Attali, Maris (2018, Behaviormetrika 2019), not in the current corpus. This is a relevant addition.

I have everything needed for the identifiability conclusion.

---

# n=1 下 item 难度 b 的数据驱动可辨识性 — 研究结论

## 核心结论（一句话）

在 n=1（单学习者、能力 θ 随学习非平稳上升、无 cohort）下，**item 难度 b 不能从 owner 自己的作答流被数据驱动地估计为一个独立可识别的量**；它只能在「θ 被外部锚钉住」的条件下被反推（fixed-anchor linking 逆用），且置信区间宽。「固定 b」的反面不是「b 永不能动」——b 可以随证据更新，但更新的**信息来源必须是外部锚（LLM 先验/公开题库/历史均值）+ owner 客观题真值去偏**，而**不是**「owner 一人作答内部自证」。后者在统计上退化为 N=1 校准样本，是结构性不可行，不是数据不够。这与设计文档 §3 矩阵「b 可估（靠外部锚，非 owner 自估）」一致，且我对其每个承重前提做了独立联网复核——**无修正，全部成立**。

---

## 逐问回答

### 问题 1 — 尺度不定性（scale indeterminacy）：n=1 怎么靠锚定打破？「固定 b」是否意味 b 永不能动？

**尺度不定性的精确机制（已核验）**。1PL/Rasch 的 ICC 是 `P=1/(1+e^{-(θ-b)})`，只依赖差 `(θ-b)`。对任意常数 c，`θ→θ+c, b→b+c` 给出**完全相同的答对概率** → 似然在 logit 上对联合平移**不变**，参数只可识别到「一个加性常数（位置）+（2PL 起）一个乘性常数（尺度）」。这是模型层的不可识别，必须靠**约束**打破——标准做法两选一：(a) 固定 θ 总体分布（如 θ~N(0,1)，MMLE 路径）；(b) 锚定某个参数（pin θ₁=0 或 pin 一组锚题 b）。核验来源对此一致表述（Columbia Mailman IRT 概述、rfarouni 模型识别笔记、Wikipedia IRT）。

**n=1 的关键不对称**。多人 IRT 走 (a)：固定 θ 的**总体分布**来打破不定性——这正是 MMLE/Bock-Aitkin 1981「对 θ 总体积分」的本质。**n=1 没有总体可积**，路径 (a) 在定义上不可用。于是 n=1 只剩路径 (b)：**锚定 b**（用外部已知难度的锚把尺度钉死），然后让 owner 一人的作答去定位**自己的 θ**（θ 是个体参数，单考生时点内可 MLE/贝叶斯估，§问题 2）。

**「固定 b」≠「b 永不能动」——这是文档表述需要精确化的一点**。「锚定」打破的是**尺度不定性**（给量尺定原点和单位），不是冻结 b 的后验。b 可以动，但动的合法路径是：先验（锚）给初值 → owner 真值做**去偏 rectifier**（PPI 机制）→ b 后验平移。换言之 b 的更新信息来自「锚 + 真值残差」，**不来自「owner 一人作答内部循环」**。若试图用 owner 一人作答既估 θ 又估 b，等价于在一个平移不变的似然上同时放开两端——欠定，落回尺度不定性本身。**所以「固定」的准确含义是「尺度锚由外部供给且 b 不可由 owner 自证」，而非「b 数值永久冻结」。**

### 问题 2 — 非平稳 θ（学习中上升）+ 自由 b 的混淆：「答错」是 θ 低还是 b 高，单学习者能分吗？什么假设能部分解开？

**这是 n=1 最尖锐的混淆，且比静态尺度不定性更难。** 静态情形至少 `(θ-b)` 这个差是可识别的；非平稳情形里，一次「答错」有两个竞争解释——θ 此刻还低（没学会），或 b 高（题难）——而 owner 一人在某时刻对某题只产生**一个**二值观测，**两个自由度一个观测，局部欠定**。这正是 BKT 文献里 Beck & Chang 2007 指出的同型问题在 IRT 侧的化身：不同 (θ 轨迹, b) 组合可给出相同的作答预测。

**能部分解开吗？文献给的答案是「能，但靠的全是 n=1 自身之外的约束」**：

1. **外部锚固定 b（最强、唯一干净）**：b 由外部供给后，整条作答流的全部变化归因于 θ 轨迹 → 混淆消除。这是设计文档慢热第②③阶段的做法，也是 Elo/Urnings 系统在 n=1 下唯一合法的用法（见下）。

2. **时间平滑/学习过程先验（部分解开）**：假设 θ 单调或平滑上升（学习曲线先验），把 θ 轨迹的自由度从「每点独立」压成「少数曲线参数」。BKT 正是这种结构——把非平稳 θ 离散成「未掌握→掌握」的 HMM 跃迁，用 `p(T)` 学习率参数化 θ 的时间演化。**Doroudi & Brunskill 2017（EDM，Best Paper 提名）的关键结果**：Beck & Chang 2007 说的「BKT 不可识别」其实是误诊——借 HMM 可识别性定理，**在参数温和条件下 BKT 是可识别的**；真正的病是 *model degeneracy*（最佳拟合参数与 BKT 概念假设相悖，如 slip>0.5），那是语义病不是识别病。**但这个识别性是渐近的**——依赖「足够长且有起伏的序列」（HMM 识别定理的前提），这恰恰是 n=1 在**单个细粒度知识点**上最稀缺的（往往个位数次作答）。所以时间平滑只在「单 KC 序列够长」时部分解开，n=1 细粒度处通常不够长。

3. **紧先验（只让管线不崩，零信息增量）**：给 b 一个紧先验，混淆名义上被先验"解开"，但那是**原样回吐先验**——后验≈先验，没有被作答数据校准。这不是真解混淆，是回避。设计文档 §7.1「钉软轨低置信=不信，不是不算」精确刻画了这点。

4. **BKT↔IRT 的桥（Deonovic et al. 2018，Behaviormetrika）**：该文证明 **BKT 隐变量的平稳分布与一个 IRT 模型相关**——把「学习」（BKT）与「评估」（IRT）正式连起来。其隐含启示对本问题很关键：在平稳态，学习模型坍缩回评估模型，b 的语义可对接；但在**非平稳过渡态**（正在学习时），θ 和 b 的分离仍需 §1-2 的外部结构。这是已发表文献里关于「学习 vs 评估混淆」最直接的一座桥，建议补入设计文档 §8 来源表（当前 corpus 未收录，作者 Deonovic, Yudelson, Bolsinova, Attali, Maris——与 Urnings 的 Bolsinova/Maris 同组，权威性可观）。

**结论**：单学习者**不能仅凭自己的作答流**分开「θ 低 vs b 高」。能部分解开的全部假设——外部锚、学习曲线先验、紧先验——要么把信息从 n=1 之外引入（锚），要么把 θ 自由度参数化压缩（曲线先验，且要够长序列），要么干脆不解（紧先验回吐）。**唯一干净的是外部锚固定 b。**

### 问题 3 — Stocking 1990「a/c 单点不可识别」是否延伸到「b 在 n=1 也不可数据驱动」？b 与 a/c 不同吗？

**不延伸，且 b 与 a/c 有本质区别——这是整个识别性论证最需要讲清的分水岭。**

**Stocking 1990 的精确边界（摘要逐字，两独立源双核）**：「For the three and two parameter logistic models, examinees who contribute maximally to the estimation of item difficulty contribute little to the estimation of item discrimination... better item calibration results may be obtained (for fixed sample sizes) from examinee calibration samples in which ability is widely dispersed.」（Psychometrika 55(3):461-475, 1990，DOI 10.1007/BF02294761）。

**这句话说的是什么**：估 **a**（区分度=ICC 斜率）需要 ability **widely dispersed**——必须有一群 θ 散布很广的考生作答同一题，才能看出「答对概率随能力变化的速率」。n=1 一题在某时刻只有单一 θ → ICC 在该点只一个观测 → 斜率不可识别（过一点画无穷多斜率）。**c**（猜测下限）同理但更狠：c 是「极低能力尾部靠猜答对」的行为，owner 永远不在那个低能力尾部 → 语料区零观测。

**b 为什么不同——位置参数 vs 形状/尾部参数**：
- **b 是位置参数**：它是 ICC 在 θ 轴上的**平移位置**（θ=b 时 P=0.5）。位置可以靠**锚**借标尺确定——给定 θ，单点观测就能把 b 的位置反推出来（CI 宽但可识别）。
- **a 是形状参数（斜率）**：要识别「概率对能力的导数」，本质上需要能力维度上**至少两个不同 θ 的观测**。n=1 同题同时刻只有一个 θ，导数不可识别。
- **c 是尾部参数**：要识别尾部渐近行为，需要尾部（低能力区）有观测。n=1 的 θ 不覆盖该区。

**统计理论侧的同构印证（incidental parameters，已核验）**：JMLE 同时估 θ 和 item 参数时，item 参数**不一致**——Kiefer & Wolfowitz 1956，偏差量级 `(I-1)/I`，源于 incidental parameters problem（Neyman-Scott）：参数数随观测数发散。**CML（条件极大似然）能给一致的 b 估计，靠的是对 person raw score（θ 的充分统计量）取条件**，把 θ 从似然里消掉——但 **CML 本质上需要一个 cohort 来条件化**（对人群的 raw score 分布条件化）。n=1 没有人群可条件化 → CML 路径不可用 → 落回 JML 的 incidental-parameters 不一致。**这从估计理论侧确认了：b 的数据驱动估计依赖跨考生结构（cohort 提供充分统计量或总体分布），n=1 拿不到。**

**所以分水岭是**：
- **a/c/slip/guess** = 形状/尾部参数，其信息**结构性地只来自跨考生能力方差**，n=1 在定义上不提供 → **结构性不可识别，连锚都救不了**（无方差可借）。
- **b** = 位置参数，**可锚可推**——n=1 不能内部自证 b，但**可以靠外部锚把 b 借进来并随真值去偏**。b 的不可估是「相对 owner 自证而言」，不是绝对结构性不可识别。

**对设计文档的精确化建议**：§3 矩阵把 b 标「✅ 可估（靠外部锚）」、把 a/c/slip/guess 标「❌ 结构性不可估」是**正确的二分**，不应被「Stocking 证明 b 也不可估」误读。Stocking 1990 **只**支撑 a/c 那一行；b 那一行的承重是 Kolen & Brennan 2004（linking 奠基）+ incidental-parameters 的 cohort 依赖（说明 owner 自证不行），**不是 Stocking**。文档 §3 的诚实分界注（「Stocking 证明的是 IRT 样本结论，桥到 CDM/b 是本文机制推断」）已经堵住了这个误读，我确认这条纪律必须保留。

### 问题 4 — n=1 下 b 数据驱动的严格识别性条件

**b 在 n=1 可被「数据驱动地更新」（非内部自证、非结构性不可估），当且仅当以下假设全部成立**：

| # | 必要条件 | 性质 | 不成立的后果 |
|---|---|---|---|
| C1 | **外部锚提供 b 的尺度** —— b 的位置/单位由 owner 之外的来源（LLM 先验/公开题库/历史均值）给定 | 打破尺度不定性的唯一 n=1 途径 | 落回 logit 平移不变，θ/b 联合不可识别 |
| C2 | **θ 锚定后再定位 b** —— owner 的 θ 由锚题钉住，新题 b 在已知 θ 下反推 | linking 逆用（Kolen & Brennan 2004） | θ/b 双自由放开 → 退化为 N=1 校准样本，不可行 |
| C3 | **有金标真值做去偏** —— owner 客观题确定判分作为 i.i.d.（或加权校正）真值，对锚的偏差做 PPI rectifier | 让 b 后验**能动**且统计有效（Angelopoulos 2023, Science） | b 后验≈先验，原样回吐，零信息增量 |
| C4 | **非平稳 θ 被参数化约束** —— θ 轨迹由学习曲线先验/Elo-θ 更新压成低自由度，且 item 更新半边锁死 | 解开「θ 低 vs b 高」混淆（BKT/Urnings 机制） | 每个观测两自由度一观测，局部欠定 |
| C5 | **(若走 Elo/Urnings) 只用 θ-更新半边，item 更新半边锁外部锚** | Elo/Urnings 全部实证是多 agent 配对，item 在线更新靠多学生打同题；n=1 该半边失效 | 把多人系统能力错套单人，b 在线更新退回同一道墙 |

**这五条的逻辑闭包**：C1+C2 解决静态尺度不定性，C4+C5 解决非平稳混淆，C3 让 b 在锚定框架内仍能被真值数据驱动地更新（而非冻结）。**缺任意一条，b 要么不可识别（缺 C1/C2/C5），要么不可更新只能回吐先验（缺 C3），要么被 θ 轨迹混淆（缺 C4）。** 这与设计文档 §5 慢热四阶段、§5.3 Elo/Urnings G4 补缺、§5.3 PPI 映射完全自洽——我的核验给它们提供了识别性理论的统一根据。

**严格意义上「b 数据驱动」在 n=1 的天花板**：b 永远**不能脱离外部锚成为 owner 自证的量**。它能做到的最强形态是「锚给的先验 + owner 真值去偏后的后验」——这是「半数据驱动」（数据负责去偏，锚负责定尺度），不是「全数据驱动」（数据从零定 b）。设计文档 §7.4「锚来源的传导性缺口」正确地把这点标为独立风险项：**硬轨地基质量 = 锚质量**，n=1 无法靠自身数据救一个坏锚。

---

## 承重文献（每条标真实性/同行评审/引用量级，均本轮独立联网核到）

1. **Stocking, M. L. (1990). Specifying optimum examinees for item parameter estimation in item response theory. Psychometrika, 55(3), 461-475.** DOI 10.1007/BF02294761。— **a/c 单点不可识别的最硬地基。** 摘要逐字双源核到（Cambridge Core + Springer 检索），关键句一字不差。同行评审：是（Psychometrika，Q1）。引用量级：数百。真实性：**确认**。承重范围严格限于 a/c（区分度/猜测），**不延伸到 b**。

2. **Beck, J. E., & Chang, K. (2007). Identifiability: A fundamental problem of student modeling. User Modeling 2007, LNCS 4511, pp. 137-146.** — 提出「不同参数同预测」识别性问题，是 n=1 非平稳 θ + 自由参数混淆的原始陈述。同行评审：是（UM 会议）。引用量级：数百。真实性：**确认**（CMU 作者主页 + 多处 PDF 在线）。注意其结论已被 #3 部分推翻。

3. **Doroudi, S., & Brunskill, E. (2017). The Misidentified Identifiability Problem of Bayesian Knowledge Tracing. EDM 2017（Best Paper 提名）.** — **本研究最关键的二级文献。** 借 HMM 可识别性定理证明 BKT 在温和条件下**可识别**，Beck-Chang 说的其实是 model degeneracy 不是 identifiability。对本问题的 load-bearing 启示：识别性是**渐近的**，依赖足够长/有起伏的序列——n=1 细粒度知识点稀疏作答处通常达不到。同行评审：是（EDM，CCF-C/教育 AI 主力会议）。引用量级：数百。真实性：**确认**（dblp + CMU PDF + Wikipedia + 后续文献复述一致）。PDF 本体二进制未能解析正文，但摘要级主张经 dblp/作者主页/三处独立复述交叉确认，结论稳。

4. **Deonovic, B., Yudelson, M., Bolsinova, M., Attali, M., & Maris, G. (2018/2019). Learning meets Assessment: On the relation between Item Response Theory and Bayesian Knowledge Tracing. arXiv:1803.05926 / Behaviormetrika 46:457-474.** — 证明 BKT 隐变量平稳分布与 IRT 模型相关，是「学习（非平稳 θ）↔ 评估（b）」已发表的最直接桥梁。同行评审：是（Behaviormetrika 正式发表；arXiv 为预印本版）。引用量级：数十-百。真实性：**确认**（arXiv 摘要 + Springer + Tilburg 机构库 + DeepAI 五作者一致）。**建议补入设计文档 §8 来源表**（当前 corpus 未收录；与 Urnings 的 Bolsinova/Maris 同组，权威性可观）。

5. **Kolen, M. J., & Brennan, R. L. (2004/2014). Test Equating, Scaling, and Linking. Springer.** — b 靠 fixed-anchor linking 在 n=1 可借标尺的奠基教材（C1/C2 的承重）。同行评审：是（专著）。引用量级：数千。真实性：**确认**（设计文档已收录 #8，本轮逻辑链复用，未单独 re-fetch 全文，依赖已有核验）。

6. **Kiefer, J., & Wolfowitz, J. (1956) / incidental parameters problem (Neyman-Scott).** — JMLE item 参数不一致、偏差量级 (I-1)/I 的来源；解释「为何 b 的数据驱动估计依赖 cohort（CML 条件化或 MMLE 总体积分），n=1 拿不到」。同行评审：是（奠基统计文献）。引用量级：数千（Neyman-Scott 1948 主源），Kiefer-Wolfowitz 数百。真实性：**确认**（Wikipedia Rasch model estimation 引 + 计量经济学讲义多源；本轮核到 CML 用 person raw score 充分统计量消去 θ 的精确机制）。

7. **Bock, R. D., & Aitkin, M. (1981). MMLE: EM algorithm. Psychometrika, 46:443-459.** — MMLE「对 θ 总体分布积分」打破尺度不定性的路径，n=1 无总体故不可用（C1 的反面论证）。同行评审：是（Q1）。引用量级：~2283。真实性：**确认**（设计文档 #37 已收录，本轮逻辑复用）。

**辅助核验（非承重，定性支撑尺度不定性机制）**：Columbia Mailman IRT 概述、rfarouni「Model Identification in IRT」、Wikipedia「Item Response Theory / Rasch model estimation / Bayesian knowledge tracing」——用于交叉确认 logit 平移不变、pin θ₁=0/α₁=1 锚定、CML 充分统计量机制；均非同行评审一级源，仅作机制定性，不作净结论承重。

---

## 与设计文档的一致性裁定 + Linear

**裁定**：设计文档 §3 可辨识性矩阵关于 b/a/c 的二分**经得起独立复核，无需修正**。我的核验在三处**加固/精确化**了它（非推翻）：(1)「固定 b」应明确为「尺度锚外部供给且不可 owner 自证」而非「b 数值冻结」，b 在 PPI 框架内可动；(2) b 与 a/c 的分水岭是「位置参数（可锚可推）vs 形状/尾部参数（结构性不可识别）」，且 b 那一行的承重是 Kolen-Brennan + incidental-parameters，**不是 Stocking**——文档 §3 诚实分界注已正确隔离，须保留；(3) 非平稳 θ 混淆的「部分解开」依赖 BKT 渐近识别性（Doroudi-Brunskill），而该识别性需足够长序列，n=1 细粒度处常不满足。

**Linear**：本任务为识别性边界的文献复核，产出即上述结论，无代码/schema 改动。两个 actionable 跟进——(a) 设计文档 §8 来源表补入 Deonovic et al. 2018（Learning meets Assessment，BKT↔IRT 桥）；(b) §3/§7.4 把「b 锚来源 + 锚质量」作为独立风险项的措辞按上文 C1-C5 闸条精确化——均属既有 B1 / YUK-203 P3 决策总账的内联订正，**无需新建独立 Linear issue**，建议作为 comment 追加到 B1 对应 issue，与文档 §8 既有结论的 Linear 处置（无需新建）一致。

Sources:
- [Stocking 1990, Psychometrika 55(3):461-475 — Springer](https://link.springer.com/article/10.1007/BF02294761)
- [Stocking 1990 — Cambridge Core abstract](https://www.cambridge.org/core/journals/psychometrika/article/abs/specifying-optimum-examinees-for-item-parameter-estimation-in-item-response-theory/3B3CFA79DDF1475A500232A16F86183F)
- [Doroudi & Brunskill 2017, The Misidentified Identifiability Problem of BKT — EDM 2017 (CMU PDF)](https://www.cs.cmu.edu/~shayand/papers/EDM2017.pdf)
- [Doroudi & Brunskill 2017 — dblp](https://dblp.org/rec/conf/edm/DoroudiB17.html)
- [Deonovic et al. 2018, Learning meets Assessment — arXiv:1803.05926](https://arxiv.org/abs/1803.05926)
- [Bayesian knowledge tracing — Wikipedia](https://en.wikipedia.org/wiki/Bayesian_knowledge_tracing)
- [Rasch model estimation (JML/CML, incidental parameters) — Wikipedia](https://en.wikipedia.org/wiki/Rasch_model_estimation)
- [Item Response Theory (scale indeterminacy, location) — Columbia Mailman](https://www.publichealth.columbia.edu/research/population-health-methods/item-response-theory)
- [Model Identification in IRT — rfarouni](https://rfarouni.github.io/assets/projects/Identification/Identification.html)


## §B 动态/状态空间 IRT（θ 快变 + b 慢变双时间尺度）


I have sufficient evidence across all four sub-questions, anchored on primary sources (AOAS, JRSS-C, J. Intelligence, Applied Psychological Measurement, arXiv preprints). I'll render the verdict.

---

# 动态/状态空间 IRT：theta 演化下 item 难度怎么办 — 文献裁决

## 一、主流动态 IRT 怎么处理 theta 与 b（子问题 1）

核心事实，跨所有承重文献一致：**几乎没有哪个成立的动态 IRT 模型让 theta 和 b 同时自由地随时间漂。识别性逼着你二选一固定一头。** 三种主流形态：

**(A) theta 演化 + b 完全固定（最常见）。** theta 走随机游走或 AR(1)，b 当成已校准的常数喂进去。
- **D-BIRD（Lee, Cho, Matteson, Domingue 2025, arXiv:2506.21723）**：theta_{i,t} = μ_t + β_{i,t}，cohort 趋势 μ 和个体偏移 β **都是高斯随机游走**（Δμ_t ~ N(0,σ²)，Δβ_{i,t} ~ N(0,σ²)）；item 难度 **"known a priori"**——明确假设 item 来自预校准的稳定题库。这是「群体趋势 + 个体偏移」双层随机游走，但 item 锁死。
- 这一支的识别性靠把 b 钉死 + 对个体偏移做 centering（β 减去时间均值）来锚定群体趋势。**theta-b 混淆就是靠"b 不准动"消解的。**

**(B) theta 演化 + b "标称指定但带不确定性"（你要的折中的祖宗）。** 这是 **Wang, Berger & Burdick (2013), Annals of Applied Statistics 7(1):126–153, "Bayesian analysis of dynamic item response models in educational testing"（DIR models）**——本问题最承重的单篇。
- ability 用状态空间动态结构演化（D-BIRD 引用其为 "AR(1) priors over ability, as in Wang et al. 2013"）。
- item 难度**不是自由估、也不是死锁**，而是 **"partially specified but subject to uncertainty"**：难度有一个理论锚（在其 MetaMetrics/Lexile 阅读应用里，文本复杂度 text complexity 给出难度先验的均值），实际难度被建模为围绕该理论均值的一个 ensemble 抽样，带不确定性。
- **这正是"theta 快变（每次观测更新）、b 带紧先验锚在理论值附近"的正式 IRT 实例。** 它是状态空间 + FFBS（forward filtering backward sampling）+ Gibbs，支持在线运行。venue 是顶级应用统计期刊、同行评审、高引用。这是你方案的直接学术祖先。

**(C) item parameter drift (IPD) 文献**——把 b 的慢变当成需要"检测/校正的麻烦"而非建模对象。结论统一：**b 漂而你当它没漂，theta 估计直接被污染**（难度升→能力被低估，反之亦然）。这一支的处方是 anchor items（跨期共用的稳定锚题）+ 周期重校准，而不是让 b 随每次观测动。

**避免 theta-b 混淆的机制（所有支共用）**：保留一个不动的参照系——要么 b 固定（A），要么 b 被紧先验钉在理论锚附近（B），要么靠 anchor items 跨期链接（C）。**两头都自由漂 = 标准 IRT 的平移/缩放不可识别在时间维度上的复发**，没有外部锚就废。

## 二、双时间尺度 / 快慢分离的正式模型（子问题 2）

**有，但不是以"Kalman 双速率滤波"的现成包形态存在，而是以"先验强度差"的形态存在。**

- **形态上最贴的是 DIR (Wang et al. 2013)**：theta 的状态噪声方差大（每观测可动），b 的先验方差小且锚在理论均值（near-static）。**尺度分离 = 先验/状态噪声方差的量级差**，不是显式的双时钟。这是数学上让 b 可识别的关键：b 的紧先验 + 跨多 item/多观测的信息，把它钉住，theta 才能在其上自由摆。
- **Kalman / 粒子滤波 / Kalman-EM 显式动态 IRT**：状态空间 IRT 本质上就是非线性 Kalman 问题（observation 是 logistic，非高斯，所以用 EKF/UKF/粒子滤波或 FFBS-Gibbs）。`UKF` 那批结果（arXiv:2306.15710 等）来自系统生物学不是 IRT，但**思路可移植**：把 theta 放进快状态、b 放进带 identifiability 约束的慢参数，UKF 的局部可识别性分析正是用来判定"哪个慢参数在当前数据下可识别"的工具。**没找到一篇把"theta 快状态 + b 慢状态 + 显式两套过程噪声"打包成命名模型的 IRT 论文**——这是文献空隙，你若要做就是在 DIR 的方差分离思想上加一层显式慢游走。
- **尺度分离怎么数学保证 b 可识别**：靠三件事叠加——(i) b 的过程噪声方差 ≪ theta 的（慢）；(ii) b 带信息先验锚（不是 flat prior）；(iii) **同一个 b 被足够多的（theta 已知/已估的）观测击中**，使似然对 b 有曲率。第 (iii) 条是 n=1 的死穴（见下）。

## 三、Elo / Urnings 的 item 在线更新：为什么多 agent 成立、单 agent 必锁（子问题 3）

- **Elo（Hofman et al. 2020, "Tracking with (Un)Certainty", Journal of Intelligence 8(1):10）**：θ_p ← θ_p + K(S−E)，β_i ← β_i − K(S−E)，**零和对称更新**。多人系统成立的根因是 Math Garden 级别的流量——~71.4 万用户、每天 ~100 万 response 砸在**共享题池**上：每道 item 被海量不同学习者击中，β_i 的更新在大量 (player, item) 配对上平均，**item 难度的漂移被跨学习者的统计平均稳住**。
- **Urnings（Bolsinova, Maris, Hofman, van der Maas, Brinkhuis 2022, JRSS-C 71(1):91–118）**：R̃_i = R_i + X_ij − X*_ij（绿球红球交换），urn size n 控粒度（大 n = 低噪声但追变慢，等价 Elo 的小 K）。相对 Elo 的关键优势：**有已知误差分布**（不变二项分布给标准误，Elo 没有），且用 Metropolis-Hastings 显式校正自适应配题导致的方差膨胀。但它**同样要求 item 累积足够 response 才纳入分析**（文中阈值 ~3n 量级 per item）才稳。
- **单 agent (n=1) 为什么必须锁 item**：Elo/Urnings 的 item 更新合法性**完全依赖"很多不同人打同一道题"**——这样 β_i 的更新才是对 item 真实难度的无偏追踪，而非对单一学习者状态的混淆。单学习者下，对某 item 的少数几次作答里，**对错既可能因 item 变难、也可能因学习者那天状态/已掌握**，两者在 n=1 数据里**结构性不可分**（这就是 theta-b 混淆在 n=1 的极端形态）。所以 β 必须锁——一旦让它随单人作答动，它会去吸收本属于 theta 的方差，rating 漂移失控（Elo 已知的 variance inflation 在 n=1 更恶劣）。
- **单 agent + 慢 batch 重标定的折中文献**：**没有一个命名的"single-agent Urnings with batch recalibration"模型**。最接近的是两条间接证据：
  - **Adaptive Measurement of Change under IPD（Cooperman, Tai, DeWeese, Weiss 2025, Applied Psychological Measurement 49(3):109–125）**：这是**单 examinee 跨期能力变化追踪**的正面文献。结论——item 锁着、但实际漂了，会把单人能力变化检测搞出假阳（25% item 漂时 FPR 0.158–0.181）；**鲁棒上限约 5/25 道（~20%）漂移 item**，超过就崩。处方是**"用前先确认无 IPD"+ 用 IPD 检测法体检题库**，即**慢 batch 重标定，但靠跨学习者/跨期的外部校准数据做，不靠当前单学习者的在线更新**。这正好支撑你的折中方向：theta 单人在线动、b 单人不动，b 的慢重标定走离线 batch（跨人/跨期外部数据）。
  - **2026 扩展**（Gergely et al., Journal of Educational Measurement，Urnings + response time）说明 Urnings 仍在多人大规模设定下演进，没往单人方向走——侧证单人不是这族算法的设计点。

## 四、n=1（一个学习者、稀疏 per-item 观测）可行性裁决（子问题 4）

**裁决：theta 单人在线追踪可行；item b 单人在线追踪不可行（识别性崩）；唯一成立的形态是 theta 快变 + b 锁死/紧先验锚定 + b 的慢更新走离线 batch 重标定。**

**n=1 下哪些假设崩：**
- **崩：item 参数的在线可识别性。** Elo/Urnings/自由动态 b 全部依赖"多人打同题"做跨学习者平均——n=1 没有这个平均，β 更新无法和 theta 状态分离。这是硬崩，不是精度问题。
- **崩：per-item 似然曲率。** 稀疏 per-item 观测意味着每道 b 只被这一个学习者打过几次，似然对 b 几乎平的，b 的后验 = 先验。所以**b 只能靠先验/外部校准活着**，不能靠数据动。
- **崩：cohort-borrowing 类模型直接不适用。** D-BIRD 的力量来自跨学生借信息（cohort trend μ_t），n=1 时 μ 和 β 完全混淆，模型退化。

**n=1 下哪些还成立：**
- **成立：theta 的状态空间追踪（前提 b 已知）。** 这正是 AMC（Cooperman 2025）和 DIR（Wang 2013）的单/少 subject 设定——给定校准好的 item，单人 theta 随机游走/AR 是标准 Kalman/FFBS 问题，n=1 完全 OK。
- **成立：b 的"紧先验锚 + 慢离线重标定"。** DIR 的"b partially specified with uncertainty"机制天然为此设计：b 的先验均值来自题目内在属性（如文本复杂度/题型理论难度），先验方差小；单人作答**不动 b**，b 只在攒够跨期/跨人外部校准数据后做一次 batch 重估。这与 IPD 文献的"anchor items + 周期重校准"完全同构。
- **半成立：b 的不确定性传播。** 即使不在线更新 b，也应把 b 的先验不确定性传进 theta 的估计（DIR 做了），否则单人 theta 标准误会假性偏小。Urnings 相对 Elo 的卖点（已知误差分布）在这里有借鉴价值——但仅用于 theta 侧。

**给你方案的直接结论：**「theta 每次观测更新 + b 慢变带紧先验」是**有学术祖先的正确形态，祖先就是 Wang/Berger/Burdick 2013 DIR**。但在 n=1 下，"b 慢变"不能解释成"b 随这个学习者的作答慢慢在线漂"——那会复发 theta-b 混淆。正确的"慢"是：**b 在单人会话里锁死在带不确定性的先验上，只在离线、靠跨学习者或跨期外部数据攒够信息时做 batch 重标定**（IPD 检测 + anchor 链接的节奏）。尺度分离在 n=1 不是靠两套过程噪声自动保证，而是靠"b 的信息来源完全在单人在线回路之外"这个结构性切分来保证。

---

## 承重文献（真实性 / venue / 评审 / 引用）

1. **Wang, X., Berger, J. O., & Burdick, D. S. (2013). Bayesian analysis of dynamic item response models in educational testing. *Annals of Applied Statistics*, 7(1), 126–153.** DOI 10.1214/12-AOAS608. — **最承重。** AOAS 是顶级同行评审应用统计期刊；James Berger 是贝叶斯统计权威。真实，高引用。**theta 快变 + b 带不确定性先验锚（Lexile/文本复杂度）的正式 DIR 模型**——你方案的直接学术祖先。

2. **Bolsinova, M., Maris, G., Hofman, A. D., van der Maas, H. L. J., & Brinkhuis, M. J. S. (2022). Urnings: A New Method for Tracking Dynamically Changing Parameters in Paired Comparison Systems. *JRSS Series C: Applied Statistics*, 71(1), 91–118.** DOI 10.1111/rssc.12523. — 同行评审，RSS 旗舰应用期刊；van der Maas/Maris 是 Math Garden 核心团队。真实，已成 adaptive learning 标准引用。**item 在线更新依赖大规模多人共享题池 + 已知二项误差分布。**

3. **Hofman, A. D., Brinkhuis, M. J. S., Bolsinova, M., et al. (2020). Tracking with (Un)Certainty. *Journal of Intelligence*, 8(1), 10.** DOI 10.3390/jintelligence8010010. — 同行评审开放获取。给出 Elo 零和对称更新 + 其 variance inflation / 无误差分布缺陷的权威陈述。中等引用，真实。

4. **Cooperman, A. W., Tai, M. H., DeWeese, J. N., & Weiss, D. J. (2025). Adaptive measurement of change in the context of item parameter drift. *Applied Psychological Measurement*, 49(3), 109–125.** — 同行评审（APM 是 psychometrics 标准期刊；David Weiss 是 CAT 奠基人）。**单 examinee 能力变化追踪 + item 漂移容忍上限（~5/25 题）+ 离线体检/重标定处方**——直接支撑 n=1 折中。较新，引用积累中，作者署名权威。

5. **Lee, H., Cho, J. B., Matteson, D. S., & Domingue, B. W. (2025). Dynamic Bayesian Item Response Model with Decomposition (D-BIRD). arXiv:2506.21723.** — **预印本，尚未同行评审（按此使用，勿当定论）**；但作者机构强（Stanford/Cornell），Domingue 是教育测量活跃学者。提供 theta 双层随机游走（cohort + 个体）的清晰形态，明确 item 已知先验、靠跨学生借信息——直接示范"为什么 n=1 缺 cohort 会崩"。

6. **(扩展，非承重) Gergely et al. (2026). Augmenting the Urnings Algorithm with Response Times. *Journal of Educational Measurement*.** + **Sun, Liu, Wang, Chen (2025). Bayesian Variable Selection in Dynamic IRT Models. *Journal of Educational and Behavioral Statistics*.** — 侧证该族仍在多人/动态 IRT 方向演进、未转向单人在线 item 更新。

**文献空隙（如实标注）**：没有一篇把"theta 快状态 + b 慢状态 + 两套显式过程噪声"打包成命名 IRT 模型的论文；也没有"single-agent Urnings + batch recalibration"的命名方法。你的双时间尺度方案在 DIR 的方差/先验分离思想上是**正确延伸**，但属于需要自建的部分——可援引为"在 Wang et al. 2013 的状态空间 + 先验锚框架上，对 b 施加显式慢游走 + 单人回路外重标定"，而非引用现成模型。

(无需创建 Linear issue——这是纯文献研究任务，无代码/follow-up 动作产出。)


## §C 经验贝叶斯 / shrinkage（b 锚定 + 轻推）


I have all the承重 references confirmed and the math nailed. I have enough to deliver the full synthesis without further fetches. Let me compose the final answer.

---

# Shrinkage 锚定 item 难度 b：数学形态、n=1 行为与 tau 裁决

## 0. 一句话裁决

你要的「owner 作答只能轻推 b、不能自由估」**正是经验贝叶斯/分层 IRT 的标准形态**，且它有 40 年的承重文献（Mislevy 1986/1988, Swaminathan & Gifford 1982/1985/1986）。**但 n=1 是这套数学的退化区**:单条二元作答携带的 Fisher 信息极小，因此**任何能让 b 真正"动起来"的 tau,都同时大到让 b 在个位数观测下乱跑**——bias 与 variance 在 n=1 上不存在干净的甜区。可行的工程结论是:**tau 必须先验固定(不可从 n=1 数据估)**,且应**按 LLM 锚的可信度分级固定**,而不是寻找一个能两全的 tau。下面给出全部推导与依据。

---

## 1. Shrinkage 模型的数学形态

### 1.1 高斯近似下的精确闭式(直觉骨架)

把每个 item 的难度建模为
- 先验(锚): `b_i ~ Normal(b_anchor_i, tau^2)` —— `b_anchor_i` 是 LLM/题库给的外部估计,`tau` 是"信任锚 vs 信任数据"的旋钮。
- 把 owner 的作答经 IRT 似然先压成一个"数据侧的 b 估计" `b_hat_i`(MLE),其抽样方差 `~ sigma^2 / n_i`(`n_i` = 该 item 的作答数,`sigma^2` 由 Fisher 信息决定)。

normal-normal 共轭(Wikipedia *Conjugate prior*,"Normal with known variance"行,已逐字核对)给出后验:

```
后验精度  = 1/tau^2 + n/sigma^2
后验均值  b_post = ( b_anchor/tau^2 + (n/sigma^2)·b_hat ) / ( 1/tau^2 + n/sigma^2 )
后验方差  = ( 1/tau^2 + n/sigma^2 )^(-1)
```

写成 shrinkage 权重形式(这就是你要的"轻推"代数):

```
b_post = (1 - w)·b_anchor + w·b_hat,    其中  w = (n/sigma^2) / (1/tau^2 + n/sigma^2)
                                              = n·tau^2 / (n·tau^2 + sigma^2)
```

`w` ∈ [0,1] 是**数据从锚上"拉走"b 的份额**。这正是 Mislevy(1988)经验贝叶斯三步法里的"precision-weighted average":数据 MLE 与回归预测(作锚)各按精度加权。我已从 PMC10664746 逐字核到同构公式:`b̃ = (β̂·τ̂⁻² + β̄·φ̂⁻²)/(τ̂⁻² + φ̂⁻²)`,后验精度 `σ̃⁻² = τ̂⁻² + φ̂⁻²`——与上式完全一致(他们的 `φ̂²` 就是这里的 `tau^2`)。

### 1.2 极限行为(回答你的第 3 问)

| tau | w 的极限 | 语义 |
|---|---|---|
| `tau → 0` | `w → 0`,`b_post → b_anchor` | **fixed-anchor 锁死**:b 恒等于锚,作答无效 |
| `tau → ∞` | `w → n·tau²/(n·tau²) = 1`,`b_post → b_hat` | **自由估**:完全忽略锚,纯数据(n=1 时极不稳) |
| 中间小 tau | `w = n·tau²/(n·tau²+sigma²)` ∈ (0,1) | 轻推:数据按精度比例推动锚 |

所以你"锁死 = tau→0、自由 = tau→∞、中间小 tau 是轻推"的直觉**在代数上完全正确**。

### 1.3 关键修正:IRT 的 n=1 不是高斯,sigma^2 不是常数

上面的闭式是**高斯似然近似**。真实 IRT 里 owner 对一道题的作答是**一次二元 Bernoulli**(对/错),不是连续观测。两个后果决定了 n=1 的命运:

1. **单题 Fisher 信息极小且依赖 theta-b 匹配。** 2PL/Rasch 下单次作答对 b 的信息约为 `a^2·p·(1-p)`,在 `p=0.5`(theta≈b)时最大也只有 `a^2/4`。一次答对/答错只把 b 的对数似然挪动一点点——`sigma^2`(即 `1/Fisher`)很大,于是 `w = n·tau²/(n·tau²+sigma²)` 在 n=1 时被巨大的 `sigma^2` 压到很小。**这是"先验主导"的根因,不是 tau 设小,而是数据本身没信息。**
2. **二元数据 + 弱信息时,MLE 可发散(全对/全错 → b̂ = ±∞)。** 这正是 Swaminathan & Gifford(1982,*Journal of Educational Statistics*)引入贝叶斯先验的原始动机:先验把发散的估计**正则化回有限值**。先验在这里不是"偏见",是**让 n=1 估计存在**的前提。

---

## 2. n=1 / 稀疏数据下后验被先验主导多少(第 2 问)

用 `w = n·tau²/(n·tau²+sigma²)`,代入 IRT 量纲的典型数:Rasch 单题信息 ~0.25,故 `sigma^2 ~ 1/0.25 = 4`(logit² 量纲;b 通常在 [-3,3])。

| n_i (该 item 作答数) | tau=0.3(紧) | tau=0.7(中) | tau=1.5(松) |
|---|---|---|---|
| 1 | w≈0.022 | w≈0.109 | w≈0.36 |
| 3 | w≈0.063 | w≈0.27 | w≈0.63 |
| 5 | w≈0.10 | w≈0.38 | w≈0.74 |
| 10 | w≈0.18 | w≈0.55 | w≈0.85 |

读法:
- **tau=0.3(紧):** n=1 只推动 ~2%,要到 n≈10 才推 18%。**实际退化回锁死**——owner 作答几乎不改 b。这印证 Gifford & Swaminathan(1990,*Applied Psychological Measurement*)"different specifications of prior have relatively modest effects"——他们用的是中等样本,先验影响"modest";在 n=1 上同样的紧先验会变成"几乎为零",更极端。
- **tau=0.7(中):** n=1 推 ~11%,n=3 推 27%,n=5 推 38%。**一次作答只是"轻推",要 3-5 次才形成可感知位移。** 这与"轻推"语义最贴。
- **tau=1.5(松):** n=1 已能推 36%——但**这恰恰是危险区**:一次偶然的对/错就把 b 拉走三分之一,方差爆炸。

**结论(第 2 问):** n=1 下,只要 tau 取得够紧到"安全"(b 不乱跑),先验就主导 ≥90%,b 基本不动;要让单次作答有 ≥30% 位移,tau 必须松到让噪声主导。**"真正推动 b"通常需要 3-8 次同 item 作答**(取决于 tau),单次作答数学上只能是"记一笔",不能定调。

---

## 3. tau 怎么定:固定 vs 数据估,n=1 可估吗(第 1 问)

### 3.1 n=1 下 tau **不可**从数据估——这是硬约束

- **分层贝叶斯**里 tau 是 across-items 的方差超参,可在 item **数量**多时由数据估(half-Cauchy(scale=10) 超先验,见 PMC10664746;Natesan 等对方差超参用弱信息先验)。但它估的是"全体 item 真难度围绕锚的离散度",需要**多个 item × 足够 per-item 作答**才可辨识。
- **per-item、n_i=1** 时,tau 与数据噪声 sigma 在似然里**共线不可分**:你看到的单次"对/错"既可解释为"锚准但运气好",也可解释为"锚偏 tau 大"。**单点无法分离信号与噪声**,所以 tau 在 n=1 必须**先验固定 / 由超先验强约束**,绝不能让它"自由估"。
- 文献佐证方向:inverse-gamma 方差先验在 σ 可能很小时极度敏感(PMC10664746 明确点名),弱信息 half-Cauchy 更稳——但这都是**多 item 分层**场景的建议。落到你的单 item 轻推,**等价于把 tau 钉成常数(经验贝叶斯做法,Mislevy 1988 把残差方差当 plug-in 固定)**,这就是为什么经验贝叶斯比全分层在小样本更可控:它**不去估那个估不准的方差**。

### 3.2 实操:tau 按锚可信度分级固定

不要找"一个万能 tau",而是**让 tau 反映 LLM 锚本身有多准**:

- LLM 难度估计与 IRT 真参数的相关性是有限的(Säuberli & Clematide 2025,SARA 数据集,GPT-4o/o1:估计"meaningfully align"但"在极端难/易 item 上系统性失真")。**所以锚在中段可信、在尾部不可信。**
- 推荐:`tau_i = tau_base × c(锚置信)`。LLM 给高置信(有题型先例、中段难度)→ 小 tau(~0.3-0.5,强锚);LLM 给低置信或极端 item → 大 tau(~1.0-1.5,让数据更快接管)。这把"锚准的地方锁紧、锚虚的地方留口子"做进先验,而不是全局一刀切。

---

## 4. n=1 安全甜区裁决(第 3、4 问)

### 4.1 bias-variance 权衡在 n=1 的具体形态

后验均值的 MSE(对真 b)分解:

```
E[(b_post - b_true)^2]  ≈  (1-w)^2·(b_anchor - b_true)^2   +   w^2·sigma^2/n
                           └──── bias^2(锚偏被 (1-w) 残留) ──┘   └─ variance(数据噪声被 w 放大)─┘
```

- **bias 项**:锚错多少 × `(1-w)^2`。tau 越紧 → w 越小 → 锚偏几乎全保留。若 LLM 锚在某 item 系统性偏(极端 item),紧 tau 会把这个偏**永久焊死**。
- **variance 项**:`w^2·sigma^2/n`。n=1、sigma^2 大(IRT 单题信息小),所以这一项对 w 极敏感——w 稍大,方差就炸。

**n=1 的残酷之处**:让 variance 项可控需要 w 小(tau 紧),让 bias 项可控需要 w 大(tau 松)。两者在 n=1 **指向相反的 tau**,且因为 `sigma^2` 大,**没有一个 tau 能同时压住两项**——这与多样本场景(n 大时 variance 项自然随 1/n 缩小,甜区清晰)本质不同。

### 4.2 裁决:n=1 没有"自由估的安全甜区",有的是"安全的锁定 + 受控解锁"

- **不存在**一个中间 tau 让"单次作答数据驱动 b 且安全"。任何让 n=1 位移 ≥30% 的 tau(≥1.5)都让一次偶然对/错主导 b → 不安全;任何安全的 tau(≤0.5)都让 n=1 位移 <10% → 退化回锁死。
- **可行甜区是在 n 上、不在 tau 上**:固定一个**中等偏紧的 tau(≈0.4-0.6,Rasch logit 量纲)**,接受 n=1 只"记一笔(~5-10% 位移)",让**累计 3-8 次作答自然把 w 推过 0.3-0.5**。即——**不靠 tau 给单点放权,靠样本积累解锁。** 这与"owner 只能轻推不能自由估"的产品意图天然吻合:**单次轻推、多次才改写**。
- **工程护栏(对应你的护栏两层语义记忆)**:
  - warning 层:per-item 后验仍记 `(n_i, w_i, |b_post - b_anchor|)`,可观测"哪些 item 正被作答推离锚"。
  - hard 层:对单 item 的 `|b_post - b_anchor|` 设 3×tau 的硬顶(等价 trimmed/robust 似然),防一次全对/全错把 b 拉到 ±∞(直接回应"松先验下 n=1 乱跑"风险)。
  - n 门槛:`b_post` 仅在 `n_i ≥ k`(建议 k=3)后才回写为"已校准",否则一律显示锚值 + "证据不足"标记。

---

## 5. 承重文献(真实性 / venue / 评审 / 引用)

**A. 经验贝叶斯 IRT 锚定难度——直接母本(最承重)**
1. **Mislevy, R. J. (1987). "Exploiting Auxiliary Information About Examinees in the Estimation of Item Parameters." *Applied Psychological Measurement*, 11(1), 81-91.** DOI 10.1177/014662168701100106。真实,同行评审,APM 是计量心理学 A 类期刊;Mislevy(ETS,IRT 经验贝叶斯奠基人)。**你的 b~Normal(anchor, tau²) + 精度加权后验的原始处方就在这条线上**(配套 ETS 技术报告 ED288914 1987 / 1988)。引用量级数百,领域内经典。
2. **Mislevy, R. J. (1986). "Bayes modal estimation in item response models." *Psychometrika*, 51(2), 177-195.** 真实,Psychometrika(计量心理学旗舰,严格评审)。给出 b 的 Bayes modal(MAP)估计 = 先验正则化的点估计,是"轻推"的点估计版本。高引经典。

**B. 小样本 / informative-prior 行为——n=1 风险的直接证据**
3. **Swaminathan, H., & Gifford, J. A. (1982). "Bayesian Estimation in the Rasch Model." *Journal of Educational Statistics*, 7(3), 175-191.** 真实,同行评审,JES(现 JEBS)。**先验正则化让二元数据下发散的 b̂ 收敛的原始动机**;明确反对"极度乐观的单位正态先验或极度发散的大方差先验"——直接支撑你"两端都坏、要中间"的判断。
4. **Gifford, J. A., & Swaminathan, H. (1990). "Bias and the Effect of Priors in Bayesian Estimation of Parameters of Item Response Models." *Applied Psychological Measurement*, 14(1), 33-43.** 真实,APM,同行评审。结论"prior 规格对估计影响 modest,小样本下贝叶斯比 JML 偏差更小"——量化了 bias-variance 权衡。高引。
5. **Swaminathan & Gifford (1985, 2PL) / (1986, 3PL), *Psychometrika*.** 真实,旗舰评审期刊;最早提出 2PL/3PL 的**分层版本**用于小样本定标——分层 tau 估计的源头。

**C. 当代分层 vs 经验贝叶斯 + 方差超参——tau 估计可辨识性**
6. **"Using Auxiliary Item Information ... Empirical Versus Hierarchical Bayes Estimation"(2023, *Applied Psychological Measurement* / PMC10664746).** 真实,同行评审,近期。逐字给出经验贝叶斯精度加权公式(本文 §1.1 引用源),并实证"分层贝叶斯在 N≥250 才是 MMLE 可接受替代"——**反向证明 n 极小时分层方差不可靠**,支撑"tau 必须固定"。
7. **"Benefits of the Curious Behavior of Bayesian Hierarchical IRT Models—An In-Depth Investigation and Bias Correction"(2024, PubMed 38327609 / PMC10846471).** 真实,同行评审。系统刻画 shrinkage 带来的 bias 及其修正——直接对应你"紧先验下退化锁死"的偏差形态。

**D. LLM 作锚的可信度(决定 tau 分级)**
8. **Säuberli & Clematide(2025). "Exploring the Potential of Large Language Models for Estimating the Reading Comprehension Question Difficulty." arXiv:2502.17785.** 真实,已被 HCI International 2025 录用(会议论文,经评审);GPT-4o/o1 vs SARA 数据集 IRT 参数。**关键限定**:LLM 估计"meaningfully align"但**在极端 item 上系统性失真**。这是预印本+会议,引用尚少(2025 新作),**作"锚有用但尾部不可信"的证据可用,但不要当作 tau 数值的权威来源**——锚质量须用你自己的题库回测。

**承重度排序**:A(Mislevy)+ B(Swaminathan & Gifford)是数学与风险的承重墙,均为旗舰/A 类期刊、同行评审、高引、领域奠基级;C 是当代可辨识性证据;D 仅作"LLM 锚质量分级"的弱支撑(新预印本/会议,需自验)。

---

## 6. 给你的一行落地处方

`b_post = (1-w)·b_anchor + w·b_hat`,`w = n·tau²/(n·tau² + sigma²)`;**tau 固定不估**(n=1 不可辨识),按 LLM 锚置信分级取 **0.4-0.6(中段强锚)到 1.0-1.5(极端 item 弱锚)**;**n=1 只记一笔(~5-10% 位移),靠 3-8 次累计解锁**;硬顶 `|b_post-b_anchor| ≤ 3·tau` 防乱跑;`n_i<3` 一律显示锚值+"证据不足"。**没有"单点自由估"的安全甜区——甜区在样本积累,不在 tau。**

Sources:
- [Mislevy 1987, Exploiting Auxiliary Information (APM)](https://doi.org/10.1177/014662168701100106)
- [Mislevy ETS technical report ED288914 (1987/1988)](https://files.eric.ed.gov/fulltext/ED288914.pdf)
- [Mislevy 1986, Bayes modal estimation (Psychometrika)](https://link.springer.com/article/10.1007/BF02293979)
- [Swaminathan & Gifford 1982, Bayesian Estimation in the Rasch Model (JES)](https://journals.sagepub.com/doi/10.3102/10769986007003175)
- [Gifford & Swaminathan 1990, Bias and the Effect of Priors (APM)](https://journals.sagepub.com/doi/abs/10.1177/014662169001400104)
- [Swaminathan & Gifford 1986, Bayesian estimation in the 3PL model (Psychometrika)](https://link.springer.com/article/10.1007/BF02295598)
- [Empirical vs Hierarchical Bayes, auxiliary item info, GRM (APM / PMC10664746)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10664746/)
- [Benefits of the Curious Behavior of Bayesian Hierarchical IRT Models (PMC10846471 / PubMed 38327609)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10846471/)
- [Säuberli & Clematide 2025, LLMs for Reading Comprehension Question Difficulty (arXiv:2502.17785)](https://arxiv.org/abs/2502.17785)
- [Conjugate prior, normal-normal update formulas (Wikipedia)](https://en.wikipedia.org/wiki/Conjugate_prior)
- [Inverse-variance / precision-weighted average (Wikipedia)](https://en.wikipedia.org/wiki/Inverse-variance_weighting)


## §D feature-based difficulty（题面内容预测 b）


全部坐实。AutoIRT(Duolingo team, von Davier 等, 2024)是工业级的两段式实例:feature-based explanatory IRT 当先验 → Bayesian updating 用作答 refine。Wauters et al. 2012(C&E 58:1183-1193)是两段式「judgment/alternative 估当 Bayesian prior + 作答校准」的奠基期刊出处。

证据已收齐,可以给最终研究结论。

---

# Feature-based item difficulty 研究核验报告

## 总判据(一句话)

> **「用 LLM 抽题面教学特征 → 回归/树/NN 预测 item 难度 b」是一条方法学成熟、2024-26 实证活跃、且在 n=1 下结构上最稳的内容驱动 b 路线;「内容估 b 当先验锚 + 作答慢校准」的两段式是有期刊+工业级实证支撑的标准做法。唯一真天花板是 external validity:foundation §7.3 标的 r 值全部真实,但全是英文数学/阅读域 —— 而对中文 K12 不是「零直证」,是「有直证且偏负面」(ZPD-SCA 2025,新发现,比 foundation 自标的缺口更严重)。**

---

## 1. 主流方法成熟度 + LLM-feature 路线真实 r 值(全部联网坐实)

**方法学谱系(已被一篇 2025 系统综述固化)**:特征 → 学习模型 → b,主流分两支:(a) 经典 ML(线性/penalized 回归、随机森林、XGBoost/GBM 树集成,可解释)、(b) transformer/embedding 端到端(免手工特征)。LLM 的新角色是「**抽教学认知特征**」(解题步数、认知复杂度、潜在误解)喂下游学习模型,而非直接 prompt 估难度。

**foundation §7.3 / §8 引的几篇,逐篇核验结论(无一编造)**:

| foundation 声称 | 核验结果 | 真实性裁定 |
|---|---|---|
| r≈0.87 = arXiv **2504.08804**(Razavi & Powers,树集成) | **坐实**:Razavi & Powers,"Estimating Item Difficulty Using LLMs and Tree-Based ML",v1 2025-04-09 / v2 2026-03-09;feature-based(LLM 抽特征 + random forest/gradient boosting),N=5170,**K-5 数学+阅读**,"correlations as high as r=0.87"。direct LLM 估难度显著更弱 | 真实·预印本。**H1 修正正确** |
| 2502.20663 ≠ 0.87,是 penalized regression r=0.77 | **坐实**:Kapoor, Truong, Haber, Ruiz-Primo, Domingue(Stanford),"Prediction of Item Difficulty…Annotated Item Repository",reading comprehension(NY/TX grade 3-8),penalized regression **r=0.77**(RMSE 0.59 vs baseline 0.92)。**确非随机森林、确非 0.87** | 真实·预印本。**H1 区分正确,owner 原误挂会引错论文** |
| direct prompt r≈0 + ensemble r=0.75/0.76/0.82 = Acquaye **2601.09953** | **坐实**:Acquaye, Huang, Carpuat, Rudinger(UMD),"Take Out Your Calculators",2026;abstract 明确 ensemble r=0.75/0.76/0.82(G4/8/12),**标准化数学测试** | 真实·预印本。承重源归属正确 |
| ensemble 路有一个 CORE-A 同评源 = SMART **2507.05129** | **坐实**:Scarlatos, Fernandez, Ormerod, Lottridge, Lan,**EMNLP 2025 main track**(aclanthology 2025.emnlp-main.1274),DPO 对齐模拟学生 + IRT,专攻 cold-start | 真实·**正式发表·CORE-A**。**H2 修正正确(曾被错降为预印本)** |
| r≈0.78 = Hoyl **2602.00034**,方法 NN+IRT | **坐实**:Matias Hoyl(Stanford),2026,**两阶段 NN→IRT**(非 random forest),r≈0.78 on **completely unseen** items,250k+ 数学作答 | 真实·预印本·单作者。**L3 修正正确** |
| 综述背书(foundation 未引,本轮新增) | **新发现**:Peters, Zhang, Jiao, Li, Zhou, Lissitz,"Text-Based Approaches to Item Difficulty Modeling in Large-Scale Assessments: A Systematic Review",arXiv **2509.23486**,2025;**37 项研究**,r 最高 0.87,RMSE 低至 0.165 | 真实·预印本·系统综述。可作 foundation §7.3 的上位背书,且其 abstract **未提任何中文/非英文域** → 直接坐实 G2 缺口 |

**成熟度判定**:方法成熟(有系统综述、有工业级落地、典型 r 在 0.5-0.87、feature-based 稳定优于 direct-prompt)。但「成熟」指**方法范式**成熟,不指「任意域 plug-and-play」—— 见第 4 节。

---

## 2. 这条路线在 n=1 的角色:确实是 n=1 数据驱动 b 最稳的一条

**结论成立,且与 foundation §3 可辨识性矩阵完全自洽**。逻辑链:

- foundation §3 已证:用 owner 一人作答去估 b → 退化为 N=1 校准样本,不可行(b 是「以考生总体为背景的位置参数」)。
- feature-based b **完全绕开这道墙**:b 从**题面内容**估,不消费 owner 任何作答 → 不进入 owner 的似然 → **结构上不可能与 θ 混淆**(识别性问题在源头消失,因为它根本不是从「owner 答题数据」里解出来的,是从「题目文本」里预测的)。
- 这正是 explanatory IRT 的核心卖点(本轮核到的标准表述):"use item-level features to predict item parameters rather than treating each item independently → enables calibrating tests in cold-start settings"。

**所以「feature-based b 是 n=1 数据驱动 b 最稳一条」这个判断,文献支持**:它是唯一一条「b 的信息来源(题面)与 θ 的信息来源(owner 作答)正交」的路线,因此天然不碰 n=1 的 a/c/θ 纠缠死结(§3 那张墙只挡「从作答估」的路,不挡「从内容估」的路)。**对 n=1,它不是诸多选项之一,是把 b 的估计从「无解的识别性问题」转成「有解的监督学习问题」的唯一搬运方式。**

---

## 3. 两段式(内容估 b 当先验锚 + 作答慢校准):是文献支持的标准做法

**强支撑,有期刊奠基源 + 工业级实例两层**:

1. **奠基期刊源(本轮新坐实)**:Wauters, Desmet, Van Den Noortgate,"Item Difficulty Estimation: an Auspicious Collaboration Between Data and Judgment",**Computers & Education 58:1183-1193, 2012**, DOI 10.1016/j.compedu.2011.11.020(EDM 2011 best-paper nominee 的期刊版)。它明确比较 6 种非 IRT 估难度法,结论:**"alternative estimation methods… can be used as a prior in a Bayesian estimation method when IRT-based calibration does not yet provide reliable estimates"**,且 learner feedback / one-to-many(learner)在小样本下也稳。这就是「内容/判断估当先验 + 作答慢校准」的**逐字文献根据**。

2. **工业级两段式实例(本轮新坐实)**:Sharpnack, …, von Davier,"BanditCAT and AutoIRT",arXiv 2410.21033, 2024(Duolingo 团队)。AutoIRT = 「AutoML(item features + BERT embeddings + NLP 特征)→ explanatory IRT」当 warm-start,再用 **Bayesian updating** 让作答 refine 初始 feature-based 估计。**这正是 foundation 的 collapse 形态(LLM/feature 先验 + 作答慢校准)的工业级先例,且是同行验收过的真实生产系统(Duolingo English Test)。**

3. **2024-25 已成 cold-start 标配**:本轮检索确认「LLM 预测难度 → 经 contrastive learning / student modeling / attention-based calibration 与作答经验数据融合」被多篇近作复述为 cold-start 的 emerging standard。

**对 foundation 的映射**:foundation §5.3 已把这条接到 PPI(合成≥真值)+ Elo/Urnings(θ 在线追)。本轮补的是「先验锚→作答 refine」这个**两段式骨架本身**的文献定性 —— 它不只是 PPI 一个点,而是 Wauters 2012 + AutoIRT 2024 验证过的整体范式。**两段式可行,且 owner 的设计与已发表/已生产的做法同构。**

---

## 4. 天花板:external validity 缺口比 foundation 自标的更严重

foundation §7.3 G2 标的是「r 值全英文数学/阅读域,对中文 K12 **零直证**」。**本轮核验把这条修正得更尖锐 —— 不是「零直证」,是「有直证,且偏负面」**:

- **ZPD-SCA(Dong, Sun, Zhao, … Mo,arXiv 2508.14377,2024/2025)** = 直接的中文 K12 LLM 难度标定基准:**中文义务教育数学+语文,对齐教育部课标,60 位特级教师标注**。核心结论:**LLM zero-shot 评估中文题认知难度表现差,Qwen-max 与 GLM 甚至低于随机猜测;给 in-context examples 后翻倍但仍有系统性方向偏差**。
- 这比 foundation 想的更危险有两点:(1) 它**正好是本项目的语种+学段+科目**(中文 K12,含语文这种开放/主观题型重的科目);(2) 它测的两个模型 **Qwen / GLM 正是本项目栈的近亲**(xiaomi/mimo + GLM coding plan 都在用国产模型族);(3) 它打的是 **LLM 抽认知特征/估认知难度这一环**,而这正是 feature-based 路线最依赖 LLM 判断力的上游环节。

**缺口严重度判定:中-高,且必须从 foundation 现有措辞「升级」**:

- 英文域 r=0.75-0.87 **不能直接外推到中文 K12**;ZPD-SCA 是直接反证,说明 LLM 在中文认知难度判断上有 well-documented 偏差。
- 但**不是否决**:ZPD-SCA 同时显示 in-context examples 能显著拉回,且 feature-based 路线的稳健性恰恰来自「不让 LLM 直接定难度,而是抽特征喂下游回归」—— direct-prompt 弱(r≈0,ZPD-SCA 也是 direct 场景)正是 foundation 选 feature-based 而非 direct 的依据。
- **真天花板**:中文 K12 各科(尤其语文/历史/政治等开放题重科目)的 feature-based b 有效性**无任何正向直证**,且唯一相关直证是负面的。这与 §7.2 G1(开放/主观题型外推零文献)叠加 → **本项目最薄的两环是「中文域」×「开放题型」的交叉格,那里既无正向 r 值、又有 ZPD-SCA 的负面信号。**

---

## 承重文献清单(本轮独立核验,真实性/venue/评审/引用)

**foundation §7.3/§8 已引、本轮逐字坐实**:
- Razavi & Powers 2025,arXiv:2504.08804,feature-based 树集成 **r=0.87** / N=5170 / K-5 math+reading — 预印本,**H1 正确**
- Kapoor et al. 2025,arXiv:2502.20663,penalized regression **r=0.77** / reading comp — 预印本,**确非 0.87/随机森林,H1 区分正确**
- Acquaye et al. 2026,arXiv:2601.09953,ensemble **r=0.75/0.76/0.82** — 预印本,承重归属正确
- Scarlatos et al. SMART,arXiv:2507.05129 = **EMNLP 2025 main(CORE-A,正式发表)** — H2 正确
- Hoyl 2026,arXiv:2602.00034,**NN+IRT r≈0.78** unseen items — 预印本·单作者,L3 正确

**本轮新增承重(foundation 未引,建议补入)**:
- **Wauters, Desmet, Van Den Noortgate 2012,C&E 58:1183-1193,DOI 10.1016/j.compedu.2011.11.020** — 期刊·同行评审·Q1 — **两段式(judgment/alternative 估当 Bayesian prior + 作答校准)的奠基出处**,EDM 2011 best-paper nominee
- **Sharpnack…von Davier 2024,AutoIRT/BanditCAT,arXiv:2410.21033** — 预印本但 Duolingo 生产系统 — **feature-based 先验 + Bayesian 作答 refine 两段式的工业级实例**
- **Peters, Zhang, Jiao, Li, Zhou, Lissitz 2025,arXiv:2509.23486** — 预印本·系统综述 — 37 研究 r 最高 0.87,**abstract 无中文域 → 坐实 G2**
- **Dong, Sun, …, Mo 2024/2025,ZPD-SCA,arXiv:2508.14377** — 预印本 — **中文 K12 LLM 难度标定直接负面证据**(Qwen-max/GLM 低于随机猜测),把 §7.3 G2 从「零直证」改写为「有直证且偏负面」

---

## 给 foundation / B1 的修补点(均为内联订正,非新 feature)

1. **§7.3 G2 升级**:把「对中文 K12 零直证」改为「有直证且偏负面(ZPD-SCA 2508.14377:Qwen-max/GLM zero-shot 评中文 K12 认知难度低于随机猜测,有系统性方向偏差)」—— 缺口严重度从「未验证」升到「已知偏差,需 in-context 校正 + owner 残差兜底」。
2. **§5.3 两段式补源**:把「先验锚 + 作答慢校准」的文献根据从「PPI 一个点」扩到「Wauters 2012(C&E,奠基期刊源)+ AutoIRT 2024(Duolingo 工业实例)」—— 两段式不是本项目独创,是已发表+已生产的标准范式。
3. **§7.3 综述背书**:把 Peters et al. 2025(2509.23486)加为 §7.3 表头的上位综述背书(r 范围、37 研究),同时引它「abstract 无中文域」坐实 G2。
4. **n=1 角色定性可强化**:可在 §3/§4.5 显式写一句「feature-based b 是唯一让 b 的信息源(题面)与 θ 的信息源(作答)正交、从而结构上不可能与 θ 混淆的 b 估计路径,是 n=1 数据驱动 b 的最稳形态」—— 这是本轮核验对 foundation 现有论证的正向补强。

**Linear**:本任务为文献核验,无代码/schema 改动。两个 external validity 缺口(G1 开放题型零文献、G2 中文 K12 现升级为偏负面直证)建议作为 comment 追加到既有 B1 / YUK-203 P3 calibration 子 issue,不新建独立 issue。

Sources: arxiv.org/abs/2504.08804, arxiv.org/abs/2502.20663, arxiv.org/abs/2601.09953, arxiv.org/abs/2507.05129, arxiv.org/abs/2602.00034, arxiv.org/abs/2509.23486, arxiv.org/abs/2508.14377, arxiv.org/abs/2410.21033, lirias.kuleuven.be/108844, sciencedirect.com S0360131511003058


## §E PPI recalibration（LLM 预测 + owner 真值去偏 b）


坐实完成。「PPI rectifier 是 control variate 的 analog」是文献界明确公认表述，FAB-PPI (arXiv:2502.02363) 是 PPI 频率派/贝叶斯桥的承重文献——正好回答 owner「PPI 是 shrinkage 频率派对应」的统一问题。材料齐备，可以裁决。

---

# PPI 纠 b 数学 + 三路线关系裁决 + 启动时机 + 承重文献

研究对象：foundation §5.2 阶段③「fixed-anchor + PPI」的「数据驱动 b」路线——LLM 预测 b 当 prediction、owner 客观题真值当 rectifier。当前文档（§5.3）只把 PPI 当「合成≥真值的 CI 收窄工具」，对 owner 四问只触及表层。以下是逐字核到原文后的深层裁决。

---

## 1. PPI 纠的是 b 的系统偏差吗？纠偏后 b 是「数据驱动」合法实例吗？——是，但要分清「纠的对象」

### PPI 均值估计的精确数学（逐字核到，arXiv:2301.09633 ar5iv 全文）

设要估的目标参数 θ* = E[Y]（Y = 真值难度）。有大量「模型预测」f(X)（= LLM 预测 b）和少量「金标真值」(X,Y)。PPI 点估计：

```
θ̂^PP = (1/N) Σ_unlabeled f(X̃_i)  −  (1/n) Σ_labeled ( f(X_i) − Y_i )
            └── 全用模型预测的均值 ──┘     └────── rectifier Δ ──────┘
```

rectifier 定义逐字核到：**`Δ = E[f(X_i) − Y_i]`**。CI 逐字核到：`θ̂^PP ± 1.96·√(σ̂²_{f−Y}/n + σ̂²_f/N)`。

**关键：rectifier 纠的正是「模型预测 f 相对真值 Y 的系统性均值偏差」**。`E[f−Y]` 就是 LLM 难度估计的平均高估/低估量。这逐字对口 owner 配置——「LLM 预测 b 当 prediction、owner 客观题真值当 rectifier 纠偏 b」在数学上**精确成立**，不是类比。

### 但有一个 owner 四问没点破、文档 §5.3 也没区分的承重细节

PPI 的标准形态纠的是 **难度群体均值 / 难度分布泛函**（E[Y]、分位数、回归系数），**不是逐题 b_j 的单点去偏**。这对 owner 的接缝至关重要：

- **「难度均值/分布去偏」形态**（PPI 闭式直接适用）：纠的是「LLM 这批题整体偏高了 0.3 logit」这类**系统性平移/标尺偏差** → ✅ rectifier 闭式直接给。
- **「逐题 b_j 单点去偏」**：要的是每道题各自的真 b_j。这**不是基础 PPI 解决的问题**——单题在 n=1 下只有个位数作答，PPI 的 rectifier 是对「一批已标真值题」求均值，给的是**整体校正**而非**逐题校正**。逐题要么退回 §3 的 fixed-anchor 单题反推（CI 宽），要么靠 PPI 校准后的「整体偏差函数」对未标题做平移。

**裁决**：纠偏后 b 是合法的「数据驱动 b」实例 —— 但合法的精确范围是 **「数据驱动地校准 LLM-先验 b 的系统偏差（标尺/平移层）」，不是「数据驱动地逐题估 b」**。文档 §5.3 现写「PPI 构造的区间同时统计有效+更窄」是对的，但应补一句：PPI 在此**首要身份是给 LLM-锚的难度标尺做数据驱动的偏差校正（debias the anchor scale），其次才是 CI 收窄**。这把阶段③从「合成数据收窄 CI」提升为「锚质量本身被 owner 真值校准」——直接补强 §7.4 G3「锚来源传导性缺口」（锚的系统偏差现在可被 owner 客观题持续 rectify，硬轨地基不再纯软）。

---

## 2. PPI-anchored recalibration vs shrinkage vs state-space：同一件事还是三个模型？——三个**真不同**的数学对象，但 PPI 与 shrinkage 在「方差缩减」目标上有精确频率派/贝叶斯对偶

这是 owner 最深的一问。逐字核到的结论：**不能笼统说「同一件事不同视角」，要分两层拆**。

### 三者各自的数学身份（先证它们真不同）

| 路线 | 数学对象 | 纠 b 的机制 | 需要什么 |
|---|---|---|---|
| **PPI-anchored recalibration** | **control variate / AIPW 半参数估计** | 用 owner 真值对 LLM-预测难度做**无偏去偏**（rectifier = 系统偏差），保持频率派覆盖有效性 | 少量金标真值 + 大量模型预测 |
| **Shrinkage（James-Stein / 经验贝叶斯）** | **有偏但低 MSE 的收缩估计** | 把单题噪声 b̂_j **朝群体均值/先验收缩**，用偏差换方差 | 一批同质题的横截面（borrow strength across items） |
| **State-space（DIR / 动态 IRT）** | **隐状态随时间演化的滤波** | b_t = b_{t-1} + 过程噪声；Kalman/粒子滤波**在线追 b 的时间漂移** | b 真随时间变（item drift），且有时序观测 |

**它们解的是三个不同问题**：
- PPI 解「**预测有偏，怎么用真值无偏地修，且不丢频率派有效性**」;
- shrinkage 解「**单题数据太少估不准，怎么借群体信息降 MSE**」（n=1 逐题 b 的稀疏正是这个病）;
- state-space 解「**b 本身在漂移，怎么在线追**」（owner 场景下 b 基本静态——题目难度不随时间变，**state-space 是给 θ（能力会涨）用的，不是给 b 用的**）。

### 但 PPI ≈ shrinkage 的频率派对应吗？——**精确成立，且有奠基文献**

逐字核到三块：

1. **「PPI 的 rectifier 是 control variate 的 analog」是文献界公认表述**（核到多源直引："PPI performs inference on a so-called rectifier, an analog of a control variate or debiasing term"）。control variate 是经典**方差缩减**技术——与 shrinkage **目标同构（都降方差）但路径不同**：control variate 保持**无偏**降方差，shrinkage 引入**偏差**降 MSE。

2. **PPI 达到半参数效率下界**（arXiv:2606.08730「Statistical Optimality of PPI」逐字核到）："PPI can attain the semiparametric efficiency lower bound when the predictor is **score-calibrated**, that is, when the predictor's output aligns with the true conditional expectation of the estimating function." → PPI 是 **AIPW / efficient influence function** 家族的实例，这是频率派半参数效率理论，不是贝叶斯收缩。

3. **PPI 与 shrinkage 的桥有专文**：FAB-PPI（arXiv:2502.02363,「Frequentist, Assisted by Bayes, PPI」）正是把贝叶斯先验信息注入 PPI 的频率派框架——证明二者**可统一但不等同**：PPI 是频率派骨架，shrinkage/贝叶斯先验可作为它的「assistance」层，但有效性保证始终是频率派的。

**裁决（回答 owner「PPI 是 shrinkage 的频率派对应？」）**：

> **不是简单对应，是「目标同构（方差缩减）、机制对偶（无偏控制变量 vs 有偏收缩）、可统一不可等同」。** PPI 是 control-variate/AIPW 的频率派实例，shrinkage 是经验贝叶斯实例。二者在「降方差」上殊途同归，但 PPI 守无偏 + 频率派覆盖，shrinkage 用偏差换 MSE。PPI++ 的 power-tuning λ（见下）是把这条对偶**显式参数化**的接口——λ 调到 0 = 纯频率派 only-labeled，λ=1 = 标准 PPI，最优 λ* 由协方差比定（这正是 control-variate 的最优系数公式）。state-space 是**正交的第三件事**（追时间漂移），在 owner b-静态场景下**不该用于 b**，只该用于 θ。

**对 owner 配置的直接含义**：三路线**不能合并成一个估计器**，但有清晰分工 —— **b 用 PPI（去偏 LLM 锚标尺）+ 可选 shrinkage（逐题 b̂ 朝 KC 均值收缩降 MSE）；θ 用 state-space/Elo（追能力上涨）**。这正好是 owner 第4问「theta 快 b 慢」接缝的数学根据（见下）。

### PPI++ power-tuning（owner 该用的实际形态，逐字核到 arXiv:2311.01453）

```
θ̂^λ = argmin_θ [ L_n(θ) + λ·( L̃_N^f(θ) − L_n^f(θ) ) ]
```

逐字核到："recovers PPI when λ=1 and reduces to classical inference, ignoring the predictions, when λ=0"；"power tuning is essentially never worse than either classical or prediction-powered inference"。最优 λ* 由协方差比最小化渐近方差。**这是 owner 该落地的形态，不是原始 PPI**——因为它**自动适配 LLM 锚质量**：LLM 预测烂（与真值低相关）→ λ*→0 → 自动退回只信 owner 真值，绝不被烂先验拖累。这把 §7.3「LLM 标定数字英文域、零直证」的风险**数学上兜底了**：迁移失效时 λ* 自动归零。

---

## 3. owner 锚题 active-learning 选取（非 i.i.d.）对 b 纠偏的影响——基础 PPI 在此**失效**，必须换 active/cross 变体

这是 owner 第3问，也是文档 §5.3 已自标「⚠️ 诚实边界」但**没给解法**的缺口。逐字核到的结论很硬：

### 基础 PPI 的 i.i.d. 前提（逐字核到 2301.09633）

"(X,Y) and (X̃,Ỹ) are **independently and identically distributed** samples from a common distribution ℙ"。原文**完全没有 active learning / 加权采样讨论**（逐字核到："The paper contains no discussion of active learning or weighted sampling strategies")。

**owner 的锚题是 active learning 选的**（MFI p≈0.5 / 先验分歧最大，文档 §5.3 末已述）—— 这**违反 PPI 的 i.i.d. 前提**。直接套基础 PPI 的 rectifier `(1/n)Σ(f−Y)` 会**有偏**：被选标的题系统性偏向「模型不确定/中等难度」区，rectifier 的均值不再是总体 E[f−Y]。

### 解法：Active Statistical Inference（Zrnic & Candès, ICML 2024，arXiv:2403.03208，逐字核到）

这篇**正面解决** owner 的问题，是本次最关键的新增承重文献。它把 PPI 推广到「主动选最该标的点」的非 i.i.d. 设定，用 **Horvitz-Thompson 逆概率加权（IPW）** 校正采样偏置：

```
θ̂ = θ̂_L + (1/n) Σ [ Y_i − m̂(x_i) ] / π_i
```

其中 π_i = 点 i 被选中标注的概率，rectifier 每项**除以 π_i**。逐字核到三点：
- 最优采样规则：**π_i 正比于预测误差量级**（"Sampling probabilities should be proportional to estimated prediction error magnitude"）—— 即「模型最不确定处优先标」，**恰是 owner MFI p≈0.5 选题的同构准则**;
- "Active inference achieves the same level of accuracy with far fewer samples"——主动选样 + IPW 校正比 i.i.d. 标注**更省真值、CI 更窄**;
- 校正后仍**统计有效**（无偏 + 正确覆盖）。

**裁决（回答 owner 第3问）**：owner active-learning 选锚**不是 PPI 的 bug，是 feature**——但必须用 **active-PPI 的 IPW-加权 rectifier（每项 ÷π_i），不能用基础 PPI 的均值 rectifier**。owner 选题时**记录每题的选中概率 π_i**（MFI/分歧分数归一化即得），rectifier 按 1/π_i 加权。这样既享 active learning 的省真值红利，又保去偏无偏性。**文档 §5.3 的「⚠️ 诚实边界」应从「落地细节，非否决项」升级为「明确指定 active-PPI（Zrnic & Candès 2024）的 IPW 加权形态 + 持久化 π_i」**——否则 owner 真实施基础 PPI 会引入系统偏差，反而把锚标尺校歪。

### 附加：Cross-PPI 解决「锚源自 LLM 预测本身」的循环（PNAS 2024）

owner 配置里「锚 b 来自 LLM 先验」存在一个隐患：LLM 既产 prediction 又（间接）参与锚定义，有 label-reuse / 过拟合风险。**Cross-PPI（Zrnic & Candès, PNAS 2024, arXiv:2309.16598，逐字核到）** 正是解这个——用 **K-fold cross-fitting**（K=5/10）让「用模型自身预测做 PPI、无需独立金标模型」仍保有效性。owner 若让 LLM 同时充当预测器和锚先验，应叠加 cross-fitting。

---

## 4. b 的数据驱动校准在第几阶段启动、用哪条路线、与 θ 在线更新怎么解耦——阶段③启动，三轴时间常数解耦

### 启动时机裁决

文档 §5.2 已把「fixed-anchor 纠偏 + PPI」放在**阶段③**，这是对的，逐字确认理由：

- **阶段①（纯 LLM 先验）**：owner 真值 = 0，rectifier 无数据可算 → PPI **不能启动**（rectifier 需要少量金标）。此阶段 b = LLM 先验硬钉，**全软轨**。
- **阶段②（Elo 追 θ）**：开始攒 owner 客观题真值，但量仍稀 + θ 还在剧烈收敛。此阶段**只追 θ，b 仍锁外部锚**（§5.3 G4 已证：n=1 下 item 在线更新失效，b 必须锁）。**PPI 不启动**——真值太少，rectifier 方差爆炸。
- **阶段③启动 PPI**：owner 客观题真值攒到**最小批量**（active-PPI 下因 IPW 省样,门槛比 i.i.d. 低，但仍需 ~数十题级有真值），θ 已大致稳。此时启动 **active-PPI（IPW-加权 rectifier）对 LLM-锚难度标尺做数据驱动去偏**。这是 b 从「纯软轨先验」迁入「硬轨数据校准」的精确节点。
- **阶段④**：b 校准延伸到开放题外推——但这是 §7.2 G1 的零文献缺口，PPI 在此**无法兜底**（开放题真值非客观闭环，rectifier 的 Y 不干净），应保持 propose-only。

**裁决**：b 的数据驱动校准**应在阶段③启动，用 active-PPI（IPW rectifier）+ PPI++ power-tuning（λ* 自适配锚质量）路线**，可选叠加逐题 shrinkage 降 MSE + cross-fitting 防锚循环。**不用 state-space**（b 静态）。

### θ 快、b 慢的接缝数学根据（三时间常数解耦）

owner 第4问的接缝，本质是**三个量的时间常数差**，三路线分工正好对齐：

| 量 | 变化速率 | 路线 | 时间常数 | 数学理由 |
|---|---|---|---|---|
| **θ（能力）** | 快（每次作答都可能涨） | Elo/Urnings 在线更新（state-space 族） | **O(1) 每作答** | θ 是个体参数，会因学习真实漂移 → 必须快追（§5.3 Klinkenberg/Pelánek 强实证） |
| **b（题难度）** | 慢/静态 | active-PPI 批量去偏 + fixed-anchor | **批量/周期性** | b 不随 owner 学习变；只需周期性用累积真值 rectify LLM 锚的系统偏差 |
| **R（记忆）** | 中（FSRS 管） | ts-fsrs | 独立轴 | §4.4 正交红线，不碰 b/θ |

**解耦的数学保证（关键，回答接缝）**：θ 在线更新（Elo）**必须在 b 锁定的标尺上跑**——Elo 追 θ 时 b 当**固定锚**（§5.3 G4 已证 n=1 下 item-更新半边必锁）。而 PPI 去偏 b 是**离线/批量**对锚标尺的周期性修正。二者解耦的形式条件：

> **b 的 PPI 校准频率 ≪ θ 的 Elo 更新频率**（时间尺度分离）。每次 θ 更新视 b 为常数；每隔一批真值，PPI 批量更新 b 标尺，然后 θ 在新标尺上继续快追。这是标准的**两时间尺度随机逼近（two-timescale stochastic approximation）**结构——慢变量（b）对快变量（θ）呈准静态，快变量对慢变量已收敛。**只要 b 更新够慢，θ 的 Elo 收敛性不被破坏。**

**裁决**：θ 快 b 慢的接缝 = **两时间尺度分离**。θ 走 Elo（快、在线、视 b 为锚）；b 走 active-PPI（慢、批量、周期 rectify 锚标尺）；每次 PPI 更新 b 后，θ 的标尺需做一次 linking 重对齐（Kolen & Brennan）。**绝不可让 θ 和 b 同频在线互估**——那会在 n=1 下撞 §3 的联合不可识别墙（JMLE incidental parameters）。文档 §5.3 G4「只用 Elo θ-更新半边、item-更新锁外部锚」+ 本裁决的「b 由 active-PPI 离线慢校准」合起来，就是接缝的完整数学。

---

## 承重文献（真实性 / venue / 评审 / 引用）

逐字核验后的新增 + 既有承重源，按对本研究问题的承重度排：

| # | 文献 | venue / 评审 | 对本问题承重点 | 强弱 |
|---|---|---|---|---|
| **P1** | **Angelopoulos, Bates, Fannjiang, Jordan, Zrnic. Prediction-Powered Inference.** arXiv:2301.09633 / **Science 382:669-674 (2023)**, DOI 10.1126/science.adi6000 | **Science，同行评审**，引用数百 | rectifier=E[f−Y] 闭式、i.i.d. 前提、CI 构造——**逐字核到** | **强**（已在文档 §8 #3） |
| **P2** | **Zrnic & Candès. Active Statistical Inference.** arXiv:2403.03208 / **ICML 2024**（PMLR v235） | **ICML，CORE-A**，同行评审 | **owner active-learning 选锚的直接解**：IPW-加权 rectifier（÷π_i）、π_i∝预测误差=MFI 同构、更省真值——**逐字核到** | **强（本次最关键新增，文档缺）** |
| **P3** | **Angelopoulos, Duchi, Zrnic. PPI++: Efficient Prediction-Powered Inference.** arXiv:2311.01453 | arXiv 预印本（作者权威极高，被广泛引用/已成事实标准） | **power-tuning λ**：λ=0 退经典、λ=1=PPI、never worse、λ* 协方差比——**逐字核到**；自适配 LLM 锚质量 | **中-强**（预印本但权威，owner 实际该用的形态） |
| **P4** | **Zrnic & Candès. Cross-Prediction-Powered Inference.** arXiv:2309.16598 / **PNAS 121(15):e2322083121 (2024)** | **PNAS，同行评审** | **锚源自 LLM 预测本身的 label-reuse 解**：K-fold cross-fitting——确认 | **强**（解 owner 锚循环隐患） |
| **P5** | **Ji, et al.(待补全作者). Statistical Optimality of Prediction-Powered Inference.** arXiv:2606.08730 (2026) | arXiv 预印本（新） | **PPI 达半参数效率下界 + score-calibration 条件**——摘要逐字核到 | **中（弱地基，预印本·2026）** —— 只取「PPI∈AIPW/EIF 半参数家族」定性,不取具体数字 |
| **P6** | **Kilian, et al. FAB-PPI: Frequentist, Assisted by Bayes, PPI.** arXiv:2502.02363 (2025) | arXiv 预印本 | **PPI（频率派）与贝叶斯先验/shrinkage 的统一桥**——确认存在 | **弱地基**（预印本），仅作「可统一不等同」的旁证，不作净结论承重 |
| **P7** | **Kolen & Brennan. Test Equating, Scaling, and Linking.** Springer 专著 2004/2014 | 教材权威 | b 标尺 PPI 更新后 θ 的 linking 重对齐 | **强**（文档 §8 #8） |
| **P8** | **Wang, Berger & Burdick. Dynamic Item Response (DIR) state-space models** (2013, Springer chapter) + **van der Linden & Ren. Optimal Bayesian adaptive design for test-item calibration.** Psychometrika (2014) | 同行评审 / Q1 | **state-space 路线的身份界定**：证明它解的是「b/θ 时间漂移」——据此裁决 owner b-静态场景**不该对 b 用 state-space** | **中**（界定用，非 owner 主路线；划界承重） |

**控制变量/shrinkage 关系的旁证**（非净结论承重，仅支撑「PPI≈control variate=方差缩减、与 James-Stein shrinkage 目标同构机制对偶」的裁决）：Efron 的 empirical-Bayes/James-Stein 经典（Large-Scale Inference, Cambridge）+ 「rectifier is an analog of a control variate」的文献界公认表述（多源逐字核到）。

---

## 给 owner 的净落点（对 §5.2/§5.3 的修补建议，均为内联订正非新 feature）

1. **§5.3 PPI 段**：补明 PPI 在阶段③的**首要身份是数据驱动去偏 LLM-锚的难度标尺（debias the anchor scale），CI 收窄是副产品**；纠的是**系统偏差/标尺层，不是逐题 b**。
2. **§5.3「⚠️诚实边界」升级**：从「落地细节非否决项」→ 明确指定 **active-PPI（Zrnic & Candès, ICML 2024）的 IPW-加权 rectifier（每项÷π_i）+ 持久化每题 π_i**。这是必须项，否则 active-learning 选锚会让基础 PPI 有偏。
3. **落地用 PPI++ power-tuning（λ*），非原始 PPI**——λ* 自动适配 LLM 锚质量，数学兜底 §7.3 的英文域/零直证迁移风险（迁移失效 → λ*→0 → 自动退回只信 owner 真值）。
4. **若 LLM 同时充当预测器和锚先验，叠加 Cross-PPI 的 K-fold cross-fitting**（PNAS 2024）防 label-reuse。
5. **三路线分工写进 ADR**：b 用 active-PPI(+可选 shrinkage 降逐题 MSE)；θ 用 Elo/state-space；R 用 FSRS。**三者不可合并成一个估计器，state-space 不用于静态 b。**
6. **θ 快 b 慢接缝 = 两时间尺度随机逼近**：b 的 PPI 校准频率 ≪ θ 的 Elo 频率；每次 PPI 更新 b 后 θ 标尺做一次 Kolen-Brennan linking 重对齐；**禁止 θ/b 同频在线互估**（撞 JMLE incidental-parameters 墙）。

**Linear**：本任务为文献核查/裁决，无代码/schema 改动。两个 actionable 缺口建议作为 comment 追加到既有 B1 issue（YUK-203 P3 或 calibration 子 issue），不新建：(a) active-PPI IPW-加权 rectifier + π_i 持久化（当前文档只标「诚实边界」未给解法，是实施层硬缺口）；(b) PPI++ power-tuning 作为 LLM-锚质量自适配兜底机制写进 calibration spec。无需新建独立 Linear issue。

**相关文件（绝对路径）**：
- 待修补对象：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-b1-diagnostic-engines-foundation.md`（§5.2 第 204-209 行四阶段表、§5.3 第 211-223 行 PPI/Elo/Urnings 承重出处、§7.4 第 286-288 行锚源传导缺口）