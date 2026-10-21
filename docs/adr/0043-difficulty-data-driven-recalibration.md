# ADR-0043 — n=1 难度数据驱动校准：半数据驱动 b + 两时间尺度 + Elo θ̂ credit 裁决

**Status**: Accepted (2026-06-15)
**Amended by**: §「2026-10-19 Amendment」（YUK-1625，改写 YUK-439 方向）——b 与 θ̂ 改为 **agent 先验锚定的在线联合标定**（每题先验=均值+方差；模型判分作答进标定=掌握更新，非答案判分）。§4 识别性表述与 §备选两条否决的适用范围由该节修订；下文原文保留作历史决策记录，冲突处以该节为准。
**Part of**: YUK-203 · B1 掌握诊断 · ADR-0035（三维 mastery + 四引擎）的 difficulty 维细化 + B1 载体（PR #414）的算法裁决固化。
**Decision source**: owner 2026-06-15 两问（difficulty 要不要更精细乃至数据驱动 / 需要什么数学模型）+ 拍板「θ̂ credit 用 MLE」。承重研究 `docs/design/2026-06-15-difficulty-data-driven-research.md`（6-agent / 420k-token workflow，5 路文献 + 统合，来源逐条核验）+ B1 载体独立 review SF-1。
**Related**: ADR-0035（mastery 三维，difficulty=FSRS D 与 PFA β 同 logit 语义需 linking）· ADR-0042（MFI 调度信号，b 来源 + 本 ADR 揪出 π_i 持久化缺口）· ADR-0028（FSRS *when* 单 writer，三轴正交）· `2026-06-14-b1-diagnostic-engines-foundation.md`（§3 可辨识性矩阵 + §5.3/§7.3/§7.4 经本研究 amend）· deferred recalibration（YUK-361 阶段③）（本 ADR 是其设计前置）。

---

## 背景

B1 载体（PR #414）实现了 difficulty 的连续表示（`item_calibration.b` logit）+ θ̂ 在线 Elo，但留了三个算法决策点 + 一个 owner 战略问：

1. **多 KC 题的 θ̂ credit 公式**（B1 载体 implement 自创了一个有数学病理的公式，独立 review SF-1 抓出）。
2. **K schedule**（核验 refuted 了 1/√n）。
3. **difficulty→logit 弱锚映射**（核验 refuted 了线性当真值）。
4. **owner 战略问**：difficulty 要不要数据驱动以贴合？要的话什么数学模型？

本 ADR 固化这四点的裁决，地基是 420k-token 文献研究（结论无矛盾收敛）。

## 决定

### 1. 多 KC θ̂ credit = 合取模型 MLE 梯度（owner 拍板 MLE，取代自创公式）

多 KC 题产生一个 outcome、多个 θ_k 待更新 = credit assignment。取**合取模型**（conjunctive / DINA 式「需所有 KC 才做对」）`P_item = ∏ σ(θ_j − b)`，credit 用其对数似然梯度：

```
correct (x=1): credit_k = (1 − p_k)
wrong   (x=0): credit_k = −(1 − p_k) · P_item/(1 − P_item)     [量级 clamp ≤ 1]
Δθ_k = K · bWeight · credit_k
```

- **(1−p_k) 灵敏度**：最弱的 KC 双向都动最多——这是 owner 拍的 MLE。
- **n=1 精确退化标准 Elo**：correct→(1−p)=(x−p)，wrong→−p=(x−p)。
- **取代的 SF-1 bug**：自创公式用 per-KC 残差 (outcome−p_k)，净位移 ∝ p_k·(1−p_k) 钟形，两端趋零 → 已诊断为弱的 KC 答错几乎不降（与意图反向）。根因是 blame 权重被乘进 per-KC 残差自我抵消；MLE 用**题目级** surprise × (1−p_k) 灵敏度消除它。
- 已实现于 `src/core/theta.ts` `conjunctiveCredits` + `src/server/mastery/state.ts`（PR #414）。

### 2. K schedule = 有界 K + 冷启高 K（弃 1/√n）

owner 主线是非平稳（在学、θ 上升）。`1/√(evidence_count)` 单调衰减是平稳目标收敛工具，套到上升 θ 产生 downward lag bias（停在过去能力）。改用冷启段 kCold（0.4）+ 稳态 kFloor（0.12，永不衰到 0 保留追上升能力的自由度）。核验 `VERIFY:elo-k-schedule` refuted 1/√n。

