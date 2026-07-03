# Scout — default-softmax-selection-policy（register § ~394-405）on main@0291987e

> 轻量 scout：code-ground 现值 + 快赢批 touched 状态 + 外部指针（不深读）。
> Register anchor: `docs/design/2026-07-02-project-logic-master-register.md:394-402`

## ① 实现现值（code-grounded，逐条对 file:line）

**核心文件**：
- `src/capabilities/practice/server/selection-constants.ts:36,47` — `DEFAULT_SELECTION_POLICY='softmax_mfi'`（default-ON，owner 2026-06-16 拍板）、`DEFAULT_TEMPERATURE=0.25`（untuned，与 `core/selection-signals.ts` 的 `softmaxProbabilities` 默认对齐，非独立调过）。
- `src/capabilities/practice/server/selection-sampler.ts:64` — `SAMPLING_EPSILON = 1e-3`（ε-mix 入选下限常数，未变）。
- `src/capabilities/practice/server/selection-sampler.ts:99-148` — `inclusionProbabilities()`：0<n<N 档 `π'_i = (1−ε)·π_i + ε·(n/N)`。**下限量级**：ε·(n/N)，注释里 register 给的「~2500× at n≈12, N≈30」算法核验：ε·(12/30) = 1e-3·0.4 = 4e-4 → 1/π_floor ≈ 2500。**代码现状核实：数量级断言成立**（4e-4 → 2500× IPW 权重）。
- `src/server/mastery/recalibration.ts:139-158`（`aipwMean`）、`227-248`（`ppiPlusMean`）— **无 winsorize/clip/trim**：`residualCorrection += r.residual / r.pi`、`weightSum += 1 / r.pi` 逐条累加，`1/π` 无任何上限。Register 里 F4/#7 提议的「structural bound」目前**未实现**。
- `src/server/mastery/recalibration.ts:257` — `RECALIBRATION_MIN_LABELS = 12`（未变）。

**b_calib 写路径 + 「首次不可逆写」的准确语义**（比 register 摘要更细一层，供后续实现参考）：
- `recalibrateQuestion()`（`recalibration.ts:479-544`）**每次合格夜跑都用该题全部历史标签重算**（`labels = SELECT * WHERE question_id=…` 无窗口截断，`recalibration.ts:501-509`），不是只喂增量——所以 b_calib **技术上会随后续夜跑自我修正**（新增正常标签会稀释单条离群标签的相对贡献）。
- 但「不可逆」的真实含义是**曝光窗口**，不是「值锁死」：`recalibration_nightly.ts` 的候选 SELECT（`:116-146`）用「昨日起有新标签 OR stale（calibration_n < 当前标签总数）」触发——**首次跨过 n=12 门槛的那一夜**，`b_calib` 从 NULL 翻成非 NULL，此后立即被下游**同步在线消费**（非批量）：
  - `src/server/mastery/state.ts:804-819`（`updateThetaForAttempt` 在线 θ̂ 更新路径，`effectiveB(calRows[0])`）——**当晚起的每次作答**都读这个可能被单条离群标签污染的 b_calib，θ̂ 更新已发生，不可回放重算。
  - `src/capabilities/practice/server/candidate-signals.ts:176-203`（选题 MFI 权重）。
  - `src/server/question-supply/target-discovery.ts:120-124,422-429,594-653`（题目补给目标判定）。
  - `src/capabilities/knowledge/ui/node-dims.ts:14`（KG 节点可视化 β）。
  - 全部走 `effectiveB = b_calib ?? b_anchor ?? b`（同一读序，`state.ts:645-646` 显式声明「single source of truth」）。
