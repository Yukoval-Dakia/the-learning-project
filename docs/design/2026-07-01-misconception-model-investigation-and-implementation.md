# 误区（Misconception）建模：调查报告与实施建议

- **日期**：2026-07-01
- **状态**：调查完成 / 待 owner 拍板（实施建议 = 提案，非已批准计划）
- **相关**：YUK-440（kc_typed_state）、YUK-454（cause/misconception 系统）、YUK-531（A5 S4 RT1 身份基建，已 dark-ship）、YUK-532、YUK-533、YUK-529（Canceled）、YUK-530；ADR-0034 / ADR-0035 / ADR-0036
- **方法**：13-agent 研究工作流（5 路文献检索 + 2 路代码/设计对账 + 综合 + 3 视角对抗 + 和解），叠加主 session 对 **origin/main** 的直接 code-ground 复核。全部文献引用见附录 A；全部代码事实带 `file:line`（**均基于 origin/main = `b0ceac0b`**，见 §0.5 漂移警告）。

---

## 0. 一段话结论

误区不是 A（自带 mastery 的独立实体）也不是 B（KC 上的一个状态枚举），而是**第三种形态**：一个**内容层身份实体**（可共享、可复用、无掌握度、confidence-only、事件溯源、`caused_by → 多个 KC`）+ 一个**每学习者的推断态**（KC 上的 `kc_typed_state` 枚举，经 probe loop 点亮）+ **唯一的耐久学习者态 mastery 永远留在 KC 上**。文献五路（本体论 / ITS bug 传统 / 认知诊断 / Eedi 现代系统 / 测评设计）在这个"两层 + mastery 归 KC"结构上高度收敛。**而且——关键发现——这个形态的基建已经在 origin/main 上 dark-ship 完毕（YUK-531 S4）**；真正未做的是把它**接活**（probe-resolution loop + authored 写路径 + confusable_with 消费），以及一个 owner 才能拍的**翻 flag 决策**。称之为 **"B-live + authored 内容层缝"**。

---

## 0.5 ⚠️ 载重级 GROUND-TRUTH 修正（先读这条）

调查过程中发现两件必须先讲清的事，否则整份实施建议会建立在错误前提上：

1. **本地工作树落后 origin/main 20 个 commit。** 本会话本地 HEAD = `34834df1`（YUK-354 A5 S3），origin/main = `b0ceac0b`（YUK-531 A5 S4 PR-5），`behind-by: 20, ahead-by: 0`。**本地 `src/db/schema.ts` 看不到 misconception_edge，但 origin/main 有。** 实施前 owner 必须先 `git pull --ff-only`（本报告未替你做任何 git 状态变更）。本报告所有 `file:line` 一律指 **origin/main**。

2. **YUK-531 S4 已经把"完整 RT1 误区身份基建"dark-ship 到 origin/main 了**，包括：`misconception` 表（+ `status/source/seen/evidence` 4 列，schema.ts:125-149）、`misconception_edge` 多态边表（schema.ts:165）、`misconception_reconciliation_log`（schema.ts:1591）、promotion writer（`misconception-promote.ts`，flag `MISCONCEPTION_PROMOTE_ENABLED` 默认 OFF + human-accept）、异构调和环、平行 topology gate、`GET /api/knowledge/:id/misconceptions` 读模型、`MisconceptionList` UI、候选 veto 端点——**全 dark**。

   > **我此前给 owner 的口头结论里说"misconception_edge 不存在、要新建一张表"——那是错的**，源自一个 grounding agent 读了落后 20 commit 的本地树。事实相反：那张表和整套软轨身份基建已经存在。**这让推荐方向更便宜，不是失效**——"authored 内容层缝"大体上是**接线 + 决定翻不翻 flag**，而不是"建表"。`misconception_edge.weight` 的注释甚至已经写明 *"AI proposals fill with confidence, **user-authored defaults 1**"*；`misconception` 表另有 `source ∈ 'hard'|'soft'` 列区分硬/软轨来源（此列在 misconception 表、非 edge 上）——**shipped schema 本身就预留了人工 authoring 路径和"无掌握度、confidence-only、caused_by→多 KC"的实体形状**，正是本报告推荐的东西。

---

# Part I — 调查报告

## 1. 问题与"A/B 假二分"

owner 的原始 crux：一个典型误区，是**关系型**（"把 X 和 Y 搞混了"，→ B：KC 上的 `confused-with-X` 状态，已设计）还是**属性型**（"对某操作有一个不特指跟谁混的独立错误规则"，→ A：需要独立实体）？并追问：是否该是**第三种形态**。

调查的第一个结论：**A/B 在争"一个 mastery 标量该放哪"，却同时锁死了另外四个本应独立的变量。** 一旦把这四个轴拆开（§5），二分就化开了，而且文献给出的答案既不是纯 A 也不是纯 B。

## 2. 文献综述（五路，全部真实引用见附录 A）

### 2.1 本体论：误区是"物件"还是"激活模式"（R1）

核心断层线（Gouvea 2023 表述最清晰）：**OBJECT 观**——误区是学习者"持有"的东西，有身份、跨情境稳定、可被"根除"；一旦给它一行带单调 `belief_strength` 的记录，就已经承诺了 OBJECT 本体论。**PATTERN 观**——误区是情境相关的、临时从更细的碎片组装出来的激活，不作为一个单元存储。

