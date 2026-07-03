# learnable-frontier-gate — 设计 spec（打磨 worklist #4，reconciled 终稿）

> **Program**: YUK-538（全项目逻辑打磨），单元 `learnable-frontier-gate`（master register `docs/design/2026-07-02-project-logic-master-register.md` line 366-381）。
> **Provenance**: research dossier `scratchpad/research/2026-07-02-worklist-frontier-gate-research.md`（三腿 code/lit/OSS + P1 回填）+ 快赢批 `docs/design/2026-07-02-quickwin-batch-pfa-tagging-ocrvlm.md` §A（已 ship，YUK-539/PR#691——evidence-floor=4 + AND-gate + γ/ρ retune，本单元不重做）。**本终稿并入两轴对抗（Lens A 算法/阈值治理 + Lens B 运行态/UI 传播）的裁决——见文末「Attack 裁决 ledger」。**
> **接地**: main `edc7cf62`（`git rev-parse` 实测），所有 file:line 现场重新核验（含两轴 attack 引用的每一条）。
> **红线**：n=1 不拟合 item 参数；阈值数值变更 = owner 决策（本 spec 只呈选项+依据，不代拍数字）；数据门只 gate 翻转不 gate build；evidence-first；科目是视角不是结构。UI 代码实施前须先过 CLAUDE.md「UI Design Compliance」pre-flight（逐字引 design doc + 声明组件类型 + touch 文件清单，等 owner approve）。

---

## 现状与问题（接地 `edc7cf62`）

### 1. 已被 PR#691（YUK-539）覆盖，本单元不重做

`src/capabilities/practice/server/learnable-frontier.ts`：
- `MASTERED_PL_THRESHOLD = 0.7`（:65）+ `FRONTIER_MASTERY_MIN_EVIDENCE = 4`（:87）+ `isMasteredForFrontier(mastery, evidenceCount)`（:91-93，AND 谓词），在 `learnableFrontierResolved` 的 self（:260）与每个 prereq（:261）**统一**应用。
- `src/core/pfa.ts`：`PFA_GAMMA=0.5`/`PFA_RHO=-0.25`（Candidate B），docblock 已是诚实条件式声明。
- `src/capabilities/knowledge/server/frontier-read.ts:103-112`：`isMastered()` 已同步吃 evidence floor。

**本单元残留 = register target shape 中 PR#691 未覆盖的份：overflow 可观测性、阈值联合记录、0.67/0.7 跨面裁决——外加两轴 attack 揭出的两处 MAJOR 完整性洞（见 §2、§4）。**

### 2. P1 残留 — overflow/sparse 静默坍缩，且**有三个消费点，不止一个**（Lens B MAJOR-3 修正原判定）

`learnableFrontierResolved`（`learnable-frontier.ts:156-266`）把三态（`sparse`/`dense`/`overflow`）判别出来，`overflow` 在 :224 `return { kind: 'overflow', ids: [] }`。但**三个下游消费点各自把 overflow 无差别坍缩成空、零日志**：

| 消费点 | 站点 | 坍缩方式 | 驱动的用户可见面 |
|---|---|---|---|
| composer（练习流） | `stream-store.ts:205` `learnableFrontier(db)`（薄壳，仅取 `.ids`） | overflow→[]，与 sparse 无区分 | `/practice` 流 |
| **FrontierRail（知识页）** | `frontier-read.ts:217-218` `const denseIds = resolved.kind === 'dense' ? resolved.ids : []` | **`kind!=='dense' ? []`——sparse AND overflow 同折空，零日志** | **知识页 FrontierRail 面** |
| nightly job（已正确） | `frontier_fill_nightly.ts` 用 `learnableFrontierResolved` 按 `.kind` 分支，overflow→`skipped_overflow`，全量落 `console.log`（:425） | 正确区分 | — |

**草稿原判定只 scope 了 `stream-store.ts:205`、并断言「nightly 是唯一另一消费者」——这是错的**：`frontier-read.ts:217` 是第三个 live 消费点，驱动**知识页** FrontierRail，overflow 时静默展示「无 dense 下一步」（退化到 propose-half/空），零日志。**修法据此改为「在 `learnableFrontierResolved` 的 overflow 返回点单点 emit」**（§M1），三消费点从一个源继承可观测性，而非往每个 caller 手抄一遍。

> 注：`stream-store.ts:205` 由 `collectComposerInputs` 承载，后者不仅在 daily compose 被调，还被 `reRankAfterAnswer`（:897 → :959）在**每次作答→done 时**调用（Lens A ④/② 修正：读频是 per-answer，非 once-daily），以及 `recomposeStream`（:770）。单点 emit 让这些路径全部继承，无需逐一改。

### 3. P2 残留 — 跨面阈值不一致 + 联合记录缺失（Lens A ①a/①b 修正框定）

- `src/capabilities/knowledge/ui/mastery-tone.ts:17-22`：`masteryTone()` 用 **0.67/0.45**。**关键修正（Lens A ①a）**：`mastery-tone.ts:11-14` 明载——这对 `0.67/0.45` 是 **S5/YUK-335 跨三个展示面统一点**（ring disc `masteryTone` + decay pill `NodeDrawer.decayCue`（实测 :33-34 = `0.67`/`0.45`）+ legend），专门修一个「~43% 节点在环上读 good/黄、在衰减 pill 上读 again/红」的分裂（audit §3.8）。**它不是一个孤立的展示常量。** 因此「把 0.67 拉到 0.7」若只改 `masteryTone` 一处，会**重新打开 YUK-335 已合的 ring-vs-pill 分裂**——是三面回改，不是一行改。
- `learnable-frontier.ts:65` `MASTERED_PL_THRESHOLD=0.7` + `:87` evidence-floor=4，是 gate 层复合二维判据，服务「是否离开 frontier 池/满足下游 prereq」，与展示层不同消费者。
- **`p(L)`=σ(PFA logit) 是 recall-probability 点估计，不是 BKT 的 P(learned) 后验（Lens A ①b）**：BKT 惯例 0.95 是双态 HMM 上「潜在掌握态 | 证据」的**后验**（Corbett & Anderson 1994）；本项目把**置信度放在不同位置**——点估计 `p(L)`（门在 0.7）与置信度（band `lo/hi` + evidence floor）分离。名字撞车很尖锐：「p(L)」正是 BKT 自己的 P(learned) 记号。所以「0.7 是否该向 0.95 靠拢」**在构念上就 off-scale**，不是一个 live 数值决策；正确的「提高置信门」在本项目已由 evidence floor 承担，不是抬高 p(L)。
- **第三个独立信号**：`BandChip` 的「低置信」标签（`view.lowConf`）来自 `state.ts` 的 **SE/`theta_precision` 驱动** `low_confidence` 旗标（`pfa.ts` `LOW_CONFIDENCE_SE_THRESHOLD=1.0`，β=0 时第 1 题后即 false），**不是** evidence-floor(≥4) 驱动。故 UI 上现存「低置信」标签**不代表** frontier 门的 evidence 语义——三信号（0.67/0.45 tone、SE-based lowConf、evidence-floor≥4）共用相邻展示位却互不代表。
- **evidence-floor × 单题确定性出题的交互（Lens A ⑤）**：frontier 尾对每个 KC 取**恰一道**题，`orderBy(question.id).limit(1)`、答案态无关（`stream-store.ts:207-215`），KC 留在 frontier 直到 `evidence_count≥4`。对一个 ≤4 题的薄编排/冷启 KC，**同一道题**跨日反复出现，`evidence_count` 靠**重复暴露同一 item** 爬满——`evidence_count` 数的是尝试量，不是证据独立性。在本项目最看重的稀疏编排（cold-start-first）场景，floor 大多只买到「同一题多做一次」，而非它宣称的多题印证。这是**在 remit 内的完整性缺口**（register item 2 charter 是「把阈值联合记录」，交互本身在范围内，虽然常量的值不动）。

