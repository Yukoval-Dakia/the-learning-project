# SoT-flip oracle — 终稿 spec（worklist #5，reconciled）

> **Program**: 项目逻辑全量打磨（master register worklist #5，`docs/design/2026-07-02-project-logic-master-register.md` §`event-sourcing-fold-sot-flip-status`，line 668-676）
> **Linear**: 子 issue 挂 YUK-538。YUK-547（learning_item prefetch threading）是既存独立 Linear 占位，本 spec 裁其执行顺序为「本单元 slice 0」，PR 仍 `Closes YUK-547` 单独关闭。
> **Provenance**: research dossier `scratchpad/research/2026-07-02-worklist-sot-flip-research.md`（三腿 CODE/LIT/OSS + P0-2 生产实测补洞）+ 姊妹 spec `docs/design/2026-07-02-kc-dedup-attribution-rewrite-spec.md`（文体先例、YUK-543/544 landed 事实）+ 两轴对抗攻击（Lens A oracle 有效性 / Lens B 运维回滚顺序）。
> **Status**: 终稿，已吸收两轴 attack 裁决（见附录 Attack Ledger）。全部代码断言本轮直接对 HEAD `bb5e115f` 重新核验，file:line 已 re-ground。
> **可交付性**: 本 spec 切片到文件/函数级，可直接交 Opus executor 实施。**红线**：n=1 不拟合 item 参数；misconception/θ̂ 信号不写 mastery/p(L)/FSRS/difficulty；数据门只 gate 翻转不 gate build（oracle 机制必须实现+接线+live 跑通，只有最终 flip 动作等证据）；fold-owned 表禁 raw UPDATE；evidence-first 可追溯可回滚。

---

## 0. 攻击后的核心校正：持续 oracle 能抓什么 / 不能抓什么（重言的精确边界）

这张表是本轮 attack（Lens A §0）逼出的、草稿缺失的核心。flag ON 后，活行由 `projectXGuarded` 用 `gatherAndFoldX` 写入；若持续 oracle 又用**同一个** `gatherAndFoldX`（`gather.ts:6-12` 明说 shell 与 auditor 共用单一 gather）重算再 diff，则 `b3-gate.ts:27-30` 白纸黑字：*post-rebuild audit「compare[s] the fold against itself — tautologically clean」*。对一个已 ON 的实体，持续「值级 diff」腿真实的捕获集是：

| 故障类 | 值级 diff 腿（同 reducer） | 对称 rowset 腿 | 判定 |
|---|---|---|---|
| out-of-band 直改行（手工 psql / migration / 漏 gate 的命令式写者 / `projectX` 持久化失败） | ✅ 抓 | ✅ 抓 | **真信号（非重言）** |
| reducer 逻辑值错（fold 算错但自洽） | ❌ 重言瞎 | ❌ 重言瞎 | **盲** |
| gather 谓词漂移（漏 action 类型） | ❌ 重言瞎 | ❌ 重言瞎 | **盲** |
| fold 非确定 / 因果排序错 | ❌ 重言瞎 | ❌ 重言瞎 | **盲** |

**结论**：持续 oracle（Q4a）的真实职责是**「检测绕过投影的外部写入 + rowset 存在性异常」**，不是「证明 reducer 正确」。整条 fold 管线内部的 bug（逻辑/谓词/排序）在 ON 后对 Q4a 结构性失明。register line 673 头号诉求「翻转之后证明 fold 没漂移」需要一条**非同源**的腿——这就是新增的 **Q4b（retained-golden 独立 oracle）**，本终稿的最大修入。Q4a 与 Q4b 名实分离，不再让一条重言 cron 冒充 register 的独立诉求。

---

## 1. 现状与问题（接地 bb5e115f）

**Flag 现状**（`src/server/projections/sot-flag.ts:57-80`，`docker-compose.mac.yml:15-23`）：6 个 flag domain 覆盖 7 个 `subject_kind`，**3/6 ON**（裸全局 `PROJECTION_IS_WRITER`→knowledge+knowledge_edge、`_ARTIFACT`、`_QUESTION_BLOCK`）、**3/6 OFF**（`_GOAL`、`_MISTAKE_VARIANT`、`_LEARNING_ITEM`）。`docker-compose.mac.yml` 仍 **git-untracked**——生产实际配置只活在 owner 本机文件系统。

**Flag 是跨进程读的**（本轮 grep 全量核验，Lens B M1 grounding）：同一实体的 flag 在 **worker 进程**（`variant_gen.ts:257`、`variant_verify.ts:305` — mistake_variant）**和 API 进程**（`actions.ts:997/1227/1365`、`goal-create.ts:130`、`goals/accept.ts:146`、`proposal-appliers.ts:437,580` — learning_item/goal/mistake_variant；`block-structured-edit.ts:224` — question_block）**各自独立读 `process.env`**。含义：翻转/回滚若非「停机→改 env→启动」，会出现 app-ON / worker-OFF 的偏斜窗口，同一行被两种写者语义竞写。这是本设计运维轴的头号真实风险，草稿完全未覆盖。

**P0-2 已把两个 ON 实体的敞口从推断升级为实测，但捕获边界必须收窄陈述**（dossier §P0-2 补洞 + Lens A M2 校正）：对 artifact(15 行)/question_block(69 行)的只读探针实测 **15/15、69/69 双向差集零、全字段 fold-parity 净**。但——artifact 15 事件**全 `experimental:genesis`**；question_block 118 事件 = 69 genesis + 40 `auto_enroll_observed` + 9 `proposal`，而后两类**不被 `gatherAndFoldQuestionBlock` 消费**（Q1+Q2 只吃 genesis/create/`experimental:edit_question_block_structured`，`gather.ts:346-375`）。**两个 ON 实体的 prod 数据从未行使过任何 mutation-reducer 分支**。P0-2 的正确结论 = **「证明了 rowset 双向对称 + 无 out-of-band 改行；genesis→fold 是构造性恒等（backfill 写 `payload.row`，fold 读 genesis seed，`learning_item.ts:152-172`）；未触及任何 mutation-reducer 分支」**。据此把「裸奔补救」P1 紧急度降级——但只对 out-of-band/ghost 类成立，对 mutation-reducer 正确性 P0-2 一字未证。

**`audit:projection` 已泛化到全 7 kind 的值级 audit（`audit-projection.ts:315-455`），但缺两处**：
1. **`scripts/rebuild-projection.ts:37-70`** 的 `allNodeIds`/`allEdgeIds` 硬编码只 import + 处理 `knowledge`/`knowledge_edge`；`scripts/b3-gate.ts:56,93-101` 的 `liveNodeIds`/`liveEdgeIds` 同样硬编码。**5 个非-W1 实体没有可运行的 rebuild/b3-gate 路径。**
2. **rowset 对称性（ghost/幽灵复活）只在 b3-gate 的 mutating rebuild 前后快照里出现**（`b3-gate.ts:157-181`）；`audit-projection.ts:310-313` 自述「this checks every LIVE row… out of scope for the live-row scan」——从未对 goal/mistake_variant/learning_item 做双向 rowset。P0-2 探针是唯一做过、且只做过 2 实体、一次性、已删。

