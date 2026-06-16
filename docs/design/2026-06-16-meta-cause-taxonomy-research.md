# 跨科 meta-错因 taxonomy 文献研究（grounding for 采集重想 spec §4.6）

> 来源：workflow meta-cause-taxonomy-research（2026-06-16）。5 学派检索 → 来源权威性对抗核验（剔编造/降级）→ 综合。owner 2026-06-16 拍板：**6 类机制主轴 + 保留 representation_failure + Axis A 元认知做正交轴**。配套 spec：`docs/superpowers/specs/2026-06-16-acquisition-rethink-retrieval-substrate-design.md` §4.6。

---

# 跨科 Meta-错因 Taxonomy 提案

n=1 自用全科学习工具 · 基于 4 学派研究 + 来源核验 · 2026-06-16

---

## 0. 核验前置：哪些来源可以背书

铁律执行结果——**只有 `exists ∈ {confirmed, likely}` 且 `authority ≥ medium` 的来源**进入论断支撑层。以下来源经核验后**降级/剔除**，不作权威背书（仅可作方向提及）：

- **「conceptual error vs procedural error 文献群」**（`exists: likely`，genre pointer，无法钉到单篇）→ 剔除为权威，仅作背景框架。
- **Avhustiuk et al. (2018)** → 真实存在但**citer 写的 PLOS ONE 是错的**（实际是 Europe's Journal of Psychology），authority=medium，小刊 → 仅辅助，不单独背书。
- **Vosniadou & Skopeliti「2017」** → 年份存疑（实为 2013 2nd ed.），authority=medium → 用时改引 2013，作辅助。
- **Ben-Hur (2006)** → 实务书非同行评审，authority=medium → 仅作 over/under-generalization 的跨科交叉佐证，不作主背书。
- **Donaldson et al. (eds.) NBK585626** → 章节实际作者是 Higham & Vincent 非 Donaldson，authority=medium → 作 Reason 框架的二手复述支撑可用，但不署 Donaldson。

进入**主背书层**（confirmed + high）的核心来源：Reason 1990、Rasmussen 1983、Reason 2000、Brown & Burton 1978、Brown & VanLehn 1980、Norman 1981、diSessa 1993、Chi 1994/2008、Vosniadou & Brewer 1992、Flavell 1979、Nelson & Narens 1990、Koriat 1997、Kruger & Dunning 1999、Lichtenstein & Fischhoff 1977、Dunlosky & Lipko 2007、Corbett & Anderson 1995、Barnett & Ceci 2002、Tulving 1983、Anderson & Krathwohl 2001、Radatz 1979、Corder 1967、Richards 1971。

---

## 1. 提案的 Taxonomy

### 推荐结构：**单层主分类（6 类 meta_cause）+ 2 条正交标注轴**

不是「几个并列 axis 当 taxonomy」，而是**一个小而正交的主类别集**（owner 要的「小而固定」），外加两条**独立标注维度**用于切分而非分类。四个学派高度收敛到同一组「错误 LOCUS」骨架——这不是巧合：Reason/Rasmussen 的认知控制层级、Newman 的解题流水线、ACT-R 的双记忆、conceptual-change 的概念结构，全部指向同一组「认知出错在哪个机制上」。我把它收敛成 **6 个互斥主类**（owner 提到的「知识缺乏 / 规则误用 / 执行失误 / 元认知监控失败」骨架被文献完整覆盖并细化）。

> 设计原则：主类**互斥单选**（聚合时干净），两条正交轴**多标**（保留诊断分辨率）。允许一条 per-subject cause_category 映射到「主 + 次」两个 meta_cause（文献明确承认 conceptual 与 comprehension/procedural 在实操会重叠——见 Brown&Burton、psychometric 学派均提此边界）。

### 最终 6 个主类（meta_cause）

