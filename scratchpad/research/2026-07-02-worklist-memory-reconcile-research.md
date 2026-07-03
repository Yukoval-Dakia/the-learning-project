# 单元 #9 memory-reconcile-policy — Research Dossier

**Register worklist**：line 173（rationale-corrected line 1153）。**Base**：main@0291987e。三腿并行调研（code-ground / 学术文献 / 产品源码先例），本 doc 为 synthesis，不抹平三腿间的分歧。

---

## 单元与打磨目标

register 定级 P1（proven prior data-loss precedent，见 PR #405 addendum）。诉求核心：`src/server/memory/reconcile-llm.ts` 里一个**单一 LLM 自报置信度标量（0.6 阈值）**是 MERGE/RETRACT_NEW/SUPERSEDE 三种破坏性动作**唯一的自动化闸**，且 MERGE/RETRACT_NEW 的执行路径含**真 SQL DELETE、无墓碑**，被删/被覆盖记忆的**原文从不落 WAL**。方向已被 register 圈定：加非 LLM 佐证信号 + 便宜结构性界（tombstone/log/cap，明确排除重型 ensemble）。

---

## Code-ground（现状 + stale 标注 + 残留缺口）

### 写路径全链（event → mem0 add → reconcile → apply）

1. **入口**：ADR-0021 transactional outbox（`event.ingest_at IS NULL` 轮询）→ `MEMORY_EVENT_INGEST_QUEUE` → `buildMemoryEventIngestHandler`（`src/server/memory/triggers.ts:296-347`）。
2. **抽取闸**：`shouldExtractToMemory`（triggers.ts:226-228）只放行 `actor_kind==='user'` 事件进 `client.addEventMemory()`（`infer:true`，client.ts:185-208）——与本单元正交（ADR-0039 §7 H6 反注入闸）。
3. **调和入队**：`enqueueMemoryReconcile`（triggers.ts:273-294），`singletonKey: memory.reconcile.${userId}`、`singletonSeconds:90`、`singletonNextSlot:true`、`retryLimit:3`。
4. **调和 handler**（`buildMemoryReconcileHandler`，triggers.ts:477-679）：
   - a. Job 起手先 `applyPlannedRows` 重放上轮未 apply 的 WAL 行（幂等游标）。
   - b. 对每条新 memory：`client.search(text, {topK:31, filters:{user_id}})`——内部走 mem0 `Memory.search()`（`mem0ai/oss` dist/oss/index.mjs:6804-6972）：向量 cosine（PGVector `<=>`，index.mjs:4670-4692，`score=clamp(1-distance,0,1)`）⊕ BM25 ⊕ entity-boost 融合 rerank，**默认 `threshold=0.1`**（index.mjs:6820，项目未覆盖）。每条候选自带 `score`。
   - c. **但** `CandidateEntry` 类型（`reconcile-llm.ts:48-53`）只取 `{index,text,memory_id,created_ms}`——triggers.ts:545-554 候选构建循环**从不读取 `r.score`**，该字段被就地丢弃。
   - d. `judgeReconciliation`（reconcile-llm.ts:295-404）单次调用 GLM-5.2（`temperature:0.1`），prompt 明确告诉模型"低于 0.6 系统会降级为 KEEP_BOTH"（reconcile-llm.ts:148-150）——模型自报一个用于跨过它自己已知阈值的置信度。`applyConfidenceThreshold`（reconcile-llm.ts:274-288，`CONFIDENCE_THRESHOLD=0.6`，常量 :18）是**全链唯一**能拦下 SUPERSEDE/MERGE/RETRACT_NEW 的自动化闸；`===0.6` 放行。解析层容错：`Number(d.confidence)||0`（:257）——缺失/非数字时安全默认 0（fail-closed，正面细节）。
   - e. `makePlannedRow`（triggers.ts:586-596、633-644）构造 WAL 行，`llm_raw={...d, new_created_ms}`（`d`=GLM 的 `ReconcileDecision`）——**不含 `text`、不含候选 `score`**。`PlannedRow` 类型（reconcile-store.ts:26-35）本身无这两个字段的位置。
   - f. `insertPlannedRows` 写入 `memory_reconciliation_log`（`src/db/schema.ts:1504-1523`：仅 `id/user_id/new_memory_id/old_memory_id/action/reason/llm_raw(jsonb)/planned_at/applied_at`），**在 apply 之前**（write-ahead）。
   - g. `applyPlannedRows`（triggers.ts:685-758）按 action 执行：
     - **SUPERSEDE** → `softSupersede`（reconcile-store.ts:67-88）：jsonb 浅合并 `payload`，非破坏（行仍在）。
     - **MERGE** → `rewriteMemoryText`（:106-124）就地覆写 OLD 行的 `payload.data`+`created_ms`（**覆写前值不被捕获**）→ 再 `hardDeleteMemory`（:131-148）删 NEW 行——**真 `DELETE FROM "<collection>" WHERE id=...`**。
     - **RETRACT_NEW** → 直接 `hardDeleteMemory` 新行。
   - h. `markApplied` 打 `applied_at`。

### DELETE 落点与可恢复性
- `hardDeleteMemory` 打在 mem0 **自建**的 pgvector 表上（`CREATE TABLE IF NOT EXISTS (id UUID PRIMARY KEY, vector vector(dims), payload JSONB)`，mem0ai dist/oss/index.mjs:4592-4598）——该表 DDL **无软删列**，且不受 Drizzle 迁移管理（无 `pgTable` 导出，显式排除出 `FK_ORDER`，`src/server/export/constants.ts:36-43`、`constants.test.ts:246`）。
- 唯一"恢复"路径是 `archive.ts` 整表 dump/restore 分支（YUK-355，:26-221）——**全库**灾备快照（一次性 wipe 30+ 张表回到某个时间点），**不是**针对单条决策的定向 undo。
- **精度细分（code lane 显式区分，register 未细分）**：项目"AI 行为可追溯可回滚"不变量有两半——**可追溯（WHY）已满足**（`reason`+`llm_raw` 记录每条决策理由/置信度，genuinely auditable）；**可回滚（WHAT）不满足**（被删/被覆写的实际内容不可恢复）。设计 doc 应把 P1 判定精确落在"可回滚"这半。