### 3. difficulty→logit 弱锚 = 降权占位（弃「线性当真值」）

`question.difficulty`（1-5 序数）→ logit b 的线性映射 `(d−3)×scale` 是占位、非真值（序数当 interval、斜率无标定来源）。caller 标 `source='difficulty_proxy'` + 更新降权 0.3 + 优先 `item_calibration.b`。核验 `VERIFY:difficulty-logit-map` refuted 线性当真值。

### 4. difficulty 数据驱动 = 半数据驱动 b（回答 owner Q1/Q2，deferred recalibration）

**Q1：要数据驱动，但 n=1 下只能「半数据驱动」，且本 wave 不改。**
- n=1 下 b **不能** owner 自证（logit 平移不变 `θ→θ+c, b→b+c` 似然不变；无总体可积 → MMLE 路径定义上不可用；退化为 N=1 校准样本）。
- **能**：外部锚定尺度 + owner 真值去偏。当前 wave（b 锁死 G4 + θ Elo）是**正确的慢热阶段②形态**，不是保守——是识别性的必要条件。
- 「锁 b」精确含义 = 锁**尺度不定性**（外部供给原点+单位、不可 owner 自证），**不是 b 数值永久冻结**——b 可在 PPI 框架内随真值去偏而动。

**Q2：四路线是三件正交事 + 一个搬运器（非同一模型四视角）：**

| 路线 | 数学身份 | 角色 |
|---|---|---|
| feature-based（题面内容预测 b） | explanatory IRT 监督学习 | **锚源**（产 b_anchor，信息源与 θ 正交→绕开识别性墙） |
| shrinkage（经验贝叶斯） | 有偏低 MSE | **逐题先验结构**（可选层；τ 不可估须先验固定） |
| active-PPI + IPW rectifier | control-variate / AIPW 无偏半参数 | **去偏引擎**（校锚标尺，非逐题 b） |
| state-space | 隐状态滤波 | **只用于 θ，b 静态** |

**识别性靠两时间尺度随机逼近**：θ 快（每作答 Elo，视 b 为固定常数，item 半边锁死 G4）/ b 慢（批量 active-PPI，对 θ 准静态）；硬条件 `b 校准频率 ≪ θ 更新频率`；**每次 b 更新后 θ 标尺做一次 Kolen-Brennan linking 重对齐**。b 的信息源完全在单人在线回路之外（锚=题面/外部，去偏=客观题真值）——这是 n=1 尺度分离的结构性切分。**〔2026-10-19 amend〕** item 半边不再锁死：识别性改由每题带方差的 agent 先验承担（先验打破平移不变），b 与 θ̂ 同尺度联合/交替小批估计；「频率 ≪」降格为稳定性工程条件、KB linking 降格为漂移审计——见 §2026-10-19 Amendment A1/A2/A5。

**分阶段**：①纯先验（PPI 不能启动，真值=0）→ ②Elo 追 θ（≈当前 wave，b 锁死）→ ③fixed-anchor + active-PPI（真值攒到 ~数十题级、θ 已稳才启动）→ ④开放题外推（propose-only，无法兜底）。（2026-10-19 amend：③ 形态改为「agent 先验锚定 + 证据从第一条起连续收缩」，见 §2026-10-19 Amendment A3。）

## 后果

**正面**
- θ̂ credit 从有 bug 的自创公式收口到教科书合取 MLE（n=1 退化标准 Elo，弱 KC 真正担责）。
- owner 两问有了文献地基的明确答案：当前 wave 设计正确、b 数据驱动是阶段③ deferred、数学模型四路线分工清晰。
- 三个算法裁决（MLE / K schedule / 弱锚降权）固化，不再只活在设计 doc。

**代价 / 诚实天花板（n=1 结构性，工程救不了）**
- **b 永远不能脱离外部锚成为 owner 自证的量**：最强止于「半数据驱动」，硬轨地基质量 = 锚质量。
- **a/c/slip/guess 结构性不可识别**（需跨考生方差，连锚都救不了）。
- **逐题 b_j 单点 n=1 无法精确定**（PPI 纠分布/标尺层，单题退回 fixed-anchor 反推 CI 宽）。
- **中文阅读/语文 × 开放题交叉格有负面直证**（ZPD-SCA 2025，**只覆盖中文阅读理解**，本项目栈近亲 Qwen/GLM zero-shot 评中文阅读认知难度低于随机猜测）；PPI 无法兜底（开放题真值非客观闭环）→ 该格 propose-only。**数学/理科/客观题格对 ZPD-SCA 仍是「缺直证、未验证」，不按已反证处理。**