| # | meta_cause | 一句定义 | 跨科例子 | 主背书来源（confirmed/high） |
|---|---|---|---|---|
| 1 | **execution_slip**（执行失误） | 知识与计划都对，仅在自动化执行/落笔环节偏离意图（写错、漏步、抄错）；提示即自纠，**不系统、不复现**。 | 数学 −(−3) 抄成 −3；古文形近字看错；物理正负号丢失；任意科目漏答/看错选项 | Norman 1981（action-slip 分类，Psych Review, high）；Reason 1990（skill-based slip/lapse, book-canonical）；Reason 2000（BMJ, top）；San Pedro/Baker/Rodrigo 2011（careless 可检测, AIED, strong） |
| 2 | **knowledge_gap**（知识缺乏） | 目标事实/定义/规则**根本不在可用知识库里**或衰退到不可用——既非取不出，也非用错。首次接触即错、跨情境一致不会。 | 古文实词义项没学过；数学某公式不知道；物理某定律不知道；英语词汇空白 | Corbett & Anderson 1995（BKT P(known) 未过阈, UMUAI, strong）；Anderson et al. 2004（ACT-R 陈述性记忆缺口, Psych Review, top） |
| 3 | **retrieval_failure**（检索失败） | 知识**已编码可用（available）但当下取不出（accessible）**——缺线索、情境不匹配；给点提示就想起，与 knowledge_gap 正交。 | 古文「见过想不起」该词义；数学闭卷调不出公式开卷全对；物理定律名记不起（舌尖现象） | Tulving 1983（availability vs accessibility + 编码特异性, OUP, book-canonical, ~12k 引） |
| 4 | **rule_misapplication**（规则误用 / 越界泛化） | 持有的规则**本身正确**，但触发在错误情境、忽略适用条件，或来自其他领域/母语的负迁移。错在「何时用」的模式识别，不在规则本身。 | 数学「乘法让数变大」套到分数；英语 -ed 套到不规则动词（goed）；古文虚词义项过度泛化；物理「有力才有运动」式 p-prim 越界 | diSessa 1993（p-prim 情境误触发, C&I, top）；Richards 1971（overgeneralization + ignorance of rule restrictions, ELT, strong）；Radatz 1979（incorrect associations / irrelevant rules, JRME, top）；Barnett & Ceci 2002（迁移失败 surface vs deep, Psych Bulletin, top） |
| 5 | **flawed_model / misconception**（概念错位 / 坏规则） | 持有一个**稳定、自洽、可跨情境复现的错误心智模型或 bug 规则**——不是空白，而是被错误内容占据；抗简单纠正，需认知冲突。含 buggy procedure 与本体类型错。 | 物理「力是维持运动的原因」；数学「1/2+1/3=2/5」（整数规则内化成坏规则）/ 退位减法稳定 bug；古文「以今律古」的稳定误读模型；古文虚词当实词的本体类型错（之=去 vs 结构助词） | Brown & Burton 1978（连贯的 rule-governed bug, Cog Sci, top）；Brown & VanLehn 1980（repair theory 生成稳定 bug, Cog Sci, top）；Chi 1994/2008（本体错类 + flawed mental model, top/book-canonical）；diSessa 1993（knowledge-in-pieces, top）；Vosniadou & Brewer 1992（synthetic model, Cog Psych, top） |
| 6 | **representation_failure**（表征 / 读题理解断层） | 在调用任何领域知识**之前**，读题/解码/转译成可解形式就已失败——「若有人把题意讲清他就会做」。错在「进入」而非「加工」。 | 古文句读/语境定义项失败；数学应用题列错方程/条件读漏；物理文字题建错模型；阅读长难句解析失败 | Newman 1977（reading/comprehension/transformation 三层, VIER Bulletin, **medium**——但被 Radatz/多源一致复述, 交叉度高）；Barnett & Ceci 2002（surface vs deep structure, top）；Reason 1990（rule-based mistake 含表征层判断, book-canonical） |

> 注：第 6 类 representation_failure 的**直接背书 Newman 1977 仅 medium**（地区 bulletin），但其五层结构被 Radatz 1979（JRME top）与大量二手一致复述，**交叉一致性高**，故保留；同时它有 Barnett & Ceci（top）的 surface-structure 层支撑。owner 若严格，可考虑把它**降为次类**或并入 rule_misapplication（见 §6 分叉）。

### 两条正交标注轴（多标，不参与主分类）

这两条来自学派明确给出的「与机制正交」的维度——把它们做成主类会污染聚合，做成标注轴正好喂数据 viz：