### 幂等设计（保护重放正确性，不保护决策正确性）
- `softSupersede`：jsonb 合并，逐字幂等。`hardDeleteMemory`：吞 `not found|does not exist|42P01`（:141-146），可安全重放。`markApplied`：无条件 `UPDATE`，重放无害。`rewriteMemoryText`：`newCreatedMs` 来自**持久化**的 `llm_raw.new_created_ms`，重放字节相同。
- 幂等设计保护的是"同一决策被重放两次"，与"这条决策本身是否该做"正交——一个自报 0.6+、内容却错的 MERGE，会**幂等地、精确地按设计重放它自己的错误**。幂等性不能替代正确性闸。

### pg-boss 并发（独立轴，非本单元范围）
- `registerMemoryHandlers`（:920-923）`{pollingIntervalSeconds:2, batchSize:1}`；`reconcile-store.ts:163-171` 逐字注释：**未行锁**，序列化只靠 singletonKey + 单 prod worker；逃生阀 "Add FOR UPDATE SKIP LOCKED... only if a real multi-writer prod topology appears"，**显式挂 YUK-345**。这是 register 独立单元 `mem0-addonly-scope-split-brain`（line 175）的范围——与本单元"决策正确性闸"正交，仅共享文件。

### register 诉求逐条 fresh/stale 判（code lane）

| 诉求 | 判定 | 依据 |
|---|---|---|
| 0.6 自报置信标量是唯一自动闸 | **FRESH** | `applyConfidenceThreshold` 是全链唯一拦截点 |
| 真 SQL DELETE 无墓碑 | **FRESH** | `hardDeleteMemory` 字面 DELETE；目标表无软删列且脱管 |
| WAL 只存元数据不存原文=不可恢复 | **FRESH** | 逐字段核对 schema + 每个写入点，原文从未落库 |
| 每个 live 用户事件都在跑 | **FRESH** | 队列端到端已注册，无 feature flag |
| Addendum：PR #405 是可见性 bug 非字面销毁、已修 | **FRESH，独立复核通过** | `git show 1cf1ca45` 确认修的是 `softSupersedeWithText` 误标 `superseded`（P3 读过滤隐身），非 DELETE bug；P1 判断不靠此先例，落在独立的结构性事实上 |
| SKIP + YUK-345 并发权衡 | **FRESH，且正确划归独立轴** | 逐字比对无误 |
| 加非 LLM 佐证信号（polish order #9 / F4） | **方向成立，且比 register 原文更便宜** | 佐证信号**已经算出来、正在被静默丢弃**（`Memory.search()` 底层 score）；零新增 embedding 调用、零新增 DB 往返 |

### 残留缺口（code lane 独立发现，register 未讲透）

1. **RETRACT_NEW 无天然佐证靶点**：`old_index` 可为 null（reconcile-llm.ts:242 只强制 SUPERSEDE/MERGE 携带），一个"候选 score 支撑该决策"式地板在无被引用候选时无处可挂——需要独立设计决策（强制带 index？还是换 volume cap）。
2. **mem0 默认 `threshold=0.1`** 已做一次极弱预过滤（index.mjs:6820），不足以充当有意义地板；需要独立于此的、专为本目的设定的更高阈值。
3. **零 observability**：核对 `ai-observability.ts`/`cost-today.ts`/`src/capabilities` 全树——无任何路由读 `memory_reconciliation_log`，无 MERGE/RETRACT_NEW 量/率仪表盘。F4"log"目前**完全未实现**。
4. **捕获原文改动面比 register 暗示的更小**：`newMem.text`/`oldMem.text` 在 `makePlannedRow` 调用点本就在作用域内，塞进已有 `llm_raw` jsonb **零迁移**；但真正"可回滚"（重新插回 mem0、带活向量）还差一步（删除前 `SELECT vector`，或接受"restore=重新 embed 归档文本"）。
5. **无管理面读取 WAL**：即便文本/向量快照存在，目前无路由可浏览待决/已 apply 决策或触发 restore——需净新增 UI/API 面。

### 改动面预估（三候选方向，非选型建议）

- **A. 非 LLM 佐证信号**：`CandidateEntry` 加 `score?`；候选构建循环塞入；新增与 `applyConfidenceThreshold` 平行的降级判断；需决定 RETRACT_NEW null-old_index 分支怎么办。量级 ~20-40 行跨 2 文件，**无迁移、无新外部调用**——三候选里改动面最小。
- **B. 便宜结构性界（cap/log）**：cap 目前无天然消费者可挂，需新增计数查询；log 最小版本极便宜（`applyPlannedRows` switch 里加一行结构化日志），仪表盘是更大独立增量。**"winsorize" 大概率不适配本单元二元 action 空间，更贴 `default-softmax-selection-policy`，设计 doc 需核实是否误挂**（code lane 明确提出的疑问）。
- **C. 结构性可恢复**：最便宜子选项——原文塞进已有 `llm_raw`（~5 行，零迁移）；完整子选项——连向量一并快照（各调用点前加 `SELECT`，仍零迁移，复用 `llm_raw` 或开 nullable jsonb 列）。**在 mem0 自建表上做原地墓碑列不可行**（不受 Drizzle 管理、每次 mem0 升级需重核）——register 的"tombstone"更自然落地为"归档进自己的 WAL 表"。让归档可用于 undo 的管理面是**净新增**、三块里最大的一块。

### 与 re-embed-on-merge-cross-cutting-gap（P2，同文件，register line 93/699-707）的边界
本单元问"0.6 是否足以**授权**破坏性动作"（apply 之前）；P2 假设 MERGE**已授权并 apply 完毕**，幸存行 `vector` 从未刷新以反映合并后文本（`rewriteMemoryText` 只写 `data`+`created_ms`，:100-104 docstring 自认）——下游检索相关性陈旧问题，非授权正确性问题。两者触碰同文件但不相交区域，修一个不需碰另一个。

### YUK-345 escalation 条款原文
逐字引自 `reconcile-store.ts:163-171`："Concurrency: NOT row-locked. Serialization relies on (1) enqueue singletonKey `memory.reconcile.<user>`, (2) a single prod worker with batchSize:1. ... Add FOR UPDATE SKIP LOCKED here ... only if a real multi-writer prod topology appears."

