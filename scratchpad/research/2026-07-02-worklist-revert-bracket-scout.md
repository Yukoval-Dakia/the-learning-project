# 决策材料：`orchestrateCascadeRevert` 接活 / 砍掉 / 局部改造

**Scout for**: YUK-538 打磨 program，master register `cascade-revert-reversibility-taxonomy`（line 524-533）+ `F8` 横切簇（line 1167-1172, 1189）。
**重接地基准**：`main@0291987e`（2026-07-02）。
**目的**：给 owner 一页可拍板材料，本文档不做选择，只给证据链 + 选项代价/风险。

---

## 0. TL;DR

`orchestrateCascadeRevert`（`src/server/revert/cascade-revert.ts:245`）零 live caller（唯一 importer 是自己的 DB test）。但比"没接线"更深——即使今天就有人接线调用它，其唯一能触达 θ̂/FSRS 状态回滚的 **A-class（`state_snapshot`）成功路径在当前生产拓扑下 100% 结构不可达**，且这不是可以"一行修好"的 bug：本次重接地额外发现，`review`/`attempt` 事件本身、以及经常伴生的 `judge` 事件，都被 `classifyRow` 的兜底规则分类为 `irreversible`——这**不是遗漏，是代码自己注释里写明的设计原则（诚实天花板 §100：真实学习者事实不可撤销）**。这意味着"修 A-class 可达性"不是修 bug，而是要在"是否允许对 review/attempt/judge 这类『真实学习者事实』开撤销口子"这个价值判断上做决定——这正是 owner 该拍板、我不该替拍的点。

---

## 1. 现状与结构不可达的确切证据链

### 1.1 零 live caller（结构性事实，非"暂未接线"）

```
grep -rn "orchestrateCascadeRevert" src server
```
仅命中 `cascade-revert.ts:245`（定义）与 `cascade-revert.db.test.ts`（15 处调用，全部在 `describe('orchestrateCascadeRevert', ...)` 测试体内）。`paper-submit.ts`、`submit.ts` 只在注释里提到"so cascade-revert restores both segments"（`submit.ts:675`、`paper-submit.ts:764`），从未 import。**零生产代码路径引用。**

### 1.2 拓扑不可达证明（四段证据链，独立可复核）

**证据 ①：`review`/`attempt` 事件的 5 个写点无一例外 `caused_by_event_id: null`**（比 master register 原文引用的 2 处更完整——本次穷举了全部写点）：

| 写点 | action | 行号 |
|---|---|---|
| `src/capabilities/practice/api/submit.ts` | `review` | `:572` |
| `src/capabilities/practice/server/paper-submit.ts` | `attempt` | `:566` |
| `src/capabilities/ingestion/server/enroll.ts` | `attempt` | `:194` |
| `src/capabilities/ingestion/api/mistakes.ts` | `attempt` | `:151` |
| `src/capabilities/practice/server/solve-session.ts` | `attempt` | `:409` |

`caused_by_event_id: null` 意味着 `review`/`attempt` **永远是因果图的根**，从不作为任何 checkpoint 的下游节点被 `collectCascadeFromCheckpoint` 的正向遍历（`WHERE e.caused_by_event_id = checkpointEventId`，`src/server/events/cascade.ts:125,137`）收进任何级联。

**证据 ②：`state_snapshot`（唯一 A-class 事件类型）的两个写点，`caused_by_event_id` 都指向"造它的那个 `review`/`attempt` 事件自己的 id"**——不是某个更上层的 checkpoint：

- `submit.ts:708` — `caused_by_event_id: eventId`（`eventId` 是同一函数里 `review` 事件自己的 id，`:539`）
- `paper-submit.ts:803` — `caused_by_event_id: attemptEventId`

结合证据①：`state_snapshot` 的父节点（`review`/`attempt`）本身永不可能是任何级联的下游节点——所以触达 `state_snapshot` 的**唯一**方式是把 `checkpointEventId` 直接传成那个 `review`/`attempt` 事件的 id 本身，让它当 ROOT。

**证据 ③：`classifyRow` 把 ROOT 和级联节点用同一套规则统一分类，而 `review`/`attempt`（以及经常伴生的 `judge`）落进兜底 `irreversible` 分支**：