**deferred recalibration（YUK-361 阶段③） 设计输入（现在记进 spec，阶段③才实现）**
1. **持久化每锚题选中概率 π_i**（active-PPI 的 IPW rectifier 必需）——当前选题引擎（ADR-0042）设计未存，**实施层硬缺口**。
2. `item_calibration` 未来分离 `b_anchor`（先验）/ `b_calib`（去偏后）+ `(n_i, w_i)` 元数据（现在留注释占位，标 YUK-361 解除）。
3. PPI++ power-tuning λ\* 作锚质量自适配兜底，写进 calibration spec。
4. 两时间尺度分离 + 每次 b 更新后 Kolen-Brennan linking 重对齐。
5. 开放题 / 中文阅读·语文格保持 propose-only，标 ZPD-SCA 负面直证（数学/理科仍缺直证，不按反证处理）。
6. **PPI 真值目标量 = 难度 b，不是判分**（Codex review）：客观题判分是二元对错 + 混 θ/学习漂移，裸当 b 真值会把 b 校成 response-rate/θ 混合残差。必须先用**锚定 θ 的 IRT 反推难度标签**当 PPI 的 `Y`，或另收独立难度真值。
7. **AIPW 均值 rectifier 正确归一化**（Codex review）：`(1/N)Σ_pool m̂ + (1/N)Σ_labeled ξ/π`，**不是**对已标注 ÷n 再 ÷π（均匀抽样下会多乘 N/n 过度校正）。π_i 须是**真随机抽样的 inclusion probability**（满足 positivity），不是确定性 top-item 选题事后归一化分数。

## 实施 sequencing amendment（2026-06-15）

本 ADR 的 deferred 项（π_i 持久化 / b_anchor·b_calib 分离 / active-PPI / 家族 b）落地序由 `docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md`（YUK-361，8 阶段）统一编排，与选题引擎（ADR-0042 编排档2）+ 供给引擎（Phase 8）同栈：
- **观测先行**（Phase 1）：`mastery_state.theta_precision` + `selection_observation`(含 π_i) + `practice_stream_item.signals` 先持久化，零行为变更。
- **π_i 来源 = ADR-0042 编排档2 的 tempered-softmax sampler**（LLM 出权重 → 抽样），这**正是本 ADR §7 要求的「真随机抽样 inclusion probability、非确定性 top-item 事后归一化」**——选题与校准的接缝在此闭合。
- **b_anchor/b_calib 分离 + AIPW**（Phase 6）：用 §7 的正确归一化 `(1/N)Σ_pool m̂ + (1/N)Σ_labeled ξ/π` + PPI++ power-tuning 自降级；Y = 锚定 θ 反推的难度标签（§6，非裸判分）。
- **家族级 b_personalized**（Phase 5，roadmap 新增）：n=1 下逐题 b 不可估，但 `(subject,knowledge,kind,source,feature_bucket)` 家族级 b_delta 在足够重复客观观测后可估（shrinkage 守保守）——这是 §代价「逐题 b_j 单点 n=1 无法精确定」的家族级绕道。
- full Urnings deferred 到离线 replay 决策门（Phase 7），见 `docs/design/2026-06-15-urnings-lite-calibration-amendment.md`。

