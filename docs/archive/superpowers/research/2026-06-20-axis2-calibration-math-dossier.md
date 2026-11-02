# Axis-2 校准机制 数学/文献研究档案（A1–A12, B1）

> 2026-06-20。11 个心理测量学/贝叶斯统计专家对 axis-2（学习者全面档案 n=1 firm-up）9 个 lit/data-dependent 提案的 advance review。**impl 由 bottom-up hold——这是提前研究 pre-work,不是 impl 放行。** 来源 workflow wr818y8l2。

## Headline
0 拒绝。8/9 = SOUND-WITH-CHANGES,1（A3）= SOUND-WITH-CHANGES 且最低风险/first-mover。**数学几乎全 settled;n=1 迁移几乎全 by-analogy。3 个数值/引用 claim 事实错误,docs ship 前必改。**

## 1. 可交付真理 vs 待验证假设

### (a) 数学 settled / 文献真支持
- **A1**: `S=(2x−1)(d−t)` 是 θ 充分统计量;accuracy 边际正是 2PL。Maris & van der Maas 2012 *Psychometrika*（字面定理）。
- **A2**: 加性两层 SGD `σ((θ_g+θ_KC)−d)`,inherit-then-differentiate shrinkage。Nižnan/Pelánek/Řihák EDM 2015（真源）。
- **A3**: MFI 对 1PL 渐近最优（定理,Chang&Ying 2009 AoS);解锁 a/c 破坏一致性（反例定理）→ locked-b 正确。顶刊。
- **A4**: 离散网格 1-D 序贯贝叶斯后验**精确**（非近似);b-locked → 无可识别问题;grid ⊇ Elo 信息。
- **A5**: L 必须无向/对称/PSD → 只 related_to 入平滑;**contrasts_with 绝不入平滑**（最锐的对）。Borovitskiy AISTATS 2021。
- **A8**: a_k 是 cohort 量,n=1 估不了 → 用预标注 key 绕墙;misconception 当一等节点合法。Bock 1972 + Bradshaw&Templin 2014 *Psychometrika*。
- **A9**: PFA logistic;5-run 多数投票降错（e≈0.2→0.06);**禁 per-item θ-slope（=隐藏区分度）正确且 n=1-appropriate**。
- **A12**: per-item 高斯-高斯共轭 shrinkage;σ²=residual-weight 单调;per-item σ² 确比 global-λ 升级。
- **B1**: AIPW Hájek **÷N（非 ÷n_labeled）**正确;positivity+真随机采样是硬前置;PPI++ λ-tuning 给「≥ classical」保证;family shrinkage=partial pooling（n=1 有效）。

### (b) By-analogy / 需 owner 数据验证 / speculative
- **A1**: 连续-S→二值投影（YUK-449/450）= 2026 active research（Gergely 2026 JEDM）,**未 settled**,丢了证明 RT 的信息增益。
- **A1/A2/A4**: Elo 当载体——variance-inflation（J.Intelligence 2020）+ 无 SE,强自适应下有偏。
- **A2**: 「per-concept↔global 相关 ~0.6」**事实错误**——文献 −0.1~0.5（EDM 2015）,且逻辑反了（相关越低增益越大）。
- **A5**: 「Thm 1 保证更准 mastery」——只证**方差**降（near-trivial）**非 MSE**;裸 `exp(−½λθᵀLθ)` prior **improper**（level 不可识别）。
- **A8/A9/A12**: 朴素 Bernoulli /「3-6× 证据乘子」当**独立**观测——**证据膨胀**:item 内步骤相关,「×」是名义非有效信息。需误分类感知似然 + 设计效应折扣。
- **A9**: PPI label-reliability 加权 + 70-80% 一致跨科迁移——是超出 Chen&Wan(triage 用途)的外推;70-80% 是单论文单科(intro physics, n≈100)。
- **A12**: 「ADR-0043 离散 b_calib 闸的 REVISION」**架构错误**——ADR-0043 已否决「单答 firm-up」且指定 PPI(非 shrinkage)为承重;AutoElicit/BERT-IRT 的「small N」是 cohort-per-item 非 n=1。
- **B1**: Kolen-Brennan re-linking 误名(需两总体,n=1 没有);Stocking 1990 是支持证据非 n=1 定理。

