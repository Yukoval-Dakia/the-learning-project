# ADR-0034 — 知识结构一致性闸取代 bi-temporal 双时间轴

**Status**: Accepted (2026-06-14)
**Part of**: [YUK-344](https://linear.app/yukoval-studios/issue/YUK-344)（一致性闸地基；父 YUK-322 记忆架构）
**Decision source**: `docs/design/2026-06-14-product-rethink-decisions-ledger.md` §1「B2 知识表示」第 52-53 行 + 「关系结构」第 62 行（一致性闸地基条）+ §3「已锁旧决策的修正」第 110 行（bi-temporal 推翻）；`docs/design/2026-06-14-product-rethink-phase2-synthesis.md` §3.6（YUK-344 重定向全节）；`docs/design/2026-06-14-product-rethink-phase1_5-relations.md` §4（写入期一致性闸「零实现」big bet #1）。被推翻的原提法在 `docs/design/2026-06-13-memory-architecture.md` §4.1 / §8.2 / §8.4（P4 知识侧补 `valid_at`/`invalid_at`）。
**Related**: ADR-0010（knowledge mesh：`knowledge_edge` 同构边 + `experimental:*` 逃逸阀，本 ADR 在其上加拓扑闸）/ ADR-0012（mastery 派生 view：结构不写回，本 ADR 强化「结构是 timeless 不变量」）/ ADR-0017（memory 双层：mem0 个性化侧调和环，本 ADR 复用其 P2 reconcile 骨架到知识侧）/ ADR-0019（`CorrectionKind` ∈ {supersede, retract, mark_wrong, restore}，本 ADR 用 epistemic 纠错复用它取代 valid-time）。**显式 supersede**：`docs/design/2026-06-13-memory-architecture.md` 的 P4 bi-temporal 决策（§4.1「知识侧补 `valid_at`/`invalid_at`」+ §8.4「P4 知识侧 bi-temporal」）与 YUK-344 原第一条（`knowledge_edge` 补双时间轴）。

---

## 背景

记忆架构混合方案（`2026-06-13-memory-architecture.md`）从 Graphiti 借了两件事到知识半边：写入期调和环（§8.2/§8.4 挂 `runProposeAndWrite`，复用 mem0 P2 reconcile 骨架）+ **bi-temporal 双时间轴**（§4.1 知识侧「事实性陈述」补 `valid_at`/`invalid_at`，「事实何时为真」与「记录何时写入」分离，落点 P4 = `knowledge_edge` 加双轴）。YUK-344 据此立项，第一条即「`knowledge_edge` 补 `valid_at`/`invalid_at`」。

「整个产品重新想」会话（2026-06-14）复核后判定 bi-temporal 是误植。三条理由（决策总账 §1 B2 第 53 行）：① **结构是 timeless 不变量**——`knowledge` 树骨架（`parent_id` 只读）与 `knowledge_edge` 表达的是认知结构（A prerequisite B 这件事不随时间「失效」，prereq 关系本身是无时间属性的事实）；② **「不再为真」≈ curation 纠错（epistemic 轴）而非 valid-time**——一条边被撤，是「我们当初标错了 / 重新认识了结构」（知识论纠正），不是「这条边曾在某时段为真、现已过期」（valid-time 语义）；③ **单用户不问历史结构态**——n=1 工具没有「2026 年 3 月时这棵知识树长什么样」的查询需求，bi-temporal 的 as-of 时间旅行查询零消费者。Phase 1.5 §4 进一步把「写入期结构一致性闸（环检测/方向矛盾/传递冗余）」标为 big bet #1：grep 复核确认其**代码侧零实现**（`src/capabilities/knowledge/` 与 `src/server/` 内 `cycle`/`direction`/`transitive` 零命中），而 RT1 误区晋升环 / RT2 传递冗余拦截 / RT4 四闸③类型签名**全部悬空依赖它**。

本 ADR 把 YUK-344 从「补双轴」重定向为「一致性闸地基」：删 bi-temporal，立结构一致性闸 + 写入期调和环作 Wave 3 全部关系增量的共同前置。

## 决定

1. **推翻 YUK-344 原第一条（`knowledge_edge` 补 `valid_at`/`invalid_at`）**，连同 `2026-06-13-memory-architecture.md` §4.1/§8.4 的知识侧 bi-temporal 决策一并 supersede。`knowledge_edge` **不加双时间轴**；保留既有 `archived_at` 单轴软归档（ADR-0010 schema）作结构的唯一时间维（写入时间侧软删，非 valid-time）。结构（树 + 边）按 timeless 不变量对待：UNIQUE(from, to, type) + confidence-only `weight`（RT4，ADR-0010）不变。

2. **立写入期结构一致性闸（拓扑层，补 `rubric-validator.ts` 语义闸之外）**，在**边**写入路径（`runEdgeProposeAndWrite`，`src/capabilities/knowledge/server/propose_edge.ts`——边批量提议/落库的真实入口；节点提议走 `propose.ts` 的 `runProposeAndWrite`，拓扑闸只关边故只挂边路径）执行三类检查：① **环检测**——`prerequisite` 边不得成环，hard-reject；② **方向矛盾**——A prereq B 且 B prereq A，hard-reject；③ **传递冗余**——A→B→C 已存在时，直接 A→C 拒绝或降权，warning。语义闸（`rubric-validator.ts`：prerequisite 序证据 / contrasts 混淆 / related_to dumping-ground 等，Phase 1.5 §4 复核确认已成熟）与拓扑闸叠加生效，二者正交。

3. **立写入期调和环（知识侧）**，复用 mem0 P2 reconcile 骨架（ADR-0017 个性化侧，`docs/design/2026-06-13-memory-architecture.md` §3.4 调和层）的 prompt 形制与 `memory_reconciliation_log` 表设计，作用于 `knowledge_edge`：AI 提议新边时检索既有相邻边喂决策 prompt，让「新提议与旧结构矛盾」在写入期被显式判定（取代/并存），而非堆积到读取端。共享 P2 骨架但**作用对象是 `knowledge_edge` 不是 mem0 collection**；其 `blockedBy YUK-342`（P2 reconcile，PR #405 待 merge）—— P2 merge 后方可起跑（复用其 `memory_reconciliation_log` 设计），在此之前是结构前置就位、调和环实现待 P2 落地。

4. **epistemic 纠错复用 `CorrectionKind`（ADR-0019），不引 valid-time**。结构「不再为真」走 correction event（`CorrectionKind` ∈ {supersede, retract, mark_wrong, restore}，已有 `getEffectiveTruth` event-层实现，`core/schema/event/known.ts`）表达知识论纠正，不再用 `valid_at`/`invalid_at` 表达时段有效性。
   - **移除机制与来由记录分工（important，修 review 发现的接线缺口）**：边的**实际移除**（从 live mesh 隐藏）= 写 `knowledge_edge.archived_at`（ADR-0010 软归档，live mesh reader 唯一过滤依据是 `archived_at IS NULL`）。`CorrectionKind` correction event 是 epistemic **来由的 provenance/审计记录，不是移除机制本身**——`CorrectEvent` schema 只能 target `subject_kind='event'`，盖不到 edge row，单写 correction event 不会让边从 mesh 消失。故撤一条边 = `archived_at` 软归档（load-bearing 移除）+ 配一条 `CorrectionKind` event 记知识论来由，二者各司其职；仍不引 `valid_at`/`invalid_at`。

5. **本闸是 RT1/RT2/RT4 的共同前置，代码侧零实现，priority High，独立先做（Wave 0）**。闸不就位，所有「升一等实体（RT1 misconception 节点）/ promote（RT4 experimental→Core）/ credit 物化（RT2）」全悬空（Phase 2 synthesis §5.0 定律 D-1）。本闸零 scope 依赖（不分单科/全科），与 weight 钉死 confidence-only（RT4）、QuizVerify 'error' 通道（B5）同属 Wave 0 立即起跑项。

6. **时序真值翻转归位三处既有载体**（bi-temporal 本想统一承接的「随时间变化的真值」拆回各轴，三轴正交红线，决策总账 §0）：① **时变 learner state**（掌握度/能力随作答演化）→ 从 event 流派生（`mastery_state` 派生层，ADR-0012；时间维天然在 event 的 `created_at`）；② **不可变 epistemic 纠正**（结构标错的更正）→ correction event append-only（ADR-0019 / ADR-0006 v2，不改写历史 event，纠正是新 event）；③ **会过时的会话事实**（偏好/习惯随对话漂移、矛盾）→ mem0 episodic 软取代（`superseded_by`/`invalid_at` 在 mem0 collection metadata，ADR-0017 + memory-architecture §3.3，**这是 valid-time 唯一合法落点——个性化软画像不是结构**）。

## 后果

**正面**

- **零新 schema 列**：删 bi-temporal 即省掉 `knowledge_edge` 两列 + 其 write-path（否则触发 `audit:schema`「字段须有 write path」+ 新 propose 子类型，Phase 1.5 §6 标过的额外成本）；一致性闸是逻辑层（拓扑检查 + 调和 prompt），不动 `src/db/schema.ts`。
- **解锁整个 Wave 3**：RT1 误区晋升环（传递冗余/方向语义靠拓扑闸钉死）、RT2 传递冗余拦截、RT4 四闸③类型签名三处悬空依赖一次性满足（D-1 承重墙就位）；本闸 `blockedBy YUK-342` 已满足，可与 B1 mastery 重写并行起跑。
- **正交红线收紧**：时序真值翻转归位三处后，valid-time 语义被限制在 mem0 个性化软画像（唯一会过时的轴），结构/event 两轴保持 timeless / append-only，杜绝「给结构边盖时间戳」这类把个性化语义渗进知识结构的污染。
- **调和骨架复用**：知识侧调和环与 mem0 P2 共享 prompt 形制 + log 表设计（ADR-0017），写入期矛盾判定一处定义两处用，不各起炉灶。

**代价 / 风险**

- **放弃历史结构态时间旅行**：删 bi-temporal 后无法 as-of 查询「某历史时刻知识树/边长什么样」。判定为 n=1 零消费者（决策总账 §1 B2），但若未来扩多用户且出现「审计某用户历史结构态」需求，需重新评估——届时是新 ADR 复活双轴，不是回退本决策。
- **异构闸成本被低估的延续**：拓扑闸现假设两端都是 `knowledge_id`（同构边）；RT1 的 `misconception_edge` 是异构边（from_kind/to_kind 多态，Phase 1.5 §2），需平行拓扑闸逻辑，复用成本在 RT1 落地时才显现（Phase 1.5 §6 已记此张力）。本 ADR 只立同构边拓扑闸，异构边闸归 RT1。
- **epistemic vs valid-time 的边界靠纪律守**：`CorrectionKind` 复用取代 valid-time 是语义约定，无 schema 强制——写入路径必须把「结构纠错」一律走 correction event、不私自给边加时间语义；靠 code review + 本 ADR 红线兜，无 `audit:schema` 级机器闸。
- **观测窗口期空窗**：本闸就位 ≠ Wave 3 可用，RT1/RT2/promote 仍 gated 在埋点 N 周（D-3）+ scope（D-4）之后；闸是结构前置不是数据前置（Phase 2 synthesis §5.3，特性非 bug）。

## 备选（已否决）

- **保留 bi-temporal（YUK-344 原案，memory-architecture §4.1/§8.4）**——否决：结构是 timeless 不变量，「不再为真」是 epistemic 纠错非 valid-time，单用户无历史结构态查询消费者；双轴是从 Graphiti（bi-temporal 服务多 agent 知识图谱的事实时效）误植到单用户认知结构的形态错配。
- **valid-time + epistemic 双轴都上（完整 Graphiti 形制）**——否决：连 valid-time 单轴都无消费者，再叠 transaction-time 双轴是纯负债；epistemic 纠错已有 `CorrectionKind`（ADR-0019）现成承接，不需第二套时间机制。
- **一致性闸延后到 RT1/RT2 各自实现时随手做**——否决：三处增量共享同一拓扑前提（环/方向/传递），分散实现会三次重造且语义漂移；立为独立 Wave 0 地基（big bet #1，Phase 1.5 §4）一次定义。
- **用 mem0 P2 调和环直接管知识边（不另立知识侧调和）**——否决：mem0 reconcile 作用于个性化 collection（软画像、会过时），知识边是结构（timeless、强 schema），二者动作空间不同（mem0 倾向 recency-supersede；结构倾向拓扑 hard-reject）；复用的是 prompt 骨架 + log 设计，不是同一个运行实例。