### 4. 副产品 P1 — `SRC_META` 崩溃有**两个** bare 访问站点，不止一个（Lens B MAJOR-1 修正）

- `schema.ts:1443-1446`：`practice_stream_item.source` 是**无约束 `text`** + TS-only `$type` widen（含 `'frontier'`，注释「no DB enum, no migration」）——`audit:schema` 已由 `materializeStream` 的 INSERT write path 满足，**新增 `'frontier'` 无需 schema/migration/audit 同步**（Lens B MINOR-4 确认）。
- `softmax-selection.ts:115,118-124` + `sourceForRole` 已按 `'frontier'` 实现；`resolveSelectionPolicy` 默认 `softmax_mfi`（`stream-store.ts:375-379`），**frontier 走 DEFAULT 路径**（非 legacy-only）——`source:'frontier'` 的 StreamItem 一旦图稠密到某 KC 前置全掌握就会产出（Lens B ④ 可达性：既经 live-compose 也经 nightly 预产，且撞上产品「首次解锁新主题」的庆祝时刻）。
- `practice-api.ts:15` `StreamSource` 联合**缺** `'frontier'`；`PfStream.tsx:22-29` `SRC_META` 同步缺 `frontier` key。**两个 bare 访问站点**：
  1. `PfStream.tsx:32` `const s = SRC_META[source];`（`PfSrcBadge` 体内）。
  2. **`PfStream.tsx:128` `const doneAnchor = anchorFromReasoning(it.reasoning) ?? SRC_META[it.source].label;`（done 行锚点，不经 `PfSrcBadge`）**——草稿完全漏了这一处。对 `'frontier'` 补 key 会**偶然**救活它（key 存在了），但草稿声称的 option-B「防未来新源再犯」保证**是假的**：未来一个 FE 未同步的新源落在 done 行、且 reasoning 无 `「…」` 锚点，仍在 :128 崩同款 `TypeError: Cannot read properties of undefined (reading 'label')`。
- `PfSrcBadge` 的 live 消费面不止 `PfStream`：**`PfSolo.tsx:317`**（`<PfSrcBadge source={item.source} />`，散题**作答中**顶栏，经 `PracticeFacePage.tsx` live）也消费它——修 render-surface 矩阵必须含 PfSolo。
- `src/ui/lib/api.ts:68-70`：`apiJson<T>` 是 `res.json() as Promise<T>` **裸 cast，零运行时校验**；`stream.ts:37` `Response.json(view)` 无 response Zod。TS `Record<StreamSource>` 穷尽性只保护 `SRC_META` 定义处的编译期字面量，对「后端产出 FE 未同步的字符串」这一失效模式**零防护**。源枚举有**四份手维护副本**（`schema.ts:1446` $type、`stream-composer.ts` `StreamPlanItem.source`、`practice-api.ts:15`、`SRC_META` keys）无共享 SoT / 契约测试——`'frontier'` 漂移（schema/composer 由 YUK-349 拿到、FE 没拿到）就是 TS 穷尽性从未 fire 的活证据。
- **既有姊妹惯例已解对**：`QuestionsPage.tsx:80-82`（`srcMeta(source: string) => QSOURCE[source] ?? QSOURCE_FALLBACK`，input typed `string`，不可漏的 fallback）、`DraftReviewPage.tsx:66`、`QuestionDetailPage.tsx:91` 全用这个 idiom。PfStream 的 `Record<StreamSource>` + bare index 是唯一 outlier——修法应**让它归队**（集中式 `string`-input accessor），而非往单站点螺一个 `??`。

---

## 目标与非目标

**目标**：
1. 关闭 P1 overflow 静默坍缩——**单点 emit（在 `learnableFrontierResolved` overflow 返回处），三消费点（composer / FrontierRail / nightly）一次继承可观测性**。最小、行为不变。
2. 关闭副产品 crash——**集中式 accessor**同时覆盖 `PfStream.tsx:32` 与 `:128` 两个站点，归队姊妹 `srcMeta(source: string)` 惯例，防「后端新源 / FE 未知」这一失效模式类再犯。
3. 对阈值/常量给出**联合记录**（文档动作，不改数值），并把 ①a（0.67/0.45 是 YUK-335 三面统一点）、①b（p(L)≠BKT 后验，0.95 off-scale）、⑤（floor × 单题）三条 honestly 写进联合 docblock。
4. 对 0.67/0.7 跨面裁决给 owner **诚实成本的选项**（数值留 owner）。
5. Q4 kg-borrowing 前瞻耦合：test 归本单元——**通过真实 gate（`learnableFrontierResolved`）测 evidence_count=0 借值场景**，不测叶子谓词；tracked trigger 归 #6。
6. 「写时物化」替代：**修正成本会计后** REJECT，留档。
7. ALEKS 27%/90-95% 双源校对结论正确落位。

**非目标**：
- **不重做 #2 快赢批已覆盖面**（evidence-floor=4、AND-gate、γ/ρ 数值）。
- **不改任何阈值数值**（0.67/0.7/4/16/10000 一个不动；M3 只加交叉引用）。
- **不做 evidence-floor 维度的 UI 暴露**（Q3c，DEFER 供 owner 选，选中则独立 PR + 独立 pre-flight）。
- **UI 文案 CLEAN 判定不重论证**（dossier P1 回填已锁定无需改）。

---

## 决策表

### Q1 — overflow/sparse 坍缩 → **单点 emit（Lens B MAJOR-3 + Lens A ② 并入）**

| 选项 | 依据 | 代价 |
|---|---|---|
| **(a) 在 `learnableFrontierResolved` overflow 返回处（`learnable-frontier.ts:224`）单点 `console.warn`** | 三消费点（composer 薄壳、FrontierRail、nightly）**一次继承**——修掉草稿漏的 `frontier-read.ts:217` 知识页盲点，且不用往每个 caller 手抄。`console.warn` 不是 DB 写，不破坏模块 PURE-READ 不变量（INVARIANT BLOCK「no writes」指 DB 写）。overflow 是**持久图病态**非瞬态——一旦 trip，所有 per-recompute 路径（含 per-answer `reRankAfterAnswer`）都 warn，「首次发生即可观测」，解掉草稿原方案「fail-safe 从不 fire→observed warn 永不产生」的近循环触发。 | 单文件单站点 + 测试。三消费点零改动（`stream-store.ts:205`/`frontier-read.ts:217` 保持不动，经 `learnableFrontierResolved` 继承）。 |
| (b) 往每个 caller 手抄 `console.warn` | register 字面「log/emit」 | **REJECT**——草稿只抄进 1 个（`stream-store.ts`）、漏了 `frontier-read.ts:217`；手抄 N 份天然会漏、且要改多文件。 |
| (c) 结构化 meta 传播 → UI 暴露 | owner 关心「data-fix 阶段能看见」 | **REJECT-for-now**——`StreamPlan` 不持久化、`getStream` 从表回读不读 `StreamPlan`，加字段对 owner 零可见度提升；UI 暴露无可复用设计词汇（`YUK-542` `RecordLanding` 是另一 surface）。 |

