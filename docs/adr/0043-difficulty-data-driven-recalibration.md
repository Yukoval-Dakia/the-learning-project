# ADR-0043 — n=1 难度数据驱动校准：半数据驱动 b + 两时间尺度 + Elo θ̂ credit 裁决

**Status**: Accepted (2026-06-15)
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

**识别性靠两时间尺度随机逼近**：θ 快（每作答 Elo，视 b 为固定常数，item 半边锁死 G4）/ b 慢（批量 active-PPI，对 θ 准静态）；硬条件 `b 校准频率 ≪ θ 更新频率`；**每次 b 更新后 θ 标尺做一次 Kolen-Brennan linking 重对齐**。b 的信息源完全在单人在线回路之外（锚=题面/外部，去偏=客观题真值）——这是 n=1 尺度分离的结构性切分。

**分阶段**：①纯先验（PPI 不能启动，真值=0）→ ②Elo 追 θ（≈当前 wave，b 锁死）→ ③fixed-anchor + active-PPI（真值攒到 ~数十题级、θ 已稳才启动）→ ④开放题外推（propose-only，无法兜底）。

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

## 概念订正（载入实施）

- **`σ(θ−b)` 误名 `p(L)`**：它是「KC-k 视角的题目答对预测概率」，**不是「掌握 KC k 的概率」**（PFA/BKT 的 p(L) 是另一个量）。下游选题引擎读「mastery」时需清理此误名，避免语义埋坑。
- **b vs a/c 分水岭**：b 是位置参数（可锚可推），a/c/slip/guess 是形状/尾部参数（结构性不可识别）。Stocking 1990 只支撑 a/c 不延伸到 b；b 那行承重是 Kolen-Brennan + incidental-parameters 的 cohort 依赖。

## 备选（已否决）
- **θ̂ credit 用自创 per-KC 残差公式**——否决（SF-1 数学病理：弱 KC 答错不降，反向）。
- **θ̂ credit 答对也归一化 / 答错也全量**（恢复对称）——否决：MLE 的非对称 (1−p_k) 灵敏度是正确的（owner 拍 MLE）。
- **1/√n K schedule**——否决（非平稳 θ 下 downward lag，核验 refuted）。
- **b owner 自证 / θ-b 同时间尺度自由互估**——否决（识别性结构性不可行：logit 平移不变 + JMLE incidental-parameters 不一致）。
- **Elo/Urnings item 更新半边用于单 agent**——否决（其合法性依赖多人打同题，n=1 失效，β 吸收本属 θ 的方差）。
- **本 wave 就改 schema/θ̂ 接 PPI**——否决：b 数据驱动是阶段③ deferred recalibration，当前阶段② b 锁死正确，纯设计输入不提前实现。