**`audit:projection` 无 anchor 适用性门，安全只因跑在全量 backfill 的 clone 上**（Lens A M3 grounding）：`parity.ts` 的 in-tx assert 对每个实体有 `hasXGenesisAnchor` 门（`hasLearningItemGenesisAnchor` line 660，`LEARNING_ITEM_ANCHOR_ACTIONS=['experimental:genesis']` line 653），因为「a pre-event-sourced row folds to null and would FALSE-mismatch」（`parity.ts:729-734`）。但 `auditProjection` 逐 LIVE 行 fold（`audit-projection.ts:393-404` 等），**没有** anchor 门。把它原样搬到 live prod 会对任一 un-anchored 活行报假 GHOST/DRIFT。

**genesis-backfill 的 SCOPED 性是 b3-gate 全部真牙的前提**（Lens A M5 grounding）：`b3-gate.ts:31-34` — 已 event-sourced 的行**不**被重新 anchor，否则「an unscoped backfill stamps a genesis snapshot LAST in the fold and masks exactly this divergence」。「已 event-sourced」判据**逐实体不同**（`GOAL_ANCHOR_ACTIONS` parity.ts:230；`LEARNING_ITEM_ANCHOR_ACTIONS` line 653；`ARTIFACT_ANCHOR_ACTIONS` line 832 含 event+index 双腿）。若某实体的 anchor-action 清单漏一个应算 event-sourced 的 action → 该行被 backfill 盖 current-state genesis（`learning_item.ts:152-172` 的 first-base + `row===null` skip，line 158/175）→ `fold==row` → **audit 假 CLEAN → 假 GO**，reducer 漂移被掩盖。方向不对称：过窄→fold null→假 RED（fail-closed，安全）；只有**过包含**危险。

**fold 顺序确定性零验证，且 tiebreak 非因果保证**（critic P2-6 + Lens A M6 grounding）：每个 reducer 进门 `[...events].sort(byCreatedThenId)`（`learning_item.ts:133`，comparator line 109-114，`(created_at, id)` tiebreak）。learning_item 顺序敏感：complete 要求 `status IN(pending,in_progress)`（line 197），relearn 要求 `status IN(done,resting)`（line 229）——同毫秒 complete+relearn，先 relearn 后 complete → 终态 `done`；先 complete 后 relearn → 终态 `in_progress`。live 写与 audit 用**同一** sort → 恒等 CLEAN 即使折出因果错误的态。

**YUK-547 prefetch 缺口未落地**（`gather.ts:273-300`）：`gatherAndFoldLearningItem(db, itemId)` 每次无条件 `db.select().from(event).where(eq(event.action,'experimental:knowledge_merge'))` 拉全表（line 283）；`audit-projection.ts:393-404` 逐 learning_item 行循环调用 → O(N_items × 全表)。

**YUK-544 `merge_attribution_sweep` 是活先例但边界关键不同**（`manifest.ts:154-172`）：weekly（`0 4 * * 1`）census + bounded auto-repair，queue **`'llm'`**（注释 line 164-166 明写「'fast' would skip the DLQ, and a repair write deserves DLQ retry coverage like its siblings」），forensic `experimental:merge_attribution_repaired`。**关键差异**：merge-attribution 的漂移调用 accept 路径同一套幂等 retire 函数、不改「谁权威」；而**投影漂移的「自动修」= 让 fold 赢 = 一次静默局部 SoT 翻转**，直接违反本单元红线——所以 Q4a **绝不自动修**。

**无统一 registry**：`parity.ts`/`gather.ts`/`audit-projection.ts`/`rebuild-projection.ts`/`b3-gate.ts` 五处各自手写 per-entity 分支，无 `Record<Kind, Adapter>` 穷尽分发，尽管 `sot-flag.ts:57-70` 的 `PER_ENTITY_FLAG_ENV`（`as const` + `keyof typeof`）已在 flag 层示范。

---

## 2. 设计目标与非目标

**目标**：
1. 给「敢翻 goal/mistake_variant/learning_item」定义显式、可复用、可执行的就绪判据。
2. **两条独立职责的 post-flip oracle**：（Q4a）持续 report-only 的 out-of-band-写 + rowset 存在性探测器；（Q4b）register line 673 点名的**非同源**独立 oracle——retained-golden 命令式参照 + reducer/gather 变更触发的离线重审——覆盖 fold 管线内部漂移，**必须在翻 learning_item 前落地**。
3. 把 B3 gate 骨架从 2 实体泛化到 7，复用现成 7 组 `project*`/`gatherAndFoldX`，**零 reducer 改动**；泛化工具对每个新实体必须有 **NO-GO 腿测试**（种 drift/deleted/ghost），不能用「复现 CLEAN」冒充捕获能力。
4. git-track 生产 flag 清单。
5. 落地 YUK-547（性能，非正确性）。
6. 补 OFF 实体 prod-warn 分支测试。
7. 把翻转的运维包络补实：**停机翻转（不 rolling）**闭掉跨进程偏斜窗口；顺序依赖降为 WARN + 人工前置校验（不 boot-throw，避免回滚死锁）；显式写明「回滚≠数据修复」。

**非目标**：
- 不引入新的**运行时**双写/影子写机制（Q1）。Q4b 的 golden 是**离线**一次性快照 + 离线重 fold，非请求路径写者，不违反 Q1。
- 不改任何 reducer/fold 业务逻辑。
- 不写 mastery_state/θ̂/material_fsrs_state/difficulty 任何字段（红线）。
- Q4a **绝不自动修复**漂移。
- 不做 UI。
- 不做 Marten 式 Blue/Green（n=1、单进程组、可停机不触发）。
- 不投 TLA+（n=1 过度工程）。
- **不建跨进程 flag 指纹共享表**（Lens B M1 提议的重型 guard）——n=1 场景「停机翻转」已完全闭掉偏斜窗口，共享表是过度工程；只保留启动期 **loud-WARN** 比对（廉价）。

---

## 3. 决策表

### Q1 — shadow imperative write 窗口 vs 「勿加新运行时机制」

**裁决**：**B，拒绝新的运行时 shadow-write**（不变）。理由链不变：P0-2 证明 flip 后只读探针即可拿到与 shadow-write 同强度的 rowset 证据；OSS 三先例无一支持 n=1 停机场景引入双写；N-version（Chen & Avizienis 1978）警示同源 shadow-write 主要验证「是否正确复制旧代码」而非「新代码是否正确」。

