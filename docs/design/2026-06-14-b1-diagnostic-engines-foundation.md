# B1 掌握诊断 · 四诊断器正式地基（IRT / CDM / KT族 / LLM + n=1 标定）

> **这是什么**：决策总账 §1 B1 自标的「来源诚实」缺口的补全——四诊断器机制 + n=1 可辨识性 + 慢热标定的逐条文献实证 + 对抗性权威核验。是 B1 的奠基文档，经得起「你到底在文献里看到了什么」的追问。
>
> **生成**：2026-06-14，workflow `b1-diagnostic-engines-foundation`（全 opus，6 agent，~784k tokens，97 工具调用/含联网核验）。4 路调研（IRT/CDM/KT族/n=1标定）→ 1 路对抗性权威审计 → 1 路 cross-统合。
>
> **配套**：决策总账 `...decisions-ledger.md` §1 B1（最高权威拍板）/ Phase 2 `...phase2-synthesis.md` §3。四路原始产出 + 审计存档于 `...b1-diagnostic-engines-foundation-lanes.md`。

---

I have everything needed. The four lanes are integrated, the audit is the supreme authority, and the ledger B1 + Phase 2 §3 mapping points are confirmed. Now I'll write the foundational document body, applying all audit verdicts (H1/H2 corrections, M1-M3 tightening, L1-L6 fixes, G1-G5 gaps), separating mechanism arguments from empirical findings, and honestly marking ceilings.

Here is the markdown body (no top-level title; the orchestrator adds the file header):

---

## §1 为什么需要这份地基 + 一句话结论

### 这份文档存在的理由

决策总账 §1 B1（`docs/design/2026-06-14-product-rethink-decisions-ledger.md` 第 32-49 行）已拍板掌握诊断的完整算法形态：三维分层 `R`/`p(L)`/`difficulty`、全诊断栈但分轨标定、LLM 当冷启先验、慢热自校准四阶段。但 B1 第 43 行自标了一行**来源诚实**警告：

> ⚠️ **来源诚实**:此条是综合连接 [difficulty=PFA β=FSRS D(已落地)] + [Phase 1 §5 选 PFA 弃四引擎] + 标准心理测量 + n=1 限制;四诊断器深挖原文未存盘,系重建非逐字引用。

也就是说：B1 的每一个引擎判断（为什么 a/c 不可估、为什么 PFA 而非 BKT、LLM 标定 r 值多少）此前**只活在被压缩的对话里**，从未存盘、从未过权威性审计。本文档就是把这块地基补成正式存盘——四路独立调研（IRT / CDM / KT 族 / n=1 标定）+ 一路对抗性权威审计，**全部联网核验**。

**本文档的权威纪律**（贯穿全文，是它经得起 owner「你到底在文献里看到了什么」追问的根据）：

1. **审计是最高权威**。凡对抗性审计判定「存疑 / 无法核实」的来源，**不得作为任何净结论的承重支撑**；凡审计判定「过度声称」的措辞，**一律按审计建议改述**。
2. **机制论证 ≠ 实证结论**。「参数计数 / HMM 可辨识性 / Fisher 信息退化」这类是机制推断；「九数据集 head-to-head / r=0.87」这类是论文实测结论。二者全文显式分标，绝不混淆。
3. **天花板诚实标注**。n=1 结构性不可估的量、本项目内容域外推、LLM 标定数字的可信度，全部显式标为「有效性天花板」而非「待解决的工程问题」。

### 一句话结论

> **在 n=1（owner 一人、每知识点稀疏作答、无 cohort）约束下，掌握诊断 collapse 成「一个 PFA logistic 引擎 + LLM 冷启先验」是经得起文献审计的正解。** PFA 把 IRT 的难度 `b` / 能力 `θ`、CDM 的 per-skill 掌握画像在 n=1 **可估的部分**吸收进单一 logistic；不可估的部分（IRT 的区分度 `a` / 猜测 `c`、CDM 的 slip/guess）是 n=1 **结构性不可识别**的有效性天花板——把它们钉软轨低置信不是工程代价否决，是**无 cohort 的认识论天花板**（核心判据：Stocking 1990，Psychometrika，本 corpus 最硬的一块地基，摘要逐字可引）。

这条结论的承重证据分三档强度，全文逐处标注：

| 档 | 含义 | 代表 |
|---|---|---|
| **强实证** | Q1 期刊 / CORE-A 会议 / 奠基专著 + 联网逐字核到关键句 | Stocking 1990（a/c 死路）、Gervet 2020（PFA vs DKT 九数据集）、Klinkenberg 2011（Math Garden 350 万题 Elo）、PPI（Science 2023） |
| **机制推断** | 前提单篇已核验，但「同源 / 可覆盖」这层桥接是本文综合判断 | [IRT a/c ↔ CDM slip/guess 同源死路]、[PFA per-KC p(L) 覆盖 CDM per-skill 画像] |
| **弱地基** | 预印本 / 单作者 / 域不匹配 / 无 n=1 直证 | LLM 标定 r 值（2025-26 预印本、英文数学阅读域）、慢热第④阶段开放题外推（零文献） |

---

## §2 四诊断器逐个机制

每个诊断器给：**机制速写 + 参数语义 + 估计需求**。本节是纯机制层，实证对比留到 §4。

### 2.1 IRT(Item Response Theory)

**机制速写**。一个潜在能力 θ（本项目里 = 某知识点的能力），经 item characteristic curve(ICC) 映到「答对该题的概率」。模型族的区别只在 ICC 有几个 item 参数：

| 模型 | ICC | 新增参数 | 何时用 |
|---|---|---|---|
| **Rasch / 1PL** | `P = 1/(1+e^{-(θ-b)})` | 只有难度 `b` | 冷启、稀疏、要可解释、要 θ 稳健 → **n=1 默认主力** |
| **2PL** | `P = 1/(1+e^{-a(θ-b)})` | 区分度 `a`（ICC 在 θ=b 处斜率） | 有跨考生数据、想知哪些题诊断价值高 |
| **3PL** | `P = c+(1-c)/(1+e^{-a(θ-b)})` | 猜测下限 `c`（四选一 MCQ 理论 ≈0.25） | 有可猜客观题 + 大样本标定 |
| **polytomous（GRM / PCM）** | 有序类别累积概率 | rubric 阈值 | 开放题 / Likert / 部分给分 |

**参数语义**。`θ` = 考生能力（θ=b 时答对概率恰 0.5）；`b` = 题目难度（θ 度量上的位置）；`a` = ICC 斜率（区分高低能力者的锐度）；`c` = 渐近下限（极低能力者靠猜答对的概率）。

**Rasch/1PL 的独有统计性质**（机制论证，决定它为何 n=1 最稳）：模型参数（item 难度、examinee 能力）是**充分统计量(sufficient statistics)** —— 即「参数可分离 / specific objectivity」。总分是 θ 的充分统计量，题目 raw count 是 b 的充分统计量（Rasch 1960，奠基专著，已核验）。这是 1PL 相对 2PL/3PL 在稀疏数据下最稳的根本原因。