---

## 文献（带权威分级）

### 方向① LLM 自报置信度的校准可靠性
1. **Xiong et al., "Can LLMs Express Their Uncertainty?"（arXiv:2306.13063）**——**ICLR 2024**，Semantic Scholar 引用 **995**（API 核验）。verbalized confidence **系统性 overconfident**，跨 prompting 策略/模型持续存在。局限：测的是通用 QA/推理，非"MERGE/RETRACT 决策"结构化二元判断，跨任务泛化需谨慎。
2. **Yang et al., "On Verbalized Confidence Scores for LLMs"（arXiv:2412.14737，ETH Zurich）**——arXiv preprint，**UNVERIFIED-venue**，方法完整+代码开源可复现。≥70B 模型 verbalized confidence ECE≈**0.1**；极端案例 95.7% 报告置信度对应 23.3% 真实准确率（ECE=0.726）。给出量化数字，可直接类比 0.6 阈值的期望偏差。
3. **"Mind the Confidence Gap..."（arXiv:2502.11028）**——arXiv preprint，**UNVERIFIED-venue**，未独立核实引用量，降权处理。88% 口头置信度 vs 79% 真实正确率（~9pt gap）；distractor 会进一步扰动置信度输出——对 prompt 结构变化（候选数量/措辞）敏感这一发现，对本单元有间接启示。
4. **Kuhn/Farquhar/Kossen/Gal, "Detecting hallucinations...using semantic entropy"（Nature, 2024）**——**Nature 正刊**（IF~50），引用 **1393**（API 核验）。提出语义熵（多次采样聚类熵）替代/补充自报置信度，核心论点是**独立于自报置信度的信号更可靠**。局限：需多次采样成本更高；但本身是单模型多采样，非多模型 ensemble，不违反项目"排除重型 ensemble"红线。

### 方向② Agent 记忆系统 consolidation/forgetting 设计
5. **Park et al., "Generative Agents"（UIST 2023，arXiv:2304.03442）**——**UIST 2023 正式录用**，引用 **4623**（API 核验），agent memory 领域奠基作。reflection 是"新增"高阶记忆，**不删除/不覆写原始 observation**——业界最有影响力范式默认"不删原始层、只叠加新结构"，与 tombstone 方向一致。局限：模拟沙盒场景，无真实数据丢失后果。
6. **Packer et al., "MemGPT"（arXiv:2310.08560）**——arXiv preprint（后续以 COLM 2024 相关工作流通，**本次未能独立确认该确切版本录用记录**，UNVERIFIED-venue-upgrade），引用 **880**（API 核验）。热/冷层显式 primitive 搬运（store/retrieve/summarize/update），可控可日志。不直接处理"两条记忆是否 MERGE"语义仲裁，适用性中等。
7. **Chhikara et al., "Mem0: Building Production-Ready AI Agents..."（arXiv:2504.19413）**——**ECAI 2025 正式录用**（CCF-B 级），引用 **442**（API 核验）。mem0 核心正是"单个 LLM function-call 在 ADD/UPDATE/DELETE/NOOP 间选择"——**与本项目 0.6 置信度闸高度同构**。论文**未报告该决策步骤自身的独立校准信号/置信度阈值/可逆性保障**，可靠性验证只在下游 QA 整体准确率。**这直接支持：单一自报置信度闸门不是本项目独有疏漏，而是当前 agent-memory 生态普遍未打磨的弱点**。
8. **Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture"（arXiv:2501.13956）**——arXiv preprint，**UNVERIFIED-venue**，引用 **230**（API 核验），Graphiti 开源 20k+ star 弥补部分权重。bi-temporal 模型：冲突时旧事实标记 `invalid_at`（**不删除**），历史可按 `as_of` 重建。register 提到的 Graphiti bi-temporal invalidation 设计原型。局限：应用场景是知识图谱事实存储，本项目 memory substrate 是 mem0（ADD-only，BR-10）；但**语义原则可在自建 reconcile 层复刻，不冲突于 mem0 substrate**。

### 方向③ 不可逆动作前的护栏模式
9. **DeCandia et al., "Dynamo"（SOSP 2007）**——**SOSP 2007**（系统领域顶会），引用量级"数千次"（**未独立核验精确数字，标注为交叉检索高置信估计**，非本 session 直接核验）。tombstone + vector clock，有界 TTL 回收，非永久保留。局限：场景是分布式副本一致性防"旧副本复活"，动机与本单元不同，但落地形态可直接借用。
10. **Mohan et al., ARIES（ACM TODS, 1992）**——**ACM TODS**（数据库权威期刊，教科书级经典），引用未逐一核验（同上标注）。核心不变量：WAL 必须先落 log 且**记录足以重建被覆盖状态的信息（旧值/原文），而非仅决策摘要**才能支持真正 undo。**这是对本单元当前 WAL 缺陷最精准的对照**——现状"只存决策元数据"直接违反 ARIES undo-log 基本不变量。局限：面向单机/集群事务 DB crash recovery，非"AI 决策可能出错"场景，引入完整 undo log 需权衡存储成本。
11. **"Cordon: Semantic Transactions for Tool-Using LLM Agents"（arXiv:2606.17573）**——arXiv preprint，**发表约 2 周，无会议/期刊录用，几乎零引用**，**UNVERIFIED/强降权**。shadow state + effect outbox，验证后才 commit。仅作"业界正在往这个方向设计"的存在性证据，**不建议作为设计依据主要支撑**。
12. **Fellegi & Sunter (1969) / Binette & Steorts 综述（Science Advances, 2020）**——Fellegi-Sunter 原始模型统计学奠基（美国人口普查局标准化采用超 50 年）；综述发表于 **Science Advances**（IF~11），引用 **91**（API 核验，综述本身较新）。记录链接领域半世纪共识：**多信号加权+三档阈值（含"不确定"中间态）优于单一分类器**。为"加非 LLM 佐证信号"给出跨领域独立理论支撑。局限：面向结构化字段比对，memory 是自由文本，需用 embedding/text-similarity 代替字段级权重，是方法论迁移而非直接套用。