### b_anchor 来源 — feature-based 锚的 spike 裁决 + 框定纠正（2026-06-15，owner 复核）
spike 报告 `docs/design/2026-06-15-b-anchor-feasibility-spike.md`（5-agent，web 核源 + 对抗 critic）+ owner 复核纠正：
- **baseline 纠正**：当前难度**已是连续 logit b**（`item_calibration.b`），由 **ItemPriorTask 估，`source='llm_prior'`，低置信**；1-5 `question.difficulty` 只是无标定时的兜底 proxy。**且 ItemPriorTask 本身已是 feature-based 方法**（prompt 强制「抽教学特征：认知步骤/前置链/典型错误/题型 → 推 b」，已引「直接打分 r≈0」证据躲最坏失败模式）。故 b_anchor **不是 vs 1-5、不是新东西**——是 ItemPriorTask（LLM **in-context** feature→b）的**训练/校准升级版**（公开 cohort 难度训的 feature→b，带 CI）。新题覆盖论据 moot（ItemPriorTask 已覆盖全题）。
- **裁决**：**仅 scale 锚可行 / 逐题 b 预测不可行（BEA 2024 RMSE 0.29≈dummy 0.31）/ 中文阅读×开放题 propose-only**。**真 blocker = 数据**（无中文全科 item 级 b 标签：ASSISTments 英文数学 b+文本双全但 NC、MOOCCubeX 唯一中文全科但 b 须自派生 + license/题面完整度待 PoC），**非经济性**（owner 拍「无所谓经济性」，故 roadmap Phase 6 不加经济闸，只留数据可行性 PoC）。
- **更轻近路（不需公开数据）**：spike 建模 lane 证 **LLaSA「学生能力模拟」prompt > 直接估**——可把 ItemPriorTask 方法从「feature 分解→b」升级为「模拟不同能力学习者作答→反推 b」，纯 prompt 改、零数据零训练；若日用中 llm_prior b 太噪，先于训练 feature→b 试。
- **承重澄清**：可靠性的承重机制是 **active-PPI（Phase 6 firm-up，用 owner 客观真值校 b）**，不是冷启先验本身。冷启 b（LLM-in-context vs 训练）只在「新题/未答过、该题家族客观标签尚不足」时起作用；**待家族积累足够客观标签 + θ 稳定 + π_i 前置满足后，由批量 active-PPI（Phase 6，用锚定 θ 反推的难度标签做 AIPW/PPI）接管——不是单次作答即 firm-up**（单答即把正确/错误写成校准信号会把 response-rate/θ 漂移混进 b，正是本 ADR §6 要避免的混淆）。优先级：**π_i + active-PPI（firm-up）> 更好的冷启先验**。
- 公开数据按用途细分：拒**行为数据**（他人作答进 owner 回路，n=1 红线）；采**锚训练数据**（他人题面↔b 离线训映射器，产物只是回归权重不进 owner 回路）。

## 概念订正（载入实施）

- **`σ(θ−b)` 误名 `p(L)`**：它是「KC-k 视角的题目答对预测概率」，**不是「掌握 KC k 的概率」**（PFA/BKT 的 p(L) 是另一个量）。下游选题引擎读「mastery」时需清理此误名，避免语义埋坑。
- **b vs a/c 分水岭**：b 是位置参数（可锚可推），a/c/slip/guess 是形状/尾部参数（结构性不可识别）。Stocking 1990 只支撑 a/c 不延伸到 b；b 那行承重是 Kolen-Brennan + incidental-parameters 的 cohort 依赖。

## 2026-10-19 Amendment — agent 先验锚定的 b×θ̂ 在线联合标定（YUK-1625；改写 YUK-439 方向）

**Decision source**：owner 2026-10-19 拍板——**YUK-439 从「A12 LLM 先验→active-PPI 接口」改为「b 与 θ̂ 在线联合标定，由 agent 先验锚定」；模型判分的作答也进入标定；这属于掌握更新，不是答案判分**。本节修订 §4 识别性裁决与 §备选两条否决的适用范围（上文原文保留作 2026-06-15 历史决策记录，冲突处以本节为准）。**本修订只改文档**：不改代码与测试；不改答案判分设计（判分路由、分数语义、更正重放零改动）；不改 agent 产出先验 b 的方式（ItemPriorTask feature→b 照旧）。实施 sequencing 另行排期；落地 PR 按「consumer 迁入、旧开关同 PR 删」的规矩移除 `RECALIBRATION_MIN_LABELS` 硬门控与 `b_calib` 首写语义，`item_calibration`/G4 相关注释随实施对齐。**实施落地：YUK-439**（`difficulty_calibration_evidence` 证据账本 + `item_calibration.b_post/posterior_variance/calibration_source` 后验列 + `src/server/mastery/joint-calibration.ts` 批量写者 + `effectiveB` 读链改 `b_post ?? b_anchor ?? b`；对照重放 `pnpm replay:joint-calibration`）。

### A1 先验打破平移不变——原否决为何不再覆盖这条路

§4 与 §备选否决的是**无锚**联合估计：似然 `P=∏σ(θ−b)` 在 `θ→θ+c, b→b+c` 下不变（平移不变 + JMLE incidental-parameters），owner 作答流内没有信息定尺度的原点与单位。本 amendment 许可的是**每题带方差的 agent 先验**：