- **Axis A — 元认知校准（metacog_flag）**：来自 metacognition-calibration 学派。值：`blind_spot`（高信心+错，不知道自己不知道）/ `false_fluency`（虚假胜任感）/ `regulation_gap`（监控到了没行动）/ `overconfident` / `poor_resolution`（信心无分辨力）/ `calibrated`。背书：Flavell 1979、Nelson & Narens 1990、Koriat 1997、Kruger & Dunning 1999、Lichtenstein & Fischhoff 1977、Dunlosky & Lipko 2007（全 confirmed/high）。**为何不做主类**：它描述「错为什么没被自己抓住」，与「错在哪个机制」正交——同一个 misconception 可以同时 blind_spot 或 calibrated。
- **Axis B — Bloom 认知过程层（bloom_level）**：来自 psychometric-transfer 学派引的修订版 Bloom。值：remember / understand / apply / analyze / evaluate / create。背书：Anderson & Krathwohl 2001（book-canonical, high）。**为何不做主类**：它是「题目要求什么认知层级」，与「错误机制」正交——一个 execution_slip 可发生在 apply 也可在 analyze 层。复刻修订版 Bloom 的 knowledge×process 二维结构。

---

## 2. Axis 之争：该按哪个框架切？

owner 问过三个候选切法。结论如下：

### 推荐：**认知机制 LOCUS（本提案的 6 类）作主轴**

**理由**：
1. **跨学派收敛度最高**——4 个独立学派（人因/程序错误分析/conceptual-change/心理测量）全部独立收敛到「执行 vs 缺知识 vs 用错规则 vs 坏模型 vs 读题」这组机制切分，而非收敛到 Bloom 层或「审题/计算/概念/粗心」表面模式。收敛 = 这是真实的认知结构而非分类便利。
2. **直接挂干预含义**（owner 要的「选题/出题暗信号」）：每个机制对应**不同处方**——slip→只提示检查不加难度；knowledge_gap→FSRS 重排/初教；retrieval_failure→无提示检索练习；rule_misapplication→条件辨识/反例；misconception→认知冲突题（最高出题价值）；representation_failure→练「据语境/题意转译」。「审题/计算/概念/粗心」这种表面模式做不到这点（「计算错」既可能是 slip 也可能是 procedural bug，处方相反）。
3. **跨科同构**：6 类描述「认知出错方式」与学科内容无关，古文/数学/物理同桶。

**文献支撑强度：强**（4 学派 × 多篇 top/canonical 来源交叉）。

### 备选 A：「错误模式」（审题 / 计算 / 概念 / 迁移 / 粗心）

- **支撑强度：弱—中**。这是直觉分类，最接近的学术锚是 Newman 五层（medium）。**问题**：维度不正交——「计算」混了 slip 与 procedural bug；「粗心」与「概念」其实是不同轴（机制 vs 校准）的投影。owner 若坚持要这种「人话标签」，建议**做成 6 类主轴的 UI 显示别名**，底层仍存 meta_cause。

### 备选 B：知识缺口 / 执行 / 元认知 三分

- **支撑强度：中—强**。这正是本提案的**压缩版**：执行=execution_slip；知识缺口=knowledge_gap+retrieval_failure+representation_failure；元认知=Axis A。**问题**：把 rule_misapplication 与 misconception 这两个**最有出题价值**的类塞进「知识缺口」会丢掉关键信号（坏规则需认知冲突题，缺知识只需补课，处方完全不同）。**建议**：作为 owner 想要更极简时的 fallback（3 主类），但会牺牲诊断分辨率。

### 备选 C：Bloom 认知过程层作主轴

- **支撑强度：强（作为正交轴）/ 弱（作为机制主轴）**。Bloom 答的是「认知层级」不是「错误机制」，单独做主轴无法挂干预。**已采纳为 Axis B 标注维度**，不作主分类。

---

## 3. 映射设计：per-subject cause_category → meta_cause

### 推荐：**映射表（subject cause_category → meta_cause）+ 实例级 meta_cause 字段**，双层并用

**为什么不只用 `meta_cause` 字段**：per-subject cause_category（如古文「虚词误解」）**本身一词多机制**——同一个「虚词误解」可能是 representation_failure（语境没读懂选错义项）、rule_misapplication（义项过度泛化）、flawed_model（系统性当成实词的本体错），甚至 knowledge_gap（该义项没学过）。所以**不能在 cause_category 层硬编死一个 meta_cause**。