### 引用卫生(blunt)
- **A2(最差)**: 核心公式**误归属**(引的两 Pelánek 论文不含该公式;真源 EDM 2015/2019 未引)+ 事实错 0.6。
- **A5**: GPG Thm 1 只在 arXiv preprint,不在同行评审 ICASSP 4-pager → 不能当 settled 引;IEEE TSIPN 是裸引用(无题/作者/年)= 填充,无效。
- **A4**: BanditCAT workshop-tier(PMLR 264, ~2 引)非 settled 权威;且它是 Thompson sampling 非 MFI-argmax,别让它背书 plain MFI(那是 Birnbaum 1968)。
- **A12**: AutoElicit「~55%」非 headline 数(单 ablation 点);BERT-IRT workshop/industrial,「small N」=cohort-per-item。
- **A9**: 「Chen et al.」应作「Chen & Wan」(两作者);confidence 度量是归一化 Shannon 熵非 between-run 方差。
- **B1**: **active-PPI 真正载体论文(Zrnic & Candès 2024 ICML oral)从引用列表 MISSING** → 整个 π_i/ξ_i 机制无引用 → active-PPI 有效性证明**悬置**。(注:B1/active-PPI 已 ship YUK-361!)
- **干净**: A1, A3, A8(A3 最干净)。

## 2. Per-item 一行裁决
| Ref | Item | Verdict | 最重要 caveat |
|---|---|---|---|
| YUK-433 | A1 SRT | SOUND-WITH-CHANGES | 连续-S→二值(YUK-449/450)2026-frontier 未 settled;RT 不驱动 θ 直到 V-A1-fwd 闸(ΔAUC>0.02 CI 排 0)过;否则 SRT 只读诊断 |
| YUK-434 | A2 分层 Elo | SOUND-WITH-CHANGES | 两 ship-blocker:误归属公式 + 事实错 0.6;实现成带方差贝叶斯 shrinkage 非裸 Elo;γ<1 必须 |
| YUK-435 | A3 MFI+KL/KLP | SOUND-WITH-CHANGES(最低风险) | 最干净;n=1-native;目标是「防早期误锚」非「证加速」;KL-direction 单测不可省 |
| YUK-436 | A4 离散网格贝叶斯 | SOUND-WITH-CHANGES | trust-gate 用**后验方差**非 Fisher/CRLB SE;真瓶颈是 locked-b **源**正确性非估计器 |
| YUK-441 | A5 图-Laplacian prior | SOUND-WITH-CHANGES | improper prior **必须**升级成 proper GMRF `N(μ₀,(λL+κI)⁻¹)`;Thm 1 只证方差↓;ship 成软层(只移后验均值不缩方差)直到 leave-one-KC GO |
| YUK-437 | A8 distractor→misconception | SOUND-WITH-CHANGES | 最佳 n=1 拟合;裸 Beta-Bernoulli → 误分类感知;P(M) 降成 ordinal trigger 非校准概率 |
| YUK-438 | A9 step-grade PFA(3-6×) | SOUND-WITH-CHANGES | 「3-6×」名义非有效——step 相关→证据膨胀;必须设计效应折扣/per-item 证据 cap;shadow 直到 Cohen's κ≥0.6 |
| YUK-439 | A12 LLM prior shrinkage | SOUND-WITH-CHANGES(≈sound-only-if-reframed) | **非 ADR-0043 修订——它就是 ADR-0043 已指定的可选 prior 层;PPI 仍承重**;更新单元=family-level b_delta 非 per-item;σ² 真活是 PPI/MEPV 标注优先非在线 b 回写 |
| YUK-361 | B1 校准载体 | SOUND-WITH-CHANGES | 补缺失 Zrnic&Candès 2024 引(否则 active-PPI 证明悬置);强制 PPI++ λ-tuning;标注 UI 必须概率推题+记 π_i(positivity 红线) |

