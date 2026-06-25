# Evidence-First 复习/推荐引擎 — X 算法架构纪律映射设计

> **类型**：设计文档（final）
> **日期**：2026-06-25
> **源材料**：`docs/research/2026-06-25-x-algorithm-deep-dive.md`（X 2026 推荐算法深潜，尤其 §4.4 Phoenix 双塔+候选隔离、§5 加权和价值函数、§6 序列分段+OON、§10 迁移映射）
> **主线 Linear**：YUK-405（私人教研团 / 推荐引擎 rethink）；follow-up 见 §7
> **设计意图基准**：报告 §10 的「抄架构纪律、拒数据前提哲学」结论，作为本文档的 agreed intent，不再重新论证。

---

## 摘要

- **这是什么**：一个 evidence-first 的复习/推荐引擎，**增强（augment）而非替换**现有 FSRS 调度 + practice 选题栈。核心是把今天的「多信号 → LLM 编排权重 → 抽样」选题，逐步收口为一个 **显式、owner-可调、确定性、可单测的多动作加权和价值函数 + 多源召回**，并把它接到现有 `composeSoftmaxStream` 选题流水线上。
- **借 X 的 4 个结构不变量**：①候选隔离 / per-candidate 可缓存打分（§4.4.4）——但只对确定性 `scoreCandidate` 内核成立，开 LLM 叠加层即失效；②right-sized 双塔（§4.4.1，brute-force，不上 ANN）——实为单一文本嵌入空间上的启发式内容相似召回，非学习双塔；③多动作加权和 = 显式价值函数（§5）——并把 X「隐藏系数」反过来做成「入代码、可 diff」的 owner 权重；④内容理解独立成层（grox，§4.5）——即录入→tagging→judging annotation 层契约。结构上还学 X 的「加权和核心 + 后置乘子（多样性衰减 / 冷启探索）」与「召回序列 ⊥ 打分序列」分段（§6）。
- **拒 1 个哲学**：拒「消除手工特征、让大模型 learn 一切」（§1 赌注 1 / §7 核验）。n=1 无 batch、无持续训练流、无 5% 采样——手工特征 + 先验规则（FSRS 理论 / KG prereq 拓扑 / 错因分类）是 day-one 唯一可用来源，是资产不是债务（连 X 自己都退到「most heuristics」）。
- **冷启动 priors-first**：先验路径是独立的**路径选择**（KLP 冷簇 vs MFI 暖簇），不是「在单一模型上调一个探索权重」；day-one 必须靠先验可用，数据门只 gate 权重 firm-up，不 gate build/wire/UI。
- **建议第一步**：**Phase 1 — `scoreCandidate` 确定性内核与 LLM 编排并存（不替换）**，先收口纯函数 + 显式权重 + batch-invariance/replay 单测，行为经 `SELECTION_POLICY` 可整层回退，**派 opus 写**（不变量 / parse-barrier 敏感代码）。

---

## 1. 背景与目标

### 1.1 我们要造什么

一个 **evidence-first 的复习/推荐引擎**，它 **增强（augment）而非替换（replace）** 现有的 FSRS 调度 + practice 选题栈。今天的选题已经是一条「Source → Hydrate → Score → Sample → Assemble」的流水线（`src/capabilities/practice/server/softmax-selection.ts`），其形态已经天然对应 X 的 home-mixer 框架。本设计不推翻它，而是：

1. 在现有 `collectCandidateSignals` + `SelectionOrchestratorTask` 的「多信号 → LLM 权重 → 抽样」打分**之上/之内**，**新增一个显式、owner-可调、确定性、可单测的多动作加权和价值函数内核 `scoreCandidate`**，与 LLM 编排器**并存**（不一次性替换；LLM 去留是 §6 的开放决策），且在 owner cut-over 前 **byte-preserve 现有 π_i sampler 语义与 ADR-0042 weight-sharing 不变量**（借 X §5）；
2. 给召回侧补一个 **right-sized brute-force 内容相似召回**（复用现有单一文本嵌入空间）作为第二召回源，与现有 KG prerequisite 拓扑并存（借 X §4.4，但拒绝 ANN）；
3. 把 `scoreCandidate` 内核约束成 **per-candidate 纯函数**（候选隔离不变量，借 X §4.4.4），换来可缓存、可解释、可回放——并诚实声明这一不变量**只对确定性内核成立，开 LLM 叠加层即失效**（见 §3a）；
4. 把录入→标注→判分 pipeline 明确为 **独立异步可缓存的内容理解层**（借 X grox，§4.5），喂给引擎而非耦合进引擎；
5. 保留一条 **冷启动专路**（priors-first，**路径选择**而非单模型权重微调），显式拒绝「让模型学一切」（X §10 反向洞见）。

> 注：本节第 1 条与 §6 开放决策 5（LLM 编排去留）一致——本设计**不**承诺一次性「重构掉」LLM 编排，而是先并存 + gate，owner 决定是否、何时 cut-over。

### 1.2 借哪些 X 的想法 / 拒哪些（引 §10）

| X 设计 | 裁决 | 本设计如何落地 / 为何拒 |
|---|---|---|
| **候选隔离 / per-candidate 可缓存打分**（§4.4.4） | **借（核心）** | `scoreCandidate(user_state, candidate)` 约束成纯函数，与同批其它候选无关。**仅对确定性内核成立**；开 LLM 软重排叠加层即破（LLM 一次看全桶，权重依赖 batch 组成）。匹配现有「三轴正交 + 单写者」纪律。详 §3(a)。 |
| **双塔召回（user 塔 × candidate 塔，L2 点积 top-K）**（§4.4.1） | **借，但 right-size + 降级表述** | brute-force 精确点积，**不上 ANN**——X 自己 demo 也是 brute-force（§4.4.1 核验修正：「ANN」是 README-only）。我们语料远小于 537K。**但这不是学习双塔**：现有只有单一文本嵌入列（DashScope text-embedding-v4），无 user 塔；user 侧聚合是 net-new 启发式，须先验证「错题池均值 · 候选文本嵌入」点积与有用性相关再接线。详 §3(b)。 |
| **多动作加权和 = 显式价值函数**（§5） | **借（核心）** | 把内容轴信号 + 表现轴信号作为不同 action head，**显式 owner 数字权重**（不学习——我们 n=1），含负权重负信号。**核心是加权和，多样性/冷启探索做后置乘子而非线性 head**（学 X §5 结构）。详 §3(c)。 |
| **内容理解独立成层（grox）**（§4.5） | **借** | 录入→tagging→judging 已经是独立异步层；本设计把它正式确立为「annotation 层」契约，缓存标注，喂引擎。详 §3(d)。 |
| **冷启动专用路径**（§6 新用户簇 + 单独 topic 召回 + OON 乘子） | **借（路径选择，非权重微调）** | 镜像 X 给冷启动单独建先验路径的事实——我们已有 KLP（冷）vs MFI（暖）门控就是「单独的冷簇打分路径」，加 thin-seed + FSRS 理论 + KG prereq + ItemPrior。冷启探索做**后置乘子**（对齐 X OON 乘子），非塞进线性和。详 §3(e)。 |
| **召回序列 ⊥ 打分序列分段**（§6） | **借** | X 的 `retrieval_sequence`（正向、压缩、喂塔）vs `scoring_sequence`（含负信号、喂排序）分段——n=1 即可用且便宜：召回用「弱 KC / 正向 mastery」精简表示，打分额外携带 `cause_recurrence` + failure-streak。详 §3(b)/§3(c)。 |
| **shadow traffic 看全信号**（§6） | **借** | 与「数据门只 gate 翻转不 gate build」一致：信号收集 + 接线 + UI 先穿到 live，只 defer 翻转。已落 `selection_observation`。 |
| **「消除手工特征」/「让大模型 learn 一切」**（§1 赌注 1、§7 核验） | **拒（明确）** | n=1 无训练流（无 batch、无持续训练、无 5% 采样）。手工特征 + 先验规则（FSRS 理论 / KG prereq 拓扑 / 错因分类）**是 day-one 唯一可用来源，是资产不是债务**。连 X 都退到「most heuristics」（§7）。详 §3(c)/§3(e) 与 §6。 |
| **学习得到的数值权重**（§5、§7：权重不在仓库） | **拒** | 我们权重是 owner 决策的显式数字，**入代码、可 review、可 diff**——恰恰反着 X「隐藏系数」做。注：X 自己的开源 phoenix 前向路径连负 head 都未消费（§4.4.5），polarity-in-code 真正成立的是 home-mixer ranking_scorer（§5，仍藏系数）。 |