- **先验模型**：`b_j ~ N(μ_j, τ_j²)`，后验 = 作答似然 + 先验项 `(b_j−μ_j)²/2τ_j²`。先验项在平移下**不再不变**（μ_j 是外部固定输入）——平坦谷变成有唯一 MAP 的谷，联合估计可识别，agent 先验场（全体 μ_j 的位置与散布）锚定整体尺度原点+单位。
- **n=1 红线保持**：识别信息仍来自作答流之外——数据只能在先验 leash 内挪 b，不能 owner 自证尺度。这是「半数据驱动」的在线化，不是推翻 §4。
- **方差膨胀改由 τ_j² 控制**：阶段②「锁死防方差膨胀」的目的由先验方差承接——τ_j² 是 b 可以离开锚的预算；incidental-parameters 偏差被先验罚项压住（penalized/MAP 是其标准缓解），不消失。**诚实边界**：τ_j 取得过大 ≈ 弱弹簧，联合估计退化回被否决的自由互估——τ 映射必须登记在案且有限，不开放调到无穷。
- **先验来源（不改 agent 产出方式）**：μ_j = 现行 `item_calibration.b_anchor`（ItemPriorTask，`source` 为 `'llm_prior'` / `'llm_prior_llasa'` / `'fixed_anchor'`）；τ_j 由既有 `confidence` 列经登记在案的固定映射派生（fixed_anchor 强锚取小 τ、llm_prior 弱锚取大 τ），LLM 不新增输出面。LLM 自述置信进 τ 须守 ADR-0035 2026-06-20 增补推论：未过校准闸的不确定性只作降权参考，不得当硬置信用。

### A2 同一尺度联合 / 交替小批估计：更新节奏与收敛/稳定条件

- **节奏（两时间尺度保留，语义精化）**：θ̂ 仍每作答在线更新（Elo，`updateThetaForAttempt` 路径不变），b 读数从 `b_calib ?? b_anchor` 链改为后验 `b_post`（无证据时数值=b_anchor，读侧零跳变）；b 以**小批**更新（nightly `recalibration_nightly` 承载，或每 N 条作答触发），批内以 θ_before 快照对 θ̂ 准静态（沿用 thetaBefore 纪律）做条件后验更新，批内可作多轮坐标交替（θ|b → b|θ）。识别性由先验承担后，「b 批频率 ≪ θ 更新频率」从识别性硬条件**降格为稳定性工程条件**，保留。
- **收敛/稳定条件（spec 层写死，非调参自由度）**：
  1. **单调收缩**：每题后验方差单调不增且 ≤ τ_j²（结构性保证）。
  2. **信任域**：每批每题 |Δb| 设 damping 上限，防 θ̂↔b 交替正反馈（θ̂ 读 b、b 读 θ̂ 的回路自激）。
  3. **收敛判据**：批间 |Δb| 中位数/最大值低于容差且后验方差趋平即收敛；批间 Δb 均值符号翻转（振荡）→ 加大 damping 或回滚该批。
  4. **自激哨兵**：θ̂ 漂移与 b 均值漂移持续同向相关 = 先验系统性偏或回路自激，触发 A5 尺度审计而非继续吸收（指标见 A6）。

### A3 连续收缩取代 RECALIBRATION_MIN_LABELS=12 的 b_anchor→b_calib 硬切换

- **现行**：`labelCount < 12 → b_calib NULL`（effectiveB 退锚）→ `≥12 一次性 AIPW firm-up 首写`（近似不可逆；`docs/design/2026-07-02-project-logic-master-register.md` 已记「单 fluke 可定首写」风险）。
- **新**：`b_post(j)` = 先验精度与证据项的精度加权组合（logistic 似然下以 Laplace/Fisher 近似或小批数值优化承载）；**0 条证据 ⇒ b_post = μ_j**，数值上就是锚——不再需要 NULL 哨兵、阈值与切换时刻；对数据的权重随有效证据量连续单调上升（shrinkage），无跳变、无「首写不可逆」。
- **退役项（落地 PR 内移除，本 ADR 只钉设计）**：`RECALIBRATION_MIN_LABELS` 门控与 `b_calib`「首写 firm-up」语义；`calibration_n`/`calibration_weight` 语义改记「折进后验的有效证据量/后验精度」。「锚定 θ 反推 b_label + IPW/AIPW」机器的存留（如转离线审计用途）随实施 PR 定，不在此预先删除。家族级 `b_delta` 层（`item_family_calibration`）与逐题后验的叠放关系随实施定（弱先验题可继续借家族证据收缩），本 ADR 不预先合并。
- **G4 红线改字面为目的**：识别性由先验保（A1）、b 单写者由标定批保——在线 attempt 路径仍不写 b，写者是标定批。schema 内「永不被 Elo 回写」注释随实施 PR 改写。