### 文献净指引汇总
三方向汇聚同一结论：**"单一自报置信度标量+硬删除"是文献已知薄弱组合；"多信号加权+留痕可逆"是三个独立领域（LLM 不确定性量化、agent 记忆系统、数据库/分布式系统）各自收敛的标准解**，不需重型 ensemble。关键落点：(a) text-similarity floor 有理论依据非权宜之计（来源4/12）；(b) 0.6 单点阈值可信区间应被质疑（来源2 ECE 数字）；(c) mem0 论文本身未解决这个问题，本单元是补业界共性洞（来源7）；(d) "只记决策元数据不记原文"违反 ARIES undo-log 不变量，应作为硬性验收标准（来源10）；(e) bi-temporal invalidation（来源8）+ tombstone 有界回收（来源9）是两种可直接落地、都不需真删除、天然满足 evidence-first 红线的结构性界原型，应在自建 reconcile 层实现（不改 mem0 substrate）；(f) Cordon 等极新研究仅方向性佐证，不作为主承重点。

---

## 产品先例（带一手引用）

### 0. 本项目现状 code-ground 锚点（oss lane 独立补充，与 code lane 互证）
- 闸位置与销毁不可逆性与 code lane 一致（`reconcile-llm.ts:17-18` `CONFIDENCE_THRESHOLD=0.6`；`reconcile-store.ts:131-148` `hardDeleteMemory` 真 DELETE；WAL 无原文）。
- **关键新发现（oss lane 独有，code lane 未提及）**：mem0 upstream 自带一套几乎正是 register 想要的"廉价结构性 tombstone"机制——`disableHistory: false` + SQLite `memory_history` 表，每次 `memory.add()/update()/delete()` 先捕获 `existingMemory.payload.data`（完整原文）再写一行 INSERT-only 历史记录。**本项目已启用它、已承担基础设施成本**（`better-sqlite3` 原生模块 + Docker `sqlitedeps` overlay + 生产命名卷 `mem0data:/var/lib/mem0`，`docker-compose.yml:83-85`），design doc `docs/design/2026-06-13-memory-architecture.md` §8.6 专门复盘过 native module 代价并由 owner 拍板保留。**但 P2 调和层三个销毁性写操作（`softSupersede`/`rewriteMemoryText`/`hardDeleteMemory`）全部走 raw SQL 直接操作 pgvector collection 表，从不调用 `memory.update()`/`memory.delete()`，因此从不触发 mem0 自己的 `db.addHistory()`**。§8.6 原文只回答了"P2 正确性要不要靠 mem0 history"（答案合理地是"不要"），从未被问过"mem0 history 能否作为 reconcile 销毁性动作的恢复后备"——reconcile job 与 mem0 add() 写入方同一 worker 进程（`scripts/worker.ts` 收敛，`client.ts:148-154`+compose 拓扑互证），同一个 SQLite 文件，**不存在接线障碍，纯粹是"从未被读回"的死角**。

### 1. mem0（一手实装 + 已装依赖双重核验，`node_modules/.../mem0ai/dist/oss/index.js`）
- v3 `addToVectorStore`（`mem0-ts/src/oss/src/memory/index.ts:762-1055`）是**纯 ADD-only 批处理**：Phase 2 只做抽取不做 update/merge/delete 判定；Phase 4-5 用 MD5 哈希做**精确去重**（非 LLM 结构性信号）；Phase 6 批量 insert + `db.addHistory(...,action:"ADD",previousValue:null,newValue:<完整原文>)`。旧版 LLM 驱动四态判定（`getUpdateMemoryMessages`）作为**死代码**留存——与本项目 `reconcile-llm.ts:108-111` 注释所指"mem0 3.0.7 LangchainLLM residual sniff 会劫持进旧 MemoryUpdateSchema"是**同一份历史遗留**，本次源码核验直接证实该注释所指残留代码确实存在。
- 真正的 `update()`（:1566-1574）/`delete()`（:1576-1593）是**显式、调用方主动触发**（非 LLM 自动判定）；`deleteMemory` 私有方法（:1856-1886，装机版 `dist/oss/index.js:7214-7238` 逐行一致）顺序：先取 `existingMemory.payload.data`（原文）→ 硬删 vector 行 → **写一行 `memory_history`（`previous_value=<原文>`, action=DELETE, is_deleted=1）**。History 表 INSERT-only、无 TTL、无自清理（`reset()`才 DROP）。**全程零置信度阈值**。
- **适配判断**：本项目问题不是"mem0 没提供"，而是"提供了、装了、付了成本，却被自建 reconcile raw-SQL 写路径绕过"。四家里唯一一个**本项目已部分具备、只差把两条已存在日志按 memory_id 关联**的方案，成本几乎为零。

### 2. Graphiti（getzep/graphiti，本项目 KG 半边已参考的一手实装）
- `graphiti_core/utils/maintenance/edge_operations.py`：两段式、全程无置信度标量——(1) LLM 一次结构化调用（`resolve_extracted_edge`，:623-847）输出 `duplicate_facts`/`contradicted_facts`（**离散 index 列表**，非 0-1 概率）；(2) 纯确定性函数 `resolve_edge_contradictions`（:538-573）比较时间区间重叠，重叠才 `invalid_at`/`expired_at`。**这条自动路径永不物理删除**，只写失效时间戳（bi-temporal，可按 `as_of` 回放旧真相）。真正硬删（`edges.py:59-115` `DETACH DELETE`）只在**显式人工触发、UUID 定标**的 `graphiti.py:1765-1793 remove_episode()` 出现，且逻辑上收窄（只删仅被该 episode 独占引用的边/节点）。
- **适配判断（oss lane 最强论点之一）**：Graphiti 把"自动 LLM 判定"和"硬删除"**架构性地隔离在两条不相交代码路径上**——自动路径最坏结果永远软失效（可逆），硬删永远需人类显式 UUID。与本项目现状（RETRACT_NEW/MERGE 由同一 0.6 自动闸直接触发硬删）直接对照：**不是给硬删加更高置信度门槛，而是自动判定路径根本不该有硬删这个动作可选**。本项目 `edge-reconcile.ts`（结构边）已是这个模式（`{KEEP_BOTH, SUPERSEDE}` 二元，SUPERSEDE 软归档到 `archived_at`，`misconception-reconcile.ts:26` 注释"MERGE/RETRACT_NEW are text-memory verbs with no [structural] analog"）——**唯独 memory（文本记忆）半边没有复用同一套软归档设计**，是项目内部既有的不一致，Graphiti 先例说明这不是"文本记忆天然需要硬删"，可被同一模式统一。