**诚实声明（什么不迁移）**：X 的核心赌注是「海量用户 × 海量 engagement 流持续训练一个大 transformer 取代手工特征」。我们是 **n=1、冷启动、day-one 必须靠先验可用**。可迁移的是 **结构不变量**（候选隔离、双塔形状、显式多动作价值函数、内容理解独立层、召回/打分序列分段、加权和+后置乘子结构），不是 **数据前提哲学**。本文档每一条设计都连到今天已存在的真实文件/表，不引入「等数据翻 flag 才能用」的 day-one 依赖。

---

## 2. 现状基线（grounded）

### 2.1 复习选题：两个消费者

- **`GET /api/review/due`**（`src/capabilities/practice/server/due-list.ts:194` `handleReviewDue`）：**纯同步、无缓存、无 pg-boss**。每次请求重跑。三切片 union（overdue-knowledge `:240-255` / overdue-question-legacy `:278-301` / never-reviewed-failure `:89-107`），跨学科 round-robin（`roundRobinBySubject` `:136-173`），末尾 goal 软偏置 stable-partition（`rerankOverdueByGoals` `:585-619`，ND-5：只改序不改 set）。**due 项由 FSRS `due_at <= now` 唯一决定，不重算 MFI**（§8 invariant 6）。`due-list.ts` 经核验**零 `knowledge_edge`、零 embedding/`<=>` 引用**。
- **`GET /api/practice/stream`**（`src/capabilities/practice/server/stream-store.ts:571` `getStream`）：**预计算表 + lazy-compose 兜底**。`practice_stream_item` 行按 `position` 读；空且 today → `singleFlightCompose`（advisory lock + double-check `:482-513`）。夜间 `practice_stream_compose_nightly`（cron 05:30 Asia/Shanghai）预产。

### 2.2 选题流水线（借鉴目标的家）

`SELECTION_POLICY=softmax_mfi`（default，`src/capabilities/practice/manifest.ts:239` 接线）路径（`softmax-selection.ts:198-407`），closely mirror X Source→Hydrator→Scorer→Selector：

1. **Signal collection（Hydrator/Scorer analog）** — `collectCandidateSignals`（`candidate-signals.ts:473-523`）：per-candidate 读 `mastery_state`（最弱 KC θ̂_min 聚合 `:128-173`）+ `item_calibration` b 锚（`effectiveB = b_calib ?? b_anchor ?? b`，`:189-211`）+ family delta，算 `mfiScore` / `klpScore` / `diagnosticScore`。
2. **信号形状（多动作面）** — `SelectionCandidateSignal`（`src/core/selection-signals.ts:22-71`）：MFI 之外已有三个 first-class 信号（ADR-0042 §9.2）：`examRelevance`（computation-deferred，无 reader）/ `misconceptionRecurrence`（实现但 flag-gated `MISCONCEPTION_RECURRENCE_ENABLED=false`）/ `transferGap`（computation-deferred）。**这就是现有的「多 action 面」雏形。**
3. **打分数学** — `mfiScore`（Fisher `p(1−p)`，`:81-83`）/ `klpScore`（后验加权 Fisher，冷启，`EARLY_KLP_ENABLED` LIVE，`:169-184`）/ `diagnosticScore`（`MFI × 不确定性降权`，`:199-201`）/ `softmaxProbabilities`（温度 + positivity clamp，`:232-248`）。
4. **LLM 编排加权（Scorer）** — `SelectionOrchestratorTask`（`src/server/ai/selection-orchestrator.ts:80-114`）：输入分 high/mid/low 桶（LLM 永不见 raw float，ADR-0042:68 signal-fidelity），输出 per-candidate 权重（`:132-174`）。route = mimo-v2.5 单 pass。**注意：LLM 一次看到整批分桶后的候选集，其 per-candidate 权重依赖 batch 组成——这是候选隔离不变量的破口（见 §3a）。**
5. **抽样 + 装配（Selector）** — `composeSoftmaxStream`（`softmax-selection.ts:198`）：tempered-softmax `sampleByWeight`（Poisson IPPS，`T=0.25`，ε-greedy 下界），产真 π_i 写 `selection_observation`（active-PPI 资产）。三路两兜底（softmax → 统计 L1 `statisticalWeights`，`softmax-selection.ts:479`，用 `mfiScore ?? diagnosticScore ?? STAT_FLOOR_EPSILON` → legacy，从不 throw `:20-28`）。守 `recallLocked` 与 ADR-0042 §4 weight-sharing。
6. **确定性内核（legacy/L2 兜底）** — `composeDailyStream`（`stream-composer.ts:60-135`）：pure no-IO，固定排序 R1-R7（decay→variant→paper→new_check tail + 容量护栏），**不是价值函数**。

> 本设计要插入的是第 1–5 步的 **default live 选题策略**，被 `softmax-selection` / `selection-sampler` / `candidate-signals.db.test` 守护。替换其打分非「augment」级别的轻改——是 live scoring policy 变更，故 §1.1 第 1 条采「并存 + gate + byte-preserve」而非「重构掉」。

### 2.3 KG 边 + 消费者（关键现状：推荐不走图）