**与 register line 673 的调和（Lens A M1 修入）**：register 给了**两个**并列选项——(a)「reducer-code-hash-triggered re-audit against a retained prod-clone imperative rebuild」或 (b)「temporary shadow-imperative-write compare」。草稿拒了 (b) 却也没交付 (a)，用被否决的重言 cron 顶替。**本终稿取 (a)**：retained-golden 命令式参照（=历史命令式路径产出的行快照，冻结为数据 artifact，非再执行命令式代码）+ reducer/gather 变更触发的离线重 fold-vs-golden diff。这**不是运行时机制**（离线、一次性、非请求路径），所以 Q1 裁决（拒运行时 shadow-write）与交付 register 的独立腿**同时成立**，不矛盾。细节见 Q4b + 组件 7。

**残留（诚实记录）**：common-mode/稳定性错误对 Q4a 保持开放；Q4b 关闭其中「post-flip reducer 回归」子类（golden 是命令式历史输出，非 fold 再解读），但不关闭「flip 当刻 reducer 与命令式同错」子类——后者已由 flip 门（b3-gate audit：fold==imperative row 才 GO）在翻转当刻拦截。

### Q2 — b3-gate 泛化形态

**裁决**：**B，registry 驱动**（不变）。新文件 `src/server/projections/entity-registry.ts` 定义 `ProjectionKind` union + `Record<ProjectionKind, ProjectionAdapter>`（穷尽性由 tsc 强制）。`rebuild-projection.ts`/`b3-gate.ts`/`audit-projection.ts` 参数化消费（详见组件 1/2/3）。

**攻击修入**：
- **per-kind 事务，非 all-7 单 tx**（Lens B m7）：先核验 7 kind 间 FK 图（`learning_item.primary_artifact_id`→artifact？`parent_learning_item_id` 自引？`question_block`↔`question_part`？`child_learning_item_ids`？），**仅**在真实 FK 强制处配对（knowledge→knowledge_edge 保持同 tx）；其余 per-kind 独立 tx。理由：`runB3Gate(db, kind)` 本就 per-kind，all-7 共享 tx 既与之不一致、又把一个 kind 的 topology reject 放大成 7 kind 全回滚。FK 图核验是 slice 2 的前置步骤。
- **`RebuildCounts` shape 变更是真接口变更，不冒充 behavior-preserving**（Lens B m10）：`RebuildCounts` 从 `{nodes,edges}`（`rebuild-projection.ts:45-48`）扩成 `Record<ProjectionKind, number>`，**同步更新** `printReport`（`b3-gate.ts:206-209` 读 `.nodes/.edges`）+ `--json`（line 266）+ 计数断言测试；「behavior-preserving」的范围**显式收窄为 GO/NO-GO verdict**，不含 counts shape。W1 的 `{nodes,edges}` 保留为兼容视图或改断言，二选一由 executor 定，但必须 own 这些下游改动。

### Q3 — per-entity readiness checklist

**裁决**：**C，混合**（不变）。唯一提升为可执行断言的判据 = 「`PROJECTION_ENTITIES` 是否登记该 kind」，由 `Record` 穷尽性免费提供（漏登记 = tsc 编译错）。

**攻击修入（Lens A M5）——撤销「scoping 无需逐实体重验」的危险豁免**：草稿表格把「backfill 已通用/幂等，无需逐实体重验 scoping」勾成免检——**撤销**。每个 OFF 实体翻转前，必须独立核验其 `X_ANCHOR_ACTIONS`（`parity.ts` 各实体常量）**穷尽了「所有能让该行 event-sourced 的 action」**；并加一条 slice-2 测试：构造「有 mutation 事件但 anchor 清单误判为 event-less」的行，断言 gate 给 **NO-GO**（验证 scoping 不静默过包含）。剩余判据留文档 checklist（下次 touch 同步进 register）：

| 判据 | goal | mistake_variant | learning_item |
|---|---|---|---|
| gather 消费全部已知 mutation 事件类型 | reviewer 过 `gather.ts:160-194` | 过 `gather.ts:209-250` | 含 Q3 merge（YUK-543 shipped）；prefetch 见 Q6 |
| write-through shell 存在 | ✅ `projectGoalGuarded` | ✅ `projectMistakeVariantGuarded` | ✅ `projectLearningItemGuarded` |
| `X_ANCHOR_ACTIONS` 穷尽性逐实体重验 + 过包含 NO-GO 测试 | **必做**（Q3 撤豁免） | **必做** | **必做**（当前仅 `['experimental:genesis']`，任何新 base event 须同步） |
| `PROJECTION_ENTITIES` 登记（tsc 强制） | Q2 落地后自动满足 | 同左 | 同左 |
| prod-clone 跑过 ≥1 次 B3 gate 且 GO | 未做 | 未做 | 未做 |
| **Q4b golden 参照已在 flip 前捕获** | **未做** | **未做** | **未做（register：learning_item flip 前硬性）** |

### Q4 — 持续性 oracle 形态（拆成 Q4a + Q4b）

**Q4a（持续 report-only sweep）裁决**：**A，但价值命题诚实改写**。weekly report-only job，范围只覆盖当前 ON 实体，两条腿（值级 diff + 只读双向 rowset 对称），**绝不自动修**。**依 §0 表，其价值命题 = 「探测绕过投影的外部写入 + rowset 存在性异常」，不是「证明 fold 没漂移」**（Lens A m4/m5 修入）。core 约束：
1. **hasXGenesisAnchor 适用性门必须复用**（Lens A M3）：两条腿都跳过 un-anchored 活行（复用 `parity.ts` 的 `hasXGenesisAnchor`/`XsWithGenesisAnchor` 批量门），或在 job 前置断言「该实体活行 100% anchored」；否则 live prod 上 §9.3 data-fix 新插行/漏 backfill 历史行会报假 GHOST/DRIFT，report-only 不豁免假阳（没人信的报告不是 oracle）。
2. **单快照读一致性**（Lens A M4 / Lens B M5）：整个 sweep 包在**一个** `REPEATABLE READ` 事务，行与事件读同一时点快照；否则 live 并发写（含 merge_attribution_sweep 04:00 的尾写）在行读/事件读之间落地会造假 FIELD_DRIFT/MISSING。非快照读的非-CLEAN 判定**不admissible as drift evidence**（写进 doc）。
3. **queue `'llm'` 非 `'fast'`**（Lens B M4）：oracle **写** forensic 证据，是 codebase 最 evidence-first-mandated 的 job；`'fast'` 跳 DLQ（`queue-config.ts:29-32`），dropped run 静默消失=证据轨迹一周盲区。与 `kc_dedup_nightly`/`merge_attribution_sweep`（`manifest.ts:145-148,164-166` 均 `'llm'`）对齐。
4. **forensic drift 写 fold-inert sink**（Lens B m6 / Lens A m2）：结构化日志（镜像 `[projection-parity]` tag）为**主**证据轨迹（不可能自污）；forensic event 为**可选**，且必须用**任何 gather 都不消费的 `subject_kind`/`action`**（结构保证 fold-inert，非「碰巧 reducer 忽略未知 action」），并 **one open record per id**（非 per run，防无界累积 + 回灌自扫）。若 event schema 约束 subject_kind，退回专用审计日志表。
5. **审 ON-in-any-process，非 worker 本地读**（Lens B m8）：sweep 依 **git-tracked flag 清单**（单一真相）判定谁 ON，而非 worker 本进程 `projectionIsWriter()`——避免混态下 worker 看 OFF 而漏审 app 正在 fold-写的实体。
6. 不自动开 Linear issue（既有纪律）。