### 3. Letta / MemGPT（letta-ai/letta，一手实装）
- 无"reconcile judge LLM 二次裁决"层；agent 直接调用记忆编辑工具（`letta/functions/function_sets/base.py`）。两条**互不依赖置信度**的独立防线：(a) **结构性精度闸**：`memory_replace`（:311-388，fork 自 Anthropic 官方 computer-use quickstart `edit.py`）要求 `old_string` 精确出现且仅出现一次，`occurences==0` 或 `>1` 直接 `raise ValueError`（:364-373）——用"能否唯一定位"代替"有多大把握"；(b) **无条件版本化**：`letta/orm/block.py:52-61`，`Block.current_history_entry_id` FK + SQLAlchemy 官方 optimistic-locking `version` 列，**每次 mutation 都产生新 `BlockHistory` 行**，不经置信度筛选——四家里"可回滚"覆盖面最完整，是"所有写入都留痕"而非"低置信度才留痕"。
- **适配判断**：两个字面对应现成范式——(a) MERGE/SUPERSEDE 决策可加一层"候选池里有没有第二个同样像的"唯一性结构校验；(b) 版本化优于 WAL-元数据化，"每次写都留完整前后快照"比"只在低置信度时留痕"更简单也更robust。n=1/单用户场景下存储成本可忽略——**四家里综合成本最低、收益最直接**。

### 4. LangMem（langchain-ai/langmem，一手实装）
- `create_memory_manager`（`src/langmem/knowledge/extraction.py:540-570`）三 feature flag 中 **`enable_deletes` 默认 `False`**（`enable_inserts=True, enable_updates=True, enable_deletes=False`，:542-544）——删除是开发者必须显式打开的能力。即便打开，判定是**离散结构化工具调用**（`Remove` 动作携带 `json_doc_id`，:960），**全程无 confidence 数值字段**（:191/:203 的 p(x) 是教 LLM 怎么写记忆内容的 prompt 文案，非机器可读门控信号）。删除直通 LangGraph `BaseStore.adelete`（:1134,:1478,:1658）——**LangMem 自己不实现任何持久化/历史层**，硬删/软删完全由调用方接的 store 后端决定，LangMem 既不审计也不留痕。
- **适配判断**：四家唯一把"删除该不该发生"做成**默认关闭功能开关**而非"打分动态决定"的——态度层面参照（非机制细节）。如需立刻见效、零构建成本的止血闸："RETRACT_NEW/MERGE 硬删部分默认关闭、先全部落 SUPERSEDE（软归档），硬删单独开需更高门槛开关"是这套立场的直接映射。**注意局限**：LangMem 本身不提供任何恢复机制，不能作为"tombstone 怎么做"的参照。

### 产品先例净指引（oss lane 汇总）
四家裁决闸没有一个是"单一自报置信度标量直接决定硬删"——印证 register P1 定级站得住。(1) 闸的形状应换掉：LLM 只负责离散/结构化判定，真正决定"能否销毁"的是确定性结构检查（Graphiti 时间重叠/Letta 唯一性计数/mem0 哈希去重）；0.6 阈值可保留做粗筛，但应叠加至少一个非 LLM 结构信号做第二道闸，两者都过才放行销毁。(2) 自动路径应架构性地不可硬删（Graphiti 最强先例）：`RETRACT_NEW`/MERGE-drop 改"硬删"为"软归档+定期真清理"，复用项目已验证的 `knowledge_edge.archived_at` 模式，推广到 memory 半边。(3) 免费部分先接上：mem0 SQLite history 已在跑、已在同一 worker 进程捕获原文，只是从未被读回——把 reconcile apply 改走 `memory.update()`/`memory.delete()`，或硬删前显式查一次 history 抄原文进 Postgres WAL，零新增基础设施即可让"WAL 不可恢复"变假，**四条建议里唯一一条本项目已付过成本、只差最后一步接线**。(4) Letta 版本化模式可作为 WAL 表结构演进参照。(5) LangMem 立场提示：默认关闭硬删是低成本临时止血选项。

---

## 三腿冲突与一致点

### 一致点（三腿独立收敛，互证强）
- **三腿一致判定 P1 FRESH**：0.6 自报置信度是唯一自动闸 + 真 DELETE 无墓碑 + WAL 不存原文，code/lit/oss 三条独立路径核验后结论完全一致，无一处矛盾。
- **"结构性界优于重型判官"是三腿共同收敛的方向**：lit lane 从三个独立学术领域（LLM 不确定性量化、agent 记忆系统、DB/分布式系统）收敛；oss lane 从四个产品实装收敛；code lane 独立发现"佐证信号已经算出来正被丢弃"这一事实，与前两者方向一致但角度不同（工程可行性 vs 理论/先例支撑）。
- **register 提出的"tombstone"该落在哪一层，三腿一致反对"改 mem0 表本身"**：code lane 明确说"在 mem0 自建表上做原地墓碑列不可行"；oss lane 独立发现 mem0 **已有** SQLite history 机制可以复用（不需要新建，只需接线）；两者殊途同归但论证路径不同——code lane 是从"改 pgvector 表不可行"倒推，oss lane 是从"mem0 已有更好的现成机制"正推，**结论一致但两条 lane 都没有引用对方的证据链**，这是 synthesis 阶段才发现的互补，非任一 lane 原文自陈的重叠。

### 显式冲突/张力点（不抹平）