### A4 模型判分作答与非 softmax 来源怎么进标定（掌握更新，非答案判分）

- **模型判分作答进标定**（judge 路由 semantic/steps/multimodal_direct/unit_dimension，`execution_provenance='invoked'`）：以 `(分数, w_e)` 进标定，**w_e = 判分可靠度** = judge `confidence` × 路由级复判一致率（live 资产：nightly judge-calibration sampler + `/api/admin/judge-calibration` agreement 读面）。deterministic 路由（exact/keyword，confidence=1）不折。**红线：这是掌握更新，不是答案判分**——judge event 仍是判分真相源，标定只读 `(outcome, confidence, provenance)` 绝不回写判分；判分设计零改动。现行「非 objective 路由 early-return 排除」由本条取代。
- **部分得分**：score ∈ (0,1) 作为连续证据直接进似然（分数值当期望化加权伯努利结果，`s·log p + (1−s)·log(1−p)`），0/1 是其特例；`unsupported`/`partial_unknown`（score=null）不进——沿用「不造假分数」。现行「partial 一律排除」由本条取代。
- **非 softmax 来源（散题 solo 无 stream_item_id、试卷 paper、placement、tutor、ingestion——无 π_i）**：作为带来源标签的似然证据**直接进**，w_e 乘来源权重（登记在案初值：低于流内选题，保守起步）。为什么不再需要 π_i：π_i 是 PPI 池估计器对「sampler 选中进标签集」的 IPW 校正；联合标定下每条作答是直接似然观测，非 sampler 来源没有可反演的模型选择机制。原「无 π_i 就 skip」红线的精神保留为**绝不伪造 π_i**；行为从「跳过」改为「无 π_i、带来源权重进」。诚实项：这些来源有自己的选择效应（学习者自选散题、出卷人选卷），不可 IPW 校正——靠来源权重保守 + A6 来源占比可观测。
- **更正跟随有效判分**：判分被更正（appeal/更正重放）后，该证据以更正后 outcome 重进下批更新（与 ADR-0070 D5「对账跟随有效判分」同构）；承载随实施定。

### A5 尺度对齐：Kolen-Brennan 漂移审计（或等价方法）

- **何时**：每个 b 批边界，以及锚集变化时（新题先验入库 / 先验再生成）。
- **对齐什么**：把 (θ̂, b) 场对回**先验锚尺度**。参照集 = 后验仍由先验主导的强锚题（后验精度 ≈ 先验精度）；方法 = Kolen-Brennan mean/sigma linking 或等价变换；|shift| 超容差 → θ̂ 与 b 场整体归一回锚尺度，并触发先验质量调查。
- **降格说明**：§4「每次 b 更新后 θ 标尺做一次 KB linking 重对齐」原是识别机制；联合估计让 (θ̂, b) 连续共处同一尺度后，KB 不再负责**建立**尺度，负责**审计**「数据是否在把整体尺度拖离锚」（自激 / 先验系统性偏的兜底）。

### A6 可观测性指标（「说清不知道并检验」承重）

1. **已离开先验的题目数**：`|b_post − b_anchor| > τ_j`（移出 1 个先验 σ）的题数与占比；
2. **平均 |b_post − b_anchor|** 及分位数（现行 census `scripts/acceptance/census/audit-queries.sql` 的 delta 族语义从 `b_calib−b_anchor` 平移到 `b_post−b_anchor`）；
3. **各来源作答进标定的占比**：softmax 流内 / 到期 / 散题 / 试卷 / placement / ingestion × 判分路由（deterministic vs model）；
4. **判分可靠度权重分布**：按路由的平均 confidence / 复判一致率、模型判分证据占进入标定总证据的比例；
5. **收敛诊断**：每批 Δb 中位数/最大值、后验方差趋势、θ̂ 漂移 × b 均值漂移相关性（A2 哨兵）、每批 KB |shift|。

### A7 与 ADR-0070（统一学习者大脑）的关系

