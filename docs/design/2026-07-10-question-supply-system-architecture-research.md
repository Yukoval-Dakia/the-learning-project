> **归档说明(2026-07-16 驾驶舱 re-grounding)**:本稿 2026-07-10 成稿后从未入库,唯一副本压在 `git stash@{0}`(未跟踪文件),本次抢救归档,原文保真(下方正文未动)。其结论已折入供给线后续裁决与 `docs/design/2026-07-13-question-supply-xueke-acquisition.md` —— 07-13「Loom 不需要新建 20k-LOC 供题控制面子系统、现行 question-supply/ 脊柱 + ADR-0021 txn outbox 足够、治理机械仅按体量触发分期引入」的判词即以本稿为研究底。参考实验仓 `codex/provider-neutral-adapter`(/private/tmp 隔离仓,never-pushed)已消失,其 19 处 engine/panel 分歧等审计证据的结论由本稿与 xueke doc 固化。

# 供题系统架构研究：从“出题队列”到“证据库存控制面”

> 日期：2026-07-10  
> 状态：架构研究稿，不是实施计划，不对应 Linear 拆单  
> 范围：题目需求发现、获取/生成、验证、题库治理、曝光与学习反馈闭环

## 结论

loom 需要的不是一条更聪明的 quiz_gen 队列，而是一套**供题控制面**：

1. **selection 与 supply 分层**：selection 决定“现在给学习者哪一题”；supply 决定“未来练习窗口内要维持什么证据库存”。
2. **需求是证据目标，不是出题参数**：需求契约应表达 claim、observable evidence、task model、允许用途、信任下限和停止条件，而不止 KC、kind、count。
3. **持久 target 负责收敛，当前事实负责真相**：事件触发低延迟 reconcile，夜间全量 reconcile 负责自愈；target ledger 记录收敛工作，但 desired state 必须可以由当前学习状态和合格库存重新计算。
4. **库存按独立题族和允许用途计量**：同题换系数、共享刺激材料、近期已曝光、未验证草稿不能假装成新的有效容量。
5. **库存采用三层组合**：稳定核心题、已验证 item model 的参数化变体、自由生成题。自由 LLM 只进入低风险 formative 通道；即使题目不复用，也必须留版本与作答审计。
6. **质量不是单一 source tier**：来源、内容验证、评分稳定性、心理测量成熟度和 allowed use 应分开表达。
7. **n=1 主动克制**：不把单用户数据包装成稳定的 2PL/3PL、DIF、群体曝光率、item drift 或路线 bandit；难度必须带量尺、依据与置信度。

一句话形状：

> **Sparse demand ledger + evidence-family inventory + CONWIP + event/nightly reconciliation + tiered item qualification**

## 调查方法与证据边界

本结论来自四条相互独立的证据链。

### 1. 当前系统与样本

- 只读追踪当前仓库从 learning intent、coverage scan、dispatcher、sourcing/quiz_gen、verify、active pool、selection 到 attempt/mastery 的完整路径。
- 对本轮 33 个供题批次、58 道成功产出题、4 个失败批次以及 9 学科独立审查结果做离线复核。
- 对冷启动、池见底、来源断网、验证误杀/漏杀、批次失败、跨批重复、过曝等 12 条路径做逐步状态推演。

本仓已有设计方向可见：

- [Question Supply Target Discovery Architecture](./2026-06-15-question-supply-target-discovery-architecture.md)
- [Coverage Lattice](./2026-07-07-yuk579-coverage-lattice.md)
- [Selection Engine Three-layer Design](./2026-06-15-selection-engine-three-layer-design.md)
- [ADR-0038 Unified Verify / Plan-then-generate](../adr/0038-unified-verify-contract-plan-then-generate.md)

### 2. 产品机制与 hands-on

研究了 Duolingo、ALEKS、Khan Academy、Moodle、Anki、Quizlet 的公开机制；实际走通了三条公开 UI 路径：