**推荐双层**：
1. **静态映射表**给每个 cause_category 一个**默认 meta_cause + 候选集**（启发先验，供冷启动/无实例信号时用）。
2. **实例级 `meta_cause` 字段**（写在每条 mistake/review 事件上，单选主类）+ **`meta_cause_secondary`（可空）** + Axis A/B 标注——由 AI judge 结合「学习者一经提示是否自纠 / 是否跨情境复现 / 信心是否脱节」这几个判别式实例化判定（evidence-first，可追溯可回滚，符合项目 AI-agency 哲学）。

### 真实例子映射

| per-subject cause_category | 默认 meta_cause | 候选集（实例级可改判） | 判别式 |
|---|---|---|---|
| 古文「虚词误解」 | rule_misapplication | {representation_failure, flawed_model, knowledge_gap} | 提示语境就懂→representation；义项泛化→rule_misapp；系统当实词→flawed_model；没学过→knowledge_gap |
| 数学「符号错误」 | execution_slip | {procedural→flawed_model, rule_misapplication} | 偶发抄错且自改→slip；每次移项不变号→flawed_model（坏规则） |
| 物理「公式套错」 | rule_misapplication | {flawed_model, knowledge_gap} | 条件不满足误触发→rule_misapp；底层 p-prim 驱动→flawed_model |
| 古文「文意理解」 | representation_failure | {knowledge_gap} | 读不懂→representation；缺背景事实→knowledge_gap |
| 数学「不验算」 | （Axis A: regulation_gap）+ execution_slip | — | 这是元认知调节失灵，主类记承载它的执行错，Axis A 标 regulation_gap |

> **关键设计**：owner 之前研究里出现的「violation/意图偏离型」（故意跳步/不验算）**不进 6 个机制主类**——它是动机/习惯而非能力，归到 **Axis A 的 `regulation_gap`** 标注（Reason 2000 把 violation 与 error 正交，confirmed/high）。这样画像不会把「会但偷懒」误判成「不会」。

---

## 4. 怎么服务消费者

### 4.1 `misconceptionRecurrence` 两层聚合

- **层内（subject 内）**：`cause_category × KC`（保持现有粒度，最细，给单科复习排程喂 FSRS）。
- **跨科（meta 层）**：`meta_cause × (可选 subject)`——按 §0「科目是视角不是结构」原则，subject 经 domain 派生，**meta_cause 不挂 subject 列**，跨科聚合时按 effective_domain 派生轴 group by。
- 聚合输出示例：「该学习者 `flawed_model` 在数学+物理跨科高发」=**系统性概念弱点**（出反例/认知冲突题）；「`execution_slip` 全科散布」=注意力/负荷问题（降权，不加难度）；「`retrieval_failure` 集中某 KC」=触发无提示检索练习。

### 4.2 未来 learner 元认知 data-viz feature 的数据层

需要采集并落库的最小字段集（喂 viz）：
- 每条 mistake/review 事件：`meta_cause`（主，单选）、`meta_cause_secondary`（可空）、`metacog_flag`（Axis A）、`bloom_level`（Axis B，可空）、`confidence`（学习者自评，若 UI 采集）、`correct`（客观）、`self_corrected_on_hint`（bool，slip/misconception 分水岭）、`recurred_cross_item`（bool，系统性判别）。
- viz 可直接产出：① **meta_cause 跨科雷达**（系统性弱点画像）；② **calibration curve**（confidence × correct，按 §1 Axis A——需 `confidence` + `correct`，背书 Lichtenstein&Fischhoff/Dunlosky）；③ **resolution 散点**（信心-对错相关度，低=自评噪声大，系统应少信自评）；④ **「练习可解 vs 需重教」分野**（slip/retrieval=练习可解；flawed_model/misconception=需重教）——这是最有价值的出题暗信号输出。

> Evidence-first：所有 meta_cause 判定经 AI judge 时落 `src/server/ai/log.ts`，可追溯可回滚（符合项目设计原则）。

---

## 5. 来源权威性表

### 进入主背书层（confirmed + authority high）