**polytomous 两支**（n=1 相关）：GRM（Samejima 1969，Psychometrika Monograph No.17）属 2PL 家族，更灵活但要更多数据；PCM（Masters 1982，Psychometrika 47:149-174）属 Rasch 家族，继承充分统计量 + 稀疏更稳。**n=1 开放/主观题型若要 polytomous，优先 PCM**（同 1PL 稀疏优势），且仍属软轨低置信。

**估计需求**（机制论证 + 领域共识，非单篇定论）：

| 方法 | 机制 | n=1 适用性 |
|---|---|---|
| **JMLE** | 同时极大化 θ 和 item 参数联合似然 | item 参数估计**不一致**（incidental parameters：考生数→∞ 时 b 也不收敛）；n=1 更不行 |
| **MMLE/EM**（Bock & Aitkin 1981） | 对 θ 总体分布积分掉，只在边际似然里极大化 item 参数 | **要假定一个 θ 总体分布** —— n=1 没有总体，这正是为什么 n=1 不能走标准 item 标定 |
| **贝叶斯 / MCMC** | item 参数和 θ 都给先验，后验采样 | **n=1 的正确路径**：先验承担稀疏处支撑，θ 后验给置信区间（对齐 B1「呈现置信区间非干净 78%」） |

样本量经验法则（领域共识）：1PL/Rasch ~100-200 考生；2PL ~250-500；3PL 常需 1000+ 且 c 尤其难收敛。**这三个数量级本身就是 n=1 不可估 a/c 的工程注脚。** 核心机制启示：**标准 item 标定本质是「对考生总体积分」（MMLE），这从估计层面解释了为什么 a/c 是跨考生方差的函数——n=1 无总体可积。**

> 奠基载体：2PL/3PL logistic 由 Birnbaum 在 Lord & Novick 1968 第 17-20 章引入；CAT/adaptive testing 由 Lord 1980 系统化（均已核验，奠基经典）。

### 2.2 CDM(Cognitive Diagnosis Model / DCM)

**机制速写**。把「答对/答错」反推成「一组离散二值技能属性 master/non-master 画像」的受限隐类模型。每个 examinee 有二值属性向量 **α = (α₁,…,α_K)**，α_k∈{0,1}；每道题经 **Q-matrix** 指定它考查哪些属性。模型规定「给定 α，答对概率」的组合函数——模型族的区别只在组合假设：

| 模型 | 组合假设 | slip/guess | 关键源 |
|---|---|---|---|
| **DINA** | 连接型（AND）——全会才"应当"答对 | 每题 2 个：s_j（会却错）、g_j（不会却蒙对） | Junker & Sijtsma 2001 |
| **DINO** | 补偿型（OR）——会任一即"应当"答对 | 每题 2 个（语义对偶） | Templin & Henson 2006 |
| **NIDA** | 连接型，噪声下放 attribute 级 | attribute 级 s_k/g_k（参数更省、约束更强） | Junker & Sijtsma 2001 |
| **RUM/Fusion** | 连接型 + 属性权重 | π*/r* 隐式编码 | DiBello/Stout/Roussos 1995 原始；Hartz 2002 重参数化 |
| **G-DINA** | 一般/饱和——不预设 AND/OR | 每题 2^{Kj} 个（指数膨胀） | de la Torre 2011（统一框架） |

**参数语义**。`α_k` = 是否掌握属性 k；`s_j` = slip（掌握却失误）；`g_j` = guess（没掌握却蒙对）。slip/guess 是 CDM 相对「确定性规则空间」的"noisy"灵魂——把确定性的潜在响应软化成概率。

**估计需求**。slip/guess 是 **item-level 频率参数**：要估 s_j 必须看到「一群掌握该题属性的人里多大比例答错」，要估 g_j 必须看到「一群没掌握的人里多大比例蒙对」。文献共识 CDM 稳定估计需**几百到上千 examinee**（DINA 类仿真典型 N=500~2000，属性越多需求越高）。

> ⚠️ **审计降级标注（M2，机制推断非实证）**：本节不援引「DINA 具体 AUC 优劣」作承重——CDM 各模型的具体性能对比未在本轮逐字核到原文数字，这里只取模型族的**结构性参数需求**（item-level + cohort），这一点是教科书级共识（Rupp/Templin/Henson 2010 教材，已核验）。

### 2.3 KT(Knowledge Tracing)族

**机制速写 + 参数语义 + 估计需求**，逐个：

**BKT（Corbett & Anderson 1995）**——**单技能 HMM**。每个 KC 的掌握状态是二值隐变量，四参数：`p(L0)`（先验掌握）、`p(T)`（学习率：未掌握→掌握的跃迁概率）、`p(S)`（slip：掌握却答错）、`p(G)`（guess：未掌握却答对）。每次作答后贝叶斯更新掌握后验。**估计需求**：四参数 HMM 的 slip 与 guess 高度耦合（同一次错误既可解释为"未掌握"也可解释为"slip"），解耦需**同一 KC 上一条足够长、有起伏的作答序列**——这正是 n=1 在单个细粒度知识点上最稀缺的（往往只个位数次作答）。

**PFA（Pavlik, Cen & Koedinger 2009）**——**logistic 回归**。对题目涉及的 KC 集合：

```
logit( P(答对) ) = Σ_{k ∈ KCs(item)} [ β_k + γ_k · s_k + ρ_k · f_k ]
```

`β_k` = KC 难度截距（先验水平）；`s_k`/`f_k` = 该 KC 历史成功/失败次数；`γ_k`/`ρ_k` = 成功/失败学习增益。它是 Cen, Koedinger & Junker **2006**（LFA，ITS 2006）的 per-student overlay 演化版。**估计需求**：参数量 ∝ KC 数 × 3，**与学生数无关**；低数据量下退化为「先验 + 计数」，不退化为无意义。

> ⚠️ **审计修正（L2）**：LFA 是 **2006**（ITS 2006, LNCS 4053:164-175）。KT 路正文曾出现「Cen…2007」的年份漂移，已订正。

**DKT / SAKT / AKT**——**深网**。DKT（Piech 2015，NeurIPS）= RNN/LSTM；SAKT（Pandey & Karypis 2019，EDM）= self-attention；AKT（Ghosh 2020，KDD）= 单调 attention + Rasch embedding。**估计需求**：成千上万自由参数，靠**跨大量学生交互**做经验风险最小化——标准 benchmark 量级是数千到数十万学生、数十万到上亿交互。n=1 连一个 batch 都凑不出。

**遗忘感知 KT**——DKT-Forget（Nagatani 2019，WWW）/ HawkesKT（Wang 2021，WSDM）/ KPT（Chen 2017，CIKM）= 在 KT 框架内重建「记忆随时间衰减」。**与 FSRS 重叠**（见 §4.4）。

### 2.4 LLM(作为诊断器组件)

**机制速写**。LLM 在掌握诊断里**不当判分诊断器**，只当两个角色：**冷启先验**（题目还没有 owner 作答时给初始难度估计）+ **特征抽取**（从题面/作答抽教学认知特征喂下游模型）。

**三条 LLM 标定路径 + 参数语义**（实证 r 值溯源留到 §5，此处只给机制）：