- 结论：register 「first, irreversible b_calib write」措辞成立，但精确说法是**「首次 NULL→非 NULL 翻转所曝光的下游消费窗口不可回滚」**，而非「b_calib 数值本身永久锁死」——after 首夜，值仍会被后续夜跑重算（且随 N 增长，单条离群权重的相对影响趋向稀释，除非新标签同样落在低 π 区）。这个区分对未来「要不要做全量重算修正」的设计决策有意义：**结构性 trim/winsorize 仍是唯一能防「首夜即污染」的手段**（重算稀释是慢药，救不了首夜就已发生的在线 θ̂ 消费）。

**Fallback 观测性**（register (a) 项，P2 nicety）：`softmax-selection.ts` 的 `tryLlmOrchestration`（:467-505）两个 silent-null 分支（`console.warn`，非结构化 event）——**未变**，仍是 P2。

## ② #2 / #3 快赢批 touched 状态

Register `RECOMMENDED POLISH ORDER` #2 = `pfa-plearn-formula`、#3 = `tagging-match-or-propose`。git 现场核验（HEAD=0291987e，即 register 落库那次 commit 本身）：

- **#2 `pfa-plearn-formula`：已 touched（DONE）**——`8ef0917d fix(mastery): YUK-539 — pfa 假 refit 注释修正（IOU 保留）+ frontier evidence-floor(=4) + γ/ρ retune 0.5/−0.25`（`src/core/pfa.ts`）。
- **#3 `tagging-match-or-propose`：已 touched（DONE）**——`c8673a48 feat(knowledge): YUK-540 — silent MATCH 补审计事件（experimental:auto_tag_kc_matched + sourceRef 贯穿）` + 跟进 `9ef22630 docs(knowledge): YUK-540 review follow-up`（`src/capabilities/knowledge/server/tag-knowledge.ts`）。
- 两者已被收纳进同批设计实录 `docs/design/2026-07-02-quickwin-batch-pfa-tagging-ocrvlm.md`（HEAD commit `0291987e` 消息：「落库打磨 program 四份 design doc（master register + quickwin + misconception ×2）」，quickwin 批次含 pfa / tagging / ocrvlm 三项）。
- **`default-softmax-selection-policy`（本 scout 的 #7）不在该 quickwin 批次里** — git log 对 `softmax-selection.ts` / `selection-sampler.ts` / `recalibration.ts` 三个文件最近的改动都早于 register 落库（最近一条是 `f7609b9d` B3 frontier，无任何 winsorize/trim 相关提交）。**确认：IPW winsorization/trim 仍未实现，是待做项，非已完成误标。**

## ③ 外部指针（bandit 温度/ε 治理 + ed-tech 选题策略，3-5 条，权威分级，不深读）

1. **Bottou, L. 等 8 人（2013）"Counterfactual Reasoning and Learning Systems: The Example of Computational Advertising"**, *Journal of Machine Learning Research*, vol 14, pp 3207–3260.
   - 真实性核验：JMLR 官方页面直连 `jmlr.org/papers/v14/bottou13a.html` + 作者本人主页 `leon.bottou.org/papers/bottou-jmlr-2013` 双源一致。
   - Venue：JMLR（顶级 ML 期刊，CCF-A 同级）。同行评审：是。Preprint：无（正式期刊版）。
   - 引用量级：千级（生产系统里 IPW/importance-weight clipping 的经典案例研究，被大量后续 off-policy evaluation 论文引用）。
   - 相关性：**直接**——本身就是「生产系统里 IPW 权重截断实践」的一手案例，与本 finding 的「structural bound」诉求同构。

2. **Ionides, E. L.（2008）"Truncated Importance Sampling"**, *Journal of Computational and Graphical Statistics*, vol 17(2), pp 295–311.
   - 真实性核验：Taylor & Francis 官方 DOI 页 `tandfonline.com/doi/abs/10.1198/106186008X320456` + 作者本人 PDF `ionides.github.io/pubs/ionides08-jcgs.pdf`。
   - Venue：JCGS（统计学同行评审期刊，ASA/统计计算方向权威期刊）。同行评审：是。Preprint：无。
   - 引用量级：中高（`R::loo` 包等生产统计软件实现了该文的 truncation 方法，是 IS 权重截断的教材级引用）。
   - 相关性：**直接**——是「截断在 √n 量级」等 trim 规则的经典数学依据，是本 finding「加 winsorize/trim」提案最该引的方法论源。