- `cascade-revert.ts:199-235` `classifyRow`：只认 `state_snapshot`（`:202-204`）、`generate(knowledge_edge)`（`:216-226`）、`EVENT_LAYER_ACTIONS` 集合（`:228-230`，成员见 `:111-118`：`copilot_reply`/`teach_message`/`copilot_user_ask`/`copilot_chip_trigger`/`propose`/`rate`——**不含 `review`/`attempt`/`judge`**）；其余全部落 `:232-234` 的兜底 `irreversible`。
- `orchestrateCascadeRevert` 第 3 步把 ROOT 塞进同一个 `orderedRows`（`:295` `orderedRows.push(rootRow)`），第 4 步对**含 ROOT 在内的全体** `orderedRows` 统一跑 `classifyRow`（`:299` `orderedRows.map(classifyRow)`），只要有一个 `irreversible` 就整单拒绝（`:300-309`）。
- 结论：当 `checkpointEventId` = 某个 `review`/`attempt` 事件 id 时，ROOT 自己就在第 4 步被分类成 `irreversible`，在触达任何 A-class 恢复逻辑（第 5-6 步）之前就整单拒绝。**这条路径无论谁调用、传什么参数，永远走不通。**

**证据 ④（本次新增发现，register 原文未覆盖）：即便 ROOT 分类问题被修，`judge` 事件（经常是 `review` 的直接子节点）仍会独立触发同一个兜底拒绝。**
- `submit.ts:587-623`：当 `judgeResult !== null && judgeRoute !== null` 时（自动判分的常见路径）会写一条 `action: 'judge'` 子事件，`caused_by_event_id: eventId`（`:619`，`eventId` = 父 `review` 事件自己的 id）。
- `judge` 不在 `EVENT_LAYER_ACTIONS`、不是 `state_snapshot`、不是 `generate(knowledge_edge)` → 落同一兜底 `irreversible`（`:232-234`）。
- `cascade-revert.ts:54-58` 的顶部设计注释明确把 `judge` 和 `attempt`/`review` 并列为"真实学习者事实"（"attempt / review (FSRS register) / judge / accept_suggestion (user_verified) / tool_use... Per 诚实天花板 §100 these cannot be undone"）——**`judge` 落 irreversible 不是疏漏，是与 `review`/`attempt` 同一条设计原则的直接产物**。
- 结果：对任何自动判分过的 review/attempt（多数活跃路径），即使 ROOT 分类问题被单独修，`judge` 子节点仍会独立把第 4 步拒绝再触发一次——**两道独立的结构性拒绝**，不是一道。

### 1.3 测试自证：唯一通过的场景用的是生产从不产生的拓扑

`cascade-revert.db.test.ts:236-252`（"flagship" 用例，标题写"the flagship use case"）手工 `seedEvent` 把 `checkpoint` 设成 `experimental:copilot_user_ask`，再把 `state_snapshot` 的 `caused_by_event_id` **直接**指向这个 `checkpoint`（`:247`）。这条边在生产里不存在——生产 `state_snapshot` 的 `caused_by_event_id` 永远是 `review`/`attempt` 自己的 id（1.2 证据②），从来不是一个更上层的 `copilot_user_ask`。测试之所以能通过，是因为 `copilot_user_ask`**在** `EVENT_LAYER_ACTIONS` 里（`:114`），走的是"聊天轮次可撤销"分支，而不是"作答产生的状态快照"分支——这两条语义链在测试里被人为焊在了一起，生产里从未连通。

### 1.4 与 ADR-0044 原始设计意图的对照

