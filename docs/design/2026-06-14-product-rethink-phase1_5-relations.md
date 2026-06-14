# 整个产品重新想 · Phase 1.5｜关系结构聚焦调研

> **这是什么**：补 Phase 1 在 graph 关系结构上的盲点。4 主题 × 文献/产品双视角 = 8 路并行 opus 调研 → 4 路主题综合 → 1 路 cross-synth（关系结构总论 + 推荐本体 + 整合路径）。
>
> **生成**：2026-06-14，workflow `product-rethink-phase1_5-relations`（全 opus，13 agent，~1.1M tokens）。
>
> **与前序的关系**：回应 owner「Phase 1 有没有就 graph 关系结构提意见」（Phase 1 这块着墨弱）+ GPT 外部稿的「三层图」建议。结论**否决了 GPT 三层图**，并印证了讨论中我的两个判断（credit 复用 tree/prereq 不新建 encompasses 边；GPT 三层图把设计脚手架和 runtime 结构混了）。

---

## §1 核心裁决：双层异构图（不是 GPT 的三层平行图）

我们的 graph 关系结构应该是一座**双层异构图**，建在「一棵不可动的认知树骨架 + 一张已验证的同构 typed-edge 网」之上——**不是 GPT 外部稿想象的「三张平行图（学科/题型/错因）」**。

- 骨架 = `knowledge.parent_id`（认知结构、红线、只读）
- 肌肉 = `knowledge_edge` 5 核心 relation_type（两端都是 knowledge_id 的同构边）

四主题独立收敛到「增量极小、不要倒向建图叙事」——RT2/RT3 明确反对新建图，RT1/RT4 的增量也只是「一张并行表 + 一列 + 一个脚本」级别。

### 三层分离（本体设计的核心裁决）

**关系结构必须区分「身份 / 观测 / 派生」三层，谁活在哪层是核心裁决，而不是「什么有意义就升 KG 实体」：**

| 层 | 是什么 | 谁在这层 |
|---|---|---|
| **身份层** | 稳定可复用、有名字、跨证据可引用的策划资产 | knowledge 节点、knowledge_edge、（未来）misconception 节点 |
| **观测层** | event 表唯一真相 | attempt、judge cause、user_cause——**错因现活这里** |
| **派生层** | 从 event 算出来、不写回 | knowledge_mastery view、credit 传播、传递闭包 |

**GPT「三层图」被三个主题独立否决**，正因为它把「设计期论证脚手架」（ECD）和「runtime 数据结构」混为一谈——把本属观测/字段层的东西强行升成身份层。

---

## §2 推荐关系本体

**三类实体 + 两层边 + 一个治理元层，全部 Postgres 无图库可承载。**

### 实体类型
1. **knowledge 节点**（现状不动）= 认知结构单元。Q-matrix 的 KC 轴、树骨架节点、所有边的核心端点。
2. **misconception 节点**（RT1 新增，渐进晋升）= 跨 attempt/跨知识点可追踪、有名字、可复用的「错法身份资产」。独立表 `misconception(id/title/reasoning/weight/created_by/archived_at)`。**不进 knowledge 表、不进树、不加 subject 列**（科目经其 caused_by 指向的 knowledge 节点 effective_domain 派生）。严格区别于 event 层 per-attempt cause。**仅 owner 拍板 + 写入期调和环就位后才建第一个节点。**
3. **题型 / TaskType —— 明确不建为实体**（RT3）。留作 `question.kind` / `judge_kind_override` 字段 + `SubjectProfile.judgePolicy` 配置。题型→知识点关联 = `question.knowledge_ids[]`（Q-matrix item→KC，策划标注非统计推断）。

### 边类型
**A. knowledge_edge（同构边，现状 5 核心不动语义）**：两端都是 knowledge_id。
- `prerequisite`（前置→高级，兼做 frontier gating 正向 + credit 抵扣反向遍历）
- `related_to`（兜底，已有 dumping-ground 闸加严）/ `contrasts_with` / `applied_in` / `derived_from` / `experimental:*` 逃逸阀
- 每条带 `weight`(0-1 **钉死 confidence-only**)/created_by/reasoning/archived_at + UNIQUE(from,to,type)
- **RT2 增量**：加一 nullable 列 `encompassing_weight real`（仅对 prerequisite 行有意义，NULL=不可 trickle-down credit）。**不新建第六种 relation_type、不新建 encompasses 表。**