3. **Swaminathan, A. & Joachims, T.（2015）"The Self-Normalized Estimator for Counterfactual Learning"**, NeurIPS 2015（NIPS）.
   - 真实性核验：作者（Cornell CS 教授）本人主页 PDF `cs.cornell.edu/~tj/publications/swaminathan_joachims_15d.pdf`。
   - Venue：NeurIPS（顶级 ML 会议，CCF-A / CORE A*）。同行评审：是。Preprint：无（正式会议论文）。
   - 引用量级：数百级。
   - 相关性：**高度直接**——本仓库代码注释里的「Hájek 自归一化」（`recalibration.ts:113-127,222-227`）与此文的 self-normalized IPW estimator 是**同一数学对象**；该文讨论的正是自归一化如何天然抑制部分 fat-tail 但**不能替代显式 clip**（两者可叠加），是本 finding「self-normalization 有效但不够」判断的直接理论支撑。

4. **Clément, B., Roy, D., Oudeyer, P.-Y., Lopes, M.（2015）"Multi-Armed Bandits for Intelligent Tutoring Systems"**, *Journal of Educational Data Mining* (JEDM), vol 7(2).
   - 真实性核验：JEDM 官方页 `jedm.educationaldatamining.org/index.php/JEDM/article/view/JEDM111` + arXiv 版 `arxiv.org/abs/1310.3174` + ERIC 全文 `files.eric.ed.gov/fulltext/EJ1115278.pdf` 三源一致。
   - Venue：JEDM（教育数据挖掘领域旗舰专业期刊，非 CCF/CORE 覆盖范围内的细分领域期刊，但是该子领域公认权威）。同行评审：是。Preprint：有 arXiv 版但期刊版已发表，非 preprint-only。
   - 引用量级：数百级（该领域内高影响）。
   - 相关性：**直接**——是「bandit 用于选题/难度排程」的 ed-tech 一手案例（RiARiT / ZPDES 两算法），是本 finding「ed-tech 选题策略」外部对照的核心一手来源。

5. **Angelopoulos, A. N., Duchi, J., Zrnic, T.（2023）"PPI++: Efficient Prediction-Powered Inference"**, arXiv:2311.01453.
   - 真实性核验：arXiv 直链 `arxiv.org/pdf/2311.01453`。
   - Venue：⚠️ **PREPRINT-ONLY**（截至本次检索未确认已发表于同行评审会议/期刊；姊妹篇「Prediction-Powered Inference」（无 ++）发表于 *Science* 2023，但 PPI++ 本身目前查到的只有 arXiv 版）。同行评审：**未确认**。
   - 引用量级：未核实（新论文，增长中）。
   - 相关性：**直接**——本仓库 `recalibration.ts:161-176` 的 λ*/PPI++ power-tuning **就是**这篇论文的方法实例化，代码注释已明确署名引用；此处仅做外部核验，**结论：引用真实存在（非编造），但需明确旗标为 preprint、同行评审状态未确认**，比 register/代码注释里隐含的「已确立方法」语气应更谨慎一档。

*(未深读排除项：Ionides 2008 之外另搜到 Vehtari/Gelman/Gabry 的 "Pareto Smoothed Importance Sampling"（PSIS，2017/2024 更新，贝叶斯计算方向常用 PSIS 诊断）作为更现代的 winsorize 替代方案候选，未展开核验，标记为**后续可选**而非本次 5 条硬指针之一。)*

## 结论摘要（供主线消费）