`docs/adr/0044-event-sourcing-foundation-redesign.md:49`（§4）写的设计原文是"从 user_ask/chip checkpoint event 沿 caused_by 反向收下游"——即 ADR 的心智模型里 checkpoint 天然是**对话轮次锚点**（user_ask/chip_trigger），级联收的是聊天轮次触发的副作用。`§5`"caused_by 一致性补全"（`:54-59`）逐一审计了 copilot chat + 所有 durable job 的 `causedByEventId` 透传（`:56`），**但从未提及 `review`/`attempt`（submit.ts/paper-submit.ts）这条路径**。也就是说：ADR 从设计阶段起就没有把"作答→状态快照"纳入"这条链会被 checkpoint 反向收"的假设范围——`review`/`attempt` 恒为 `caused_by:null` 更像是从未被这次审计触及的**盲区**，而不是明确否决后的取舍。这与 §100 诚实天花板对 `attempt`/`review`/`judge` **事件记录本身**不可撤销的原则是两回事——诚实天花板管的是"不能假装这件事没发生过"，不直接等价于"这件事产生的衍生状态数字也永远不能被修正"（后者正是 `judge-fidelity-spof` 条目里"申诉推翻判决后 θ̂ 从不回滚"这个真实未满足需求的核心矛盾，见下）。

### 1.5 证据链小结

| 层 | 结论 |
|---|---|
| 调用面 | 零 live caller，唯一 importer 是自己的测试 |
| 拓扑面 | A-class 唯一入口（`state_snapshot`）的父节点（`review`/`attempt`）永远是根，永远不会被任何级联当下游节点收进去 |
| 分类面 | 把该父节点直接当 checkpoint 传入时，ROOT 自身在第 4 步被 `classifyRow` 兜底分类成 `irreversible`，整单拒绝，A-class 恢复逻辑永远跑不到 |
| 分类面（新增） | 即便修了 ROOT，常见的 `judge` 子节点独立触发同一兜底拒绝——不是一处 bug，是两处 |
| 测试面 | 唯一通过的"flagship"用例手工构造了生产不存在的拓扑（snapshot 直接挂在 `copilot_user_ask` 下）才能过 |
| 设计面 | `review`/`attempt`/`judge` 落 irreversible 是**代码自己写明的设计原则**（诚实天花板），不是遗漏——修复不是"补 bug"，是"要不要为这条原则开例外"的价值判断 |

---

## 2. 选项 A / B / C：代价与风险

### 选项 A — 接活：修 A-class 可达性 + 落一个真 live caller

**要做的事**（不是一行修复，是至少三层决策 + 改动）：
1. **决定 ROOT 语义**：是否允许"以 `review`/`attempt` 为根发起级联撤销"这个操作本身存在？如果允许，`orchestrateCascadeRevert` 第 6 步现有逻辑会对 ROOT **也**写一条 `correct`(retract) 补偿事件（`:341` 循环覆盖 `effects` 全体，含 ROOT；`:376-397` 写补偿事件不区分 ROOT/节点）——这直接与 `:54-58` 注释里"attempt/review 是真实学习者事实，不可撤销"的原则冲突。要么（a）明确决定"撤销级联"允许对 ROOT 本身也打 retract 标记（改写诚实天花板对 `review`/`attempt` 的适用范围），要么（b）重新设计 orchestrator，让 ROOT 参与分类/收集但**永不**对 ROOT 自身写补偿事件（"只撤销派生状态，不碰事件记录"）——这是两种不同的产品语义，只有 owner 能定。
2. **决定 `judge` 语义**：`judge` 子节点同样落"真实学习者事实"——是否允许"判决被申诉推翻后，撤销级联可以把这条 judge 事件也标记 retract"？还是同样需要"绕过 judge，只修正它产生的 θ̂ 副作用"这种更窄的操作？（这正是 `judge-fidelity-spof` 条目〔register:306-314〕点名的真实未满足需求——"appeal-overturn corrects the judge verdict... but never reprojects θ̂"。）
3. **代码改动量**：至少要给 `classifyRow` 加 ROOT-aware 分支（区分"作为 ROOT 出现"与"作为下游节点出现"两种上下文，当前函数完全无上下文感知，`:199` 签名只吃一行 `EventRow`）、给 `judge` 定义一个新的 `ReversibilityClass`（"补偿其副作用但不 retract 事件本身"，当前四态枚举 `state_snapshot | structural_imperative | event_layer | irreversible` 没有这一态）、重新设计第 6 步的补偿写入逻辑使其对不同类可选择性跳过 ROOT/judge 的 `correct` 写入。**不是局部 patch，是给 `ReversibilityClass` 加新维度 + 重写编排循环的语义。**
4. 落一个真实 live caller（UI 入口或 API route）——当前项目里没有任何"撤销这次作答"的产品面，需求本身也未经验证。