| 路径 | 机制 | 强弱（机制层） |
|---|---|---|
| **直接 prompt 估难度** | 让 LLM 直接输出"这题多难" | 弱（单点 rating，无校准） |
| **抽教学特征 → 下游学习模型 → IRT** | LLM 抽解题步数/认知复杂度/潜在误解 → NN/树模型模拟答题 → IRT 导出难度 | 中-强（冷启先验主力） |
| **模拟不同能力考生 → 拟合 IRT** | LLM role-play 不同水平学生 → 对模拟作答拟合 IRT | 中（ensemble 路径） |

**估计需求**。LLM 路径本身无传统样本量需求（推理时给先验），但其**有效性**受两条硬约束：(1) 产出的是「模型预测」（量大、可能有偏），需 owner 真值去偏（见 §5 PPI）；(2) 全部实证在英文数学/阅读域，对本项目内容域（中文 K12 各科）**零直证**（见 §7 G2）。

---

## §3 n=1 可辨识性矩阵

这是全文最 load-bearing 的一张表。每个参数 × 单用户能否估 × 凭什么（机制） × 文献支撑。**「可估」= 在 fixed-anchor 框架下、个体参数意义上可估；「结构性不可估」= 不是数据不够，是 n=1 在定义上不提供该参数赖以定义的方差。**

| 参数 | 含义 | n=1 能否估 | 凭什么（机制论证 vs 实证） | 文献支撑 + 强弱 |
|---|---|---|---|---|
| **θ**（owner 能力，per-KC） | 个体能力 | ✅ **可估** | **机制**：θ 是个体参数，似然 `L(θ)=∏ Pᵢ(θ)^{xᵢ}(1-Pᵢ)^{1-xᵢ}` 在 1PL/2PL 下单峰，单考生作答即可 MLE/贝叶斯。**实证**：CAT 的运行前提就是每考生独立实时估自己 θ；Math Garden 40 万学童级 Elo 在线追 θ | **强**（Lord 1980 CAT + Klinkenberg 2011 + Pelánek 2016，均 Q1/经典，已核验） |
| **b**（题目难度） | θ 度量上的位置 | ✅ **可估（靠外部锚，非 owner 自估）** | **机制**：θ 由锚题钉住后，新题 b 可由单考生在已知 θ 下作答反推（anchor linking 逆用），但 CI 宽；**若想用 owner 一人作答去估 b（而非用现成锚）→ 退化为 N=1 校准样本，不可行** | **中-强**（linking 奠基 Kolen & Brennan 2004 强；锚来源依赖 LLM 先验则弱，见 §7 G3） |
| **a**（区分度） | ICC 斜率 | ❌ **结构性不可估** | **机制**：估「概率随能力变化的速率」必须数据里有能力的变化（一题被 θ 散布广的考生作答）；n=1 一题在某时刻只有单一 θ，ICC 在该点只一个观测，斜率不可识别（过一点画无穷多斜率）。**实证**：Stocking 1990 摘要逐字——"examinees who contribute maximally to…difficulty contribute little to…discrimination…ability is widely dispersed" | **强**（Stocking 1990，Psychometrika Q1，**摘要逐字核到**，本 corpus 最硬地基） |
| **c**（猜测） | 渐近下限 | ❌ **结构性不可估** | **机制**：c 是「极低能力者靠猜答对」的尾部行为，n=1 owner **永远不在那个低能力尾部** → 语料区无观测，只能靠先验硬钉。3PL 下 c 即便大样本也最难收敛 | **强**（Stocking 1990 + 其多目标编程后续，DOI 10.1007/BF02294434，补「常规样本不够估 guessing」一刀，已核验） |
| **slip / guess**（CDM） | item-level 噪声参数 | ❌ **结构性不可估** | **机制（同源于 a/c）**：slip/guess 是 examinee 维度频率参数；n=1 单点观测无法分离「真不会 vs slip」——两自由度（α + 噪声）只一个观测，欠定。**这是 IRT (a,c) 在 CDM 族的同源化身** | **中**（机制清楚；**「同源」是本文综合判断，非单篇逐字结论**——见下方诚实标注） |
| **BKT 四参数**（p(L0)/p(T)/p(S)/p(G)） | 单技能 HMM | ❌ **p(S)/p(G) 不可估** | **机制**：HMM slip/guess 解耦要长序列；p(G)/p(S) 即 CDM slip/guess 的 HMM 版，撞同一道死路 | **中**（机制 + Corbett & Anderson 1995 奠基，已核验） |

> ⚠️ **机制推断 vs 实证的诚实分界（审计 M1/M2 + IRT/CDM 路自标）**：表中 θ/b/a/c 的可估性论断有**实证**支撑（Stocking 1990 / CAT / Math Garden 逐字核到）。但「**IRT 的 a/c 与 CDM 的 slip/guess 是同源死路**」这一桥接是**本文的机制综合判断**（连接 Stocking 1990 的 IRT 样本结论 + CDM 的 item-level 参数性质），**非任何单篇原文的逐字结论**。各前提单篇已核验，桥接层是推断。落 ADR 时不得把它写成「Stocking 证明了 CDM slip/guess 不可估」。

**矩阵的总判据（一句话）**：θ 是**个体参数**（单考生时点内可估）；b 是**以考生总体为背景的位置参数**（锚题可借标尺）；而 **a/c/slip/guess 是关于「概率对能力的导数形态」和「能力尾部行为」的参数，其信息结构性地只来自跨考生能力方差** —— n=1 在定义上不提供这个方差。这与 §2 的 MMLE「对 θ 总体积分」从估计理论侧同源：**没有总体，就没有 a/c 赖以定义的那个积分。**

---

## §4 为什么 collapse 成「一个 PFA + LLM 先验」

逐条排除每个备选，**显式区分机制论证（参数计数 / 可辨识性）与实证结论（head-to-head 数字）**。

### 4.1 弃独立 IRT 引擎 —— 因为可估部分已被 PFA 吸收，不可估部分不该单建

- **机制论证**：IRT 在 n=1 可估的只有 b（靠锚）+ θ（个体）。PFA 的 `β_k` 截距 = KC 难度（与 b 同 logit 语义），per-KC 累积 = θ（按知识点）。**PFA 的 logistic 形态正是 1PL 精神的回归化身**（Rasch 充分统计量带来的稀疏稳健性，机制论证）。
- **不该单建的理由**：a/c 结构性不可估（§3），单建一个只能估 b/θ 的 IRT 引擎，与 PFA 的可估部分完全重叠，纯负债。

### 4.2 弃独立 CDM 引擎(DINA/DINO/G-DINA) —— 增量≈0 且非零那点不可得