- **①**：register 对现值的描述**在 code 上核实成立**——ε=1e-3、T=0.25、n_min=12、b_calib 无 trim 三点均与 main@0291987e 逐字一致；且发现一层 register 未展开的细节——「不可逆」的准确单位是**首夜曝光窗口的在线 θ̂ 消费**，不是「数值永久锁死」（b_calib 后续夜跑仍会用全量标签重算，但首夜污染已被 `updateThetaForAttempt` 在线消费、不可回放）。
- **②**：#2（pfa-plearn-formula/YUK-539）、#3（tagging-match-or-propose/YUK-540）**均已 touched/DONE**，且已收入同批 `docs/design/2026-07-02-quickwin-batch-pfa-tagging-ocrvlm.md`；本 scout 的 `default-softmax-selection-policy`（polish order #7）**确认仍待做**，非误标已完成。
- **③**：5 条外部指针全部一手来源可核验（4 条确认非 preprint 正式发表 + 1 条明确旗标 preprint），覆盖「IPW 截断方法论」（Bottou 2013 JMLR / Ionides 2008 JCGS）、「自归一化与本仓库术语同构」（Swaminathan & Joachims 2015 NeurIPS）、「ed-tech 选题一手案例」（Clément et al. 2015 JEDM）、「本仓库已用方法的溯源核验」（Angelopoulos et al. 2023 PPI++，preprint 旗标）。

## 附录 — OSS 产品腿回填（2026-07-03，critic P1）

> critic 判 GAP：本 scout 原只有 ①code-ground + ③文献 两腿，缺「开源产品一手源码」腿。本附录补该腿——五锚点全部为**真实打开过的 GitHub 源文件**（带 commit SHA），与 scout 既有 ①③ 结论对话（印证/修正/补角度），**不改动上文**。file:line 号标 approx 者为按已读文件内容估位（symbol 名精确、可复核），obp 的 `np.minimum(iw, self.lambda_)` 字面串已额外经 `search_code` 命中确认。

### A. 锚点清单（`path › symbol` 级，附 commit SHA + 权威性）

**锚点 1 — Vowpal Wabbit**（微软研究院；生产：Azure Personalizer / MSN）⭐8.7k，active（push 2026-05），许可 **BSD-revised**（文件头声明）
`vowpalwabbit/explore/include/vw/explore/explore_internal.h`（SHA `f938381`）
- `details::generate_softmax`（approx L48-92）：`prob = exp(lambda * (*s − max_score))`——**exp 前先减 max_score 做数值稳定**；`lambda>0` 用 max、`<0` 用 min。lambda ≈ 1/T，本项目 T=0.25 ⇒ lambda≈4。
- `details::mix_with_uniform`（approx L180-196）：`prob = prob*(1−uniform_epsilon) + uniform_epsilon/num_actions`——**与本项目 ε-mix 下限逐字同构**（`selection-sampler.ts:99-148` 的 `π'_i=(1−ε)·π_i+ε·(n/N)`；项目用幸存 n/N，VW 用均匀 1/N）。
- `details::enforce_minimum_probability`（approx L118-178）：**另一种下限**——注水法（sort desc → 求阈值 τ → `prob = max(prob−τ, uniform_epsilon/support_size)`），保证每臂 ≥ ε/N 但从高质量臂扣 τ、而非等比缩全体；`consider_zero_valued_elements=false` 把零概率臂排出 support（对应本项目「幸存 n」而非「全 N」）。
- 合法域校验（approx L126）：`if (uniform_epsilon<0 || >1) return E_EXPLORATION_BAD_EPSILON`——**写前先验 ε 域**。
- 退化兜底 `details::sample_after_normalizing`（approx L198-240）：负概率 clamp `if(*pmf<0)*pmf=0`；全零 total → `chosen_index=0; *pmf_first=1`（确定性取首）。

