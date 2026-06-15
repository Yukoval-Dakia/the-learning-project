# W2 选题引擎实施 lane plan

> **⚠️ 从属说明（2026-06-15）**：本文是 `sel-engine-w2-mapspec` 工作流的 map/spec 产物。**权威实施计划已升级为** `docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md`（YUK-361，观测先行 8 阶段），编排分工以 **ADR-0042 编排档2 amendment**（LLM 出权重 → sampler → π_i）为准——本文「L2 LLM 编排 = what/mix/reason」的 framing 已被档2 精化（LLM 直接出 per-candidate 权重）。**本文保留作 14 blocker 的具体实施细节 appendix**（frontier CTE depth/MFI 归一化/signals 列 schema/fallback 阈值等仍有效参考），不作独立权威计划，避免与 roadmap 漂移。

**状态**：design-locked（细节 appendix，从属于 YUK-361 roadmap），待 owner 拍 Linear 子票后进 wave。
**Grounding 基线**：ADR-0042（Accepted）+ design doc rev2 §1/§2/§3/§5/§6 + 三份只读 grounding（STREAM 现状 / L1 信号可用性 / 14 blocker 裁决）+ 代码现状核对（2026-06-15）。

## 0. 现状一句话（lane 的起点）

当前 `composeDailyStream`（`src/capabilities/practice/server/stream-composer.ts:56`）是**单层、确定性、纯规则 R1-R7 混排的 lazy compose**：零 IO 纯函数把 `collectComposerInputs`（`stream-store.ts:49`）预收集的 4 源（decay/variant/new_check/paper）拼成线性 plan，**无信号打分、无 LLM 编排、无 post-filter**，只在 `GET /api/practice/stream?date=today` 当天流为空时同步触发。`practice_stream_item`（`schema.ts:926`）的 `source`/`added_by` 是封闭 enum、**无 `signals` 列**、`composer_nightly` 枚举值已预留但**无写入方**。本 plan 把它重构成 **L1 确定性信号 → L2 LLM 编排 → L3 确定性 post-filter 三明治 + hybrid runtime（nightly 预产 + 作答后增量重排）**。

## 1. 14 blocker 最终裁决表（吸收 grounding 建议）

「已拍」= owner 已在 ADR-0042 / design doc 定，照搬落地；「待 owner」= 需 owner 在建票前确认的实施抉择。