- **机制论证**：CDM 相对 PFA 的「独有增量」逐项拆——离散二值分类（PFA 连续 p(L) 卡阈值即得，且信息更全）、slip/guess 显式分解（§3 不可估）、显式组合假设（G-DINA 每题 2^{Kj} 参数，n=1 不可得）、属性 hierarchy（已被 KG prerequisite 边 + B3 frontier-gating 覆盖）。**唯一可能增量是 slip/guess 语义，而这恰恰最不可得。**
- **结论（审计采纳的精修措辞）**：CDM 在「软轨低置信」的精确定位**不是「照算但不信」，而是「根本不实例化估计器」**——DINA/DINO/G-DINA/RUM 的参数估计机器一律不建（跑了也只原样回吐先验或发散）；slip/guess **降级为 LLM 软归因标**（LLM 看作答说"这更像失误而非不会"），走 mem0 软画像 / fluency-illusion 软提示通道，**不进 p(L) 诊断器、不进调度**。
- **白送 Q-matrix 的代价**：`question.knowledge_ids`（`src/db/schema.ts:163`，jsonb string[]）= 策划标注版 Q-matrix（item×KC 二值关联），是 n=1 唯一可行的 Q-matrix 来源；但 de la Torre 2008 那套统计 Q-matrix 验证要 cohort，**n=1 用不了**——Q-matrix 错标的唯一防线是人审 + RT4/YUK-344 拓扑一致性闸，不是统计检测。
- **⚠️ owner 拍板覆盖（2026-06-14）：全实例化，不省 CDM 估计器**。owner 选「照字面全实例化四引擎」（扩多用户期权 + 管线先就位），故 DINA/DINO/G-DINA 仍**建并持久化输出**——但本节的 n=1 零信息结论**不变，正是它的「为什么钉软轨低置信」依据**：CDM 估计器在 n=1 多原样回吐先验，输出**钉软轨低置信、不进 p(L) 诊断器、不进调度**。**实例化 ≠ 可信**。即「跑且存」是产品决策（期权/诊断丰富度），「不信且不喂决策」是不变的有效性天花板。详见决策总账 §1 B1「数据保留」条。

### 4.3 弃 BKT/DKT/AKT —— 机制论证 + 实证结论双支撑

**这是本节最强的一块，因为有 head-to-head 实证。**

- **机制论证（参数预算与数据轴对齐）**：PFA 参数 ∝ KC 数 × 3，随**交互数**（owner 持续累积）线性；BKT 押「单 KC 长序列」；DKT/AKT/SAKT 押「跨大量学生交互」。n=1 同时缺「单 KC 长序列」和「多学生」——唯一与 n=1 数据轴对齐的是 PFA。这是结构性匹配，不是偏好。
- **实证结论（head-to-head，强）**：**Gervet et al. 2020（CMU，JEDM）九数据集**，关键句逐字核到——"Logistic regression—with the right set of features—leads on datasets of moderate size or containing a very large number of interactions"，DKT 只在大规模数据领先。**n=1 是数据规模下极限，直接落在逻辑回归（PFA 族）确证占优区间。**
- **实证结论（护城河不成立，强）**：**Khajah, Lindsey & Mozer 2016（"How deep is KT?", EDM）**——DKT 对 BKT 的优势不来自深度表示，而来自可枚举的统计规律性，补进参数模型即可逼近。**为 n=1 付深网数据代价换不到不可替代的精度。**
- **BKT 单错反应（措辞已按审计 M2 收紧）**：BKT 假设「一次错误（除非 slip）= KC 未掌握」对单错反应激进，PFA 用参数平滑——这对 owner 偶尔手滑友好。⚠️ **但「Pavlik 2009 实测 PFA 略优于 BKT」的具体 AUC 数字未逐字核到原文**，故此处改述为「PFA 在 Pavlik 2009 对比中与 KT 相当或略优，**机制上对单次错误的推断更平滑**」，**不写「实测略优」**。落 spec 前若要当承重结论，须对 Pavlik 2009 全文做一次 WebFetch 坐实。

> ⚠️ **审计 G5 补缺（弃 BKT 的对称性漏洞）**：弃 BKT 的论证若只压「需长序列解耦 slip/guess」，会留一个对称漏洞——既然「PFA + LLM 先验」可行，「BKT + 强先验」为何不可行？补一句堵死：**BKT 即便贝叶斯化/灌强先验，仍受「单技能结构 + slip/guess item-level 不可估」所限**（先验只让管线不崩、不产生信息增量），而 PFA 的 per-KC 计数对单点更新更平滑、参数随交互而非学生数增长——这才是弃 BKT 的根本理由，非仅「序列短」。

### 4.4 弃遗忘感知 KT —— 与 FSRS 重叠不互补

- **机制论证**：DKT-Forget/HawkesKT/KPT 的共同目标是在 KT 框架内重建「记忆衰减」。但 B1 已钉**三轴正交**：`R`（记忆/留存）由 FSRS（ts-fsrs，DSR 三组件）专管喂调度 when；`p(L)`（掌握）由 PFA 专管喂诊断。引入遗忘 KT = 让 KT 维重复建模 R 维已管的遗忘，正是 B1「耦合 R 制造信号混乱」同款风险。KPT 把「学习曲线+遗忘曲线」缝进一个模型，与刻意保持的正交分轨相反。
- **结论**：R 已由 FSRS 管，KT 维只负责 p(L)（掌握，含 transfer），不碰遗忘。这是对 B1「信号保持正交」红线的机制确认。

### 4.5 收敛一句话

PFA **不是新引擎，是落地综合体**：把 IRT 的 b/θ、CDM 的 per-KC 掌握在 n=1 可估的部分收进单一 logistic，不可估的部分（a/c/slip/guess）照算照留但钉软轨低置信、不喂决策。这是 B1「收敛+接通非推倒重建」的精确数学落点。

---

## §5 硬轨/软轨 + 慢热四阶段的文献支撑

### 5.1 硬轨 / 软轨的文献定性

| 轨 | 量 | 可估性 | 进哪条轨的文献根据 |
|---|---|---|---|
| **硬轨** | θ（知识点能力）+ b（题目难度，靠锚） | 客观题闭环可 n=1 自校验 | θ 个体参数可估（CAT/Math Garden 强实证）；b 靠 fixed-anchor linking（Kolen & Brennan 2004 强） |
| **软轨低置信** | a、c、CDM slip/guess、KT、开放/主观题型 | 结构性不可估 / 域外推无直证 | Stocking 1990（a/c 死路，强）；slip/guess 同源（机制推断） |

**关键定性**：把 a/c/slip/guess 钉软轨**不是工程代价否决（不违反「不计代价」），是 n=1 无 cohort 的有效性天花板**——「不计代价 ≠ 不计有效性」的直接体现。

### 5.2 慢热四阶段逐阶段支撑强弱

| 阶段 | 内容 | 支撑强弱 | 主要文献（已核验 / 审计裁定） |
|---|---|---|---|
| **① 纯 LLM 先验** | 全低置信，只信相对排序 | **中（弱地基）** | Acquaye 2026（arXiv:2601.09953，预印本）+ Hoyl 2026（arXiv:2602.00034，预印本）+ **SMART/Scarlatos 2025（EMNLP 2025，CORE-A，已正式发表）** |
| **② Elo 追 θ** | O(1) 在线更新能力 | **强** | Pelánek 2016（C&E Q1）+ Klinkenberg 2011（Math Garden 3648 儿童/350 万题，逐字核到）+ Bolsinova 2022（Urnings，JRSS-C Q1） |
| **③ fixed-anchor 纠偏 + PPI + 自检** | 锚题去偏 + 合成≥真值 | **强** | PPI/Angelopoulos 2023（Science，逐字核到）+ Kolen & Brennan 2004（linking 奠基）+ Stocking 1990 |
| **④ per-KC 滚动达标解锁开放题外推** | 客观题掌握外推到开放题 | **弱（零文献，最危险）** | 无直接文献——属产品假设，须埋点事后验证（见 §7 G1） |

