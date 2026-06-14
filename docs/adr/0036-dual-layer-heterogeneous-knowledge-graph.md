# ADR-0036 — 知识关系结构落在双层异构图（否决三层平行图）

**Status**: Accepted (2026-06-14)
**Part of**: YUK-203（领域模型重构）· 关系结构主线（YUK-322 关系族 / YUK-344 一致性闸地基）。
**Decision source**: `docs/design/2026-06-14-product-rethink-decisions-ledger.md` §1「关系结构（Phase 1.5 RT1-4）」+ §1「B2 知识表示」（决策总账，最高权威）；展开论证 `docs/design/2026-06-14-product-rethink-phase1_5-relations.md` §1-§4（双层异构图核心裁决 + 三层分离 + 推荐本体 + 头号前置）；接口对账 `docs/design/2026-06-14-product-rethink-phase2-synthesis.md` §3.5/§3.6/§3.9 + §4.1 三轴正交红线。
**Related**: ADR-0010（knowledge mesh：tree backbone + typed cross-edges + experimental escape；本 ADR **扩展并收紧**其 relation_type 治理，把 5 核心 enum 钉为闭集、weight 钉死 confidence-only）· ADR-0006 v2（event 核：错因现活 event 层 `action='judge'` payload，本 ADR 据此把误区身份层与观测层显式分离）· ADR-0012（mastery 派生 view：本 ADR RT2 credit 是派生量不写回边，与「mastery 住 view 不住列」同源）· ADR-0028 / ADR-0030（知识级 FSRS + by-kind 选题：误区节点不持独立调度，remediated_by 复用 FSRS 管线）· ADR-0034（写入期结构一致性闸地基，YUK-344；本 ADR RT1 晋升环 / RT2 传递冗余拦截 / RT4 类型签名闸**全部 gated 在其之后**）。

---

## 背景

GPT 外部稿（`~/Documents/ai_learning_tool_research_design.docx`）为知识关系结构建议「三张平行图」——学科图 / 题型图 / 错因图各自独立成层。Phase 1.5 关系结构聚焦调研（8 路文献/产品双视角并行 → 4 路主题综合 → 1 路 cross-synth）四主题独立收敛到**否决这个三层平行图**：它把「设计期论证脚手架」（ECD 证据中心设计）与「runtime 数据结构」混为一谈，把本属观测层 / 字段层的东西强行升成身份层（`...phase1_5-relations.md` §1 三层分离表 + §2）。

仓库现状（grounded）：`knowledge.parent_id` 树骨架 + `knowledge_edge` 5 核心 typed-edge 网早已落地（ADR-0010；`src/db/schema.ts:688-717` 表，`src/core/schema/event/blocks.ts:87-100` `CoreRelationType` enum + `experimental:*` 逃逸阀）；错因现活 event 层 `action='judge'` payload `CauseSchema`（ADR-0006 v2），mastery 是派生 view（ADR-0012）。安心结论（决策总账 §综合主线）：**没有一个主题需要新引擎 / 新图数据库**——四主题的增量合起来只是「一张并行表 + 一列 + 一个脚本」级别，是「收敛 + 接通」不是推倒重建。本 ADR 把关系结构的目标形态钉死为**双层异构图**，并逐条裁决 RT1-4。

## 决定

1. **关系结构 = 双层异构图（否决 GPT 三层平行图），建在「一棵不可动的认知树骨架 + 一张已验证的同构 typed-edge 网」之上**。骨架 = `knowledge.parent_id`（认知结构、红线、只读，延续 ADR-0010「不动树」）；同构肌肉 = `knowledge_edge` 两端皆 `knowledge_id` 的 5 核心 relation_type 网；其上叠**渐进晋升的 misconception 异构层**（见决定②）。三张平行图退役为这一座双层异构图。

2. **三层分离是本体设计的核心裁决（身份 / 观测 / 派生）**，谁活在哪层是裁决，而非「什么有意义就升 KG 实体」（`...phase1_5-relations.md` §1）：
   - **身份层**（稳定可复用、有名字、跨证据可引用的策划资产）：`knowledge` 节点、`knowledge_edge`、（晋升后的）`misconception` 节点。
   - **观测层**（event 唯一真相，ADR-0006 v2）：attempt / judge cause / user_cause——**错因现活这里**，per-attempt cause 不自动升身份层。
   - **派生层**（从 event 算出、不写回）：`knowledge_mastery`（ADR-0012）/ credit 传播 / 传递闭包。
   这条分离同时是 Phase 2 §4.1「KG 轴」与三轴正交红线（`R` ⟂ `p(L)` ⟂ `mem0` ⟂ `KG`）的落地：KG 只回答「知识怎么组织」，mastery/credit 是派生量不入图。