- `knowledge_edge`（`src/db/schema.ts:1102-1131`）：5 核心 `relation_type`（prerequisite / related_to / contrasts_with / applied_in / derived_from），有向 UNIQUE(from,to,type)，`weight` real，`archived_at` 软删（**无 bi-temporal**，ADR-0034）。
- **消费矩阵**（`scripts/audit-relations.ts` CONSUMER_REGISTRY，三层分级 `specialized` > `generic-read` > `creation-validation`，`:96-103`）：prerequisite → topology-gate（诊断）+ hub-mesh（复习）；contrasts_with/related_to → hub-mesh + paths（推荐）；derived_from → hub-mesh；**`applied_in` = 死边（零 specialized 消费，`:86` 在核心 type 列）**。
- **关键发现（grounding 双塔/图嵌入借鉴）**：自动选题/推荐引擎**完全不 traverse `knowledge_edge`**（`softmax-selection.ts` / `candidate-signals.ts` 经核验零边读）。due-list、softmax 选题都是 FSRS + IRT 信号，零边读。边只喂：结构诊断（topology-gate）、note-hub 复习上下文（hub-mesh）、copilot LLM 上下文（generic read）。
- **嵌入现状（精确）**：pgvector + 1024-dim + `<=>` cosine 基础设施已在并**已在被使用**，但**不在 practice/review SELECTION 路径**：
  - `question.embedding vector(1024)`（`schema.ts:269`）由 `embed_backfill` 写，被 **题供给（SUPPLY/sourcing）lane** 读——`pool-fetch.ts:112` 跑 `ORDER BY ${question.embedding} <=> ${qvec}::vector`（cosine，排除 NULL 行 `:106`），经 `matcher.ts`（caller-agnostic，`:1,45`）被 `runSourcingSequence`/`target-discovery`/`quiz_gen`/`quiz_verify` 消费。
  - `knowledge.embedding vector(1024)`（`schema.ts:91`）被 **KC-tagging / cold-start lane** 读——`match-similarity.ts:10`（自述「Mirrors the `poolFetch` ORDER-BY-`<=>` pattern, retargeted from `question` to `knowledge`」）+ `dedup-flags.ts`（近重 MERGE 提议）。
  - **但 practice/review SELECTION 路径（`softmax-selection.ts` / `candidate-signals.ts` / `due-list.ts`）确认零 `<=>`/embedding 读**。诚实框架：嵌入基础设施**非空闲**，它服务供给/标注/冷启；选题/复习侧才是空白——这正是 §3(b) 第二召回源要填的缺口（不是「复用闲置 substrate」，而是「把已被供给侧验证的 cosine 召回范式扩到选题侧」）。

### 2.4 题池 / draft_status 隔离

`question.draft_status`（`schema.ts:233`）三态 NULL≡active：`'draft'`（容器内专用，embedded/teaching check）**排除于两池**。Gate-B 谓词 `or(isNull(draft_status), ne(draft_status,'draft'))` 在每个选题入口重复（`due-list.ts:236,438` / `stream-store.ts:165` / `placement-select.ts:96`）——SQL 三值逻辑下 `IS NULL OR` guard 必需且 present everywhere。

### 2.5 冷启动内容模型

- **薄 seed**：`seedKnowledge`（`src/capabilities/knowledge/server/seed.ts`）只插 3 行 `seed:<subject>:root`（wenyan/math/physics），无 curriculum 子树、无边、无题。`scripts/migrate.ts:39` 调用，**失败有意 fatal**。
- **内容靠上传有机生长**：`tagKnowledge`（`tag-knowledge.ts:145-310`）embed → `matchKnowledgeBySimilarity` → MATCH（`cosine_distance <= 0.55`）or PROPOSE（建子 KC 挂 `seed:<subject>:root`，`domain:null` 经 parent 链派生 effective domain）。**tagging 恒 attribute ≥1 KC**（消除「零-KC 不可见」失效）。
- **cold-start bridge**：`runColdStartBridge`（`cold-start-bridge.ts`）仅在 `knowledge_ids` 全空时触发（`image-candidate-accept.ts:638` / auto-enroll enroll 模式）；anti-hallucination：`subject_id ∈ KNOWN_SUBJECT_IDS` 否则 throw。
- **gen 降级 refill**：`question_supply_nightly` + `discoverSupplyTargets`（`target-discovery.ts:645`）扫前沿 = active `learning_item` 引用 KC——**day-one 新用户无 learning_item → 前沿空 → 派零**，结构性服务不了 day-one（infra 在，但 day-one dead）。
- **ItemPrior 冷启锚**：`item_prior_backfill`（cron 04:20）逐题 LLM 估 `b`/`b_anchor`（max 25/run）；无 calibration 行时 selection 落回 `effectiveB` → `difficultyToLogitB(difficulty)`。**day-one 题可选不依赖 backfill 完成。**

### 2.6 两轴（内容轴 ⊥ 表现轴）—— 实为三轴正交红线（ADR-0035）

| 轴 | 表 | 单写者 |
|---|---|---|
| **R（调度）** | `material_fsrs_state`（`schema.ts:830-847`） | `src/server/fsrs/state.ts upsertFsrsState`（ADR-0005 单写者） |
| **p(L)（诊断/mastery）** | `mastery_state`（`schema.ts:867-911`） | `src/server/mastery/state.ts updateThetaForAttempt`（单写者，invariant-audit 守） |
| **b（题难度锚）** | `item_calibration`（`schema.ts:928-989`） | ItemPrior applier + 夜间 `recalibrateQuestion`；**item-half locked G4：在线 θ̂ 路只读 b 永不写** |

- prompt 的「表现轴」= p(L)/mastery（`mastery_state`）+ 错因轴（`mistake_variant.cause_category`，`schema.ts:1153`，per-subject `causeCategories` 声明 `src/subjects/general/profile.ts:52-93`）。
- prompt 的「内容轴」= propose/KC tagging（`docs/design/2026-06-22-unified-tagging-axis.md`）：**内容驱动**（题面→KC，与答对错无关），与表现轴正交（YUK-482 决策①，记忆 `feedback_propose_is_content_axis`）。
- **正交边界在代码里结构性切断**：`misconceptionRecurrence`（唯一把错因轴桥进选题的信号）「**绝不进 `updateThetaForAttempt` / p(L) / FSRS**」（`candidate-signals.ts:224-227`）——由 `UpdateThetaForAttemptInput` 类型签名无承载字段强制（`state.ts:397-440`）。selection 永不写 calibration/mastery（`candidate-signals.ts:14-15`）。

### 2.7 serving 面

- `/today`（`workbench-summary.ts`）：同步 on-demand，内部跑 `handleReviewDue(limit=200)` 取 `due_count`。
- `/practice`（`stream.ts`）：预计算 + lazy-compose；item 状态 pending/in_progress/done/skipped。
- **AI 任务跑哪**：选题 `SelectionOrchestratorTask` inline 在 Hono route；夜间 job 在 pg-boss worker（`scripts/worker.ts`）。provider 默认 mimo-v2.5（key），`AI_PROVIDER_OVERRIDE=anthropic-sub` 全局切 Opus（oauth）。
- **evidence-first 留痕**：`src/server/ai/log.ts` 三表 `ai_task_runs` / `tool_call_log`（`effect: read|propose|write` + `mirrored_event_id`）/ `cost_ledger`。observability route `/api/logs/{cost,jobs,tool_calls}`。

---

## 3. 架构映射（核心）

每个借鉴想法配一条对真实代码的具体设计。命名约定：新模块统一在 `[新建] src/core/recommendation/`（pure，no-IO，跨学科）+ `src/capabilities/practice/server/`（接线）。**`src/core/recommendation/` 目录、`weights.ts`、`score.ts` 均为 net-new（今天不存在，经 `find` 核验）。**

### 3(a) 候选隔离 / per-candidate 可缓存打分

**X 的不变量**（§4.4.4）：transformer 推理时候选间不互相 attend（`make_recsys_attn_mask`），每条候选的分是 `(user, history, 该候选)` 的纯函数 → 与 batch 内有哪些其它候选无关 → 可缓存、batch-order-independent。X 的 RankingScorer 本身也 per-candidate 纯（`apply(score,w)=score*w`，§5）——X 从不在模型和 sampler 之间插一个 batch-aware 的 LLM。

