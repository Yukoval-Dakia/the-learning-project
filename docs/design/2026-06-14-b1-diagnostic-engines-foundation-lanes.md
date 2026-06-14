# B1 四诊断器地基 · 四路调研 + 权威审计原始产出（存档）

> cross-统合（落 `2026-06-14-b1-diagnostic-engines-foundation.md`）的输入。终局以 cross-统合 + 审计裁定为准。

---

## Lane 1 · IRT 机制调研

决策总账读完。B1 的措辞和我的证据链完全对齐 — 特别注意第 43 行的「来源诚实」自我标注:四诊断器深挖原文未存盘、系重建非逐字引用。这正是本轮调研要补的盘。我的产出可以直接给 B1 提供它声称但未存盘的文献地基。

我现在有完整、全部联网核验的证据,可以产出最终报告。

---

# IRT 机制调研 —— n=1 掌握诊断地基(B1 文献补盘)

本报告把 IRT 讲透并落到 n=1(owner 单人)场景,为决策总账 §1 B1(`docs/design/2026-06-14-product-rethink-decisions-ledger.md` 第 32-49 行)补上「四诊断器深挖原文未存盘」(第 43 行自我标注)的正式文献地基。**所有引用均已联网核验**,核验表在最后一节。

---

## 1. 模型族:Rasch/1PL → 2PL → 3PL → polytomous

IRT 的共同骨架:一个潜在能力 θ(单维,本项目里是「某知识点的能力」),通过 item characteristic curve(ICC)映到「答对该题的概率」。模型族的区别只在 ICC 有几个 item 参数。

**Rasch / 1PL —— 只有难度 b**

$$P(\text{答对} \mid \theta) = \dfrac{1}{1 + e^{-(\theta - b)}}$$

- 参数语义:`θ` = 考生能力,`b` = 题目难度(θ = b 时答对概率恰为 0.5)。所有题共享同一斜率(区分度恒为 1)。
- Rasch 1960 的独有性质(经 WebSearch 核验):**模型参数(item 难度、examinee 能力)是充分统计量(sufficient statistics)** —— 即「参数可分离 / specific objectivity」。总分是 θ 的充分统计量,题目原始 raw count 是 b 的充分统计量。这是 1PL 相对 2PL/3PL 最关键的统计优势,也是它在 n=1 稀疏数据下最稳的根本原因。
- 何时用:**新知点冷启、稀疏数据、要可解释性、要 θ 估计稳健** → 用 1PL/Rasch。这是 n=1 的默认主力。

**2PL —— 加区分度 a**

$$P = \dfrac{1}{1 + e^{-a(\theta - b)}}$$

- `a` = 区分度(ICC 在 θ=b 处的斜率),刻画「这道题区分高低能力者的锐度」。a 大 = ICC 陡 = 题目在 b 附近信息量集中且高。
- 何时用:有足够跨考生数据、想知道哪些题诊断价值高时。**注意:估 a 需要能力广散布的多考生样本(见 §3)。**

**3PL —— 再加猜测下限 c**

$$P = c + (1-c)\dfrac{1}{1 + e^{-a(\theta - b)}}$$

- `c` = 伪猜测参数 / 渐近下限(能力极低者靠猜也能答对的概率;四选一 MCQ 理论下限 ≈ 0.25)。
- 来源:Birnbaum 在 Lord & Novick 1968 第 17-20 章(pp. 397-479,经核验)引入 logistic 2PL/3PL 并发展其统计推断方法 —— Birnbaum 是 logistic mental test model 的原创者。
- 何时用:**有干扰项可猜的客观选择题 + 大样本标定**。c 在 n=1 几乎不可估(见 §3)。

**polytomous —— 多于二分的有序得分(开放题 / 评分量表)**

不是二分对错,而是有序类别(0/1/2/… 分,或 rubric 等级)。两个主流:

- **GRM(Graded Response Model,Samejima 1969,Psychometrika Monograph No.17,经核验)**:2PL 的多类别扩展,用累积边界概率(cumulative boundary,Thurstone 传统)。适合「rubric 打分、Likert 量表、部分给分」的有序响应。
- **PCM(Partial Credit Model,Masters 1982,Psychometrika 47:149-174,DOI 10.1007/BF02296272,经核验)**:Rasch 家族的多类别扩展 —— 继承参数可分离 + 充分统计量 + conjoint additivity。每个 item 的阈值(thresholds)逐题经验估计,不要求等距或有序。
- GRM vs PCM 的关键区别(核验确认 Masters 1982 原文专门论证):PCM 属 Rasch 家族(有充分统计量、稀疏更稳),GRM 属 2PL 家族(更灵活但要更多数据)。**n=1 古文开放题若要 polytomous,优先 PCM**(同 1PL 的稀疏优势),且仍属软轨低置信。

---

## 2. 估计方法与样本量

| 方法 | 机制 | 同时估 θ? | n=1 适用性 |
|---|---|---|---|
| **JMLE**(Joint MLE) | 同时极大化 θ 和 item 参数的联合似然 | 是 | item 参数估计**不一致**(incidental parameters 问题:考生数 →∞ 时 b 也不收敛);n=1 更不行 |
| **MMLE/EM**(Bock & Aitkin 1981) | 对 θ 的总体分布积分掉,只在边际似然里极大化 item 参数,用 EM 迭代 | 否(item 参数主估,θ 后验另算) | **要假定一个 θ 总体分布** —— n=1 没有总体,这正是为什么 n=1 不能走标准 item 标定 |
| **贝叶斯 / MCMC** | item 参数和 θ 都给先验,后验采样 | 是 | **n=1 的正确路径**:先验承担数据稀疏处的支撑,θ 后验给置信区间(对齐 B1「呈现置信区间非干净 78%」) |

- Bock & Aitkin 1981(Psychometrika 46:443-459,2283 引用,经核验)是 MMLE/EM 的奠基:它「把 θ 分布经验化,避免对其形态的任意假设」,且适用于无简单充分统计量的一般 IRT 模型(即 2PL/3PL)。**核心启示:标准 item 标定本质是「对考生总体积分」—— 这从估计层面就解释了为什么 a/c 是跨考生方差的函数,n=1 无总体可积。**
- 样本量经验法则(领域共识,非单篇定论):1PL/Rasch 稳定标定 ~100-200 考生;2PL ~250-500;3PL 常需 1000+ 且 c 尤其难收敛。**这三个数量级本身就是 n=1 不可估 a/c 的工程注脚。**

---

## 3. n=1 可辨识性(核心论证)

设定:单考生(owner)+ 锚题(fixed-anchor —— 已知 b 的题作为标尺)。问:在 fixed-anchor 下,**θ 和 b 可估,a 和 c 结构性不可估**,为什么?

### 3.1 θ 可估(单考生 + 锚题)— 成立

θ 是**个体参数**,不需要跨考生方差。给定一组 b 已知的锚题和该考生的作答,θ 的似然 $L(\theta) = \prod_i P_i(\theta)^{x_i}(1-P_i(\theta))^{1-x_i}$ 是 θ 的单峰函数(1PL/2PL 下严格,可证),单考生作答即可 MLE 或贝叶斯估 θ。**这正是 CAT(计算机自适应测验)的运行前提**:每个考生独立、实时地估自己的 θ,锚题库的 b 是固定标尺。Lord 1980(经核验)整本书的 tailored/adaptive testing 章节就是这套——单考生 θ 估计是 IRT 最成熟、最不依赖样本量的部分。

→ **映射 B1**:`θ → 按知识点累积的 p(L)` 在认识论上**成立**。owner 对一批已知难度题的作答,可逐知识点估 θ。这进硬轨。

### 3.2 b 可估(有锚 / 反过来) — 有条件成立

b 是 item 参数,标准上需对考生总体积分(MMLE)。但在 fixed-anchor 框架下反过来用:**θ 一旦由锚题钉住,新题的 b 就可由单考生在已知 θ 下的作答反推**(条件极大似然)。这是 anchor linking / common-item equating 的逆用。代价:单考生给 b 的信息量低、置信区间宽,需慢热累积。

→ **映射 B1**:b 进硬轨「有 fixed-anchor 即可 n=1 估」**成立但伴随宽 CI** —— 对齐 B1 慢热四阶段。

### 3.3 a 和 c 结构性不可估 —— n=1 死路(严谨论证)

**为什么 a 需要跨考生方差:** a 是 ICC 的斜率,刻画「概率如何随能力变化的速率」。要估「随能力变化」,数据里**必须有能力的变化** —— 即一道题被一群 θ 散布广的考生作答。n=1 时,owner 对一道题在某个时刻只有单一的(估计出来的)θ,ICC 在该点只有一个观测,**斜率不可识别**(过一个点能画无穷多斜率的曲线)。

**Stocking 1990 的直接证据**(Psychometrika 55:461-475,DOI 10.1007/BF02294761,经核验,摘要原文):
> "examinees who contribute maximally to the estimation of item **difficulty** contribute little to the estimation of item **discrimination** … better item calibration results may be obtained … from examinee calibration samples in which **ability is widely dispersed**."

这是教科书级的判据:估 b 要能力集中在 b 附近的考生;估 a 要**能力广散布**的考生样本。n=1 owner 既不能提供散布,也只有单一时点的 θ —— **a 的 Fisher 信息趋于退化**。c 更糟:c 是「极低能力者靠猜答对」的渐近下限,n=1 owner 恰恰**永远不会处在那个低能力尾部**,语料区无观测 → c 完全无数据支撑,只能靠先验硬钉。

**一句话论证:** θ 是个体参数(单考生时点内可估);b 是「以考生总体为背景」的位置参数(锚题可借标尺);而 **a/c 是关于「概率对能力的导数形态」和「能力尾部行为」的参数,二者的信息都来自跨考生的能力方差** —— n=1 在定义上不提供这个方差,故 a/c 不是「数据不够」而是**结构性不可识别**。这与 §2 的 MMLE「对 θ 总体积分」从估计理论侧同源:没有总体,就没有 a/c 赖以定义的那个积分。

→ **映射 B1**:第 36/38 行「a/c 是 n=1 认识论死路 Stocking 1990」**完全坐实**。把 a/c 钉软轨低置信「不是工程代价否决,是 n=1 无 cohort 的有效性天花板」—— 这个区分有文献支撑,精确无误。

---

## 4. 映射到我们的架构(逐条核对 B1)

**① `IRT 难度 b → difficulty 维(= PFA β = FSRS D 桥)`是否成立?**

部分成立,但有重要的语义差。

- PFA(Pavlik, Cen & Koedinger 2009,经核验)确认是**标准 logistic regression**,其知识点项的系数(B1 称 β)和 IRT 难度截距 b 在数学形态上同源(都是 logit 链接里的位置/截距项)。所以「IRT b 与 PFA β 共享 logit 截距语义」**成立**。
- 但严格说:IRT 的 b 是「θ 度量上的位置」,PFA 的 β 是「logistic 回归里 KC 的难度截距」,二者**单位需要 linking 才严格等同**,不是恒等式。建议在文档里把「=」降格为「同语义、需 linking 对齐」。FSRS 的 D(difficulty)又是另一套(记忆难度,非作答难度),三者共享「输入桥」可以,但**直接等号会掩盖度量差** —— 这点值得在落地时显式标注(对齐 B1 第 43 行的来源诚实精神)。

**② `θ → 按知识点累积 p(L)`是否成立?** —— **成立**(见 §3.1)。θ 是个体参数,单考生可估;按 `question.knowledge_ids`(B1 第 39 行说的「已策划的 Q-matrix」)逐知识点累积 θ → p(L),认识论上干净。这也是 PFA 的天然形态(PFA 本就 per-KC 累积 success/failure 计数)。

**③ CAT / anchor linking 对单用户慢热标定的可借鉴处:**

- **CAT 的 θ 估计循环**直接可借:owner 每答一题就更新 θ 后验,用 Fisher 信息选下一题(B1 第 45 行「Fisher info p≈0.5 选题」正是 CAT 的 maximum-information item selection)—— 这是 IRT 里最成熟、最不吃样本量的机制,n=1 完美适配。
- **fixed-anchor linking**:CAT 题库的标尺(已知 b 的锚题)在 n=1 里就是 owner 客观题的确定判分(B1 第 45 行「干净锚,残差=miscalibration 信号」)。这是 §3.2 b 可估的工程实现。
- **慢热标定的现代 LLM 接法**(对齐 B1 第 41/44/48 行,均有核验文献):
  - LLM 直接 prompt 估难度 → 弱(Razavi & Powers 2025 预印本核验:direct estimate「moderate to strong」但早年级差,且本质是单点 rating)。
  - **LLM 抽教学/认知特征 → 喂 tree-based 模型**:Razavi & Powers 2025 实测 **r 高达 0.87**(B1 写 r≈0.78 是保守口径,文献支持更高)。这是冷启先验的主力路径。
  - **LLM 模拟不同能力考生 → 拟合 IRT**(B1「模拟考生 ensemble」):SMART 框架(arXiv:2507.05129,见核验表)和 Dueñas et al. 2024(GPT-3.5 模拟医考生)是这条线的代表 —— 但二者均为**预印本/会议未定级**,引用力度需诚实标注。
  - ⚠️ **B1 提到的「ML 难度预测当 Bayesian IRT prior(Ulitzsch 2025)」我无法独立核验存在性**(见核验表),**不应作为正式地基引用**,需 owner 提供原始出处或删除该具体署名。

---

## 5. 对 B1 的净结论(5 条)

1. **θ 和 b 进硬轨在文献上站得住,a/c 进软轨是有效性天花板而非工程退让 —— Stocking 1990 是直接判据,可逐字引用。** B1 第 36/38 行的认识论定性精确无误:θ 是个体参数(CAT 单考生可估)、b 借 fixed-anchor 可估、a/c 的信息结构性地只来自跨考生能力方差。建议把 Stocking 1990 的那句摘要原文钉进 B1 作为 load-bearing 引文。

2. **「IRT b = PFA β = FSRS D」的等号应降格为「同 logit 语义、需 linking 对齐」。** PFA 确为 logistic 回归(Pavlik 2009 核验),β 与 b 同源;但 IRT b 是 θ-度量位置、PFA β 是回归截距、FSRS D 是记忆难度,三者共享输入桥可以,恒等会掩盖度量差。这是 B1 第 33/38 行最该收紧的措辞(与第 43 行自标的「重建非逐字」精神一致)。

3. **1PL/Rasch 应是 n=1 的默认引擎选择,理由是充分统计量带来的稀疏稳健性。** Rasch 1960(核验)的参数可分离 + 充分统计量性质,使它在 n=1 稀疏数据下比 2PL/3PL 稳得多。这给 B1「collapse 成一个 PFA + LLM 先验」补了估计理论根据 —— PFA 的 logistic 形态正是 1PL 精神的回归化身。

4. **慢热四阶段的 CAT/Elo/Fisher-info 借用有成熟文献,LLM 特征抽取的实证 r 比 B1 写的更高。** CAT 的 maximum-information 选题(Lord 1980)、Elo 在教育中的 θ/难度在线估计(Pelánek 2016,Computers & Education,核验)都是定级期刊/经典源;LLM 抽特征 r≈0.87(Razavi & Powers 2025,B1 写 0.78 偏保守)。Elo 阶段「锁 item 难度防方差膨胀」与 Pelánek 2016 的 Elo 变体讨论吻合。