**Q4b（NEW — retained-golden 独立 oracle，register line 673 硬性）裁决**：**落地**。这是 register「must land before flipping learning_item」的那条腿，草稿缺失。机制见组件 7。要点：翻每个 OFF 实体**前**，把该实体当前**命令式路径写的活行**（+ 其事件集）快照留存为独立 golden 参照（flip 门已保证此刻 fold==imperative row，故 golden 可信）。post-flip 任一 reducer/gather 变更（`core/projections/X.ts` 或 `gather.ts` 的该实体分支），对 golden 事件重 fold，与 golden 命令式行 diff——**非重言**（golden 行是命令式路径产出的冻结数据，非 fold 再解读），抓 post-flip reducer 回归。**已 ON 实体（artifact/question_block）的残留**：其数据 genesis-only，golden 与行构造性相等，无法回溯造独立 golden——诚实标注 Q4b 对它们无追溯牙，仅 Q4a + P0-2 覆盖；Q4b 对未来 3 个 OFF 实体全效。

### Q5 — 小缺口打包

**裁决**：打包成一个 housekeeping PR（与 Q2 重构 PR、Q6 PR、Q4 oracle PR 分开）。四项形态（较草稿有实质校正）：
1. **git-track** `docker-compose.mac.yml`（不改内容）。
2. **OFF 实体 prod-warn 测试**：3 个新 `it()`（`assertGoalParity`/`assertMistakeVariantParity`/`assertLearningItemParity` 各一），`vi.stubEnv('NODE_ENV','production')` + 造 fold≠row + 断言 `console.warn` 一次且不 throw（镜像 `parity.ts:70-90`）；放 `parity.db.test.ts`。
3. **回滚演练**：在 question_block 上做一次真实「停机 unset + 启动 + 确认 OFF 路径恢复」，结果记入 runbook（见 §7）。
4. **flip-order 护栏 = WARN，不 boot-throw**（Lens A m3 / Lens B M3 修入，见 §7）。

### Q6 — YUK-547 归属与执行顺序

**裁决**：**C，作为 slice 0**。`gatherAndFoldLearningItem(db, itemId, prefetchedMergeEvents?)` 加可选参数（`gather.ts:273-300`），`audit-projection.ts:393-404` 调用点改循环外一次拉取传入。PR 单独 `Closes YUK-547`。

**攻击修入（Lens B m9）——依赖非「无」**：姊妹 spec（`2026-07-02-kc-dedup-attribution-rewrite-spec.md`，Status 实施中，§2/§7）在 worklist #1（kc-dedup）里也改 `gatherAndFoldLearningItem`（加 Q3 merge scan 分支）。slice 0 的 prefetch threading **rebase 在 worklist #1 landed 的 Q3 scan 之上**——prefetch 优化的是 post-#1 的 scan 形状。依赖表标注：**slice 0 dependency = worklist #1 (kc-dedup) merged**。

### Q7 — fold 确定性验证（critic P2-6）

**裁决**：**B，窄范围，且测试目标校正**（Lens A M6 修入）。两层：
- **(a) 确定性（permutation-invariance）**：`learning_item` + `knowledge` node，同事件集随机排列 N 次重放，断言输出一致。**诚实标注**：此测验证的是「reducer 对输入数组序不敏感（sort 生效）」这一**确定性前提**，**不**验证 canonical `(created_at,id)` tiebreak 的**因果正确性**——后者对 permutation 测试 by-construction 通过。
- **(b) 因果序对抗（learning_item 专项，M6 核心）**：构造 `created_at` 撞毫秒的 complete+relearn 对抗事件集，断言 `foldLearningItem` 结果匹配**命令式到达序（arrival-order）逐事件应用**的独立预期（命令式写者按事件追加时刻顺序 UPDATE，这是唯一有意义的因果 oracle）。**诚实边界**：真正同毫秒同 subject 的两事件，因果序本身歧义，`(created_at,id)` tiebreak 是可辩护的确定性选择；测试钉 fold==arrival-order，不假设存在「更真的因果序」可断言。

不对 artifact/question_block/mistake_variant/goal 做（事件词汇更线性，边际价值低）。**排序上最先跑**（slice 1）——若 (a) 将来失败，此前所有 P0-2 CLEAN 结论只证明「实际历史插入序下无异常」，不能外推 reducer 正确。

---

## 4. 机制设计

### 组件 1 — `ProjectionAdapter` registry（Q2/Q3）

新文件 `src/server/projections/entity-registry.ts`：

```ts
export type ProjectionKind =
  | 'knowledge' | 'knowledge_edge' | 'goal' | 'mistake_variant'
  | 'learning_item' | 'artifact' | 'question_block';

export const ALL_PROJECTION_KINDS: readonly ProjectionKind[] = [ /* 7 kinds */ ];

export interface ProjectionAdapter {
  kind: ProjectionKind;
  /** sot-flag 入口；knowledge/knowledge_edge 共享裸全局 flag → undefined。*/
  flagEntity: import('./sot-flag').ProjectionEntity | undefined;
  /** 活行 id 集。*/
  liveIds(db: DbLike): Promise<Set<string>>;
  /** ghost 检测腿的 id 全集 = event.subject_id ∪（该实体若写 materialized_id_index 则并入其锚点）。*/
  eventSubjectIds(db: DbLike): Promise<Set<string>>;
  /** 复用现成 write-through guarded shell，原样调用。*/
  project(db: DbLike, id: string): Promise<void>;
  /** in-tx anchor 门的批量形（parity.ts 的 XsWithGenesisAnchor），Q4a 适用性门复用。*/
  withGenesisAnchor(db: DbLike, ids: string[]): Promise<Set<string>>;
}

export const PROJECTION_ENTITIES: Record<ProjectionKind, ProjectionAdapter> = { /* 7 条 */ };
```