### 5.3 各机制的承重出处（关键三块）

**Fixed-anchor / linking（硬轨闭环的根据）**。不同校准批次 IRT 参数线性相关，一条线性变换即可换尺而不改答对概率（Kolen & Brennan 2004 奠基教材）。**n=1 解锁点**：传统估 b 需 cohort，但若 b 已由外部公共锚给定（LLM 先验/公开题库/历史均值），owner 一人作答即可经 fixed-anchor 把**自己的 θ**（per-person，n=1 天然满足）挂上量尺。**所以 b（来自锚）+ θ（owner 自估）这条硬轨在 n=1 闭环可行**——这是 B1「b/θ 进硬轨」的文献根据。

**PPI（合成 ≥ 只用真答的数学保证）**。Angelopoulos et al. 2023（Science 382:669-674，DOI 10.1126/science.adi6000，已逐字核到 5 作者）。有大量「模型预测」+ 少量「金标真值」时，PPI 构造的区间**同时**统计有效（靠少量真值做去偏 rectifier）+ 比只用真值更窄。**本项目映射（教科书级对口）**：LLM 模拟考生/抽特征产出的难度估计 = 「模型预测」；owner 客观题确定判分 = 「金标真值」（B1 的干净锚）；去偏校正项 = B1「残差=miscalibration 信号」。⚠️ **诚实边界**：PPI 有效性建立在「真值 i.i.d. 抽样」前提；owner 客观题是 active learning 选出的，严格用需 cross-PPI / 加权 PPI 处理抽样偏置——落地细节，非否决项。

**Elo / Urnings（单用户在线追 θ）**。Elo 教育应用综述 Pelánek 2016（C&E 98:169-179）；奠基实证 Klinkenberg 2011（Math Garden，**item 选择按目标答对率 .75 抽样**，逐字核到）。

> ⚠️ **审计修正（L of n=1 路 + 确认）**：B1/总账曾把 Urnings 记作「Brinkhuis & Maris」——**主论文实为 Bolsinova, Maris, Hofman, van der Maas, Brinkhuis 2022（JRSS-C 71(1):91-118，DOI 10.1111/rssc.12523）**，Brinkhuis & Maris 是更早 2009/2010 提出「Elo 稳态无已知误差分布、方差膨胀」的前序工作。Urnings 相对 Elo 的两个 n=1 关键优势：(1) 已知误差分布 → 能算标准误 → 能做统计推断；(2) 显式校正自适应选题偏置（active learning p≈0.5 选题不校正会让 θ 失真）。**这是 B1「锁 item 难度防方差膨胀」的直接出处。**

> ⚠️ **审计 G4 补缺（Elo/Urnings 的 n=1 前提反证）**：Elo/Urnings 全部实证（Math Garden 3648 儿童、chess）都是**多 agent 配对比较**——题目难度能在线更新是因为有很多学生打同一题。n=1 下只有一个学生，**item 难度的在线更新退化回 §3 同一道墙**（b 需 cohort）。故必须显式声明：**n=1 下 Elo/Urnings 只用其 θ-更新半边，item-更新半边必须锁死用外部锚**——否则是把多人系统的能力错套到单人。这把 B1「锁 item 难度防方差膨胀」从「防方差」升级为「n=1 下 item 更新本就失效，必须锁」。

**Active learning 选题**。Fisher info p≈0.5（CAT 标准 MFI 准则，Rasch 下等价选 b 最接近 θ̂ 即 P(答对)≈0.5 信息最大）；先验分歧最大（Query-by-Committee，Settles 2009 综述，~6400 引用，**但属 tech report 非同行评审**，且是 ML 通用综述、非教育测量专文——「先验分歧最大」用于选题是合理迁移）。⚠️ **n=1 警示**：MFI 在 θ 估计还差时不稳，且系统性偏好「a 正误差/c 负误差」的题（capitalization on chance），样本越小越严重——**这是 a/c 不可靠会反噬选题的机制证据**，强化「item 难度锁死、只在硬轨选题」。

---

## §6 映射回决策总账 B1 + Phase 2 §3

逐条核对 B1（ledger 第 32-49 行）与 Phase 2 synthesis §3 的具体接口。

### 6.1 `difficulty = PFA β = FSRS D` 桥：成不成立?

**部分成立，等号必须降格（审计 M3 + IRT 路自标，确认）。**

- **成立的部分**：PFA 确为标准 logistic 回归（Pavlik 2009 核验），其 KC 难度截距 β 与 IRT 难度 b 在 logit 链接里**同源**（都是位置/截距项）。
- **必须降格的部分**：IRT 的 b 是「θ 度量上的位置」，PFA 的 β 是「logistic 回归里 KC 的难度截距」，FSRS 的 D 是「记忆难度（非作答难度）」——**三者共享输入桥可以，直接等号会掩盖度量差**。
- **建议措辞**：把 B1 第 33/38 行的「=」降格为「**同 logit 语义，需 linking 对齐**」。
- **与 Phase 2 §3 C4/H10 对齐**（synthesis 第 250/254/419/467 行）：difficulty 是**唯一允许的跨轴共享，但是「同一输入喂两个独立估计」不是「同一个估计两处读」**——D 走 FSRS review、β 走 PFA 梯度，**不互写**。本文档确认这条 ADR 红线与「b/β 需 linking」是同一回事的两个面：共享的是**作答 correctness/RT 这个输入**，各自独立估计，不共享估计值。否则正交红线在 difficulty 处破。

### 6.2 transfer 进 p(L)：成立

θ 是个体参数，单考生可估（§3）；按 `question.knowledge_ids`（已策划 Q-matrix）逐知识点累积 θ → p(L) 认识论上干净，这也是 PFA 的天然形态（本就 per-KC 累积 success/fail 计数）。transfer credit 只作为 RT2 credit 注入 p(L)（Phase 2 §3 第 148/249/254 行），**只进 p(L)，不碰 R/调度**——FSRS when 数学绝不被 credit 污染。本文档确认：transfer 进 p(L) 在文献上站得住（个体参数累积），不进 R 是正交红线。

### 6.3 `item_calibration` schema 含义

Phase 2 §3 第 231 行设计的 `item_calibration` 新表（硬轨 b/θ 高置信列 + 软轨 a/c/cdm/kt 低置信列 + confidence + track + source）——本地基给它的文献支撑：

- **硬轨列（b/θ）有真值会 firm up**：θ 个体可估、b 靠锚可估（§3），慢热四阶段数据攒够后这两列置信度真实上升。
- **软轨列（a/c/cdm/kt）长期 NULL / 低置信是结构性的，不是「还没攒够」**：a/c/slip/guess 是 n=1 结构性不可估（§3），它们的「慢热 firm up」**有天花板**——allowlist 标 `resolves_when: phase` 时须诚实写明「软轨列的置信上限受 n=1 无 cohort 约束，非纯时间问题」，否则会误导未来读者以为「等数据多了就能信」。
- **keyed 选择**（Phase 2 §3 第 483 行待拍）：IRT b 题级 / θ 知识点级，混一表 vs 拆两表——本地基不替产品拍，但给约束：b 与 θ 是**不同度量层**（item-level vs person-KC-level），同表分列须显式标 level 列，否则 linking 时易串。

---