| # | blocker | 裁决 | 状态 | lane |
|---|---|---|---|---|
| 4 | L1→L2 数据契约 schema | 定义 `SelectionCandidate` Zod（`src/core/schema/selection-candidate.ts`，cross-subject 故归 core）。per-candidate：`{ questionId, knowledgeIds[], source:'due'\|'frontier'\|'consolidation', dueAt?, mfiScore:number\|null, mfiBucket:'high'\|'mid'\|'low'\|null, masteryPoint:number\|null, evidenceCount, frontierDepth?, isPlaceholder, variantFamily?, inclusionProb:number\|null }`；global：`{ date, dueOrderLocked:questionId[], capacity, masteryCalibrated }`。B1 前缺信号 → `mfiScore=null`+`isPlaceholder=true`，mix 由 `evidenceCount` 驱动（§5.6）。**硬前置**。 | 已拍（结构） | L1 |
| 12 | frontier CTE cycle guard | `WITH RECURSIVE` 沿 `knowledge_edge WHERE relation_type='prerequisite'`，累积 `path text[]`，递归条件 `AND NOT (next = ANY(path)) AND array_length(path,1) < MAX_DEPTH`（=8）。cycle 命中停该分支不抛错（脏边是数据问题 §6.12）。frontier = 「所有前置 KC mastered 但自身未 mastered」边界 KC，外层 `LIMIT FRONTIER_LIMIT`（=20）。复用 `knowledge_edge`，零新基建。**硬前置**。 | 已拍 | L1 |
| 14 | MFI score 归一化 + f 形式 | f = Fisher 信息 `I(θ̂)=P(1−P)`，`P=σ(θ̂−b)`（1PL，§2），峰 0.25@θ̂=b。归一 `mfi_norm=I/0.25∈[0,1]`。与 due 紧迫度**不相加**——due 是 L1 hard constraint 保序、不参与 MFI 加权；MFI 只在非到期候选池内排序（§14 / gap A2）。喂 LLM 用分桶 high≥0.66/mid 0.33-0.66/low<0.33（§5.4）；原始 `mfi_score` 进 signals 列供观测。多 KC 题取 `θ̂_min`（§2，与未来 mastery VIEW 聚合一致性须文档化）。 | 已拍 | L1 |
| 6 | 观测面 signals 列 | `practice_stream_item` 加 `signals jsonb`：`{ mfi_score, mfi_bucket, due_urgency, frontier_depth, cap_hit_reason, mastery_at_compose, is_placeholder, inclusion_prob }`。`source` enum 扩 `'frontier'\|'consolidation'\|'due_override'\|'recall_override'\|'llm_filled'`（现 6 值）。配套两个 observability query（capitalization 跨天检测 + cap 触发率）。需 migration + `audit:schema` write path。 | 已拍（结构） | schema + L3 + obs |
| 5 | L2→L3 格式坏 vs 内容坏分 | 格式坏（JSON parse/schema fail/非数组）→ **整流 fallback** 到退化 `composeDailyStream`（§1，保 frontier 非纯 due）。内容坏 → **per-item repair**：①幻觉 id（候选池外）剔除；②越界 due（池外到期）走 H8 补回；③配比超 cap → L3 裁超项标 `llm_filled`/裁剪。语义违规 item 数 > `SEMANTIC_VIOLATION_THRESHOLD`（候选数×30%）→ 升级整流 fallback。 | 已拍 | L3 |
| 8 | 三层测试策略 | L1（MFI/frontier CTE/到期保序）+ L3（invariant 全集）= **确定性单测**，每条 §1.1 invariant 一断言。L2 = **golden E2E**（固定候选 → 快照输出形态，钉数量/source 分布/invariant 而非具体 id）+ L3 兜底。L2 编排「质量」不可单测，靠 n=1 使用验证（写进 test README）。MFI 失真诊断（§5.4）记「输入最高 MFI vs 输出排第一」排名差作健康信号非断言。 | 已拍 | 各 lane |
| 1 | 运行时形态 hybrid | 已拍（ADR-0042 决定 4）。(a) nightly cron `compose_nightly` 产骨架（`added_by:'composer_nightly'`）；(b) `advanceStreamItem` 后**事件驱动**增量重排——不在 advance 同步路径调 LLM，写 outbox → pg-boss `recompose_incremental`，payload 带受影响 `knowledgeIds`。增量单元 = 仅受影响 KC 的 L1 重算 + 子集喂 L2。触发阈值：作答后 θ̂ 跨 MFI 分桶边界才喂 L2，否则只 L1 确定性重排（省 LLM）。 | 已拍（运行时）/ **待 owner**（分桶阈值具体值） | runtime |
| 2 | 并发/竞态锁 | pg-boss `singletonKey='compose:${date}'`（同 date 在途只一）+ PG `pg_advisory_xact_lock(hashtext('stream:'\|\|date))` 包「读信号→写 stream_item」事务。order 冲突由既有 `(date,ref_id)` uniqueIndex + `onConflictDoNothing` 兜底。**不引入 Redis**（CLAUDE.md 红线）。信号预读在锁外、只锁写入段，保短事务。 | 已拍 | runtime |
| 3 | 候选窗 + token 预算 | 三级 cap 常量：`MAX_CANDIDATES=50`（喂 LLM，紧于 due-list 的 400）、`FRONTIER_LIMIT=20`、`STREAM_LLM_TOKEN_BUDGET`（分桶压缩后估）。截断即决策：到期项**不截**（hard constraint 全入），截非到期池——MFI 降序 top-K frontier + top-K 巩固。落 `selection-constants.ts`。 | 已拍（哲学）/ **待 owner**（`STREAM_LLM_TOKEN_BUDGET` 数值） | L1 + 横切 |
| 7 | 参数表 warn-vs-hard | 统一 `selection-constants.ts`，每参数四元组（默认/调整粒度/观测信号/护栏层）。warn 层（零干预只 observable）：mix 配比 / MFI 降权阈值 / 反舒适区配额。hard 层（3-5× 防事故）：容量硬顶 / auto-apply 熔断 / 语义违规整流阈值。ADR-0039 A 档撤销窗口单位时间 auto-apply 熔断归 hard 层。 | 已拍 | 横切 |
| 9 | 流生命周期 compose-advance-recompose | 三态 + LLM 边界：①**compose**（首次 lazy/nightly）调 L2；②**advance**（作答推进，现纯改 status）→ 改 θ̂ → 跨分桶才事件触发增量重排（#1），**advance 永不同步调 LLM**（保低延迟）；③**recompose**（用户主动）调 L2（与 compose 同路径，删 pending 重排，现 `recomposeStream` 已是此形态，换 `composeDailyStream`→L2）。recompose 删 pending 时若 LLM 挂 → 先产新再删旧的事务序，保留旧 pending。 | 已拍 | runtime |
| 10 | copilot reach 边界（ADR-0041） | 三边界：①copilot 经 `run_task` dispatcher 声明 `recompose_stream` 任务（不直接调 composer，决定 2 reach）；②copilot 经 **typed apply** 直改 `practice_stream_item`（payload schema 承重），写 live + checkpoint 戳 `user_ask`（决定 1）；③改后 **L3 必重执**（copilot 写入是 L2 同构产物，过同一 post-filter）。`added_by:'copilot'`（现 enum 已有）。撤销走 ADR-0041 补偿事件（接 #11）。复用 `copilot_run.ts`（已存在）。 | 已拍 | interface |
| 11 | 今日流撤销链（ADR-0039） | **不进 18-kind 归档表**（stream_item 是 AI 日程行非 inbox proposal，A/B/C 表不适用 §6.11）。撤销 = **软删**（status 加 `'retracted'` 或 superseded 标记，非物理删），承 ADR-0006 event=SoT。整流撤 = recompose；逐条撤 = copilot 经 ADR-0041 补偿事件 / user 经 status 转移（`LEGAL_TRANSITIONS` 扩 retracted）。**作答事实在 event 流不撤，撤的只是日程行**。 | 已拍 / **待 owner**（`retracted` status vs 独立 `superseded` 字段二选一） | interface |
| 13 | mem0 prior 进 prompt 契约 | 量级 cap（`MEM0_PRIOR_CAP`≤5 条 one-line）+ `<ADVISORY_ONLY>` 标记块 + 不进数值（ADR-0037 H5 / ADR-0039 决定 6/7）。防循环注入五防必守（注入事实非上轮装配物 / ambient 不进历史 / L2 输出永不进 mem0 extraction 源堵 confirmation loop）。不可机械验证（§5.5）：靠 L3 due presence 硬兜底——LLM 被带偏漏排到期项时 L3 强制补回。复用 `searchMemories`（YUK-322）。 | 已拍 | interface |