3. **RT1 误区图谱「晋升而非复制」**：同 `effective_cause` 同知识点跨 attempt 复现 **≥k 次**时，写入期调和环 propose『晋升此错因为 misconception 节点』，**人审 accept 才建**；只出现一次的错因永远留 event 观测层。落地形态：
   - 独立 `misconception(id / title / reasoning / weight / created_by / archived_at)` 表——**不进 `knowledge` 表、不进树、不加 subject 列**（科目经其 `caused_by` 指向的 `knowledge` 节点 `effective_domain` 派生，延续「科目是视角不是结构」红线）。
   - 异构边 `misconception_edge`（多态 from_kind/to_kind）四语义：`caused_by → knowledge`（可先单一 caused_by + experimental 试水，independent/dependent 两型待 owner 拍）/ `confusable_with → misconception|knowledge`（对称边，**必须接组卷层出对比辨析题否则是死边**）/ `observed_in → event`（证据回链指针，**永远回指 event 不复制内容**）/ `remediated_by → 复习项|probe`（复用 FSRS 管线做复习偏置）。
   - 误区节点**不持独立掌握度、不持独立调度**（remediated_by 经 ADR-0028/0030 FSRS 管线偏置即可）。SISM 措辞收紧为「并列 / 可共存建模」（非统计独立）。
   - **gated 在一致性闸地基（ADR-0034）之后**：晋升环的「同一误区判据」「方向语义钉死」悬空依赖写入期结构一致性闸 + 调和环，闸未就位不得建第一个 misconception 节点。`misconception_edge` 多态破坏 `knowledge_edge` 同构性——`rubric-validator`（`src/capabilities/knowledge/server/rubric-validator.ts`）所有闸假设两端皆 knowledge，异构边需平行闸逻辑，此成本计入 RT1。

4. **RT2 层级 credit 传播 = 派生量，不物化回边**：从被 attempt 的高阶知识点沿 `prerequisite` **反向**遍历（to→from），**沿 `encompassing_weight` 连乘衰减**算出 implicit evidence 喂 mastery 派生层——**不写回 `knowledge` 行**（与 ADR-0012「mastery 住 view」同源）。
   - **credit 衰减只用 `encompassing_weight`，不乘 `weight`（修 review 发现的语义混用）**：`weight` 钉死 confidence-only（决定⑥），它只作边的 inclusion 阈值/置信门控（低置信边可整条不参与 credit），**绝不当 credit 衰减系数**——若用 `weight × encompassing_weight`，一条「真包含但标注置信偏低」的边会被错误削减 credit 量，把「我们对这条边多有把握」误当成「这条边传多少掌握」。两者语义正交：confidence 决定信不信这条边，encompassing_weight 决定信了之后 trickle 多少。
   - **不新建第六种 relation_type、不新建 encompasses 表**：只给 `knowledge_edge` 加一 nullable 列 `encompassing_weight real`（仅对 `prerequisite` 行有意义，NULL = 不可 trickle-down credit）。该加列触发 `audit:schema`「字段须有 write path」，需新 propose 子类型（属性更新而非新边）。
   - **credit 只进 `p(L)`，不碰 `R` / 调度**（三轴正交红线，Phase 2 §4.1）：FSRS when 数学绝不被 credit 污染。tree parent 链做向上 rollup（科目/簇掌握%），prereq 反向做向下 credit——两个算子、两组边、两个方向，不混。
   - 注入排在 `mastery_state`（B1 PFA logistic 重写）之后；落地前先人工抽样标 N 条 prereq 边看 component 重合率。

5. **RT3 题型不建图**：题型留 `question.kind` 字段 + `SubjectProfile.judgePolicy.routeByKind` 配置（同 ADR-0014/0030「按 kind 路由」同构思路）；题型→知识点关联 = `question.knowledge_ids[]`（`src/db/schema.ts` Q-matrix item→KC 策划标注，非统计推断）。GPT 的 TaskType 实体层被否决——文献无「把题型当诊断实体」的传统，ECD 是设计期脚手架不是 runtime 结构。

6. **RT4 关系类型治理 = 5 核心 enum 闭集 + `experimental:*` 受闸逃逸阀**（收紧 ADR-0010 的开放语气）：
   - `RelationTypeSchema = CoreRelationType ∪ ExperimentalRelationType`（`src/core/schema/event/blocks.ts:87-100`，union 不动）；不倒向 Obsidian/Roam 全开放（碎片化），不死锁纯闭集。
   - `weight` **全局钉死 confidence-only**（grep 证实无 strength 消费路径）；strength/salience 留 future 第二列，等真有下游消费再加。
   - promote = `experimental:*` 提升进 Core enum，**走 migration + ADR 摩擦**（刻意有摩擦）；四闸判定（频次 ≥N / pgvector 语义内聚单峰 / 类型签名可声明 / 可泛化跨数据集），promote 与 pass/fail 作 event 留痕。其中「类型签名可声明」闸悬空依赖一致性闸地基（ADR-0034）。
   - 新增 `audit:relations` 脚本（照 `audit:schema` / `audit:profile` 同形）。`rubric-validator` 比假设成熟——`related_to` dumping-ground 加严其实**已实现**，整改为「微调阈值」非「新建」。