**映射**：把推荐分内核约束成纯函数

```
scoreCandidate(user_state, candidate) -> { value: number, breakdown: Record<ActionHead, number>, provenance }
```

- **user_state** = `{ θ̂ per-KC (mastery_state), θ_precision, evidence_count, fsrs_card per-subject (material_fsrs_state), active_goal_scope, cause_recurrence_self_tally, failure_streak }` —— 一个不可变快照，调用前组装一次。
- **candidate** = `{ question_id, knowledge_ids, effective_b (item_calibration), kind, draft_status, family_key }`。
- **纯性约束**：`scoreCandidate` 不读全局可变状态、不依赖同批其它候选、不做 IO（所有 DB 读在 `collectCandidateSignals` 阶段完成，喂进不可变 `user_state` + `candidate[]`）。这正是今天 `mfiScore`/`klpScore`/`diagnosticScore` 已满足的形态（`src/core/selection-signals.ts` 全是纯函数）——本设计把它们收口进 **单一 `scoreCandidate(user_state, candidate)`**。

**候选隔离不变量的边界（关键诚实声明，A1）**：
- 候选隔离 / 可缓存 / batch-invariant **仅对确定性 `scoreCandidate` 内核成立**。
- **一旦开启 `SelectionOrchestratorTask` LLM 软重排叠加层，最终 sampler 权重不再 per-candidate 隔离、不再可缓存**——因为 LLM 一次看整批分桶候选（§2.2 步骤 4），其 per-candidate 权重是 batch 组成的函数。
- 因此本设计**只缓存确定性 `scoreCandidate.value`，绝不缓存 post-LLM 权重**；LLM 叠加层挂「no-cache / no-isolation」语义。§3(a) 的可缓存承诺与 §6.5 的「保留 LLM 叠加层」由此对账：缓存只承诺内核，LLM 层显式破例。

**插入选题查询的位置**：
- 在 `composeSoftmaxStream`（`softmax-selection.ts`）里，以 `scoreCandidate` 内核**产出确定性 base value**，作为 LLM 编排前的信号→权重映射的**确定性替身/并存源**。owner cut-over 前 LLM 叠加层语义与 π_i sampler、ADR-0042 weight-sharing **byte-preserve**；cut-over 后可关 LLM 退回纯内核。`breakdown` 写进 `practice_stream_item.signals` JSONB 的 **`signals.rec` 子命名空间**（`schema.ts:1264`，现 default `{}`）。
- **due-list 不动其 set 决策**（FSRS `due_at` 是 L1 硬门，invariant 6）；但 due 项的 **展示序** 可由 `scoreCandidate.value` 在 overdue 段内做 stable re-rank（与现有 `rerankOverdueByGoals` 同性质，只改序不改 set，守 ND-5）。

**缓存策略（n=1 诚实版，A2）**：
- 在 n=1 下，缓存的价值是 **可回放 / replay-safety**，**不是命中率**——因为 `mastery_state` 每答一题就被单写者 `updateThetaForAttempt` 写一次（§2.6），任何「以 mastery/fsrs `updated_at` 派生 user_state_version」的整体 key 会在一次交互后就 miss。
- 故 key **拆两半**，对齐 X CachedHydrator 对**候选侧特征**缓存的做法：
  - **候选侧 / annotation 半**：key = `hash(candidate_id, candidate_calibration_version)`（`item_calibration.updated_at` 派生）。这一半跨 attempt 稳定，可真命中——对应内容理解层产物（§3d）。
  - **user-coupled 半**：每次选题实时重算，不缓存（n=1 下必然每次变）。
- **存储**：Phase 1 用 `practice_stream_item.signals.rec` 当 read-through 缓存（夜间预算物化候选侧分量，白天读表 + 实时算 user 半）；不新增缓存表，避免一致性负担。

**determinism / parse-barrier invariant**（与记忆 `feedback_sonnet_weak_on_invariant_code` 一致——这类时时刻刻守不变量的代码派 opus）：
- `scoreCandidate` 纯函数 + 固定浮点序 → 同输入同输出，replay-safe（对齐 placement-select 的 `ORDER BY question.id` 确定性）。
- **parse-barrier**：LLM 输出（若保留 LLM 编排）永不直接进 score——LLM 只见分桶（high/mid/low，ADR-0042:68），其输出经 schema 校验 + 确定性 clamp 后才进 sampler。score 本体是确定性数学，LLM 是可选的「软重排」叠加层（**no-cache / no-isolation**），**可整层关掉退回纯 `scoreCandidate`**（已有 `SELECTION_POLICY=legacy` kill switch 先例）。
- 单测范式抄 X `test_recsys_model.py`：喂两个不同候选集断言同一候选的内核 `scoreCandidate.value` 相等（X 自己缺这个端到端 batch-invariance 测试，§4.4.4 核验——我们补上）。**注意：该断言只对 LLM-off 内核路径成立**；LLM-on 路径不在 batch-invariance 测试范围内（见上 A1 边界）。
- 另需一个守卫单测：断言推荐写入只触及 `signals.rec`，**绝不 mutate `SelectionCandidateSignal` 的 π_i / calibration provenance 字段**（`selection_observation.signals` 是 active-PPI 重标定的不可恢复资产，`schema.ts:1397,1421-1422`）。

### 3(b) right-sized brute-force 内容相似召回（非学习双塔）

**X**（§4.4.1）：user 塔（重，完整 transformer）× candidate 塔（轻，2 层 SiLU MLP，非孪生/asymmetric）→ L2 归一化点积 top-K。核验修正：**代码实为 brute-force 精确点积**（`jnp.matmul` + `top_k`），无 FAISS/ANN，537K demo 语料够用。

**映射 + right-size（诚实降级表述，F5/A3）**：
- **这不是学习双塔，是单一文本嵌入空间上的启发式内容相似召回。** 我们今天只有**一个文本嵌入列**（`question.embedding` / `knowledge.embedding`，1024-dim，由 `embed_backfill` 经 DashScope text-embedding-v4 写）——**没有任何 user 塔**（`grep two.tower|userTower` 为空）。
- **candidate 表示 = 现有文本嵌入**（零新模型，候选侧）。
- **user 表示 = net-new 启发式聚合**：把 user 近期 engagement 序列聚合成一个 1024-dim 向量。Phase 1 最简实现 = **错题/弱 KC 文本嵌入的加权 mean-pool**（权重 = `1 − p(correct)` 或 `θ_precision` 降权），L2 归一化。**这是全新代码**（聚合器 + brute-force scorer 都是 net-new），且「过去错题文本嵌入均值 · 候选题文本嵌入」点积作为有用性代理是**未经验证的假设，不是免费复用**——见下「开放验证项」。
- **检索 = brute-force 精确点积**：`user_repr @ candidate_corpus.T` + top-K。**明确不上 ANN**——题库规模远小于 X 的 537K，pgvector `<=>` 全量扫或内存点积都够（X 自己 demo 也 brute-force）。复用 `pool-fetch.ts` / `match-similarity.ts` 已验证的 `toSqlVector` + `<=>` cosine 范式（即把供给侧已 live 的 cosine 召回范式扩到选题侧）。
- **召回序列 ⊥ 打分序列分段（借 X §6，D1）**：召回侧 user 表示用 **精简正向序列**（弱 KC / 正向 mastery 聚合，**不让「我放弃了这题」把你拉向相似项**）；打分侧 user_state **额外携带负信号**（`cause_recurrence` + failure-streak）。两个表示分别服务召回与打分，不混为单一「engagement 序列」。

