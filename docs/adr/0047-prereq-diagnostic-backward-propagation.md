# ADR-0047 — prereq 边诊断「向后传播」（inc-E，dark-ship producer）

**Status**: Proposed (2026-06-27) — DRAFT, 待 owner ratify（勿自行 ratify）
**Part of**: YUK-455 ·「冷启 day-one MVP」epic（YUK-452）§6 Q5 / 设计 doc §5 inc-E。
**Decision source**: YUK-452 §6 Q5（owner：先诊断向后传播，缓选题 gating，留 issue）+ YUK-455「🛠 实施讨论 · grounded 2026-06-27」comment（对照当前 main 核对）。
**Related**: ADR-0035（B1 mastery_state / 三轴正交红线）· ADR-0040（决定2「先埋点 N 周再定阈」范式）· ADR-0010（relation_type 核心集合）· ADR-0005（event single-owner writeEvent）· ADR-0037 #4 / YUK-349 B3（learnable_frontier，本 ADR 的 prereq 闭包同方向先例）· YUK-357 / RT4（audit:relations 死边审计）。

> ⚠️ 编号 0047 是本 lane 推测——并行 lane 可能撞号。合并时若与已 ship ADR 撞，按时序重编号。

---

## 背景

KG 的 `knowledge_edge(relation_type='prerequisite')` 一直存在（owner / AI 供给），但它的「surmise relation」诊断语义（答错某 KC ⇒ 其前置可能也没掌握）从未被任何下游学习路径消费——它对诊断/选题/复习是死语义（图在转但不影响学习，正是 YUK-357 死边审计要剪的形态；当前唯一仍死的核心 type 是 `applied_in`）。

inc-E 把 prereq 边接成 surmise relation 的**诊断向后半**：学习者答错 KC B → 沿 prereq 边向上找 B 的（transitive）前置 A → 上调 A 的掌握风险，喂学习者画像。

## 决定

### 1. 只做「诊断向后传播」producer；选题 gating 缓做（owner §6 Q5 锁定）

- **先行**：诊断向后传播——答错 B ⇒ 给 B 的 transitive 前置 A 算一个**掌握风险增量** `risk_delta`，作为独立观测投影喂画像。
- **缓做**：选题 gating（A 未掌握 ⇒ 降权/锁依赖 A 的 KC 选题）。它改 **live 练习流**（target-discovery / 选题 / p(L)），需重验，单拎后议——本增量**不碰**。

### 2. 承载形态 = 通用 event outbox（零新表）

`experimental:prereq_risk` 事件（`subject_kind='knowledge'`，`subject_id=前置 A`，`caused_by=触发的 attempt event`），经 ADR-0005 single-owner `writeEvent` 写入通用 `event` 表。**不建新表**——这是最干净的 dark-ship：避开 5 面登记（schema / migration / audit:schema / export FK_ORDER+SCHEMA_VERSION / db.ts ALL_TABLES）+ 写者纪律。`experimental:prereq_risk` 非 reserved action ⇒ 走通用 `ExperimentalEvent` schema（payload 松守 record），无需 schema 注册。

> 备选（owner 拍）：物化进 `kc_typed_state`（画像可直读，但触登记 + 写者纪律）。建议先 outbox，N 周后据用量定。

### 3. dark-ship flag + flag-off byte-identical（触 live 引擎的硬约束）

`PREREQ_PROPAGATION_ENABLED`（module const, 默认 `false`，镜像 `SRT_ENABLED` / `THETA_GRID_ENABLED`）。dark 保证**完全住两个 call site**（`submit.ts` / `paper-submit.ts`），gate 在 `PREREQ_PROPAGATION_ENABLED && outcome==='failure'`——flag-off 时 `&&` 短路、emit 永不调用 ⇒ event set 与 inc-E 之前 **byte-identical**（回归锚 in `submit.db.test.ts`）。

**DARK-SHIP CONTRACT**：`emitPrereqRiskSignal` / `loadPrereqClosure` 故意**不**在函数内查 flag——producer 机制可被 unit/db 测独立验证（defer-flip readiness：dark-ship 必须已接线 + 可证，不能 dark-AND-broken）。新增 call site 必须同样 gate，否则破坏 byte-identical。

### 4. n=1 admissibility + 三轴正交红线

- **litmus ✓**：信号 = 单学习者 B 的自作答 outcome（failure）+ KG 拓扑（owner 供给的 prereq 边）+ owner 固定传播权重/衰减常数。无 a/slip/guess/φ/discrimination 等跨被试方差参数。
- **红线（ADR-0035）**：向后风险**绝不**折进 `mastery_state.theta_hat / fail_count`——前置 A 从未被作答，写「假 fail」会用非证据污染 Elo 充分统计量、破坏三轴正交。风险是**独立 event 投影**，不经此路径回流 θ̂/p(L)/选题/FSRS。

### 5. 传播权重/衰减 = threshold_deferred（n=1 magic number）

`risk_delta = base_weight · decay^(depth−1)`（depth 1 = 直接前置）。`base_weight`/`decay` 是 owner 固定先验常数，但精确取值留待从 emit 出来的 `risk_delta` 分布 N 周后选定（同 ADR-0040 决定2「先埋点再定阈」）。每条事件带 `threshold_deferred:true`，埋点期不 gate 任何 live 行为。

### 6. audit:relations 登记

`CONSUMER_REGISTRY` 补两条 `prerequisite` specialized 条目（各带 file:marker 反查）：(a) 本 producer（`prereq-propagation.ts`，surface=diagnosis）；(b) 顺手补 PR #635 遗漏的 `learnable-frontier.ts`（surface=recommendation）。注：`prerequisite` 此前**已有** 2 条 specialized 消费（topology-gate + hub-mesh），早已非死边——issue body §约束「prereq 接 specialized consumer 正好补一条 / 升 specialized」措辞 STALE；真正的死边仍是 `applied_in`（本增量不碰）。

## 验收

诊断向后传播 dark-ship；flag-off byte-identical（`submit.db.test.ts` 锚）；producer 机制 unit + db 测可证（defer-flip readiness）；`audit:relations --strict` 绿（新 specialized 条目反查命中、无 STALE，`applied_in` 仍唯一死边）；不锁选题（本增量）。

## 实现

- PURE：`src/core/prereq-risk.ts`（`prereqRiskFromAttempt` + 常数 + 类型，无 IO）。
- IO + EMIT：`src/server/mastery/prereq-propagation.ts`（flag + `loadPrereqClosure` 向上 prereq 闭包 SQL + `emitPrereqRiskSignal`）。
- Call site：`submit.ts` / `paper-submit.ts`，gated，紧挨 `emitMasteryProgressSignal`，post-commit / best-effort。
- 测试：`src/core/prereq-risk.test.ts`（unit）+ `src/server/mastery/prereq-propagation.db.test.ts`（db）+ `submit.db.test.ts` byte-identical 锚。

## Open questions（owner 拍）

1. 承载形态：event outbox（已选）vs 物化 `kc_typed_state`？
2. `base_weight` / `decay` 取值 + 是否随 depth 衰减——N 周埋点后定。
3. 画像 surface 读这些事件是否拆独立 follow-up（建议同 epic 增量 PR 用 Refs，避免 scope 碎片化）。
4. 选题 gating（缓做半）何时排期。