## §7 有效性天花板(诚实)

这一节是 B1 第 43 行「来源诚实」精神的兑现。**全部是天花板，不是待解决的工程问题。**

### 7.1 a / c / slip / guess 结构性不可估（强证据天花板）

不是数据不够，是 n=1 在定义上不提供「跨考生能力方差」这个 a/c/slip/guess 赖以定义的量（§3 完整论证，Stocking 1990 摘要逐字核到，本 corpus 最硬地基）。逃逸阀只有「强先验硬钉」，但那是**原样回吐先验、零信息增量**——只让管线不崩，不是被数据校准过。**钉软轨低置信 = 不信，不是不算、不留。**

### 7.2 开放/主观题型外推（弱地基天花板，审计 G1，最危险）

**慢热第④阶段「客观题硬轨标定外推到开放/主观题型」是全栈最薄一环，零文献兜底。** 四路无一找到 transfer learning / 跨题型迁移效度的正证或反证。B1「滚动达标解锁开放题」机制压在一个**无文献支撑的产品假设**上。

**审计建议（采纳）**：把第④阶段从「净结论」**降级为「显式埋点验证的产品假设」**——外推结果标 **propose-only + 显式低置信**，靠 owner 复盘回执（Phase 2 §3 第 72 行 A2 复盘自校准 UI 落点）做事后校验，**不当成已标定**。

### 7.3 LLM 标定数字的可信度（弱地基天花板 + 审计 ID 修正）

三个 r 值**全部溯源成功、无编造**，但全是 **2025-26 预印本、英文数学/阅读域**，对本项目内容域**零直证**（审计 G2，这是比「未评审」更要命的 external validity 缺口）：

| 声称 | 真实出处（审计裁定后） | 可信度 |
|---|---|---|
| 直接 prompt 估难度 **r≈0** | **Acquaye 2026, arXiv:2601.09953**（直接 prompt r∈[-0.139, 0.137]，逐字核到） | 预印本；**承重源是 Acquaye，不是 reading-comprehension 那篇** |
| LLM 模拟考生 ensemble **r=0.75-0.82** | **Acquaye 2026 同篇**（weighted ensemble r=0.75/0.76/0.82 G4/8/12）+ **SMART/Scarlatos 2025, EMNLP 2025（CORE-A，正式发表）** | ensemble 路径**有一个 CORE-A 同行评审源**（SMART），非全预印本 |
| LLM 抽教学特征 **r≈0.78** | **Hoyl 2026, arXiv:2602.00034**（Stanford 单作者，全新题 r≈0.78） | 预印本·单作者；**方法是 NN+IRT 两阶段，不是 random forest** |
| LLM 抽特征 + 树集成 **r≈0.87** | **Razavi & Powers, arXiv:2504.08804（N=5170）** | 预印本 |

**必须落实的审计修正（H1/H2/M1/L3）**：

- **H1（高严重度）**：r≈0.87 的 arXiv ID 是 **2504.08804**（Razavi & Powers），**不是 2502.20663**。arXiv:2502.20663（Kapoor et al., Stanford）是 **penalized regression r=0.77**，根本不是 0.87、不是随机森林。n=1 路曾误挂——必须改正，否则 owner 会引到错论文。
- **H2（高严重度，反方向欠claim）**：**SMART（arXiv:2507.05129）是 EMNLP 2025 main track 正式论文**（aclanthology 2025.emnlp-main.1274，CORE-A NLP 顶会、同行评审），**不是「裸预印本/引用力度弱」**。它可作 B1「模拟考生 ensemble」的承重源之一（权威性高于 Acquaye 预印本）。
- **M1**：「直接 prompt 弱」的承重源是 **Acquaye 2026（r≈0）**；Razavi 2504.08804 的承重点只取它的 **feature-based r=0.87**，**不要拿它的 direct-estimate「moderate to strong」结论混引**（与 Acquaye 矛盾，二者对「直接 prompt」结论不一致）。
- **L3**：r≈0.78 的方法是 **NN+IRT**，B1 原写「random forest」失准，改述为「LLM 抽特征 + 学习模型 + IRT，r≈0.78（Hoyl 2026 预印本，NN+IRT）」。

### 7.4 锚来源的传导性缺口（审计 G3）

硬轨号称「θ+b 站得住」，但**整条硬轨的地基质量 = 锚的质量**。n=1 锚题难度 b 要么来自 LLM 先验（预印本、英文域、未验证迁移 = §7.3 的弱地基），要么来自公开题库（本项目科目未必有）。**「θ/b 进硬轨」不能继承「锚已可靠」的隐含假设**——「锚来源 + 锚质量」应作为独立风险项追踪，否则硬轨站的地面本身是软的。

### 7.5 无法引用的来源（审计裁定，不得作承重）

- **「Dueñas et al. 2024」**（GPT-3.5 模拟医考生）：**无法核实**，审计确认核不到匹配。该空间真实论文是 Lu & Wang 2024 / Benedetto et al. 2024 / Liu et al. 2024 / SMART(Scarlatos 2025)。**不作正式引用。**
- **「Ulitzsch 2025」当 Bayesian IRT prior**：**存疑·部分平反**——确有 Ulitzsch et al. 2025「ML 难度预测整合进 IRT」工作（被 Frontiers in Education 2026 综述引用），但钉不到精确 venue/DOI，「当 Bayesian prior」的具体机制未坐实。**不可精确引用**——B1 第 41 行须删除/替换该具体署名，目前只能靠通用「贝叶斯 IRT + 先验」原理（MMLE/Bock-Aitkin 边际似然框架）间接支撑，**不能挂在未核实署名上**。（澄清：它存在，不是 hallucination，只是没找到精确出处。）

---

## §8 来源核验表

审计修正后的合并去重版。裁定列：**确认** = 联网核到一手/权威源，标题+作者+venue+年一致；**确认·修正** = 存在但某条措辞/ID/作者有误（已订正）；**存疑** = 存在但具体声称未坐实；**无法核实** = 不应作正式地基。引用量级为量级估计（除明确标精确数）。