- 本 amendment 改 θ̂/b 的估计与标定机制，**落入 ADR-0070 D7 挑战者流程的变更范围**：现役 θ̂/effectiveB 路径继续权威运行；联合标定作为挑战者在影子里写封存预测（D3 出题即封存、结算后对账），按预注册指标（对数损失改善、校准不变差、配对 bootstrap）赢过现役**且 owner 批准后**才切换，切换时 D1 契约 `version` bump。既有挂点：YUK-1431（预测封存）、YUK-1445（判分准入）。
- **边界接缝**：agent 仍不写数字（D2/D8）——agent 的合法产出面是**先验 b**（D2「提出探针与难度先验」），联合估计器是确定性代码；判分可靠度权重若改为从对账账本学（D3 证据权重学习），属 ADR-0070 的权重学习面，不在本 ADR 展开。

### 边界与诚实天花板（不变项）

- a/c/slip/guess 仍结构性不可估（n=1 无 cohort），本 amendment 不碰软轨。
- 尺度识别信息仍全部来自 agent 先验：**先验系统性偏会把整个 (θ̂, b) 场带偏**——ADR-0035「锚来源传导性缺口（G3）」条款仍承重；A5 审计 + A6 指标是兜底，不是担保。
- 软信号伪装成硬的红线（ADR-0035 2026-06-20 增补）继续适用：`b_post`/后验 τ 量在过 owner-data 校准闸前 shadow-only，不当硬置信用。

### 本修订精确取代的旧句（上文原文保留作历史记录）

| 位置 | 原句（2026-06-15） | 现行裁决（2026-10-19） |
|---|---|---|
| §4 识别性段 | 「θ 快（视 b 固定常数，item 半边锁死 G4）/ b 慢（批量 active-PPI）」 | b 小批后验更新 + θ 在线交替（A2）；识别性由先验场承担（A1） |
| §4 识别性段 | 「每次 b 更新后 θ 标尺做一次 Kolen-Brennan linking 重对齐」 | 降格为漂移审计（A5） |
| §4 分阶段 | 「③ fixed-anchor + active-PPI（真值攒到 ~数十题级才启动）」 | ③ 改为先验锚定联合标定，证据从第一条起连续收缩（A3） |
| §deferred 设计输入 #2/#4 | 「b_anchor/b_calib 分离 + 阈值 firm-up」「两时间尺度 + 每次更新后 KB」 | 连续后验取代硬切换（A3）；节奏与审计条件见 A2/A5 |
| §备选 | 「b owner 自证 / θ-b 同时间尺度自由互估——否决」 | 否决范围收窄为**无锚**形态（A1） |
| §备选 | 「Elo/Urnings item 更新半边用于单 agent——否决」 | 否决范围收窄为**无先验、靠 cohort 证成**的形态（A1/A2） |
| ADR-0035 决定 5 ② | 「item-更新半边必须锁死用外部锚」 | 不再锁死；方差控制由 τ² 承担（该文件已行内修订） |
| ADR-0042 §3 | 「θ̂ 在线更新用 Elo + b 锚死外部锚」 | 「Elo + b 先验锚定（后验连续收缩）」（该文件已行内修订） |

## 备选（已否决）
- **θ̂ credit 用自创 per-KC 残差公式**——否决（SF-1 数学病理：弱 KC 答错不降，反向）。
- **θ̂ credit 答对也归一化 / 答错也全量**（恢复对称）——否决：MLE 的非对称 (1−p_k) 灵敏度是正确的（owner 拍 MLE）。
- **1/√n K schedule**——否决（非平稳 θ 下 downward lag，核验 refuted）。
- **b owner 自证 / θ-b 同时间尺度自由互估**——否决（识别性结构性不可行：logit 平移不变 + JMLE incidental-parameters 不一致）。〔2026-10-19 amend〕否决范围收窄为**无锚**形态：每题带方差先验锚定的联合估计获许可（先验项打破平移不变），见 §2026-10-19 Amendment A1。
- **Elo/Urnings item 更新半边用于单 agent**——否决（其合法性依赖多人打同题，n=1 失效，β 吸收本属 θ 的方差）。〔2026-10-19 amend〕否决范围收窄为**无先验、靠 cohort 证成**的形态：先验锚定后 item 半边的合法性不再依赖 cohort（方差由先验 τ² 约束），见 §2026-10-19 Amendment A1/A2。
- **本 wave 就改 schema/θ̂ 接 PPI**——否决：b 数据驱动是阶段③ deferred recalibration，当前阶段② b 锁死正确，纯设计输入不提前实现。
