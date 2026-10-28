# 私人教研团 · 产品愿景（"feel" 文档）

- **date**: 2026-06-18
- **status**: vision / pre-design — brainstorm 产物，待 A 轨 grounding + B 轨设计细化对账后转 spec
- **scope**: 泛用学习框架（目标）/ 学科教育（第一实例）
- **anchors**: KG 脊柱（结构 timeless，per ADR-0034，**非** bi-temporal——见 §11）、copilot 单人格编排者、FSRS/题库/错题、AI 共创 artifact、知识点、mem0 个性化层、pg-boss 独立 worker、evidence-first（可追溯可回滚）

> 这份文档捕捉的是**感觉与方向共识**，不是实现 spec。它是后续两条并行轨的共同输入。任何细节（schema、组件边界、构建序列）以对账后的设计为准；这里只钉「我们到底要造什么、为什么、哪些是红线」。

---

## 0. 一句话愿景

> **一个透明的、evidence-backed 的私人教研团：在你不在时为你做学情分析 + 规划 + 教学法设计，回来时把准备好的东西连同理由摆给你，你随时改方向盘。**

---

## 1. 共享诊断：为什么现在像「AI 加法」

现有形态（copilot + 题库 + 自动题流 + artifacts + 知识点）的问题不在功能不够，而在**骨架是 AI 之前的**。题库、间隔重复、推荐流、卡片，全是为旧世界四个约束设计的：

1. 内容贵 → AI 让内容即时生成
2. 批改贵 → AI 让开放/主观题即时可判
3. 反馈慢 → AI 让反馈零延迟
4. 一个老师看不过来一群人 → 一个无限耐心、永不遗忘的导师能盯你每一步

四个约束几乎全被溶解。只要保留旧骨架，做的就只是「把旧机器做便宜」。判据：**拆掉 AI，体验是只变慢变贵（= AI 加法），还是直接坍塌（= AI constitutive）？** 我们要后者。

---

## 2. 惊艳的核心：在你不在时为你工作

一个真实教研组最值钱的不是「人多、七嘴八舌」，而是那些**你看不见的活**：学情分析会、集体备课、命题、磨课、因材施教地单独排路。把这个搬上 AI，最惊艳的那一下是——

> 你打开它，不是面对一个等你输入的 chatbot；而是回来发现：「团队这两天复盘了你的进度，给你重排了下周计划，备好了三道专攻你那个反复错的点的题，还附了为什么这么排。」

这个「**为你而备、你不在也在转**」的异步协作感，是本愿景的情感内核。它顺手解掉单人无约束工具最毒的盲点——**第 90 天的弃用**：

- 一个**严厉的镜子**（考你、暴露你的无知）让人想关掉 → push。
- 一个**为你准备好东西、欢迎你回来的团队**让人想回来 → pull。

教研团框架天然是 pull 不是 push。技术上对应一个 sleep-time 巩固/备课 job（产出全进 `draft_status` 等你过目），地基（独立 pg-boss worker）已现成。

---

## 3. 感官 vs 大脑：ABC 必要但不充分

前面 brainstorm 收敛出的三条（ABC）是教研团的**感官**，但感官不会让人觉得「有人在为我负责」：

- **A 诊断深度（误解引擎）**：不判对错，合成诊断 probe 追问你*为什么*错，把 misconception 当 KG 上一等对象（独立异构表 + 多态边，per ADR-0036；**非** bi-temporal——见 §11）。
- **B 题型解放（判分孪生）**：把题型从封闭选择题解放到开放题（证明/论述/翻译），且记得你标准的演进。
- **C 泛用内核**：同一套 misconception/judge/calibration 机器跨所有学科**同构**，因为它操作 KG 结构而非学科内容。

惊艳不在感官层，在**大脑（meta 层）**——教研团在感官之上做三件感官做不了的事：

1. **学情分析**：维护「你」的活模型（目标、进度、misconception、轨迹）。
2. **为你规划**：排你学什么、给计划、讲清为什么。
3. **为你定制教学法**：决定*怎么*学这一块（worked example / 苏格拉底 / 微世界 / 间隔检索 / 项目…）。