| # | 标识(DOI/arXiv ID) | 标题(简) | 作者 | venue | 年 | 引用量级 | 同行评审 | 裁定 | 权威等级 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 10.1007/BF02294761 | Specifying optimum examinees for item parameter estimation | M. L. Stocking | Psychometrika 55(3):461-475 | 1990 | 数百 | 是 | **确认**（摘要逐字核到 a/c 死路句） | 高·Q1（a/c 不可估核心地基，corpus 最硬） |
| 2 | 10.1007/BF02294434 | Optimum examinee samples…multi-objective programming | Stocking 后续 | Psychometrika | — | 数十 | 是 | **确认**（补 c 不可估二级源） | 高·Q1 |
| 3 | 10.1126/science.adi6000 | Prediction-powered inference | Angelopoulos, Bates, Fannjiang, Jordan, Zrnic | Science 382(6671):669-674 | 2023 | 数百 | 是 | **确认**（PMID 37943906，5 作者全对） | 顶级·Science |
| 4 | 10.1016/j.compedu.2016.03.017 | Applications of the Elo rating system in adaptive ed. | R. Pelánek | Computers & Education 98:169-179 | 2016 | 数百 | 是 | **确认** | 高·Q1 |
| 5 | 10.1016/j.compedu.2011.02.003 | Computer adaptive practice of Maths…on the fly | Klinkenberg, Straatemeier, van der Maas | Computers & Education 57(2):1813-1824 | 2011 | 数百 | 是 | **确认**（3648 儿童/350 万题/.75 抽样逐字核到） | 高·Q1（Math Garden，n=1 最强在野证据） |
| 6 | 10.1111/rssc.12523 | Urnings: tracking dynamically changing parameters | **Bolsinova, Maris, Hofman, van der Maas, Brinkhuis** | JRSS-C 71(1):91-118 | 2022 | 数十 | 是 | **确认·修正**（B1 误记作者「Brinkhuis & Maris」，主论文是 Bolsinova et al. 2022 五作者） | 高·Q1 |
| 7 | (UMUAI 27:89-118) | Elo-based learner modeling for adaptive practice of facts | Pelánek, Papoušek, Řihák, Stanislav, Nižnan | UMUAI 27 | 2017 | 数百 | 是 | **确认** | 高（用户建模旗舰） |
| 8 | ISBN/专著 | Test Equating, Scaling, and Linking | Kolen & Brennan | Springer 专著 | 2004/2014 | 数千 | 是(专著) | **确认**（linking/fixed-anchor 奠基教材） | 高·教材权威 |
| 9 | arXiv:2601.09953 | Take Out Your Calculators (LLM student simulations) | Acquaye, Huang, Carpuat, Rudinger (UMD) | arXiv 预印本 | 2026 | 低(新) | **预印本** | **确认**（直接 prompt r∈[-0.139,0.137]≈0；ensemble r=0.75/0.76/0.82 逐字核到） | 预印本·数值真实可溯（**r≈0 承重源**） |
| 10 | arXiv:2602.00034 | Synthetic Student Responses (LLM-extracted features for IRT) | M. Hoyl (Stanford) | arXiv 预印本 | 2026 | 低(新) | **预印本·单作者** | **确认·修正**（r≈0.78 真实；方法 NN+IRT 非 random forest） | 预印本·权威低 |
| 11 | arXiv:2504.08804 | Estimating Item Difficulty Using LLMs and Tree-Based ML | Razavi & Powers (Edmentum) | arXiv 预印本 | 2025 | 低 | **预印本** | **确认·修正**（feature-based 树集成 **r=0.87, N=5170** 坐实；r≈0.87 唯一正确出处） | 预印本（**H1：r≈0.87 挂这里，非 2502.20663**） |
| 12 | arXiv:2502.20663 | Prediction of Item Difficulty…Annotated Item Repository | Kapoor, Truong, Haber, Ruiz-Primo, Domingue (Stanford) | arXiv 预印本 | 2025 | 低 | **预印本** | **确认·修正**（此文是 **penalized regression r=0.77**，非 0.87/随机森林） | 预印本（勿与 #11 混） |
| 13 | arXiv:2507.05129 | SMART: Simulated Students Aligned with IRT | Scarlatos, Fernandez, Ormerod, Lottridge, Lan (UMass/Cambium) | **EMNLP 2025**（2025.emnlp-main.1274） | 2025 | 低-中 | **是·正式发表** | **确认·修正**（**H2：是 EMNLP 2025 main track CORE-A 同行评审，非裸预印本**） | 高·CORE-A 会议（曾被错降为预印本） |
| 14 | (无;转述) | (GPT-3.5 模拟医考生 IRT) | Dueñas et al.(声称) | 未定位 | 2024 | — | — | **无法核实**（核不到匹配；真实空间是 Lu&Wang/Benedetto/Liu/SMART） | **不可引用** |
| 15 | (声称) | (ML 难度预测当 Bayesian IRT prior) | Ulitzsch(声称) | 未定位精确 venue | 2025 | — | — | **存疑·部分平反**（确有 Ulitzsch 2025 相关工作被 Frontiers 2026 综述引；但钉不到精确 DOI，「当 prior」机制未坐实） | **不可精确引用**（B1 须删/替署名） |
| 16 | arXiv:2502.17785 | LLMs for Estimating Reading Comprehension Q Difficulty | Jain, Hollander, He, Tang, Zhang, Sabatini | arXiv 预印本 | 2025 | 低 | **预印本** | **确认**（只报 accuracy，**不含 r 值，不能当 r≈0 出处**） | 预印本（澄清用） |
| 17 | UW-Madison CS TR 1648 | Active Learning Literature Survey | B. Settles | tech report | 2009 | ~6400 | **非同行评审** | **确认**（tech report，非期刊/会议） | 奠基·但非同评 |
| 18 | 10.1111/j.1745-3984.1983.tb00212.x | Rule Space (Q-matrix 开山) | K. K. Tatsuoka | JEM 20(4):345-354 | 1983 | 数千 | 是 | **确认**（ERIC EJ296184） | 奠基·最高 |
| 19 | 10.1177/01466210122032064 | Cognitive Assessment Models (DINA/NIDA) | Junker & Sijtsma | Applied Psych. Measurement 25(3):258-272 | 2001 | 千级 | 是 | **确认** | 高 |
| 20 | 10.1037/1082-989X.11.3.287 | Measurement of Psych. Disorders w/ CDM (DINO) | Templin & Henson | Psychological Methods 11(3):287-305 | 2006 | 千级 | 是 | **确认**（PMID 16953706） | 高·APA 顶刊 |
| 21 | 10.1007/s11336-011-9207-7 | The Generalized DINA Model Framework | J. de la Torre | Psychometrika 76(2):179-199 | 2011 | 千级 | 是 | **确认**（ERIC EJ921258） | 高·Q1 |
| 22 | 10.1111/j.1745-3984.2008.00069.x | Q-Matrix Validation for the DINA Model | J. de la Torre | JEM 45(4):343-362 | 2008 | ~296 | 是 | **确认** | 高 |
| 23 | (章节+博论) | RUM/Fusion 原始 + 重参数化 | DiBello/Stout/Roussos;Hartz | Erlbaum 章节;UIUC 博论 | 1995;2002 | 百-千 | **非期刊同评** | **存疑·部分二手**（一手全文未直接 fetch，经二手交叉转引确认存在） | 中-高·载体非期刊 |
| 24 | ISBN 978-1-60623-527-0 | Diagnostic Measurement (DCM 教材) | Rupp, Templin, Henson | Guilford Press | 2010 | 千级 | 是(获 AERA 奖) | **确认** | 高·教材权威 |
| 25 | 10.1007/BF01099821 | Knowledge Tracing (BKT 开山) | Corbett & Anderson | UMUAI 4(4):253-278 | **1995** | 数千 | 是 | **确认·小修**（多源标 1995，全仓统一为 1995；L1） | 奠基·最高 |
| 26 | 10.1007/11774303_17 | Learning Factors Analysis (LFA, PFA 前身) | Cen, Koedinger & Junker | ITS 2006, LNCS 4053:164-175 | **2006** | 数百 | 是 | **确认·修正**（KT 路正文曾写 2007，正确是 2006；L2） | 高 |
| 27 | ERIC ED506305 / ACM 10.5555/1659450.1659529 | Performance Factors Analysis (PFA 奠基) | Pavlik, Cen & Koedinger | AIED 2009, FAIA 200:531-538 | 2009 | 数百-千 | 是(会议) | **确认·存疑**（论文存在确认；「PFA 略优于 BKT/单错温和」**具体实证数字未逐字核到**，属机制转述；M2） | 高（AIED=CORE-A/CCF-C 教育 AI 会议） |
| 28 | NeurIPS 2015 | Deep Knowledge Tracing (DKT) | Piech et al. | NeurIPS 28:505-513 | 2015 | >1200 | 是 | **确认** | 顶级·NeurIPS |
| 29 | 10.1145/3394486.3403282 | Context-Aware Attentive KT (AKT) | Ghosh, Heffernan & Lan | KDD 2020:2330-2339 | 2020 | 数百 | 是 | **确认**（arXiv 2007.12324） | 顶级·KDD |
| 30 | arXiv:1907.06837 / EDM 2019 | Self-Attentive Model for KT (SAKT) | Pandey & Karypis | EDM 2019:384-389 | 2019 | 数百 | 是(会议) | **确认** | 高·EDM |
| 31 | 10.1145/3308558.3313565 | Augmenting KT by Forgetting (DKT-Forget) | Nagatani et al. | WWW 2019:3101-3107 | 2019 | 数百 | 是 | **确认** | 顶级·WWW |
| 32 | 10.1145/3437963.3441802 | Temporal Cross-Effects in KT (HawkesKT) | Wang et al. | WSDM 2021:517-525 | 2021 | 数百 | 是 | **确认** | 高·WSDM |
| 33 | 10.1145/3132847.3132929 | Tracking Knowledge Proficiency (KPT) | Chen et al. | CIKM 2017:989-998 | 2017 | 数百 | 是 | **确认** | 高·CIKM |
| 34 | 10.5281/zenodo.4143614 / EJ1273917 | When is Deep Learning the Best Approach to KT? | Gervet, Koedinger, Schneider, Mitchell | JEDM 12(3):31-54 | 2020 | 数百 | 是 | **确认**（关键句逐字核到——PFA 占优区间） | 高·JEDM（弃 DKT 最强实证地基） |
| 35 | arXiv:1604.02416 / EDM 2016 | How Deep is Knowledge Tracing? | Khajah, Lindsey & Mozer | EDM 2016 | 2016 | 数百 | 是(会议) | **确认** | 高·EDM（深网护城河不成立的关键引用） |
| 36 | 10.1145/3569576 | Knowledge Tracing: A Survey | Abdelrahman, Wang & Nunes | ACM Computing Surveys 55(11) | 2023 | 数百 | 是 | **确认** | 顶级·CSUR |
| 37 | 10.1007/BF02293801 | MMLE of item parameters: EM algorithm | Bock & Aitkin | Psychometrika 46:443-459 | 1981 | ~2283 | 是 | **确认**（MMLE/EM 奠基） | 高·Q1 |
| 38 | ISBN 0201043105 | Statistical Theories of Mental Test Scores | Lord & Novick (Birnbaum ch.17-20) | Addison-Wesley 专著 | 1968 | 数万 | 是 | **确认**（2PL/3PL logistic 奠基载体） | 奠基·经典 |
| 39 | ISBN 0898590067 | Applications of IRT to Practical Testing Problems | F. M. Lord | Erlbaum 专著 | 1980 | 万级 | 是 | **确认**（CAT 经典） | 奠基·经典 |
| 40 | (DPI 1960) | Probabilistic Models…Intelligence and Attainment | G. Rasch | Danish Inst. Educ. Research 专著 | 1960 | 万级 | 是 | **确认**（Rasch/1PL 充分统计量奠基） | 奠基·经典 |
| 41 | (Psychometrika Monograph No.17) | Estimation of latent ability…graded scores (GRM) | F. Samejima | Psychometrika Monograph Suppl. 34 | 1969 | 数千 | 是 | **确认** | 奠基·GRM |
| 42 | 10.1007/BF02296272 | A Rasch model for partial credit scoring (PCM) | G. N. Masters | Psychometrika 47:149-174 | 1982 | 数千 | 是 | **确认** | 奠基·PCM |