### 三个真硬前置（不定则其余悬空）

- **#4 L1→L2 数据契约 schema** — 最根本：#5/#6/#7/#8/#13/#14 全读它字段。
- **#1 运行时形态**「增量重排单元」定义 — #2/#9/#10 的共同前提（已拍 hybrid，单元 = 受影响 KC 子集）。
- **#12 frontier CTE cycle guard** — L1 候选源安全前置；脏边会让 L1 整体挂、#4 frontier 字段无从产出。

### 待 owner 拍的具体值（建票前确认，非阻塞结构）

1. #1 增量重排的 **MFI 分桶边界触发阈值**（跨桶才喂 L2 的判定——是否就用 high/mid/low 三桶边界，还是另设 θ̂ 变动 δ 阈值）。
2. #3 `STREAM_LLM_TOKEN_BUDGET` 数值（分桶压缩后估，需先有 L1 候选实测体积）。
3. #11 撤销载体：`status` enum 加 `'retracted'` vs 新增独立 `superseded_at`/`superseded_by` 字段（影响 `LEGAL_TRANSITIONS` 矩阵大小）。

## 2. 实施 lane 分解（5 lane + 依赖序）

依赖拓扑：**LANE-A（schema）→ LANE-B（L1 确定性）→ LANE-C（L3 post-filter）→ LANE-D（runtime + L2 接入）→ LANE-E（interface）**。横切 LANE-X（常量 + 参数表）先于 B 落地、被所有 lane 引用。LANE-B 三个子件（frontier CTE / MFI / SelectionCandidate schema）内部可并行。