**裁决：(a) 单点 emit。** 升级触发：**若 `[frontier] closure overflow` 在生产被观测 ≥1 次，升级到 (c) 结构化 meta + UI 暴露**——记在 §M1 代码注释 + §开放问题。
**durable-event 替代的裁决（Lens A ② 邀请的 adjudication）**：**拒绝**把 overflow 写成 `event` 行——`learnableFrontierResolved` 是 PURE READ 且被 compose/rerank 事务内调用，写 event 会（i）破坏读写轴分工，（ii）与事务纠缠。`console.warn`（自托管单用户，owner 对 `docker logs` 有直接访问）是此架构下的正确 evidence 形态；durable event 被拒的理由显式记档。

---

### Q2 — 副产品 crash 修复 + 集中式 accessor（**Lens B MAJOR-1/MINOR-2/enum-gap 并入**）

**立即修复**（补 `'frontier'`）：
- `practice-api.ts:15` `StreamSource` 联合加 `'frontier'`（今天已知的修复，源枚举同步）。
- `PfStream.tsx` `SRC_META` 加 `frontier: { label: '下一步', tone: 'coral', icon: 'target' }`（三字段逐字溯源见 §M2）。

**穷尽性护栏——集中式 accessor（唯一真正防再犯的形态）**：

| 选项 | 依据 | 代价 |
|---|---|---|
| (A) 仅 `Record<StreamSource>` 类型穷尽 | 加 key 后编译期强制补键 | **不成立为护栏**——`api.ts:70` 裸 cast，穷尽性只保护定义处字面量，对未来 FE 未同步新源零防护；且**与 string-accessor 互斥**（Record 精确 union key 要求 `source: StreamSource`，string accessor 要求 `source: string`——姊妹 idiom 已选 string）。 |
| **(B) 集中式 `srcMeta(source: string)` accessor，`SRC_META[source] ?? FALLBACK_SRC_META`，`PfSrcBadge` 与 `:128` 两站点都经它** | 归队 `QuestionsPage.tsx:80-82` 已在用的 `srcMeta(source: string) => MAP[source] ?? FALLBACK` idiom（`DraftReviewPage:66`/`QuestionDetailPage:91` 同）；镜像 `softmax-selection.ts:186-189` `resolveEnumKind`「未知枚举值→安全兜底，绝不 throw」。**覆盖草稿漏的 `:128` 第二站点**——不可漏的运行时 fallback。 | 新增 1 个 accessor + 1 常量；`PfSrcBadge` 与 `:128` 两处改成经 accessor；`SRC_META` 保留 `Record<StreamSource>` 作**字面量定义**形态（编译期仍强制补齐已知键），但 accessor **入参 widen 到 `string`**——不再把 `Record` 穷尽性当「护栏」。 |

**裁决：(B)，`SRC_META` 定义仍用 `Record<StreamSource>`（保留编译期已知键强制），但访问一律经 `srcMeta(source: string)`。** `practice-api.ts` 类型联合照常同步（今天已知修复），运行时 fallback 额外加（防未来漂移）——两者职责不同、不互斥。
**render-surface 矩阵（触及全部消费点）**：`PfSrcBadge` 被 `PfStream.tsx:133`、`PfStream.tsx:158`、**`PfSolo.tsx:317`**（散题作答顶栏，live）消费；`:128` 是独立第二站点。修 accessor 覆盖全部，但 pre-flight 触及清单与测试矩阵**必须显式含 PfSolo 与 :128**。

---

### Q3 — 阈值治理（联合记录 + 0.67/0.7 跨面）

| 子问题 | 选项 | 依据 | 裁决 |
|---|---|---|---|
| 阈值/常量联合记录 | (b) 保留分工 + 联合 docblock | ALEKS 论文刻意拒绝单一标量展示掌握度（Science_Behind_ALEKS.pdf，Table 2 只给两份清单）——旁证多组独立阈值分工更贴合该问题域。三腿一致：需一次显式文档动作，非改代码。 | **(b)，文档/注释动作。** docblock 内容见 §M3（并入 ①a/①b/⑤）。 |
| Q3a — `masteryTone`(0.67/0.45) 是否对齐 `MASTERED_PL_THRESHOLD`(0.7)+floor(4) | (a) 对齐；(b) 保留独立 + 交叉引用 | **诚实成本修正（Lens A ①a）**：选项 (a) **不是**「单常量/快照小改」——`0.67/0.45` 是 YUK-335 跨三面统一点（`masteryTone` + `NodeDrawer.decayCue:33-34` + legend），对齐需**三面同步回改**，否则重开 ring-vs-pill 分裂。且 `[0.67, 0.70)` 是 n=1 未拟合标量上 ~0.03 宽的窄窗，dossier 已测「无同屏矛盾」（FrontierRail chip 用 `masteryBandIdx` 非 `masteryTone`）——**未见任何用户可观测 artifact**。 | **不代拍数值，呈两选项给 owner（成本已诚实标注）**。当前默认 = (b) 保留独立 + 加交叉引用注释。选项 (a) 若被选，须按「re-touch YUK-335 三面统一（`masteryTone` + `decayCue` + legend 一起动）」范围实施，非一行改。 |
| Q3b — 0.7 是否要「回应」BKT 惯例 0.95 | 关闭为**确定性文档动作**，非 owner 数值决策 | **Lens A ①b**：p(L)=σ(PFA logit) 点估计 ≠ BKT P(learned) 后验；名字撞车（「p(L)」是 BKT 自己记号）；0.95 **off-scale、不迁移**；置信度在本项目住在 band + evidence floor（这正是「提高置信门」= 加 evidence floor 而非抬 p(L) 的原因）。「0.7 是否向 0.95 靠」是 malformed，不是 live 决策。 | **确定性 doc 动作，写进 M3 disambiguation，close 而非 defer**。残留 owner 选择仅是 **doc-scope**（联合 docblock 是否够，还是**另加**一段「frontier-readiness ≠ mastery-retirement」的正面论证）——这是文档篇幅偏好，不是数值决策（见开放问题）。 |
| Q3c — evidence-floor 维度是否需 UI 可见 | DEFER | 当前「低置信」标签来自 SE-based 旗标，非 evidence-floor；一个 `evidence_count=3`（p(L)≥0.7 未过门）的 KC 在 `MasteryRing`/`BandChip` 上可能显示「非低置信」——真实可见性缺口。但要么改造 `BandChip` 现有语义、要么新增视觉态，皆设计决策；改动面 4-6 文件；且缺口只在**非 frontier** 的 `MasteryRing` 消费点（frontier 相关面 `FrontierRail` 已带 `evidence_count` 管道，`frontier-read.ts:255-266`）。 | **DEFER**，owner 级开放问题；选中则独立 gated-future UI 切片 + 完整 pre-flight。 |