**与 KG prerequisite traversal 的关系（多源召回并存）**：
- 这是 X「多源并行召回」（§3 6 源）的对应：**召回不是单源**。
- **源 1 = FSRS due**（`material_fsrs_state due_at<=now`）——确定性 L1，不进相似召回（守 invariant 6）。
- **源 2 = brute-force 内容相似召回**（弱 KC / 错题文本嵌入近邻的题）——本设计新增，喂非 due 候选池。
- **源 3 = KG prerequisite traversal**（沿 `knowledge_edge` prerequisite 边找弱 KC 的前置/后继 KC 下的题）——**复活 §2.3 的「推荐不走图」缺口**。今天边不喂推荐；本设计让 prerequisite 邻接成为召回源（找「你弱在 X，X 的前置 Y 也该补」的题）。这也给死边 `applied_in`（§2.3）一个潜在 specialized 消费者（applied_in 召回「该 KC 的应用题」），可解 audit-relations 死边——**但这是注册义务非免费收益**：若接 `applied_in` 消费，**必须在 `scripts/audit-relations.ts` 的 `CONSUMER_REGISTRY` 补一条带真实 `file:marker` 的条目**，否则 audit（report-only by default，`--strict` 才非零 exit）会持续报它死。
- 多源 union 后去重，喂进 §3(a) 的 `scoreCandidate` 统一打分——召回管「捞哪些」，打分管「排哪个」，职责分离（X 的 Source ⊥ Scorer）。**召回来源不得作为打分特征**（守 Source⊥Scorer，见 §3c 对 `p_prereq_unblock` 的修正）。

**right-size 的诚实边界 + 开放验证项**：user 表示 Phase 1 是 **先验加权聚合，非学习 encoder**。「学习的 user encoder」是 gated-future（需 engagement 训练流，n=1 没有）——保持聚合可换成 encoder 的接口，但 day-one 用先验聚合。**接线前必须先验证**：「错题池 mean-pool · 候选文本嵌入」点积是否真与「该题对该用户有用」相关（小样本人工核或 retro 相关性检查），相关才作召回源——否则它只是噪声召回。

### 3(c) 多动作加权和 = 显式价值函数（加权和核心 + 后置乘子）

**X**（§5）：`combined = Σ_i P(action_i) · weight_i`（21-22 项，含 not_interested/block/mute/report 负权重），再过 offset 重标定 + **作者多样性几何衰减乘子** + **OON 乘子**（新用户，带 topic→new-user→default 优先级）。**核验：所有数值权重不在仓库（隐藏系数）；开源 phoenix 前向路径连负 head 都未消费（§4.4.5），消费负权重的是 home-mixer ranking_scorer（§5，仍藏系数）。** X 的结构是 **线性加权和核心，多样性/探索做核心之外的乘子**——这样它们不会被其它 head 在线性和里淹没。

**映射到两轴模型 —— action head 设计（线性和部分）**：把内容轴信号 + 表现轴信号作为不同 action head，每个 head 是 `[0,1]` 预测 × owner 显式权重：

| Action head | 轴 | 信号源（已存在 / 新增） | 极性 | 权重（owner 决策示例） |
|---|---|---|---|---|
| `p_diagnostic_info` | 表现 | `mfiScore`/`klpScore`（`selection-signals.ts`） | + | `w_diag` |
| `p_mastery_gap` | 表现 | `1 − mastery`（`getMasteryProjection`，`state.ts:280-338`） | + | `w_gap` |
| `p_misconception_recur` | 表现(错因) | `misconceptionRecurrence`（`candidate-signals.ts`，现 flag-gated） | + | `w_recur` |
| `p_goal_relevance` | 内容 | KC ∈ active goal scope（现 `rerankOverdueByGoals` 的 binary） | + | `w_goal` |
| `p_prereq_unblock` | 内容(KG) | **候选自身**图位置：该 KC 是某弱 KC（user_state.θ̂ 低）的直接 prerequisite（per-candidate 从 `knowledge_edge` + user_state 算，**非「召回源 3 捞到了它」**） | + | `w_prereq` |
| `p_exam_relevance` | 内容 | `examRelevance`（现 computation-deferred stub） | + | `w_exam`（gated，无 reader 前=0） |
| `p_frustration_abandon` | 表现(负) | 预测放弃/连错沮丧（见下「负信号建模」） | **−** | `w_frust < 0` |

> **`p_prereq_unblock` 的 Source⊥Scorer 修正（C1）**：它必须是**候选自身相对 user_state 的图特征**（「这个 KC 是某个弱 KC 的直接前置」，per-candidate 可算、batch-无关），**不能是「召回源 3 选中了我」**——后者会让分数依赖召回集组成，重新引入 batch 依赖、破 Source⊥Scorer。
>
> **`p_overexposed` 不在此表（C2/D4）**：曝光/多样性是**第三类关注**（既非内容轴亦非表现轴），在 X 里是后置乘子不是 head。把它当线性 head 会与下面的多样性乘子**双重计数**。故从 head 表删除，归入后置乘子。

```
linear_sum(candidate) = Σ_head  head_score · w_head          （含负权重负信号）
value(candidate)      = clamp_offset(linear_sum)
                          × diversity_decay_multiplier(position, KC)   （多样性，后置乘子）
                          × cold_start_exploration_multiplier(evidence_count)  （冷启探索，后置乘子）
```

**负信号建模（线性和内的负 head）**（抄 X NEGATIVE_FEEDBACK_INDICES 的极性纪律，引 §5 home-mixer ranking_scorer 而非 §4.4.5 phoenix——phoenix 前向路径未消费负 head）：
- `p_frustration_abandon`：用 `θ̂ − b` 过大（题远超能力）+ 近期连续 failure streak（event 流）估「会沮丧/放弃」概率，**负权抑制**。day-one 先验可算（θ̂ 默认 0 + b 锚），不依赖数据。
- **负信号也进 user_state 输入表示（D2，借 X §4.4.3 `actions_signed = 2*actions − 1`）**：过去做错/放弃的 item 在打分侧 user_state 里是**显式 −1 信号而非缺省/null**，而非仅作输出 head down-weight。这同时锐化召回（§3b 打分序列）与打分。
- 极性方向入代码（像 X home-mixer），**量级也入代码**（不像 X 藏系数）。

**后置乘子（核心之外，对齐 X §5 结构，C2/D3/D4）**：
- **作者多样性 → 学科/KC 多样性几何衰减乘子**：X 的「作者多样性几何衰减」映射成「同 KC 连续出现衰减」——`multiplier(position) = (1−floor)·decay^position + floor`，**乘在 linear_sum 之后**。现有 `roundRobinBySubject` 是其离散版，可升级成此连续乘子。`p_overexposed`（同题/同家族近期已练）折进此乘子，**不再作线性 head**（避免双重计数）。硬 dedup 仍在容量护栏层。
- **冷启动探索乘子（对齐 X OON 乘子，非线性 head）**：冷启动用户给 linear_sum **乘**一个探索因子（多喂诊断/前沿），随 `evidence_count` 增长衰减到 1（利用）。X 把 OON 作乘子（带 topic→new-user→default 优先级）正是为了让探索不被其它 head 在线性和里淹没——我们照此结构，不把探索塞进 `w_diag`。