```
LANE-X (constants)  ─┐
LANE-A (schema)     ─┼─→ LANE-B (L1) ─→ LANE-C (L3) ─→ LANE-D (runtime+L2) ─→ LANE-E (interface)
                     └────────────────────────────────────────────────────────┘  (#4 schema 贯穿)
```

---

### LANE-X · 选题常量 + 参数表（横切，先落）

承 #3 #7。纯常量 + 类型，零 IO，先于 B 落地，B/C/D/E 全引用。

| 文件 | 动作 |
|---|---|
| `src/capabilities/practice/server/selection-constants.ts` | **创建**。`MAX_CANDIDATES=50` / `FRONTIER_LIMIT=20` / `FRONTIER_MAX_DEPTH=8` / `STREAM_LLM_TOKEN_BUDGET`（待 owner）/ `SEMANTIC_VIOLATION_THRESHOLD`（候选数×0.3）/ `MEM0_PRIOR_CAP=5` / MFI 分桶边界 0.33/0.66 / mix 配比 warn 水位 / 容量硬顶（沿 `DEFAULT_WARN=12`/`DEFAULT_MAX=30`）。每参数 JSDoc 注释四元组（默认/粒度/观测信号/护栏层 warn\|hard）。 |

**测试**：`selection-constants.unit.test.ts` 钉默认值 + 护栏层标注存在（防漂移）。
**依赖序**：无前置，最先落。

---

### LANE-A · `practice_stream_item` schema 补列（硬前置 #4 持久化 + #6）

承 #4 #6 #11 #7（π_i 列）。schema + migration，先于 L1 写入路径。

| 文件 | 动作 |
|---|---|
| `src/db/schema.ts:926` | **修改** `practice_stream_item`：① 加 `signals jsonb`（§3 结构 + `inclusion_prob`）；② `source` enum 扩 `'frontier'\|'consolidation'\|'due_override'\|'recall_override'\|'llm_filled'`；③ #11 撤销载体（status 加 `'retracted'` 或独立 `superseded` 字段，**待 owner**）；④ 加编排代际列 `composed_at timestamptz`（区分 nightly 预产 vs 白天第 N 次重排，承 hybrid position 重排语义）。 |
| `src/db/migrations/NNNN_*.sql` | **创建**（`pnpm db:generate`）。加列 + enum 扩值（`source`/`added_by` 现为 text + `$type` union，扩 union 即可，无 PG enum DDL；若 status 用 `'retracted'` 同理）。`signals` nullable（旧行无 signals）。 |
| `src/core/schema/selection-candidate.ts` | **创建**。`SelectionCandidate` + `SelectionCandidateBatch` Zod（#4 字段全集，含 `inclusionProb`）。cross-subject 故归 `core/`。schema 注释写截断策略（到期不截、非到期 MFI 截 top-K）。 |
| `scripts/audit-schema-allowlist.json` | **修改**（如需）。新列若暂无 write path（如 `inclusion_prob` 在 #45 解锁前为 null）须加 allowlist + `resolves_when:{kind:'phase',ref:'<π_i 解锁 phase>'}`，否则 `pnpm audit:schema` fail。 |

**测试**：`selection-candidate.unit.test.ts`（Zod 字段 + B1 前/后双形态同 schema、null 字段非两 schema）；migration 由 `pnpm test:migration` smoke。
**依赖序**：LANE-X 后；LANE-B 前（L1 producer 输出 `SelectionCandidate` 型、L3 写 `signals`/`source` 新值）。

---

### LANE-B · L1 确定性信号层（硬前置 #12 + #14 + π_i 产出口）

承 #12 #14 #4（producer 侧）+ L1 信号 grounding。三子件并行：frontier CTE / MFI / 信号收集重构。**全确定性、可先于 LLM 落地单测**。