| Citation | Venue | venue_tier | authority | exists | 背书哪个 meta_cause / axis |
|---|---|---|---|---|---|
| Reason, J. (1990). Human Error. CUP. | Cambridge UP (monograph) | book-canonical | high | confirmed | execution_slip, rule_misapp, flawed_model 骨架 + GEMS |
| Rasmussen, J. (1983). SRK. IEEE TSMC SMC-13(3). | IEEE TSMC | strong | high | confirmed | SRK 分层主轴（执行/规则/知识） |
| Reason, J. (2000). Human error: models & management. BMJ 320:768-770. | BMJ | top | high | confirmed | violation↔error 正交（→Axis A regulation_gap） |
| Norman, D.A. (1981). Categorization of action slips. Psych Review 88(1). | Psychological Review | top | high | confirmed | execution_slip |
| Brown & Burton (1978). Diagnostic models for procedural bugs. Cog Sci 2(2). | Cognitive Science | top | high | confirmed | flawed_model（rule-governed bug） |
| Brown & VanLehn (1980). Repair theory. Cog Sci 4(4). | Cognitive Science | top | high | confirmed | flawed_model（稳定 bug vs slip） |
| diSessa (1993). Toward an epistemology of physics. C&I 10(2-3). | Cognition & Instruction | top | high | confirmed | rule_misapp（p-prim）+ flawed_model |
| Chi (1994). From things to processes. L&I 4(1). | Learning & Instruction | strong | high | confirmed | flawed_model（本体类型错） |
| Chi (2008). Three types of conceptual change. Handbook. | Routledge Handbook | book-canonical | high | confirmed | flawed_model 三层 + knowledge_gap（false belief） |
| Vosniadou & Brewer (1992). Mental models of the earth. Cog Psych 24(4). | Cognitive Psychology | top | high | confirmed | flawed_model（synthetic model） |
| Radatz (1979). Error analysis in math ed. JRME 10(3). | JRME | top | high | confirmed | rule_misapp（incorrect assoc/irrelevant rules） |
| Corder (1967). Significance of learner's errors. IRAL 5. | IRAL | strong | high | confirmed | rule_misapp 跨语言科同构 |
| Richards (1971). Non-contrastive approach. ELT Journal 25(3). | ELT Journal | strong | high | confirmed | rule_misapp（overgeneralization） |
| Corbett & Anderson (1995). Knowledge tracing. UMUAI 4(4). | UMUAI | strong | high | confirmed | knowledge_gap + execution_slip 分离（BKT slip/known） |
| Anderson et al. (2004). Integrated theory of mind (ACT-R). Psych Review 111(4). | Psychological Review | top | high | confirmed | knowledge_gap（陈述性）vs flawed_model（程序性） |
| Tulving (1983). Elements of Episodic Memory. OUP. | Oxford UP (monograph) | book-canonical | high | confirmed | retrieval_failure（availability vs accessibility） |
| Barnett & Ceci (2002). Taxonomy for far transfer. Psych Bulletin 128(4). | Psychological Bulletin | top | high | confirmed | representation_failure（surface vs deep）+ rule_misapp（迁移横轴） |
| Anderson & Krathwohl (2001). Revision of Bloom. Longman. | Longman (book) | book-canonical | high | confirmed | Axis B（Bloom 认知层） |
| Flavell (1979). Metacognition & cognitive monitoring. Am Psychologist 34(10). | American Psychologist | top | high | confirmed | Axis A 框架根 |
| Nelson & Narens (1990). Metamemory framework. PLM 26. | PLM (Academic Press) | strong | high | confirmed | Axis A（监控-控制环：blind_spot, regulation_gap） |
| Koriat (1997). Cue-utilization JOL. JEP:General 126(4). | JEP: General | top | high | confirmed | Axis A（false_fluency） |
| Glenberg/Wilkinson/Epstein (1982). Illusion of knowing. Mem&Cog 10(6). | Memory & Cognition | strong | high | confirmed | Axis A（blind_spot/false_fluency 首证） |
| Kruger & Dunning (1999). Unskilled and unaware. JPSP 77(6). | JPSP | top | high | confirmed | Axis A（blind_spot/overconfident）注：效应后续有统计学批评 |
| Lichtenstein & Fischhoff (1977). Do those who know more… OBHP 20(2). | OBHP | strong | high | confirmed | Axis A（overconfident, hard-easy） |
| Dunlosky & Lipko (2007). Metacomprehension. CDPS 16(4). | CDPS | strong | high | confirmed | Axis A（calibration vs resolution 两轴） |
| Rhodes & Castel (2008). Perceptual info & memory predictions. JEP:General 137(4). | JEP: General | top | high | confirmed | Axis A（fluency 错觉实证） |
| Thompson et al. (2011). Intuition, reason, metacognition. Cog Psych 63(3). | Cognitive Psychology | top | high | confirmed | Axis A（regulation_gap/false_fluency 推理侧） |
| San Pedro/Baker/Rodrigo (2011). Detecting carelessness. AIED 2011 LNCS 6738. | AIED Proceedings | strong | high | confirmed | execution_slip（careless 可操作化检测） |
| Meijer (1996). Person-fit research. AME 9(1). | Applied Measurement in Education | moderate | high | confirmed | execution_slip（IRT aberrant/spuriously-low） |
| Newman (1977). Analysis of pupils' errors. VIER Bulletin 39. | VIER Bulletin | moderate | medium | confirmed | representation_failure（reading/comprehension/transformation）——medium 但被 Radatz/多源交叉复述 |