- **Chi（本体误类）**、**Vosniadou（框架理论 / 综合模型）**是强 OBJECT 派，但即便他们，"改变"也是**离散的类别跃迁**（阶跃函数），不是平滑单调衰减——支持**枚举态**，不支持 float。且 Vosniadou 的"综合模型"连贯性被 Nobes/Panagiotaki 批为**部分是测量工具的伪迹**。
- **diSessa（knowledge-in-pieces / p-prims）**是强 PATTERN 派：所谓稳定误区其实是底层**有效**碎片的复发激活模式，没有固定身份。在 M 层面记一个单调 `belief_strength` 近乎**范畴错误**；正确的状态变量是**每碎片、二维（cuing × reliability）、按情境索引**的。
- **Smith/diSessa/Roschelle（"Misconceptions Reconceived"）**从元层面否定 OBJECT 观本身："先破后立"与建构主义自相矛盾；很多误区是**有产出性的资源**（此处错、彼处是正确想法的种子）。
- **最强的、被反复复现的经验证据（决策相关性最高）**：**Shtulman & Valcarcel (2012, Cognition)** ——即使受过科学教育的成人，在朴素与科学理论**冲突**的陈述上仍**更慢、更易错**；朴素理论**被抑制而非被删除**，几十年后仍在检索时竞争。**Potvin（prevalence/共存模型）**：学习不擦除朴素概念，只改变**哪个在何种负荷下胜出**。fMRI/心理计时学显示专家也持续动用抑制。

> **R1 对数据模型的裁决**：**单调地趋近"已根除"的标量对误区本身不可辩护**——每个 PATTERN 派都否定它，Chi 预测阶跃而非单调，最强经验证据说朴素概念的底层强度**大致恒定**、变的是可逆的**抑制/优势度**。若保留标量，须命名为 `override_reliability`/`suppression_strength`、按情境索引、允许回退，另存一个永不归零的 `latent_intuition`。文献重心已**决定性地移离"一等存储实体（带强度）"**，移向"**事件（耐久）+ 按情境索引的非单调推断态（可修正）**，实体只做**标签与内容锚**"。

### 2.2 ITS bug 传统：45 年的迁移史（R2）

一个学生错误被表示为三种之一，整个领域是这三者之间的迁移：**(a) 目录条目**（BUGGY/DEBUGGY 的共享 bug library，题目映射进去）→ **(c) 生成式规则**（Repair Theory：bug 是对 impasse 的即时修补）→ **(b) 每学生态**（ACT-R/BKT：把耐久态做成"对**正确 KC** 的掌握概率"）。

- **Brown & Burton (1978)**：bug = 正确过程的"离散修改"（如 `0−N=N`）。但**发明者自己**就标注了 library 的两个失效：**歧义**（多个 bug 都精确匹配）和**覆盖缺口**（无 bug 匹配）；且明确说过程网络"**不是认知构造，只是框架**"。
- **VanLehn（Repair Theory / Mind Bugs）的经验重磅**：**bug 迁移**——同一个孩子周五和周一表现出**不同**的 bug。**稳定的是 impasse（知识缺口），bug 是身份会闪烁的表面症状。** 这是最直接否定 (a)/(b) 的发现。
- **Cognitive Tutor（Anderson/Koedinger）**：模型完整建**正确**路径，任何不匹配即"off-model"——buggy production 只是**高频错误的可选增强层**。且 **LISP-tutor 90% vs 91%**：精细 buggy 反馈相对"只说错了"**无显著学习收益**。**Payne & Squibb (1990)**：mal-rule 高频头 + 长尾、**跨人群不迁移**；**Sleeman**：基于模型的补救 ≈ 重教。
- **Constraint-Based Modeling（Ohlsson/Mitrovic）**：干脆**不建 bug**——只建"每个正确解必须满足的约束"，违反的约束**就是**错误信号，**无覆盖缺口**（没有闭合目录可漏）。

> **R2 对 KG 工具的裁决**：**不要**把误区做成一个你断言并持久化的**每学生存储态节点**（那正是会迁移、会失效的东西）。**耐久态记在正确 KC 上**（BKT/Andes/CBM 共识）。误区做成**共享内容层目录节点**是好的（BUGGY 的好部分），但**学习者→误区的边必须是软的、会衰减的、推断的关系，绝不是存储的事实**。并用 **CBM 兜底**：正确知识子图是安全网，误区目录是其上的精度层；**bug 是闪烁，缺口是信号**。

### 2.3 认知诊断模型：两层架构 + distractor 是信号载体（R3）

- 主流把误区操作化为**学生"持有"的二元潜变量** α_M ∈ {0,1}，通常用**析取**语义（DINO 式："持有任一误区 → 倾向错"），与技能的合取语义（DINA："缺任一技能 → 错"）相对。
- **是否存在"误区的 Q-matrix"？有，而且正是本报告主张的两层架构**：扩展 Q-matrix / **Q-cube**（item × **option** × attribute）在**内容层**给每个 **distractor** 打上它编码的误区标签；**每学习者的后验** P(has M) 是**独立的人层**。见 **MC-DINA（de la Torre 2009）**、**SICM（Bradshaw & Templin 2014）**、**SISM（Kuo, Chen & de la Torre 2018）**。
- **为什么 distractor 是载体**：0/1 二值打分**丢掉**误区信号；只有观测到**具体哪个错答**（开放题则是**具体编码的错误**）才能诊断 M，也才能在统计上**打破"缺技能 S"与"持误区 M"的并**。
- **可识别性（最深的一点）**：SISM 证明——若一个错答既可由"缺 S"也可由"持 M"产生，而设计从不分离两者，模型**不可识别**。**M ≠ 缺技能 只有在存在"有技能的学生仍暴露 M / M 产生独特错答"的题/选项时才可识别；distractor（或开放题的编码错误）就是提供这种分离的观测。**