| 文件 | 动作 |
|---|---|
| `src/capabilities/practice/server/frontier-cte.ts` | **创建**（#12，真新件零雏形）。`WITH RECURSIVE` 沿 `knowledge_edge` prereq 边，`path text[]` cycle guard + `MAX_DEPTH=8` + 外层 `LIMIT FRONTIER_LIMIT`。frontier = 前置全 mastered 自身未 mastered 的边界 KC。脏边停分支不抛错。复用 `knowledge_edge_from_idx`。 |
| `src/capabilities/practice/server/mfi.ts` | **创建**（#14，MFI 函数新件；底层 `core/theta.ts:27` expectedScore + `:111` difficultyToLogitB 复用）。`fisherInfo(θ̂,b)=P(1−P)` → `mfiNorm=I/0.25` → `mfiBucket()`。多 KC 题 `θ̂_min`（取候选 KC 集 min θ̂）。B1 前 b/θ̂ 缺 → `mfi=null`（过渡可用 `question.difficulty`+`evidenceCount` crude MFI，ADR-0042 后果节已埋）。 |
| `src/capabilities/practice/server/stream-store.ts:49` | **修改** `collectComposerInputs`：4 段 SQL 不再降级为裸 id，每候选附 `SelectionCandidate` 结构化 signals（urgency/decay/mfi/coverage）。消费现已存在但未用的 `dueItems.dueAt`（`stream-composer.ts:19`）。叠加 frontier-cte（新源）+ MFI 打分。**π_i 产出口**：选题侧若走随机抽样则在此写 `inclusionProb`（满足 positivity，ADR-0043:86）；确定性 MFI top-item 下 `inclusionProb=null` + 标注（确定性选 ≠ 随机 inclusion probability 的结构张力，#45 解锁前留 null）。 |
| `src/server/mastery/state.ts:141` | **修改**（或新建聚合 helper）。补 `θ̂_min`(min over kc) ex-ante 选题聚合（现仅注释留口）；与未来 mastery VIEW 的 min/avg 一致性文档化。批量读 b（复用 `state.ts:167` 单读 select，补批量 reader）。 |
| `src/capabilities/practice/server/due-list.ts` | **修改**（轻）。L1 纯到期保序需绕开 round-robin（`:537`）+ goal soft-rerank（`:558`）或复用底层 select（`:236`）。`candidateWindow=400` 对齐 `MAX_CANDIDATES=50`。 |

**守恒红线**：FSRS *when* 单写者契约不破——L1 只**读** `material_fsrs_state.due_at`（`due-list.ts:236`），到期投影不并进 MFI 打分（due 是独立 hard constraint 轴）。`pickProbeForKnowledge`（`variant-rotation.ts:231`）作 L1 子步骤复用、recall/application 路由不变（ADR-0030）。
**测试**：`selection-engine.unit.test.ts`（确定性）—— MFI 峰值 0.25 / 归一 / 分桶边界；frontier CTE 脏边 + 自环 fixture（cycle guard 不挂、depth limit 生效）；到期保序 `due_at ASC` ±k；θ̂_min 多 KC。
**依赖序**：LANE-X + LANE-A 后；LANE-C 前。

---

### LANE-C · L3 确定性 post-filter（守 invariant 全集，所有写入路径的 choke point）

承 #5 #8 #6（signals 落库）。L3 是 compose/recompose/copilot 三写入路径的**共享 choke point**，先于 L2 接入。

| 文件 | 动作 |
|---|---|
| `src/capabilities/practice/server/post-filter.ts` | **创建**。独立 pass：容量收口（R5 从 composer 内联移出 `stream-composer.ts:122` 到此）/ 去重 / 最终排序 / per-item repair 表（#5：幻觉 id 剔除、越界 due 走 H8 补回、配比超 cap 裁剪标 `llm_filled`）/ 语义违规阈值 → 整流 fallback 信号。**到期 presence 硬兜底**（#13：LLM 漏排到期项强制补回）。 |
| `src/capabilities/practice/server/stream-store.ts:165` | **修改** `materializeStream`：物化前过 L3；写 `signals` jsonb（#6）+ 新 `source` 值。hybrid position 重排语义：增量重排回收 position 空洞（现 `base+i+1` 追加单调增 `:187` 与 nightly 骨架冲突），用 `composed_at` 代际识别本代产物（替现状 status=pending 粗筛 `:294`）。 |