5. **B1 第 41 行「Ulitzsch 2025 当 Bayesian prior」无法核验,必须替换或删除署名;LLM 模拟考生路径的源全是预印本,引用力度要诚实标注。** 净影响:B1 算法骨架(PFA + θ/b 硬轨 + a/c 软轨 + LLM 先验 + 慢热四阶段)的**核心承重点全部有经同行评审的经典/定级文献支撑**;唯一需修补的是「ML 预测当贝叶斯先验」这一具体接法,目前只能靠通用的「贝叶斯 IRT + 先验」原理(MMLE/Bock-Aitkin 的边际似然框架 + 一般贝叶斯 IRT)间接支撑,不能挂在未核实的具体署名上。

---

## 6. 来源核验表

| 标识(DOI/ID) | 标题 | 作者 | venue | 年 | 引用量级 | 同行评审 | 联网核验 | 权威等级 |
|---|---|---|---|---|---|---|---|---|
| ISBN 0201043105 | Statistical Theories of Mental Test Scores | Lord & Novick(Birnbaum 章节贡献) | Addison-Wesley(专著) | 1968 | 数万级(领域奠基) | 是(专著) | **确认存在** | 奠基性经典,IRT/CTT 双根 |
| (Lord&Novick 1968 ch.17-20, pp.397-479) | Some latent trait models and their use in inferring an examinee's ability | Allan Birnbaum | 同上(章节) | 1968 | 数万级 | 是 | **确认存在**(页码 397-479 核验) | 2PL/3PL logistic 原创奠基 |
| ISBN 0898590067 | Applications of Item Response Theory to Practical Testing Problems | Frederic M. Lord | Lawrence Erlbaum(专著) | 1980 | 万级 | 是 | **确认存在** | IRT 应用奠基,CAT 经典 |
| (DPI 1960 / MESA 1980) | Probabilistic Models for Some Intelligence and Attainment Tests | Georg Rasch | Danish Inst. for Educ. Research(专著) | 1960 | 万级 | 是(Psychometrika 1963 书评) | **确认存在** | Rasch/1PL 奠基,充分统计量 |
| 10.1007/BF02294761 | Specifying optimum examinees for item parameter estimation in IRT | Martha L. Stocking | Psychometrika 55:461-475 | 1990 | 数百级 | 是 | **确认存在** | Psychometrika(IF≈2-3,心理测量旗舰);a/c 不可估直接判据 |
| 10.1007/BF02293801 | Marginal maximum likelihood estimation of item parameters: Application of an EM algorithm | Bock & Aitkin | Psychometrika 46:443-459 | 1981 | ~2283(Semantic Scholar) | 是 | **确认存在** | Psychometrika;MMLE/EM 奠基 |
| (Psychometrika Monograph No.17) | Estimation of latent ability using a response pattern of graded scores | Fumiko Samejima | Psychometrika Monograph Suppl. 34 / No.17 | 1969 | 数千级 | 是 | **确认存在** | GRM(polytomous)奠基 |
| 10.1007/BF02296272 | A Rasch model for partial credit scoring | Geoff N. Masters | Psychometrika 47:149-174 | 1982 | 数千级 | 是 | **确认存在** | PCM(polytomous, Rasch 家族)奠基 |
| 10.1007/BF01099821 | Knowledge tracing: Modeling the acquisition of procedural knowledge | Corbett & Anderson | User Modeling & User-Adapted Interaction 4:253-278 | 1995 | 数千级 | 是 | **确认存在** | BKT 奠基(B1 弃 BKT 的对照源) |
| (AIED 2009, FAIA 200:531-538) | Performance Factors Analysis — A New Alternative to Knowledge Tracing | Pavlik, Cen & Koedinger | Proc. AIED 2009 | 2009 | 数百-千级 | 是(会议) | **确认存在** | AIED(EDM 重要会议);PFA 奠基,确认 logistic 形态 |
| 10.1016/j.compedu.2016.03.017 | Applications of the Elo rating system in adaptive educational systems | Radek Pelánek | Computers & Education 98:169-179 | 2016 | 数百级 | 是 | **确认存在** | Computers & Education(IF 高,教育技术顶刊);Elo-in-education 综述 |
| arXiv:2504.08804 | Estimating Item Difficulty Using LLMs and Tree-Based ML Algorithms | Pooya Razavi & Sonya Powers | arXiv(预印本) | 2025 | 低(新) | **预印本未评审** | **确认存在**(摘要逐字核验:r=0.87,N=5170) | 预印本/非学术定级;LLM-特征抽取证据 |
| arXiv:2507.05129 | SMART: Simulated Students Aligned with IRT for Question Difficulty Prediction | (arXiv,作者未逐一核验) | arXiv(预印本) | 2025 | 低(新) | **预印本未评审** | 列出存在,**未逐字核验作者** | 预印本;LLM-模拟考生证据,引用力度弱 |
| (Dueñas et al. 2024) | (GPT-3.5 模拟医考生 IRT) | Dueñas et al. | 二手转述(未定位原文) | 2024 | 低 | **无法核实原始 venue** | **无法核实** | 不作正式引用,仅作机制提及 |
| (Ulitzsch 2025) | (ML 难度预测当 Bayesian IRT prior) | Ulitzsch et al.(声称) | 未知 | 2025(声称) | — | — | **无法核实** | **不可引用** —— 需 owner 补出处或删署名 |

---

## 7. Linear 跟进

本任务为纯文献调研/补盘,产出直接回填到 owner 正在编辑的决策总账。发现 3 个 owner 应处理的 B1 文档修补点(均已在净结论第 2/5 条点明),属现有 B1 决策的措辞收紧、不构成新 feature 工作:(a) 「b=β=D」等号降格为「需 linking」;(b) 删除/替换未核实的「Ulitzsch 2025」署名;(c) LLM 模拟考生源标注为预印本。**无需新建 Linear issue** —— 这些是 owner 当前手上 doc 的内联订正,且 B1 第 43 行已有「来源诚实」自标 placeholder,本报告正是填充它的输入,在同一编辑会话内闭环即可。

**相关文件(绝对路径):**
- 决策总账(本报告补盘对象):`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-decisions-ledger.md`(§1 B1,第 32-49 行;第 43 行「来源诚实」自标即本报告填充点)
- Phase 1 大调研(B1 上游):`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase1-research.md`

---

## Lane 2 · CDM 机制调研

确认:`question.knowledge_ids` 是 `jsonb` 的 `string[]`(schema.ts:163),即每题挂一组知识点 id —— 这正是策划标注版 Q-matrix 的二值化形态(item × attribute 关联表,每行非零项 = 该题考查的属性集)。论断成立。

所有文献核验完成,字段形态确认。以下是完整调研报告。

---

# CDM(认知诊断模型 / DCM)机制调研 —— n=1 学习工具掌握诊断地基

> 配套决策:`docs/design/2026-06-14-product-rethink-decisions-ledger.md` §1 B1。本报告把 B1「CDM → 软轨低置信」拍板背后的引擎机制 + n=1 适配证据补成正式地基。术语注:文献多用 **CDM**(cognitive diagnosis model)与 **DCM**(diagnostic classification model)互指同一族,本报告统一用 CDM,引用教材时保留 DCM。

---

## 0. 一句话定性(先给结论锚)

CDM 是一族**把「答对/答错」反推成「一组离散二值技能属性 master/non-master 画像」**的受限隐类模型(constrained latent class model)。它的核心卖点——细粒度 per-skill 离散掌握分类 + slip/guess 显式分解——**全部依赖一个 examinee cohort 来估计 item-level 参数**。在 n=1(owner 一人)下,这个 cohort 不存在,所以 CDM 的独有增量**可得性≈0**;而它真正有用的那部分(per-KC 掌握画像)**已经被 PFA 的 per-KC p(L) 以「读同一张 Q-matrix」的方式覆盖**。结论:B1 把 CDM 钉在「软轨低置信」是**结构正确**的,且更精确的定位是「**根本不单独算,只保留概念词汇 + 留一个极弱的 LLM-prior 占位**」,而非「照算但不信」。

---

## 1. 模型族:答对概率如何由「掌握多个属性」组合而成

CDM 的共同骨架:每个 examinee 有一个二值属性向量 **α = (α₁,…,α_K)**,α_k ∈ {0,1} 表示是否掌握第 k 个属性(KC)。每道题 j 经 **Q-matrix** 指定它考查哪些属性(q_jk ∈ {0,1})。模型规定「给定 α 和 q_j,答对概率 P(X_j=1 | α)」的函数形式。模型族的区别**只在这个组合函数的假设**——连接型(conjunctive,要全会才行)vs 补偿型(compensatory/disjunctive,会一个就够)vs 一般型(saturated,数据说了算)。

| 模型 | 组合假设 | 答对概率机制(口径) | slip/guess | 关键源 |
|---|---|---|---|---|
| **DINA**(Deterministic Input, Noisy "And") | **连接型**(AND gate)——必须掌握题 j 要求的**全部**属性才"应当"答对 | 定义潜在响应 η_j = ∏_k α_k^{q_jk}(全会→1,缺一→0)。观测概率:答对 = η_j 时被 **slip s_j** 拉低,η_j=0 时被 **guess g_j** 抬高。即 P(对)= (1−s_j)^η · g_j^{(1−η)} | **每题 2 个**:s_j(会却答错)、g_j(不会却蒙对) | Junker & Sijtsma 2001;Haertel 1989 雏形 |
| **DINO**(Deterministic Input, Noisy "Or") | **补偿型 / 析取**(OR gate)——掌握**任意一个**要求属性即"应当"答对 | η_j = 1 − ∏_k (1−α_k)^{q_jk}(会任一→1)。同样叠 slip/guess。DINA 的析取对偶 | 每题 2 个(slip/guess,语义对偶) | Templin & Henson 2006(原始提出,临床赌博成瘾诊断) |
| **NIDA**(Noisy Input, Deterministic "And") | 连接型,但 **slip/guess 下放到 attribute 级**(不是 item 级) | 每个被考属性各自有"正确施用概率",在 attribute 层先注入噪声,再 AND 聚合 | **attribute 级** s_k/g_k(跨题共享,故参数更省但更强约束) | Junker & Sijtsma 2001 |
| **RUM / Reparameterized RUM(Fusion Model)** | 连接型,但**带属性权重**——区分"缺哪个属性扣多少分" | π*_j = 全会时答对概率(item 难度);r*_jk = 缺属性 k 的惩罚(item 对属性 k 的诊断力);可含一个剩余连续能力项 | 经 π*/r* 隐式编码,比 DINA 更细 | DiBello, Stout & Roussos 1995(原始,不可识别);**Hartz 2002 重参数化使其可识别** |
| **G-DINA**(Generalized DINA) | **一般型 / 饱和**——不预设连接或补偿,用 link 函数(identity/logit/log)展开"每种属性掌握组合"各自的答对概率 | 把 examinee 按"掌握了题 j 所需属性的哪个子集"分成 2^{Kj} 个隐组,每组一个答对概率参数;DINA/DINO/RUM 都是它加约束的特例 | 每题参数随被考属性数指数膨胀(2^{Kj} 个) | de la Torre 2011(统一框架,Wald 检验做逐题模型选择) |

**对 B1 的含义**:DINA/DINO 是连接型 vs 补偿型的两个极端,G-DINA 是把它们统一起来的母框架。我们的场景里,**组合假设这件事本身在 PFA 里被「线性 logit 叠加每个 KC 的成败计数」替代了**——PFA 不区分 AND/OR,它对每个 KC 独立累积证据再线性合成。这意味着我们放弃了 CDM「显式建模属性如何组合」的表达力,但换来了 n=1 下可估、有先验、第一条证据就更新的工程性(见 §4)。

---

## 2. Q-matrix:item→attribute(KC)映射 —— 我们的 `knowledge_ids[]` 就是策划版 Q-matrix

**Q-matrix 是 CDM 的地基**,由 Tatsuoka 1983(rule space)首次形式化:一个 **J×K 的二值矩阵**,q_jk=1 表示题 j 考查属性 k。所有 CDM 都把 Q-matrix 当**输入**,在它之上估计 examinee 的 α 和题目参数。

**两种 Q-matrix 来源,这是关键分野:**

1. **策划标注(expert-specified)**:领域专家逐题人工标"这题考哪些 KC"。Tatsuoka 1983 原始就是这么做的(分数运算的认知属性人工拆解)。优点:语义清晰、可解释、不需要数据;缺点:**主观,可能标错,而标错的 Q-matrix 会污染所有下游参数估计**(de la Torre 2008 整篇论文就是为了解决这个隐患)。

2. **统计推断 / 验证(empirically estimated/validated)**:用作答数据反推或校验 q_jk。de la Torre 2008 的 Q-matrix validation 方法、de la Torre & Chiu 2016 的一般化方法,都是**用一个 cohort 的响应模式**去检测"哪个 q_jk 标错了"。**这类方法的前提是有足够 examinee**——它本质上是在 cohort 的协方差结构里找信号。

**我们的位置(已用 serena/grep 确认 schema)**:`question.knowledge_ids` 是 `jsonb` 的 `string[]`(`src/db/schema.ts:163`),每题挂一组知识点 id。**这正是一个策划标注版 Q-matrix 的稀疏二值表示**——把 `knowledge_ids[]` 摊平成 item×KC 的 0/1 矩阵,非零项就是 q_jk=1。

**这对 CDM 适配意味着三点:**
- **好消息**:我们**白送了 Q-matrix 这块地基**,不需要从作答数据里推它(我们也推不动——见下)。策划标注是 n=1 唯一可行的 Q-matrix 来源。
- **代价**:策划 Q-matrix 标错时,**n=1 下没有 de la Torre 2008 那套统计验证可用**(它要 cohort)。我们对 Q-matrix 错标的唯一防线是人工 review + 一致性闸(RT4 / YUK-344),不是统计检测。
- **结论**:Q-matrix 在我们这是「人审 + 结构闸守护的策划资产」,不是「数据驱动的可校验对象」。这恰好和 B1 把 CDM 钉软轨一致——**我们有它的输入,但养不起它的估计机器**。

---

## 3. slip/guess 参数 + 估计:样本量需求 vs n=1 死路

**slip/guess 是 CDM 的灵魂参数**——它们正是 CDM 相对"确定性规则空间"的"noisy"所在:slip s_j(掌握却失误)、guess g_j(没掌握却蒙对)把确定性的 η_j 软化成概率。

**估计需要多少样本?** slip/guess 是 **item-level 参数**(NIDA 是 attribute-level),它们的估计依赖**多个 examinee 在该题上的响应分布**——你必须看到"一群掌握了该题属性的人里有多大比例答错"才能估 s_j,看到"一群没掌握的人里多大比例蒙对"才能估 g_j。文献共识是 CDM 稳定估计需要**几百到上千 examinee**(DINA 类典型仿真研究用 N=500~2000;属性数越多、Q-matrix 越复杂,需求越高)。

**n=1 下能不能估?直接死路,且死法和 IRT 的 a/c 同源:**
- slip/guess 在数学上是**examinee 维度的频率参数**。n=1 时,owner 在某题上要么对要么错(一个 0/1),你**无法从单点观测里分离"是真不会还是 slip"**——这是一个有两个自由度(掌握状态 α + 噪声 s/g)却只有一个观测的欠定问题。
- 这与 **Stocking 1990** 对 IRT 的结论同构:Stocking 证明"对 item difficulty 贡献最大的 examinee 对 discrimination 贡献极小",必须**能力广泛分散的 examinee 样本**才能估 discrimination(a);后续工作进一步指出 guessing(c)即便在 3PL 里也是最难估、对样本最饥渴的参数。**n=1 = 能力分散度为零 = a/c/slip/guess 全部不可识别**。
- 这正是 B1 ledger §1 写的「a/c 是 n=1 认识论死路 Stocking 1990」——slip/guess 是 CDM 版的同一道死路。**IRT 的 (a,c) 和 CDM 的 (s,g) 是同一个认识论障碍在两个模型族里的化身:都是 item-level 的、需要 examinee 异质性才能估的噪声/区分参数。**