> **R3 裁决**：误区做**一等 KG 节点** + 一个**incidence 层**（`Distractor --encodes--> Misconception`，`Misconception --confuses--> {ConceptA, ConceptB}`——**关系型"A vs B"就住在这条图边上**，人层变量保持二元/分级）。**冷启动先用确定性 bug-tag 累加器**（Brown-Burton stance），有量后再升级到标定的 SICM/SISM——内容标注 day-one 可用，统计人层随 N 变锐。**别把"缺 S"和"持 M"塌成一个节点。**

### 2.4 现代系统 & Eedi：误区 = 挂在 distractor 上的内容 taxonomy（R4，最贴切的真实类比）

- **凡是真把误区当一等对象的系统，误区压倒性地被建成一个"策展的内容-taxonomy 条目"**——一个具名、authored、与题独立的"错误概念"，挂在具体 distractor 上、跨多题复用；**每学习者态只是"该生所选 distractor 映射到哪些 taxonomy 条目"的派生**。
- **只建每学习者潜态、无具名错误目录的系统（ALEKS/KST、vanilla DKT）根本不表示误区**——它们表示知识**状态**或正确率。这是最重要的对比：**要"诊断并命名具体错误想法"，KST 是错的祖先。**
- **Eedi 2024 Kaggle "Mining Misconceptions in Mathematics"（深挖，最贴本决策）**：数据模型就是**两张表**——
  - `misconception_mapping.csv`：`{MisconceptionId, MisconceptionName}`，**~2,587 条细粒度、扁平、闭合但可扩展**的具名错误概念，**独立于任何题存在**。
  - `train.csv`：每题一行，含 `Misconception{A..D}Id` = **distractor→misconception 外键**（正确项的 FK 为 null；错项 FK 可 null；**同一 MisconceptionId 跨多题复用**——多题→一误区的 fan-in 正是检索能 work 的原因）。
  - ML 任务 = 对每个 distractor 从 2,587 条里排序取 25（MAP@25）；**很多测试集误区训练时未见 → 纯分类失败，必须对标签文本做检索** → 冠军做法 = **retrieve-then-rerank**（bi-encoder 嵌入 + 生成式 reranker）。
- **LLM 时代**：distractor 生成**以误区为条件输入**才逼真（LLM 不擅长凭空发明学生错误）；开放题误区检测收敛到同样的 **generate→retrieve→rerank**；一致的告诫是**忠实性/幻觉**（"Correct Answer Trap"：正确答案背后藏着错误推理）。

> **R4 裁决**：误区做**一等内容实体**（`misconception(id, name, scope, description, remediation_ref)`，Eedi `misconception_mapping.csv` 的直接类比）+ **两个显式层**（authored 目录 ⟂ 每学习者 `learner_misconception` 态，态可随 FSRS 衰减）。**链接对象 = `distractor → misconception_id`**（可空、多对一）。**开放题无 distractor → 在判分时跑 generate→retrieve→rerank**，写回 `misconception_id`。**目录 day-one 闭合但可扩展**（低置信时 LLM 起草、人工批准新条目）。**别抄 KST 当误区模型。**

### 2.5 测评设计：一个内容实体，三扇门（R5）

误区最自然是**内容层实体**——被三个 authoring 面**引用**：**题干 tag / distractor 理由 / rubric 错误码**——并**按学习者实例化为证据**，去更新一个学习者态。这不是三选一，是**同一个内容实体的三个视角**。

- 经典 distractor rationale（King et al.）、**Ordered Multiple Choice**（Briggs/Alonzo/Wilson——每个选项映射到 construct map 的一个层级，若干是具体误区）、**Wilson BEAR outcome space**（一等对象，独立于题和学生）都把误区当**归一化的内容层对象**。
- **CDM 明确把误区建成独立析取潜变量**（Kuo/de la Torre："误区可与正确解**共存**，即使概念改变后仍残留"→ **误区是学习者真持有的独立潜态，不是技能的缺失**）。
- **开放题（本产品的主战场）**：无 distractor → 信号从 authoring-time **迁移到 scoring-time** 的 **rubric 错误码空间 + 分类器**。**TIMSS 两位编码**（第二位 70-79 = 具体错误类别）、**NAEP×Eedi 三段标注**（正确性 / 有无常见错误 / 具体错误类型，60,000+ 应答）、**AACR**（自由文本科学解释里的具名误区码）都证明：**rubric 的"常见错误码"和 OMC 选项/Eedi distractor-target 是同一种对象，只是被分类器而非点击触达。**

> **R5 最强论断**：**大量开放/LLM 判分的内容把"实体"从"方便的归一化"抬升为"任何诊断的必要前提"**——没有共享的具名错误码标签空间，开放答案**不可诊断**，只能打分。每学习者信念仍是**态**；分类器输出是**证据事件**（`response → misconception m, confidence c`），且因 LLM 中段易错、过度锚定措辞，证据必须**概率化 + 带 provenance，绝不硬翻**。

### 2.6 五路的交叉收敛

| 主张 | R1 本体 | R2 ITS | R3 CDM | R4 Eedi | R5 测评 |
|---|---|---|---|---|---|
| 误区身份与 mastery 必须分离；mastery 归"正确 KC" | ✓（抑制非根除） | ✓（BKT 归 KC） | ✓（θ 与 α_M 分开） | ✓（态是投影） | ✓（态 ⟂ 掌握） |
| 内容层实体 ⟂ 每学习者态（两层） | ✓ | ✓ | ✓✓（Q-cube/后验） | ✓✓（两张表） | ✓✓（三扇门一实体） |
| 单调标量 belief_strength 不可辩护 | ✓✓ | ✓（bug 迁移） | ~（用二元/析取） | ~（用衰减态） | ✓（概率证据非硬翻） |
| 关系型 A-vs-B 与属性型 free-rule **都真实存在** | ✓ | ✓ | ✓ | ✓ | ✓ |
| 正确性兜底（CBM），误区是精度层 | — | ✓✓ | ✓（可识别性纪律） | — | ✓ |
| 开放题靠共享错误码 taxonomy + 检索 | — | — | ~ | ✓✓ | ✓✓ |