**id-universe 完备性（Lens A M8 修入，severity 校正）**：逐实体核验「该实体每个 id 是否都能从 `event.subject_id` 覆盖」。gather docstring 已证：**只有 knowledge** 有 propose_new/split 反向-index mint 路径（`gather.ts:104-114` Q2，其 id 不作任何事件 subject_id），故需并入 `materialized_id_index` 锚点（`rebuild-projection.ts:52-59`）；其余 6 实体 gather 均声明「X == subject_id」（无 Q2），`eventSubjectIds` 已覆盖。**修入 = belt-and-suspenders**：凡**写** `materialized_id_index` 的实体（artifact/goal/mistake_variant/learning_item——见各 backfill `upsertMaterializedIdIndex`），`eventSubjectIds` **并入** index 锚点（与 knowledge 对称，near-zero 成本，严格更安全）；question_block 不写 index（backfill 无 index 写）→ 豁免。这不是承认「其余 6 现设计有 live bug」（结构上 gather 已保证），而是对称化防御。

### 组件 2 — `rebuild-projection.ts` / `b3-gate.ts` 参数化（Q2）

`rebuild-projection.ts`：`allIds(db, adapter) = liveIds ∪ eventSubjectIds`；`rebuildProjection(db, kind)` 循环 `allIds` 调 `adapter.project`；`RebuildCounts` 扩为 `Record<ProjectionKind, number>`（m10：同步 printReport/JSON/测试）。CLI 对全部 7 kind **per-kind tx**（仅 FK 强制处配对，见 Q2）。

`b3-gate.ts` 的 `runB3Gate(db, kind, allowlist, now)` 参数化：步骤 1/5 用 `adapter.liveIds`；步骤 3 调组件 3 的 `auditProjectionKind(db, kind, allowlist)`（非整个 `auditProjection()`）。**FK 图核验是本组件前置**（m7）。

### 组件 3 — `audit-projection.ts` 按 kind 拆分（纯提取，Q2/Q4a）

把现有 `audit-projection.ts:315-455` 的 7 个 inline 循环逐个提取成 `auditProjectionKind(db, kind, allowlist)`，内容逐字节一致（纯剪切 + 参数化 allowlist）；`auditProjection(db, allowlist)` 保留导出签名、改为循环调用合并（现有调用方/测试零改动）。

### 组件 4 — 只读 rowset 对称审计（P0-2 产品化，Q4a）

新函数 `auditProjectionKindSymmetric(db, kind, allowlist)` → `{id, verdict: 'CLEAN'|'GHOST'|'MISSING'|'FIELD_DRIFT', diffs}[]`。id 全集 = `adapter.liveIds ∪ adapter.eventSubjectIds`；对全集每个 id 跑 `gatherAndFoldX` + 映射活行 → `diffSnapshots`。**必须**：(a) 复用 `adapter.withGenesisAnchor` 跳 un-anchored 行（M3）；(b) 调用方在单 `REPEATABLE READ` tx 内（M4）。

### 组件 5 — Q4a 持续 sweep job

新文件 `src/capabilities/knowledge/jobs/projection_oracle_sweep.ts`（宿主理由：knowledge capability 已是 `merge_attribution_sweep` 这类跨实体基础设施 job 的宿主；`src/server/projections/` 是 server-shared 不属任何单一 capability）。

```ts
export async function runProjectionOracleSweep(db: Db, allowlist: ProjectionAllowlist): Promise<ProjectionOracleReport> {
  // 单 REPEATABLE READ 事务包裹整个 sweep（M4/B-M5）。
  return db.transaction(async (tx) => {
    // 依 git-tracked flag 清单判 ON（B-m8），非 worker 本地 projectionIsWriter()。
    for (const kind of ALL_PROJECTION_KINDS) {
      if (!isTrackedWriter(kind)) continue;
      const valueDrift = await auditProjectionKind(tx, kind, allowlist);       // 组件 3（跳 un-anchored）
      const symmetric  = await auditProjectionKindSymmetric(tx, kind, allowlist); // 组件 4
      // 非 CLEAN → 结构化日志 [projection-parity] + 可选 fold-inert forensic（B-m6：one-per-id）。
      // 绝不写实体表本身任何一行。
    }
  }, { isolationLevel: 'repeatable read' });
}
```

注册 `manifest.ts`（紧邻 merge_attribution_sweep）：`schedule: { cron: '30 4 * * 1', tz: 'Asia/Shanghai' }`，queue **`'llm'`**（B-M4）。report-only，从不 throw 非「DB 不可达」外的错误。

### 组件 6 — flip-order 运维护栏 = WARN（Q5，Lens B M3 修入）

**不 boot-throw**（草稿的 `throw` 会在 artifact 单独回滚而 learning_item 仍 ON 时 brick 整个 app+worker——回滚死锁，且与 `sot-flag.ts:37`「Each entity flips independently」矛盾）。改为：

```ts
// src/server/projections/sot-flag.ts — 启动期调用，只 WARN，永不 throw。
export function warnFlipOrder(): void {
  if (projectionIsWriter('learning_item') && !projectionIsWriter('artifact')) {
    console.warn('[sot-flag] learning_item ON while artifact OFF — runbook §2 顺序依赖（W3 retract 耦合）。' +
      '若为 artifact 紧急回滚，先回滚 learning_item（见 runbook 反向回滚序）。');
  }
  // 跨进程一致性 WARN（B-M1 廉价腿，非共享表）：启动期打印本进程 flag 向量，供 owner 目视两进程一致。
  console.info('[sot-flag] flag vector at boot:', trackedFlagVector());
}
```

**前置硬校验放 CLI/runbook**（非 boot）：翻 learning_item 前，人工确认 artifact ON（Q3 checklist）。**且**：本终稿要求 executor **先 code-ground `learning_item` retract-path 对 artifact-fold 的真实耦合**（runbook line 28 只是 cutover 建议，未 ground 具体函数）——若耦合是单向/双向/已在 retract 路径处理，据实定护栏强度；未 ground 前只保留 WARN。

### 组件 7 — Q4b retained-golden 独立 oracle（register line 673，NEW）

**捕获（翻转前，per OFF 实体）**：新脚本 `scripts/capture-golden.ts --kind=<X>`。对 prod-clone（flip 门已跑、fold==imperative row 已验），把该实体所有**命令式活行**（`adapter.liveIds` → 全字段行）+ 其**事件集**（`gatherAndFoldX` 的 gather 输入 superset）冻结为 `scripts/golden/<kind>-<flip-date>.json`（committed，evidence-first 可追溯）。golden 行是命令式路径历史产出，与 fold 独立。

**重审（reducer/gather 变更触发）**：新脚本 `scripts/golden-reaudit.ts --kind=<X>`：对 golden 事件集重跑当前 `gatherAndFoldX` + `foldX`，与 golden 命令式行 `diffSnapshots`。任何 diff = post-flip reducer 回归 → 非零 exit + 报 drifted id。触发方式 = 一个 `audit:golden` npm script，纳入「touched `src/core/projections/**` 或 `src/server/projections/gather.ts` 且该实体已 ON」时的 pre-PR 人工 checklist（register 用词「reducer-code-hash-triggered」——本单元落地为 path-触发的 checklist 项，不建 hash 基建，n=1 足够；hash 自动化留 owner 未来可选）。