**权重纪律（关键差异点）**：
- **显式数字、owner 决策、入代码可 diff**：权重存 **`[新建] src/core/recommendation/weights.ts` 常量**（或挂 `SubjectProfile` 字段，见 §4 与 §6.7——后者是真 schema 变更，触发 `pnpm audit:profile` / `scripts/audit-profile.ts` / `SubjectProfileSchema` 校验，非免费 toggle），**不学习**——我们 n=1，无训练信号去 learn（§10 反向洞见 1）。
- **不藏系数**：恰恰反着 X §7「隐藏系数」做。每次调权是一次 commit，evidence-first（可 review、可回滚）。
- **owner-tunable 但有护栏**：权重改动经 `audit:profile` 校验（若挂 SubjectProfile）；`clamp_offset` 防止单 head 主导（抄 X `NEGATIVE_SCORES_OFFSET` 重标定思路，但用**确定性 clamp** 而非 X 缺席的 `score_normalizer.rs`，§9——借意图不抄看不到的代码）。

### 3(d) 内容理解独立层（grox 映射）

**X**（§4.5）：grox 是独立的 asyncio 多进程内容理解层，9 条并行 plan，VLM 做 banger/spam/PTOS/多模态 embed，**写回 Strato 给下游召回/排序用**。是 2026 全新增量。eligibility gate「8/9 plan 立即返回 None」体现其非阻塞性。

**映射 —— 已存在，本设计正式确立契约**：
- **录入→tagging→judging pipeline = 我们的 grox**：`src/capabilities/ingestion/` + `tag-knowledge.ts`（KC 标注，对应 banger 主题分类）+ `item_prior_backfill`（难度分类 b，对应质量分）+ `embed_backfill`（多模态嵌入）+ 整页 Opus vision 判分（YUK-488，对应 grox VLM 兜底，记忆 `whole-page-vision`）。
- **独立、异步、可缓存的 annotation 层**：这些都已在 pg-boss worker 夜间跑（§2.5 job 链），结果写回 DB 表（`question.knowledge_ids` / `item_calibration.b` / `question.embedding` / `question.reference_md`）——正是「grox 写回 Strato，我们写回 KG/DB」（§10）。这一层产物正是 §3(a) 缓存「候选侧半」的来源。
- **本设计的契约确立**：引擎（§3a-c）**只读 annotation 结果，从不内联触发 annotation**（保持解耦）。annotation 缺失 → 引擎用先验兜底（`effectiveB` → difficulty proxy，`mastery` → θ=0 默认），**不阻塞选题**（对应 grox eligibility gate「8/9 plan 立即返回 None」的非阻塞性）。
- **整页 vision > 本地切割**（记忆 `whole-page-vision`）对应 grox「VLM 兜底」分层：判分不裁图，整页 Opus 看图独立解 + 读手写 + 评分。已验证（合成卷 + 真手写卷）。

### 3(e) 冷启动专路（priors-first，路径选择 ≠ 单模型权重微调）

**X**（§6/§10）：新用户走 gRPC 实时性别预测 + 单独 topic 召回 + **冷启动专用 Phoenix 簇**（独立簇，非主模型上调一个权重）+ OON 乘子——**连 X 都给冷启动单独建先验路径，不指望主模型从零学**。

**映射 —— 镜像 X 的「冷启动专路 = 路径选择」事实（D3 修正）**：
- **day-one 先验来源（已存在，本设计声明为正式专路）**：thin-seed（3 root，§2.5）+ FSRS 间隔重复理论（默认 ts-fsrs 参数，`fsrs.ts:35-46`）+ KG prerequisite 拓扑（§3b 源 3）+ ItemPrior 难度锚（§2.5）+ KLP 冷启信息打分（`klpScore`，`EARLY_KLP_ENABLED` LIVE）。
- **冷/暖门控 = X 的冷启动簇 vs 主簇（真·路径选择，不是权重微调）**：`evidence_count < EARLY_KLP_N(=4)` → KLP（后验加权 Fisher，冷）；否则 MFI（点 Fisher，暖）。**这本身就是 live 的「单独冷启动打分路径」**（`candidate-signals.ts`）——对应 X 的独立冷簇。本设计把冷启动框成**路径选择**（走 KLP 冷路 vs MFI 暖路），而非「在单一价值函数里调一个探索权重」。
- **冷启探索做后置乘子**（§3c，对齐 X OON 乘子）：在冷路上额外 **乘** 探索因子（多喂诊断/前沿），随 `evidence_count` 衰减——不塞进线性 head 权重。
- **显式拒绝「让模型学一切」**（§10 反向洞见，记忆 `feedback_cold_start_first` + `feedback_defer_flip_not_build`）：
  - n=1 无 batch、无持续训练流、无 5% 采样——「让 transformer 做重活」在我们这=冷启动死循环（无数据→无模型→无推荐→无数据）。
  - **手工特征/先验规则是 day-one 唯一可用来源，是资产不是债务**。FSRS 理论 / KG prereq / 错因分类 day-one 就能算。
  - **不引入任何「等数据翻 flag 才能用」的 day-one 依赖**。数据门只 gate 价值函数权重的 **firm-up**（n=1 后的精炼），不 gate day-one 可用性。

---

## 4. 数据与 schema 影响

**核心原则：尽量零新表。** 引擎是 pure-compute 层，读现有三轴表 + 边 + 嵌入，分数写进现有 `practice_stream_item.signals` 槽的 `signals.rec` 子命名空间。

### 4.1 不新增表（首选路径）

- **打分 breakdown** → 写 `practice_stream_item.signals` JSONB 的 **`signals.rec` 子键**（`schema.ts:1264`，现 default `{}`）。在 JSONB 列里加子键**不触发 `audit:schema`**（它只审 top-level 列，不审 JSONB 子键，见 `scripts/audit-schema-writes.ts`），所以躲过 5-surface 登记舞。**但**：`signals` 快照是 π_i / active-PPI 标定 provenance 的一部分（`schema.ts:1397,1421-1422`，标签不可恢复）——故推荐分**必须**隔离在 `signals.rec` 子命名空间，**绝不混入 `SelectionCandidateSignal` 标定字段**，并有单测守此边界（§3a）。
- **权重** → **`[新建] src/core/recommendation/weights.ts`** 常量 + 可选挂 `SubjectProfile`（`profile-schema.ts`）字段 `recommendationWeights`（per-subject owner 调权）。**注意**：`recommendationWeights` 字段今天不存在，加它是真 schema 变更，须过 `pnpm audit:profile`（`scripts/audit-profile.ts` / `SubjectProfileSchema`）——是成本不是免费 toggle（见 §6.7）。
- **user 表示向量** → 不持久化，每次选题从 `mastery_state` + event 流即时聚合（§3b 是先验聚合非训练 encoder，便宜）。或若需缓存候选侧半，复用 `practice_stream_item.signals.rec`。
- **active-PPI 资产** → 已有 `selection_observation`（`schema.ts:1405-1429`）+ `difficulty_calibration_label`（`schema.ts:1069-1098`），不动。

### 4.2 若必须新表（gated-future，仅当 user 表示升级为持久化 encoder）