1. **"tombstone 该落在哪个系统"——code lane vs oss lane 隐含分歧未被任一方直接对话**：
   - code lane 的改动面预估（§四.C）建议"把原文塞进已有 `llm_raw`"或"归档进自己的 WAL 表"，**完全没有提及 mem0 自带的 SQLite `memory_history` 机制**，其"完整子选项"是自建向量快照（`SELECT vector` + 新 jsonb 列）。
   - oss lane 认为**最优路径是复用 mem0 已有的 history 机制**（"改走 `memory.update()`/`memory.delete()` 而非 raw SQL"，或"硬删前查一次 mem0 history 抄原文"），并强调这是"唯一一条本项目已付过成本、只差接线"的方案。
   - **这是一个真实的设计分歧，需要在设计 doc 阶段裁决**：改走 mem0 官方 `update()`/`delete()` API 意味着放弃 reconcile 层当前的 raw-SQL 直接操作模式（该模式可能是为了绕开 mem0 v3 已知的"LangchainLLM residual sniff 劫持进旧 MemoryUpdateSchema"问题——`reconcile-llm.ts:108-111` 注释所指，oss lane 也确认该残留代码存在）；如果 raw-SQL 路径本来就是为了绕开这个 mem0 内部 bug，那么"改走官方 API"可能重新踩中同一个坑，这一点两条 lane 都指出了残留代码的存在，但都没有交叉验证"绕开 mem0 update/delete API 是否正是为了避开这个残留 bug"这一因果关系——**这是设计 doc 需要补的一手验证**，不能想当然认为两个方案互不冲突。

2. **oss lane 对 Graphiti 先例的定性（"自动路径根本不该有硬删动作可选"）比 lit lane 对同一先例（来源8 Zep）的定性更激进**：
   - lit lane 把 Zep/Graphiti 定位为"结构性界的一种可落地原型"（bi-temporal invalidation），是众多候选之一，与 Dynamo tombstone、ARIES undo-log 并列，语气是"提供一种可选模式"。
   - oss lane 把同一先例（直接读 Graphiti 源码而非论文）定性为"最强论点"——认为这证明"不是要给硬删加更高置信度门槛，而是自动判定路径根本不该有硬删这个动作可选"，语气更接近"这是应该采纳的架构原则"而非"这是一种可选模式"。
   - **两者并不矛盾**（oss lane 读的是源码实现细节，lit lane 读的是论文摘要级设计原则），但**强度不同**，设计 doc 需要明确表态：是采纳"架构性禁止自动路径硬删"这一更强主张，还是仅采纳"加一道非 LLM 佐证信号"这一更保守主张——这是 register 已经排除"重型 ensemble"但尚未在"结构性禁止硬删 vs 加软闸"这两个不同强度的方案之间做出选择。

3. **"winsorize" 这个候选词的适用性——仅 code lane 提出质疑，lit/oss 两条 lane 均未处理**：
   - register 原文的候选词列表含 tombstone/winsorize/log/cap 四项，code lane 明确指出"winsorize 大概率不适配本单元的二元 action 空间，更贴 `default-softmax-selection-policy` 那类连续权重场景，需在设计 doc 里核实是否误挂到本单元"。
   - lit lane 和 oss lane 的文献/先例调研均未触及 winsorize 这一统计学概念在本单元的适用性，**没有任何一手引用或先例可以驳斥或支持 code lane 的这一怀疑**——这是一个尚未被三腿共同验证、只有单腿提出异议的悬而未决点，设计 doc 阶段需要单独核实，不能默认 code lane 的怀疑成立，也不能忽略它。

4. **文献 venue 权威性分布不均，需在设计 doc 引用时分层处理**：lit lane 12 篇来源里，**5 篇正式同行评审录用**（Xiong=ICLR2024、Kuhn=Nature、Park=UIST2023、Chhikara=ECAI2025、Binette=Science Advances 综述）+ **1 篇统计学奠基经典**（Fellegi-Sunter 1969）+ **1 篇系统顶会经典**（Dynamo SOSP2007）+ **1 篇数据库期刊经典**（ARIES TODS1992）= 8 篇高权威；**其余 4 篇为 arXiv preprint 未验证 venue**（Yang ETH、"Mind the Confidence Gap"、Zep/Graphiti、Cordon），其中 Cordon 因"发表约 2 周、零引用"被 lit lane 自己强降权。**设计 doc 引用时不应把这 12 篇一视同仁**，尤其"Cordon"和"Mind the Confidence Gap"两篇的证据权重应明显低于 Nature/ICLR/UIST/ECAI 四篇。

### 需要设计 doc 显式裁决、而非从三腿证据直接推出的开放问题
以上 4 点冲突/张力都不是"哪条 lane 错了"，而是三条独立调研路径在收敛到同一大方向（结构性界优于自报置信度单闸）后，在**具体落地形态**上出现了未被交叉验证的分叉，见下节。

---

## 设计相输入（净指引 + 开放问题 + 建议的对抗验证角度）

### 净指引（三腿一致，可直接作为设计前提）
1. **0.6 自报置信度单闸是 P1 级真实缺陷**，三条独立证据路径无一矛盾——不需要在设计 doc 里重新论证"要不要修"，只需论证"怎么修"。
2. **加至少一个非 LLM 结构信号作为第二道闸是有理论+先例双重支撑的正确方向**，且 code lane 证实这个信号（`Memory.search()` 返回的 `score`）**已经在计算、只是被丢弃**——这是三个候选方向（A 佐证信号 / B 结构性界 / C 可恢复性）里改动面最小、且不需要新决策就能立刻见效的一项。
3. **销毁性动作（MERGE 吸收行删除、RETRACT_NEW）应从"硬删"改为"软归档"**，复用项目已验证过的 `knowledge_edge.archived_at` 模式（结构边半边已经这么做，文本记忆半边是项目内部既有的不一致，非文本记忆天然需要硬删）。
4. **WAL 需要能真正支持 undo 就必须存住足以重建旧状态的原文**（ARIES 级不变量），这不是"多留一点日志"的模糊表述，而是设计验收的硬性标准；code lane 已确认接原文进 `llm_raw` 是零迁移改动。
5. **红线自查**：以上四点均不涉及 n=1 拟合 item 参数、不涉及重型 ensemble、不改变 mastery/θ̂/FSRS 语义——纯粹是"AI 决策是否可追溯可回滚"这一项目自身红线（evidence-first）范畴内的加固，与 misconception/θ̂ 信号无关，无需担心红线冲突。