**守恒红线（invariant 全集，每条一断言 §1.1）**：recall 不换题（不污染）/ 到期 hard constraint 保序 ±k / frontier 配额（一等公民）/ presence 补回 / cap 裁剪 / 幻觉剔除 / 三轴正交 R⟂p(L)⟂difficulty（L3 不把 due 紧迫度并进 MFI 排序）。
**测试**：`post-filter.db.test.ts`（invariant 断言全集，DB fixture）+ repair 表逐类单测。
**依赖序**：LANE-B 后；LANE-D 前。

---

### LANE-D · hybrid runtime（nightly + 增量重排 job）+ L2 LLM 编排接入

承 #1 #2 #9 + L2 编排。compose/recompose 换 L2 路径，fallback 退回退化 `composeDailyStream`。

| 文件 | 动作 |
|---|---|
| `src/capabilities/practice/jobs/compose_nightly.ts` | **创建**（参照 `jobs/review_plan.ts` manifest 登记 + handler 工厂 + `jobs/item_prior_backfill.ts` cron 形态）。nightly cron 产骨架，`added_by:'composer_nightly'`（enum 已预留无写入方）。`singletonKey='compose:${date}'`（#2）。 |
| `src/capabilities/practice/jobs/recompose_incremental.ts` | **创建**。事件驱动增量重排，payload 带受影响 `knowledgeIds`。仅该子集 L1 重算；跨 MFI 分桶才喂 L2，否则 L1 确定性重排。 |
| `src/capabilities/practice/server/stream-llm.ts` | **创建**（L2 编排者）。L1 `SelectionCandidate` → prompt 装配（分桶压缩 + mem0 ADVISORY_ONLY 段接 #13）→ runTask → parse → 交 L3。R7 模板 reasoning（`stream-composer.ts:78` 等）由此接管成 AI provenance。**结构化 schema 钉 opus**（reference_workflow 教训：sonnet/GLM 不兼容 StructuredOutput）。 |
| `src/capabilities/practice/server/stream-composer.ts:56` | **修改/包裹**。保留作 **fallback 退化路径**（#5 格式坏整流），R5 容量截断移走（→L3）。composer 签名改 async + 注入 runTaskFn（参照 `jobs/review_plan.ts:9` CoachRunDeps/MCP bridge 注入），或 L2 留 IO 壳侧。 |
| `src/capabilities/practice/server/stream-store.ts:269` | **修改** `advanceStreamItem`：θ̂ 更新后跨分桶 → 写 outbox event → `boss.send('recompose_incremental')`，**advance 本身不同步调 LLM**（#9 保低延迟）。`recomposeStream`（`:292`）换 `composeDailyStream`→`stream-llm`，删 pending 时先产新后删旧事务序。`materializeStream`/`recomposeStream` 写入段包 `pg_advisory_xact_lock`（#2，信号预读在锁外）。 |
| `src/capabilities/practice/manifest.ts:156` | **修改** jobs.handlers：登记 `compose_nightly`（cron，错开 `item_prior_backfill` 的 `20 4 * * *`）+ `recompose_incremental`（queue `llm`）。 |
| `scripts/worker.ts` | **修改**（如 cron 注册需）。 |
| `postman/api-endpoints.json` + `pnpm gen:postman` | **修改**（若 stream 路由 body/param 变）。 |

**守恒红线**：mem0 ADVISORY_ONLY（#13）—— L2 prompt 注入只读 top-K one-line + `<ADVISORY_ONLY>`，L2 输出永不回流 mem0 extraction（堵 confirmation loop）。三轴正交在 L2 prompt 保持（不让 LLM 把 due/MFI/difficulty 揉成单分）。
**测试**：`stream-llm.golden.test.ts`（golden E2E：固定候选 → 快照形态，钉数量/source 分布/L3 invariant 兜底，不钉具体 id；opus）；`recompose_incremental.db.test.ts`（事件触发 + advisory lock 并发 + singletonKey 去重）。L2 质量 n=1 使用验证写 test README。
**依赖序**：LANE-C 后；LANE-E 前。