---

### Q4 — kg-borrowing 前瞻耦合测试归属（**Lens A ③ 修正测试层**）

`state.ts` 借值分支（`applyKgSoftLayer`，实测 `evidence_count: 0` + `low_confidence: true` 硬编码在借值合成块，约 :570-573）+ 两 flag（`GRAPH_LAPLACIAN_ENABLED`/`PREREQ_THETA_PROPAGATION_ENABLED`）今天都 `false`，分支 dark。`learnable-frontier.ts:78-85` 已有 inline 注释记录「flag 翻转后借来的 prereq（evidence_count:0）永不过 floor」，但无 tracked trigger、无测试断言。

| 选项 | 依据 | 裁决 |
|---|---|---|
| test 归 #4（本单元） | gate 自身防御性质属 gate 的测试面。 | **裁：test 归本单元。** |
| **测试形态：DB gate 测试（非叶子谓词单测）** | **Lens A ③**：草稿 M4 提议的 `learnable-frontier.unit.test.ts` 只断言叶子谓词 `isMasteredForFrontier(m,e)`——(1) **冗余**：`learnable-frontier.db.test.ts` 已 ship `(l)`(:326-335，3 clean corrects 的 prereq 不解锁 dependent)/`(m)`(:337-346，self 角色)/`(n)`(:348-358，边界=4)，经**真实 gate** `learnableFrontier(testDb())` 走完整闭包；(2) **测错层/假信心**：叶子单测自称「characterize kg-borrowing 交互」却从不 exercise 借值分支/`getMasteryProjection`/闭包——它是 change-detector，若真回归（`:261` `prereqKcs.every(masteredEnough)` 被降级为裸 `pL(p) >= T`）发生，叶子单测仍 **GREEN**，而 `(l)` 正确 RED。 | **裁：drop 叶子谓词单测；改为通过真实 gate 的 DB 测试**——seed 一个 `evidence_count=0` 的 prereq（正是借值分支的确切形状，区别于 `(l)` 的「3 corrects」形状），断言 dependent 经 `learnableFrontierResolved` 被 gate out。docblock 交叉引用既有 `(l)/(m)/(n)`（它们已是 floor 语义的 characterization）。 |
| tracked trigger 归 #6 | 「flag 翻转须重审 evidence-floor 语义」属 kg-borrowing 单元 remediation 范围。 | **裁：tracked trigger 归 #6**，本单元只显式钉交叉引用（Linear sub-task 挂 YUK-538），不实现 #6 代码。 |

---

### Q5 — 「写时物化」替代：**修正成本会计**（Lens A ④）后 REJECT

**候选**：nightly job 已全图跑 `learnableFrontierResolved`——能否顺手物化 `.ids`/`.kind` 进表，读路径只读物化结果？

**草稿两处会计错误，先纠正**：
1. **读频不是 once-daily，是 per-answer**：daily **首**次 compose 确实一次（`singleFlightCompose:534-538` `count>0 → no-op`），但 live 闭包实际经 `reRankAfterAnswer`（`stream-store.ts:897 → collectComposerInputs:959 → learnableFrontier:205`）**每次作答→done 重算一遍**，另有 `recomposeStream`（:770）。故「一次性、便宜、日更快照」误述了真实频率。
2. **headline 收益是幻觉**：草稿称物化后「彻底不需要 overflow fail-safe」——**假**。即便全物化，`recomposeStream`/`reRankAfterAnswer`/`loadFrontierRail`（`frontier-read.ts:217`）为实时新鲜度**仍调 live 闭包**，fail-safe **删不掉**。草稿只评了「所有读者→表」的极大式设计（那需要写热路径失效钩），从没评真正会被提的**「live 路径下叠一层 nightly TTL 缓存」**（hybrid，无需写路径钩、fail-safe 原封不动）。

**修正后的裁决：REJECT。** 干净论证：物化只是叠在**仍然存活**的 live 路径下的一层缓存——它既杀不掉 fail-safe、也不改 daily-stream 行为，唯一收益是省掉一次**未测量的 per-answer 闭包重算**。用「零已测量性能问题」换一层缓存一致性债，收益不足。若未来读频/图规模数量级变化（compose 不再 once-daily 或 KC 远超万级频繁触 node-cap），重评；当前无此信号。

---

### Q6 — ALEKS 引用规范化 + 措辞红线注释

dossier P1 回填已完成双源校对（Cosyn et al. 2021 JMP 的 27% 冷启首答 vs 营销页 90-95% 学习模式最终习得，测漏斗上不同点，不矛盾但构念不同）。裁决：
1. **本 spec 是主锚**（27% peer-reviewed 主锚；90-95% 营销页降权，仅在显式标注「learning-mode 最终成功率非冷启首答」前提下谨慎引用）。
2. **不改任何 UI 文案**（GAP-1 核查 clean）。
3. **补三处防御性注释**（零行为变更，不触发 UI pre-flight）：`frontier-read.ts:82`（`denseReason` 前）、`softmax-selection.ts:205`（`frontierReasoning` 前）、`FrontierRail.tsx:1`（文件头）——见 §M5。

---

## 机制设计（文件/函数级）

### M1 — Q1：**单点** overflow emit（`learnable-frontier.ts`，覆盖三消费点）

`learnable-frontier.ts`，在 :224 的 overflow 返回处 emit：

```ts
// 现状（:222-224）：
const depthOverflow = normalised.some((r) => r.depth > FRONTIER_DEPTH_LIMIT);
const nodeOverflow = normalised.length > FRONTIER_NODE_CAP;
if (depthOverflow || nodeOverflow) return { kind: 'overflow', ids: [] };

// 改为：
const depthOverflow = normalised.some((r) => r.depth > FRONTIER_DEPTH_LIMIT);
const nodeOverflow = normalised.length > FRONTIER_NODE_CAP;
if (depthOverflow || nodeOverflow) {
  // YUK-XXX（本 spec Q1）：闭包撞 depth/node-cap fail-safe，frontier 整体坍缩为空——与
  // 「稀疏图无 prereq 边」的 sparse 态语义完全不同（前者图过密/病态，后者冷启预期态）。
  // 在此**单点** emit，让全部三个消费点（composer 经 learnableFrontier 薄壳、FrontierRail
  // 经 frontier-read.ts:217、nightly 经 kind 分支）一次继承可观测性——不往各 caller 手抄。
  // console.warn 不是 DB 写，不破坏本模块 PURE-READ 不变量（INVARIANT BLOCK「no writes」
  // 指 DB 写）。不 dedup：overflow 是持久图病态非瞬态，跨消费点的重复 warn 即为告警音量，
  // 「首次发生即可观测」。今天从未真实触发（n=1 稀疏图）；若观测到，升级为结构化 meta 传播
  // + UI 暴露（见 scratchpad/research/2026-07-03-frontier-gate-draft.md §Q1）。
  console.warn('[frontier] closure overflow — depth/node-cap fail-safe tripped, frontier blanked', {
    depthOverflow,
    nodeOverflow,
    depthLimit: FRONTIER_DEPTH_LIMIT,
    nodeCap: FRONTIER_NODE_CAP,
    rows: normalised.length,
  });
  return { kind: 'overflow', ids: [] };
}
```