**B. misconception_edge（异构边，RT1 新增，先 experimental 试水）**：引入 from_kind/to_kind 多态。四类语义：
- `caused_by` → knowledge（分 independent/dependent 两型，可先单一 caused_by + experimental 试水）
- `confusable_with` → misconception/knowledge（对称边，**必须接组卷层出对比辨析题否则是死边**）
- `observed_in` → event（证据回链指针，**永远回指 event 不复制内容**）
- `remediated_by` → 复习项/probe（复用 FSRS 管线做复习偏置，误区节点**不持独立掌握度/独立调度**）

### 治理元层（RT4）
- RelationTypeSchema = CoreRelationType ∪ ExperimentalRelationType（已实现 union 不动）
- promote = experimental:* 提升进 Core enum（走 migration + ADR，**刻意有摩擦**）
- 四闸判定（频次≥N / pgvector 语义内聚单峰 / 类型签名可声明 / 可泛化跨数据集）+ promote 与 pass/fail 作为 event 留痕
- **weight 全局钉死 confidence-only**；strength/salience 留 future 第二列，等真有下游消费再加

> **一句话本体**：树管层级（认知骨架），同构网管知识点横向语义（5 核心），异构网管误区身份（晋升后），题型/错因观测留 event+字段，credit/mastery 是派生量不入图，治理靠 enum 闭集 + 受闸逃逸阀 + event 留痕。

---

## §3 四主题结论

**RT1 错因图谱（high）**：**升,但「晋升而非复制」**。误区从 event 层归因里「晋升」成二级策划资产——同 effective_cause 同知识点跨 attempt 复现 ≥k 次时,调和环 propose『晋升此错因为 misconception 节点』,人审 accept 才建;只出现一次的永远留 event 层。独立 misconception 表 + misconception_edge 异构边,不进树/不加 subject 列。**决胜判据**：要跨 attempt 追踪同一误区/易混辨析/按误区组补救卷 → 升;只要「这道错题大概是概念问题」→ event 层够用。

**RT2 层级 credit 传播（medium）**：**派生量,不物化回边;复用 prerequisite 反向遍历,不新建 encompasses 边**（印证讨论中我的反对）。从被 attempt 的高阶知识点沿 prerequisite **反向**遍历（to→from），weight×encompassing_weight 连乘衰减，递归 CTE 算出 implicit evidence 喂 mastery 派生层,**不写回 knowledge 行**。tree parent 链做向上 rollup（科目/簇掌握%），prereq 反向做向下 credit——两个算子两组边两个方向,不混。只给 knowledge_edge 加一 nullable `encompassing_weight` 列（默认 NULL,只对确认的 component 子集开）。

**RT3 题型↔证据↔验证器图（high）**：**不建图**。题型留 `question.kind` 字段 + `SubjectProfile.judgePolicy.routeByKind` 配置。GPT 的 TaskType 层被否决——文献无「把题型当诊断实体」的传统,ECD 是设计期脚手架不是 runtime 结构。题型→知识点 = `question.knowledge_ids`(已有)。

**RT4 关系类型治理（high）**：**5 核心 enum 闭集 + experimental:* 受闸逃逸阀**(两路独立调研 DIAL-KG / Wikidata 同构背书现状范式)。不倒向 Obsidian/Roam 全开放(碎片化),不死锁纯闭集。weight 钉死 confidence-only。promote 走可执行四闸 + 新增 `audit:relations` 脚本(照 audit-schema/profile 同形) + migration/ADR 摩擦。

---

## §4 头号前置：写入期结构一致性闸「零实现」（big bet #1）

**最关键的现实校准**：owner 2026-06-14 拍板要做的「写入期调和环 + 结构一致性闸(环检测/方向矛盾/传递冗余)」在代码侧确认为**纯设计、零实现**（`src/server/memory/reconcile-llm` 是 mem0 个性化侧,不碰 knowledge_edge;knowledge capability 内无 cycle/direction/transitive 命中）。