### 辅助层（authority medium，仅佐证不单独背书）

| Citation | 处理 |
|---|---|
| Ben-Hur (2006). Concept-Rich Math Instruction. ASCD. | 实务书非同行评审；仅作 over/under-generalization 跨科交叉佐证 |
| Vosniadou & Skopeliti（标「2017」）framework theory chapter | 年份存疑（实为 2013 2nd ed.）；用时改引 2013，作 flawed_model/synthetic 辅助 |
| Avhustiuk et al. (2018). Illusion of knowing. | venue 应为 Europe's J. of Psychology（非 citer 写的 PLOS ONE）；小刊；仅辅助 Axis A |
| Donaldson et al. (eds.) NBK585626 patient-safety textbook | 章节实际作者 Higham & Vincent；作 Reason 框架二手复述可用，不署 Donaldson |

### 已剔除（不得作权威背书）

| Citation | 剔除原因 |
|---|---|
| 「conceptual error vs procedural error 文献群」/「Students' Conceptual & Procedural Error in Solving Algebraic Problems」类 | `exists: likely`，genre pointer，无法钉到单篇可验证来源；仅作背景框架，不作离散权威源 |

---

## 6. 留给 owner 的真分叉（需你拍板）

**分叉 1 — 主类粒度：6 类 vs 3 类压缩版。**
- **6 类**（本提案推荐）：保留 retrieval_failure / rule_misapplication / flawed_model 三者分立——出题暗信号分辨率最高（坏规则↔缺知识↔取不出 处方各异）。代价：AI judge 实例化判定更难，冷启动需更多信号。
- **3 类**（备选 B：知识缺口/执行/元认知）：极简、聚合最干净、judge 最容易，但丢掉「需重教 vs 补课 vs 多检索」的关键区分。
- **我的倾向**：6 类。owner 既然要「选题/出题暗信号」，分辨率就是产品价值本身；且文献支撑 6 类全部 confirmed/high。

**分叉 2 — representation_failure 是独立主类还是次类？**
- 它的**直接背书 Newman 仅 medium**（虽有 Radatz top + Barnett&Ceci top 侧翼）。
- **选项 a**：保留为第 6 主类（读题型错误在古文/阅读/应用题极高频，值得独立）。
- **选项 b**：降为「rule_misapplication / knowledge_gap 的前置标注」，主类回到 5 个，背书全 top。
- **我的倾向**：保留（选项 a），因为全科里「没读懂题」是真实且高频的独立机制，且 owner 工具含大量开放/主观题型。

**分叉 3 — Axis A（元认知）做正交标注轴 vs 升为主类？**
- **正交标注轴**（本提案推荐）：元认知与机制正交（同一 misconception 可 blind_spot 也可 calibrated），做轴不污染聚合，calibration/resolution 两条 viz 直接出。
- **升为主类**：若 owner 认为「为什么没被自己抓住」比「错在哪个机制」更重要（元认知画像是产品核心卖点），可把 Axis A 提为并列主分类，做成「机制 × 元认知」二维主表。
- **我的倾向**：保持正交标注轴——但这取决于 owner 把元认知画像定位成「主要卖点」还是「附加诊断」。

---

Linear 跟进：本任务为研究/提案产出，**无需创建 Linear issue**——它是设计输入而非已确认的实现工作；落地为 schema/字段（`meta_cause` / `meta_cause_secondary` / `metacog_flag` / `bloom_level`）时再由 owner 决定开 issue。无本报告外的悬挂 follow-up。

(本报告为最终返回内容，未写入任何 .md 文件。)