若 Phase 3+ 决定持久化 user-state 嵌入或打分缓存，**新 pgTable 登记 5 处**（记忆 `reference_new_pgtable_registration_surfaces`，**路径已对账修正**）：
1. `src/db/schema.ts`（表定义）
2. drizzle migration（`pnpm db:generate`）
3. `scripts/audit-schema-allowlist.json`（若有暂无 write path 的字段，标 `resolves_when`）
4. **`src/server/export/constants.ts`**（**非** `export-constants.ts`）：`FK_ORDER`（`constants.ts:99`，派生投影进 FK_ORDER 非 BACKUP_EXCLUDED）+ bump `SCHEMA_VERSION`（`constants.ts:54`，当前 `'4.9'`）。reverse-lockstep guard（`reverse_lockstep.db.test.ts` / `archive.ts:92`）在模块加载期对每个新 `FK_ORDER` 表强制 `SCHEMA_VERSION` bump，漏 bump 会 throw 崩备份测试 collection。
5. **`tests/helpers/db.ts`** 的 `ALL_TABLES`（`:24`，`resetDb()` 截断登记表）——这是**测试 hermeticity 面，非生产 `src/db/` 代码**（`ALL_TABLES` 不在任何非测试源文件，经 `grep` 核验）。

但 **Phase 1/2 目标是不碰这条**——零新表。

### 4.3 不可碰的红线

- **「subject is a view」**：引擎按 `effective_domain` 派生学科（`resolveSubjectKnowledgeIds`，`domain.ts:63-107`），**绝不给任何实体加 subject/domain 列**，绝不 restructure 树。相似召回/打分都走派生轴。
- **三轴正交（ADR-0035）**：引擎 **只读** `material_fsrs_state` / `mastery_state` / `item_calibration`，**永不写**（守 `candidate-signals.ts:14-15` 单写者纪律）。打分信号绝不回流进 `updateThetaForAttempt`（守结构性切断 `:224-227`）。
- **draft_status 排除**：召回的每个新入口都必须带 Gate-B 谓词 `or(isNull, ne('draft'))`（§2.4）。
- **π_i / 标定 provenance 不污染**：推荐分只写 `signals.rec`，绝不 mutate `SelectionCandidateSignal` / `selection_observation` 标定字段（§4.1，单测守）。
- **不删 pre-AI feature**：FSRS due-list、题库、组卷、quiz 全保留；引擎是 additive 软重排/补召回，`SELECTION_POLICY` kill switch 可整层退回 legacy 确定性。

---

## 5. 分阶段落地

原则（记忆 `feedback_defer_flip_not_build`）：**build + wire + UI 先穿到 live，只 defer 最终翻转**（绑数据 harness 的权重 firm-up）。

### Phase 1 — `scoreCandidate` 确定性内核（candidate isolation，**与 LLM 编排并存**）
- 把 `mfiScore`/`klpScore`/`diagnosticScore` + goal binary + misconception 收口进单一 `scoreCandidate(user_state, candidate)` 纯函数（**`[新建] src/core/recommendation/score.ts`**）。
- action head 结构 + 显式权重常量（**`[新建] weights.ts`**），day-one owner 拍初值。
- 接入 `composeSoftmaxStream`：`scoreCandidate.value` 作确定性 base，**与 `SelectionOrchestratorTask` 并存**；owner cut-over 前 π_i sampler 语义 + ADR-0042 weight-sharing **byte-preserve**。`breakdown` 写 `practice_stream_item.signals.rec`。
- **单测**：①batch-invariance（两候选集断同一候选**内核** `value` 相等，仅 LLM-off 路径）；②determinism replay；③`signals.rec` 隔离守卫（不触 π_i / 标定 provenance）。
- **不 defer**：直接 live（内核与 LLM 并存，行为可经 `SELECTION_POLICY=legacy` 回退）。**派 opus 写**（不变量 / parse-barrier 代码，记忆 `feedback_sonnet_weak_on_invariant_code`）。

### Phase 2 — brute-force 内容相似召回 + KG prereq 源 + 序列分段
- **先做验证项**：核「错题池 mean-pool · 候选文本嵌入」点积与有用性相关（§3b），相关才接召回源。
- user 表示先验聚合（错题/弱 KC 文本嵌入加权 mean-pool）；召回用精简正向序列，打分用含负信号序列（§3b 分段）。
- candidate 表示 = 现有 `question.embedding`（**首次被 SELECTION 路径读**——供给侧 `pool-fetch.ts` 已读，选题侧此前为空）。
- brute-force top-K（pgvector `<=>` 或内存点积），union 进非 due 候选池。
- KG prerequisite traversal 作召回源（复活 §2.3 缺口）；若接 `applied_in` 召回，**同 PR 补 `CONSUMER_REGISTRY` 条目 + `file:marker`**（§3b）。
- **UI 穿透**：召回来源标进 `practice_stream_item.reasoning`（人类可读 provenance，现有列）。
- **不 defer**：召回直接 live；user 表示聚合是先验，无数据依赖。

### Phase 3 — 负信号 + 后置乘子 + 冷/暖路径选择
- `p_frustration_abandon` 负 head（day-one 先验可算）+ 负信号进 user_state 输入表示（signed，§3c D2）。
- **多样性几何衰减乘子**（吸收 `p_overexposed`，不双计）+ **冷启探索后置乘子**（随 `evidence_count` 衰减，§3c）。
- 冷/暖**路径选择**升级（KLP 冷路 vs MFI 暖路，§3e），非单模型权重微调。
- **UI**：`/today` 或 `/practice` 展示「为什么推这题」breakdown（evidence-first，对应教研团「摆理由」愿景 YUK-405）。
- **不 defer**：负 head / 乘子先验可算，直接 live。

### Phase 4 — 权重 firm-up（**唯一 defer 翻转**）
- 用 `selection_observation`（π_i）+ `difficulty_calibration_label`（active-PPI/AIPW）retro-validate 权重。
- **数据门只 gate 这一步的翻转**：攒够 label 后 owner review retro-validation 结果，决定是否调权（**不自动学习**，owner 决策的显式调整）。
- 这是 n=1 的「精炼非前提」——day-one 已可用，firm-up 是 polish（记忆 `feedback_cold_start_first`）。

### serving 形态决策（见 §6）
- **Phase 1-3 复用现有**：online 算（inline route，like 现 `SelectionOrchestratorTask`）+ 夜间预计算（`practice_stream_compose_nightly`）双路已在。引擎插这两路，**不新增 serving 形态**。候选侧缓存半夜间物化，user 半白天实时。

---

## 6. 开放决策（owner 拍板）