**边界（Lens A M2/M1 诚实标注）**：Q4b 对 artifact/question_block（已 ON、genesis-only、golden 构造性等于行）**无追溯牙**；对未来 goal/mistake_variant/learning_item **全效，且 learning_item flip 前硬性**（register）。

---

## 5. 实施切片（PR 粒度，file/function 级）

| Slice | 内容 | 依赖 | Linear |
|---|---|---|---|
| **0** | YUK-547：`gatherAndFoldLearningItem` 加 `prefetchedMergeEvents?`（`gather.ts:273-300`）+ `audit-projection.ts:393-404` 调用点循环外一次拉取 | **worklist #1 (kc-dedup) merged**（m9） | `Closes YUK-547` |
| **1** | Q7：(a) learning_item + knowledge node permutation-invariance 测试（标注为确定性非因果）；(b) learning_item 同毫秒 complete/relearn 因果对抗测试（断言 fold==arrival-order） | 无（建议最先跑） | `Refs YUK-538` |
| **2** | Q2：`entity-registry.ts`（含 M8 id-universe 并 index 锚点 + `withGenesisAnchor`）+ `rebuild-projection.ts`/`b3-gate.ts` 参数化（per-kind tx，FK 图先核验，m7）+ `audit-projection.ts` 按 kind 拆分 + `RebuildCounts` 扩形同步 printReport/JSON/测试（m10）+ **每实体 NO-GO 腿测试**（种 value-drift→audit DRIFT；种 backfill 后被 rebuild 删的行→survival deleted≠0；种 index-anchored/event-only ghost→survival created≠0，M7/M2）+ **过包含 scoping NO-GO 测试**（M5）+ 用泛化工具对 artifact/qb 复现 P0-2 CLEAN（smoke，非捕获证据，M7） | Slice 0 | `Refs YUK-538` |
| **3** | Q4a：`auditProjectionKindSymmetric`（组件 4，含 anchor 门 M3）+ `projection_oracle_sweep` job（组件 5：REPEATABLE READ M4/B-M5、queue `'llm'` B-M4、fold-inert forensic B-m6、tracked-flag 判 ON B-m8）+ manifest 注册 | Slice 2 | `Refs YUK-538` |
| **4** | Q4b：`scripts/capture-golden.ts` + `scripts/golden-reaudit.ts` + `audit:golden` script + pre-PR checklist 文档（组件 7，register line 673） | Slice 2 | `Refs YUK-538` |
| **5** | Q5 housekeeping：git-track compose + 3 prod-warn 测试 + `warnFlipOrder`（组件 6，WARN 非 throw）+ 回滚 runbook 更新（§7：停机翻转、回滚≠修复、反向回滚序、跨进程 WARN）+ question_block 停机回滚演练记录 | 无（可与 2/3/4 并行） | `Refs YUK-538` |
| **6**（gated，非本次交付） | 逐一对 goal/mistake_variant/learning_item：Q3 checklist 全过 + b3-gate GO on clone + **Q4b golden 已捕获**（learning_item 硬性）+ 停机翻转 | Slice 0-5 全 | 逐实体单独 issue，`Closes` 各自 |

Slice 6 明确**非本次交付**——本 spec 交付「翻转的 oracle 机制」，不交付「实际翻转」（红线：数据门只 gate 翻转不 gate build）。

---

## 6. 测试与 gate

- **Slice 0**：`gather.db.test.ts` prefetch 等价性（传/不传 fold 输出一致）+ 性能烟雾（mock 全表 SELECT 计数=1 而非 N）。
- **Slice 1**：两个纯 fold 测试（`src/core/projections/learning_item.test.ts`、`knowledge.test.ts`）+ learning_item 同毫秒对抗 `it`（断因果 arrival-order）。
- **Slice 2**：`b3-gate.db.test.ts` 现有 knowledge/knowledge_edge GO/NO-GO 全分支原样通过（behavior-preserving 回归锚，范围=verdict，m10）；**每个新实体（goal/mistake_variant/learning_item/artifact/question_block）三条 NO-GO 腿测试**（drift/deleted/ghost）+ 过包含 scoping NO-GO 测试；`rebuild-projection.db.test.ts` 同扩。**禁**用「复现 CLEAN」替代 NO-GO 腿（M7）。
- **Slice 3**：`projection_oracle_sweep.db.test.ts`（镜像 `merge_attribution_sweep.db.test.ts`）：CLEAN→零日志/零 forensic；种 GHOST/MISSING/FIELD_DRIFT→分类正确 + **断实体表本身零写入**（唯一写=日志/inert sink）；**种 un-anchored 活行→断跳过不报假阳**（M3）；并发写下 REPEATABLE READ 稳定性（M4）。
- **Slice 4**：`golden-reaudit` 测试：golden 事件重 fold==golden 行→CLEAN；篡改 reducer 分支→golden-reaudit 报 drift（证非重言）。
- **Slice 5**：`parity.db.test.ts` 3 个 `NODE_ENV=production` warn-not-throw；`sot-flag.unit.test.ts` `warnFlipOrder` 不 throw 断言（both ON/both OFF/only-learning_item-ON→warn/only-artifact-ON→无 warn）。
- **全量 gate**：`pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm audit:draft-status && pnpm audit:relations && pnpm test && pnpm build`。本单元不新增迁移/schema。

---

## 7. 回滚与运维 runbook