## 后果

**正面**
- 关系结构的目标形态从「三张平行图」收敛为一座双层异构图，且全部 **Postgres 无图库可承载**——零新基建、零新引擎（决策总账 §综合主线）。增量合计仅「一张并行表（misconception）+ 一张异构边表 + 一列（encompassing_weight）+ 一个脚本（audit:relations）」。
- 三层分离把 GPT 三层图的混淆一次性钉死：错因留 event 观测层、credit/mastery 留派生层、只有跨 attempt 复现的策划资产才升身份层——既保住 ADR-0006 v2「event 是真相」又保住 ADR-0012「mastery 派生」。
- RT1 晋升而非复制 + 人审 gate + observed_in 永远回指 event，使误区身份层可追溯、可回滚，延续 evidence-first / propose-only 红线。
- RT2 复用既有 prereq 边反向遍历，不新建 encompasses 边，避免 `knowledge_edge` 语义膨胀；credit 只进 p(L) 守住三轴正交。
- RT4 闭集 + 逃逸阀 + 钉死 confidence-only + `audit:relations`，让 relation 治理从 ADR-0010 的开放语气收紧为可机器审计的契约层。

**代价 / 风险**
- **misconception_edge 多态破坏同构性**：`rubric-validator` 所有 per-relation 语义闸（prerequisite 序证据 / contrasts 混淆 / applied_in 角色 / derived_from 端点 / related_to dumping-ground / cross-subject / parent-duplicate / self-edge）都假设两端是 knowledge_id，异构边需另写一套平行闸逻辑——Phase 1.5 §6 明指此复用成本被 RT1 低估。
- **`encompassing_weight` 加列触发 `audit:schema`**：「字段须有 write path」要求新 propose 子类型（属性更新而非新边），比「加一列」重，须配 allowlist `resolves_when: pr` 或实现写路径。
- **所有数值阈值（晋升 k、频次 N≈15-20、encompassing_weight≈0.3-0.4）单用户无基线**，须埋点观测 N 周——观测窗口期内误区图 / credit 图 / promote **整体不可用是特性非 bug**（决策总账 §5；Phase 2 §5.3），owner 须接受空窗期。
- **开放题 observed_in 证据精度退化**：文献默认 MCQ distractor 级归因，本项目古文开放题靠 judge cause 归因更软（B1 有效性天花板）——开放题为主科目的误区图实际可用性存疑，需打样数据集实测。
- **环形依赖盲区**：caused_by 方向语义要靠一致性闸地基（ADR-0034）钉死，而闸本身代码侧零实现——这是 RT1/RT2/RT4 共同的硬前置，本 ADR 的身份层增量在闸就位前不得起跑。
- misconception 命名规范未定（自由文本 vs 受控词表），同义去重靠 pgvector 近邻缓解非根治；`misconception_edge` 单多态表 vs 四窄专表、reconciliation_log 知识侧/个性化侧共表与否，均为 owner 后续待拍（决策总账 §5）。

## 备选（已否决）

- **GPT 三层平行图（学科图 / 题型图 / 错因图各自独立）**——否决：把设计期 ECD 脚手架与 runtime 结构混层，四主题独立收敛反对（`...phase1_5-relations.md` §1/§3）。本 ADR 取双层异构图替代。
- **RT1 错因「复制」进 KG（每条 judge cause 即建 misconception 节点）**——否决：会在观测层之上造大量孤儿身份节点；改「晋升而非复制」+ ≥k 复现 + 人审 gate。
- **RT2 新建 `encompasses` 第六 relation_type / encompasses 边表，credit 物化回 `knowledge` 行**——否决：credit 是派生量（ADR-0012 同源），改复用 prereq 反向遍历 + 一 nullable 列。
- **RT3 把题型升为 KG 实体（GPT TaskType 层）**——否决：题型链落 `question.kind` + `SubjectProfile.judgePolicy` 配置（同 bi-temporal 形式写进决策文档）。
- **RT4 relation_type 全开放（Obsidian/Roam 式自由命名）或纯闭集无逃逸阀**——否决：前者碎片化、后者死锁；取 5 核心闭集 + `experimental:*` 受闸逃逸阀折中。
- **`weight` 重解释为 strength（accepted=strength 复用同列）或现在即拆 strength/salience 两列**——否决：grep 无 strength 消费路径，钉死 confidence-only，第二列留 future。
- **bi-temporal（为 `knowledge_edge` 补 valid_at/invalid_at 双轴）**——否决（决策总账 §1 B2 / §3，YUK-344 原第一条推翻）：结构是 timeless 不变量，「不再为真」≈ curation 纠错 epistemic 轴而非 valid-time，单用户不问历史结构态；YUK-344 重定向为一致性闸地基（ADR-0034）。