**核验诚实声明**：审计对 22 个不重复来源做了独立联网核验（含全部 arXiv ID + 最 load-bearing 的数字），**裁定无任何一条疑似编造**。本表已落实审计全部修正：H1（r≈0.87 ID 改 2504.08804）、H2（SMART 升级为 EMNLP 2025 CORE-A）、M1（直接 prompt r≈0 承重源 = Acquaye，勿混 Razavi direct）、M2（PFA>BKT 标机制转述非实证）、M3（b=β=D 降格 needs linking）、L1（Corbett 统一 1995）、L2（LFA 统一 2006）、L3（Hoyl 方法 NN+IRT 非 random forest）。#14 Dueñas 不可引用、#15 Ulitzsch 不可精确引用、#23 RUM 部分二手——均不作净结论承重。最 load-bearing 的 Stocking 1990 a/c 死路句、Gervet 2020 PFA 占优句、Klinkenberg 2011 Math Garden 数字、PPI Science 五作者均逐字核到。

---

**相关文件（绝对路径）**：
- 决策总账（本地基补盘对象 + 所有修正落点）：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-decisions-ledger.md`（§1 B1，第 32-49 行；第 43 行「来源诚实」自标即本文档填充点）
- Phase 2 synthesis（散落引用首次正式存盘对象 + §3 接口对账）：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase2-synthesis.md`（§3 第 148-149/231-232/248-254/419/467/483 行）
- Phase 1 大调研（PFA 弃四引擎原始判断上游）：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase1-research.md`（§5）
- Q-matrix 字段实证：`/Users/yukoval/yukoval-projects/the-learning-project/src/db/schema.ts:163`（`question.knowledge_ids` jsonb string[]）

---

**owner 需在 B1 文档落实的修补点（均为现有决策的内联订正，非新 feature）**：(1) `b=β=D` 等号 → 「同 logit 语义，需 linking 对齐」（§6.1）；(2) 删/替换未核实的「Ulitzsch 2025」署名（§7.5）；(3) r≈0.87 ID 改 arXiv:2504.08804、r≈0.78 方法改 NN+IRT、SMART 标 EMNLP 2025（§7.3 H1/H2/L3）；(4) Urnings 作者改 Bolsinova et al. 2022（§5.3 L6→实为 Urnings 作者修正）；(5) 慢热第④阶段降级为「propose-only + 埋点验证的产品假设」（§7.2 G1）；(6) `item_calibration` 软轨列 allowlist 须标「置信上限受 n=1 无 cohort 约束，非纯时间问题」（§6.3）。

**Linear**：本任务为四路调研 + 权威审计的 cross-统合存盘，产出即本地基文档正文，无代码/schema 改动。所有 actionable 修正项均属 owner 当前在编决策总账的内联订正 + 未来 calibration epic 的 spec 输入，强归属既有 B1 / YUK-203 P3 / YUK-344 范畴。**无需新建独立 Linear issue**；若 owner 要独立追踪两个外推缺口（G1 开放/主观题型外推无文献、G2 本项目内容域 LLM 标定零直证），建议作为 comment 追加到 B1 对应 issue（YUK-203 P3 或 calibration 子 issue），不碎片化新建。