**三消费点零改动**：`stream-store.ts:205`（薄壳 `learnableFrontier`）、`frontier-read.ts:217`（`learnableFrontierResolved`）保持不动——它们经此函数继承。nightly 会额外多一条 `console.warn`（叠在它自己的 `skipped_overflow` 结构化 log 上）——可接受（告警互补，非噪音，overflow 罕见）。`dense`/`sparse` 路径 byte-identical。

### M2 — Q2：集中式 accessor（`PfStream.tsx`/`practice-api.ts`，覆盖两站点）

`practice-api.ts:15`：

```ts
export type StreamSource =
  | 'decay' | 'variant' | 'new_check' | 'paper' | 'on_demand' | 'import' | 'frontier';
```

`PfStream.tsx:22-39`：

```ts
const SRC_META: Record<StreamSource, { label: string; tone: string; icon: string }> = {
  decay: { label: '衰减复习', tone: 'info', icon: 'history' },
  variant: { label: '错题变式', tone: 'again', icon: 'mistakes' },
  new_check: { label: '新学自测', tone: 'good', icon: 'spark2' },
  paper: { label: '打包卷', tone: 'coral', icon: 'layers' },
  on_demand: { label: '点播', tone: 'neutral', icon: 'send' },
  import: { label: '导入', tone: 'neutral', icon: 'record' },
  frontier: { label: '下一步', tone: 'coral', icon: 'target' },
};

// 未知 source 防御 fallback（YUK-XXX 本 spec Q2）——src/ui/lib/api.ts:70 的 apiJson 是运行时
// 零校验裸 cast（`res.json() as Promise<T>`），源枚举有四份手维护副本（schema.ts:1446 $type /
// stream-composer StreamPlanItem.source / practice-api.ts:15 / 本 SRC_META keys）无共享 SoT。
// TS Record 穷尽性只保护本文件定义处字面量，对「后端产出 FE 未同步新源」零防护（'frontier'
// 就是活证据）。集中式 accessor（入参 string）+ fallback = 归队 QuestionsPage.tsx:80-82 的
// srcMeta idiom，镜像 softmax-selection.ts:186-189「未知枚举值→安全兜底，绝不 throw」。
const FALLBACK_SRC_META = { label: '其它', tone: 'neutral', icon: 'dots' } as const;

// 所有 SRC_META 访问一律经此（PfSrcBadge + done 行锚点 :128 + PfSolo）——不再有 bare index。
function srcMeta(source: string): { label: string; tone: string; icon: string } {
  return SRC_META[source as StreamSource] ?? FALLBACK_SRC_META;
}

export function PfSrcBadge({ source }: { source: string }) {
  const s = srcMeta(source);
  return (
    <span className={`badge tone-${s.tone}`}>
      <LoomIcon name={s.icon as never} size={12} />
      {s.label}
    </span>
  );
}
```

`PfStream.tsx:128`（done 行第二站点，改成经 accessor）：

```ts
// 现状：const doneAnchor = anchorFromReasoning(it.reasoning) ?? SRC_META[it.source].label;
const doneAnchor = anchorFromReasoning(it.reasoning) ?? srcMeta(it.source).label;
```

**逐字溯源**（Q2 决策要求「确切文案/tokens」，实测存在）：
- `label: '下一步'` — 逐字取自已上线 `FrontierRail.tsx:72`。
- `icon: 'target'` — `FrontierRail.tsx:96` + 设计源 `screen-knowledge-a5.jsx:39`；`LoomIcon.tsx:65` 实测存在。
- `tone: 'coral'` — 设计源 `knowledge-a5.css`（`.frontier-ic` background `var(--coral)`）；`web/src/globals.css:6551` `.badge.tone-coral` 实测合法。**⚠️ 与 `paper` 撞色**（`paper` 也是 `coral`，`data-pface.jsx:10` / `PfStream.tsx:26`）——见 pre-flight owner question。
- `FALLBACK_SRC_META` `tone:'neutral'`（`globals.css:6546` 实测）/`icon:'dots'`（`LoomIcon.tsx:54` 实测）——复用既有色系/icon，不新增视觉语言。

### M3 — Q3：联合 docblock（并入 ①a/①b/⑤；文档/注释，零行为变更）

`learnable-frontier.ts`，在 `MASTERED_PL_THRESHOLD`（:65）之前新增：

```ts
/**
 * ═══ 阈值/常量联合记录（YUK-XXX 本 spec Q3，register P2 target shape item 2）═══
 * 本模块与相邻模块共有多组独立、各自服务不同消费者的阈值/常量，此前无单一 artifact 交叉引用。
 * 数值本身是各自 owner-fixed 决策，不在此改。
 *
 *   ① masteryTone 0.67/0.45（src/capabilities/knowledge/ui/mastery-tone.ts:17-22）——展示层
 *      3-tone（good/hard/again），驱动 MasteryRing 环色。⚠️ 这对数值**不是**孤立常量，而是
 *      S5/YUK-335 跨三个展示面的**统一点**：ring disc(masteryTone) + decay pill
 *      (NodeDrawer.decayCue:33-34) + legend，专门修一个「~43% 节点环上读 good、衰减 pill 读
 *      again」的分裂（audit §3.8）。任何对齐动作须三面同步，否则重开该分裂。
 *   ② MASTERED_PL_THRESHOLD=0.7 AND FRONTIER_MASTERY_MIN_EVIDENCE=4（本文件 :65,:87）——gate 层
 *      复合判据（YUK-539），决定 KC 是否离开 frontier 池/满足下游 prereq。
 *   ③ FRONTIER_DEPTH_LIMIT=16 / FRONTIER_NODE_CAP=10_000（本文件 :48,:60）——闭包 fail-safe，与
 *      ①②语义无关，纯 SQL 递归防爆界。
 *
 * ①②读同一个 getMasteryProjection() 标量但独立评估——一个 KC 可能在 MasteryRing 上显示"好"
 * （①）同时未过 frontier 门（②，evidence 不够）。是否对齐①②是 owner 决策，且对齐 = 三面回改
 * （见 §M3 ①），本文件默认保留独立分工。
 *
 * p(L) 的构念（防 BKT 名字撞车，本 spec Q3b）：本项目 p(L) = σ(PFA logit)，是**recall 概率的
 * 点估计**，NOT BKT 的 P(learned) 后验（对二值掌握潜变量），尽管共用「p(L)」记号。故 BKT/
 * Cognitive-Tutor 惯例 0.95（及老 Khan 0.94）**off-scale、不迁移**到本门。置信度在本项目住在
 * band(lo/hi) + FRONTIER_MASTERY_MIN_EVIDENCE，不在抬高 p(L) 阈值上——这正是「提高置信要求」
 * 的正确落点是 evidence floor 而非更高 p(L) 的原因。
 *
 * evidence-floor × 单题出题的交互（本 spec Q5/⑤）：frontier 尾对每 KC 取恰一道题
 * （stream-store.ts:207-215，orderBy(id).limit(1)）。对 ≤floor 题的薄编排/冷启 KC，同一题跨日
 * 反复出现，evidence_count 靠**重复暴露同一 item** 爬满——它数尝试量非证据独立性。故在冷启薄
 * 编排场景，floor 大多只买到「同一题多做一次」，而非多题印证。这是 authoring-supply/refill
 * 路径（单独 owner）的输入，非本门可修——记此以免被误读为「floor 已保证 diverse 证据」。
 */
```