**没有一路支持 A（M 自带 mastery）；没有一路支持 B 独存（只有关系型 KC-pair）。全部收敛到"两层 + mastery 归 KC + 内容实体是诊断前提"。**

## 3. 代码 ground truth（origin/main 实际形态）

> 全部 `file:line` = origin/main `b0ceac0b`。本地落后 20 commit（§0.5）。

**已 dark-ship（YUK-531 S4）：**

| 组件 | 位置 | 形态 |
|---|---|---|
| `misconception` 表 | schema.ts:125-149 | 软轨身份：`title/reasoning/weight(confidence-only)/status('draft'|'active')/source('hard'|'soft')/seen(recurrence 计数)/evidence(event-ptr[])`。`.strict()`（`core/schema/misconception.ts`）**禁任何 mastery/θ̂/p(L)/FSRS/difficulty 列**。无 subject 列。`archived_at` 是唯一时间维（无 bi-temporal）。 |
| `misconception_edge` 多态边 | schema.ts:165 | `from_kind/from_id/to_kind/to_id/relation_type ∈ caused_by\|confusable_with\|observed_in\|experimental:*`（ADR-0036 另设想的 `remediated_by` 走 FSRS 管线复用、非存储边 relation_type，故不在此枚举）。weight ∈[0,1] CHECK（confidence-only）。**注释明写"user-authored defaults 1"** → 已预留人工 authoring。 |
| `misconception_reconciliation_log` | schema.ts:1591 | 调和环审计。 |
| promotion writer | `agency/server/misconception-promote.ts` | conjecture（recurrence≥2，同 cause×KC，identity-preserving）→ PROPOSE → **human-accept** → misconception 节点。gate = `MISCONCEPTION_PROMOTE_ENABLED === '1'`（**默认 OFF**，:74）。 |
| 调和/topology/读/UI/veto | `knowledge/server/misconception-{edges,read,reconcile,reconcile-store,topology-gate}.ts`、`api/misconceptions.ts`、`api/misconception-veto.ts`、`MisconceptionList` UI | 全 dark，flag OFF。 |
| `kc_typed_state`（YUK-440，Option-B 表） | schema.ts:1022 | `typed_state ∈ no-evidence\|confused-with-X\|mastered`、`confused_with_kc_id`、`lifecycle`、`evidence_event_ids`。单写者 `upsertKcTypedState`（advisory-lock `kc_typed:*`），**已接活** nightly reconcile cron。 |

**仍 inert / 未做（真正的实施面）：**

1. **kc_typed_state 的混淆轴是死的**：`reconcile.ts:268` **硬编码 `confused_with_kc_id: null`**（origin/main 仍如此），`induce.ts` 不产出"跟哪个 KC 混"。→ **`confused-with-X` 永不点亮**，每格停在 `no-evidence/open`。**这是 probe-resolution loop 缺口，真实存在。**
2. **YUK-533**：`confusable_with` 是**死边**——写了但无人消费（应喂组卷层"对比辨析题"）。分支 `yuk-533-confusable-consumer` 在建。
3. **YUK-532**：confirmed-archive veto 写 + confirmed-live UI 硬化。分支 `yuk-532-confirmed-veto-propose` 在建。
4. **无纯人工 authoring 路径**：目前只有"机器 propose（recurrence≥2）+ human-accept"这一条 dark 路径；没有"owner 直接手写一个跨 KC misconception 节点"的写路径（虽然 schema 已预留 `source='hard'`/`user-authored weight=1`）。
5. **翻 flag 决策**：`MISCONCEPTION_PROMOTE_ENABLED` 何时/是否 ON，k 阈值多少——owner-gated。
6. **embedding / retrieve-rerank 去重（YUK-454）**：misconception 表的 embedding triplet 在 L1 省略；语义去重/增长的两阶段检索未建。
7. **MCQ distractor↔misconception 链不存在**：`question.choices_md` 是裸 `jsonb string[]`（schema.ts:288），无 option id、无 distractor→misconception 字段。开放题错误经 **judge → `cause_category`**（`core/schema/cause.ts`）——per-subject-profile 声明的闭合词表，是 de-facto 抽象错误类型轴。

## 4. 决策谱系（已定 vs 未决；"option B"被重载 3 次）

- **"option B" 在文档里有三个互不相同的含义**（G2 对账），别再用字母：
  - 早前 **YUK-531 S4 批准的 B** = "建完整 RT1 mesh 身份实体" ≈ **本次的 A（但不含独立 mastery 轴）** → **已 ship**。
  - 早前**被否的 (a)** = "扁平 per-KC 派生读 kc_typed_state" ≈ **本次的 B** → 其 ticket **YUK-529 已 Canceled**。
  - 第三个 B = day-one **显示**漏斗（RT1 行 ⊎ 候选 conjecture）——是渲染问题，非数据模型。