1. **augment vs replace scope**：本设计提案 **augment**（引擎软重排 + 补召回，FSRS due 仍是 L1 硬门，legacy kill switch 在）。是否要更激进——让 `scoreCandidate` 也参与 **due 项的 set 决策**（而非仅展示序）？默认建议：**不**（守 invariant 6，FSRS due 是 evidence-backed 调度真相）。
2. **online-serve vs pg-boss precompute**：引擎打分放哪？(a) inline route（白天实时，like 现 LLM 编排，延迟敏感）；(b) 夜间 pg-boss 预计算（写 `practice_stream_item`，白天读表，省延迟省 token）。默认建议：**夜间预计算候选侧半 + 白天 lazy-compose user 半兜底**（复用现有双路 + 对齐 §3a 缓存拆半），与现状一致。
3. **价值函数权重激进度**：权重初值多激进？(a) 保守——引擎只微调 FSRS 序（小权重）；(b) 激进——引擎主导非 due 选题（大权重）。涉及 §3(c) 的 `w_*` 初值。owner n=1 体感决策。
4. **feed/today 新面 vs 仅重排现有队列**：是否新增一个「教研团备好的今日推荐 feed」面（对应 X For You + YUK-405 「为你而备」愿景），还是仅重排现有 review/practice 队列？默认建议：**Phase 1-3 仅重排现有队列**（最小风险）；新 feed 面留 Phase 4+（绑 YUK-405 教研团 UI）。
5. **LLM 编排去留**：`scoreCandidate` 内核确定性后，`SelectionOrchestratorTask`（LLM 软重排）保留还是删？保留=多一层软能动性（记忆 `feedback_ai_agency`）但多 token/延迟/**非确定性 + 破候选隔离/缓存**（§3a A1）；删=纯确定性可缓存可隔离。默认建议：**保留为可关叠加层**（parse-barrier 后，挂 no-cache/no-isolation 语义），默认由 `SELECTION_POLICY` 决定；§1.1 不承诺一次性「重构掉」。
6. **applied_in 死边**：是否借 §3b 源 3 给 `applied_in` 一个 specialized 消费者（应用题召回），从而清掉 audit-relations 唯一死边（YUK-357）？若接，**须同 PR 补 `CONSUMER_REGISTRY` 条目 + `file:marker`**。owner 另决策是否升级 `audit:relations` 为 CI gate（现 report-only）。
7. **权重存哪**：`weights.ts` 全局常量 vs per-subject `SubjectProfile.recommendationWeights`？后者 owner 可分科调，但 `recommendationWeights` 是**新增 profile 字段=真 schema 变更**，须过 `pnpm audit:profile`（`scripts/audit-profile.ts` / `SubjectProfileSchema`），非免费 toggle。

---

## 7. 与 Linear 的关系

### 7.1 Home issue

**YUK-405**（私人教研团 · AI-native rethink，推荐引擎/算法主线，High，Todo，project「私人教研团 — AI-native rethink」，经 Linear 核实）。本设计是该 issue「关系脑 / 推荐引擎」愿景的算法架构落地——X 映射给 YUK-405 的「为你而备、async 协作感」一个具体的 evidence-first 打分/召回机制。北极星「记录 derivation-path、别让 question 表成内容唯一真相源」与 §3(d) 内容理解独立层契约一致。

### 7.2 建议 follow-up issues（待 owner 批准创建）

- **[新] 推荐引擎 Phase 1：`scoreCandidate` 确定性内核（与 LLM 编排并存）+ 显式价值函数权重**（YUK-405 子，依赖 §3a/§3c）。Refs YUK-405。
- **[新] 推荐引擎 Phase 2：brute-force 内容相似召回 + KG prereq 源 + 召回/打分序列分段**（YUK-405 子，依赖 §3b）。Refs YUK-405。可顺带推进 **YUK-357**（`applied_in` 死边——§3b 源 3 给它 specialized 消费者，须补 `CONSUMER_REGISTRY`）。
- **[新] 推荐引擎 Phase 4：权重 active-PPI firm-up 翻转**（gated-future，绑 `selection_observation` harness，依赖 §5 Phase 4）。Refs YUK-405。
- **关联既有**：`examRelevance`/`transferGap`（现 computation-deferred stub，`selection-signals.ts:58-70`）是 §3(c) 内容轴 head 的填充工作；`MISCONCEPTION_RECURRENCE_ENABLED`（现 dark-ship）的翻 flag 是 §3(c) 错因 head 落 live 的前置——这两项是引擎落地的自然消费方，建议在 Phase 1/3 内顺带捕获，不单拆碎片化 issue（记忆 `feedback_no_scope_fragmentation`）。

### 7.3 文档同步

按惯例（记忆 `feedback_docs_sync_to_linear`），本 repo doc 落定后用 `save_document` 同步成挂 YUK-405 的 Linear Document 镜像（repo 为源、Linear 为镜像）。

---

## 附：核心 grounding 索引

- **选题流水线（借鉴目标的家）**：`src/core/selection-signals.ts`（信号形状+打分，纯函数）/ `src/server/ai/selection-orchestrator.ts:80-114`（LLM 加权，batch-aware）/ `src/capabilities/practice/server/softmax-selection.ts:198`（sampler + 三路两兜底 + L1 `statisticalWeights:479`）/ `src/capabilities/practice/server/candidate-signals.ts:473`（信号收集，零边/零 embedding 读）/ `stream-composer.ts:60-135`（确定性兜底）/ `src/capabilities/practice/manifest.ts:239`（default 策略接线）
- **三轴正交边界**：`src/capabilities/practice/server/candidate-signals.ts:14-15,224-227`（结构性切断）/ `src/server/mastery/state.ts updateThetaForAttempt`（p(L) 单写者）
- **KG 边消费**：`scripts/audit-relations.ts:86,96-103`（CONSUMER_REGISTRY + 死边 `applied_in` + 三层分级）/ `src/server/ai/tools/knowledge-readers.ts:724-773`（paths traversal）/ `src/capabilities/knowledge/server/topology-gate.ts`（prereq 诊断）
- **嵌入消费者（精确）**：`src/server/quiz/pool-fetch.ts:106,112`（question SUPPLY `<=>` cosine）/ `src/server/quiz/matcher.ts:1,45`（caller-agnostic 仲裁）/ `src/capabilities/knowledge/server/match-similarity.ts:10`（knowledge KC-tagging/cold-start `<=>`，自述镜像 poolFetch）/ `dedup-flags.ts`（近重）—— SELECTION 路径（softmax/candidate-signals/due-list）**零 embedding 读**
- **冷启动**：`src/capabilities/knowledge/server/seed.ts`（thin seed 3 root）/ `src/capabilities/knowledge/server/tag-knowledge.ts:145-310`（match-or-propose）/ `src/capabilities/ingestion/server/cold-start-bridge.ts`（空 knowledge_ids 桥）/ `klpScore`（冷簇 vs MFI 暖簇路径选择）
- **schema 锚点**：`question.embedding`（`schema.ts:269`）/ `knowledge.embedding`（`schema.ts:91`）/ `practice_stream_item.signals`（`schema.ts:1264`，default `{}`，写 `signals.rec`）/ `selection_observation.signals`（`schema.ts:1421-1422`，π_i 不可恢复，不污染）
- **新表登记面（精确路径）**：`src/server/export/constants.ts`（`SCHEMA_VERSION:54`='4.9' / `FK_ORDER:99` / `archive.ts:92` reverse-lockstep）/ `tests/helpers/db.ts`（`ALL_TABLES:24`，测试面非 `src/db/`）
- **evidence 留痕**：`src/server/ai/log.ts`（三表，effect=read|propose|write）
- **X 报告**：`docs/research/2026-06-25-x-algorithm-deep-dive.md` §4.4（Phoenix 双塔/候选隔离）§4.4.3（signed actions）§4.4.5（phoenix 未消费负 head）§5（加权和 + 多样性/OON 乘子，home-mixer 藏系数，score_normalizer 缺席）§6（retrieval ⊥ scoring 序列 + 冷簇）§7（核验/heuristics 退守）§10（迁移映射 + 反向洞见）