`mastery-tone.ts` 头部注释追加一行回指：

```ts
// SEE ALSO: learnable-frontier.ts 顶部「阈值/常量联合记录」——本模块 0.67/0.45 与 frontier gate
// 的 0.7+evidence-floor(4) 是两组独立、服务不同消费者的阈值；且本对数值是 YUK-335 跨三面统一点
// （+ NodeDrawer.decayCue + legend），任何对齐须三面同步（详见该 docblock §① 与本 spec §Q3）。
```

### M4 — Q4：DB gate 测试（**替代草稿的叶子谓词单测**）

**Drop** 草稿的 `learnable-frontier.unit.test.ts`（叶子谓词单测，冗余于既有 `(l)/(m)/(n)` 且测错层）。**改为**在 `learnable-frontier.db.test.ts` 加一条经真实 gate 的测试，seed 借值分支的确切形状（`evidence_count=0` 的 prereq，区别于 `(l)` 的 3-corrects）：

```ts
it('(o) kg-borrow characterization — a prereq with evidence_count=0 (borrow-branch shape) NEVER
    satisfies a dependent, even at high p(L) → dependent gated OUT through the real gate', async () => {
  // 前瞻锚定（register 单元 kg-borrowing-prereq-propagation-sprawl，state.ts 借值分支硬编码
  // evidence_count:0）。两 flag（GRAPH_LAPLACIAN_ENABLED/PREREQ_THETA_PROPAGATION_ENABLED）今 dark。
  // 本测经完整 gate（learnableFrontierResolved / learnableFrontier）钉：evidence_count=0 的 prereq
  // 即便 p(L) 很高也永不过 floor → 其 dependent 被 gate out。与既有 (l)(3 corrects,evidence 3)、
  // (m)(self 角色)、(n)(边界=4) 互补，专钉「借来的 0-evidence prereq」这一 flag-翻转后的路径。
  // 归属见 scratchpad/research/2026-07-03-frontier-gate-draft.md §Q4（test 归本单元；借值分支
  // 自身正确性 = kg-borrowing 单元 remediation）。
  await seedPrereq('p1', 'F');
  await setEvidenceZeroHighPL('p1'); // p(L) 高但 evidence_count=0（借值形状；helper 见下）
  await setNotMastered('F');
  expect(await learnableFrontier(testDb())).toEqual([]);
});
```

> helper 说明：若既有 fixture 无「高 p(L) + evidence_count=0」直设入口，实施者用与 `setNearMastered` 同款直写 `mastery_state`（success/fail=0 → cold-start p(L)=0.5 不够；需构造 mastery≥0.7 且 evidence_count=0——可直插一行 mastery_state 令 point≥0.7、evidence_count=0，模拟借值合成结果）。这正是 `state.ts` 借值分支产出的态：`mastery=band.point`（可≥0.7）、`evidence_count:0`、`low_confidence:true`。

### M5 — Q6：三处措辞红线注释 + Q7 rerank-asymmetry 注释（Lens B MINOR-7）

三处措辞红线（`frontier-read.ts:82`、`softmax-selection.ts:205`、`FrontierRail.tsx:1`）各加：

```ts
// 措辞红线（本 spec §Q6，Cosyn et al. 2021 JMP 实证 outer-fringe 首答正确率仅 ~27%）：
// frontier 是「结构可达」信号，不是「容易/该会/正确率高」信号——不要在这段文案引入后者措辞。
// 详见 scratchpad/research/2026-07-03-frontier-gate-draft.md §Q6。
```

`stream-store.ts` 的 `reRankAfterAnswer` pool filter（:926-932）加一行决策注释（Lens B MINOR-7，实测过滤只含 `variant`/`new_check`，排除 `frontier`）：

```ts
// 设计决策（本 spec Q7/Lens B MINOR-7）：frontier 进初始 softmax sampler 池，但**排除**在
// 作答后 reRank 之外——placed frontier item 在 θ̂ 移动下冻结、不换。刻意如此：frontier 是
// **结构可达性**信号（前置全掌握），非 θ̂-诊断 slot；reRank 只 churn θ̂-诊断项（variant/
// new_check）。改一侧前先读此注释，勿「修好一边破了不变量」。
```

---

## 实施切片（PR 粒度，**crash 优先——Lens B MINOR-8/④**）

| # | 内容 | 类型 | 文件（创建/修改） | pre-flight |
|---|---|---|---|---|
| **1（先）** | Q2：crash 修复 + 集中式 accessor（覆盖 `:32` + `:128` + PfSolo） | **UI** | 修改 `practice-api.ts`（类型 +frontier）；修改 `PfStream.tsx`（`SRC_META` +frontier、`FALLBACK_SRC_META`、新 `srcMeta` accessor、`PfSrcBadge` 入参 widen、`:128` 经 accessor）；新建 `PfStream.unit.test.tsx` | **是——见下方 UI pre-flight** |
| 2 | Q1：overflow 单点 emit | server-only | 修改 `learnable-frontier.ts`（:224 单站点）；修改 `learnable-frontier.db.test.ts`（复用既有 `(d)/(j)/(k)` overflow 建图，断言 warn fire + sparse/dense 不 fire） | 不需要（非 UI） |
| 3 | Q3+Q6+Q7：文档/注释 | docs-only | 修改 `learnable-frontier.ts`（联合 docblock）、`mastery-tone.ts`（回指）、`frontier-read.ts`/`softmax-selection.ts`/`FrontierRail.tsx`（措辞红线）、`stream-store.ts:926`（rerank-asymmetry 注释） | 不需要（纯注释） |
| 4 | Q4：DB gate 测试 `(o)` | test-only | 修改 `learnable-frontier.db.test.ts`（+1 条经真实 gate 的 evidence_count=0 测试；**不新建叶子单测**） | 不需要（非 UI） |
| — | Q5 | 无代码变更，仅存档 | — | — |

**建议顺序**：**切片 1（crash）先落**——它是唯一 live-reachable 缺陷（frontier 走 default softmax 路径，一旦有 live prereq 边被 accept + prereq mastered 即可达，且撞「首次解锁」时刻）；切片 2（overflow log）修的是**从未触发**的可观测性缺口。2/3/4 低风险可并行/合并；切片 1 唯一 UI 改动，独立 PR + 独立 review。

### 切片 1（Q2）的 UI pre-flight（按 CLAUDE.md 要求提前完成，供 owner approve）