而 **RT1 的误区晋升环、RT4 的四闸③类型签名、RT2 的传递冗余拦截全部悬空依赖它**。

→ **big bet #1：先建这个地基,再谈任何升一等实体 / promote / credit 物化。** 在它就位前,所有增量应停留在「埋点观测 + 入口把关 + 派生计算」三件已有能力内,不要先造孤儿节点和悬空闸。

> **意外发现**：入口把关（`rubric-validator.ts`）比调研假设的成熟得多——已实现 per-relation 语义闸（prerequisite 序证据/contrasts 混淆/applied_in 角色/derived_from 端点/related_to dumping-ground/cross-subject/parent-duplicate/self-edge）。RT4 说的「related_to 加严」其实**已经做了**,应整改为「微调阈值」而非「新建」。

---

## §5 需 owner 拍板（最高优先汇总）

1. **【最高优先·地基】** 先把「写入期结构一致性闸」作为独立前置 phase 建造,再开 RT1/RT2/RT4 任何增量?（建议:是,单独 Linear issue 先落地）
2. **【RT4·两路真分歧】weight 语义**：(a) 钉死 confidence-only + strength 留 future 另开列（推荐,grep 证实无 strength 消费路径）/ (b) accepted 重解释为 strength 复用同列 / (c) 现在拆两列。
3. **【RT1】错因升不升一等实体**：建议升,但渐进晋升 + gated 在一致性闸之后 + 接受观测窗口期内无误区图。
4. **【RT1】misconception_edge 形态**：一张多态边表（灵活但需平行闸逻辑）vs 四张窄专表（严但碎）。
5. **【RT2】credit 载体**：prereq 反向 + encompassing_weight（推荐）vs tree-down side-car vs 直接复用 prereq weight。落地前先人工抽样标 N 条 prereq 边看 component 重合率。
6. **【RT2·依赖】credit 注入排在 knowledge_mastery view 重写之后,而 view 重写卡在 B1（PFA双层）vs B3（FSRS R 唯一）硬矛盾未二选一**——owner 须先拍「统一掌握信号」,RT2 才能闭环。
7. **【RT3】** 接受「题型链落 profile 配置而非 KG 图」写进决策文档（同 bi-temporal 形式）?
8. **【scope 耦合】** 一致性闸地基 + weight 钉死 + verify 'error' 通道单科阶段先做（零 scope 依赖）;misconception/credit/routeByKind 等全科或观测数据攒够再开。
9. **【独立先做·无依赖】** QuizVerifyCheckVerdict 扩 'error' 通道（区分 transport/parse 失败 vs 真实 verdict）——零结构改动、独立于建不建图,建议无条件先做。

---

## §6 与现状的张力 + coverage gaps（诚实）

- 写入期一致性闸**零实现**是四份建议共同的乐观假设与现实的最大张力（环形依赖盲区:caused_by 方向语义要靠一致性闸钉死,而闸还没建）。
- misconception_edge 多态会破坏 knowledge_edge 同构性——rubric-validator 所有闸假设两端是 knowledge,异构边需平行闸逻辑,复用成本被 RT1 低估。
- `encompassing_weight` 加列触发 audit:schema「字段须有 write path」,需新 propose 子类型（属性更新而非新边）,比「加一列」重。
- 所有数值阈值（晋升 k、频次 N=15~20、encompassing_weight=0.3-0.4）单用户无基线,须埋点 N 周——观测窗口期内误区图/credit 图/promote 不可用（特性非 bug,但 owner 须接受空窗期）。
- 开放题（古文鉴赏/论述）的 observed_in 证据精度退化（文献默认 MCQ distractor 级,我们靠 judge cause 归因更软）——开放题为主科目误区图实际可用性存疑,需打样数据集实测。
- misconception 命名规范未定（自由文本 vs 受控词表,同义去重靠 pgvector 近邻缓解非根治）。
- credit 与 B1/B3 硬矛盾的交互未覆盖（credit 注入 p(L) 诊断层还是 FSRS R 调度层,取决于未拍板的二选一）。