- **已锁的红线（任何提案必须守）**：
  1. **误区节点绝不持独立 mastery/调度**（ADR-0036 §3；`.strict()` 守）。`weight` 是 confidence-only salience。
  2. **三层分离不可违**：身份层（节点/边/promoted misconception）⟂ 观测层（事件，错因活这）⟂ 派生层（mastery/credit，不写回）。per-attempt cause **不自动**升身份。
  3. **promote-not-copy + human-accept**：只有跨 attempt 同一 identity-preserving cause 复发 ≥k（k=2，owner-prior，flag-gated）才 propose 升级。正确 substrate = `gatherConjectureEvidence`（identity-preserving），**不是** `aggregateMisconceptionRecurrence`（丢 cause 身份的标量 selection 信号）。
  4. **n=1 红线（ADR-0035）**：误区信号软轨——**绝不喂 θ̂/p(L)/FSRS/difficulty/mastery**。从应答模式估 "P(M|option)"/"distractor 区分度" = 跨科方差 = **不可采纳**。
  5. **结构无 bi-temporal**（ADR-0034）：无 `valid_at/invalid_at`；"不再真" = `archived_at` 软归档 + CorrectionKind 事件。
  6. **anti-guilt（⑥）**：confidence 数字绝不裸过线，server 侧离散成定性 band。
  7. **冷启动优先 + defer-flip-not-build**：现在建+接+dark-ship（owner-prior 阈值），只 defer 读真数据的**翻转**。
  8. **冷启诚实天花板**：cause/misconception 推断是整个冷启栈**最弱一环**（模拟学生对人选 distractor 命中仅 **31-47%**），永远保持 hypothesis-state（可 dismiss），绝不当硬标签；开放题更差。
  9. **taxonomy 会增长** → 身份去重靠 pgvector 语义近邻（retrieve-then-rerank，Eedi 冠军式），非精确闭合词表。
  10. **`confusable_with` 不喂组卷对比题就是死边（YUK-533）**；misc↔misc 须 canonical 排序防无向重复。

---

# Part II — 立场

## 5. 拆掉假二分：四个正交轴

| 轴 | A/B 各自默认锁死的值 | 文献裁决 |
|---|---|---|
| **本体论** | 稳定物件（可记单调 mastery）vs 情境激活 | **未定案**；但两派 + 最强经验证据**都否定误区上的单调 mastery**。 |
| **层（内容 vs 学习者态）** | A/B 都把两层塌成一层 | **真共识轴**：内容实体 ⟂ 每学习者后验（CDM Q-cube / Eedi 两表 / BEAR outcome space）。 |
| **关系拓扑** | B 只有 KC-pair；A 只有跨 KC 抽象 | **≥4 格**：① 单 KC 程序 bug ② KC-pair 混淆（B 甜区）③ 跨 KC 抽象（A 动机）④ p-prim 激活。 |
| **证据来源** | 隐含 MCQ distractor | 你主战场是**开放题** → judge 打 `cause_category`（归因保真度低——distractor 域实测 31-47%，开放题很可能更差、未量化），命名词表更吃重、更依赖最不可靠环节。 |

## 6. 为什么 A 太重、B 太窄

- **A 太重（三条独立理由，一条是硬伤）**：① 单调 `belief_strength→0` 被每个流派否定（共存/抑制；bug 迁移；45 年 ITS 终点是"掌握度记正确 KC"）；② `.strict()` + ADR-0036 §3 **明令禁止**误区节点持掌握度——A 原样是**硬 parse failure**；③ 精细 buggy 补救 ROI ≈ 1pp（LISP 90/91）。A **唯一对的直觉**——跨 KC 模式需要一个不属于单个 KC 的身份——**是真的，而且已经 ship**（`misconception` + `caused_by→多 KC`），只是**不带 mastery、不靠机器凭 n=2 铸造**。
- **B 太窄（但没想的那么窄）**：只表达 row ②。诚实比较不是 `B` vs `C`，是 `(B + 已 ship 的 cause_category 标签)` vs `(那个 + 内容层身份实体)`。`cause_category` 已能 day-one 给 ①③④ 打扁平归因标签，所以"B 漏掉整个 taxonomy"半是稻草人。B+labels **真正缺的只有**：跨 KC 的**身份对象**（一个节点跨多 KC，作补救路由键）——而它**也已 ship**。

## 7. 推荐形态："B-live + authored 内容层缝"（映射到已 ship 基建）

四层，按 origin/main 实况定价：

- **Layer A — 内容词表（day-one，已有）**：`cause_category`（profile 声明的闭合词表，config + 自由文本列）。给 ①③④ 提供开箱归因标签。**不是**能挂边的实体 id。
- **Layer B — 每学习者推断态（活的核心，需接线）**：`kc_typed_state`。加 `under-identified` 一等可见态（证据稀疏时默认停这，**不自信断言**）；`confused-with-X` **只能经 `discriminating` probe** 到达（`typed-state.ts:48-62` 已 gate）。`resolved` **按类型分**：程序 bug 可"置换/修好"，直觉理论型只"抑制、可逆、never cured"。
- **Layer C — 跨 KC 身份（authored 缝，已 ship 表，需写路径）**：已有的 `misconception` 节点 + `misconception_edge(caused_by → 多 KC)`。**激活方式 = 人工 authoring**（owner 手写一个节点，`source='hard'`，weight=1），**无 mastery、无机器凭复发铸造**。学习者侧"是否持有" = `observed_in → event` 读时投影。**A 唯一对的直觉住这，去掉 mastery 轴和自动铸造。**
- **Layer D — mastery（不动）**：`mastery_state.θ̂` + FSRS 永远在 KC；任何误区路径不写它。这也是 **CBM 兜底**：应答匹配不上任何 cause 也照样降对应 KC mastery——**正确性是穷尽地板，误区诊断是精度点缀**。