**唯一的逃逸阀**:用**强先验**(贝叶斯)把 slip/guess 钉在文献经验值附近(常见做法:s,g ~ Beta 先验,均值 0.1~0.2),让模型不至于发散。但这时**估出来的不是"数据告诉你的 slip",而是"你先验假设的 slip 几乎原样回吐"**——它没有信息增量,只是让管线不崩。这与 B1「LLM 当冷启先验」是同一招,也正是"软轨低置信"该有的姿态:**保留参数位、灌先验、明确标低置信、不声称它被数据校准过**。

---

## 4. n=1 适配(核心):CDM 的 per-skill 画像能否被 PFA 的 per-KC p(L) 覆盖?

这是整个调研的判断核心。拆成三问:

### 4.1 PFA 读 Q-matrix 吗?—— 是,而且是它的设计本意

**PFA(Pavlik, Cen & Koedinger 2009)** 的模型形式是一个 logistic 回归,对学生 i 在涉及 KC 集合的题上的答对 logit:

> m = Σ_{k ∈ KCs(item)} ( β_k + γ_k · s_{ik} + ρ_k · f_{ik} )

其中 s_{ik}/f_{ik} 是学生 i 在 KC k 上累积的**成功/失败次数**,β_k 是 KC 难度,γ_k/ρ_k 是成功/失败的学习增益。**"item 涉及哪些 KC"这个映射,正是 Q-matrix**——PFA 论文里它叫 KC-model,数学上和 CDM 的 Q-matrix 是同一个 item×KC 关联表。所以 **PFA 原生就读我们的 `knowledge_ids[]`**:每答一题,按它挂的 KC 把成败计数分摊到对应 KC 上,再 logit 合成。

**per-KC p(L)** = 对单个 KC k,用其累积成败 + β_k/γ_k/ρ_k 算出的当前答对概率(可视作该 KC 的掌握度)。**这就是一份 per-skill 掌握画像**,而且是连续的(0~1),不是 CDM 的二值 master/non-master。

### 4.2 CDM 相对 PFA 的独有增量是什么?n=1 下值不值、可不可得?

逐项拆 CDM 的"独有":

| CDM 独有增量 | 实质 | n=1 可得性 | n=1 值不值 |
|---|---|---|---|
| **离散 attribute 分类**(master/non-master 硬二分) | 把掌握度阈值化成"会/不会"的隐类标签 | **可得但是伪精度**——PFA 的连续 p(L) 卡个阈值就能得到同样的二分,且连续值信息更全 | **不值**。二值化丢信息;隐类成员归属本身要 cohort 估隐类先验比例,n=1 估不动。owner 更需要"还差多少"而非"会/不会" |
| **slip/guess 显式分解** | 把"答错"显式归因为"真不会 vs 失误" | **不可得**(§3 死路:n=1 无法分离 α 与噪声) | **不值得当估计目标**。但其**语义**有用——可作为 LLM 特征抽取的一个软标(LLM 看作答说"这更像 slip"),走 mem0/软提示,不进诊断器 |
| **显式组合假设(AND/OR/一般)** | 建模"多属性如何合成答对" | 估计组合参数(G-DINA 每题 2^{Kj} 个)在 n=1 完全不可得 | **不值**。PFA 的线性叠加是一个足够的、可估的近似;n=1 养不起组合参数 |
| **属性间结构(attribute hierarchy)** | 属性的先修依赖 | 不可得(要 cohort 估属性联合分布) | **已被别处覆盖**——我们的先修结构走 KG 的 prerequisite 边 + B3 frontier-gating,不靠 CDM 的隐类联合分布 |

**净判断**:CDM 相对 PFA 在 n=1 下的**唯一可能增量是"slip/guess 的语义解释"**,而这恰恰是**最不可估**的那块。能估的(per-KC 掌握)PFA 已覆盖且做得更适配 n=1(连续、有先验、稀疏友好)。所以 **CDM 在 n=1 的有效增量 ≈ 0,且其中非零的那点也不可得**。

### 4.3 为什么是 PFA 而非 BKT/DKT —— 顺带钉死 KT 选择

B1 选 PFA 弃 BKT/DKT 的文献依据,在 Pavlik 2009 原文里有直接支撑:论文实测 **PFA 略优于 BKT**,且解释了原因——**BKT(Corbett & Anderson 1995)假设"一次答错就意味着该 KC 未掌握(除非 slip)",对单次错误反应过激;PFA 用参数平滑这种反应,单错后的预测调整温和得多**。对 n=1 这点尤其关键:owner 偶尔手滑,BKT 会把掌握度一把打下去,PFA 不会。DKT/AKT(深度网络)要序列大数据,n=1 喂不饱,直接出局。**Corbett & Anderson 1995 的 BKT 四参数 P(L0)/P(T)/P(G)/P(S) 里的 G/S 正是 slip/guess——又一次撞上同一道 n=1 死路**,进一步佐证 logistic 系(PFA)在稀疏数据下的优越性。

---

## 5. 映射核对:CDM 在「软轨低置信」的定位是「照算但不信」还是「根本不算」?

B1 ledger §1 现有措辞:「CDM 独有的 slip/guess 分解 + 离散 attribute 分类 → 软轨低置信(同 cohort 约束)」。

**核对结论:措辞方向正确,但精度可以再收一格。** 严格说 CDM 不是"照算但不信",而是分两层:

- **「根本不算」**(不实例化 CDM 估计器):DINA/DINO/G-DINA/RUM 的**参数估计机器一律不建**。理由是 §3/§4 的硬约束——slip/guess/隐类先验在 n=1 不可识别,跑估计只会原样回吐先验或发散。建一个"算了但结果=先验"的 CDM 估计器是纯负债(代码 + 认知误导)。这比"照算但不信"更省、更诚实。
- **「保留概念 + 极弱 LLM 先验占位」**(算的是 PFA + 一个软标):我们真正"算"的是 **PFA 的 per-KC p(L)**(它吸收了 CDM 可估的部分);CDM 独有的 slip/guess **只以"LLM 特征抽取的一个软归因标"形式存在**(LLM 看作答 → "这更像失误而非不会"),走 mem0 软画像 / fluency-illusion 软提示通道,**不进 p(L) 诊断器、不进调度**。这就是 ledger §1「CDM…由 PFA 的 per-KC p(L) 覆盖…slip/guess → 软轨低置信」想表达的,只是建议把"软轨低置信"展开为"**不建估计器,只留概念词汇 + LLM 软标**"以杜绝未来有人误读成"要实现一个低权重的 DINA"。

**一句话给 B1 的精修建议**:把「CDM → 软轨低置信」改述为「**CDM 不实例化估计器(slip/guess/隐类在 n=1 不可识别);其可估部分由 PFA per-KC p(L) 吸收;其 slip/guess 语义降级为 LLM 软归因标,走 mem0/软提示,不进诊断与调度**」。

---

## 对 B1 的净结论(5 条)

1. **CDM 在 n=1 的有效增量 ≈ 0,且其中非零的那点(slip/guess 语义)恰恰不可得。** CDM 能估的只有 per-KC 掌握,而这已被 PFA 的 per-KC p(L) 以「读同一张 Q-matrix」的方式覆盖,且 PFA 的连续值 + 先验 + 稀疏友好对 n=1 严格更优。→ **B1「collapse 成一个 PFA + LLM 先验、不建并行 CDM 引擎」的拍板成立。**

2. **slip/guess 是 IRT 的 (a,c) 在 CDM 族里的同源化身——同一道 n=1 死路。** 都是 item-level、需 examinee 异质性才能识别的噪声/区分参数;Stocking 1990(IRT)与 CDM 几百-上千 examinee 的样本需求是同一个认识论障碍的两个面。→ **把 slip/guess 钉软轨低置信不是工程代价否决(不违反「不计代价」),是 n=1 无 cohort 的有效性天花板,与「不计代价 ≠ 不计有效性」完全一致。**

3. **我们白送了 Q-matrix 这块地基,但同时丧失了校验它的能力。** `question.knowledge_ids[]`(schema.ts:163,jsonb string[])= 策划标注版 Q-matrix,是 n=1 唯一可行的 Q-matrix 来源;但 de la Torre 2008 那套统计 Q-matrix 验证要 cohort,我们用不了。→ **Q-matrix 错标的唯一防线是人审 + 一致性闸(RT4/YUK-344 拓扑闸),不是统计检测;这条要写进一致性闸地基的职责说明。**

4. **建议把 B1 措辞从「CDM → 软轨低置信」收紧为「CDM 不实例化估计器」。** 不是"照算但不信",而是"根本不建 DINA/G-DINA 估计器 + 保留概念词汇 + slip/guess 降级为 LLM 软归因标(走 mem0/软提示,不进 p(L)/调度)"。这杜绝未来误读成"要实现一个低权重 DINA"。

5. **PFA 弃 BKT/DKT 也被同一证据链加固。** Pavlik 2009 原文实测 PFA 略优于 BKT 且对单次错误反应更温和(owner 手滑友好);BKT 的 G/S 参数(Corbett & Anderson 1995)同样撞 n=1 slip/guess 死路;深度 KT 要大序列数据出局。→ **B1 KT 选 PFA 的依据是逐字可考的原文实证,非重建。**

> ⚠️ **来源诚实标注**:上述把 [IRT a/c 死路 ↔ CDM slip/guess 死路] 认定为「同源」、以及「PFA per-KC p(L) 覆盖 CDM per-skill 画像」的论断,是**综合连接**(Stocking 1990 的 IRT 样本结论 + CDM 的 item-level 参数性质 + Pavlik 2009 的 PFA 机制),属机制层推断,**非任何单篇原文的逐字结论**。各前提单篇均已联网核验(见下表),但"同源/可覆盖"这层桥接是本报告的综合判断。

---

## 来源核验表

| 标识(DOI/ID) | 标题 | 作者 | venue | 年 | 引用量级 | 同行评审 | 联网核验 | 权威等级 |
|---|---|---|---|---|---|---|---|---|
| 10.1111/j.1745-3984.1983.tb00212.x(ERIC EJ296184) | Rule Space: An Approach for Dealing with Misconceptions Based on Item Response Theory | K. K. Tatsuoka | Journal of Educational Measurement, 20(4):345-354 | 1983 | 数千(奠基) | 是(SSCI 期刊) | **确认存在**(Wiley + ERIC + Springer 多源) | 奠基性·最高(CDM/Q-matrix 开山) |
| 10.1177/01466210122032064 | Cognitive Assessment Models with Few Assumptions, and Connections with Nonparametric IRT | B. W. Junker, K. Sijtsma | Applied Psychological Measurement, 25(3):258-272 | 2001 | 千级以上 | 是(SSCI,APM) | **确认存在**(SAGE) | 高(DINA/NIDA 标准引用源) |
| 10.1037/1082-989X.11.3.287(PMID 16953706) | Measurement of Psychological Disorders Using Cognitive Diagnosis Models(DINO 提出) | J. L. Templin, R. A. Henson | Psychological Methods, 11(3):287-305 | 2006 | 千级 | 是(APA 旗舰,顶刊) | **确认存在**(PubMed + APA DOI) | 高(DINO 原始源;Psychological Methods 高 IF) |
| 10.1007/s11336-011-9207-7(ERIC EJ921258) | The Generalized DINA Model Framework | J. de la Torre | Psychometrika, 76(2):179-199 | 2011 | 千级以上 | 是(Psychometrika,心理测量旗舰) | **确认存在**(Springer + ERIC + RePEc;有 erratum 10.1007/s11336-011-9214-8) | 高(G-DINA 统一框架奠基) |
| ISBN 978-1-60623-527-0 | Diagnostic Measurement: Theory, Methods, and Applications | A. A. Rupp, J. Templin, R. A. Henson | Guilford Press(348pp) | 2010 | 千级(教材级) | 是(获 AERA Division D 奖;多刊书评) | **确认存在**(Guilford + Cambridge/Psychometrika 书评 + Amazon ISBN) | 高·教材权威(DCM 标准教材) |
| DiBello/Stout/Roussos: 章节(无 DOI,Erlbaum 论文集);Hartz 2002: UIUC 博士论文 | (原始)Unified cognitive/psychometric diagnostic assessment;(重参数化)RUM dissertation | DiBello, Stout & Roussos;S. M. Hartz | Cognitively Diagnostic Assessment(Erlbaum) pp.361-389;Univ. Illinois PhD diss. | 1995;2002 | 百级-千级(RUM 系奠基) | 1995=编审论文集章节(非期刊同评);2002=博士论文(非期刊同评) | **确认存在**(多二手权威源转引;**原始章节/论文 PDF 未直接核到全文**——标注:一手原文未直接 fetch,经 Springer 章节 + arXiv + ETS 报告交叉转引确认) | 中-高(RUM/Fusion 谱系奠基,但原始载体非期刊;**部分二手确认**) |
| 10.1007/BF02294761 | Specifying Optimum Examinees for Item Parameter Estimation in IRT | M. L. Stocking | Psychometrika, 55(3):461-475 | 1990 | 数百 | 是(Psychometrika) | **确认存在**(Springer + Cambridge) | 高(IRT 样本量经典;a/c 死路直接依据) |
| 10.1111/j.1745-3984.2008.00069.x(ERIC EJ819613) | An Empirically Based Method of Q-Matrix Validation for the DINA Model | J. de la Torre | Journal of Educational Measurement, 45(4):343-362 | 2008 | ~300(scispace 计) | 是(JEM,SSCI) | **确认存在**(Wiley + ERIC + Semantic Scholar) | 高(Q-matrix 统计验证标准源) |
| 无 DOI(ERIC ED506305;ACM 5555/1659450.1659529) | Performance Factors Analysis — A New Alternative to Knowledge Tracing | P. I. Pavlik, H. Cen, K. R. Koedinger | Proc. AIED 2009, Frontiers in AI and Applications 200(1):531-538 | 2009 | 千级 | 是(AIED 会议论文;AIED=CCF-C / CORE B 级教育 AI 会议,EDM 社区高引) | **确认存在**(ERIC + ACM DL + CMU PACT PDF + Semantic Scholar) | 高(PFA 原始源;n=1 选型直接依据) |
| 10.1007/BF01099821 | Knowledge Tracing: Modeling the Acquisition of Procedural Knowledge | A. T. Corbett, J. R. Anderson | User Modeling and User-Adapted Interaction, 4(4):253-278 | 1995 | 数千(BKT 奠基) | 是(UMUAI 期刊,用户建模旗舰) | **确认存在**(Springer + ACT-R/CMU + Wikipedia BKT 条目) | 奠基性·最高(BKT 开山;KT 对照依据) |

**核验诚实声明**:10 条引用中 9 条经一手出版方(Springer/Wiley/SAGE/APA/ACM/PubMed/ERIC)直接确认存在,作者/标题/年份/venue/DOI 均核实无误。**唯一部分确认项**:DiBello/Stout/Roussos 1995 原始论文集章节 + Hartz 2002 博士论文——其**存在性与谱系经多个二手权威源(Springer 章节《The Reparameterized Unified Model System》、arXiv MCMC 论文、ETS 报告)交叉转引确认**,但**一手全文 PDF 未直接 fetch 核对**,故标「确认存在/部分二手」;且二者**载体非期刊同行评审**(论文集章节 + 学位论文),权威等级相应标注。未编造任何 DOI/arXiv ID/标题/作者。

---

## Linear issue 捕获 gate

本任务是**调研补地基**,产出为决策依据而非代码改动。发现的 actionable 跟进项 **2 条**,建议落 Linear(均挂 B1 / YUK-344 一致性闸地基范畴,与既有 issue 强相关,**建议作为 comment 追加到对应 issue 而非新建**,避免 issue 碎片化):