- **翻转 = 停机翻转，禁 rolling（Lens B M1）**：flag 在 worker 与 API 两进程各自读 `process.env`（§1）。翻转/回滚必须 **`docker compose down` → 改 env → `up`**（或至少确保两容器同批重建、无请求/job 在飞），**不做** rolling `up -d` 单容器重建——否则 app-ON/worker-OFF 偏斜窗口内同一行被两写者竞写、且 parity assert 在 ON 侧被跳。n=1 owner 在静默时段执行，停机成本可忽略。启动期 `warnFlipOrder` 打印两进程 flag 向量供目视一致（廉价腿，非共享表）。
- **回滚 ≠ 数据修复（Lens B M2，诚实记录）**：回滚 = unset flag + 停机重建，命令式写者**从此刻起**恢复为行写者（`sot-flag.ts:3-5`：imperative writer 从未消失，ON 期只是没被调用）。但 ON 窗口内 fold 写的行**保持原样**——回滚不重写它们。**采纳 lane (a)**：ON 窗口 fold-written 行**按定义即权威**，回滚只是**写路径回退**，不声称「restores full verification」。**无 events→imperative 的独立重建工具**（唯一 rebuild 走同一 fold reducer，`rebuild-projection.ts:80-90`）——这是被 Q1 拒绝的 N-version 独立写路径的对偶，**接受为残留**。若 ON 窗口检出 fold bug 导致的行损坏：回滚止血（停未来 fold 写）+ 该实体 Q4b golden-reaudit 定位 + 人工逐行修（evidence-first，非自动）。compose 注释「the double-write never stopped… zero data loss」**校正**：ON 期是**单**（fold）写非双写，且「zero data loss」仅对**删除**成立，不对**值漂移**成立。
- **反向回滚序（Lens B M3）**：learning_item ON 后若需**单独**回滚 artifact，先回滚 learning_item（顺序依赖：W3 retract 耦合，runbook §2 line 28）。`warnFlipOrder` 只 WARN 不 brick，不阻断 boot。**任何硬护栏前须先 code-ground 真实耦合函数**（组件 6）。runbook §4「不要一次翻全部」纪律保留。
- **Q5 演练**：本 spec 落地后对 question_block（风险最低）做一次真实停机 unset + 重建 + 确认 OFF 路径恢复，结果记入本 runbook，把 dossier 缺口 7（回滚只有文档承诺）实证清零。
- **oracle 运维预期**：Q4a weekly report-only，owner 每周过日志；非 CLEAN 唯一自动动作 = 写日志/inert forensic（Q4a-4），无任何实体表写、无告警外自动化。Q4b 按 reducer/gather 变更触发（pre-PR checklist），非 cron。

---

## 8. 开放问题（owner 级）

1. Q4a job 宿主 capability（暂 knowledge，bikeshed）。
2. Slice 6 实际翻转排期（Q3 人工判断项 + Q4b golden 捕获完成度）。
3. Common-mode 残留：Q4b 关 post-flip reducer 回归子类；flip-当刻同错子类由 flip 门拦；是否再投「真正独立黄金数据集」由 owner 定（本 spec 认为 n=1 下 Q4b 已足）。
4. Q4b 触发从「path-触发 checklist」升级为「reducer-hash 自动化」是否值得（register 原词是 hash 触发；本单元落 checklist，hash 留可选）。
5. 跨进程 flag 一致性从「启动 WARN」升级为「共享表指纹」是否值得（本 spec 判 n=1 停机翻转已足，REJECT 重型 guard）。

---

## 附录 — Attack 裁决 Ledger

> 全部 file:line 已对 HEAD `bb5e115f` 重接地。REJECT/PARTIAL 也留档。

### Lens A（oracle 有效性轴）

| # | 裁决 | 理由 + 接地 |
|---|---|---|
| **§0 重言边界表** | **ACCEPT（升为终稿 §0）** | `gather.ts:6-12` 单一 gather、`b3-gate.ts:27-30` tautological 均 re-ground 确认。持续 oracle 值级腿对已 ON 实体只抓 out-of-band 写，reducer/gather/排序三类结构失明。 |
| **M1** Q4=被否决的重言 cron 换皮，未交付 register 独立腿 | **ACCEPT（最大修入）** | register line 673 verbatim「reducer-code-hash-triggered re-audit against a retained prod-clone imperative rebuild… Must land before flipping learning_item」re-ground 确认。新增 **Q4b（组件 7）**交付 (a) 选项；Q4a 价值命题诚实改写为 out-of-band 探测器。Q1 拒运行时 shadow-write 与交付 (a) 离线 golden **不矛盾**。 |
| **M2** P0-2 CLEAN by-construction，mutation-reducer prod 零覆盖 | **ACCEPT** | `learning_item.ts:152-172` genesis 恒等；`gather.ts:346-375` qb 只消费 genesis/create/edit（auto_enroll/proposal 不消费）确认。§1 收窄 P0-2 结论；slice 2 NO-GO 腿必用带 mutation 事件种子。 |
| **M3** 持续 oracle 未 gate hasXGenesisAnchor→live 假阳 | **ACCEPT** | `audit-projection.ts:310-313` 无 anchor 门；`parity.ts:653,660,729-734` in-tx 有门 + 「pre-event-sourced row folds to null and would FALSE-mismatch」确认。Q4a-1 + 组件 4 复用 `withGenesisAnchor`。 |
| **M4** 无单快照读一致性→live 假阴/阳 | **ACCEPT** | 与 Lens B M5 同。组件 5 REPEATABLE READ 单 tx。 |
| **M5** genesis-backfill 过包含静默熄牙，草稿豁免逐实体重验 scoping | **ACCEPT** | `b3-gate.ts:31-34` scoped 依赖 + `LEARNING_ITEM_ANCHOR_ACTIONS=['experimental:genesis']`（parity.ts:653）确认。Q3 撤销豁免 + slice 2 过包含 NO-GO 测试。 |
| **M6** Q7 测「sort 是否调用」非因果序，测试重言 | **ACCEPT（精化）** | `learning_item.ts:133` sort、`:197/:229` complete/relearn 状态门确认同毫秒终态分叉。Q7 拆 (a) 确定性 +（b）同毫秒因果对抗（断 arrival-order）。**PARTIAL 校正**：同毫秒同 subject 因果序本歧义，不假设存在可断言的「更真因果序」。 |
| **M7** 泛化只测「工具能跑」不测「能抓」，复现 CLEAN 是重言 smoke | **ACCEPT** | slice 2 强制每实体三条 NO-GO 腿；复现 P0-2 CLEAN 降级为 smoke，非捕获证据。 |
| **M8** ghost 触角全靠 eventSubjectIds，6/7 实体只断言未核验 | **ACCEPT（severity 校正为 PARTIAL）** | `gather.ts:104-114` 仅 knowledge 有 Q2 反向-index mint；其余 6 gather 均「X==subject_id」，`eventSubjectIds` 结构上已覆盖——非 live bug。修入=对称化防御：写 index 的实体并入 index 锚点，qb 豁免。 |
| **m1** Rule-of-Three 对重言检查不适用 | **ACCEPT** | doc 明写持续 oracle CLEAN 携带零 reducer-正确性置信（非独立）。 |
| **m2** forensic event 回灌自污 | **ACCEPT（并入 Q4a-4）** | 主证据=结构化日志（不可自污）；forensic 用无 gather 消费的 subject_kind + one-per-id。 |
| **m3** flip-order guard 是代理量 | **ACCEPT（并入组件 6）** | 降为 WARN + 标注「已知顺序依赖的最小代理」+ 要求 code-ground 真实耦合。 |
| **m4** 值级腿 pre-flip 有牙/post-flip 无牙，同码语境依赖 | **ACCEPT** | §0 表 + Q4a 定性显式区分。 |
| **m5** 「post-flip tautological」前提与 Q4 选 A 内部矛盾 | **ACCEPT** | §0 表消解；Q4 拆 Q4a（诚实）+ Q4b（独立）。 |