**代价**：中大（新分类语义 + 编排器改造 + 至少一个新增消费面，无现成 UI/route 可复用）。
**风险**：
- 如果选（a）（允许 ROOT/judge 也被 retract），是对诚实天花板核心原则开例外，影响面比 cascade-revert 本身大得多——任何读 `attempt`/`review`/`judge` 事件流的下游（FSRS 历史、mastery 溯源、复盘 UI）现在都要考虑"这条记录可能被标记 retract 但历史仍在"的新状态，属于跨子系统的语义变更，不是局部改动。
- 如果选（b）（新增"只撤销派生状态"分支），本质上是在造 Option C 那个更窄的原语，只是包在了现有大编排器里——复杂度更高但收益跟 Option C 相近，性价比更差。

### 选项 B — 砍掉：正式退休 A-class（`state_snapshot`）分支，`orchestrateCascadeRevert` 只保留 B-class/event_layer（聊天轮次撤销）

**要做的事**：
1. Doc-backfill ADR-0044 §4：把"A-class 目前结构不可达且现有拓扑下无法触达"写实，把"θ̂/FSRS 状态是 append-only，不支持撤销"明确记录为决定（呼应 register 原文 `:1172` "explicitly document θ̂/mastery as intentionally append-only per 诚实天花板 and retire the A-class bucket"）。
2. 代码层面：从 `ReversibilityClass` 移除 `state_snapshot`，`STATE_SNAPSHOT_ACTION` 相关分支、`assertSnapshotMatchesCurrent`、`restoreStateSnapshot` 调用整体删除或标记 dead-but-kept-for-reference。`state_snapshot` 事件本身仍继续写（它是审计/未来读模型的原始记录，不是只为 revert 存在——payload 里的 `theta_snapshots`/`fsrs_snapshots` 仍是唯一的"这次作答到底动了哪些状态"的可查证据），只是不再声称"这是可恢复的"。
3. `cascade-revert-reversibility-taxonomy` 条目（register `:524-533`）、`conjunctive-multi-kc-credit` 的"θ_global 无 revert bracket"顾虑（register `:565-567`）、`judge-fidelity-spof`（register `:306-314`）三个条目都需要同步改判词——它们目前的"P1 capture-gap"/"P2 待 bracket 落地"措辞都隐含"未来会有一个能用的 revert 机制来兜底"，一旦正式退休 A-class，这个兜底假设消失，三条各自的残余风险需要重新独立评估（例如 `conjunctive-multi-kc-credit` 的"unbracketed attempts 永久不可恢复"从"过渡期风险"变成"永久性质"，优先级判断可能要重新拍）。

**代价**：小（主要是文档 + 删代码 + 三条关联条目改判词，无新增复杂度）。
**风险**：
- 关掉了"未来某天低成本兜底"的选项——如果后续真的需要"判决被推翻后修正 θ̂"（`judge-fidelity-spof` 的真实场景），届时要从零设计，不能复用已经写了半年的 `restoreStateSnapshot`/`assertSnapshotMatchesCurrent` 原语。
- `state_snapshot` 事件如果因此被判定为"没有消费者"，可能被后续打磨轮进一步质疑"为什么每次作答都要多写一条快照事件"（当前它已经跳过 memory outbox，成本可控，但仍是每次作答的额外写入）。

### 选项 C — 改造为局部 revert：留一个窄原语，不动通用编排器