### 开放问题（需要设计阶段裁决，三腿证据不足以直接推出答案）
1. **tombstone 落地层：改走 mem0 官方 `update()`/`delete()` API 复用其自带 SQLite history，还是继续走 raw SQL + 自建 WAL 原文快照？** 两条路径改动面都不大，但前者可能重新踩中 `reconcile-llm.ts:108-111` 注释所指的"LangchainLLM residual sniff 劫持进旧 MemoryUpdateSchema"这个 mem0 v3 已知坑（raw-SQL 路径当初很可能正是为了绕开它）——这个因果关系两条 lane 都发现了残留代码存在，但都没有交叉验证，需要设计阶段单独查证 reconcile-store.ts/triggers.ts 是否有 commit message 或注释明确说明当初为何选 raw SQL 而非官方 API，再决定是否值得冒险改回官方 API 换取"零新增代码复用现成 history"的收益。
2. **架构性禁止自动路径硬删（Graphiti 强论点）vs 仅加非 LLM 佐证信号做第二道闸（更保守）——选哪个强度？** 前者改动面更大（需要把 RETRACT_NEW/MERGE 的执行路径整体改为"自动只能软归档，硬删需要显式人工触发"，类比 Graphiti 的 `remove_episode()` 需要人工 UUID），后者改动面小（只加一层判断，硬删路径不变）。两者不互斥（可以先做保守版本，硬删架构性收紧作为后续），但设计 doc 需要明确排序和是否要在本单元一次性做完。
3. **"winsorize" 是否真的适配本单元、还是 register 原文候选词误挂**（code lane 独立提出，lit/oss 两腿均未处理，无法交叉验证）？需要设计阶段单独核实这个词在 register 语境下具体指什么机制，避免在设计 doc 里生搬硬套一个可能不适配二元 action 空间的统计学概念。

### 建议的对抗验证角度
- **对"改走 mem0 官方 API"方案**：找出 raw-SQL 写路径最初被引入的 commit/PR，核实是否明确因为要绕开某个 mem0 bug；若是，则"改回官方 API"方案需要先验证该 bug 在当前锁定的 mem0 版本（3.0.6）里是否仍然存在，而非假设它已被上游修复。
- **对"非 LLM 佐证信号地板值"**：由于 n=1 红线（不拟合 item 参数），任何新增的 similarity floor 常量都不能靠本项目自己的历史数据校准，只能先用一个保守的、有文献/先例可引用的初始值（如 Fellegi-Sunter 式的"宁可误判为不确定、推给人工"倾向），并在设计 doc 里明确标注"这是未经数据验证的地板值，非拟合结果"，避免与 misconception 打磨系列的其它单元共享的 n=1 处境混淆成两个不同性质的问题。
- **对"软归档 vs 硬删"的行为对照**：写一个具体场景表（如"用户两次提到同一偏好但措辞不同→应 MERGE"vs"用户纠正了之前的错误信息→应 SUPERSEDE 旧记忆"vs"抽取误把噪声当新记忆→应 RETRACT_NEW"），逐一验证"改为软归档"是否会在正常场景下产生用户可感知的行为差异（如检索到已被软归档但未真正消失的旧记忆），而不是只验证"删除是否可逆"这一个维度。

---

**Dossier 涉及文件（三腿合并去重）**：
`src/server/memory/triggers.ts`、`src/server/memory/reconcile-store.ts`、`src/server/memory/reconcile-llm.ts`、`src/server/memory/client.ts`、`src/db/schema.ts:1504-1523`、`src/server/export/constants.ts:1-60,245-252`、`src/server/export/archive.ts:21-221`、`docker-compose.yml:34,83-85`、`docs/design/2026-06-13-memory-architecture.md`（§8.3/§8.6）、`docs/design/2026-07-02-project-logic-master-register.md:173`、`node_modules/.pnpm/mem0ai@3.0.6.../dist/oss/index.mjs:4519-4720,6804-6972`、`node_modules/.pnpm/pg-boss@12.18.2/dist/types.d.ts:145-147`、commit `1cf1ca4559b8d2fe8a7f75a4c3a06120f41af06f`。

---

## P0-1 补洞：raw-SQL 因果考古（2026-07-03）

**枢轴问题**：reconcile-store.ts 的 raw-SQL 写路径（MERGE/RETRACT_NEW 走 `hardDeleteMemory` 真 DELETE，SUPERSEDE 走 jsonb 直写）当初是否正是为绕开 `reconcile-llm.ts:108-111` 注释所指的 mem0 3.0.7 LangchainLLM residual-sniff 坑而选？

### 裁决：**因果不成立（raw-SQL 另有原因 X，与 residual-sniff 坑不相关）**

### 证据链

**1. 两者诞生于同一个 commit，但是两条不相交的设计线**——`eff328df`（"feat(memory): P2 mem0 调和层——软取代 + write-ahead log + per-kind 决策 (YUK-342)"，2026-06-14，PR #405）同时新增 `reconcile-llm.ts`（GLM 判定 + prompt 构造）与 `reconcile-store.ts`（软取代 + 硬删数据层）。commit message 原文只把 raw-SQL/自建 log 的理由讲成："P2 调和读自建 Postgres log，不依赖 mem0 history（§3.5）"——只字未提 residual-sniff。

**2. residual-sniff 红线在源码里明确自称"prompt 措辞红线"，作用域限定在 GLM 调和判定调用的 prompt 文本，与写路径无关**——`reconcile-llm.ts:107-111` 原文：
```
 * Prompt wording RED LINE: never simultaneously contain "smart memory manager"
 * AND "Compare newly retrieved facts" (mem0 3.0.7 LangchainLLM residual sniff
 * would hijack into old MemoryUpdateSchema). Existing memories are referenced
 * by sequential index 0..n only — never expose real UUIDs to the LLM.
```
且该文件顶部另一段注释明确声明这条 GLM 调用**根本不经过 mem0 SDK**："This is NOT runTask/resolveTaskProvider (Anthropic-protocol-only). GLM is openai-compat and physically unreachable through the Anthropic SDK"——是复用 `createMem0Config().llm` 的**配置**（baseURL/apiKey/model）做原始 `fetch`，不复用 mem0 的 `LangchainLLM` 类或其内部 `getUpdateMemoryMessages` 决策代码路径。residual-sniff 风险作用在"prompt 文本会不会被 mem0 内部残留代码误判"这一层，与 `reconcile-store.ts` 用什么 API 把决策**落到 pgvector 表**（raw SQL vs 官方 `update()`/`delete()`）是两个不相交的关注点——前者是"发给 LLM 的话怎么措辞"，后者是"决策定了之后怎么写库"。