1. **逐字引用的 design doc 段落 + 显式 owner question**：本单元**没有**覆盖 `/practice` `PfSrcBadge` 的 design doc 新段落——设计源 `docs/design/loom-refresh/project/data-pface.jsx:6-13`（`PFACE_SRC`，`SRC_META` 的 1:1 港口）**本身也无** `frontier` key（该设计文件早于 B3 frontier 落地；frontier 设计 token 只存在于 `knowledge-a5.*`，即 FrontierRail 的 surface）。故本切片是**从已上线、已 owner 审阅通过的姊妹组件 `FrontierRail.tsx`（A5 S2/YUK-354）逐字借用文案/icon/色系**（§M2 三条溯源）。CLAUDE.md pre-flight 要求「找不到就停下问」——**故 owner 需明批以下两问**：
   - **Q-preflight-A（跨面 token 借用）**：批准 `frontier` badge 的 `label/icon/tone` 从 FrontierRail(knowledge-a5) 借到 pface surface 吗？（pface 设计源 `PFACE_SRC` 无 frontier token；这是「同概念系统内横向复用」而非发明新视觉语言，但 owner 应知情批准这个替代。）
   - **Q-preflight-B（撞色）**：`frontier` 用 `tone:'coral'` 会与 `paper`（也 coral，`data-pface.jsx:10`）**同色**，仅靠 icon 区分（`target` vs `layers`）。批准 coral 复用，还是给 frontier 挑一个 distinct tone？（badge 六态可选：`neutral`/`coral`/`info`/`good`/`hard`/`again`。）
2. **组件类型**：**既有页面组件的内部数据结构 + 既有函数的防御性重构**——非新 drawer/route/modal/page。`PfStream.tsx` 是 `/practice` 流视图既有内容组件；本切片改其内部 `SRC_META`（+1 条目）、新增 `srcMeta` accessor + `FALLBACK_SRC_META`、`PfSrcBadge` 入参 widen、done 行 `:128` 经 accessor；不新增组件/路由。
3. **将 touch 的文件**（含 render-surface 全矩阵）：
   - 修改：`src/capabilities/practice/ui/practice-api.ts`（`StreamSource` +frontier）
   - 修改：`src/capabilities/practice/ui/PfStream.tsx`（`SRC_META` +frontier、`FALLBACK_SRC_META`、`srcMeta` accessor、`PfSrcBadge` 入参 `string`、`:128` doneAnchor 经 accessor）
   - **覆盖但不改**：`src/capabilities/practice/ui/PfSolo.tsx:317`（散题作答顶栏，import `PfSrcBadge`——经修复自动覆盖；列入矩阵供 reviewer 核「所有 frontier render surface 已覆盖」）
   - 新建：`src/capabilities/practice/ui/PfStream.unit.test.tsx`

---

## 测试与 gate

- **切片 1**：`pnpm vitest run --config vitest.unit.config.ts src/capabilities/practice/ui/PfStream.unit.test.tsx`。**测试矩阵（Lens B slice-5 gap 修正——必须含 :128 与 PfSolo）**：
  - (a) `PfSrcBadge({source:'frontier'})` → `label:'下一步'`/`tone-coral`/`target` icon。
  - (b) `PfSrcBadge({source:'unknown-future' as any})` → fallback（`其它`/`neutral`/`dots`），**不 throw**。
  - (c) **done 行 frontier**（`reasoning` 无 `「」` → 强制走 `:128` doneAnchor）→ 锚点回退到 `srcMeta(source).label`，**不 throw**。
  - (d) **done 行 unknown source** → `:128` 经 accessor 回退，**不 throw**。
  - (e) **PfSolo 顶栏渲一个 frontier item**（或至少断言 `PfSrcBadge` 覆盖 PfSolo 消费路径）。
  - **`audit:partition`**：新文件路径是 `src/capabilities/practice/ui/PfStream.unit.test.tsx`（**非** `src/ui/**`——草稿引用的 glob 路径不准）；既有 `src/capabilities/practice/ui/practice-api.unit.test.ts` + `src/capabilities/knowledge/ui/BandChip.unit.test.tsx` 已作 unit 跑，判例成立，但 `audit:partition` 须对**实际新文件**跑。
- **切片 2**：`pnpm vitest run --config vitest.db.config.ts src/capabilities/practice/server/learnable-frontier.db.test.ts`——复用既有 `(d)`(depth overflow)/`(j)`/`(k)` 建图，spy `console.warn`：断言 overflow 场景 fire 一次（携 `depthLimit`/`nodeCap`/`rows`），**且** sparse/dense 场景**不** fire（负向断言，防加错分支）。三消费点继承由此单测覆盖（emit 在被三者共调的 `learnableFrontierResolved` 里）。
- **切片 3**：无新测试（纯注释），`pnpm typecheck`/`pnpm lint`。
- **切片 4**：`pnpm vitest run --config vitest.db.config.ts src/capabilities/practice/server/learnable-frontier.db.test.ts -t '(o)'`。
- **audit:schema / postman（Lens B MINOR-4，显式记档）**：**无需同步**——`practice_stream_item.source` 是 plain `text` + TS-only `$type` widen（`schema.ts:1443-1446`「no DB enum, no migration」），`materializeStream` 已有 INSERT write path，`audit:schema` 对 `'frontier'` 已满足；`stream.ts:37` `Response.json` 无 response Zod、无 route method/path/body/query 改动，`gen:postman` 不受影响。
- **全量 pre-PR gate**：`pnpm typecheck`、`pnpm lint`、`pnpm audit:schema`、`pnpm audit:partition`、`pnpm test`、`pnpm build`。
- **红线自检**：全部切片零写路径（`learnable-frontier.ts`/`frontier-read.ts` 保持纯读，`console.warn` 非 DB 写）；n=1 不拟合零涉及；阈值数值零改动；evidence-first（切片 2 是直接体现）。

---

## 开放问题（owner 级）

1. **Q1 升级触发**：`[frontier] closure overflow` 生产观测 ≥1 次 → 批准升级 (c) 结构化 meta + UI 暴露？（默认：观测到再讨论。）
2. **Q3a — masteryTone(0.67/0.45) 是否对齐 gate(0.7+floor 4)**：
   - (a) 对齐——**须知真实成本**：这是 YUK-335 三面统一点回改（`masteryTone` + `NodeDrawer.decayCue` + legend 一起动），非一行；且 `[0.67,0.70)` 是 n=1 未拟合标量上 ~0.03 窄窗，dossier 已测无同屏矛盾、无用户可观测 artifact。
   - (b) 保留独立 + 本 spec 已加交叉引用注释（当前默认）。
3. **Q3b — doc 篇幅偏好（非数值决策）**：0.95 off-scale 已由 M3 disambiguation 关闭。残留仅：M3 联合 docblock 是否够，还是**另加**一段「frontier-readiness ≠ mastery-retirement 为何故意不同」的正面论证段（lit lane 措辞最强的一条）？**不改 0.7 数值本身**。
4. **Q3c — evidence-floor 维度是否上 `MasteryRing`/`BandChip`**（DEFER）：若要，独立 gated-future UI 切片 + 完整 pre-flight（改造 `BandChip` 语义或新增视觉态，皆 owner 设计决策）。
5. **Q-preflight-A / Q-preflight-B（切片 1 UI）**：跨面 token 借用（FrontierRail→pface）批准？coral 撞 paper 是否换 distinct tone？
6. **Q4 tracked trigger**：已裁归 #6（`kg-borrowing-prereq-propagation-sprawl`）——落地时开轻量 Linear sub-task 挂 YUK-538，交叉引用 register #6 + 本 spec §Q4，不预先实现 #6 代码。
7. **实施切片粒度**：切片 2/3/4 是否合并（低风险非 UI）？切片 1 建议独立 PR + 独立 review。