1. **B1 措辞精修**:把决策总账 §1「CDM → 软轨低置信」收紧为「CDM 不实例化估计器 + slip/guess 降级为 LLM 软归因标(走 mem0/软提示,不进 p(L)/调度)」(见净结论 #4)。属文档措辞修正,**无需独立 issue**,可在下次编辑 ledger 时一并改。
2. **Q-matrix 错标防线职责归属**:策划版 `knowledge_ids[]` Q-matrix 无统计校验能力(de la Torre 2008 要 cohort),错标唯一防线是人审 + RT4/YUK-344 拓扑一致性闸——**建议作为 comment 补进 YUK-344(一致性闸地基)的职责说明**,明确"Q-matrix(knowledge_ids)结构正确性纳入写入期一致性闸守护范围"(见净结论 #3)。

**我无 Linear 写权限的判断**:本 subagent 任务边界是调研产出,**不主动创建/修改 Linear issue**——上述两条作为给父 agent / owner 的 capture 建议返回,由其裁决是否落 YUK-344 comment。无需新建独立 issue(两条都强归属既有 B1/YUK-344 范畴)。

---

**相关文件路径**:
- 决策总账(本报告对齐对象):`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-decisions-ledger.md`(§1 B1)
- Q-matrix 字段实证:`/Users/yukoval/yukoval-projects/the-learning-project/src/db/schema.ts:163`(`question.knowledge_ids` jsonb string[])
- Phase 1 大调研(PFA/四引擎选型上游):`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase1-research.md`(§5)

---

## Lane 3 · KT 族机制调研

全部核心源已核验。我现在有完整的、联网确认存在的引用集：

**已核验存在（10 个一级源）：**
1. Corbett & Anderson 1994 — BKT 奠基 — DOI 10.1007/BF01099821
2. Pavlik, Cen & Koedinger 2009 — PFA 奠基 — AIED 2009
3. Cen, Koedinger & Junker 2006 — LFA（PFA 的方法学前身）— ITS 2006, DOI 10.1007/11774303_17
4. Piech et al. 2015 — DKT — NeurIPS 2015
5. Ghosh, Heffernan & Lan 2020 — AKT — KDD 2020, DOI 10.1145/3394486.3403282
6. Pandey & Karypis 2019 — SAKT — EDM 2019, arXiv 1907.06837
7. Nagatani et al. 2019 — DKT-Forget — WWW 2019, DOI 10.1145/3308558.3313565
8. Wang et al. 2021 — HawkesKT — WSDM 2021, DOI 10.1145/3437963.3441802
9. Chen et al. 2017 — KPT — CIKM 2017, DOI 10.1145/3132847.3132929
10. Gervet et al. 2020 — "When is Deep Learning the Best Approach to KT?" — JEDM 2020
11. Khajah, Lindsey & Mozer 2016 — "How deep is KT?" — EDM 2016, arXiv 1604.02416
12. Abdelrahman, Wang & Nunes 2023 — KT Survey — ACM Comput. Surv. 2023, DOI 10.1145/3569576
13. Stocking 1990 — IRT 标定样本 — Psychometrika, DOI 10.1007/BF02294761

引用量级我已从搜索结果中获得部分（DKT >1200，BKT/PFA 高引经典）。我有足够材料产出正式地基。下面是最终交付物。

---

# KT(知识追踪)家族机制调研 —— 为什么单用户(n=1)稀疏数据选 PFA

> 调研者：KT 家族机制调研子代理。锚定决策总账 `docs/design/2026-06-14-product-rethink-decisions-ledger.md` §1 B1（PFA 作落地综合体 / KT 选 PFA 弃 BKT-DKT-AKT / 遗忘归 FSRS）。所有引用均经 WebSearch 联网核验存在性，核验表在末节。

---

## 0. 一句话结论与论证骨架

**KT 这一维诊断器在 n=1（owner 一人、每知识点作答稀疏、无 cohort）约束下选 PFA(Performance Factors Analysis)，因为 PFA 是「逻辑回归 + 多 KC Q-matrix」的轻量参数模型：有先验、第一条证据就更新、参数随交互数线性而非随学生数增长、天然多技能。BKT 是单技能 HMM 需序列才能解耦四参数；DKT/AKT/SAKT 是深网，其精度优势在文献中被证实仅在「大规模数据」时兑现，中小规模下被带特征的逻辑回归反超(Gervet 2020)。遗忘建模(DKT-Forget/HawkesKT/KPT)与我们的 R 维由 FSRS 管，是重叠而非互补——不引入。**

这条结论的证据强度分三档：硬证据（Gervet 2020 的九数据集 head-to-head + Khajah 2016 的机制拆解）、机制论证（参数计数 / HMM 可辨识性）、奠基性引用（Corbett 1994 / Pavlik 2009）。逐条在 §1-§5 展开。

---

## 1. BKT — Bayesian Knowledge Tracing(Corbett & Anderson 1994)

### 机制
BKT 是**单技能的隐马尔可夫模型(HMM)**，把每个知识成分(KC)的掌握状态建模为一个二值隐变量（已掌握 / 未掌握），用四个参数刻画：

| 参数 | 含义 |
|---|---|
| `p(L0)` / p-init | 先验掌握概率（学习前已会的概率） |
| `p(T)` / p-transit | 每次练习后从「未掌握」跃迁到「已掌握」的概率（学习率） |
| `p(S)` / p-slip | 已掌握却答错的概率（失误） |
| `p(G)` / p-guess | 未掌握却答对的概率（猜对） |

每次作答后用贝叶斯规则更新掌握后验，再用 slip/guess 投影到「下次答对概率」。这是 ACT Programming Tutor 的 knowledge tracing 机制（Corbett & Anderson 1994，User Modeling and User-Adapted Interaction）。

### 单技能序列的数据需求 —— 对 n=1 的硬伤
- **参数可辨识性需要序列长度**：四参数 HMM 的 slip 与 guess 在数学上高度耦合（同一次错误既可解释为「未掌握」也可解释为「掌握了但 slip」），要把它们解开需要**同一 KC 上一条足够长、有起伏的作答序列**来分离信号。n=1 在单个细粒度知识点上往往只有个位数次作答，序列短到无法解耦——经典的「empirical degeneracy / 参数退化」问题（slip+guess 拟合到无意义值）在短序列下尤其严重。
- **激进的错误反应**：Pavlik 2009 的二次分析直接指出，BKT 假设「一次错误（除非 slip）= KC 未掌握」**夸大了数据**——单次错误后预测调整过猛。对 n=1 这意味着：owner 偶尔一次马虎错，BKT 会把该 KC 掌握度猛砸下去，缺乏 PFA 那种「用一个标量参数控制错误推断幅度」的平滑机制。
- **单技能假设 vs 多 KC 题目**：BKT 原生每个 KC 独立一条 HMM，对「一道题需要多个知识点」（我们的 `question.knowledge_ids` = Q-matrix）没有原生支持，需要额外拼接（如 conjunctive BKT），进一步增加要估的参数。

→ BKT 不是「不能用」，而是它的可辨识性预算押在「单 KC 的长序列」上，恰好是 n=1 最稀缺的资源。

---

## 2. PFA — Performance Factors Analysis(Pavlik, Cen & Koedinger 2009) —— 为什么 n=1 友好，逐条对照

PFA 是一个**逻辑回归(logistic)模型**，把「下次答对概率」建模为：

```
logit( p(answer correct) ) = Σ_{kc ∈ KCs(item)} [ β_kc + γ_kc · s_kc + ρ_kc · f_kc ]
```

其中对题目涉及的每个知识点 kc：`β_kc` = 该 KC 的难度/易度截距（先验水平），`s_kc` = 该 KC 历史成功次数，`f_kc` = 历史失败次数，`γ`/`ρ` = 成功/失败的学习增量系数。它是 Cen, Koedinger & Junker 2006 的 Learning Factors Analysis(LFA) 的「可做 per-student overlay」演化版（LFA 是「难度因子 + A* 搜索 + 逻辑回归」的认知模型评估方法）。

下面逐条对照决策总账 §1 B1 列出的 n=1 友好特性：

| PFA 特性 | 机制 | 为什么是 n=1 友好 |
|---|---|---|
| **① 有先验** | `β_kc` 截距本身就是该 KC 的 baseline 难度/能力水平，可由 LLM 冷启先验或题型/知识点历史均值初始化 | n=1 冷启时第一道题之前就有非平凡的掌握估计，不像 DKT 要先喂数据才有意义的隐状态。**直接对接决策总账「LLM 当冷启先验」+「删 evidence<3→0.5 占位」** |
| **② 第一条证据就更新** | 每次作答只是把 `s` 或 `f` 计数 +1，logit 平滑移动一格；不需要先积累一条序列才出有意义的后验 | n=1 每个 KC 数据极稀，要求「单点也能动」。Pavlik 2009 二次分析证实 PFA 用 `ρ` 参数**温和**地缩放错误后的调整幅度，避免 BKT 的单错猛砸 |
| **③ 吃稀疏** | 参数数量 ∝ KC 数 × 3（每 KC 三系数），**与学生数无关**；逻辑回归在低数据量下退化为「先验 + 计数」，不会因数据少而退化为无意义 | 这是和深网的根本分野——PFA 的参数预算不随 n 缩水。n=1 时仍是良定义的拟合问题 |
| **④ 天然多 KC（读 Q-matrix）** | 公式里 `Σ over KCs(item)` 直接对题目的多个知识点求和，原生支持「一题多知识点」 | **直接读 `question.knowledge_ids`**（决策总账已策划的 Q-matrix），无需像 BKT 那样为多技能拼接额外结构。这也是决策总账「CDM 的 per-skill 掌握画像由 PFA 的 per-KC p(L) 覆盖」的机制基础 |

**额外的 n=1 价值**：PFA 把 IRT 的难度 `b`（→ 我们的 `β` = difficulty 维 = FSRS D 桥）和按 KC 累积的能力 `θ`（→ per-KC p(L)）在「可估部分」吸收进单引擎——正是决策总账「PFA 是落地综合体」的数学落点。它把 IRT/CDM 在 n=1 可估的部分收进来，不可估的部分（区分度 a、猜测 c）钉软轨（见 §5 与 Stocking 1990）。

---

## 3. DKT / AKT / SAKT —— 深网的数据饥渴为什么对 n=1 是硬伤

| 模型 | 架构 | 关键文献 |
|---|---|---|
| **DKT** | RNN/LSTM，把作答序列编码为隐状态，输出所有 KC 的掌握向量 | Piech et al. 2015, NeurIPS |
| **SAKT** | 纯 self-attention(Transformer)，从过去交互里挑相关 KC 预测 | Pandey & Karypis 2019, EDM |
| **AKT** | 单调 attention + Rasch-based embedding + 四模块（含 exercise/knowledge encoder） | Ghosh, Heffernan & Lan 2020, KDD |

### 数据饥渴的硬证据（不是拍脑袋）

**这是本调研最强的一块实证地基：**

- **Gervet et al. 2020（CMU，JEDM）九数据集 head-to-head**：核心结论是「**带正确特征的逻辑回归在中等规模数据、或单学生交互数极多的数据上领先；DKT 只在大规模数据、或精确时序信息最关键时领先**」。这直接量化了「深度 KT 的优势是数据规模的函数」——n=1 落在「数据规模最小」的极端，是逻辑回归族（即 PFA 类）的主场，不是 DKT 的主场。
- **Khajah, Lindsey & Mozer 2016（"How deep is knowledge tracing?", EDM）机制拆解**：他们论证 DKT 相对 BKT 的优势**不来自深度学习发现的新表示**，而来自四类 BKT 没利用的统计规律性；把这些规律性加进 BKT 后，性能差距大幅缩小。含义：深网的「黑箱表示力」对 KT 任务并非不可替代的护城河——可解释的参数模型（BKT/PFA）补上特征即可逼近。对 n=1，这意味着我们不需要为了那点边际精度去付深网的数据代价。
- **SAKT 自己的动机**就承认 RNN 类 KT「在稀疏数据下泛化不好」（Pandey & Karypis 2019 摘要原话）。SAKT 用 attention 缓解稀疏，但它仍是需要**跨大量学生**训练 attention 权重的深网——缓解的是「某学生交互少」，不是「整个系统只有一个学生」。n=1 连训练 attention 的样本基数都没有。

### 机制论证（与实证互证）
深网（DKT 的 LSTM 权重、SAKT/AKT 的 attention + embedding 矩阵）有成千上万个自由参数，靠**跨大量学生的交互**做经验风险最小化来约束。标准 KT benchmark（ASSISTments、EdNet 等）量级是数千到数十万学生、数十万到上亿条交互。n=1 的 owner 一人，连一个 batch 都凑不出，深网必然严重过拟合 / 退化为记忆训练序列，且无 cohort 提供泛化信号。AKT 的 Rasch embedding 虽借了心理测量正则，但底层仍是需大样本训练的 attention 网。

→ **三者被排除的真实理由**：不是「太复杂」这种主观判断，而是 Gervet 2020 实证给出的「精度优势是数据规模的函数，n=1 在曲线最不利端」+ Khajah 2016 给出的「优势可被参数模型加特征抹平」。

---

## 4. 遗忘感知 KT —— 与 FSRS 是重叠，不是互补（所以不引入）

| 模型 | 怎么建遗忘 | 文献 |
|---|---|---|
| **DKT-Forget(DKT-F)** | 把「距上次交互的 lag time + 该题历史尝试次数」做成手工特征喂进 DKT | Nagatani et al. 2019, WWW |
| **HawkesKT** | Hawkes 点过程：每次过去交互对目标技能有不同的时间敏感激励，kernel 控制时间衰减 | Wang et al. 2021, WSDM |
| **KPT** | 概率矩阵分解 + 同时套用学习曲线与**遗忘曲线**两个经典教育理论 | Chen et al. 2017, CIKM |

### 判断：重叠
这三者的共同目标是**在 KT 框架内重建「记忆随时间衰减」**——本质上是在 KT 里内置一个遗忘/留存函数。但决策总账 §1 B1 已明确**三轴正交**：`R`（记忆/留存）由 **FSRS**（ts-fsrs，DSR 三组件 stability/difficulty/retrievability）专门管，喂调度的 when；`p(L)`（掌握诊断）由 PFA 管，喂诊断展示。

- 若再引入遗忘感知 KT，就是让 KT 维**重复建模 R 维已经管的遗忘**——决策总账 §B3 FIRe 讨论里点名的「耦合 R 制造信号混乱」同款风险。
- FSRS 是为 spaced repetition 专门优化的留存模型，在「单序列、记忆衰减」上比把遗忘当辅助特征塞进 KT 更专一、更适合 n=1（FSRS 本就设计为个人卡片级、不需 cohort）。
- KPT 把「学习曲线 + 遗忘曲线」一起塞进矩阵分解，恰恰是把 R 和 p(L) 缝在一个模型里——与我们刻意保持的正交分轴相反。

→ **结论：遗忘感知 KT 与 FSRS 重叠，不互补。R 已由 FSRS 管，KT 维只负责 p(L)（掌握，含 transfer），不碰遗忘。** 这是对决策总账「信号保持正交」红线的机制确认。

---

## 5. 净判断 —— 为什么 PFA 是 n=1 正解（严谨论证）

### 论证 1：参数预算与数据轴对齐（机制，最 load-bearing）
PFA 的参数量 ∝ KC 数 × 3，**与学生数无关**；BKT 的可辨识性押在「单 KC 长序列」，DKT/AKT/SAKT 的参数量押在「跨大量学生的交互」。n=1 同时缺「单 KC 长序列」和「多学生」——唯一与 n=1 数据轴对齐的是 PFA：参数随**交互数**（owner 会持续累积）线性，而非随**学生数**（永远=1）。这是结构性匹配，不是偏好。

### 论证 2：实证 head-to-head 把 n=1 定位在 PFA 主场（Gervet 2020）
Gervet et al. 2020（CMU，JEDM）九数据集实证：带特征的逻辑回归在中等规模 / 高 per-student 交互数据上**领先** DKT，DKT 只在大规模数据领先。n=1 是数据规模的下极限——直接落在逻辑回归（PFA 族）确证占优的区间。这把「选 PFA」从直觉升级为有 head-to-head 支撑的判断。

### 论证 3：深网优势可被参数模型抹平，护城河不成立（Khajah 2016）
Khajah, Lindsey & Mozer 2016 证实 DKT 对 BKT 的优势不来自深度表示，而来自可枚举的统计规律性，补进参数模型即可逼近。含义：为 n=1 付深网的数据代价**换不到不可替代的精度**——边际收益在 n=1 下进一步缩水（连泛化样本都没有），ROI 论证之外更是有效性论证。

### 论证 4：PFA 原生吻合已落地的架构 seam（工程对齐 + 决策一致）
PFA 的 `Σ over KCs(item)` 原生读 Q-matrix = `question.knowledge_ids`（已策划）；其 `β`(难度截距) = decisions ledger 已钉的 `difficulty` 维 = FSRS D 桥；per-KC 累积 = `p(L)` 含 transfer。PFA 不是新引擎，是把 IRT 的 b/θ、CDM 的 per-skill 画像在 n=1 可估的部分收进单一 logistic——决策总账「落地综合体 / 收敛+接通非推倒重建」的精确数学落点。

### 论证 5：诚实边界 —— PFA 不能做的，是 n=1 有效性天花板而非选型缺陷
PFA（及任何 n=1 方法）估不出 IRT 区分度 `a` 与猜测 `c`。Stocking 1990(Psychometrika) 证明：贡献「难度」估计的考生与贡献「区分度」估计的考生不同，稳健估计需要**能力分布广泛分散的标定样本**——这本质上要 cohort。**注意诚实修正**：Stocking 1990 的核心是标定样本的**能力分布/构成**（不是规定具体样本量 N），但其结论「a/c 的稳健估计需要分散的多考生样本」对 n=1 直接成立——单考生无法提供分散的能力分布。这与决策总账「a/c 钉软轨低置信不是工程代价否决、是 n=1 无 cohort 的有效性天花板」完全一致。即：选 PFA 不是因为它能做全部，而是它在 n=1 可估的边界内做到最多，把不可估的部分诚实钉软轨。

---

## 来源核验表

> 全部经 WebSearch 联网核验。引用量级取自搜索结果中 Semantic Scholar / Google Scholar / 各源页面的量级提示；未在搜索中拿到精确数字的标「量级估计」。权威等级按调研者综合 venue 声誉 + 引用量给出（说明性，非官方排名）。

| 标识(ID/DOI) | 标题 | 作者 | venue | 年 | 引用量级 | 同行评审 | 联网核验结果 | 权威等级 |
|---|---|---|---|---|---|---|---|---|
| DOI 10.1007/BF01099821 | Knowledge Tracing: Modeling the Acquisition of Procedural Knowledge | Corbett & Anderson | User Modeling and User-Adapted Interaction, 4(4):253-278 | 1994 | 数千（KT 奠基，~4000+ 量级） | 是（期刊，Springer） | 确认存在（Springer + CMU ACT-R 双源） | 奠基性经典（BKT 起源，领域基石） |
| AIED 2009（ERIC ED506305） | Performance Factors Analysis — A New Alternative to Knowledge Tracing | Pavlik, Cen & Koedinger | Proc. 14th Intl. Conf. on AI in Education (Frontiers in AI and Applications v200, 531-538) | 2009 | 数百-上千（~900+ 量级） | 是（会议，AIED） | 确认存在（CMU PACT + ERIC + ACM 多源） | 奠基性（PFA 起源；AIED 为 EDM/ITS 主力会议） |
| DOI 10.1007/11774303_17 | Learning Factors Analysis — A General Method for Cognitive Model Evaluation and Improvement | Cen, Koedinger & Junker | Intelligent Tutoring Systems (ITS 2006), LNCS 4053, 164-175 | 2006 | 数百（~600+ 量级） | 是（会议，Springer LNCS） | 确认存在（CMU PACT + Springer） | 高（PFA 的方法学前身；ITS 为领域核心会议） |
| NeurIPS 2015（hash bac9162b…） | Deep Knowledge Tracing | Piech, Bassen, Huang, Ganguli, Sahami, Guibas, Sohl-Dickstein | Advances in Neural Information Processing Systems 28, 505-513 | 2015 | >1200（搜索结果明示） | 是（NeurIPS，CCF-A / CORE A*） | 确认存在（NeurIPS proceedings 官方） | 顶级（NeurIPS；DKT 起源） |
| DOI 10.1145/3394486.3403282 | Context-Aware Attentive Knowledge Tracing | Ghosh, Heffernan & Lan | Proc. 26th ACM SIGKDD (KDD '20), 2330-2339 | 2020 | 数百（~700+ 量级） | 是（KDD，CCF-A / CORE A*） | 确认存在（KDD 官方 + ACM DL + arXiv 2007.12324 + dblp） | 顶级（KDD；AKT 起源） |
| arXiv 1907.06837 / EDM 2019 | A Self-Attentive Model for Knowledge Tracing | Pandey & Karypis | Proc. 12th Intl. Conf. on Educational Data Mining (EDM 2019), 384-389 | 2019 | 数百（~600+ 量级） | 是（EDM 会议论文；arXiv 版为预印本） | 确认存在（arXiv + ERIC ED599186 + EDM proceedings） | 高（EDM 为领域旗舰会议；正式发表非仅预印本） |
| DOI 10.1145/3308558.3313565 | Augmenting Knowledge Tracing by Considering Forgetting Behavior | Nagatani, Zhang, Sato, Chen, Chen, Ohkuma | The World Wide Web Conference (WWW '19), 3101-3107 | 2019 | 数百（~400+ 量级） | 是（WWW/TheWebConf，CCF-A / CORE A*） | 确认存在（ACM DL 官方 + dblp 隐含） | 顶级（WWW；DKT-Forget 起源） |
| DOI 10.1145/3437963.3441802 | Temporal Cross-Effects in Knowledge Tracing | Wang, Ma, Zhang, Lv, Wan, Lin, Tang, Liu, Ma | Proc. 14th ACM Intl. Conf. on Web Search and Data Mining (WSDM '21), 517-525 | 2021 | 数百（~200+ 量级） | 是（WSDM，CCF-B / CORE A*） | 确认存在（ACM DL + THUIR PDF + dblp + 官方 GitHub THUwangcy/HawkesKT） | 高（WSDM；HawkesKT 起源） |
| DOI 10.1145/3132847.3132929 | Tracking Knowledge Proficiency of Students with Educational Priors | Chen, Liu, Huang, Wu, Chen, Wu, Su, Hu | Proc. 2017 ACM CIKM, 989-998 | 2017 | 数百（~300+ 量级，含 TOIS 2020 期刊扩展引用） | 是（CIKM，CCF-B / CORE A*） | 确认存在（USTC PDF + ACM DL；TOIS 2020 扩展可查） | 高（CIKM；KPT 起源） |
| DOI 10.5281/zenodo.4143614 / EJ1273917 | When is Deep Learning the Best Approach to Knowledge Tracing? | Gervet, Koedinger, Schneider, Mitchell | Journal of Educational Data Mining, 12(3):31-54 | 2020 | 数百（~300+ 量级） | 是（JEDM，领域专刊；开放获取） | 确认存在（ERIC EJ1273917 + Zenodo + 作者站 PDF + Semantic Scholar） | 高（JEDM 为 EDM 领域核心期刊；本调研最强实证地基） |
| arXiv 1604.02416 / EDM 2016 | How Deep is Knowledge Tracing? | Khajah, Lindsey & Mozer | Proc. 9th Intl. Conf. on Educational Data Mining (EDM 2016) | 2016 | 数百（~400+ 量级） | 是（EDM 会议；arXiv 版为预印本） | 确认存在（ERIC ED592694 + arXiv + Semantic Scholar） | 高（EDM；DKT vs BKT 机制质疑的关键引用） |
| DOI 10.1145/3569576 | Knowledge Tracing: A Survey | Abdelrahman, Wang & Nunes | ACM Computing Surveys, 55(11), Article 224, 1-37 | 2023 | 数百（综述，~400+ 量级且快速增长） | 是（ACM CSUR，影响因子极高的综述期刊，JCR Q1） | 确认存在（ACM DL 官方 + Unpaywall + scinapse） | 顶级（CSUR 是 CS 综述最高 venue 之一） |
| DOI 10.1007/BF02294761 | Specifying Optimum Examinees for Item Parameter Estimation in Item Response Theory | Stocking | Psychometrika, 55:461-475 | 1990 | 数百（经典心理测量，~300+ 量级） | 是（Psychometrika，心理测量学顶刊，JCR Q1） | 确认存在（Springer + Cambridge Core；1988 ETS 报告前身亦可查） | 高（Psychometrika 奠基性方法学；a/c 标定约束的经典依据） |

**诚实标注（违反铁律即作废，故逐条交代）：**
1. **引用量为「量级估计」**：WebSearch 仅对 DKT 给出精确「>1200」，其余从 venue 声誉 + 年份 + 综述/复现频次推断量级，未逐篇查 Google Scholar 精确数字。所有「~N+ 量级」均为保守下界估计，非精确计数。
2. **Stocking 1990 的语义边界**：该文核心是标定样本的**能力分布构成**（用信息函数找最优能力水平），**不直接规定样本量 N**。我在 §5 论证 5 已显式修正——把它用作「a/c 稳健估计需分散多考生样本 → n=1 死路」的依据，机制成立；但决策总账若把它读成「规定样本量」则是过度引申。
3. **SAKT / Khajah / Gervet 的 arXiv 版本属预印本**，但三者均有正式会议/期刊发表（EDM 2019 / EDM 2016 / JEDM 2020），核验表已标注「会议论文 + arXiv 预印本」双重身份，非纯未评审预印本。
4. **本调研未做的事**：未逐篇 WebFetch 全文核对公式逐字（PFA logit 公式、BKT 四参数表述取自搜索摘要 + 标准领域共识，非逐字引原文方程）；若需把公式写进正式 schema/ADR，建议对 Pavlik 2009 与 Corbett 1994 做一次 WebFetch 全文核对。

---

## Linear issue 捕获门

本任务为纯文献调研/地基补全，**产出为本调研结论文本本身**，无代码/schema 变更。发现的唯一可执行 follow-up：

- **建议（非阻塞）**：决策总账 §1 B1 当前对 Stocking 1990 的引用措辞可微调为「a/c 稳健估计需能力分布分散的多考生标定样本（Stocking 1990），n=1 无法提供 → 死路」，避免被读成「规定样本量 N」。这是措辞精确性建议，**不需要新建 Linear issue**（属决策总账下一次编辑时顺手收口的文档级微调，已在本调研 §5 论证 5 + 核验表诚实标注 2 留痕）。

无其他需要新建 Linear issue 的 follow-up。

---

## 相关文件路径
- 决策总账（本调研锚点）：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-decisions-ledger.md`（§1 B1 掌握诊断 / KT 选 PFA 条目 line 40-43）
- 配套 Phase 1 调研：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase1-research.md`（§5 选 PFA 弃四引擎原始判断）

---

## Lane 4 · n=1 标定可行性调研

确认了 —— 这些引用目前只散落在决策总账和 phase2 synthesis 文档里，没有一份带「来源核验」的正式文献地基。这次调研正是首次正式存盘。我已经收集到全部所需文献，质量充分。

最后做 Linear issue 捕获门：这是调研任务，产出是文献地基本身，不引入需要独立追踪的代码 follow-up。本轮无需新建 Linear issue —— 调研结论会回流到 §1 B1 与未来 calibration epic 的 spec 阶段，而非独立 actionable ticket。

下面是完整产出。

---

# n=1 单用户标定能力边界 · 文献地基（慢热四阶段）

> **范围**：为决策总账 §1 B1「全诊断栈但分轨 + 慢热自校准四阶段」补正式文献地基。所有引用已联网核验存在性，核验表在末尾。
> **核心判据**：单用户无 cohort，到底能标定到什么程度。

---

## 0. 一句话净结论（先给答案）

n=1 + 已知参数锚题的前提下，**owner 能力 θ 与（挂到公共量尺的）题目难度 b 是可估的**（fixed-anchor linking + Elo/Urnings 在线追踪 + PPI 用 LLM 合成补真值）。而**区分度 a、猜测 c、CDM 的 slip/guess** 是 n=1 的**结构性不可估**——不是工程代价问题，是无 cohort 的认识论天花板（Stocking 1990 的信息函数论证）。LLM 不能当判分诊断器（直接 prompt 估难度 r≈0，已溯源），但能当冷启先验（模拟考生 ensemble r=0.75–0.82 / 抽教学特征 r≈0.78，均已溯源到真实论文）。慢热四阶段每阶段的支撑强弱：①LLM 先验=中（预印本为主）/ ②Elo=强（Q1 期刊+大规模实证）/ ③fixed-anchor+PPI=强（顶刊方法论奠基）/ ④外推=弱（机制合理，无 n=1 直证）。

---

## 1. Fixed-anchor / linking：把单用户答题挂上公共量尺

**机制**。IRT 里两套题的参数只有放到同一量尺才可比。Fixed Parameter Calibration（FPC）的做法：以一个已知 item 参数的基准量尺为锚，新题校准时把**锚题参数钉死在已知值**，新题与考生 θ 都被拉到这条既有量尺上（Kolen & Brennan 2004 奠基；Kim 2006 FPC）。数学根基：不同校准批次的 IRT 参数估计**线性相关**，一条线性变换即可换尺而不改变答对概率（Kolen & Brennan）。

**前提**。(a) 锚题参数「测量不变」——难度跨时间稳定；(b) 锚题与目标题共享构念；(c) 锚题比例足够——限题库 + 模型轻度失配下，文献建议锚题占比 >20%（Rasch linking 研究，PMC8289883）。

**单用户下的有效性边界**。这是 n=1 标定的**关键解锁点**：传统 IRT 估难度需要 cohort（数百考生答同一题）；但若题目难度 b 已由**外部公共锚**给定（LLM 先验 / 公开题库 / 历史均值），那么 owner 一个人的作答就能通过 fixed-anchor 把**自己的 θ** 挂到这条尺上——θ 的估计本就是 per-person 的，n=1 天然满足。**所以 b（来自锚）+ θ（owner 自估）这条「硬轨」在 n=1 闭环可行**，正是决策总账 B1「b/θ 进硬轨」的文献根据。反过来，若想用 owner 一个人的作答去**估题目的 b/a**（而非用现成锚），则退化为 N=1 校准样本——不可行。

---

## 2. PPI（Prediction-Powered Inference）：LLM 合成 + 少量真值的统计保证

**论文**。Angelopoulos, Bates, Fannjiang, Jordan, Zrnic (2023), "Prediction-powered inference," *Science* 382(6671):669–674, DOI 10.1126/science.adi6000。**已联网确认存在**（Science 官网 + Berkeley 作者主页 + Semantic Scholar）。后续高效变体 PPI++（arXiv:2311.01453）+ cross-PPI（*PNAS* 2024）。

**机制**。有大量「模型预测值」+ 少量「金标真值」时，PPI 构造的置信区间/p 值**同时满足两点**：(1) 统计有效（不因模型有偏而失真——靠少量真值做去偏校正项 rectifier）；(2) **比只用少量真值更窄**（模型越准，区间越窄）。即数学上保证「合成 + 少量真值 ≥ 只用真值」，且永远不会比只用真值更差。

**能否用到本项目「LLM 合成标定 + owner 少量客观题真答」**。**可以，且这是教科书级对口场景**。映射：LLM 模拟考生/抽特征产出的难度估计 = PPI 的「模型预测」（量大、可能有偏）；owner 真实作答的**客观题确定判分** = PPI 的「金标真值」（量少、无偏，决策总账里的 fixed-anchor 干净锚）。PPI 给的正是 B1「PPI（数学保证合成≥只用真答）」这句话的严格出处——去偏校正项 = decision ledger 里说的「残差=miscalibration 信号」。
**诚实边界**：PPI 的有效性保证建立在「真值是 i.i.d. 抽样」的前提上；owner 客观题不是随机抽样的（是 active learning 选出来的），严格用需要按 cross-PPI / 加权 PPI 处理抽样偏置——这是落地时要钉的细节，不是否决项。

---

## 3. Elo / Urnings：单用户在线追 θ

**Elo 教育应用——综述**。Pelánek (2016), "Applications of the Elo rating system in adaptive educational systems," *Computers & Education* 98:169–179。**已确认**（ScienceDirect + ACM DL + Semantic Scholar）。把「学生答题」当「学生 vs 题目的一场对局」，每次作答后用 O(1) 简单公式更新学生能力 + 题目难度。配套细化版：Pelánek et al. (2017), "Elo-based learner modeling...," *UMUAI* 27:89–118。

**Elo 教育落地——奠基实证**。Klinkenberg, Straatemeier, van der Maas (2011), "Computer adaptive practice of Maths ability using a new item response model for on the fly ability and difficulty estimation," *Computers & Education* 57(2):1813–1824, DOI 10.1016/j.compedu.2011.02.003。**已确认**。Math Garden/Rekentuin 系统：3648 名儿童、10 个月、350 万道题，Elo 实时估能力+难度，**item 选择按目标答对率 .75 抽样**（直接对应 §5 active learning）。后扩到 40 万+ 学童。

**Urnings——已知误差分布的改进**。**重要修正**：决策总账写的「Urnings（Brinkhuis & Maris）」，主论文实为 **Bolsinova, Maris, Hofman, van der Maas, Brinkhuis (2022), "Urnings: A new method for tracking dynamically changing parameters in paired comparison systems," *JRSS-C* 71(1):91–118**（Brinkhuis & Maris 是更早 2009/2010 的前序工作，提出 Elo 方差膨胀问题）。**已确认**。机制：每个 person/item 用一个装红绿球的「瓮」表示，每次作答按 Metropolis-Hastings 接受概率交换球，平衡态下 urning 是二项分布、logit 即 Rasch 能力/难度。

**单用户适配性**。Elo/Urnings 都是 O(1) 在线更新、吃稀疏、第一条证据就动——契合 owner 边用边攒数据。**Urnings 相对 Elo 的两个 n=1 关键优势**：(1) **已知误差分布 → 能算标准误 → 能做统计推断**（Elo 的痛点是稳态下无已知误差分布，方差膨胀，Brinkhuis & Maris 2009 指出）；(2) **显式校正自适应选题偏置**——这点对本项目尤其要命，因为决策总账要 active-learning 选题（p≈0.5），不校正会让 θ 估计失真。**这是 B1「锁 item 难度防方差膨胀」的直接出处**：锁住 item 难度（用 fixed-anchor）+ 用 Urnings 类已知误差分布的更新，就能在单用户在线追 θ 时控制方差。

---

## 4. LLM 做题目标定的实证：三个相关系数全部溯源

> 这是任务里最关键的「数字溯源」。决策总账引用了 r≈0 / r≈0.78 / r=0.75–0.82 三个数，之前没核源。**结论：三个数全部溯源到真实论文，无一编造。**

**(a) 直接 prompt 估难度 r≈0 — 溯源成功**。出处：Acquaye, Huang, Carpuat, Rudinger (2026), "Take Out Your Calculators: Estimating the Real Difficulty of Question Items with LLM Student Simulations," arXiv:2601.09953 [cs.CL]。**已联网确认全文**。直接 prompt（GPT-4o 等 6 模型 × grades 4/8/12）相关性全程**贴近 0**：整体 Pearson r ∈ [−0.139, 0.137]；GPT-4o 具体 r = 0.15/0.06/0.01（G4/G8/G12）。论文原话「LLMs are poor direct judges of problem difficulty」，且「GPT-4o 同样弱 → 失败不是模型能力的函数」。**这就是 B1「直接 prompt 估难度 r≈0」的精确出处。**

**(b) LLM 模拟考生 ensemble r=0.75–0.82 — 溯源成功（同一篇）**。同篇 arXiv:2601.09953：让 LLM role-play 不同水平学生 → 对模拟作答拟合 IRT → 难度参数对照真实 NAEP 统计，**weighted ensemble（Gemma 系）相关 = 0.75/0.76/0.82（G4/G8/G12）**。完全对上决策总账「模拟考生 ensemble、客观题 r=0.75-0.82」。有趣旁证（也对上 B1「弱模型优先」）：数学能力弱的 Gemma 反而比强模型（Llama/Qwen）预测真实难度更准。

**(c) LLM 抽教学特征 r≈0.78 — 溯源成功（另一篇）**。出处：Hoyl (2026), "Synthetic Student Responses: LLM-Extracted Features for IRT Difficulty Parameter Estimation," arXiv:2602.00034（Stanford School of Education）。**已联网确认全文**。方法：LLM 抽教学特征（解题步数、认知复杂度、潜在误解）+ 语言/结构特征 → 神经网络模拟答题 → 1PL IRT 导出难度。25 万+ 数学题答案，**完全未见过的新题上 Pearson r ≈ 0.78**。这是 B1「抽教学特征 r≈0.78」的精确出处。
**诚实标注**：(1) 这是**单作者、Stanford 教育学院预印本、未经同行评审**——权威性低于上面的期刊文献，引用时必须显式标「预印本」。(2) 决策总账若把 0.78 与「random forest」绑定是**轻微失准**：原文用的是「神经网络 + IRT」，不是随机森林（相关文献里别的研究才用树模型，feature-based 树模型另有 r≈0.87 的结果，arXiv:2502.20663 等）。建议落地 spec 时改述为「LLM 抽特征 + 学习模型 + IRT，r≈0.78（Hoyl 2026 预印本，NN+IRT）」。

**(d) PFA 引擎本体（B1 落地综合体）**。Pavlik, Cen, Koedinger (2009), "Performance Factors Analysis – A New Alternative to Knowledge Tracing," Proc. AIED 2009, pp.531–538, IOS Press。**已确认**（CMU 数字仓库 + ERIC ED506305 + ACM DL）。logistic 回归形式、吃 per-KC 先验、第一条证据就更新——这是 B1 选 PFA 弃 BKT/DKT 的引擎出处。

---

## 5. Active learning 选题（Fisher info p≈0.5 + 先验分歧最大）

**Fisher info p≈0.5（单学习者 uncertainty）**。CAT 标准做法是选**当前 θ̂ 处 Fisher 信息最大**的题（MFI 准则）；Rasch 模型下等价于「选 b 最接近 θ̂ 的题」，即 **P(答对)≈0.5 的题信息量最大**（多篇 CAT 文献，PMC5968224 等）。Math Garden 实操取 .75（Klinkenberg 2011）——略偏简单以保动机，信息量与体验的权衡。**这是 B1「Fisher info p≈0.5」的出处**。
⚠️ **n=1 重要警示**（直接相关有效性边界）：MFI 在 θ 估计还差时不稳，且**会系统性偏好「a 估计为正误差 / c 估计为负误差」的题（capitalization on chance）**，calibration 样本越小越严重（Hambleton & Jones 1994，文献中转引）。对 n=1 = 这是 a/c 不可靠会**反噬选题**的机制证据 → 强化「item 难度锁死、只在硬轨选题」的设计。

**先验分歧最大（committee disagreement）**。理论根基：Settles (2009), "Active Learning Literature Survey," UW-Madison CS Tech Report 1648（**已确认，~6,400 引用，奠基性综述**）。Query-by-Committee：建多个模型，选**committee 分歧最大**的样本——等价于版本空间缩减最快 / 信息增益最大（BALD 类互信息准则）。映射到本项目「先验分歧最大」= 多个 LLM 先验（或多 persona ensemble）对某题难度估计**最不一致**时，owner 真答该题的边际信息最高。
**诚实标注**：Settles 是 ML 通用综述、非教育测量专文；「先验分歧最大」用于选题在教育场景是合理迁移，非该领域有专门 n=1 实证。

---

## 6. 诚实净结论：n=1 下什么可估、什么结构性不可估

| 量 | n=1 可估性 | 机制/前提 | 文献支撑强弱 |
|---|---|---|---|
| **θ（owner 能力，per-KC）** | ✅ 可估 | fixed-anchor 挂尺 + Elo/Urnings 在线追 | **强**（Q1 期刊 + 大规模实证 Klinkenberg/Pelánek/Bolsinova） |
| **b（题目难度）** | ✅ 可估（**靠外部锚，非 owner 自估**） | LLM 先验/公开题库给 b，owner 作答经 PPI 去偏 | **中-强**（linking 方法奠基强 + LLM 先验预印本为主） |
| **a（区分度）** | ❌ 结构性不可估 | 估 a 需 cohort——贡献 b 估计的考生对 a 估计贡献极小（Stocking 1990 信息函数论证） | **强**（Stocking 1990 Psychometrika Q1，n=1 死路的直接论证） |
| **c（猜测）** | ❌ 结构性不可估 | 常规样本「不够估 guessing」（Stocking 后续多目标编程研究） | **强**（同上） |
| **slip/guess（CDM）** | ❌ 结构性不可估 | 同 cohort 约束；PFA per-KC p(L) 覆盖掌握画像，slip/guess 分解钉软轨 | **中**（机制清楚，n=1 无直证） |

**Stocking 1990 是 a/c 不可估的核心地基**：Stocking, M. (1990), "Specifying optimum examinees for item parameter estimation in item response theory," *Psychometrika* 55(3):461–475, DOI 10.1007/BF02294761。**已确认（Q1）**。核心论证：「贡献 difficulty 估计的考生，对 discrimination 估计贡献极小」——意味着估 a/c 需要**能力广泛分散的大样本**，单用户（一个固定 θ）原理上无法提供。后续多目标编程研究补刀：常规推荐样本适合估 b、3PL 下勉强够 a，但**不够估 guessing**。这正是决策总账「a/c 是 n=1 认识论死路 Stocking 1990」的精确出处——**且把它钉软轨不是工程代价否决，是有效性天花板**，与「不计代价 ≠ 不计有效性」一致。

**慢热四阶段逐阶段支撑强弱**：

| 阶段 | 内容 | 支撑强弱 | 主要文献 |
|---|---|---|---|
| ① 纯 LLM 先验 | 全低置信，只信相对排序 | **中**（实证为 2026 预印本，且必须用 simulation/feature 路线，非直接 prompt） | Acquaye 2026 / Hoyl 2026（均预印本） |
| ② Elo 追 θ | O(1) 在线更新能力 | **强**（Q1 期刊 + 40 万学童级实证） | Pelánek 2016 / Klinkenberg 2011 / Bolsinova 2022 |
| ③ fixed-anchor 纠偏 + PPI + 自检 | 锚题去偏 + 合成≥真值 | **强**（Science + Psychometrika + Kolen&Brennan 方法论奠基） | Angelopoulos 2023 / Kolen&Brennan 2004 / Stocking 1990 |
| ④ per-KC 滚动达标解锁开放题外推 | 客观题掌握外推到开放题 | **弱**（机制合理，但客观题→开放题的迁移有效性无 n=1 直证；最易过度自信） | 无直接文献，属产品决策需埋点验证 |

**给路线图的两条诚实提醒**：
1. **第④阶段是最薄的一环**——「客观题硬轨标定外推到古文开放题」没有文献保证，且开放题判分本就是软轨低置信。建议落地时把外推标成「propose-only + 显式低置信」，靠 owner 复盘回执做事后校验，不要当成已标定。
2. **LLM 先验那一层全是 2026 年的预印本**（Acquaye / Hoyl）。数字（0.75–0.82 / 0.78）真实可溯，但未经同行评审，且都在**数学/阅读**领域、**英文**——**对古文（décision ledger 已知短板）无任何直证**，相对排序可用，绝对值必须当先验而非真值，靠 ②③ 阶段的 Elo+PPI 慢热纠偏。这与决策总账「LLM 当冷启先验非判分诊断器」完全一致。

---

## 来源核验表

| 标识(ID/DOI) | 标题 | 作者 | venue | 年 | 引用量级 | 同行评审 | 联网核验 | 权威等级 |
|---|---|---|---|---|---|---|---|---|
| DOI 10.1126/science.adi6000 | Prediction-powered inference | Angelopoulos, Bates, Fannjiang, Jordan, Zrnic | *Science* 382(6671):669–674 | 2023 | 数百（Science 顶刊，增长快） | 是 | **确认存在**（Science官网+Berkeley主页+SemSch） | **顶级**（Science，多学科最高梯队） |
| DOI 10.1007/BF02294761 | Specifying optimum examinees for item parameter estimation in IRT | Stocking, M. L. | *Psychometrika* 55(3):461–475 | 1990 | 数百（心理测量奠基级） | 是 | **确认存在**（Springer+Cambridge Core） | **高**（Psychometrika，JCR/SJR Q1，IF 3.1） |
| DOI 10.1016/j.compedu.2016.03.017 | Applications of the Elo rating system in adaptive educational systems | Pelánek, R. | *Computers & Education* 98:169–179 | 2016 | 数百 | 是 | **确认存在**（ScienceDirect+ACM DL） | **高**（C&E，JCR Q1，IF 10.5） |
| DOI 10.1016/j.compedu.2011.02.003 | Computer adaptive practice of Maths ability...on the fly ability and difficulty estimation | Klinkenberg, Straatemeier, van der Maas | *Computers & Education* 57(2):1813–1824 | 2011 | 数百（Math Garden 奠基实证） | 是 | **确认存在**（ScienceDirect+ACM DL） | **高**（C&E，JCR Q1） |
| DOI 10.1111/rssc.12523（JRSS-C 71(1):91–118） | Urnings: A new method for tracking dynamically changing parameters in paired comparison systems | Bolsinova, Maris, Hofman, van der Maas, Brinkhuis | *JRSS-C (Applied Statistics)* 71(1):91–118 | 2022 | 数十 | 是 | **确认存在**（Oxford Academic JRSS-C） | **高**（JRSS-C，统计学 Q1）；⚠️决策总账误记为「Brinkhuis&Maris」 |
| (UMUAI 27:89–118) | Elo-based learner modeling for the adaptive practice of facts | Pelánek, Papoušek, Řihák, Stanislav, Nižnan | *UMUAI* 27 | 2017 | 数百 | 是 | **确认存在**（Springer+SemSch） | **高**（UMUAI，用户建模顶刊，CORE A 关联） |
| ERIC ED506305 / ACM 10.5555/1659450.1659529 | Performance Factors Analysis – A New Alternative to Knowledge Tracing | Pavlik, Cen, Koedinger | Proc. *AIED 2009*, 531–538 | 2009 | 数百-上千（EDM 奠基） | 是（会议） | **确认存在**（CMU仓库+ERIC+ACM DL） | **高**（AIED，CORE **A**，AI-in-Ed 顶会） |
| Kolen & Brennan (Springer book) | Test Equating, Scaling, and Linking: Methods and Practices | Kolen, M. J. & Brennan, R. L. | Springer（专著，2nd/3rd ed.） | 2004/2014 | 数千（linking 领域奠基专著） | 是（学术专著） | **确认存在**（多篇 linking 论文一致引用） | **高**（IRT linking 领域奠基教科书） |
| arXiv:2601.09953 [cs.CL] | Take Out Your Calculators: Estimating the Real Difficulty of Question Items with LLM Student Simulations | Acquaye, Huang, Carpuat, Rudinger | arXiv 预印本 | 2026 | 新（<1年，低） | **预印本未评审** | **确认存在**（arXiv全文，含 Table 3/13/14 数值） | **预印本**（数值真实可溯：r≈0 直接prompt + 0.75/0.76/0.82 ensemble；作者含 Carpuat/Rudinger，UMD NLP 知名组） |
| arXiv:2602.00034 | Synthetic Student Responses: LLM-Extracted Features for IRT Difficulty Parameter Estimation | Hoyl, M. | arXiv 预印本（Stanford 教育学院） | 2026 | 新（<1年，低） | **预印本未评审** | **确认存在**（arXiv全文+Stanford仓库，r≈0.78） | **预印本**（单作者；r≈0.78 真实，但决策总账「random forest」表述失准，实为 NN+IRT） |
| arXiv:2502.17785 | Exploring the Potential of LLMs for Estimating Reading Comprehension Question Difficulty | Jain, Hollander, He, Tang, Zhang, Sabatini | arXiv 预印本 | 2025 | 新，低 | **预印本未评审** | **确认存在；但本文不含任何相关系数**（只有 accuracy %），不可作为 r≈0 出处 | **预印本**（澄清用：曾被误当 r≈0 源，实际 r≈0 出处是 arXiv:2601.09953） |
| UW-Madison CS TR 1648 | Active Learning Literature Survey | Settles, B. | 技术报告（非正式发表） | 2009 | **~6,400**（奠基级） | **非同行评审**（tech report） | **确认存在**（UW仓库+SemSch标 Highly Influential） | **奠基性**（active learning 最权威综述；但属 tech report，非期刊/会议） |

**核验表总结**：核心方法论地基（PPI/Stocking/Elo/linking/PFA）全部为 Q1 期刊或 CORE-A 会议或奠基专著，**强**。三个 LLM 标定相关系数（r≈0 / 0.78 / 0.75–0.82）**全部溯源成功、无编造**，但均来自 **2026 预印本**——数字真实，权威性受限于未评审，且领域为英文数学/阅读，对古文无直证。两处需修正决策总账措辞：(1) Urnings 主论文作者应为 **Bolsinova et al. 2022 JRSS-C**（非 Brinkhuis & Maris）；(2) r≈0.78 的方法是 **NN+IRT**（非 random forest）。一处澄清：r≈0 的真实出处是 **arXiv:2601.09953**（非常被关联的 reading-comprehension 那篇，那篇根本不报相关系数）。

**相关文件路径**：决策总账 `/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-decisions-ledger.md`（§1 B1，本地基的对接锚点）；现有散落引用见 `docs/design/2026-06-14-product-rethink-phase2-synthesis.md` 与 `...phase2-synthesis-lanes.md`（本轮首次为这块做带核验的正式存盘）。

**Linear**：本轮为调研任务，产出即文献地基本身，未引入需独立追踪的代码 follow-up，无需新建 Linear issue；结论将回流到 §1 B1 与未来 calibration epic 的 spec 阶段。

---

## Audit · 对抗性权威审计

Confirmed: **"Dueñas et al. 2024" cannot be located** — the IRT lane's "无法核实" call was correct. The real LLM-simulation-for-IRT papers in this space are Lu & Wang 2024 (Generative Students), Benedetto et al. 2024, Liu et al. 2024, and SMART (Scarlatos 2025). The IRT lane correctly declined to cite Dueñas as a primary source.

I now have comprehensive verification across all four lanes. Producing the final adversarial audit.

---

# 对抗性来源权威审计 —— 四路调研（IRT / CDM / KT / n=1 标定）汇总复核

诚实声明：我对 22 个不重复来源做了独立联网核验（WebSearch/WebFetch），覆盖全部 arXiv ID、DOI、作者组合、以及最 load-bearing 的数字声称。**重大裁定：没有任何一条疑似编造（hallucinate）的引用。** 四路的来源诚实自标普遍到位，甚至偏保守。问题集中在两类：(a) 跨路 ID/作者**误配**（同一个 r 值挂错论文）；(b) **欠claim**（把已正式发表的会议论文当裸预印本）。下面三节给完整裁定。

---

## ① 修正后的全局来源核验表（合并去重 + 复核裁定）

裁定列：**确认** = 我联网核到一手/权威源，标题+作者+venue+年一致；**确认·修正** = 存在但四路某条措辞/ID/作者有误；**存疑** = 存在但具体声称未坐实；**无法核实** = 核不到，不应作正式地基。

| # | 标识(DOI/arXiv ID) | 标题(简) | 作者 | venue | 年 | 引用量级 | 同行评审 | 复核裁定 | 权威等级 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 10.1007/BF02294761 | Specifying optimum examinees for item parameter estimation | M. L. Stocking | Psychometrika 55(3):461-475 | 1990 | 数百 | 是 | **确认**（摘要逐字核到："examinees who contribute maximally to...difficulty contribute little to...discrimination"+"ability is widely dispersed"） | 高·Q1（a/c 死路核心地基） |
| 2 | 10.1007/BF02294434 | Optimum examinee samples...multi-objective programming | (Stocking 后续) | Psychometrika | — | 数十 | 是 | **确认**（补 guessing 不可估的那一刀，搜索中浮现，可作 c 不可估的二级源） | 高·Q1 |
| 3 | 10.1126/science.adi6000 | Prediction-powered inference | Angelopoulos, Bates, Fannjiang, Jordan, Zrnic | Science 382(6671):669-674 | 2023 | 数百 | 是 | **确认**（PMID 37943906，5 作者全对） | 顶级·Science |
| 4 | 10.1016/j.compedu.2016.03.017 | Applications of the Elo rating system in adaptive ed. | R. Pelánek | Computers & Education 98:169-179 | 2016 | 数百 | 是 | **确认** | 高·Q1 |
| 5 | 10.1016/j.compedu.2011.02.003 | Computer adaptive practice of Maths ability...on the fly | Klinkenberg, Straatemeier, van der Maas | Computers & Education 57(2):1813-1824 | 2011 | 数百 | 是 | **确认**（3648 儿童/10 月/3.5M 题/.75 抽样 全部逐字核对） | 高·Q1（Math Garden 实证，n=1 最强在野证据） |
| 6 | 10.1111/rssc.12523 | Urnings: tracking dynamically changing parameters | **Bolsinova, Maris, Hofman, van der Maas, Brinkhuis** | JRSS-C 71(1):91-118 | 2022 | 数十 | 是 | **确认·修正**（决策总账误记作者为「Brinkhuis & Maris」；主论文是 Bolsinova et al. 2022 五作者；n=1/IRT 两路均已抓到此误，正确） | 高·Q1 |
| 7 | (UMUAI 27:89-118) | Elo-based learner modeling for adaptive practice of facts | Pelánek, Papoušek, Řihák, Stanislav, Nižnan | UMUAI 27 | 2017 | 数百 | 是 | **确认** | 高（UMUAI 用户建模旗舰） |
| 8 | ISBN/专著 | Test Equating, Scaling, and Linking | Kolen & Brennan | Springer 专著 | 2004/2014 | 数千 | 是(专著) | **确认**（linking/fixed-anchor 奠基教材，多源一致引） | 高·教材权威 |
| 9 | arXiv:2601.09953 | Take Out Your Calculators (LLM student simulations) | Acquaye, Huang, Carpuat, Rudinger (UMD) | arXiv 预印本 | 2026 | 低(新) | **预印本** | **确认**（全文核到：直接 prompt r∈[-0.139,0.137]≈0；ensemble r=0.75/0.76/0.82 G4/8/12；弱模型 Gemma 反优——全部逐字对上） | 预印本·数值真实可溯 |
| 10 | arXiv:2602.00034 | Synthetic Student Responses (LLM-extracted features for IRT) | M. Hoyl (Stanford 教育学院) | arXiv 预印本 + Stanford Digital Repository | 2026 | 低(新) | **预印本·单作者** | **确认·修正**（r≈0.78 真实；方法是 **NN+IRT 两阶段**，非 random forest——n=1 路已抓到此误，正确） | 预印本·权威低 |
| 11 | arXiv:2504.08804 | Estimating Item Difficulty Using LLMs and Tree-Based ML | Razavi & Powers (Edmentum) | arXiv 预印本（v1 2025-04，v2 2026-03） | 2025 | 低 | **预印本** | **确认·修正**（feature-based 树集成 **r=0.87, N=5170** 坐实；但 IRT 路与 n=1 路对此论文的 ID 与 r 值出现互相矛盾的误配——见②清单 #2） | 预印本 |
| 12 | arXiv:2502.20663 | Prediction of Item Difficulty...Annotated Item Repository | Kapoor, Truong, Haber, Ruiz-Primo, Domingue (Stanford) | arXiv 预印本 | 2025 | 低 | **预印本** | **确认·修正**（此文是 **penalized regression r=0.77**，非「random forest r=0.87」；n=1 路把 0.87 误挂到此 ID） | 预印本 |
| 13 | arXiv:2507.05129 | SMART: Simulated Students Aligned with IRT | Scarlatos, Fernandez, Ormerod, Lottridge, Lan (UMass/Cambium) | **EMNLP 2025**（aclanthology 2025.emnlp-main.1274） | 2025 | 低-中 | **是·已正式发表(EMNLP)** | **确认·修正**（IRT 路标「预印本未评审/未逐字核验作者/引用力度弱」**严重低估**——这是 EMNLP 2025 正式 main track，CORE-A NLP 顶会，作者已核） | 高·CORE-A 会议（被错降为预印本） |
| 14 | (无;转述) | (GPT-3.5 模拟医考生 IRT) | Dueñas et al.(声称) | 未定位 | 2024 | — | — | **无法核实**（核不到任何 Dueñas 2024 匹配；该空间真实论文是 Lu&Wang 2024 / Benedetto 2024 / Liu 2024；IRT 路已自标「不作正式引用」，正确） | 不可引用 |
| 15 | (声称) | (ML 难度预测当 Bayesian IRT prior) | Ulitzsch(声称) 2025 | 未定位精确 venue | 2025 | — | — | **存疑·部分平反**（确有 Ulitzsch et al. 2025「ML 难度预测整合进 IRT」工作，被 Frontiers in Education 2026 综述引用；但 IRT 路无法钉精确 venue/DOI，且「当 Bayesian prior」这一具体机制未坐实——IRT 路「不可引用、需 owner 补出处」的处置正确，但「疑似 hallucinate」是冤枉它了） | 存在但无法精确引用 |
| 16 | arXiv:2502.17785 | LLMs for Estimating Reading Comprehension Q Difficulty | Jain, Hollander, He, Tang, Zhang, Sabatini | arXiv 预印本 | 2025 | 低 | **预印本** | **确认**（n=1 路澄清「此文只报 accuracy，不含 r 值，不能当 r≈0 出处」——这是 n=1 路一条高质量的反向自查，正确） | 预印本 |
| 17 | 10.1111/j.1745-3984.1983.tb00212.x | Rule Space (Q-matrix 开山) | K. K. Tatsuoka | JEM 20(4):345-354 | 1983 | 数千 | 是 | **确认**（ERIC EJ296184；注意同年同刊还有 tb00201 另一篇，CDM 路引对了那篇） | 奠基·最高 |
| 18 | 10.1177/01466210122032064 | Cognitive Assessment Models...DINA/NIDA | Junker & Sijtsma | Applied Psych. Measurement 25(3):258-272 | 2001 | 千级 | 是 | **确认** | 高 |
| 19 | 10.1037/1082-989X.11.3.287 | Measurement of Psych. Disorders w/ CDM (DINO) | Templin & Henson | Psychological Methods 11(3):287-305 | 2006 | 千级 | 是 | **确认**（PMID 16953706） | 高·APA 顶刊 |
| 20 | 10.1007/s11336-011-9207-7 | The Generalized DINA Model Framework | J. de la Torre | Psychometrika 76(2):179-199 | 2011 | 千级 | 是 | **确认**（ERIC EJ921258） | 高·Q1 |
| 21 | 10.1111/j.1745-3984.2008.00069.x | Q-Matrix Validation for the DINA Model | J. de la Torre | JEM 45(4):343-362 | 2008 | ~296 | 是 | **确认** | 高 |
| 22 | (章节+博论) | RUM/Fusion Model 原始 + 重参数化 | DiBello/Stout/Roussos 1995；Hartz 2002 | Erlbaum 论文集章节；UIUC 博论 | 1995;2002 | 百-千 | **非期刊同评**（章节+学位论文） | **存疑·部分二手**（CDM 路诚实自标「一手全文未直接 fetch，经二手交叉转引确认」——处置诚实，但应保留「部分二手」标） | 中-高·载体非期刊 |
| 23 | ISBN 978-1-60623-527-0 | Diagnostic Measurement (DCM 教材) | Rupp, Templin, Henson | Guilford Press | 2010 | 千级 | 是(获 AERA 奖) | **确认** | 高·教材权威 |
| 24 | 10.1007/BF01099821 | Knowledge Tracing (BKT 开山) | Corbett & Anderson | UMUAI 4(4):253-278 | **1994/1995** | 数千 | 是 | **确认·小修**（年份多源标 1995、少数 1994；IRT/CDM 路写 1995，KT 路写 1994——内部不一致但都可辩护，建议统一为 1995） | 奠基·最高 |
| 25 | 10.1007/11774303_17 | Learning Factors Analysis (LFA, PFA 前身) | Cen, Koedinger & Junker | ITS 2006, LNCS 4053:164-175 | 2006 | 数百 | 是 | **确认**（注：KT 路正文一处写「Cen...2007」，年份漂移，正确是 2006） | 高 |
| 26 | ERIC ED506305 / ACM 10.5555/1659450.1659529 | Performance Factors Analysis (PFA 奠基) | Pavlik, Cen & Koedinger | AIED 2009, FAIA 200(1):531-538 | 2009 | 数百-千 | 是(会议) | **确认·存疑**（论文存在确认；但「PFA 略优于 BKT」「单错反应更温和」的**具体实证结论无法从摘要/搜索坐实**，三路都靠它做承重，属机制层转述非逐字——KT 路已自标此点，诚实） | 高（AIED 是 CORE-A/CCF-C 教育 AI 会议，非顶级 ML 会议） |
| 27 | NeurIPS 2015 | Deep Knowledge Tracing (DKT) | Piech et al. | NeurIPS 28:505-513 | 2015 | >1200 | 是 | **确认** | 顶级·NeurIPS |
| 28 | 10.1145/3394486.3403282 | Context-Aware Attentive KT (AKT) | Ghosh, Heffernan & Lan | KDD 2020:2330-2339 | 2020 | 数百 | 是 | **确认**（arXiv 2007.12324 镜像存在） | 顶级·KDD |
| 29 | arXiv:1907.06837 / EDM 2019 | Self-Attentive Model for KT (SAKT) | Pandey & Karypis | EDM 2019:384-389 | 2019 | 数百 | 是(会议)+预印本 | **确认** | 高·EDM |
| 30 | 10.1145/3308558.3313565 | Augmenting KT by Forgetting (DKT-Forget) | Nagatani et al. | WWW 2019:3101-3107 | 2019 | 数百 | 是 | **确认** | 顶级·WWW |
| 31 | 10.1145/3437963.3441802 | Temporal Cross-Effects in KT (HawkesKT) | Wang et al. | WSDM 2021:517-525 | 2021 | 数百 | 是 | **确认** | 高·WSDM |
| 32 | 10.1145/3132847.3132929 | Tracking Knowledge Proficiency (KPT) | Chen et al. | CIKM 2017:989-998 | 2017 | 数百 | 是 | **确认** | 高·CIKM |
| 33 | 10.5281/zenodo.4143614 / EJ1273917 | When is Deep Learning the Best Approach to KT? | Gervet, Koedinger, Schneider, Mitchell (CMU) | JEDM 12(3):31-54 | 2020 | 数百 | 是 | **确认**（关键句逐字核到："Logistic regression—with the right set of features—leads on datasets of moderate size or containing a very large number of interactions"——KT 路最强实证地基坐实） | 高·JEDM |
| 34 | arXiv:1604.02416 / EDM 2016 | How Deep is Knowledge Tracing? | Khajah, Lindsey & Mozer | EDM 2016 | 2016 | 数百 | 是(会议)+预印本 | **确认** | 高·EDM |
| 35 | 10.1145/3569576 | Knowledge Tracing: A Survey | Abdelrahman, Wang & Nunes | ACM Computing Surveys 55(11) | 2023 | 数百 | 是 | **确认** | 顶级·CSUR |
| 36 | UW-Madison CS TR 1648 | Active Learning Literature Survey | B. Settles | 技术报告(非正式发表) | 2009 | ~6400 | **非同行评审·tech report** | **确认**（n=1 路诚实标 tech report，正确） | 奠基·但非期刊/会议 |
| 37 | ISBN 0201043105 | Statistical Theories of Mental Test Scores | Lord & Novick (Birnbaum ch.17-20) | Addison-Wesley 专著 | 1968 | 数万 | 是 | **确认**（2PL/3PL logistic 奠基载体） | 奠基·经典 |
| 38 | ISBN 0898590067 | Applications of IRT to Practical Testing Problems | F. M. Lord | Erlbaum 专著 | 1980 | 万级 | 是 | **确认**（CAT 经典） | 奠基·经典 |
| 39 | (DPI 1960) | Probabilistic Models...Intelligence and Attainment | G. Rasch | Danish Inst. Educ. Research 专著 | 1960 | 万级 | 是 | **确认**（Rasch/1PL 充分统计量奠基） | 奠基·经典 |
| 40 | (Psychometrika Monograph No.17) | Estimation of latent ability...graded scores (GRM) | F. Samejima | Psychometrika Monograph Suppl. 34 | 1969 | 数千 | 是 | **确认** | 奠基·GRM |
| 41 | 10.1007/BF02296272 | A Rasch model for partial credit scoring (PCM) | G. N. Masters | Psychometrika 47:149-174 | 1982 | 数千 | 是 | **确认** | 奠基·PCM |

**核验覆盖诚实声明**：41 条里我对 25 条做了直接联网核验，其余（Lord&Novick、Lord 1980、Rasch 1960、Samejima、Masters、Junker&Sijtsma、Templin&Henson、Pelánek 系、KT 系深网论文 DKT/AKT/SAKT/DKT-F/HawkesKT/KPT/CSUR）属四路已各自联网核过且为领域内不存在争议的经典/顶会论文，我做了交叉一致性检查（venue/年/DOI 互不矛盾）但未逐条重复 fetch。**所有 arXiv ID（2601.09953 / 2602.00034 / 2504.08804 / 2502.20663 / 2507.05129 / 2502.17785 / 1907.06837 / 1604.02416）与所有声称的 DOI 我都至少抽查到一手或权威镜像，无一编造。**

---

## ② 过度声称 / 弱地基清单（每条：声称 → 压在什么源 → 严重度 → 建议措辞）

**【高严重度 —— 必须改，否则是错误信息】**

**H1. r≈0.87 的 arXiv ID 在两路间互相打架（n=1 路误配）**
- 声称：n=1 路核验表写「feature-based 树模型 r≈0.87（arXiv:2502.20663 等）」。
- 真相：**r=0.87（feature-based 树集成，N=5170）出自 Razavi & Powers, arXiv:2504.08804**；而 **arXiv:2502.20663（Kapoor et al., Stanford）是 penalized regression, r=0.77**，根本不是 0.87、也不是随机森林。IRT 路把 0.87 正确挂在 2504.08804，n=1 路挂错了 ID。
- 严重度：**高**（错误的 arXiv ID 会让 owner 引到错论文）。
- 建议措辞：删掉 n=1 路「(arXiv:2502.20663 等)」，统一改为「LLM 抽特征 + 树集成 r≈0.87（Razavi & Powers, arXiv:2504.08804, N=5170）」。2502.20663 若要保留，只能作为「penalized regression r=0.77」的独立条目。

**H2. SMART 被错降为「裸预印本、引用力度弱、作者未核」**
- 声称：IRT 路核验表写 SMART(arXiv:2507.05129)「预印本未评审 / 未逐字核验作者 / 引用力度弱」。
- 真相：**SMART 是 EMNLP 2025 main track 正式论文（aclanthology 2025.emnlp-main.1274, pp.25071-25094）**，作者 Scarlatos/Fernandez/Ormerod/Lottridge/Lan（UMass + Cambium Assessment），EMNLP 是 CORE-A / CCF-B NLP 顶会、同行评审。
- 严重度：**高**（这是**反方向**的错误——欠claim 让一个本可承重的顶会证据被当垃圾源丢弃）。
- 建议措辞：SMART 升级为「EMNLP 2025（CORE-A），同行评审，LLM 模拟考生路径的正式证据」，可作 B1「模拟考生 ensemble」的承重源之一（与 Acquaye 2026 预印本互补，且权威性更高）。

**【中严重度 —— 措辞收紧，避免误读】**

**M1. 「直接 prompt 估难度 r≈0」与 Razavi 的「moderate to strong」表面冲突**
- 声称：IRT 路写 Razavi「direct estimate 早年级差」；n=1 路写「直接 prompt → r≈0（Acquaye 2026）」。
- 真相：两个数都对，但**来自不同论文、不同结论**——Acquaye 2026 直接 prompt r∈[-0.14,0.14]≈0；Razavi 2504.08804 摘要却说 direct estimate「moderate to strong」（只是早年级差）。这是两篇论文对「直接 prompt」的结论**不一致**，不是同一结论。
- 严重度：**中**（净结论「直接 prompt 弱」压在 Acquaye 上成立，但不能拿 Razavi 当同向证据——Razavi 的 direct 反而偏正面）。
- 建议措辞：明确「直接 prompt 弱」的承重源是 **Acquaye 2026（r≈0）**；Razavi 2504.08804 的承重点只取它的 **feature-based r=0.87**，不要拿它的 direct-estimate 结论（与 Acquaye 矛盾）混引。

**M2. 「PFA 略优于 BKT / 对单错反应更温和」是机制转述，非逐字实证**
- 声称：KT 路 + CDM 路净结论都说「Pavlik 2009 原文实测 PFA 略优于 BKT」「BKT 单错猛砸、PFA 温和」。
- 真相：Pavlik 2009 论文确实做了 PFA vs KT 对比，但**具体 AUC/优劣幅度无法从摘要或搜索坐实**；「单错反应温和」是对模型机制的合理转述，非原文逐字数字。KT 路自己已在诚实标注 #4 承认「PFA>BKT 取自摘要+领域共识，未逐字 fetch 全文」。
- 严重度：**中**（结论方向对、领域共识支持，但若写进 ADR 当「实测结论」会过度声称）。
- 建议措辞：保留 KT 路的自标；落 spec 前对 Pavlik 2009 全文做一次 WebFetch 坐实 PFA>BKT 的具体数字，或改述为「PFA 在 Pavlik 2009 的对比中与 KT 相当或略优（机制上对单次错误的推断更平滑）」，不写「实测略优」。

**M3. 「IRT b = PFA β = FSRS D」等号 —— IRT 路自己已指出，确实该降格**
- 声称：决策总账 B1 用等号链「难度 b = PFA β = FSRS D」。
- 真相：三者同属 logit 位置/截距语义但单位不同（θ-度量位置 vs 回归截距 vs 记忆难度），需 linking 才严格等同。
- 严重度：**中**（IRT 路已抓到并建议降格为「同语义、需 linking 对齐」，我**确认此修正正确**）。
- 建议措辞：采纳 IRT 路建议，等号→「同 logit 语义，需 linking 对齐」。

**【低严重度 —— 记一笔即可】**

**L1. Corbett & Anderson 年份四路不一致（1994 vs 1995）**：多源主流标 1995，少数 1994（vol 4 issue 4 跨年）。IRT/CDM 写 1995，KT 写 1994。建议全仓统一 **1995**。

**L2. LFA 年份漂移**：KT 路正文一处写「Cen, Koedinger & Junker 2007」，核验表写 2006。正确是 **ITS 2006（LNCS 4053）**；2007 是误记。

**L3. Hoyl r≈0.78 的方法标注**：决策总账原写「random forest」，实为 **NN+IRT 两阶段**。n=1 路已抓到，**确认修正正确**。

**L4. Stocking 1990 不可读成「规定样本量 N」**：KT 路与 n=1 路都已诚实标注 Stocking 讲的是能力**分布/构成**而非样本量阈值。**确认此自查正确**——这是全corpus 最 load-bearing 的源，被两路主动收紧措辞，是诚实加分项。

**L5. Ulitzsch 2025 不是 hallucination、但不可精确引用**：确有 Ulitzsch et al. 2025「ML 难度预测整合进 IRT」工作（Frontiers in Education 2026 综述引之），但钉不到精确 venue/DOI，「当 Bayesian prior」的具体机制未坐实。IRT 路「不可引用、需 owner 补出处」的处置正确；唯一要平反的是别把它当「疑似编造」——它存在，只是 IRT 路没找到精确出处。

**L6. RUM/Fusion（DiBello/Stout/Roussos 1995 + Hartz 2002）一手未 fetch**：CDM 路诚实标「部分二手」，载体是论文集章节 + 博士论文（非期刊同评）。保留此标即可，不构成过度声称。

---

## ③ 四路覆盖缺口（对 n=1 地基至关重要、但四路漏掉或薄弱的引擎/方法/反证）

**G1. 「客观题→开放题外推」（慢热第④阶段）是全栈最薄环，且无任何引擎/文献兜底。**
n=1 路已诚实点名第④阶段「客观题硬轨标定外推到古文开放题」无文献保证、最易过度自信。但四路**没有一路去找 transfer learning / 跨题型迁移效度的反证或正证**。这是 n=1 地基里**唯一一处净结论悬空**的地方——B1 的整个「滚动达标解锁开放题」机制压在一个无文献支撑的产品假设上。建议补一路专门调研「构念迁移 / cross-format validity」或明确标注此环为 propose-only + 埋点事后验证（n=1 路已建议后者，但应升级为显式 gap）。

**G2. LLM 标定证据**全部是英文数学/阅读领域，对古文（项目核心科目）**零直证**——四路都提了，但没人去找中文/古典语言/低资源语言的 LLM 难度估计证据。** 三个 r 值（0.75-0.82 / 0.78 / 0.87）能否迁移到古文是**完全未验证的外推**。这是比「预印本未评审」更要命的 external validity 缺口：即使论文权威，domain 也不匹配。建议补「中文/古文 NLP 难度估计」专项检索，否则 B1 的 LLM 先验数字对本项目是「借来的、未验证的」。

**G3. 缺「fixed-anchor 的锚题从哪来」的工程可行性反证。** 三路都说「θ + b（来自外部锚）可估」，但 n=1 场景的锚题难度 b 要么来自 LLM 先验（预印本、英文域、未验证迁移），要么来自公开题库（古文有吗？）。**整条硬轨的地基质量 = 锚的质量**，而锚的质量目前压在 G2 的未验证外推上。这是个传导性缺口：硬轨号称「站得住」，但它站的地面（锚）本身是软的。建议把「锚来源 + 锚质量」作为独立风险项，不要让「θ/b 进硬轨」继承「锚已可靠」的隐含假设。

**G4. 缺对 Elo/Urnings「单序列 vs 多人对局」前提的反证审查。** Elo/Urnings 的全部实证（Math Garden 3648 儿童、chess、movie reviews）都是**多 agent 配对比较**系统——「学生 vs 题目」的对局之所以能更新题目难度，是因为有**很多学生打同一道题**。n=1 下只有一个学生，题目难度更新退化为「单人反复打同一题」，这与 Math Garden 的多人配对**不是同一个统计情形**。四路把 Elo/Urnings 当 n=1 在线追 θ 的成熟方案，但**没人审查「item 难度在 n=1 下还能不能在线更新」**——这恰恰回到 a/c/b 不可估的同一道墙：Elo 能在线追 θ（个体参数）没问题，但 Elo 同时在线更新的 item 难度在 n=1 下和 Stocking 的 b 估计一样需要被「锁死」（n=1 路其实点到了「锁 item 难度防方差膨胀」，但没把它和「Elo 的 item 更新在 n=1 失效」这个反证显式连起来）。建议显式声明：**n=1 下 Elo/Urnings 只用其 θ-更新半边，item-更新半边必须锁死用外部锚**——否则是把多人系统的能力错套到单人。

**G5. 四路无一覆盖 BKT 的现代贝叶斯/层次化变体（如 Bayesian hierarchical BKT、BKT+先验）作为「弃 BKT」的完整反方。** KT 路弃 BKT 的论证压在「四参数 HMM 需长序列解耦 slip/guess」，但**没审查「给 BKT 灌强先验/层次先验能不能救它到 n=1 可用」**——这正是它们给 PFA/CDM 都开的同一个逃逸阀（贝叶斯先验）。逻辑上若「PFA + LLM 先验」可行，「BKT + LLM 先验」为何不可行的对称反驳是缺失的。弃 BKT 的真正理由（PFA 的 per-KC 计数对单点更新更平滑、参数随交互而非学生数增长）成立，但应补一句「BKT 即便贝叶斯化仍受单技能 + slip/guess 结构所限」把反方堵死，否则选型论证有一个对称性漏洞。

---

**最终裁定一句话**：四路**无编造**，奠基地基（Stocking / PFA / Gervet / Tatsuoka / de la Torre / PPI / Klinkenberg / Urnings）全部联网坐实且最 load-bearing 的 Stocking a/c 死路是 corpus 里最硬的一块；需修的是 **2 条 ID/降级误配（H1 n=1 路 0.87 挂错 ID、H2 SMART 被错当预印本）+ 5 条措辞收紧 + 5 处域外推缺口**，其中 **G1（开放题外推无文献）与 G2（古文零直证）是对 n=1 地基最危险的两个未验证外推**，应在 B1 里从「净结论」降级为「显式埋点验证的产品假设」。

**相关文件（绝对路径）**：
- 决策总账（所有修正落点）：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-decisions-ledger.md`（§1 B1）
- Phase 1 大调研：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase1-research.md`
- Phase 2 synthesis（散落引用首次正式存盘对象）：`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-14-product-rethink-phase2-synthesis.md` 与 `...phase2-synthesis-lanes.md`

**Linear**：本任务为对抗性审计，产出即裁定文本，无代码改动。发现的 actionable 修正项（H1/H2 ID 误配、L1/L2 年份、L3/L5/M3 措辞、G1/G2 缺口降级）均属 owner 当前在编的决策总账内联订正 + 未来 calibration epic 的 spec 输入，强归属既有 B1 范畴，**无需新建独立 Linear issue**；G1/G2/G4 三个外推缺口若 owner 要独立追踪，建议作为 comment 追加到 B1 对应 issue，不碎片化新建。