之前两轮调研恰恰把规划（Curriculum Director）降级、把教学法没单拎出来——所以「不够惊艳」的缺口正在这里。

---

## 4. 教研团 = 一组「职能」，不是一群互相聊天的 agent

| 教研职能 | 干什么 | 真 agent 还是 prompt-step |
|---|---|---|
| **学情分析师** | 维护「你」的模型：目标、进度、misconception、轨迹 | orchestrator 内状态 + 单 prompt 更新 |
| **课程教研员** | 排你学什么、给计划、讲清为什么 | 单 prompt step（产出 = 可改提案）|
| **教学法设计师** | 定*怎么*学这块（按掌握度/误解证据选方法）| 单 prompt step |
| **命题 + 判分员（Jury）** | 出诊断题、判开放题 | **唯一需要真并行 subagent**（异构模型破偏置）|
| **导师** | 你真正对话的前台声音 | = 现有 copilot 单人格 |
| **教练 / 班主任** | 动机、节奏、「欢迎回来，这是我们备的」| 单 prompt step + 异步招呼 |
| **教研例会** | 你不在时复盘、改计划、备料 | sleep-time pg-boss job |

**核心原则：「团队感」是体验层的产物，不是要真建七个进程。** 真正需要独立 context + 并行的只有 Jury；其余都是中心化单写者 orchestrator 上的 prompt step，reconciliation 是一段确定性写入逻辑（非 agent）。这样既拿到「私人教研团」体验，又不踩 multi-agent swarm 虚胖的坑（[MAST taxonomy, NeurIPS 2025](https://arxiv.org/abs/2503.13657)）。

---

## 5. 架构姿态

- **orchestrator + 中心化单写者 learner-state**：同构现有 copilot 单人格（D14）+ `editing_presence` 单写 + evidence-log。
- **真 subagent 只有 Jury**；Scaffold（L2M 分解）、Step-Mirror、Devil's-Advocate 都是单 prompt step；把它们画成 spawn worker = 架构虚胖。
- **记忆三层（Letta OS 隐喻）**：
  - **CORE**（in-context，mem0 个性化层）= learner-model block；copilot primary **无写权**，只 sleep-time job 能写 → 天然契合 author/review 分离铁律。
  - **KG**（working memory）= **timeless 认知结构图**（结构是不变量，per ADR-0034，**不引 valid-time**）；learner-model 记 **per-edge 传导强度**而非 per-node 标量掌握度（`edge_state`，Phase 1+）；misconception 走 ADR-0036 独立异构层（`misconception` 表 + 多态 `misconception_edge`，gated 在一致性闸之后）。时变 learner-state（掌握/遗忘/复发）从 **event 流派生**（`created_at` + `last_evidence_at` + 衰减，可挂 ts-fsrs）；结构纠错走 `CorrectionKind` + `archived_at`；valid-time 唯一合法落点是 mem0 个性化软画像。
  - **EPISODIC**（archival）= 原始错题/答题/artifact，**只 ADD 不删**（对冲 naive summarization 丢 ~20% 事实——对学习产品=丢掉真实弱点）。
- **教研例会** = sleep-time pg-boss job：你不在时复盘、改计划、备料，产出进 `draft_status` 等过目。

---

## 6. judge 是良心：bootstrap 策略

两轮调研最硬的发现：**「judge 够准」是被偷偷假设、却撑着半数机制的单点故障。** 双时态信念修订、misconception 归因（SOTA 仅 ~40%）、技能突破率、薄弱链路边权——全部最终落到「LLM 能不能准确判跨科开放题」。这在 frontier 评测里仍是开放问题。给噪声盖上漂亮时间戳，噪声不会变成信号。

**bootstrap 路径**：

1. **地基**：真实结果↔预测**在线对账校准** + 你的**纠偏按钮**——让 learner-model 从「AI 断言」变成「被你真实表现持续证伪的概率模型」。你既是学习者又是最高质量标注者，每次纠偏复利成 golden 锚点。
2. **先在能核对的地方建立信任**：学科里**客观可判子集（数学/理科，答案可数值/符号核对）**= 现成的 cheap 可信验证信号。在这里把判分校准养出牙。
3. **再指向核对不了的地方**：开放/主观题（论述、文言翻译、历史分析）= 产品真正的天花板。
4. **铁律**：任何 `judge-dep` 机制上线即绑 calibration harness + owner 锚点；Jury 用你的异构 provider lane（mimo + Opus 订阅）破 judge 同质化偏置——这是别人没有的现成 moat。

---

## 7. 泛用 vs 学科教育

- **泛用框架 = 架构**：KG 脊柱 + judge + calibration + misconception 建模，全部 **domain-agnostic**。这正是现有 `core/`（跨科）vs `subjects/<name>/`（单科特化）分层，和「科目是视角不是结构」。
- **学科教育 = 第一个 content 实例**：往这套引擎灌学科内容，先只点亮这一个擂台。
- 一句话：**框架照泛用设计，第一版只证明学科这一个实例。** 学科教育不是产品身份，是这台泛用引擎第一个证明自己的擂台。

---

## 8. 红线与张力（设计期必须守）

1. **规划只出提案不拍板**：evidence-backed、讲清理由、你一键改/否决、据此调整。强工程师 owner 最不愿交出的就是「学什么」的方向盘——靠透明把方向盘**暂借**给它，不是夺走。
2. **教学法定制按掌握度/误解证据，不是 learning styles**（视觉型/听觉型那套已被证伪）。有证据的因材施教是 expertise reversal effect、guidance fading、desirable difficulty 校准——挂在 misconception/掌握度证据上。这条对 evidence-first 的 owner 是红线。
3. **engagement 是头号过滤器**：选任何主循环前先问「这个设计让我第 90 天更想回来还是更想关掉？」。pull not push。每处 instrumentation friction（登记 confidence、被判分、被监视）在单人工具里都是**复利的弃用风险**。
4. **judge-dep 机制上线即绑 calibration harness**，否则只是「相信 LLM 没漂」的信仰。
5. **不建 swarm**；复杂 agent 机制限制在「有自动 ground truth 的子域」，否则是 cargo-cult（Voyager/Generative-Agents 能 work 靠确定性环境信号或大规模群体，学习域两样都没有）。

---

## 9. 证据基底（关键引用）

- 记忆 + 反思：[Generative Agents（arXiv:2304.03442）](https://arxiv.org/abs/2304.03442)、[mem0（arXiv:2504.19413）](https://arxiv.org/abs/2504.19413)、[Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute)
- KG 时间维（**非采用** bi-temporal）：[Zep/Graphiti（arXiv:2501.13956）](https://arxiv.org/abs/2501.13956) 的双时态服务「多 agent 世界事实时效」；本项目 KG 是 timeless 认知结构，ADR-0034 已否决 bi-temporal，时间维拆给 event 流 / CorrectionKind / mem0 三轴
- 多 agent 失败学：[MAST taxonomy（arXiv:2503.13657）](https://arxiv.org/abs/2503.13657)、[debate-as-vote 证伪（arXiv:2502.08788）](https://arxiv.org/abs/2502.08788)
- 脚手架/规划：[Least-to-Most（arXiv:2205.10625）](https://arxiv.org/abs/2205.10625)
- 判分/验证：[Generative Verifiers GenRM（ICLR 2025）](https://arxiv.org/abs/2408.15240)、[Universal Self-Consistency](https://learnprompting.org/docs/advanced/ensembling/universal_self_consistency)
- 校准护栏：[semantic entropy（arXiv:2511.04869）](https://arxiv.org/pdf/2511.04869)、[conformal abstention（arXiv:2405.01563）](https://arxiv.org/pdf/2405.01563)
- 新媒介谱系：Matuschak & Nielsen 助记媒介（Quantum Country / Orbit）、Bret Victor 可探索解释
- 教学法证据 + 伪科学警示：worked-example / expertise reversal / guidance fading（成立）；learning styles（**已证伪，勿用**）；Bloom 2-sigma（注意其增益建立在强制脚手架上，搬到单人自愿工具是 category error）

---

## 10. 待解问题（A 轨 grounding + B 轨设计细化要回答）

1. **团队的「心脏」先建哪颗**：规划脑 / 教学法脑 / 关系脑（学情分析 + 异步为你而备）？（brainstorm 未锁，留给设计权衡）
2. **第一个学科实例选什么**：数学/理科（= judge bootstrap 域，可核对）优先？
3. **thin slice**：第一个能让你感到「团队在为我工作」的最小可感知切片。
4. **grounding（A 轨）**：现有 capability 包 / KG / 记忆层 / FSRS / evidence-log / worker 中，哪些职能能直接复用、哪些要改、哪些缺失。
5. **engagement 的具体形态**：「欢迎回来 + 为你而备」在 UI/节奏上长什么样，才是 pull 不是负担。

---

## 11. grounding 后的决策修正（2026-06-18，对账 5 张 codebase map + 3 版心脏设计 + ADR-0034/0036）

> 本节是权威修正，与上文任何冲突处以本节为准。

- **心脏裁定（owner 已确认）**：先建**关系脑**（备课台 + sleep-time 例会 job）。规划脑→Phase 2、教学法脑→Phase 3，作为例会内 prompt-step 后续插入。关系脑最接地（基础设施大半已 ship：`agency/jobs/dreaming_nightly.ts` 模板 / proposal-as-event 可纠偏面 / CORE 单写 / evidence-log / provider lane / calibration 底座）、judge 风险隔离最干净、正面攻 day-90 弃用，且是另两颗心脏的容器。
- **bi-temporal 裁定：遵从 ADR-0034，KG 不引 bi-temporal**。理由：① KG 存 timeless 认知结构，bi-temporal 是为「关于变化世界的事实」设计（Graphiti 多 agent 场景），与单用户认知结构 category mismatch；② 会变的是 learner-state，已由 event 流 `created_at` + 派生 `mastery_state` + `last_evidence_at` + 衰减承接（「学过又忘」vs「没学过」由此区分）；③ misconception 生命周期 = append-only event 序列 + 节点 status，是 event-time；④ 结构纠错走 `CorrectionKind`；⑤ append-only event log 已免费提供 transaction-time 回放（要 as-of 重放 events 即可，ADR-0044），不需第二条 valid-time 轴；⑥ valid-time 唯一合法落点 = mem0 软画像（关系脑确实用它记你的偏好/习惯漂移）。**若未来确需结构 as-of 时间旅行，是开 superseding ADR 复活双轴，不是设计层偷绕。**
- **misconception 形态**：ADR-0036「独立异构 `misconception` 表 + 多态 `misconception_edge` + 晋升而非复制 + 人审 gate」仍是唯一 Accepted 决定；2026-06-16 的 `meta_cause` taxonomy（6 类机制主轴，`flawed_model`=misconception + metacog/bloom 两正交轴，落 event payload）是其下的**观测层正交增强**，不推翻它。但身份层**至今零代码**（gated 在一致性闸 ADR-0034 之后，且若干 owner gate 未拍）。
- **Phase 0（采纳 §12 全部修正，2026-06-18 owner 拍「全采」）**：中心数据类型 = **一等 conjecture 对象**——关于你大脑的一条信念（claim + confidence + provenance 回链 event + 一道未跑的判别 probe），活在现有 event log + proposal-as-event，**不建 misconception 表、不需 consistency-gate**。`cause_category × KC` recurrence（经 `effectiveCauseForFailureAttempt()`，`src/server/events/cause-policy.ts`）降为*归纳 conjecture 的信号源之一*，不再是中心。**Reconstruction 作教学法脑的一种方法（远期，不删题库）**、**Subtraction 作 proposal type**、**Work Metabolizer 作冷启动输入层**一并纳入。验收用 conjecture 确认率非退化 + owner 锚累积 + 两周打开/愉悦（**不再用 Anki 导出测试**——见 §12 修正 + §13）。持久化 misconception 身份表 + per-edge `edge_state` 推到一致性闸后的 Phase 1+。

---

## 12. 逃逸检验裁定（2026-06-18，history-blind 三视角 + 裁定）

> owner 问「带项目上下文的 rethink 会不会走不出历史」。独立 history-blind 检验：**Escape score 3/5（半突围）——逻辑层突围，骨架层被拉回引力井。** 本节记录裁定与修正；§11 Phase 0 的中心数据类型据此修正（待 owner 确认采纳程度后定稿）。

**方法论关键**：grounding 那轮 auditor 判「计划干净」是**循环论证**——愿景文档本身是 grounding 之后写的，拿它验 plan = 测两份同源文档一致性。真正独立的两个视角（from-scratch + ambition-recoverer）各自从不同入口命中同一处：**protagonist 选错了。**

**真突围的**：① async sleep-time 例会 = 惊艳机制本身（非廉价替身）；② bi-temporal 是干净截肢（§11 第一性原理重新推导拒绝，非援引 ADR 权威）；③ Jury-only/反 swarm 是 vision 红线推出的。

**被拉回引力井的（要害排序）**：
1. **protagonist 仍是 artifact**：中心仍是「在既有 question/KC/错题之上叠加推理」，未删任何 pre-AI 骨头。**Anki 导出测试**：所有幸存方向都能无损导出成 Anki deck → 骨架层面 safe plan 仍是「Anki + 更友好的教练」。pull-based async tutor 仍是 tutor（pre-AI 角色）；AI 让它*买得起*，没让它*constitutive*。
2. **consistency-gate 作 Phase 1**：无任何 vision 段落驱动，纯 ADR-0034 依赖图遗产（history 塑造 sequencing scope）。
3. **misconception 一等对象推到长依赖链末端**：read-time 信号有 ossify 成永久 vaporware 的风险。

**「关系脑先行」终审**：**vision choice 成立**（剥掉「最廉价」理由后，judge-risk 隔离 / day-90 engagement / 容器性三条独立且唯一选中关系脑，非 back-fill）。**但流程 under-tested**——本案「廉价=正确」恰好重合，流程从未被证明能在两者分叉时选对。

**修正（不换 phase，换 Phase 0 的中心数据类型）**：从「read-time cause×KC recurrence 信号」→ **一等的 conjecture 对象**：关于你大脑的一条信念（claim + confidence + provenance 回链 event + 那一道还没跑的判别 probe）。关系脑仍先行，但它**持有并检验关于你的信念**，而非*分析 artifact*。判据：conjecture-with-provenance **导不进 flashcard**——Phase 0 必须有的「不可导出物」。它活在现有 event log + proposal-as-event，不需 misconception 表/consistency-gate，且正是 Misconception Engine 的种子（confirmed conjecture = misconception）。

**该复活的三个野心（互相补救弱点，是一组被同一骨架形状误杀的）**：
- **Reconstruction（「从父节点重建」）= 教学法脑的一种方法（远期，可选），不是删题库的 North Star**（2026-06-18 owner 第二次纠偏：题库是教研团的工具、真团队也用，「删 pre-AI 器官」是 novelty-purism 误判）。它与「从题库调题」（matcher/retrieval）**平级**，由教学法脑按人/时机选。轻量可选护栏：保持 KG 依赖结构够丰富让「重建」将来可用——但**不为此把 `question` 表降级**。详见 YUK-407（已重构）+ §13。
- **Subtraction Engine = 关系脑 async 循环里的一种 proposal**：团队趁你不在提议 merge/demote/delete 节点 + 理由，你 approve/override；进度可向下（更少更整合=更深）。近零边际成本（复用 proposal-as-event）。
- **Work Metabolizer = 冷启动输入层（partial）**：学科语境下「你的产出」= 答案/推理痕迹/笔记，喂 conjecture 引擎 + 解 Reconstruction 的 sparse-KG cold-start。

**不复活**：Calibration Mirror（折进 probe 信号）/ Microworld Forge（仅 sim-natural 科目当 content type）/ Think-Out-Loud Canvas（当 Work Metabolizer 输入 UI）/ Protégé（Reconstruction 后再 A/B）/ Adversarial Examiner（当 Misconception 强度开关）。

**守则**：codebase 只能答「先做哪个、多贵」，永不能答「做不做、敢不敢」；reuse 论证一旦出现「因为表已经在了/因为不用碰未建的 X」，划出 scope 论证、只准进 sequencing。
**三 tripwire**（① 经 2026-06-18 修正）：① **正确的 constitutive 标尺**——不是「像不像旧工具 / 能不能导成 Anki」（真教研团也用题库，导得出 ≠ 是 Anki），而是「**它有没有给*一个人*提供以前不可能的专属团队级关注：连续看每一题 + 完美记忆 + 不眠响应 + 持有并检验关于你的信念**」；② **「廉价≠正确」分叉演练**（流程会不会报警）；③ **Planning/Pedagogy 须有 expected_by 日期**——它们是 vision §3 自诊断的惊艳缺口，否则 demo 成功会把惊艳永久挤出 roadmap（demo 成功是 ambition 最大的敌人）。

---

## 13. 本次 rethink 抛弃清单（2026-06-18，供 owner 复核）

> 原则：列出来防止「成果静默丢失」。**抛弃 ≠ 永久删除**——每条标「去向 / 复活条件」。
> **完整版**（每条带原始赌注 + 当初为何诱人 + 复活条件，供 owner「捞出来」）见独立归档 `2026-06-18-rethink-abandoned-directions-archive.md`。本节为缩写索引。

### A. 产品方向（发想 13 菜单里被丢 / 降的）

| 方向 | 为何抛弃 | 去向 / 复活条件 |
|---|---|---|
| **Reconstruction Engine**（从父节点重建、删题库） | novelty-purism 误判（真团队也用题库） | **降为教学法脑的一种方法**（远期可选），YUK-407 已重构 |
| **Work Metabolizer**（学你的真实产出） | 泛用/终身向，与「学科教育先行」错配 | **部分复活**为 conjecture 引擎冷启动输入层（你的答案/推理痕迹/笔记）；泛用阶段再升 |
| **Curriculum Director**（替你排路） | distal feedback、信任最难赚 | = **规划脑**，保留为 heart，相位推后（Phase 2，带可验证预测 + 对账） |
| **Long Exposure**（以年为单位认识论实验） | payoff 一年后才兑现 | 可选反射层，不进早期；bi-temporal 数据本来就在 event 流 |
| **Calibration Mirror**（知不知道自己知不知道） | 本质 dashboard，AI 非 constitutive | 折进 conjecture 的 confidence + 误解 probe 信号 |
| **Adversarial Examiner**（击败你的错误观点） | 单独做边际低 | 折进 Misconception/conjecture 的**强度开关** |
| **Microworld Forge**（操作可跑 sim） | 不泛化全科 + 真贵 | 仅 sim-natural 科目（物理/编程）当 content type |
| **Think-Out-Loud Canvas**（会反驳的笔记本） | 是编辑器 feature 不是引擎 | 可当 Work Metabolizer 的输入 UI |
| **Protégé**（教一个自信的笨蛋） | 单用户 adoption 是口味猜测 | 远期 A/B |
| **Replayable Mind / One Living Document** | 进度 dashboard 豪华版 / 单一巨文档不可导航（Matuschak retrospective 实证 3 杀手问题） | 删，价值被别方向吸收 |

### B. Agent 方法论（被证伪 / 砍的）

| 方法论 | 为何抛弃 | 复活条件 |
|---|---|---|
| **自动跨月课程线（Auto-Quest）** | owner 自己是课程设计者；验收又回判分 | 仅在有自动 ground-truth 子域试 |
| **影子学生模拟** | 单用户无群体分布校准模拟器 | 多用户后再议 |
| **元认知反思树（裸用）** | n 小 + AI 自贴标签 = 统计幻觉 | 只在 sleep-time + draft review 内、数据足够后 |
| **技能蒸馏（Voyager skill library）** | 学习域无确定性成功信号，「突破率」又回判分 | 有自动 verifier 的子域（代码测试通过）才试 |
| **debate-as-vote（多 agent 投票定真值）** | 2025 已证伪 hype | 只保留 debate-as-content（生成正反论证当材料） |
| **宪法式 rubric 自审（CAI 包装）** | CAI 是训练时 RLAIF，此处实为推理时 self-critique，名不副实 | 机制以「准则 + 一次 self-critique」留判分链，不贴 CAI 标签 |
| **一群互相聊天的 agent（swarm）** | MAST 失败模式 + 单用户复杂度虚胖 | 永不（唯一真 subagent = Jury） |

### C. 架构 / 框架立场（被推翻的）

| 立场 | 为何抛弃 | 复活条件 |
|---|---|---|
| **bi-temporal on KG**（valid_at/invalid_at on edges） | KG 是 timeless 认知结构；时变走 event 流；valid-time 仅 mem0（ADR-0034） | 开 superseding ADR + 出现真实 as-of 结构查询消费者 |
| **「删题库 / AI-native = 避开 pre-AI 形态」** | novelty-purism；真教研团也用题库（owner 第二次纠偏） | 不复活（错误前提） |
| **「Anki 导出测试」当 constitutive 判据** | 真团队的题库也能导出，判据本身坏 | 不复活；换成「是否提供以前不可能的专属团队级关注」 |
| **「这只是 AI 加法、功能够了」原始前提** | 整个 rethink 的起点就是推翻它 | 不复活 |

> 两条 framing 教训（owner 两次纠偏）：① grounding 会把 rethink 拽回**增量主义**（历史陷阱）；② 矫枉过正会冲进**新奇洁癖**（为不一样而否定旧工具）。判据守则：**别用「像不像旧工具」量，用「是否给一个人提供以前不可能的专属团队级关注」量。**

---

## 14. 保留清单（reframed-not-deleted，owner 三次确认「不删」）

> **rethink ≠ 推倒重来。** 以下既有功能**全部保留**，只是角色从「产品主角」退成「被大脑编排的服务/工具」。owner 反复担心「删」，本节钉死：除已**撤销**的 Reconstruction「删题库」北极星，**没有任何既有功能在删除名单上**。

| 功能 | 状态 | 新角色（reframe，非删除） |
|---|---|---|
| **题库（question bank）** | ✅ 保留 | 内容**供货层**；matcher 给它供货；conjecture/规划 panel 从中取题；从「唯一真相源」退成「probe/练习的缓存与供给」——**不再是唯一真相源**，但照常是内容一等载体 |
| **练习流（题流）** | ✅ 保留 | **「投递面」**——probe 与练习经它投递；「往流里推什么」由 B3 合并引擎（YUK-349，早定）+ 规划 panel 决定；你刷流照旧 |
| **试卷 / 卷架（组卷）** | ✅ 保留 | 从「独立东西」reframe 成「从流派生的视图」（A2 早定）；matcher/组卷供货；可被 conjecture 驱动出**专打你弱点的卷** |
| **FSRS 调度** | ✅ 保留 | 三轴正交里的 **R 轴单写者**；规划/credit **绝不污染它**；conjecture 确认的 weakness remediation 经它做长期复习 |
| **Copilot（前台单人格）** | ✅ 保留 | 前台对话声音 + 叙述 Layer 0；审议 panel/团队**藏身后，绝不实时刷屏** |
| **artifacts / 知识点 / 错题** | ✅ 保留 | 错题 → conjecture 证据源；知识点 = KG 节点；artifacts 继续 |

> 唯一沾过「删」字的是 Reconstruction Engine 的「删静态题库」北极星——**已撤**（novelty-purism 误判，真团队也用题库、也调题），降为教学法脑的一种方法（YUK-407，§12/§13）。**守则**：codebase 只答「先做哪个/多贵」，永不答「做不做/敢不敢」。