**关键一刀（对齐 R2/R3/冷启诚实）**：**在 n=1 不要靠"recurrence≥2 + pgvector 去重"自动晋升**——它的 warrant 是 Eedi/CDM 的**人群级频率统计**，搬到一个人身上不成立，且开放题 judge 归因保真度低（distractor 域实测 31-47%，开放题很可能更差）会让计数被系统性噪声污染（两次抽样非独立）。已 ship 的 promotion writer 是"机器 propose + human-accept"，那个 **human-accept 就是 authored 元素**——所以推荐 = **保留 human gate、优先接人工 authoring、把纯自动晋升（recurrence 计数 + 语义去重 + retrieve-rerank）推到缝后面 deferred**。

## 8. 决策表

| 判据 | A（M 持掌握度） | B（只 typed-state） | **推荐（B-live + authored 缝）** |
|---|---|---|---|
| 科学保真 | ✗ 单调标量全否 + `.strict()` 禁 | ~ 只 row②，n=1 就断言分类 | ✓ 两层分 + `under-identified` 一等 + 类型分动力学 |
| 冷启 day-one | ✗ belief_strength n=1 无意义 | ✓ 标签有，但关系分支 inert | ✓ cause 标签 + authored 节点 day-one 活；只 defer 机器发现 |
| 工程成本（**修正后**） | ✗✗ 代码禁止的并行系统 | ✓ 一条 probe 竖切 | ✓ **基建已 dark-ship**；剩接线（probe loop + 人工写路径 + 533 消费）+ 翻 flag 决策，**非建表** |
| 处理开放题 | ~ | ~ 只能打分 | ✓ judge→cause→降 KC mastery（CBM），**上限 = judge 归因保真度（distractor 域 31-47%，开放题很可能更差、未量化）** |
| 处理 ①③④（非 KC-pair） | ~ 只 row③焊 mastery | ✗ 只 row② | ✓ ①=cause 标签+降 mastery；②=typed_state；③=authored `caused_by→多`；④ p-prim 留瞬态**不 reify** |
| 复用 infra / 最小充分 | ✗ 自带 embedding/阈值 | ✓✓ 最小但不充分 | ✓ 复用全部已 ship 软轨基建；**零新表**；**不翻**自动晋升器 |

## 9. Taxonomy 探针（4 例，owner 自检模型是否盖住脑内例子）

| # | 真实误区 | 拓扑 | 在推荐下的表示 |
|---|---|---|---|
| 1 | 问"平均数"却用"中位数"算法（文言：使动当意动） | ② KC-pair 混淆 | `kc_typed_state` 在"平均数"KC：`confused-with-X`, `confused_with_kc_id=中位数KC`——**仅 `discriminating` probe 后点亮**，否则 `under-identified`。纯 B，无需内容节点。 |
| 2 | 分数加法直接分子加分子、分母加分母 | ① 单 KC 程序 bug | judge 打 `cause_category='忽略通分'` → **CBM 降该 KC mastery**。typed_state 停 `no-evidence`（无第二 KC 可混）。可置换——`resolved`=真修好。跨情境反复才 author 节点。 |
| 3 | 把幂当重复乘法 → 2^0=0、误读科学计数法、算错复利 | ③ 跨 KC 抽象（A 动机） | **authored 缝**：owner 手写一个 `misconception` 节点，`caused_by → {幂,科学计数法,复利}`。学习者侧 = `observed_in` 读时 join。**节点无 mastery、无机器铸造**——A 的对直觉，轻量交付。 |
| 4 | 证明里把定理**逆命题**当等价用（无 distractor、无单一混淆 KC） | ④ 开放题-only / 类 p-prim | judge 打 cause_category → 降证明-KC mastery。**显式标"诊断上限=judge 归因保真度"（distractor 域 31-47%，开放题很可能更差、未量化，混合题尤甚）**。稳健跨情境才升 authored 节点；真 p-prim 资源**留瞬态不 reify**。 |

> 若 owner 脑内某典型例子落不进这四种，即模型欠覆盖信号——surface 出来重新划缝。

---

# Part III — 实施建议（提案，非已批准计划）

## 10. 修正后的工程现实

**大部分基建已 dark-ship**（§0.5 / §3）。所以实施不是"建 A 或建 B"，是**接活已 ship 的暗桩 + 一个 owner 翻 flag 决策**。下面按"90% 优先"排序。

## 11. 分阶段计划

### Phase 0 — 同步 origin/main（先决，~0.5 天）
- **`git pull --ff-only`**（本地曾落后 20 commit，本报告成文时已同步至 `b0ceac0b`）。任何实施在陈旧树上做都会假绿。
- **审计钟更正**：早前草稿称 misconception allowlist 条目 2026-07-31 到期构成"强制钟"——**这是错的**。核 origin/main：`audit-schema-allowlist.json` 里**零条** misconception/kc_typed_state 条目（S4 promotion writer 已有 INSERT 写路径，`audit:schema` 看得到 → 无需 waiver）；那些 2026-07-31 全属无关表。**misconception 相关代码无审计到期压力**。Phase 排序的唯一真实理由：**Phase 1 probe-loop 是 90% 的解锁，优先做**。

### Phase 1 — probe-resolution loop：让 kc_typed_state 混淆轴活（**THE 90%**，中等竖切）
- **目标**：解掉 `reconcile.ts:268` 的 `confused_with_kc_id: null` 硬编码；让 `induce.ts` 在有区分性证据时**产出非空 `confused_with_kc_id`**；`discriminating` probe 结果回灌 reconcile → `confused-with-X` 首次可点亮。
- **同时加 `under-identified` 态**（Critique 2）：`typed_state` enum 扩一个显式"证据不足"值，UI 可见，作稀疏证据默认。注意这是**改 enum**——走 migration + `kc_typed_state` 单写者 `upsertKcTypedState`，不碰 `mastery_state`。
- **红线**：probe 只写 `experimental:probe_result` 事件 + 推进 `kc_typed_state`，**绝不写 FSRS（ND-5）**；`beats-baseline` 只 license "定性轨预测更好"，**非"误区确认"**。
- **验证**：`test:db` targeted（`typed-state.db.test.ts` + reconcile 测），加一条"probe confirmed → confused-with-X 点亮"的端到端。