### Lens B（运维/回滚/顺序轴）

| # | 裁决 | 理由 + 接地 |
|---|---|---|
| **M1** 非原子跨进程 flip = split-brain，草稿 guard 打错轴 | **ACCEPT（runbook 停机翻转）+ PARTIAL REJECT（共享表 guard）** | grep 确认 flag 在 worker（`variant_gen.ts:257`/`variant_verify.ts:305`）+ API（`actions.ts:997/1227/1365`、`goal-create.ts:130`、`proposal-appliers.ts:437,580`）各读 env。§7 强制**停机翻转**（down→up）完全闭窗；**REJECT** 重型跨进程指纹共享表（n=1 停机已足，过度工程），保留启动期 loud-WARN 比对（组件 6）。 |
| **M2** 回滚 forward-only，无命令式重建路径 | **ACCEPT** | `sot-flag.ts:3-5` + `rebuild-projection.ts:80-90`（唯一 rebuild 走同 fold）确认。§7 采纳 lane (a)：ON 窗口 fold 行按定义权威，回滚=写路径回退；无 events→imperative 独立工具，接受为残留；校正 compose「zero data loss」仅对删除成立。 |
| **M3** assertFlipOrder boot-throw = 回滚死锁，与独立翻转设计矛盾 | **ACCEPT** | runbook line 28「learning_item flip after artifact… W3 retract path couples」是 cutover 建议非 runtime 不变量；compose:17,22 artifact ON 确认。组件 6 改 WARN 非 throw + 反向回滚序 + 要求先 code-ground 真实耦合。 |
| **M4** oracle queue 'fast' 违背 sibling 'llm' | **ACCEPT** | `manifest.ts:145-148`(kc_dedup)、`164-166`(merge sweep) verbatim「'fast' would skip the DLQ… a repair write deserves DLQ retry coverage」+ `queue-config.ts:29-32` 确认。Q4a-3 改 `'llm'`。 |
| **M5** live 读无快照隔离→读偏 skew 假 drift | **ACCEPT（同 A-M4）** | 组件 5 单 REPEATABLE READ tx；非快照读判定 inadmissible。 |
| **m6** forensic 写进被审 log，inert 仅 knowledge 证明，无界重发 | **ACCEPT（并入 Q4a-4）** | `merge_attribution_sweep.ts` inert 仅对 knowledge fold。改 fold-inert sink + one-per-id。 |
| **m7** all-7 单 tx 靠未验「其余 5 无 FK」，放大爆炸半径 | **ACCEPT** | Q2 改 per-kind tx（仅 FK 强制处配对）+ FK 图核验前置；与 `runB3Gate(db,kind)` per-kind 形一致。 |
| **m8** worker-hosted oracle gate 在 worker 本地 flag，混态审错 writer-set | **ACCEPT（并入 Q4a-5）** | sweep 依 git-tracked flag 清单判 ON，非本进程读。 |
| **m9** slice 0 与 worklist #1 PR 同改 gatherAndFoldLearningItem，草稿标「无依赖」 | **ACCEPT** | 姊妹 spec §2/§7 确认同函数 Q3 clause。Q6 依赖表改「worklist #1 merged」，prefetch rebase 其上。 |
| **m10** RebuildCounts shape 变更 vs「behavior-preserving」 | **ACCEPT** | `rebuild-projection.ts:45-48` + `b3-gate.ts:206-209,266` 确认。Q2 扩形同步 printReport/JSON/测试，「behavior-preserving」收窄为 verdict。 |

**Ledger 一句话**：两轴 MAJOR 全部修入（Lens A 8/8、Lens B 5/5），其中 2 条 PARTIAL 校正（A-M8 severity：非 live bug 而是对称化防御；B-M1：ACCEPT 停机翻转、REJECT 重型共享表 guard）；A-M6 精化为「测确定性≠测因果，同毫秒因果本歧义」。全部 minor 修入。草稿方向（泛化 b3-gate、report-only、绝不自动修）正确并保留；核心修入 = 交付 register line 673 点名的 **Q4b retained-golden 独立 oracle**（草稿用重言 cron 顶替了它），并补齐运维包络（停机翻转、回滚≠修复、WARN 非 boot-throw、queue 'llm'、快照隔离）。

---

## 独立 review 轮裁决（2026-07-03，实现后 8 finder → 4 Opus verifier）

> 实现落地（slices 0-5）后的独立 review 环收敛：9 CONFIRMED 已修入实现（K1 edge 锚 action 过滤 MAJOR + K2/K4/K7/K9/K11/K12/K14/K15 minor），3 归 follow-up（K6 knowledge gather prefetch / K8 propose+generate 安全砍除 / K10+K13 registry dispatch 字段化，Linear 另立）。以下 4 条 **REFUTED** 留档为 doctrine——后续迭代别再翻案：

| # | 主张 | 裁决 | 理由 |
|---|---|---|---|
| **K3** golden-reaudit 的 dateReviver 全树 revive 太宽，应按键收窄 | **REFUTED** | 对称 revive（rows + events 同一 reviver）+ snapshot-diff 的 normalize（Date→getTime、严格 ISO→epoch）已闭合 Date/string 缝。按键收窄反而是回归风险：漏掉一个嵌套日期键会破 fold 的 `.getTime()` 调用。全树 + 严格 ISO 正则是正确取舍。 |
| **K5** oracle sweep 单 REPEATABLE READ tx 包全 kind 太重，应 per-kind tx | **REFUTED** | spec M4 的语义要求是 per-kind 的行读/事件读同快照——单 tx 是其超集，天然满足。拆分不减少任何 fold 工作量；n=1 周跑一次的 tx 时长对 autovacuum 的影响可忽略。保留单 tx（实现更简、跨 kind 时点一致还是免费加成）。 |
| **K16** warnFlipOrder 只硬编码 learning_item→artifact 单对，应泛化成依赖表 | **REFUTED** | Ledger m3 逐字裁决就是「已知顺序依赖的**最小代理**」，且该对已 code-ground 到唯一真实耦合（actions.ts:1308-1325 retract 归档配对 artifact）。当前代码库不存在第二条跨实体 flip 依赖；预建泛化依赖表是给不存在的耦合造基建——as-designed。 |
| **K8**（方向部分）capture-golden 的 CROSS_REF_ACTIONS 应按实体收窄 | **REFUTED（方向）** | 按实体收窄 rate/correct 是危险的 under-scope：rate 的 subject 是 proposal（subject_kind='event'），链在 caused_by_event_id 上——收窄等于在 capture 侧重造各 gather 的谓词，恰是 CROSS_REF_ACTIONS 注释刻意避免的脆弱面。纯 reducer 按 id+action 过滤，宽超集只是字节成本。（**安全**的 propose/generate 砍除作为 follow-up 单独评估，不在本 PR。） |