---

### LANE-E · 接口层（copilot reach #10 + 撤销链 #11 + mem0 契约 #13）

承 #10 #11 #13。最后落，依赖 ADR-0041 `copilot_run.ts`（已存在）。

| 文件 | 动作 |
|---|---|
| `src/capabilities/copilot/` | **修改/创建**。注册 `recompose_stream` 任务（copilot 经 `run_task` dispatcher 声明，不直接调 composer）+ stream `practice_stream_item` typed apply tool（payload schema 承重）；写 live + checkpoint 戳 `user_ask`（ADR-0041 决定 1）；copilot 写入**过同一 L3 post-filter**（复用 LANE-C，强制汇入单 applier ADR-0041 决定 4）。`added_by:'copilot'`。 |
| `src/capabilities/practice/server/stream-store.ts` | **修改** `LEGAL_TRANSITIONS`：扩 `'retracted'`（或 superseded 字段转移，#11 待 owner）。撤销 = 软删非物理删（ADR-0006 event=SoT）。 |
| `src/capabilities/practice/server/stream-llm.ts` | **修改**（mem0 段，若 LANE-D 未含）。`searchMemories`（YUK-322）top-K + `<ADVISORY_ONLY>` + 防注入五防。 |

**测试**：`copilot-stream-reach.db.test.ts`（typed apply 过 L3、checkpoint 事件、撤销补偿）；`LEGAL_TRANSITIONS` 合法转移矩阵单测；**防循环注入专项单测**（per feedback_no_recursive_prompt_injection + ADR-0039 决定 7）。
**依赖序**：LANE-D 后（末 lane）。

## 3. Banked 约束映射（守住不可破的红线）

| Banked 约束 | 落点 | 守法 |
|---|---|---|
| **FSRS *when* 不并进** | LANE-B `due-list.ts:236` 只读 `due_at`；LANE-C 三轴正交断言 | due 是独立 hard constraint 轴，不进 MFI 加权；`material_fsrs_state` 仍 FSRS 单写者 |
| **到期 hard constraint** | LANE-B 到期保序 `due_at ASC`；LANE-C presence 硬兜底 | 到期项不截（#3）、LLM 漏排强制补回（#13）、保序 ±k 断言（#8） |
| **frontier 一等公民** | LANE-B `frontier-cte.ts`（与 due/consolidation 平级 source）；LANE-C frontier 配额断言 | 格式坏 fallback 也保 frontier（非纯 due，#5/§1） |
| **recall 不污染** | LANE-B `pickProbeForKnowledge` 复用（recall 原题不换 ADR-0030）；LANE-C recall 不换题断言 | recall(fill_blank/translation) 路由不变；application 族轮换不越界 |
| **三轴正交 R⟂p(L)⟂difficulty** | LANE-C 正交断言；LANE-D L2 prompt 不揉单分 | due(R 紧迫)/MFI(p(L) 信息量)/difficulty 各自轴，L3 不跨轴归一 |
| **mem0 ADVISORY_ONLY** | LANE-E mem0 段 `<ADVISORY_ONLY>` + 五防 | 不进数值、L2 输出不回流 extraction、L3 due presence 兜底 |
| **event=SoT 可重放（ADR-0006）** | LANE-E 撤销软删非物删；LANE-D advance 作答仍写 event | 撤的是日程行非作答事实；stream_item 是物化日程非 SoT |

## 4. 上下游接口