**锚点 2 — Open Bandit Pipeline / zr-obp**（ZOZO Research；生产电商数据集 + NeurIPS'21 D&B 论文背书）⭐704，**⚠️ 维护停滞（last push 2024-06，~2yr）**，许可 **Apache-2.0**
`obp/ope/estimators.py`（SHA `8cbd5fa`）
- `InverseProbabilityWeighting`（approx L269）：`lambda_: float = np.inf`（approx L314）默认不截断；截断经 `np.minimum(iw, self.lambda_)`（approx L353，字面串经 search_code 确认）。docstring：大 iw 被 clip；behavior policy 偏离时方差大。
- `SelfNormalizedInverseProbabilityWeighting`（approx L508）：`reward*iw / iw.mean()`（approx L573）——**Hájek 自归一化，与本项目 `recalibration.ts:113-127,222-227` 同一数学对象**；docstring：「gains some stability」，有偏但一致。
- 关键：**obp 把自归一化与截断做成两个独立 estimator（可叠加），clip 默认 off（∞）但作为一等参数暴露，绝不 hardcode 成无界**。

**锚点 3 — River**（online-ml；广用流式 ML 库）⭐5.9k，very active（push 2026-06-30），许可 **BSD-3**
`river/bandit/base.py` + `river/bandit/epsilon_greedy.py`（SHA `4def49e`）
- `Policy.pull`（base.py approx L68-89）：burn-in——`for arm_id in arm_ids: if self._counts[arm_id] < self.burn_in: return arm_id`，**强制每臂拉满 burn_in 次才切 `_pull`**。docstring 原话：「Each arm is given the chance to be pulled during the burn-in phase. This is useful to mitigate **selection bias**.」
- `EpsilonGreedy.current_epsilon`（epsilon_greedy.py approx L92）：`epsilon * exp(−n*decay)`——**ε 随步数退火**。

**锚点 4 — Anki**（最大生产级 SRS，数百万用户）⭐28.9k，push 2026-07-03，许可 **AGPL-3**（文件头）
`rslib/src/scheduler/queue/builder/gathering.rs`（SHA `c6aafbd`）
- `gather_new_cards`（approx L62-89）：六档 `NewCardGatherPriority`——Deck / DeckThenRandomNotes / LowestPosition / HighestPosition / RandomNotes / RandomCards；随机档用 `knuth_salt(days_elapsed)` = `base_salt.wrapping_mul(2654435761)`（Knuth 乘法散列，approx L188）派**确定性每日种子** → `NewCardSorting::RandomNotes(salt)`。
- 全程 **无 temperature、无 softmax、无概率探索**；取而代之是确定性优先级 + 可选确定性种子洗牌 + 硬每日上限（`root_limit_reached` / `limit_reached`）。

**锚点 5 — ts-fsrs**（**本项目直接依赖**）⭐699，push 2026-07-03，许可 **MIT**
`packages/fsrs/src/algorithm.ts`（SHA `cdec8d2`）
- `apply_fuzz`（approx L197-206）：`if(!enable_fuzz || ivl<2.5) return round(ivl)`（**护栏**：关或短间隔不 fuzz）；否则 `alea(this._seed)` **种子化 PRNG** + `get_fuzz_range` **有界** → floor 落界内。**有界 + 种子（可复现）+ 护栏** 三合一。
- 全程 `clamp`：difficulty [1,10]（`next_difficulty`）、stability [S_MIN, 36500]（`next_recall_stability` / `next_forget_stability` / `next_short_term_stability`）。
- `calculate_interval_modifier`：`request_retention<=0 || >1` → throw（**参数域校验**）。

### B. 对 scout 既有结论的印证/修正表