## 3. Owner-data 验证 backlog
### Tier 0(先跑,解锁多项)
- **G-bSource(基石)**: locked-b 校准敏感性——注 ±0.5 logit 扰动测 mastery-rank Spearman;>0.8 → b 源可信,否则**修 b 源再 ship A3/A4/A12/B1**。解锁 A3/A4/A12/B1。
- **G-PPIsample**: 标注 UI positivity 审计——π_i ∈(0,1) 有真方差(非确定性 top-k),否则 AIPW 无偏性作废。解锁 A9/A12/B1。
- **G-τ²**: family-shrinkage 经验贝叶斯——partial vs full vs no pooling 三曲线;partial 严格胜两端 → family partition 对。
### Tier 1（per-item ship 闸,~12 个）
V-A1-fwd（**全档案最重要闸**:forward AUC,RT 才入 θ）· V-A1-caution · V-A2-sep · V-A2-mastery · V-A3-replay · V-A4-ECE（ECE≤0.10）· V-A5-LOKO · V-A8-key（precision≥0.7,且 1−precision=经验 ε）· V-A9-kappa（κ≥0.6 才碰 mastery）· V-A9-ICC（ρ>0.3 必开折扣）· V-A12-σcal · V-A12-θpoll · V-B1-replay（载体决策主闸）。
### Cross-cutting
**证据膨胀审计**:任何「多观测映同一 node/KC/family」必先去重或建簇内相关——同一失效模式在 A8/A9/A12/B1 复现。**一个共享 design-effect/effective-N 工具。**

## 4. 依赖 + 推荐 axis-2 序
```
G-bSource ──gates──► A3, A4, A12, B1   (b 是共享底座,错 b → 下游全自信地错)
   ▼
B1 载体决策(Elo+PPI++ vs Urnings; family shrinkage; π_i)  [V-B1-replay 主闸]
   ├──► A12(必复用 B1 的 AIPW 归一 + family-level b_delta——A12 是 B1 的层非独立)
   ├──► A4(后验-SE 仅 b 源+校准验证后可信)
   └──► A1(RT→θ 仅载体存在后)
judge-calibration(V-A9-kappa κ≥0.6) ──gates──► A9 上线(镜像 #522 A9 owner-data call)
共享机器(建一次): effective-N 折扣 → A8/A9/A12/B1; per-item σ² 层 → A1/A12/A2; 后验方差(非 Fisher SE) → A4/B1
```
**需 owner call 的项**:B1 载体(Elo+PPI++ vs Urnings vs 单一层级 state-space,reviewer 强荐 state-space 重述)· A3 KL vs KLP(看冷启 prior 是否真 informative——与「冷启优先」哲学张力)· A1 RT-as-θ(看 V-A1-fwd 数)· A12 scope reframe(接受「这是 ADR-0043 prior 层非闸修订」)· A9 上线(κ≥0.6,#522 同款)。

**推荐序**:
- **Wave 0(无需 owner 数据,可即做)**: 修 3 个事实/引用缺陷(A2 0.6+归属 / B1 缺 Zrnic&Candès / A5 improper→proper GMRF)+ 建共享机器(effective-N / 后验方差 / per-item σ² 层)+ ship **A3**(最低风险 n=1-native,math settled)。
- **Wave 1(瓶颈闸)**: G-bSource + G-PPIsample + G-τ² → V-B1-replay 定载体。A12/A4/A1 等它。
- **Wave 2(载体上的分层)**: A8(首个 live 证据通道,record-only 到 V-A8-key)→ A9(shadow→κ≥0.6 live + 设计效应)→ A12(ADR-0043 prior 层,σ²→标注优先半,零在线回写)→ A4(shadow 量并行 Elo)→ A5(软层 mean-only)。
- **Wave 3(最 speculative,最后)**: A1(SRT+η 信号层,RT→θ 仅 V-A1-fwd 后)+ A2(分层 mastery 重述成贝叶斯 shrinkage)。

## 5. 红线复核（ADR-0035）
**确认:9 项全 hard-track,无软轨→θ̂ 泄漏。** 各项见 workflow 原文。**一个站岗风险(非违例,是护栏)**:A4/A5/A12 都涉「看起来校准好的」不确定性(后验 SE / 图-shrunk 方差 / LLM 自述 σ)。**未校准的 confidence 当校准用 = 软信号伪装成硬。** 每个 reviewer 独立抓到并 gate 了(ECE/LOKO/σ-cal 闸)。**建议加 ADR-0035 corollary**:任何 gate user-visible 或下游-θ 决策的不确定性量,必须过 owner-data 校准闸才当硬用——之前 shadow-only。

## Linear capture
3 个 ship-blocking 修正(A2/B1/A5)+ ~15 验证闸 + 1 个 ADR-0035 corollary。建议作为既有 issue(433/434/441/361 修正;全 9 项验证闸)的 acceptance-criteria 子项,非新 issue(no-fragmentation)。owner 定登记。