| 接口 | 关系 | 落点 |
|---|---|---|
| **#45（π_i 解锁 / active-PPI IPW rectifier）** | `inclusion_prob` 列 LANE-A 先建（nullable），LANE-B 产出口预留；确定性 MFI top-item 下为 null（确定性选 ≠ 随机 inclusion probability 的 positivity 张力 ADR-0043:86，#45 解 random-tie-break / Boltzmann 抽样时填实值）。本 wave 不实现随机抽样，留口。 | LANE-A `schema.ts` + audit allowlist `resolves_when:phase=#45`；LANE-B `stream-store.ts` 产出口 |
| **YUK-350（B5）** | B5 慢热自校准供给 `mastery_state.theta_hat` / `item_calibration.b`（gated B1）。B1 前本引擎走 `mfi=null`+`isPlaceholder` 退化骨架（#4 缺失契约 / §5.6 evidence_count 驱动），**不阻塞 B5**——与 ADR-0039「A/C 档零算法依赖可立即做」同构。 | LANE-B `mfi.ts` B1 前/后双形态 |
| **ADR-0041（copilot reach 边界）** | copilot 经 typed apply + per-utterance checkpoint，复用已存在 `copilot_run.ts` + `job_events` durable infra。reach = 声明 `recompose_stream` 任务（决定 2）+ stream typed apply（决定 2 结构型）+ checkpoint `user_ask`（决定 1）+ 汇入单 applier 过 L3（决定 4）。撤销走补偿事件链。 | LANE-E copilot 注册 |

## 5. 诚实天花板（写进实施 + test README）

- **capitalization-on-chance**：θ̂ 不准时 MFI 会系统性偏好同类误差题。缓解非消除——LANE-C 观测 query 跨天检测（#6），作健康信号非硬断言。
- **MFI 锚质量依赖**：`item_calibration.b`（强锚 `bWeight=1`）vs `difficulty_proxy`（弱锚 `DIFFICULTY_PROXY_WEIGHT=0.3`，`state.ts:174`）。锚差则 MFI 失真，无法单测保证选题「正确」。
- **B1 前 evidence_count 过渡**：`mastery_state`/`item_calibration` gated B1。B1 前 `mfi=null`+`isPlaceholder=true`，mix 由 `evidence_count` 驱动（§5.6），或 `question.difficulty`(1-5) crude MFI 先 prototype。整引擎可在 B1 载体到位前以确定性骨架 + 退化 MFI 落地。
- **L2 编排不可单测**：LLM 非确定。golden 只钉形态（数量/source 分布/invariant），「质量」靠 n=1 owner 使用验证（test README 明示）。
- **π_i 与确定性 MFI 结构张力**：MFI 是 `argmin`（确定性 top-item），π_i 须真随机 inclusion probability（positivity，ADR-0043:86）。本 wave 留 `inclusion_prob=null`，#45 解。

## 6. 实施排序总览（cross-lane gate）

1. **硬前置批**：LANE-X（constants）→ LANE-A（schema #4/#6 + π_i 列）→ LANE-B（#12 frontier CTE / #14 MFI / θ̂_min）。全确定性，可先单测、先于 LLM。
2. **L3 choke point**：LANE-C（#5 repair + #8 invariant 全集）—— 所有写入路径共享，先于 L2。
3. **runtime + L2**：LANE-D（#1 hybrid + #2 锁 + #9 三态 + L2 接入，fallback 退化 composer）。
4. **接口**：LANE-E（#10 copilot reach + #11 撤销 + #13 mem0 + 防注入专项单测）。
5. **横切贯穿**：LANE-X 常量 + #7 参数表被 B/C/D/E 全引用；#4 `SelectionCandidate` schema 从 L1 producer 到 L2 consumer 到 L3 校验全程承载。

**每 lane gate**：`pnpm typecheck` + `pnpm lint` + 对应分区测试（L1/L3 确定性单测、L2 golden、runtime DB 测）+ `pnpm audit:schema`（LANE-A 后）+ `pnpm audit:partition`。Pre-PR 全量 `pnpm test` + `pnpm build`。

## 7. Linear 跟进

本 plan 是 spec 产出，未改代码。建议 owner 为上述 5 lane 在 wave 前批量建 Linear 子票（承 YUK-203 / ADR-0042 实施波次），尤其三个硬前置（#4 LANE-A schema / #12 LANE-B frontier CTE / #1 LANE-D runtime）独立成票且互为依赖标注。三个「待 owner」抉择（#1 分桶阈值 / #3 token 预算 / #11 撤销载体）应在建票前确认。π_i `inclusion_prob` 列与 #45 互为接口，audit-schema allowlist 的 `resolves_when` 指向 #45 phase。