### Phase 2 — authored-seam 写路径 + 翻 flag 决策（小-中，**owner 拍**）
- **加一条纯人工 authoring 写路径**：owner 手写 `misconception` 节点（`source='hard'`, weight=1）+ `caused_by → 多 KC` 边。schema 已预留（`user-authored defaults 1`），缺的是端点 + 单写者纪律（advisory-lock，镜像现有 upsert）。
- **决定 `MISCONCEPTION_PROMOTE_ENABLED`**：本报告建议**先只开人工 authoring，机器自动晋升（recurrence 计数 + pgvector 去重 + retrieve-rerank）留 deferred**（n=1 warrant 不成立 + judge 噪声）。若 owner 要开机器 propose，**保留 human-accept gate**、k=2 owner-prior、并对 `gatherConjectureEvidence`（identity-preserving）而非 `aggregateMisconceptionRecurrence` 反查。
- **红线**：`.strict()` 守无 mastery；confidence server 侧离散成 band（⑥）；无 subject 列（经 `caused_by → effective_domain` 派生）。

### Phase 3 — YUK-533：`confusable_with` 死边接消费（中）
- 让 `confusable_with` 边喂**组卷层对比辨析题生成**（ADR-0036 "否则是死边"）。分支 `yuk-533-confusable-consumer` 已在建——**接续它，别另起**。canonical 排序（small-id as from）防无向重复。

### Phase 4 — 开放题错误码 → 误区证据路径（中-大，可后置）
- judge → `cause_category` 已活。补 **generate→retrieve→rerank**（Eedi 式）：judge 抽候选错误 → 对 misconception 目录 embedding 检索 → rerank → 写 `observed_in` 证据事件（概率化 + provenance，非硬翻）。**依赖 embedding triplet**（当前 L1 省略）→ 属"缝后面"的 YUK-454 语义检索/去重 slice。
- **CBM 兜底先行**：匹配不上任何 cause 的错答仍降对应 KC mastery——先保证地板，误区精度层后补。

### 明确 deferred（缝后面，别现在建）
- embedding 列 + `embed_backfill` 登记、pgvector 语义去重、retrieve-then-rerank、recurrence≥k 自动晋升、LLM 提议自动 promote（仅当人工 authoring 在 n=1 太累才启，单用户可能永远不需要）。
- MCQ distractor↔misconception 显式链（D2/D3 已裁"距distractor 路径死"，开放题走 judge-cause 统一链，不建 distractor 表）。

## 12. 单写者 / 不变量 / 须守的红线
- `kc_typed_state`：单写者 `upsertKcTypedState`（advisory-lock `kc_typed:*`），投影 over resolved evidence。
- `misconception` / `misconception_edge`：写路径经 accept route / 新人工 authoring 端点，单写者；topology 走**平行** `misconception-topology-gate.ts`（同构 `checkEdgeTopology` 只管 knowledge↔knowledge prerequisite）。
- 新表登记 5 面（本轮**不新增表**，故不触发；若 Phase 4 加 embedding 表则须：schema/migration/audit:schema/export FK_ORDER+SCHEMA_VERSION bump/db.ts ALL_TABLES + backup 往返测）。
- events：append-only 不可变；`mastery_state`：单写者在 KC，误区路径不碰。

## 13. 风险 + 只有 owner 能答的开放问题
**风险**：① **judge 是一切的地板**（开放题归因、cause 分配、任何未来晋升都压在保真度低的 judge 上——distractor 域实测 31-47%，开放题很可能更差；错误系统相关——**绝不凭原始计数晋升**，若开晋升须两个**独立**信号）；② **authored 缝烂尾**（owner 从不手写 → Layer C 空理论；缓解：seam 建时种 3-5 个高价值先验节点；无审计钟可依赖，靠 owner 主动决策）；③ **过度 reify row④**（p-prim 升成具名身份 = diSessa 错误；缓解：authored 节点限连贯性 licensed 类型，p-prim 留瞬态）。

**开放问题**：
1. **前置 author 还是按需？**（我倾向：seam 建时种 3-5 个课程级跨 KC 先验，之后按需。）
2. **`resolved` 按类型分语义接受吗？**（程序 bug 可治愈；直觉理论型只抑制可逆。驱动 UI 措辞 + 能否回翻。）
3. **`cause_category` 固定闭集还是开放世界**（LLM 提议 + 人工批准）？你之前倾向 retrieve-rerank + 增长（YUK-454）——确认。
4. **翻 `MISCONCEPTION_PROMOTE_ENABLED` 吗、何时？**（我倾向：先只开人工 authoring，机器晋升 defer；probe loop 现在排。）
5. **是否永不物化学习者侧"持有 M"？**（我倾向纯投影 over events；若分析逼迫，只存**非单调、会衰减**、显式**永非 mastery** 的边。）