**核心思路**（本次重接地新增的具体设计方向，非 register 原文既有选项）：`restoreStateSnapshot`（`src/server/revert/restore-snapshot.ts:1-30`）本身就是一个**已经与级联收集完全解耦**的纯函数——"guard-agnostic... 这条原语不断言 `current == snapshot.after`；那个冲突守卫活在 cascade-revert orchestrator 里（后续 wave）"（原语自己的设计注释，`restore-snapshot.ts:16-20`）。这意味着"针对单个已知 `review`/`attempt` 事件 id，直接查它的 `${eventId}:snapshot` 快照行、跑冲突守卫、调用 `restoreStateSnapshot`、只对**快照事件自己**（不对 `review`/`attempt`/`judge`）写一条 `correct`"是一个远比整套 `collectCascadeFromCheckpoint`+`classifyRow`+四态编排更小的操作面——不需要触碰 `EVENT_LAYER_ACTIONS`、`generate(knowledge_edge)` 分支、ROOT 语义决定，也**不需要在诚实天花板原则上开任何例外**（因为 `review`/`attempt`/`judge` 事件记录全程不被触碰，只修正它们产生的派生状态数字）。

具体要做的事：
1. 新增一个窄 API（如 `revertAttemptStateOnly(db, attemptEventId)`）：按确定性 id `${attemptEventId}:snapshot` 直查该行（无需递归 CTE）→ 复用现有的 `assertSnapshotMatchesCurrent`（`cascade-revert.ts:565-603`，目前是模块私有函数，需要导出或抽到共享文件）+ `restoreStateSnapshot` → 写一条 `correct` 只挂在快照事件自己身上（`subject_id` = 快照事件 id，不是 `review`/`attempt`/`judge` 的 id）。
2. `orchestrateCascadeRevert`（聊天轮次撤销）保持现状不动——它目前唯一被测试证明能跑通的场景（`copilot_user_ask` 为根）不涉及 `state_snapshot`，改造 C 不影响它。
3. 明确记录：这个新原语**不是**"级联撤销"的特例，而是一个语义完全不同的操作——"修正一次作答产生的派生数字，不改写这次作答发生过的事实"——两者不该共用同一套 `ReversibilityClass`/`classifyRow` 框架，这也是为什么它值得独立于 Option A 存在。

**代价**：小-中（复用两个已存在的原语 `restoreStateSnapshot` + `assertSnapshotMatchesCurrent`，新增代码主要是一个薄查找+编排函数，不用碰 `classifyRow`/`EVENT_LAYER_ACTIONS`/递归 CTE）。
**风险**：
- 仍然是"造了但没有需求方"——当前项目里没有产品面提出"我要撤销这次作答的 θ̂"的真实用户故事；`judge-fidelity-spof` 条目虽然点出了这个缺口，但其本身判词是 P2、"是一个 narrow precondition + bounded effect"（register `:312`），不是紧急项。造这个原语前最好先确认 `judge-fidelity-spof` 的目标方案（"θ̂ replay/reprojection"）真的要用它，否则又是一次"建了没人接"的重复（呼应 F7 的 dark-shipped 教训）。
- 如果 `judge-fidelity-spof` 的目标方案不是"整单还原到某次快照"而是"精确重放被推翻判决那一步的 θ̂ 增量"（register `:311` 提到"a minimal single-step θ̂ replay"），Option C 这个"整段快照还原"原语可能语义上偏粗（它会把 `attemptEventId` 之后到现在**这一整段**期间该 KC 的 θ̂ 全部回滚到该次作答前，而不是只撤销这一次的 delta）——需要先跟 `judge-fidelity-spof` 的实际方案对齐粒度，否则造出来也用不上。

---

## 3. 与 F8「decide-and-record」横切簇的关系

Register `F8`（`:1167-1172`）把 4 条本轮各自看似局部的 P1/P2 条目点名为同一横切簇——本文档的选项 A/B/C 拍板结果直接 gate 这 4 条：