---

## 附录 — Attack 裁决 ledger（两轴逐条）

裁决码：**ACCEPT**（修入终稿）/ **ACCEPT-refined**（并入但重构框定）/ **PARTIAL**（部分并入 + 部分显式拒绝并记理由）。本轮**无 outright REJECT**——两轴全部命中真实 gap，均已接地 `edc7cf62` 复核。

### Lens A（算法/阈值治理）

| # | 严重度 | 裁决 | 处置 + 接地证据 |
|---|---|---|---|
| A①a | MAJOR | **ACCEPT** | 0.67/0.45 是 YUK-335 三面统一点（`mastery-tone.ts:11-14` + `NodeDrawer.decayCue:33-34` 实测=0.67/0.45）。Q3a 重构为「对齐 = 三面回改，非一行」+ 诚实成本（~0.03 窄窗、n=1 未拟合、无可观测 artifact）；M3 docblock ① 记「统一点非孤立常量」。 |
| A①b | MAJOR | **ACCEPT-refined** | p(L)=σ(PFA logit) 点估计 ≠ BKT P(learned) 后验（`learnable-frontier.ts:61-65`）；0.95 off-scale 不迁移；置信度住 band + floor。Q3b 从「owner 数值决策」降为**确定性 doc 动作**（M3 disambiguation，close）。**保留**的 owner 选择仅 doc-scope（是否另加正面论证段），非数值——refined 于 attacker「直接 close」以尊重 dossier lit lane 的正面回应诉求。 |
| A③ | MAJOR | **ACCEPT** | 既有 DB 测 `(l)`(:326-335)/`(m)`(:337-346)/`(n)`(:348-358) 经真实 gate 已覆盖 floor 语义；草稿 M4 叶子谓词单测冗余 + 测错层（真回归时保持 GREEN）。Drop 叶子单测；改为 DB gate 测试 `(o)`（evidence_count=0 借值形状，经 `learnableFrontierResolved`）。切片 4 从 unit → DB。 |
| A④ | MAJOR | **ACCEPT** | 读频是 per-answer（`reRankAfterAnswer:897→collectComposerInputs:959→learnableFrontier:205`）非 once-daily；fail-safe 物化后仍删不掉（`recompose:770`/`reRank:959`/`frontier-read.ts:217` 仍调 live 闭包）。Q5 重写会计；REJECT 裁决不变但论证改为「cache-under-live-path 省未测量 per-answer 重算 → 收益不足」。 |
| A② | MINOR | **PARTIAL** | **ACCEPT**：reRank 路径纳入分析/测试（emit 在共调的 `learnableFrontierResolved`，per-answer 继承）；单点 emit 解掉「触发近循环」（首次即多路 warn）。**REJECT durable-event 替代**（写 event 破坏 PURE-READ + 事务纠缠）——保留 `console.warn`，理由记档（Q1 durable-event 段）。 |
| A⑤ | MINOR | **ACCEPT** | frontier 尾单题确定性出题（`stream-store.ts:207-215`）；floor 数尝试量非独立性；≤floor 题 KC 靠重复暴露爬满。写进 M3 docblock（authoring-supply 路径输入）。在 remit（register item 2 charter「联合记录」含交互，不含改值）。 |

### Lens B（运行态/UI 传播）

| # | 严重度 | 裁决 | 处置 + 接地证据 |
|---|---|---|---|
| B MAJOR-1 | MAJOR | **ACCEPT** | 第二 bare 站点 `PfStream.tsx:128`（`SRC_META[it.source].label`，不经 PfSrcBadge）实测确认。集中式 `srcMeta(source: string)` 覆盖两站点，归队 `QuestionsPage.tsx:80-82` idiom。M2 重写。 |
| B MINOR-2 | MINOR | **ACCEPT** | 四份手维护枚举副本、`api.ts:70` 裸 cast 实测确认。accessor 入参 widen `string`（`Record<StreamSource>` 保留作字面量定义、不再当护栏）；Record 与 string-accessor 互斥点已在 Q2 表述。 |
| B enum-gap（PfSolo） | MAJOR（属 ①） | **ACCEPT** | `PfSolo.tsx:317` `<PfSrcBadge>` live 消费实测确认。纳入 render-surface 矩阵 + 测试 (e) + pre-flight touch 清单。 |
| B MAJOR-3 | MAJOR | **ACCEPT** | 第三消费点 `frontier-read.ts:217-218`（`kind==='dense'?ids:[]`，sparse+overflow 同折，零日志）实测确认，驱动知识页。修法改为 §M1 单点 emit（三消费点一次继承），subsume 草稿逐 caller 手抄。 |
| B MINOR-4 | MINOR | **ACCEPT** | `schema.ts:1443-1446` plain text $type widen、`stream.ts:37` 无 response Zod 实测确认。测试节显式记「audit:schema/postman 无需同步」。 |
| B MINOR-5 | MINOR | **ACCEPT** | `data-pface.jsx:10` + `PfStream.tsx:26` paper=coral 实测确认。升为 pre-flight owner question Q-preflight-B。 |
| B MINOR-6 | MINOR | **ACCEPT** | `PFACE_SRC`（`data-pface.jsx:6-13`）无 frontier key 实测确认。升为 pre-flight owner question Q-preflight-A（跨面借用显式请批）。 |
| B MINOR-7 | MINOR | **ACCEPT** | reRank pool filter（`stream-store.ts:926-932`）只含 variant/new_check、排除 frontier 实测确认。M5 加 rerank-asymmetry 决策注释（frontier 结构可达非 θ̂-诊断）。 |
| B slice-5 test gap | MAJOR（属 ①） | **ACCEPT** | 测试矩阵加 (c) done+:128 / (d) done+unknown / (e) PfSolo。 |
| B MINOR-8 + ④ 可达性 | MINOR/框定 | **ACCEPT** | frontier 走 default softmax（`resolveSelectionPolicy:375-379`→`sourceForRole:118-124`）实测确认，撞「首次解锁」时刻。切片重排：crash 优先。 |
| B partition 引用 | nit | **ACCEPT** | 新文件 `PfStream.unit.test.tsx`（非 `src/ui/**`）；`audit:partition` 对实际文件跑。 |

---

**Linear 捕获门**：本单元 target shape（overflow 可观测、阈值联合记录、0.67/0.7 决策）已在 master register `learnable-frontier-gate` 条目内，无需新开独立 follow-up。**新登记两条轻量 sub-task（挂 YUK-538）**：① kg-borrowing tracked-trigger 交叉引用（归 #6 消费）；② Q3c evidence-floor UI 暴露（gated-future，owner 选中才启）。两条落地时创建，不在本 spec 阶段抢先。