- **Duolingo**：选择英语 → 采集学习动机 → 自报先验水平 → 选择每日时间预算 → “从基础开始 / 评估水平”分叉 → 依据自报水平推荐第 2 阶段 → 首道分级口语题。它先确定课程、意图、预算和起点，再从课程内容中选题，而不是现场自由生成正式题。[Birdbrain / Session Generator](https://blog.duolingo.com/learning-how-to-help-you-learn-introducing-birdbrain/)
- **ALEKS**：公开学生导览明确先做约 25–30 题 adaptive assessment，再把 mastered、not learned 与 prerequisite-ready topics 显示为知识空间，并推荐可学边界。[ALEKS tour](https://www.aleks.com/independent/students/tour_stu_assessment)、[About ALEKS](https://www.aleks.com/about_aleks/)
- **Moodle 5.2 sandbox**：使用官方公开教师 demo 账号进入一门 blank course；Question banks 页面明确显示“尚无题库”，只能显式创建题库。平台提供 Draft/Ready、版本、评论、使用统计等治理能力，但不会因空池自动造题。[Moodle question bank](https://docs.moodle.org/401/en/Question_bank)、[官方 sandbox](https://sandbox.moodledemo.net/)

还实际读取了一个 13 条目的 Quizlet 公开 UGC biology set：内容可以直接进入 Flashcards/Learn/Test，但质量责任主要仍在作者和使用者，而不是一个统一 promotion gate。[公开 set](https://quizlet.com/50681880/biology-flash-cards/)、[Quizlet Learn](https://help.quizlet.com/hc/en-us/articles/360030986971-Studying-with-Learn)

hands-on 只走公开、合法路径；没有创建付费账户、绕过登录墙或修改课程内容。

### 3. 文献与标准

- Evidence-Centered Design 要求从要支持的 claim，反推 observable evidence 与能诱发证据的 task；这直接否定了“KC + 题型 + 数量就是完整需求”。[Mislevy et al., ECD](https://www.ets.org/research/policy_research_reports/publications/report/2003/hsgs.html)
- CAT 不只是“找离 theta 最近的题”，而是校准题池、内容约束、item selection、exposure control 和 stopping rule 的组合；没有稳定校准池时，只能把 Fisher information 降格为启发式。[CAT components](https://pmc.ncbi.nlm.nih.gov/articles/PMC5968224/)、[ITC Technology-Based Assessment Guidelines](https://www.intestcom.org/upload/media-library/guidelines-for-technology-based-assessment-v20221108-16684036687NAG8.pdf)
- Knowledge tracing 更新的是含猜测、粗心、学习与遗忘假设的隐状态；一次答错不能直接等同于“不会”，也不应直接引爆大量供题。[Corbett & Anderson 1995](https://doi.org/10.1007/BF01099821)、[Knowledge Tracing survey](https://doi.org/10.1145/3569576)
- 自动出题的成熟路线以显式 item/task model 为核心，不是开放式“围绕主题写 N 题”。[Gierl & Lai 2012](https://doi.org/10.1080/15305058.2011.635830)
- LLM 题目在窄域研究中可以接近人工题的部分属性，但系统综述仍认为总体证据质量很弱；这支持“生成候选”，不支持“自由生成后自动成为正式测量题”。[代数题实证](https://www.sciencedirect.com/science/article/pii/S2666920X24000870)、[系统综述](https://pmc.ncbi.nlm.nih.gov/articles/PMC12758716/)
- QTI 适合作为 authoring、item bank、delivery 之间的交换层，不应反向充当内部生命周期模型。[QTI 3](https://www.1edtech.org/standards/qti/index)
- ITC 与 PROV-O 都支持稳定 item identity、不可变 revision、来源、活动和责任主体的 lineage。[ITC Guidelines](https://www.intestcom.org/upload/media-library/guidelines-for-technology-based-assessment-v20221108-16684036687NAG8.pdf)、[W3C PROV-O](https://www.w3.org/TR/prov-o/)

### 4. 红队与控制系统模拟

把 nightly push、取题时 JIT、持久 target ledger、稳定核心题 + ephemeral 四类形状放进 10 个故障场景做独立评分。另从库存/排队视角建立玩具模型：

- 一个 target 需要 2 个合格题；
- 每候选过验率 0.6；
- 生产加验证延迟均匀为 1–3 天；
- 每日扫描，无容量争用；
- Monte Carlo 10 万次。

固定 7 天 cooldown 的平均满足时间为 10.0 天；attempt 终态后按剩余缺口续单的 target single-flight 为 4.3 天。两者平均 job 都约 2.14、候选都约 3.33。固定 cooldown 没有节省产量，只把平均缺货期拉长约 57%。该模型没有计入当前 enqueue/event 撕裂和跨进程竞态，因此反而偏袒 cooldown。

这不是生产预测，而是用于验证控制语义的玩具实验。

## 关键事实：当前瓶颈不在“能不能生成”

### 当前闭环真实断点

~~~text
learning intent
  → learning_item(pending)
  → [缺 pending → active/in_progress 正向迁移]
  → nightly / refill / new-check 的 active-KC 作用域恒空

coverage scanner
  → 完整 QuestionSupplyTarget
  → dispatcher
  → [job payload 丢失 gap、difficulty、trust、avoid、stop condition]
  → sourcing / quiz_gen
  → draft
  → verify
  → active pool
~~~

coverage scanner 的 R1–R4 本身有价值：池深度、来源质量、near-theta 锚与题型多样性都是真需求。但当前有四个结构问题：

1. scanner 的作用域恒空；
2. target 到 job 的信封萎缩；
3. enqueue 事件被当成“已处理”并触发 7 日 cooldown；
4. job、candidate、verify、item activation 之间没有 target/attempt 因果链。

### 58 题样本告诉我们的事

| 指标 | 结果 | 架构含义 |
|---|---:|---|
| 批次成功 | 29 / 33 | 生产需要 partial/slot 级重试，不应整批重烧 |
| 生成题 | 58 | 模型有基本产能 |
| 自动 active | 38 / 58 | active 不是质量真相 |
| 独立审查 good/usable | 52 / 58 | 内容总体可用，但缺少需求定向 |
| 门禁精度 | 36 / 38 = 94.7% | 仍漏进 2 道 flawed |
| 门禁召回 | 36 / 52 = 69.2% | 16 道可用题被误挡 |
| solve_check fail | 16 | 16 道全部被独立审查判为 good/usable |
| 难度 2–3 档 | 55 / 58 = 94.8% | 没有可执行的目标难度需求 |
| engine disagreement | 19 / 58 | verifier 不能是不可解释的单点裁决 |
| 可见生成成本 | 约 $2.74 | 生产不是主要可见成本 |
| 可见 solve + teaching 成本 | 约 $8.67 | 验证成本约为生成的 3.2 倍 |

样本还出现至少两组明确跨批次近同构题；数学 10 题中 8 题集中在同一窄考点。两道二次函数题仅常数项不同，却被当作两个有效库存单元。

因此：

> 供题系统的核心产物不是 question row，而是“经过资格判定、可独立提供某种学习证据的 item family capacity”。

## 架构总图

~~~mermaid
flowchart LR
  subgraph OBS["观测事实"]
    G["学习目标与课程边界"]
    L["mastery / uncertainty / due / frontier"]
    I["合格库存、题族、曝光与健康"]
    M["placement miss / selection miss / owner request"]
  end

  G --> R["Desired-state Reconciler"]
  L --> R
  I --> R
  M --> R

  R --> T["SupplyTarget Ledger"]
  T --> P["Capability-aware Route Planner"]

  P --> A1["真实题导入 / 来源检索"]
  P --> A2["已验证 Item Model"]
  P --> A3["Owner Authoring"]
  P --> A4["自由 LLM 候选"]

  A1 --> C["Candidate Revision"]
  A2 --> C
  A3 --> C
  A4 --> C

  C --> Q["Deterministic Gates + Dedup + Independent Verification"]
  Q --> U["Qualification / Allowed Use"]
  U --> V["Evidence-family Inventory Projection"]

  V --> S["Delivery Selector"]
  S --> X["Exposure / Attempt / Outcome"]
  X --> L
  X --> H["Item Health"]
  H --> I

  E["事件：标脏并加速 reconcile"] --> R
  N["夜间：全量 reconcile 与孤儿恢复"] --> R
~~~

最关键的边界：

- **Reconciler** 决定库中缺什么。
- **Route planner** 决定用哪些能力收敛目标。
- **Producer** 只负责兑现一个受约束的 slot。
- **Qualification** 决定题能用于什么。
- **Selector** 只从有资格的库存里选择当前题。
- **Learning model** 只消费与题目资格相匹配的证据权重。

## 三个不同对象：Signal、Target、Attempt

### DemandSignal

一次不可变事实，例如：

- 一个 KC 成为课程前沿；
- placement 无可信候选；
- selection 因 trust/kind/exposure 找不到题；
- 某 misconception 有重复证据；
- item revision 被隔离导致覆盖下降；
- owner 明确请求某类题。

Signal 不是订单。多个 signal 可以汇聚到同一 target。

### SupplyTarget

系统对未来库存的**版本化 desired state**。它必须可被重新计算、过期、supersede 或 reopen。

Target 至少包含：

~~~json
{
  "coverageReason": "pool_depth | source_quality | diagnostic | format_diversity",
  "claim": {
    "knowledgeIds": ["..."],
    "inference": "希望支持的学习判断",
    "prerequisiteState": "..."
  },
  "evidenceTarget": {
    "observable": "希望看到的作答行为",
    "misconceptionIds": ["..."],
    "responseMode": "...",
    "scoringOrRubric": "..."
  },
  "taskModel": {
    "kind": "...",
    "cognitiveProcess": "...",
    "materialConstraints": ["..."],
    "accessibility": ["..."]
  },
  "difficultyTarget": {
    "scale": "author_ordinal_v1 | logit_anchor_v1",
    "interval": [0.0, 1.0],
    "basis": "planner | expert_anchor | empirical",
    "confidence": 0.4
  },
  "inventoryGoal": {
    "distinctFamilies": 2,
    "diversityAxes": ["context", "reasoning_path"],
    "allowedUse": "practice | mastery_evidence | placement_anchor",
    "minQualification": "..."
  },
  "avoidAndExposure": {
    "familyIds": ["..."],
    "nextNeededBy": "...",
    "poolSnapshot": "..."
  },
  "control": {
    "policyVersion": "...",
    "expiresAt": "...",
    "maxAttempts": 3,
    "maxCostUsd": 1.0,
    "stopPredicateVersion": "..."
  }
}
~~~

两个重要修正：

- **intent** 只能表示 coverage reason；真正的诊断意图在 claim + evidence target。
- **difficulty [3,4]** 如果没有 scale、basis 和 confidence，只是两个无单位整数。

### ProductionAttempt

一次用某个 producer 满足 target 的尝试。它有 route、capability declaration、预算、lease、candidate slots、失败类型与重试策略。

Target 与 Attempt 分开后，才能正确表达：

- 两题只过一题；
- 生成成功但 verify enqueue 失败；
- 来源服务暂时不可用；
- 需要换 brief、换 route，而不是放宽正确性；
- 旧 target 因学习 scope 改变而过时。

## 库存单位：独立题族容量

对稀疏需求单元 c，库存不是 raw question count，而是：

> 未来 lead-time 窗口内，当前 eligible、未被近期曝光封锁、能独立承担目标 evidence role 的 item family 数。

建议至少识别这些关系：

- revision_of
- variant_of / template_family
- shares_stimulus
- near_duplicate
- enemy / 不可同卷
- supersedes

同一 family 的十个参数变体可以提供练习变化，但不能等价于十个独立 diagnostic anchor。

控制器可区分：

- **eligible on-hand**：当前可用的 active 独立题族；
- **reserve/ready**：已验证但暂不激活的题族；
- **pipeline commitment**：已有 single-flight attempt 承诺的 slot；
- **exposure-blocked**：因最近见过、同 family、同材料而暂不可用；
- **unqualified**：draft/quarantine，永不计入 target satisfaction。

pipeline commitment 可以阻止重复下单，但不能让 target 提前 satisfied。

## 稀疏 base-stock + CONWIP 控制

不应物化完整 KC × kind × difficulty × source 的笛卡尔积。n=1 下绝大多数组合不会产生真实需求。

每个真实出现的需求单元维护：

- L：近期服务的硬下界；
- S：正常补货目标；
- U：active + reserve + pipeline 的上界；
- A：可用独立题族；
- R：ready/reserve；
- P：在制承诺。

库存位置可写为：

\[
IP = A + R + P
\]

释放量是满足 S 与 U 的最小补货量，同时必须满足：

- target 没有 live attempt；
- 全局与 route WIP 有空位；
- 预算允许；
- route 能兑现 trust、allowed use、source、difficulty 与 task model；
- target 尚未过期。

初始策略保持简单：

- 一般覆盖按独立 family 维持 L=1、S=2、U=3；
- source-quality、format-diversity、contrast 等布尔角色通常只需 1；
- safety stock 由 FSRS / planned stream 在 producer lead time 内需要多少次独立曝光决定，不用 Poisson/正态需求预测。

## 事件加速 + 夜间全量对账

### 事件只做“标脏 + reconcile”

以下事件标记相关需求单元为 dirty：

- goal/frontier/due 变化；
- selection miss，并带具体 miss reason；
- item 激活、隔离、修订或退休；
- attempt/verify 终态；
- route 恢复；
- owner 解锁 blocked target。

请求路径不应直接 boss.send。否则事件丢失、重复请求和跨进程竞态会再次绕开控制面。

### 夜间任务负责自愈

- 全量重算 desired state 与库存投影；
- 找漏事件、孤儿 candidate、漏发 verify；
- 回收 lease；
- reopen 错误关闭的 target；
- supersede 过时 target；
- 按 hard shortage、needed_by、age 和 WIP 空位释放 attempt。

nightly 仍保留，但它从唯一生命线变成 reconciliation safety net。

### 不再用 cooldown 代替生命周期

不同时间语义必须拆开：

- 事件 debounce：秒/分钟；
- in-flight lease：job 正常时长；
- transient failure：指数 backoff；
- content failure：换 brief / route；
- owner 暂缓：可见 snooze；
- target expiry：scope/policy 失效；
- nightly：一致性对账。

## 三层题目供给

### 1. 稳定核心题

来源可以是 owner 导入、可信题源、专家/owner authoring。它们承担：

- placement；
- mastery evidence；
- 稳定 scoring anchor；
- 关键 recall / diagnostic；
- 来源断网和 LLM 降级时的服务韧性。

冷启动不能依赖空池现场生成。核心学科应有最小 seed/anchor pack；新材料或新学科至少先让 owner 选择/上传可信材料，再启动异步 supply。

### 2. 已验证 Item Model

这是稳定题与自由 LLM 之间最重要的中间层：

- 明确可变参数与边界；
- 解法、答案和评分逻辑可确定性生成；
- 题型/认知过程经过验证；
- 生成实例继承模型资格，但仍保留 revision 与参数 lineage。

数学、物理的计算/选择题尤其适合。该通道可以安全 JIT，并减少模型成本、格式故障和同题换皮。

### 3. 自由 LLM 候选

适合：

- 低风险 formative；
- 换情境、解释与开放探索；
- session-specific 新材料；
- 生成 item plan/candidate，供独立门禁与 owner 复核。

不适合：

- learner critical path 上同步生成正式测量题；
- 未经独立证据直接影响 placement 或稳定 mastery；
- 用自报 difficulty 充当 calibrated difficulty。

“Ephemeral”只表示不复用，不表示不记录。题面、答案、prompt/model/source、revision 和本次作答必须可追溯。

## Qualification 与 Allowed Use

题目 origin 不直接决定质量；同一来源也可能有不同资格。建议把资格拆成多轴：

- provenance / license；
- deterministic validity；
- independent content verification；
- scoring stability；
- family novelty；
- difficulty basis 与 confidence；
- post-use health；
- allowed use。

| Allowed use | 最低要求 | 对学习状态的影响 |
|---|---|---|
| exploratory | 结构/答案 sanity、基本安全、留 lineage | 默认不更新 mastery |
| formative practice | 可判分、来源/生成可追踪、全池去重、独立校验 | 低权重或只更新复习调度 |
| mastery evidence | 稳定 task/scoring model、可信内容验证、版本冻结 | 正常更新 mastery |
| placement anchor | 核心题或验证过的 item model、明确难度依据、owner/专家背书 | 可用于起点判断 |

对 n=1，“placement anchor”更诚实地表示 expert/author anchor，不声称群体 psychometric calibration。

## 生产前计划、生产后强制去重

### Plan-then-generate

每个 slot 先形成结构化 item plan：

- claim / evidence role；
- misconception 或 skill facet；
- kind / response mode；
- answer semantics / rubric；
- difficulty interval 与依据；
- source/material strategy；
- 与其它 slot 的差异轴；
- avoid families；
- allowed use。

generator 只负责把 plan 变成 candidate revision。批内差异化因此成为可检查约束，而不是一句 prompt。

### 去重是服务端 gate

query_questions 可以给 agent 增加视野，但不能是唯一保证。强制 gate 应覆盖 active、draft、reserve、retired 与 in-flight：

1. normalized exact hash；
2. 结构 / item-model signature；
3. shingles / MinHash；
4. embedding 候选召回；
5. 必要时 cross-encoder 或 owner 复核；
6. family assignment 与曝光策略。

语义相似不等于题目等价，因此 embedding 只做候选召回，不做唯一裁决。[Broder 1997](https://www.cs.princeton.edu/courses/archive/spring13/cos598C/broder97resemblance.pdf)、[Sentence-BERT](https://aclanthology.org/D19-1410/)

## 验证生命周期

### 三个状态机，不压成一个 status

~~~text
Target:
OPEN → IN_FLIGHT → SATISFIED
  ├→ BLOCKED
  └→ SUPERSEDED

Attempt:
REQUESTED → IN_PROGRESS → VERIFYING → SUCCEEDED
                         └──────────→ FAILED

Item revision:
DRAFT → READY / RESERVE → ACTIVE
   └→ QUARANTINED
ACTIVE → QUARANTINED / RETIRED
~~~

### 验证原则

- pass、fail、inconclusive 分开；
- 单个弱 comparator 不可永久 veto；
- choice/计算题先抽取 canonical answer，再做字母集合、代数/数值等价比较；
- free-response 的内容冲突不能因“partial”默认放行；
- verifier 与 generator 尽量避免同模型、同提示结构造成相关错误；
- 低置信 candidate 进入 quarantine/canary，而不是二元 active/draft；
- verify 通过只意味着 READY；是否激活还取决于库存上界和 allowed use；
- post-use 异常、owner 申诉、内容时效和 revision 变化都可触发可逆 demotion。

验证成本高于生成成本，route planner 应把可验证性视作一等 capability，而不是生成后的附属步骤。

## Selection 与学习模型如何接入

Delivery selector 的顺序应是：

1. **hard eligibility**：KC/frontier、allowed use、trust、题型、来源、版本健康、曝光/bury；
2. **learning utility**：due、mastery uncertainty、frontier、misconception、MFI 等；
3. **exposure/diversity**：family、材料、情境和作答模式的随机化与冷却。

Supply 与 selection 共享库存投影和 miss reasons，但不共享决策职责：

- selection miss 不等于立刻造题；
- 先检查题何时恢复 eligible、未来 due 和可用 fallback；
- 只有在 producer lead time 内仍无法服务，才产生 supply signal。

学习状态更新必须读取 item qualification：

- exploratory 不进入 theta；
- formative 可以低权重或只更新 FSRS；
- mastery evidence 正常更新；
- item health 与 learner state 不应由同一次异常作答同时激进修改，n=1 下两者不可辨识。

## 可靠性、幂等与成本

最低不变量：

1. 同一 fingerprint + policy version 最多一个未 supersede target。
2. 同一 target version 默认最多一个非终态 attempt。
3. target/attempt 与 dispatch outbox 在同一事务落库。
4. worker 以 target version + attempt number 做业务幂等。
5. candidate 以 attempt + ordinal 唯一。
6. verifier 以 item revision + verifier version 幂等。
7. 全链透传 target、attempt、revision、trace。
8. target 不能因 enqueue、candidate 或 draft 而 satisfied。
9. satisfy 按 distinct qualified family，不按 raw question。
10. 内容变化生成新 revision；旧 attempt 永远绑定旧 revision。
11. demotion/retirement 必须触发相关 target reconcile。
12. transient failure 重试同一 attempt；content failure 才创建实质改变的 attempt。
13. verify enqueue 失败只补发 verify，绝不重跑生成。
14. manual route 留可见 BLOCKED target。
15. 每个 target 有 attempts、WIP、token/USD 和 expiry 上限。

这里不需要分布式 exactly-once。数据库唯一约束、transactional outbox 和 idempotent consumer 足够。

## 冷启动与空池

冷启动有三种不同问题，不能统一成“现场生成”：

1. **已有核心课程、无 learner prior**：使用稳定 placement anchor pack，低置信时跨 KC 探索，逐步缩小起点。
2. **已有学习目标、核心题暂缺**：创建有界 starter-pack target，明确 pending/blocked；使用相邻可信题或 owner 路由，不伪装成已可测量。
3. **今天刚上传的新材料**：可以 session-specific 生成 formative 题，但应标记 material-bound、低风险、不可自动成为 placement/mastery anchor。

如果没有合格题，应诚实进入“无法可靠测量、供题中”的状态；上传页不能伪装成后台已经下单。

## 候选架构比较

以下 1–5 分是架构思维实验，不是生产测量。

| 场景 | 夜间 push | 取题 JIT | Target ledger + hybrid | 稳定 core + ephemeral |
|---|---:|---:|---:|---:|
| 冷启动 | 2 | 4 | 4 | 3 |
| 池见底 | 2 | 5 | 5 | 4 |
| 知识状态误判 | 2 | 2 | 4 | 3 |
| 重复模板 | 2 | 1 | 4 | 3 |
| 来源断网 | 3 | 1 | 4 | 5 |
| LLM 降级 | 3 | 1 | 4 | 5 |
| 验证误杀 | 2 | 1 | 4 | 4 |
| 成本峰值 | 5 | 1 | 4 | 4 |
| 题目修订 | 4 | 1 | 5 | 4 |
| n=1 稀疏数据 | 4 | 3 | 3 | 5 |

这里有一个分类修正：

- 前三列主要是**控制/触发策略**；
- 第四列是**库存与信任策略**。

所以推荐不是在 C 与 D 之间二选一，而是：

> **Target ledger + event/nightly hybrid 控制面，叠加 stable core + verified item model + low-risk free generation 的库存策略。**

反例：如果课程范围固定、已有深题库、每天用量很低且可容忍一天补货延迟，那么简单的 nightly reconcile + stable core 可能更可靠、更便宜。控制面复杂度必须由真实 route 数、失败恢复和 service latency 证明，而不是为了“智能”而存在。

loom 当前已经有 nightly、refill、placement、manual、sourcing、quiz_gen、verify 和多种失败状态，因此持久 target/attempt 的价值主要来自**统一因果链与恢复语义**，而不是吞吐规模。

## n=1 主动放弃的能力

当前不应承诺或建设：

- 用单个学习者估计稳定 2PL/3PL discrimination、guessing 或 DIF；
- 用群体 item exposure rate 优化池利用；
- 从少量重复作答断言 item parameter drift；
- 训练深度 KT 或自动发现可靠先修图；
- 路线 contextual bandit / RL；
- ARIMA、Poisson 或正态安全库存；
- 同时在线学习 learner theta 与自由生成题 difficulty；
- 自由 LLM 在 critical path 实时生成正式测量题；
- LLM 自评或同源 judge 代替效度证据；
- 全量笛卡尔 coverage lattice；
- “全部自动化、owner 永不介入”。

值得保留的是：

- curated frontier；
- 透明 mastery uncertainty；
- per-user family no-repeat；
- author/expert difficulty anchor + confidence；
- 不可变 revision 与 lineage；
- 全生命周期去重；
- route/model/prompt/version 级质量监控；
- owner 集中审核高影响 blueprint、验证分歧和抽样审计。

## 评估这套架构是否真的更好

以后不应以“派了多少 job”或“题库有多少行”衡量成功，而应看：

- qualified family coverage，按 allowed use 分层；
- unmet target age 与 time-to-qualified-supply；
- selection structural miss rate；
- route yield：candidate → qualified family；
- cost per qualified family；
- verify precision、recall 与 inconclusive rate；
- family-level duplicate / exposure concentration；
- blocked、partial、orphan 与 superseded target 数；
- active 后的内容申诉、异常率与可逆 demotion；
- owner review minutes per qualified family。

架构应被以下事实推翻或简化：

- stable core 已覆盖近期窗口，selection miss 接近零；
- owner 可接受一天补货延迟；
- route 和失败状态足够少，无需持久 attempt；
- free generation 对正式测量没有实际需求；
- item model 的维护成本高于其节省的验证和生成成本。

## 最终判断

当前 scanner 不是要丢掉的“旧设计”；它应从“每天发订单的大脑”降为 desired-state reconciler 的一个传感器。真正缺失的是：

- 可重新计算的证据目标；
- 持久 target/attempt/slot 因果链；
- 按独立题族和 allowed use 计量的库存；
- 对生产、验证、激活、曝光的分层状态；
- 事件加速与夜间自愈的双闭环；
- stable core、verified item model、free generation 三种生产等级。

这样供题系统才会从“模型能出题”变成“系统知道为什么缺、缺的是什么、由谁补、补到什么程度算完成、失败后如何恢复，以及这道题到底有资格用于什么”。