**3. `reconcile-store.ts` 文件头注释自陈的理由是"不依赖 mem0 history"，不是"避坑"**——`eff328df` 引入的原文：
```
// P2 (YUK-342): softSupersede + write-ahead log data layer for mem0 reconcile.
// Self-built — does NOT depend on mem0 history. The mem0 pgvector collection
// table (dynamic name from config) is operated on via raw SQL (sql.raw for table
// name); memory_reconciliation_log is a drizzle-managed table.
```
全篇零 residual/sniff/hijack/LangchainLLM 字样。

**4. 设计 doc `docs/design/2026-06-13-memory-architecture.md`（`git log --follow` 溯源 commit `060dc0a6`/`8aac118e`，早于 eff328df 一天，P2 实施前已锁）给出的是三条独立、具体、与 residual-sniff 无关的理由**：

   - **官方 `update()` 被红线封禁的理由是数据完整性 bug，非 residual-sniff**（§3.2 第 1 条，line 62）：
     > "公开 `update()` 禁用：不接收 metadata 且会替换式清除旧 payload 的全部自定义字段 + `textLemmatized`（该记忆从此退出 BM25 关键词检索通道）。包 wrapper 封禁直调。"
     这是**功能性回归**（clobber metadata + 使记忆退出关键词检索），不是"避免触发 mem0 内部残留代码路径"。

   - **软取代走 raw SQL jsonb merge 是 spike 实测验证的独立设计**（§3.3，line 70-90），验证项是"原子、零 re-embed、textLemmatized 完好"——这套验证发生在 P2 编码之前，动机是拿到官方 `update()` 拿不到的三个属性，与 residual-sniff 无关。

   - **residual-sniff 红线在设计 doc 里被明确单独列在 §3.4"调和层"小节、标题就是"调和 prompt 措辞红线"**（line 108），与 §3.2/§3.3 讨论"该用哪个 API 写库"的段落物理分离，互不引用。

   - **自建 log 优于 mem0 history 的理由在 §3.5（line 126）单独给出、且与 residual-sniff 无关**：
     > "自建 `memory_reconciliation_log`（Postgres）是唯一完整证据链……mem0 自身 history 缺 actor/reason、无 user_id 索引，且 jsonb 直写本就绕过它——只作辅助，不作依赖。"
     三个理由：缺 actor/reason 字段、无 user_id 索引、jsonb 直写（因 §3.3 的理由）已经结构性绕开——最后一条是对 §3.3 决策的复述，不是新增的"避坑"动机。

**5. `delete()`（硬删）在红线清单里完全没有被提及/封禁**——§3.2 的红线清单（7 条，line 58-68）只封禁 `update()`，从未讨论官方 `delete()`。`hardDeleteMemory` 走 raw SQL DELETE 而非官方 `delete()`，在设计 doc、commit message、PR #405 body 里都没有给出独立理由，最合理的读法是"延续 softSupersede 已验证的 raw-SQL 直写模式做实现一致性"，而非"避免某个已知 bug"——因为如果真是为了避坑，红线清单（这份文件明确逐条列出"每条均有源码实证"的已知约束）没有理由漏掉它。

**6. PR #405（`gh pr view 405`）body 原文复述与 commit message 一致的理由**（"P2 不依赖 mem0 history（调和读自建 Postgres log，§3.5）"），且 PR 评论区（`gh pr view 405 --json comments`，含两轮独立 Opus review）**全文 grep `sniff|hijack|residual|LangchainLLM|update()|delete()` 零命中**——两轮 review（首轮 REQUEST_CHANGES 聚焦 MERGE-reason-as-text + search-by-UUID 两个 HIGH，与本问题无关）均未把 residual-sniff 与写路径选择联系起来讨论过。

### 净含义（对 tombstone 层裁决）

开放问题 #1（line 172）担心"改走 mem0 官方 API 会不会重新踩中 residual-sniff 坑"——**这个担心不成立，可以从裁决矩阵里划掉**。residual-sniff 是 GLM 调和判定 prompt 措辞的风险，只作用于 `reconcile-llm.ts` 的 prompt 构造代码路径，与 `reconcile-store.ts` 拿什么 API 把决策写进 pgvector 表是两件事；改写路径不会触碰、也不会重新触发这个坑。

但这不代表"改走官方 API 无阻碍"——**真正的阻碍是另一个已被详细记录、且严重得多的功能性 bug**：官方 `update()` 会整体清除 payload 自定义字段 + `textLemmatized`，把记忆踢出 BM25 检索通道（§3.2.1）。这条红线是实打实的、已被 spike 验证过替代方案（raw SQL jsonb merge）优于官方 API 的场景，`softSupersede`/`rewriteMemoryText` 这半边**不应该**因为"residual-sniff 顾虑已被排除"就重新考虑改回官方 `update()`——阻碍换了一个,但依然存在,而且证据更硬（不是理论坑，是文档化过的实测数据丢失）。

**但 `hardDeleteMemory`（MERGE 吸收行删除 / RETRACT_NEW）这半边情况不同**：红线清单里没有对官方 `delete()` 的任何封禁记录，oss lane 已经源码级确认官方 `delete()`（mem0 私有 `deleteMemory` 方法）会在真删之前把原文写进 SQLite `memory_history`（`previous_value=<原文>`, action=DELETE）。这意味着**硬删这半边换成官方 `delete()` API，目前没有已知红线拦着**，而且能免费拿到 tombstone（原文可恢复）——这是三条候选方向（A/B/C）里改动面最小、且不会像 softSupersede 那样撞上 metadata/BM25 那个真 bug 的一条路。设计 doc 阶段应该把这两半拆开单独裁决，不要因为发现"raw-SQL 不是为了避 residual-sniff"就笼统地把两半都判定为"可以安全切回官方 API"或"两半都不能动"——软取代半边继续锁定 raw SQL（有真实阻碍），硬删半边是唯一值得认真评估"切官方 API 换免费 tombstone"的候选。