## 14. Linear 映射（不新增 issue，重构既有）
可执行的活大多是**重构**既有 scope（砍自动晋升器、优先 probe loop）；唯一可能的真新增量 = Phase 2 的人工 authoring 端点，按 Linear capture gate 落成 YUK-531 follow-up（见下）：
- **YUK-440**：kc_typed_state 已 ship；Phase 1 probe-resolution loop 是其"接活"（confused_with 命名 + reconcile 回灌 + `under-identified` 态）。
- **YUK-531**：Done（S4 dark-ship）。Phase 2 的**人工 authoring 写路径**（带 single-writer/advisory-lock 的跨-KC authoring 端点）是**真新增量** → 待 owner 批准 Phase 2 方向后落成 YUK-531 的 follow-up issue（非新父单）。本报告是提案，phases 未获批前不预建实施 issue（避免加剧 Linear 腐败）。
- **YUK-532 / YUK-533**：进行中分支，Phase 3 接续 533（confusable_with 消费）。
- **YUK-454**：Phase 4 的 embedding/retrieve-rerank/去重 = 其语义检索 slice，deferred。
- **YUK-529**：Canceled（保持）。**YUK-530**：S3 DiagnosticDrill 读路径，gated ADR-0035 #4。
- **审计：无 misconception waiver**——origin/main 的 allowlist 里零条 misconception/kc_typed_state（写路径已存在），故实施 misconception 相关代码**不触发 audit:schema 到期压力**；仅 Phase 4 新增 embedding 表才需按 5-surface 登记 + 可能的 allowlist 占位。

---

## 附录 A — 文献引用（全部真实，带 venue / 证据等级）

**本体论（R1）** — Chi (2005) *JLS* 14(2); Chi (2008) 三型概念改变章; Vosniadou & Brewer (1992) *Cognitive Psychology* 24(4)（综合模型连贯性被 Panagiotaki/Nobes 2006 批为工具伪迹）; diSessa (1993) *Cognition & Instruction* 10(2-3); diSessa, Gillespie & Esterly (2004) *Cognitive Science* 28(6); Minstrell facets / DIAGNOSER (Hunt & Minstrell); Smith, diSessa & Roschelle (1993) *JLS* 3(2); Hammer (2000) *AJP*; Gupta, Hammer & Redish (2010) *JLS* 19(3); Gouvea (2023) *Frontiers in Education* 8; **Shtulman & Valcarcel (2012) *Cognition* 124(2)**（最强，widely replicated）; Potvin (2013/2015) prevalence 模型 *JRST* 52(8)。

**ITS bug 传统（R2）** — Brown & Burton (1978) *Cognitive Science* 2(2); Brown & VanLehn (1980) *Cognitive Science* 4(4); VanLehn (1990) *Mind Bugs* MIT Press（bug 迁移）; Anderson/Corbett/Koedinger/Pelletier (1995) *JLS* 4(2)（LISP 90/91）; Payne & Squibb (1990) *Cognitive Science* 14(3); Sleeman et al. (1989) *Cognitive Science* 13(4); Ohlsson (1994) / Mitrovic CBM。2025-26 arXiv MalruleLib 等为**未评审预印本**（低置信）。

**认知诊断（R3）** — Q-matrix / DINA(Haertel 1989; Junker & Sijtsma 2001) / DINO(Templin & Henson 2006) / LCDM(Henson/Templin/Willse 2009 *Psychometrika* 74); Tatsuoka (1983) Rule Space *JEM* 20; de la Torre (2009) MC-DINA *APM* 33; **Bradshaw & Templin (2014) SICM *Psychometrika* 79(3)**; **Kuo, Chen & de la Torre (2018) SISM *APM* 42(3)**; Wang (2024) DFSM *Psychometrika* 89(3); Xu & Zhang (2016) 可识别性 *Psychometrika*。较新 misconception-CDM 为中置信（真数据验证少）。

**现代系统 / Eedi（R4）** — ASSISTments Common Wrong Answer; ALEKS/KST(Doignon & Falmagne 1985; Falmagne et al. 1990 *Psych Review*)（对比：无误区目录）; **Eedi NeurIPS 2020 Diagnostic Questions (PMLR v133)** + **Eedi 2024 Kaggle "Mining Misconceptions"（2,587 条闭合目录 + distractor FK + MAP@25 + retrieve-rerank，最贴类比）**; DiVERT (NeurIPS 2024); Option Tracing (EDM 2021); 距distractor 生成 NAACL 2024。高置信（真数据 + 多独立复现），LLM 检测部分为预印本。

**测评设计（R5）** — King et al. (2004) Distractor Rationale Taxonomy (Pearson, 实践报告); Briggs/Alonzo/Schwab/Wilson (2006) OMC *Educational Assessment* 11(1); Wilson (2009) BEAR *JRST* 46(6); Brown & Burton (1978); Kuo/Chen/de la Torre (2017) 共存 CDM; **TIMSS 两位编码**（第二位 70-79 错误类别）; **NAEP×Eedi 三段标注**（60,000+ 应答）; AACR / Nehm et al. (2012)。LLM-judge 告诫（中段退化、过度锚措辞、"Correct Answer Trap"）为 2025-26 预印本（方法参考，非定论）。

## 附录 B — 关键代码坐标（origin/main `b0ceac0b`）
`src/db/schema.ts`（misconception 125-149 · misconception_edge 165 · misconception_reconciliation_log 1591 · kc_typed_state 1022 · knowledge_edge 1288 · question.choices_md 288）· `src/core/schema/{misconception,misconception-edge,cause,profile-decl}.ts` · `src/server/conjectures/{typed-state,reconcile}.ts`（reconcile.ts:268 null 硬编码）· `src/server/agency/conjecture/induce.ts` · `src/capabilities/agency/server/{misconception-promote,conjecture-accept}.ts`（flag 默认 OFF）· `src/capabilities/knowledge/{api/misconceptions.ts,api/misconception-veto.ts,server/misconception-*.ts}` · `scripts/audit-schema-allowlist.json`（无 misconception 条目）。