| 下游条目 | anchor | 当前判词 | 被本决策 gate 的方式 |
|---|---|---|---|
| `conjunctive-multi-kc-credit` | `theta.ts:93-149` | **P1**（capture-gap：θ_global attempt 写入今天就在发生，无 revert bracket，是单向门） | 若选 **B**（正式退休 A-class）：这条的"未来会有 bracket 兜底"假设消失，"unbracketed" 从过渡期风险变永久性质，需要重新独立评估优先级（可能仍是 P1，但理由要改写）。若选 **A/C**：capture-gap 的"缺 bracket"论述本身不变，但至少有了一个理论上能接的兜底机制。 |
| `elo-k-schedule` | `theta.ts:6-74` | P2（"revert/precision hardening... gated on cascade-revert 拿到 live caller"） | 选 **A/C** 且落地后，这条的 gate 条件解除，可以重新排期；选 **B**，这条的"等 revert 落地"措辞要改成"该维度精度硬化不再等 revert，若要做走独立方案"。 |
| `cascade-revert-reversibility-taxonomy` | `cascade-revert.ts:1-77,199-235` | P2（本文档条目自身） | 本文档 = 这条的执行细化，A/B/C 三选一即是这条"If RESHAPE"段落的最终落点。 |
| `judge-fidelity-spof` | `question-contract.ts:237-266` 等 | P2（appeal-overturn 后 θ̂ 从不 reproject，"deferred by name to 投影引擎契约"） | 这是**唯一一个已经点名"需要类似撤销能力"的真实产品需求**——选 **C** 的话，这条会是它的第一个真实消费者（解决 Option C 的"造了没人接"风险，见上）；选 **B**，这条的 P2 方案（"θ_stale 标记或最小单步 θ̂ replay"）必须在完全不依赖 `restoreStateSnapshot`/A-class 机制的前提下独立设计。 |

**F8 建议的行动顺序（register `:1172`, `:1189`）**："single decide-and-record before any of the 4 local items in isolation"——即先在 A/B/C 之间拍板，再动前 3 条局部条目（`judge-fidelity-spof` 是唯一可能反向影响拍板本身的条目，因为它是目前唯一具体、有名字的真实需求来源，值得在拍板前先确认它的目标方案粒度，见 §2 Option C 风险段）。

---

## 4. 给 owner 的决策清单（不是建议，是需要拍的问题）

1. **诚实天花板的适用边界**：`review`/`attempt`/`judge` 事件记录本身"不可撤销"这条原则，是否也隐含"它们产生的衍生状态数字（θ̂/FSRS）永远不可修正"？还是这两者是可以分开的（事实不可改，但发现计算错误时允许修正衍生数字）？—— 这是 Option A vs C 的分水岭，也是唯一一个真正的价值判断，其余都是工程代价问题。
2. **`judge-fidelity-spof` 的目标方案粒度**：如果未来要做"申诉推翻判决后修正 θ̂"，是"整单快照回滚"（Option C 现成可用）还是"精确单步 replay 那次判决的 θ̂ 增量"（需要新造，Option C 的原语用不上）？
3. **A-class 的退休是否需要先跟 `conjunctive-multi-kc-credit` 的 P1 capture-gap 条目一起拍**（同一份"要不要有 revert 兜底"的判断，两条目前独立排期）？

---

## 附：本次重接地新增/修正的证据（相对 register 原文）

- 穷举了全部 5 处 `review`/`attempt` 写点（register 原文只引用 2 处），结论一致但证据更完整。
- 新发现 `judge` 子节点独立触发同一兜底拒绝（register/F8 原文未提及这一层），且确认这是与 `review`/`attempt` 同一条设计注释下的**同一原则**产物，不是独立 bug。
- 新发现 `restoreStateSnapshot` 原语本身"guard-agnostic"、与级联收集完全解耦（`restore-snapshot.ts:16-20`），据此提出 Option C 这个 register 原文未列出的具体路径。
- 交叉核对 ADR-0044 §4/§5（`docs/adr/0044-event-sourcing-foundation-redesign.md:47-59`），确认 `review`/`attempt` 路径从未被 §5 的 `caused_by` 一致性审计覆盖——是设计盲区，不是明确否决。
- 外部基线沿用 register 原文引用的 Saga/CRDT/bi-temporal 三家收敛（`register:527`）；本次额外核验 Saga 原始文献可信度：Garcia-Molina & Salem, *Sagas*, ACM SIGMOD Record Vol.16 No.3, 1987, pp.249-259（ACM Digital Library 收录，非 preprint，同行评审会议论文；引用量 ACM DL 报 790 / Semantic Scholar 报 608，两个独立索引皆确认为该领域奠基性高被引文献）——用于支撑 Option C"compensating-transaction/局部撤销"路径的外部合理性，未发现与 register 原判断冲突之处。