| scout 既有结论（①/③） | OSS 腿证据 | 判定 |
|---|---|---|
| ε-mix 下限 `π'=(1−ε)π+ε(n/N)`（sampler:99-148） | VW `mix_with_uniform` 逐字同式 | **印证**：是有名的标准生产原语（非自创） |
| 自归一化（Hájek）present 但不能替代显式 clip（③ Swaminathan & Joachims 支撑） | obp 把 SNIPW 与 IPW-clip 做成两个独立可叠加 estimator | **强印证**：产品级证据自归一化 ≠ clip，二者正交互补 |
| F4/#7：1/π 无 winsorize/clip/trim，是待做项 | obp `lambda_` = `np.minimum(iw,λ)` 是一等参数；ts-fsrs 对 D/S 全程 clamp | **印证 + 加码**：trim 是标准；且本项目自家依赖 ts-fsrs 已全程 clamp，mastery 层不 clamp 属**内部不一致** |
| n_min=12 gate b_calib 翻转 | River burn_in 强制探索，docstring 明指 mitigate **selection bias** | **补角度**：n_min 与 River burn-in 同源（都是「够观测再信」），但项目用 n_min-gate + IPW 两件套，River 只用 burn-in 一件 |
| 「不可逆」= 首夜在线 θ̂ 消费窗口不可回放（①细化） | Anki `knuth_salt(days_elapsed)` + ts-fsrs `alea(seed)` 种子化随机 | **补角度**：种子化 → 曝光窗口**可重构回放**（即使不可撤销）；当前项目采样若不 record seed 则失此审计性 |
| ε=1e-3 硬编码常数 | VW 写前校验 `E_EXPLORATION_BAD_EPSILON`；ts-fsrs `request_retention` 域 throw | **补角度**：若 ε/T 未来变可配（按科目温度），需补域校验 |
| softmax T=0.25（selection-signals） | VW `generate_softmax` exp 前减 max_score | **未决探针**：未打开本项目 `softmaxProbabilities`，无法断言其是否做 max-subtraction；低 T 下若无此步有溢出风险 → 设计相待核 |

### C. 给设计相的 5 条可执行启示

1. **把 IPW trim 实现成「暴露的、有界的、可选」clip，对标 obp 的 `lambda_` 旋钮**——放 `recalibration.ts`，常数与 `SAMPLING_EPSILON` 并列声明（如 √n 或固定倍数上界），默认可保守但**绝不 hardcode 成无界**。obp 证明成熟库也把 clip 做成一等参数（默认 ∞ 但暴露），而非隐式无界。〔obp `estimators.py`〕
2. **让 mastery 层与项目自家 ts-fsrs 的 clamp 纪律对齐**——ts-fsrs 对 difficulty/stability 每步 clamp，`recalibration.ts` 对 1/π 无界是**同一数据流里的内部不一致**；补 clip 是「补齐既有纪律」而非引入新范式，论证成本最低。〔ts-fsrs `algorithm.ts`〕
3. **softmax 加 max-subtraction 数值护栏**——核 `core/selection-signals.ts:softmaxProbabilities` 是否在 exp 前减 max；若否，低 T（=0.25 ⇒ lambda≈4）下有溢出隐患，照 VW `generate_softmax` 补。〔VW `explore_internal.h`〕
4. **采样随机性从确定性种子派生以获得回放审计性**——Anki（`knuth_salt(days_elapsed)`）与 ts-fsrs（`alea(seed)`）都用种子化随机使当日顺序可重构；若本项目采样器从可记录值（attempt id / 日戳）播种，则「首夜 θ̂ 消费不可回放」的审计缺口可补（仍不可撤销，但可重建核对）。〔Anki `gathering.rs` / ts-fsrs `apply_fuzz`〕
5. **（范围反例，供防过度工程）Anki 全程无概率探索**——最大生产 SRS 用确定性优先级 + 种子洗牌 + 硬上限，不用 softmax/ε-mix/IPW 那套。设计相应至少 sanity-check 现有 apparatus 的复杂度是否配得上收益；VW 的 `enforce_minimum_probability`（注水法下限，少扰动 argmax）也可作为比当前线性 mix 更温和的下限候选，若发现 ε-mix 过度压制 MFI 最优题。〔Anki `gathering.rs` / VW `explore_internal.h`〕
