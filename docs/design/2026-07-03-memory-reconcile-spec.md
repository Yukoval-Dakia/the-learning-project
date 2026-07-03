# memory-reconcile-policy — 设计 spec（打磨 worklist #9，reconciled 终稿）

> **Program**: YUK-538（全项目逻辑打磨），单元 `memory-reconcile-policy`（master register
> `docs/design/2026-07-02-project-logic-master-register.md` line 173 初判 + line 1153/1188 grounding-pass
> rationale-corrected：P1 不靠 PR #405 先例，靠结构性事实——单一 0.6 自报置信度是 MERGE/RETRACT_NEW/SUPERSEDE
> 三种破坏性动作**唯一**自动闸，MERGE/RETRACT_NEW 走真 SQL DELETE 无墓碑，WAL 只存决策元数据不存原文）。
> **Provenance**: research dossier `scratchpad/research/2026-07-02-worklist-memory-reconcile-research.md`
> （三腿 code/lit/oss + P0-1 raw-SQL 因果考古补洞）。
> **接地**：main `d705dfe1`（本稿全部 file:line 已对 HEAD 重新核对）。
> **审查状态**：本稿为 **reconciled 终稿**——已吸收两轴对抗审查（Lens A 裁决语义轴 / Lens B 存储回滚运行时轴）
> 逐条裁决（见文末「Attack 裁决 ledger」附录），修入全部存活 MAJOR。可直接交 Opus executor。
> **红线**：n=1 不拟合参数（任何新增地板值/常量必须标注"未经数据校准的保守初值"）；evidence-first 可追溯**可
> 回滚**（本单元正因）；轻量与完整两案并呈，由裁决表定夺（"反过度工程协议已撤回"）；重型 ensemble 已被项目
> 整体拒绝（register 明示），不再提；mem0 substrate ADD-only（BR-10）语义边界尊重——本单元不改 `add()` 管道，
> 只改 P2 调和层的 apply 原语；数据门只 gate 翻转不 gate build；护栏两层惯例（warning 水位 vs 硬顶）。

---

## 现状与问题（接地 `d705dfe1`，破坏性动作全链逐行）

### 1. 写路径全链

`event`（`ingest_at IS NULL` outbox，ADR-0021）→ `memory_ingest_outbox_poll`（每分钟，`triggers.ts:807-835`）
→ `memory_event_ingest` handler（`triggers.ts:296-347`，仅 `actor_kind==='user'` 事件经 `shouldExtractToMemory`
放行，`triggers.ts:226-228`，与本单元正交）→ `client.addEventMemory()`（mem0 `infer:true`，`client.ts:185-208`）
→ `enqueueMemoryReconcile`（`triggers.ts:273-294`，`singletonKey: memory.reconcile.${userId}`）→
`memory_reconcile` job（`buildMemoryReconcileHandler`，`triggers.ts:477-679`）。

调和 job 单次批处理：

1. 对每条新 memory，`client.search(text, {topK:31, filters:{user_id}})`（`triggers.ts:541-544`）——mem0
   `Memory.search()` 内部融合 pgvector cosine（`score=clamp(1-distance,0,1)`）⊕ BM25 ⊕ entity-boost，默认
   `threshold=0.1`（项目未覆盖）。每条候选自带 `score`。
2. `CandidateEntry` 类型（`reconcile-llm.ts:48-53`）只取 `{index,text,memory_id,created_ms}`——
   `triggers.ts:545-554` 候选构建循环**从不读取 `r.score`**，字段被就地丢弃。
3. `judgeReconciliation`（`reconcile-llm.ts:295-404`）单次调用 GLM-5.2（`temperature:0.1`），prompt
   明确告诉模型"低于 0.6 系统会降级为 KEEP_BOTH"（`reconcile-llm.ts:148-150`）。`applyConfidenceThreshold`
   （`reconcile-llm.ts:274-288`，`CONFIDENCE_THRESHOLD=0.6` 常量 :18）是**全链唯一**能拦下
   SUPERSEDE/MERGE/RETRACT_NEW 的自动化闸；`confidence===0.6` 放行（`d.confidence < threshold`，:279）。
   解析层容错：`Number(d.confidence)||0`（:257）——缺失/非数字安全默认 0（fail-closed）。**降级时重写
   `reason`**（`reconcile-llm.ts:284`：`Low confidence (X); downgraded from ACTION. <orig>`）——保证 WAL 行
   action 与 reason 一致可审计。**这条既有纪律是本稿 Q1 score-floor 降级必须对称遵守的模板**（见 Q1 论证 #6
   / Lens A A5-1）。
4. `makePlannedRow`（`triggers.ts:625-645`）构造 WAL 行，`llm_raw={...d, new_created_ms}`——**不含
   `text`、不含候选 `score`**。`PlannedRow` 类型（`reconcile-store.ts:26-35`）本身无这两个字段。
5. `insertPlannedRows`（`reconcile-store.ts:41-55`）写入 `memory_reconciliation_log`
   （`src/db/schema.ts:1504-1523`：仅 `id/user_id/new_memory_id/old_memory_id/action/reason/llm_raw(jsonb)/
   planned_at/applied_at`），在 apply 之前（write-ahead）。**关键结构事实**：`insertPlannedRows.values()` 是
   **显式列映射，非 `...spread`**——任何新列不加进这个 `.values()` 映射就会**静默丢弃**（Lens B M2）。
6. `applyPlannedRows`（`triggers.ts:685-758`）按 action 执行：
   - **SUPERSEDE** → `softSupersede`（`reconcile-store.ts:67-88`）：jsonb 浅合并 `payload`，非破坏（行仍在）。
   - **MERGE** → `rewriteMemoryText`（:106-124）就地覆写 OLD 行 `payload.data`+`created_ms`（**覆写前值不被
     捕获**）→ 再 `hardDeleteMemory`（:131-148）删 NEW 行——**真 `DELETE FROM "<collection>" WHERE id=...`**。
   - **RETRACT_NEW** → 直接 `hardDeleteMemory` 新行。
7. `markApplied` 打 `applied_at`。**幂等重放**：job 起手（`triggers.ts:498`）先调一次 `applyPlannedRows`
   重放上轮 `applied_at IS NULL` 行——**这条重放路径是本稿 M1/m7 时序修正的中心约束**（apply-time 捕获会被
   重放污染；半应用行不可 markApplied）。

### 2. DELETE 落点与可恢复性现状

`hardDeleteMemory` 对 mem0 **自建**的 pgvector 表执行原生 `sql.raw` DELETE——该表不受 Drizzle 迁移管理
（`export/constants.ts:36-43` 显式排除出 `FK_ORDER`），DDL 无软删列。唯一"恢复"路径是 `archive.ts` 整表
dump/restore（全库灾备快照，非单条 undo）。**注意 mem0 SQLite `memory_history` tombstone（Q2a 依赖）在
`mem0data` Docker 卷上（`docker-compose.yml:83-85`），不在逻辑备份边界内**（`archive.ts` 只备 pgvector
collection + `memory_reconciliation_log`）——见 Lens B m6：tombstone 的耐久性**严格弱于** WAL。

**不变量精度分层**（本单元核心判据）：
- **可追溯（WHY）已满足**：`reason`+`llm_raw` 记录每条决策理由/置信度。**本稿 Q1 的 score-floor 降级路径若不
  对称重写 `reason`，会主动回归这已满足的一半**（Lens A A5-1，升为硬验收项）。
- **可回滚（WHAT）不满足**：被删/被覆写的实际内容不可恢复。
- **可回滚有第三个隐含维度：可检测（owner 是否知道"发生了一次错误销毁"）**。记忆单条低显著性，owner 现实中
  几乎不会自发注意到某条被误删——若无检测面，tombstone/WAL 让"可回滚"在**纸面**成立、在**实操不可达**
  （Lens A A4-2）。本稿因此把最小检测面（结构化日志）从 defer 提为**同波必做**（Q3/M4）。

### 3. 幂等设计保护重放，不保护决策正确性

`softSupersede` jsonb 合并逐字幂等；`hardDeleteMemory` 吞 `not found|does not exist|42P01`；`markApplied`
无条件 UPDATE 重放无害；`rewriteMemoryText` 的 `newCreatedMs` 来自持久化 `llm_raw.new_created_ms`，重放字节
相同。这套设计保护"同一决策被重放两次"，与"这条决策本身该不该做"正交——一个自报 0.6+、内容却错的 MERGE，会
幂等地、精确地重放它自己的错误。**推论（M1）**：任何"在 apply 阶段读取当前状态"的新增捕获步骤，都会在崩溃
重放时读到**已被上一次部分 apply 改写过的状态**——所以可回滚快照必须在 **write-ahead 阶段**捕获，不能在
apply 阶段。

### 4. pg-boss 并发（独立轴，不在本单元范围）

`registerMemoryHandlers`（`triggers.ts:920-923`）`{pollingIntervalSeconds:2, batchSize:1}`；未行锁、序列化只靠
singletonKey + 单 prod worker，逃生阀显式挂 **YUK-345**（register 独立单元 `mem0-addonly-scope-split-brain`
line 175）。本 spec 不动并发假设。

### 5. raw-SQL 因果考古结论（P0-1 补洞，本单元设计前提）

dossier 已完成考古，**裁决：因果不成立，且两个写操作阻碍强度不同**：

- **`softSupersede`/`rewriteMemoryText`（软取代/改写）继续锁 raw SQL**——真实阻碍是官方 `update()` 会整体清除
  payload 自定义字段 + `textLemmatized`（踢出 BM25 检索通道，design doc §3.2.1），**已被 spike 实测验证的功能性
  bug**。这半边**不在本单元改动范围**。本稿源码二次核验：`updateMemory`（`index.mjs:7123-7166`）确实以
  `newMetadata` 替换式写入并重算 hash——证实 red-line。
- **`hardDeleteMemory`（MERGE 吸收行删除 / RETRACT_NEW）情况不同**——design doc §3.2 红线清单从未封禁官方
  `delete()`。本稿对 mem0ai 3.0.6 已装源码逐行核验（见 Q2a "成色核验"）确认官方 `delete()` 真删前把原文写进
  SQLite `memory_history`（tombstone）——改动面最小、不撞 softSupersede 那个真 bug 的一条路。**但 residual-sniff
  红线只作用于 `reconcile-llm.ts` 的 prompt 措辞，与写路径无关**（考古 §2）——切官方 delete 不会重踩该坑。

---

## 目标与非目标

**目标**：
1. 给 MERGE/RETRACT_NEW 加**第二道非 LLM 结构性闸**，缩小"单一自报置信度独家授权销毁"的敞口（Q1）——且
   **显式承认该闸的作用域限制**：它守低相似错误销毁，对"高相似却按产品语义该分开"的错误 MERGE 无覆盖，后者
   由平行的**确定性 per-kind 执行闸**补（Q1b，Lens A A2-1）。
2. 把 MERGE/RETRACT_NEW 硬删从"无墓碑真 DELETE"改为"可恢复删除"，**优先以自建 WAL `prev_text` 为主恢复源
   （在备份边界内），mem0 官方 `delete()` + SQLite tombstone 为免费副保底**（Q2a，主次关系经 Lens B m6 修正）。
3. 给 SUPERSEDE/MERGE 软取代半边补齐 WAL 原文/payload 快照，且**在 write-ahead 阶段捕获**（ARIES + 重放安全，
   Lens B M1）（Q2b）。
4. 显式裁决"架构性禁止自动路径硬删"（更强）vs "只加软闸"（更保守）的强度选择（Q3），并**把最小检测面
   （结构化日志）定为同波必做**（可回滚依赖可检测，Lens A A4-2）。
5. 核实并正式除名 winsorize，且**论证覆盖 Q1 新引入的连续值 `score`**（Q4，Lens A A3-1）。
6. 给出最小充分 undo 面（Q5）——含**可用的逐字恢复原语**（addEventMemory 不可用，Lens B M5）——与 prompt/
   docstring 一致性收尾（Q6）。

**非目标**：
- 不新建 LLM ensemble / 多模型投票 / 语义熵多采样（register 已排除）。
- 不改 `judgeReconciliation` 的 prompt 结构或**动作空间**（四态不变）。**注**：Q1b 的 per-kind 执行闸与 Q1 的
  score floor 都是"LLM 输出**之后**的确定性后处理层"，与 `applyConfidenceThreshold` 同架构层次，**不算改
  prompt/动作空间**（Lens A A2-1 裁决确认在界内）。
- 不改 `softSupersede`/`rewriteMemoryText` 的 raw-SQL 写法（真 bug，非理论坑）。
- 不给 `applyConfidenceThreshold` 调参（0.6 不动）。
- 不解决 YUK-345 并发/行锁。
- 不建完整管理面 UI；但**最小检测日志同波必做**（Q3/M4，非 defer）。dashboard/只读端点留 follow-up。
- 不改 mem0 substrate ADD-only 边界（BR-10）。
- **不处理 re-embed-on-merge**（register P2 独立单元）：`rewriteMemoryText` 只写 `payload.data`、`textLemmatized`
  保持陈旧（Lens B m9 确认这是既有缺口，本波不引入不加剧）。

---

## 决策表

### Q1 — 非 LLM 佐证信号（score floor）接入形态

`triggers.ts:551` 循环里 mem0 `Memory.search()` 已算出的融合 `score` 被 `CandidateEntry` 静默丢弃。是否/如何
接上做第二道闸？

| 选项 | 判决 |
|---|---|
| (a) 不接 | **REJECT**——已算出的免费信号被丢弃 |
| (b) score floor 与 0.6 置信度 **AND** | 采纳基座（两个都过才放行销毁） |
| (c) **OR** | **REJECT**——OR 制造第二条更宽放行路径，与"收紧"目的相反 |
| (d) 分层：销毁类挂 floor，SUPERSEDE 单独 | **采纳**（见下三分裁决） |

**裁决：AND 复合闸，且销毁类按动作三分（Lens A A1-2/A1-1 修正后）：**

| action | score floor | 说明 |
|---|---|---|
| **MERGE** | **挂 floor（方向无歧义）** | MERGE=改写既有以吸收新的；仅当二者**真高相似**才该 MERGE，低相似 MERGE=把两条不同事实揉成一条=破坏性丢失。floor 用**被引用候选（`oldMem.score`）的具体分数**（非 max），方向正确 |
| **RETRACT_NEW** | **挂 floor，但语义受限（见下）** | prompt 定义 RETRACT_NEW = "noise **OR** exact duplicate"（`reconcile-llm.ts:134`）——两个**相似度关系相反**的子语义。floor 只对 **duplicate 子案**有佐证意义（高相似候选存在）；对 **noise 子案** floor 无佐证目标（噪声恰恰孤立），降级为 KEEP_BOTH 只是**良性过度保守**（保留噪声=安全方向、可回滚、不销毁），不新增销毁安全 |
| **SUPERSEDE** | **免 floor** | `softSupersede` 只加 jsonb 标记、OLD 行仍在、本身可逆——本单元稀缺资源（结构闸）优先花在不可逆的 MERGE/RETRACT_NEW 上 |

论证：
1. **AND 而非 OR**——目的是把"单一标量独家授权"变成"至少两个独立信号一致"。
2. **RETRACT_NEW 的 floor 靶点与 null-old_index 边界**：`reconcile-llm.ts:242` 只强制 SUPERSEDE/MERGE 携带
   `old_index`。RETRACT_NEW 若携带 `old_index`（duplicate 子案常见），floor 挂**该具体候选**的 score；若
   `old_index` 为 null，floor 挂 `topCandidateScore(cands)`（候选集最高分）作 fallback，**并显式标注这是
   outlier-permissive 的近似**（Lens A A3-1：entity-boost 可能把单个公共 token 候选虚高到 ~0.99，max 归约对此
   敏感、方向偏放行）；候选集为空则 **floor 跳过**，仅 0.6 置信度把关（不劣于现状），且**必打一条结构化日志**
   （m8：floor 因缺 score 被跳过必须可见/可计数）。
3. **noise-RETRACT 的诚实定性（Lens A A1-1 存活半）**：对"噪声且无高相似邻居"的 RETRACT_NEW，floor 会降级为
   KEEP_BOTH → 噪声被保留。这**不违反红线**（保留=安全方向、可回滚），但**有非零代价**（未 sweep 的噪声行
   `vector` 仍参与 ANN topK 召回，污染检索）——所以本稿**不把"降级=零成本安全"当公理**（修正 draft 早期在 Q1
   称安全、Q3 又承认对称代价的自相矛盾）。残留失效模式"noise-with-weak-neighbors 被保留"记为**已接受、
   owner 可翻**的限制（不加 `reason_kind` prompt 字段——那违反非目标 + n=1 极简 + 扩 LLM 契约面；REJECT 该修法）。
4. **地板值是结构性保守值，非拟合（n=1 红线）**：新增 floor 取 **`MERGE_RETRACT_SCORE_FLOOR = 0.5`**
   （`[0,1]`，pgvector 部分 `clamp(1-distance,0,1)`）。**未经数据校准的保守初值**：(i) 明显高于 mem0 预过滤
   0.1；(ii) 明显低于"高置信度重复"直觉上限（0.8+）；(iii) n=1 无真实分布时宁可让第二闸温和（本闸是加固、
   非主拦截层，主拦截仍是 0.6）。**代码注释必须原样标注"0.5 未经数据验证的保守地板值，非拟合结果"**，与
   `SOLVE_CHECK_TIER34_VETO` 常量注释纪律一致。
5. **可观测优先**：`score`/`referenced_score`/`structurally_corroborated` 写进 `llm_raw`（零迁移，jsonb 既有），
   使地板值将来可用真实分布回顾校准。
6. **score-floor 降级必须对称重写 `reason`（硬验收，Lens A A5-1）**：既有 `applyConfidenceThreshold`（:284）
   在降级时重写 reason 保 action↔reason 一致；本稿 score-floor 降级**同样必须**产出如
   `Low structural corroboration (score=${s}); downgraded from ${action}. ${d.reason}` 的 reason——否则会写出
   `action=KEEP_BOTH` 但 `reason="合并 X 与 Y"` 的自相矛盾 WAL 行，直接回归本单元正因的"可追溯"那一半。

### Q1b — 高相似错误 MERGE 的覆盖缺口 + per-kind 确定性执行闸（Lens A A2-1，新增）

**显式承认的敞口**：score floor 与"错误 MERGE"**反相关**——它只拦"LLM 说 merge 但 mem0 说不像"（低分），对
"两条确实很像、但按产品语义就该分开"（高分）**零防护**。而 dossier P1 的核心是"0.6 自报置信度 overconfident"，
LLM 过度自信**最常发生在高文本相似**的一对上——这类 case score 也高，floor 帮不上忙。prompt 的 per-kind 规则
明确要求 `weakness`/`event` **KEEP_BOTH**（"Episodic facts coexist ... Weakness/error trajectories have value
as history"，`reconcile-llm.ts:143`）——这正是项目最想保留的错题轨迹历史，也正是高相似误 MERGE 最会伤到的。

| 选项 | 判决 |
|---|---|
| (轻) 仅文档承认残留 + owner 接受 | 呈报 |
| **(完整，推荐) 加确定性 per-kind 执行闸：`weakness`/`event` 的 MERGE 一律降级 KEEP_BOTH** | **推荐采纳**（owner 批） |

论证（"反过度工程协议已撤回"→ 两案并呈）：`kind` 已在作用域内（`NewMemoryEntry.kind`，`triggers.ts:530-536`
由 `input.kind` 携带）；per-kind 闸是 register 明确圈定的"便宜结构性界"（确定性、非 LLM）；~3 行；降级方向
（KEEP_BOTH）可逆且安全；直接闭合 score floor 结构上**补不了**的、后果最重的失效模式（对最有价值的 kind 的
高相似误并）。**owner 需拍**：这比 prompt 的"lean toward KEEP_BOTH"**略严**（硬禁 MERGE 而非倾向）；若 owner
认为要保留 weakness/event 偶尔 MERGE 的自由，可只取轻案。本稿**推荐完整案**，理由是错题轨迹一旦被误并即
灭失历史，代价不对称。降级同样走 Q1 论证 #6 的 reason 重写纪律。

### Q2a — 硬删半边：切官方 `delete()`（成色经装机源码逐行核验）

**裁决：切 mem0 官方 `delete()`，复用其 SQLite `memory_history` tombstone——但定位为 Q2b WAL 的免费副保底，
不是主恢复源（Lens B m6 修正）。**

**本稿对"免费 tombstone"成色的装机源码核验**（`mem0ai@3.0.6/dist/oss/index.mjs`，已逐行读）：

1. `delete(memoryId)`（公开，`:6980-6984`）→ `_captureEvent("delete")`（遥测，`MEM0_TELEMETRY=false` 于 §8.6+
   compose 强制关 + try/catch 包裹 + `add()` 早已 fire——**净零新增副作用，非 finding**，Lens B 已 defuse）→
   `deleteMemory(memoryId)`（私有，`:7164-7189`）：
   ```
   const existingMemory = await this.vectorStore.get(memoryId);          // {id, payload} — 无 vector 列
   if (!existingMemory) throw new Error(`Memory with ID ${memoryId} not found`);
   const prevValue = existingMemory.payload.data;                         // 只取 payload.data（原文文本）
   await this.vectorStore.delete(memoryId);                               // 真 DELETE
   await this.db.addHistory(memoryId, prevValue, null, "DELETE", void 0, void 0, 1);  // tombstone
   ```
2. **三个必须诚实标注的成色限制**（本稿装机核验确认）：
   - **只保存 `payload.data`（文本），不保存完整 payload**——`kind`/`created_ms`/`actor_kind`/`subject_*`/
     `affected_scopes` 全丢。恢复出的记忆缺原始 metadata，除非本项目 WAL 另记（→ Q2b `prev_metadata`）。
   - **不保存 vector**——"恢复"是把文本**重新 embed 后 `add()`**，产生**新 UUID 的新行**，非原行复活。
   - **mem0 SDK 无 `restore`/`undelete`**——读 tombstone 再重建是本项目要写的代码（→ Q5 M5 逐字原语）。
3. **`delete()` 抛 `Memory with ID <id> not found` 当行已不存在**——本项目既有幂等正则
   `/not found|does not exist|42P01/i`（`reconcile-store.ts:145`）天然匹配，无需改正则。
4. **主次定位（Lens B m6）**：tombstone 在 `mem0data` 卷、**不在逻辑备份边界**，可能与 PITR 全库 restore
   分叉；WAL `prev_text`（Q2b，在 `FK_ORDER` 备份内）耐久性更强。故**主恢复源 = WAL `prev_text`（覆盖所有
   销毁动作，见 Q2b），mem0 tombstone = 免费副保底**（历史行 / WAL 失效时的兜底）。这颠倒 draft 早期把
   tombstone 当硬删主恢复源的框架。

（不采纳完全自建 archive 表：会重复 mem0 已免费提供的东西，且给 mem0 自建表加软删列每次升级需重核。）

### Q2b — 软取代半边：WAL 原文/payload 快照（write-ahead 捕获，Lens B M1/M2 修正）

**裁决：`memory_reconciliation_log` 加两个 nullable 列 `prev_text`(text)/`prev_metadata`(jsonb)；两者都在
**write-ahead 阶段**（`insertPlannedRows` 之前）捕获并随行 INSERT；写入侧覆盖所有非 KEEP_BOTH action。**

论证（含对 draft 早期设计的三处修正）：
1. **write-ahead 捕获，非 apply-time（Lens B M1，correctness 非 taste）**：draft 早期把 `prev_metadata` 放在
   apply 阶段用 `capturePrevState` + `setPrevMetadata` 两阶段补齐。但 job 起手 `applyPlannedRows`（`triggers.ts:498`）
   会重放上轮未 apply 行——若 MERGE 在 `rewriteMemoryText` 之后、`markApplied` 之前崩溃，重放时
   `capturePrevState` 读到的是**已被改写的 post-merge payload**，把正确快照覆写成 `merged_text` 垃圾，**恰好
   对最需要恢复的行**。故 `prev_text` 与 `prev_metadata` **都在 write-ahead 阶段一次捕获**（此时 OLD 行尚未被
   apply 改写），随 `insertPlannedRows` 落库；apply 阶段**不再捕获**，重放天然安全。这同时消掉了 `setPrevMetadata`
   两阶段写。
2. **写路径必须显式加进 `insertPlannedRows.values()`（Lens B M2）**：`insertPlannedRows`（`reconcile-store.ts:41-55`）
   是**显式列映射非 spread**——`PlannedRow` 类型（:26-35）加 `prev_text?/prev_metadata?` 字段 **且**
   `.values()` 映射加这两列，否则 `prev_text` 静默丢弃 + `audit:schema` 因新列无 write path 硬 fail。
   `loadUnappliedLog`（:181-190）**不需**回读这两列（apply 不消费 `prev_*`；恢复是 runbook 离线查表）——但为
   完整性可选一并映射（非 load-bearing）。
3. **捕获什么**：
   - `prev_text`：SUPERSEDE/MERGE = `oldMem.text`（`CandidateEntry.text`，作用域内，无需 SELECT）；
     RETRACT_NEW = `newMem.text`（`NewMemoryEntry.text`，作用域内，无需 SELECT）。语义"这条决策所删除/覆写的
     那份原文"，字段名统一含义因 action 而异（schema 注释写清）。
   - `prev_metadata`（完整 payload，仅 SUPERSEDE/MERGE 有意义）：write-ahead 阶段对 `old_memory_id` 做一次
     只读 `capturePrevState` SELECT（`reconcile-store.ts` 新增 helper），拿完整 payload。RETRACT_NEW 不取
     （删的是本批新行，其 metadata 由本项目 `addEventMemory` 刚写入，可从 `event` 表溯源）。SELECT 失败（行不
     存在，防御式）→ `prev_metadata` 留 NULL，不阻塞（`prev_text` 打底）。
4. **RETRACT_NEW 也写 `prev_text`（双保险非重复劳动）**：即便 Q2a mem0 tombstone 因故失效，WAL 独立持有可恢复
   原文；且 WAL 在备份边界内（m6），是**主**恢复源。
5. **登记面（`reference_new_pgtable_registration_surfaces`，列 vs 表）**：`memory_reconciliation_log` 已在
   `FK_ORDER`（`export/constants.ts:168`，`SCHEMA_VERSION` 现 `4.13`）。additive 列走"表=bump/列=不 bump"
   先例（`item_calibration` 加列、`practice_stream_item.signals` 加列均不 bump，constants.ts 注释实证）。
   **不需**：`SCHEMA_VERSION` bump / `FK_ORDER` 改动 / `audit:schema` allowlist（有 writer 后 `buildColumnAllowlist`
   pgTable 内省自动纳入）。**需要**：一次 `pnpm db:generate` migration。**但列与 writer 必须同 PR 落地**（Lens B
   M3，见切片）——列单独先行会让 `audit:schema`（写路径 gate，与备份覆盖正交）在该 PR 上 fail。

### Q3 — 架构性禁止自动路径硬删 vs 仅加佐证信号（用户模型统一 + 检测同波，Lens A A4-1/A4-2）

| 选项 | 判决 |
|---|---|
| (a) 架构性禁止：自动 reconcile 只软操作，硬删降级为"标记待销毁"+ 独立人工/延迟 sweep | **记为有条件未来升级** |
| **(b) 仅 Q1/Q1b 结构闸 + Q2 tombstone/WAL + 同波最小检测日志【裁决】** | **采纳** |

**裁决：(b)，本波不做架构性禁止；(a) 记为条件触发的未来升级。**

论证（重建——修掉 draft 早期两处不自洽）：
1. **统一用户模型 = owner 即专家开发者（Lens A A4-1）**：本项目单用户工具（ADR-0007），owner 有 psql/脚本权限。
   draft 早期在 Q3 把 owner 当"会被软归档语义搞混的小白"、在 Q5 又当"能连 sqlite3 抄 tombstone 的工程师"——两套
   互斥画像各为需要的否决站台。统一为专家 owner 后，"软归档产品语义困惑"论据**自动失效**（专家不会被软归档搞混，
   反而可见性对他是加分）。故 (a) 被否**不再靠**"用户困惑"，改靠下条真论据。
2. **红线要求"可回滚"非"自动路径不能碰硬删"**：Q2a+Q2b 组合后 MERGE/RETRACT_NEW 硬删有 WAL `prev_text`（主）
   + mem0 tombstone（副），SUPERSEDE/MERGE 覆写有 `prev_text`/`prev_metadata`——"可回滚（WHAT）"从不满足变满足
   （手动但确实可行）。红线不要求"自动一键 undo"。
3. **(a) 的真实成本/收益（Lens A A4-2 steelman，替换 draft 早期算反的账）**：
   - **(a) 被 draft 早期高估**：项目**已有**同构落地模板——`knowledge_edge.archived_at` 软归档 + 独立 sweep
     （`misconception-reconcile.ts:26`）；"多久才真删"现存 sweep 已回答；可定时自动化，**owner 稳态手动清 ≈ 0 次**。
   - **(a) 的真收益 / (b) 的真成本（诚实 steelman）**：软归档而不真删，noise 行 `vector` 未 sweep 前仍参与 ANN
     topK 召回，挤占名额、污染检索（即便 P3 事后过滤）。这是 (b) 保留自动硬删的真实代价，也是 (a) 的真实收益——
     **draft 早期两个理由（产品语义困惑 + 改动面大）都是弱的/算反的，本稿据实替换。**
   - **为何仍选 (b)**：(b) 改动面显著更小，且 Q2a+Q2b 已让硬删可逆；(a) 是为"级联损坏"（知识图谱传递性）设计的
     强论证，而 mem0 个性化记忆是扁平独立事实集（ADR-0017），单条误删不级联（mastery/FSRS 不进 mem0，§3.7）——
     用为级联设计的强论证套非级联风险，代价与诉求不对称。
4. **可回滚依赖可检测 → 最小检测面同波必做（非 defer，Lens A A4-2 修正 fix#3）**：(b) 下若无检测面，owner
   永不知道"发生了一次错误硬删"→ runbook 永不被触发 → 可回滚纸面成立、实操不可达。故**最小检测 = 结构化日志**
   （每次破坏性 apply / 每次 score-floor 降级 / 每次 per-kind 降级 / 每次 floor 因缺 score 跳过，都打一行可 grep/
   可计数的结构化日志）+ runbook 场景 C 的批量核查 SQL——**这些同波落地**（廉价、无 UI，符合"数据门只 gate 翻转
   不 gate build"+"dark-ship 无 UI 不算做完"）。完整 admin dashboard/只读端点留 follow-up。
5. **(a) 留档为条件触发升级**：若上线后观测到误删率偏高且 runbook 挽救不力，(a) 是自然下一步。

### Q4 — winsorize 候选词核实（论证覆盖 Q1 新增连续值，Lens A A3-1）

**核实结论：winsorize 不适用于本单元，正式除名——但论证必须覆盖 post-Q1 管道的两个连续值，不能停在 draft
早期"本单元唯一连续值是 confidence"的过时前提。**

论证（重做）：winsorize 是把连续分布极端值截断到某分位数的技术，适用对象是连续值分布。post-Q1 管道有**两个**
连续值：
1. **`confidence`**：只用于和 0.6 阈值一次性二元比较，钳制两端不改变比较结果——winsorize N/A（结论不变）。
2. **`score`（Q1 新引入，`[0,1]`）**：MERGE 用**被引用候选的具体分数**（非归约统计量），单点 floor 比较，
   winsorize 无对象。RETRACT_NEW 的 null-old_index fallback 用 `topCandidateScore = max`——**这是对离群值最敏感
   的 max 统计量**（entity-boost 可虚高单个候选到 ~0.99），draft 早期 Q4 宣称"没有连续分布可 winsorize"与 M1
   构造的 max 归约**自相矛盾**。**修正**：承认 max 归约离群敏感，但 winsorize 仍非正解——n=1 候选数少、且更稳健
   的解是"用具体被引用候选（MERGE 已如此）或退化到 floor 跳过 + 日志（RETRACT_NEW 候选空时）"，而非引入分位数
   截断这一为大样本连续分布设计的技术。**除名结论保留，论证已覆盖 score。** 不代 `default-softmax-selection-policy`
   判断 winsorize 是否适配它（那是它自己的裁决范围）。

### Q5 — undo 窗口/恢复路径（含可用逐字原语，Lens B M5）

**裁决：doc-only runbook（本波最小充分形态）+ 一个**可用的逐字恢复原语**（不建管理面 UI/API）。**

论证：
1. **专家 owner + 低频运维**：owner 有 psql/脚本权限，无证据表明频繁 undo（加固单元，非响应真实事故）。完整案
   （管理面 UI）改动面大且缺需求信号。
2. **draft 早期 runbook 的恢复 hop 是坏的（Lens B M5，硬修）**：draft 步骤 5 用 `client.addEventMemory({...})`
   恢复——但该方法（`client.ts:185-208`）硬编码 `infer:true` + 经 `eventToText`（`:160-168`）包成 event JSON
   信封，且期望完整 event 输入。把 `prev_text` 喂进去会 (a) 把 memory 误塑成 event 信封、(b) 重跑 mem0 抽取 LLM
   → "恢复"出的是推理重派生物，**非原文逐字**。`Mem0Like`（`:25-34`）也未暴露 `infer:false` 通道。**修法**：
   `MemoryClient` 新增 `restoreVerbatim(text, metadata)` 原语，内部调 `memory.add(text, {userId:'self',
   metadata, infer:false})`——`infer:false` 跳过抽取 LLM、把文本作为单条记忆直接落库（仍重 embed，产新 UUID，
   这是可接受的"文本可恢复非原行复活"）。**executor 须核**：mem0 3.0.6 的 `add(..., {infer:false})` 是否确把
   raw text 作单条 memory 直存（v3 `addToVectorStore` 路径）而不 MD5-dedup 掉——若语义有出入，退路是直接
   pgvector INSERT + 手动 embed。**停止经 `addEventMemory` 走 undo。**
3. **最小充分形态**：runbook（本 spec 附录）+ 两条可在 psql/脚本执行的路径（查 WAL `prev_text`/`prev_metadata`；
   历史行查 mem0 SQLite tombstone）+ `restoreVerbatim` 原语。
4. **未来升级**：若 undo 频率超预期，只读 admin 端点（`GET /api/_/memory-reconcile/:id` 展示 `prev_text`/
   tombstone，复用 `client.history()`）是自然增量，本波不建。

### Q6 — prompt 措辞 / docstring 一致性（decision 非 assertion，Lens A A5-3）

**裁决：prompt 措辞不改，但 Q6 是**权衡后的决策**（非断言）：选"不告知 LLM 第二道闸"，并同步 docstring。**

论证：
1. **权衡（Lens A A5-3 要求 decision 非 assertion）**：prompt 已如实向 LLM 披露 0.6 闸（`:148-150`）以助校准。
   "也告知 floor"理论上能让 LLM 对高自信-低相似 merge 主动压低 confidence（联合校准）。**但选不告知**，理由：
   score floor 消费的是 mem0 融合 `score`——一个 LLM **拿不到、无法数值推理**的信号；只告诉它"还有个结构闸"而
   不给分数，不能实质改善校准，反而复杂化 prompt 契约。这是**裁决**（权衡两侧后选隐藏），非"不应该被告知"的断言。
2. **注释落点**：`reconcile-llm.ts:149` 加一行注释说明"这句描述 LLM 侧唯一被告知的阈值，执行侧另有 score floor +
   per-kind 闸的独立后处理层，见 `passesStructuralCorroboration`"。
3. **docstring 同步（A5-3 存活）**：`applyConfidenceThreshold` 的 docstring（`reconcile-llm.ts:270-273`，现写
   "no destructive action on low-confidence"）在本波后已 under-describe 系统（还有 score floor + per-kind 闸）——
   列入 M0 doc 同步清单。

---

## 机制设计（文件/函数/schema 级，接地 `d705dfe1`）

### M0 — 改动文件清单

| 文件 | 改动 | 决策 |
|---|---|---|
| `src/db/schema.ts` | `memory_reconciliation_log` 加 `prev_text`/`prev_metadata` | Q2b |
| `drizzle/` | 新 migration（`pnpm db:generate`） | Q2b |
| `src/server/memory/client.ts` | `Mem0Like` 加 `delete`/`history`；`MemoryClient` 加 `hardDelete`/`history`/`restoreVerbatim` | Q2a, Q5 |
| `src/server/memory/reconcile-llm.ts` | `CandidateEntry.score?`；`MERGE_RETRACT_SCORE_FLOOR` + `passesStructuralCorroboration`；per-kind MERGE 抑制 helper；prompt/docstring 注释 | Q1, Q1b, Q6 |
| `src/server/memory/reconcile-store.ts` | `PlannedRow` 加 `prev_text?/prev_metadata?` + `insertPlannedRows.values()` 映射；`hardDeleteMemory` 改签名（切 client，删 raw-SQL）；新增只读 `capturePrevState` | Q1/Q2a/Q2b |
| `src/server/memory/triggers.ts` | 候选携带 `score`；write-ahead 捕获 `prev_text`/`prev_metadata`；统一 makePlannedRow 合成 action；`applyPlannedRows` 时序重排 + client 缺失整分支跳过；破坏性 apply/降级/跳过结构化日志 | Q1/Q1b/Q2a/Q2b/Q3 |
| `docs/design/2026-06-13-memory-architecture.md` | §3.4/§3.5 追加落点 + docstring 同步说明 | 全部 |
| `docs/runbooks/memory-reconcile-undo.md` | 新增（含 `restoreVerbatim`） | Q5 |

### M1 — Q1/Q1b：score floor + per-kind 闸 + 统一 action 合成 + reason 重写

`reconcile-llm.ts`，`CandidateEntry` 加 `score?: number`（注释标 YUK-538 Q1，undefined=缺分数防御式）。

`triggers.ts:545-554` 候选构建循环追加 `score: typeof r.score === 'number' ? r.score : undefined`。

`reconcile-llm.ts` 新增（独立纯函数，不改 `applyConfidenceThreshold` 本体）：

```ts
// n=1：未经数据验证的保守地板值，非拟合结果（见 spec Q1 论证 #4）。
export const MERGE_RETRACT_SCORE_FLOOR = 0.5;

/** Q1 第二道非 LLM 结构闸。MERGE/RETRACT_NEW 除 0.6 置信度外还要求被引用候选 score≥floor。
 *  SUPERSEDE/KEEP_BOTH 免闸。score===undefined（无候选可挂）→ 不因此拒绝，返回 true，
 *  调用方必须对此路径打一条"floor skipped (no score)"结构化日志（m8）。*/
export function passesStructuralCorroboration(
  action: ReconcileAction,
  referencedCandidateScore: number | undefined,
): boolean {
  if (action !== 'MERGE' && action !== 'RETRACT_NEW') return true;
  if (referencedCandidateScore === undefined) return true;
  return referencedCandidateScore >= MERGE_RETRACT_SCORE_FLOOR;
}

/** Q1b 确定性 per-kind 执行闸：weakness/event 的 MERGE 一律不允许（错题轨迹历史，
 *  高相似误 MERGE 是 score floor 结构上补不了的洞）。返回 true=该 kind 禁止 MERGE。*/
export function kindForbidsMerge(kind: string): boolean {
  return kind === 'weakness' || kind === 'event';
}
```

`triggers.ts` 的 `makePlannedRow` 调用点（`:625-645`）**替换为单一、完整的 action 合成**（消掉 M1/M4 三处
`action` 各说各话，Lens A A5-2），顺序：`badTarget → per-kind(Q1b) → score-floor(Q1) → final`，且
`reason`/`old_memory_id`/`prev_text` 全读**同一个 final action**，降级路径**对称重写 reason**（Q1 论证 #6）：

```ts
const plannedRows: PlannedRow[] = [];
for (const d of uniqueDecisions) {
  const newMem = newMems[d.new_index];
  const cands = candidatesByNew.get(d.new_index) ?? [];
  const oldMem = d.old_index != null ? cands[d.old_index] : undefined;
  const destructive = d.action === 'SUPERSEDE' || d.action === 'MERGE';
  const badTarget = !newMem || (destructive && !oldMem) || (d.action === 'RETRACT_NEW' && !newMem);

  // 1) bad target 降级（既有语义）
  let action: ReconcileAction = badTarget ? 'KEEP_BOTH' : d.action;
  let reason = badTarget ? `out-of-range index degraded from ${d.action}; ${d.reason}` : d.reason;

  // 2) per-kind 闸（Q1b）：weakness/event 禁 MERGE
  if (action === 'MERGE' && newMem && kindForbidsMerge(newMem.kind)) {
    reason = `Per-kind guard (kind=${newMem.kind} forbids MERGE); downgraded from MERGE. ${reason}`;
    action = 'KEEP_BOTH';
    console.warn(`[memory_reconcile] per-kind MERGE suppressed (kind=${newMem.kind}) new_index=${d.new_index}`); // Q3 检测
  }

  // 3) score floor（Q1）：MERGE 用具体候选分；RETRACT_NEW 用具体候选或 topCandidateScore fallback
  const referencedScore =
    action === 'MERGE' ? oldMem?.score
    : action === 'RETRACT_NEW' ? (oldMem?.score ?? topCandidateScore(cands))
    : undefined;
  const corroborated = passesStructuralCorroboration(action, referencedScore);
  if (!corroborated && (action === 'MERGE' || action === 'RETRACT_NEW')) {
    reason = `Low structural corroboration (score=${referencedScore}); downgraded from ${action}. ${reason}`;
    action = 'KEEP_BOTH';
    console.warn(`[memory_reconcile] score-floor downgrade (score=${referencedScore}) new_index=${d.new_index}`); // Q3 检测
  } else if ((action === 'MERGE' || action === 'RETRACT_NEW') && referencedScore === undefined) {
    console.warn(`[memory_reconcile] score-floor skipped (no candidate score) action=${action} new_index=${d.new_index}`); // m8
  }

  // 4) write-ahead prev snapshot（Q2b，见 M4）
  const prevText = action === 'KEEP_BOTH' ? null
    : action === 'RETRACT_NEW' ? (newMem?.text ?? null)
    : (oldMem?.text ?? null);
  let prevMetadata: Record<string, unknown> | null = null;
  if (action === 'SUPERSEDE' || action === 'MERGE') {
    const snap = oldMem ? await capturePrevState(db, collectionName, oldMem.memory_id) : null;
    prevMetadata = snap?.metadata ?? null; // 失败/不存在 → NULL，不阻塞（prev_text 打底）
  }

  plannedRows.push(makePlannedRow({
    user_id: userId,
    new_memory_id: newMem?.memory_id ?? null,
    old_memory_id: action === 'KEEP_BOTH' ? null : (oldMem?.memory_id ?? null),
    action,
    reason,
    llm_raw: { ...d, new_created_ms: newMem?.created_ms ?? null,
               referenced_score: referencedScore ?? null, structurally_corroborated: corroborated },
    prev_text: prevText,
    prev_metadata: prevMetadata,
  }));
}
```

`topCandidateScore(cands)`（3 行 helper，取 max `score`，无候选返 undefined——注释标 outlier-permissive 近似，
Q4/A3-1）。注意 `makePlannedRow` 调用现在带 `prev_text`/`prev_metadata` → `PlannedRow` 类型 + `insertPlannedRows`
必须同步（M4）。因 `capturePrevState` 是 async，这段从 `.map` 改为 `for...of`（保持 write-ahead 前完成捕获）。

### M2 — Q2a：硬删切官方 `delete()` + Q5 逐字恢复原语

`client.ts` `Mem0Like`（`:25-34`）加 `delete(memoryId): Promise<{message:string}>` 与
`history(memoryId): Promise<Array<{memory_id; previous_value; new_value; action; created_at; is_deleted}>>`。
`MemoryClient`（`:63-69`）+ `createMemoryClient()` 返回对象（`:184-217`）加：

```ts
async hardDelete(memoryId) {            // Q2a：idempotent，目标已不存在时 no-op
  try { await memory.delete(memoryId); }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|does not exist|42P01/i.test(msg)) return; // mem0 "Memory with ID x not found"
    throw err;
  }
},
async history(memoryId) { return memory.history(memoryId); },   // Q5 undo 面读 tombstone
async restoreVerbatim(text, metadata) {                          // Q5/M5：逐字恢复，不经抽取 LLM
  // infer:false → 跳过抽取 LLM，把 text 作单条 memory 直存（仍重 embed，产新 UUID）。
  // executor 须核 mem0 3.0.6 add(...,{infer:false}) 语义（addToVectorStore 直存 vs MD5-dedup）；
  // 退路=直接 pgvector INSERT + 手动 embed。绝不经 addEventMemory（infer:true + eventToText 信封）。
  await memory.add(text, { userId: 'self', metadata, infer: false });
},
```

`reconcile-store.ts` `hardDeleteMemory` **整体替换**（`grep hardDeleteMemory` 确认 `triggers.ts` 唯一调用方，
两处，无其它消费者）：

```ts
export async function hardDeleteMemory(
  client: Pick<MemoryClient, 'hardDelete'>,
  memoryId: string,
): Promise<void> {
  await client.hardDelete(memoryId); // 官方 delete()：真删前把 payload.data 写 SQLite memory_history（tombstone）
}
```

### M3 — `applyPlannedRows` 时序重排 + client 缺失整分支跳过（Q2a 前提 + Lens B m7）

`applyPlannedRows`（`triggers.ts:685-758`）当前签名 `(db, userId, injectedCollectionName?)`，job 起手（`:498`）
在 client 初始化**之前**调用一次（重放）。切官方 `delete()` 后，MERGE/RETRACT_NEW 分支需要 `MemoryClient`。裁决：
**惰性 getter 传入，只在真有 MERGE/RETRACT_NEW 待 apply 行时才要求 client；client 缺失时整分支跳过（含
`rewriteMemoryText`）且不 `markApplied`，留给重放**（沿用 F-4 优雅降级）：

```ts
async function applyPlannedRows(
  db: Db, userId: string,
  deps: { collectionName?: string; getClient: () => MemoryClient | undefined },
): Promise<void> {
  const pending = await loadUnappliedLog(db, userId);
  if (pending.length === 0) return;
  const collectionName = deps.collectionName ?? createMem0Config().vectorStore.config.collectionName ?? 'learning_project_memories';
  const needsClient = pending.some((r) => r.action === 'MERGE' || r.action === 'RETRACT_NEW');
  const client = needsClient ? deps.getClient() : undefined;
  if (needsClient && !client) {
    console.warn('[memory_reconcile] Mem0 client unavailable; MERGE/RETRACT_NEW rows left unapplied for resume');
  }
  for (const row of pending) {
    // m7：MERGE/RETRACT_NEW 且 client 缺失 → 整分支跳过（不跑 rewriteMemoryText，不 markApplied），留重放。
    if ((row.action === 'MERGE' || row.action === 'RETRACT_NEW') && !client) continue;
    switch (row.action) {
      // KEEP_BOTH / SUPERSEDE（raw SQL，不依赖 client）不变；
      // MERGE：rewriteMemoryText(...) 后 await hardDeleteMemory(client!, row.new_memory_id)
      //        + console.warn 破坏性 apply 结构化日志（Q3 检测）；
      // RETRACT_NEW：await hardDeleteMemory(client!, row.new_memory_id) + 同上日志。
    }
    await markApplied(db, row.id);
  }
}
```

调用点（两处，`:498`/`:649`）传 `{ collectionName, getClient: () => memoryClient }`；handler 内既有惰性
`memoryClient ??= createMemoryClient()`（`:504-516`）保持——起手重放那次若尚未初始化则 `getClient()` 返
undefined → 破坏性行留重放（下一 job 有 client 时执行）。**不把 client 初始化整体提前**（避免让纯 KEEP_BOTH/
SUPERSEDE 重放 job 无谓要求 mem0 key）。

### M4 — Q2b：write-ahead 快照列 + 写路径

`src/db/schema.ts` `memory_reconciliation_log`（`:1504-1523`）加两 nullable 列：

```ts
// YUK-538（Q2b）— ARIES 级 undo：记决策元数据不够，必须记足以重建旧状态的原文。write-ahead 阶段捕获
// （非 apply-time，防崩溃重放读到已改写值污染快照）。语义因 action 而异：SUPERSEDE/MERGE 存 old 行原文/
// 完整 payload（被软取代/被吸收那份）；RETRACT_NEW 的 prev_text 存 new 行原文（被丢弃那份），prev_metadata
// 留 NULL（其 metadata 由本项目 addEventMemory 刚写、可从 event 表溯源）。KEEP_BOTH 恒 NULL。可空——不回填历史行。
prev_text: text('prev_text'),
prev_metadata: jsonb('prev_metadata'),
```

`reconcile-store.ts`：`PlannedRow` 类型（`:26-35`）加 `prev_text?: string | null; prev_metadata?: Record<string,
unknown> | null;`；**`insertPlannedRows.values()`（`:43-54`）显式加这两列**（load-bearing，否则静默丢 + audit
fail）。新增只读 helper：

```ts
export async function capturePrevState(
  db: Db, collectionName: string, memoryId: string,
): Promise<{ text: string | null; metadata: Record<string, unknown> } | null> {
  assertSafeCollectionName(collectionName);
  const rows = await db.execute<{ payload: Record<string, unknown> }>(
    sql`SELECT payload FROM ${sql.raw(`"${collectionName}"`)} WHERE id = ${memoryId}::uuid`,
  );
  const payload = (rows as unknown as Array<{ payload: Record<string, unknown> }>)[0]?.payload;
  if (!payload) return null;
  const text = typeof payload.data === 'string' ? payload.data : null;
  return { text, metadata: payload };
}
```

（write-ahead 捕获已在 M1 的 `for...of` 里；`setPrevMetadata` 两阶段写 **已删除**——不再需要。）

### M5 — Q6：prompt/docstring 一致性

`reconcile-llm.ts:149` 加一行注释（不改 prompt 字符串）：说明这句是 LLM 侧唯一被告知阈值、执行侧另有
`passesStructuralCorroboration` + `kindForbidsMerge` 独立后处理层，与 `applyConfidenceThreshold` 同架构层次。
同步 `applyConfidenceThreshold` docstring（`:270-273`）+ memory-architecture.md §3.4/§3.5。

---

## 实施切片（PR 粒度，Lens B M3/M4 修正切片依赖）

| # | 内容 | 类型 | 文件 | 规模 | pre-flight |
|---|---|---|---|---|---|
| **S1** | Q2b schema 两列 + migration **且** Q1/Q2b write-ahead 写路径（`PlannedRow`+`insertPlannedRows.values()`+`capturePrevState`+write-ahead 捕获）**同 PR** | schema+server | schema.ts, drizzle/, reconcile-store.ts, triggers.ts | ~50 行 + migration | `pnpm audit:schema`（列**与 writer 同 PR** → 有 write path，不需 allowlist）；`pnpm db:generate` SQL 人工核（nullable ADD COLUMN=metadata-only） |
| **S2** | Q1 score floor + Q1b per-kind 闸 + 统一 action 合成 + reason 重写 + 候选携带 score + **score-present fixture 迁移** | server+test | reconcile-llm.ts, triggers.ts, *.test.ts | ~60 行 | 无 UI；targeted `triggers.test.ts`/`reconcile-llm.test.ts` |
| **S3** | Q2a `client.ts` `hardDelete`/`history`/`restoreVerbatim`；`reconcile-store.ts` `hardDeleteMemory` 切签名；`triggers.ts` `applyPlannedRows` 时序重排 + m7 跳过；**db-test 迁移（hardDelete 双 test-double 保物删覆盖）+ real-Memory tombstone 集成测试**（原子） | server+test | client.ts, reconcile-store.ts, triggers.ts, reconcile-*.db.test.ts | ~80 行 | targeted db-test；`pnpm build`（新 export 引用） |
| **S4** | Q3 破坏性 apply 结构化日志收拢（若未随 S2/S3 落）+ Q6 prompt/docstring 注释 + M0 doc 同步 + Q5 runbook（含 `restoreVerbatim`） | server+docs | triggers.ts, reconcile-llm.ts, memory-architecture.md, runbooks/ | ~20 行 + docs | 无 |
| — | Q3(a) 架构禁硬删、Q4 winsorize 除名 = 文档裁决，无代码 | 无代码 | 本 spec | — | — |

**合并策略**：**S1 必须列+writer 同 PR**（Lens B M3：列单独先行会让 `audit:schema` 写路径 gate fail；备份
覆盖"随整行 dump/restore"与写路径 gate 正交）。S2 相对独立可并行，但其 gate 只在**同 PR 带一条 score 明确偏低
的 fixture** 时才真生效（否则 `score===undefined` 恒 true 测试假绿）。S3 的签名改 + 全 test 迁移 + real-Memory
tombstone 测试**原子同 PR**（Lens B M4：否则物删集成覆盖降级为"mock 被调用"、tombstone 保证 unproven）。S4 可
随 S3 或单独 docs PR；runbook 在 S3 的 `restoreVerbatim` 落地前标"未完成"（Lens B M5）。

---

## 测试与 gate

### 新增/迁移测试点

1. **`reconcile-llm.test.ts`**：
   - `passesStructuralCorroboration`：MERGE/RETRACT_NEW 且 score<floor→false；≥floor→true；SUPERSEDE/KEEP_BOTH
     恒 true；`score===undefined` 恒 true。
   - `kindForbidsMerge`：weakness/event→true；preference/habit→false。
   - `CandidateEntry.score` 类型改动不破坏既有 `buildReconcilePrompt`/`parseReconcileResponse`。
2. **`triggers.test.ts` / `reconcile-handler.db.test.ts`**：
   - **score floor 未过 → MERGE/RETRACT_NEW 降级 KEEP_BOTH**，且断言 `llm_raw.structurally_corroborated===false`
     **AND `reason` 与 action 一致**（含 "Low structural corroboration" 且不再含裸 merge 理由——锁 A5-1 的
     action↔reason 一致，非只断 flag）。
   - **per-kind 闸**：kind=weakness 的 MERGE → KEEP_BOTH，reason 含 "Per-kind guard"（Q1b）。
   - **score floor 已过 + confidence≥0.6 → 正常执行**（回归，M1 不误伤正常路径）。
   - **RETRACT_NEW 候选空 → 闸跳过**，仅 0.6 把关，且断言打了 "floor skipped (no score)" 日志（m8）。
   - **既有 fixture 迁移**：所有 `searchResult.results` fixture 补 `score`，**必须至少一条"score 明确偏低"**
     才验证闸真生效（缺失=Q1 未被验证，硬性要求）。
   - **Q2b**：SUPERSEDE/MERGE 决策 `prev_text===oldMem.text`；RETRACT_NEW `prev_text===newMem.text`；KEEP_BOTH
     `prev_text===null`。SUPERSEDE/MERGE `prev_metadata` 为该行 write-ahead 时刻的完整 payload。
   - **M1 重放安全**：MERGE 在 `rewriteMemoryText` 后 `markApplied` 前崩溃 → 重放不覆写已存的 `prev_metadata`
     （因 write-ahead 已捕获，apply 不再捕获）——断言重放后 `prev_text`/`prev_metadata` 仍是原始值。
   - **m7**：client 缺失时 MERGE/RETRACT_NEW 待 apply 行留 `applied_at IS NULL` **且 old 行未被 rewriteMemoryText
     改写**（整分支跳过）；SUPERSEDE 待 apply 行仍正常执行。
3. **`reconcile-store.db.test.ts`（Lens B M4 迁移）**：
   - `hardDeleteMemory(client, memoryId)` 新签名：注入一个 **test-double `hardDelete` 执行对注入测试 COLLECTION
     的 raw DELETE**——保留 "physically deletes the row"/`getPayload===null`/idempotent 的**真物删覆盖**（不降级
     为"mock 被调用"）。
   - `capturePrevState`：存在行返回 `{text, metadata}`；不存在返回 null。
4. **real-Memory tombstone 集成测试（Lens B M4，新增，证明 Q2a 可回滚保证）**：testcontainer PG + tmp
   `historyDbPath` + 手动 pgvector INSERT 一行（含已知 `payload.data`，delete 路径不 embed）→ `new Memory(config)`
   → `memory.delete(id)` → 断言 SQLite `memory_history` 有 `action='DELETE'`、`previous_value=<text>`、
   `is_deleted=1` 的行。`better-sqlite3` 已装（package.json:84，§8.6 本地编译）。**若无法 hermetic**（Memory 构造
   触网/需 embedder key），按 YUK-501 CI-skip 模式 gate 但**必须 author**——纯 mock 不能证明 tombstone。

### Gate

- `pnpm typecheck`（新方法签名、`CandidateEntry.score`、`PlannedRow` 新字段）。
- `pnpm audit:schema`（S1 列**与 writer 同 PR** → 有 write path，不需 allowlist；若 audit 要 allowlist 说明列/
  writer 被拆到不同 PR，回查切片）。
- `pnpm test:db:watch src/server/memory/reconcile-handler.db.test.ts` + `reconcile-store.db.test.ts`（targeted）。
- Pre-PR：`pnpm typecheck` + `pnpm lint` + `pnpm audit:schema` + `pnpm audit:partition` + `pnpm test` + `pnpm build`。
- `pnpm db:generate` migration SQL 人工核（两 nullable 列 ADD COLUMN，Postgres metadata-only，不锁全表）。

---

## 回滚与运维 runbook

> 落点：`docs/runbooks/memory-reconcile-undo.md`（本节为初稿）。**S3 的 `restoreVerbatim` 落地前本 runbook 标
> "未完成"**（恢复 hop 依赖它，Lens B M5）。

### 场景 A：MERGE/RETRACT_NEW 误删了一条记忆

1. 从 `memory_reconciliation_log` 按嫌疑窗口/`user_id` 查：
   ```sql
   SELECT id, action, reason, new_memory_id, old_memory_id, prev_text, prev_metadata, llm_raw
   FROM memory_reconciliation_log
   WHERE user_id = 'self' AND action IN ('MERGE','RETRACT_NEW')
   ORDER BY planned_at DESC LIMIT 20;
   ```
2. **主恢复源 = `prev_text`（WAL，在备份边界内）**：非空 → 直接用它，跳步 4。
3. **副保底 = mem0 SQLite tombstone**（仅当 `prev_text` 空，即历史遗留行；注意此库在 `mem0data` 卷、**不在逻辑
   备份内**，可能与 PITR 全库 restore 分叉——Lens B m6）：
   ```
   sqlite3 <historyDbPath> "SELECT previous_value, created_at FROM memory_history
     WHERE memory_id='<uuid>' AND action='DELETE' ORDER BY id DESC LIMIT 1;"
   ```
   （`<historyDbPath>`：prod 挂载卷 `/var/lib/mem0/history.db`；dev `MEM0_HISTORY_DB_PATH`。`<uuid>` 是
   RETRACT_NEW 的 `new_memory_id` 或 MERGE 删的 `new_memory_id`。）
4. **诚实预期**：恢复是"把原文经 `restoreVerbatim` 重新入库"，产**新 UUID 新行**（重 embed），**非原行复活**。
   metadata：`prev_metadata` 有值（SUPERSEDE/MERGE 场景）可一并恢复；RETRACT_NEW 场景需从 `event` 表按
   `event_id`（`prev_metadata`/tombstone 无则从原 `llm_raw` 溯源）重推，或接受"文本对、metadata 缺"降级。
5. 逐字恢复（**用 `restoreVerbatim`，绝不用 `addEventMemory`**——后者 infer:true + eventToText 信封会重跑抽取 LLM、
   非逐字，Lens B M5）：
   ```ts
   const client = createMemoryClient();
   await client.restoreVerbatim(prevText, reconstructedMetadata /* 从 prev_metadata / event 表重建 */);
   ```

### 场景 B：SUPERSEDE/MERGE 覆写了错误内容

1. 查 `memory_reconciliation_log`，关注 `action='SUPERSEDE'`/`'MERGE'`。
2. `prev_text`/`prev_metadata` 是**被覆写前**的原文/payload。
3. 恢复：MERGE（`rewriteMemoryText` 覆写 old 行，行未物删）→ 用同款 raw-SQL jsonb merge 把 `prev_text` 写回
   `payload.data`（**原行字面恢复**）；SUPERSEDE（只加 `superseded_by`/`invalid_at`）→
   `UPDATE ... SET payload = payload - 'superseded_by' - 'invalid_at'`（删两键，重对 P3 可见）。

### 场景 C：批量核查某窗口内破坏性决策（Q3 检测面之一）

```sql
SELECT action, count(*), avg((llm_raw->>'confidence')::float) AS avg_confidence,
       count(*) FILTER (WHERE (llm_raw->>'structurally_corroborated')::bool = false) AS floor_downgraded
FROM memory_reconciliation_log
WHERE planned_at > now() - interval '7 days'
GROUP BY action;
```
配合结构化日志（每次破坏性 apply / 降级 / floor 跳过都打一行可 grep）——**这两者构成本波的最小检测面**
（Lens A A4-2：可回滚依赖可检测），使 owner 能主动发现误删并触发本 runbook。

### 已知限制（如实标注）

- 全程手动 SQL + 脚本，无一键 undo（Q5 最小充分形态）。
- mem0 tombstone 只存文本、不存 vector/完整 metadata，且**在备份边界外**（副保底，非主源）——主源是 WAL `prev_text`。
- Q2b 上线前的历史 WAL 行无 `prev_text`/`prev_metadata`，只能依赖 mem0 tombstone（若涉硬删）或不可回滚。
- `restoreVerbatim` 依赖 mem0 `add(...,{infer:false})` 语义——executor 落地时须核（见 M2 注释）。

---

## 开放问题（owner 级，真正需要拍的）

1. **Q1b per-kind MERGE 抑制是否采纳**（本稿**推荐采纳完整案**）：`weakness`/`event` 硬禁 MERGE，比 prompt 的
   "lean toward KEEP_BOTH" **略严**。理由：错题轨迹一旦误并即灭失历史、代价不对称，且这是 score floor 结构上补不了
   的高相似误 MERGE 的唯一便宜闸。owner 若要保留偶尔 MERGE 自由 → 退轻案（仅文档承认残留）。
2. **`MERGE_RETRACT_SCORE_FLOOR = 0.5` 数值**：结构性保守初值（>mem0 预过滤 0.1，<直觉高置信度上限），非强论证
   锁死。owner 可调（0.6 与 confidence 对齐更保守 / 0.3 更宽松），不影响其余机制。
3. **最小检测面已定为同波必做**（结构化日志 + 场景 C SQL，非 defer）——是否**追加只读 admin 端点**
   （`GET /api/_/memory-reconcile/:id` 展示 `prev_text`/tombstone，复用 `client.history()`）？本稿判**暂不需**
   （改动面小，owner 若认为值得半天可加）。
4. **Q3(a) 架构性禁硬删是否提前排期**：本波不做（(b)+tombstone+WAL 已让可回滚字面满足）；owner 若认为把
   `knowledge_edge.archived_at` 软归档模式统一到 memory 半边的产品价值优先，可独立提前（不影响其余 5 决策）。
5. **real-Memory tombstone 集成测试的 hermeticity**（Lens B M4）：若 `new Memory(config)` 无法 hermetic
   （触网 / 需 embedder key），接受 YUK-501 式 CI-skip gate 还是要求更轻证明？本稿要求**至少 author 一次**——纯
   mock 不能证明 tombstone 这条可回滚保证。owner 拍 CI 策略。

---

## 附录 — Attack 裁决 ledger

两轴对抗审查逐条裁决（ACCEPT=修入终稿 / PARTIAL=部分修入 / REJECT=不采纳）。全部 file:line 已对 `d705dfe1`
重接地。

### Lens A（裁决语义轴）

| # | 严重度 | 裁决 | 理由与落点 |
|---|---|---|---|
| A1-1 | MAJOR | **PARTIAL** | 语义观察正确（RETRACT_NEW=noise∪duplicate，相似度关系相反，`reconcile-llm.ts:134`）→ ACCEPT 修入 Q1 三分表 + 论证 #3 诚实定性。**REJECT** "harmful false-negative / MAJOR" 框架：noise-RETRACT 降级 KEEP_BOTH 是**安全方向**（保留=可回滚不销毁），非违反红线。**REJECT** `reason_kind` prompt 字段修法（违非目标 + n=1 极简 + 扩 LLM 契约）。ACCEPT 内部不自洽修正（"降级=安全"公理 vs Q3 对称代价）→ 改述"安全 for 红线但非零成本（检索污染）"。残留"noise-weak-neighbor 保留"记为已接受 owner-可翻 |
| A1-2 | MINOR | **ACCEPT** | MERGE floor 方向无歧义正确 → Q1 拆三分（MERGE 挂 floor 用具体候选分 / RETRACT_NEW 挂 floor 带 caveat / SUPERSEDE 免闸），不再 MERGE+RETRACT 同闸 |
| A2-1 | MAJOR | **ACCEPT** | 高相似误 MERGE 从双闸间穿过（score floor 与该错误反相关），伤 weakness/event 轨迹（`reconcile-llm.ts:143`）→ 新增 Q1b：显式承认敞口 + 确定性 per-kind 执行闸（weakness/event 禁 MERGE）。两案并呈，**推荐完整案**，owner 批 |
| A2-2 | MINOR | **ACCEPT(light)** | 不过度攀 Fellegi-Sunter 三档权威 → 第二闸改述"二元保守闸"，FS 第三档"uncertain→人工"映射到 Q3 deferred 软归档，不作 load-bearing 依据。无机制改动 |
| A3-1 | MAJOR | **ACCEPT** | Q4 除名论证过时（pre-Q1）且与 M1 max 归约矛盾 → 结论保留，论证重做覆盖 confidence + score 两连续值；承认 `topCandidateScore=max` outlier-permissive；更稳健解=用具体候选/floor 跳过，非 winsorize |
| A4-1 | MAJOR | **ACCEPT** | Q3/Q5 两套互斥用户模型 → 统一为专家 owner（ADR-0007）；Q3"软归档产品语义困惑"论据删除，改靠 vector-污染真论据 |
| A4-2 | MAJOR | **ACCEPT** | 摩擦账算反 [(a) 有 archived_at 模板、owner 稳态手动≈0；(b) 无检测=可回滚纸面成立实操不可达] → Q3 保留 (b) 但用 vector-污染 steelman 替换弱论据，**最小检测面（结构化日志+场景C SQL）提为同波必做**（非 defer）。dashboard 仍 defer |
| A5-1 | MAJOR | **ACCEPT** | score-floor 降级不重写 reason → action↔reason 自相矛盾 WAL 行，回归"可追溯"（本单元正因）。对照 `applyConfidenceThreshold:284` → M1 统一 action 合成对称重写 reason；测试断言 action↔reason 一致（非只断 flag）。**升为硬验收** |
| A5-2 | MINOR | **ACCEPT** | M1/M4 `action` vs `finalAction` 三处各说各话 → M1 给单一完整 makePlannedRow，顺序 badTarget→per-kind→score-floor→final，reason/old_memory_id/prev_text 全读同一 final action |
| A5-3 | MINOR | **ACCEPT** | Q6 改为**权衡后决策**（非断言）：仍选隐藏 floor（LLM 拿不到数值 score，披露不改善校准）+ 同步 `applyConfidenceThreshold` docstring（`:270-273` under-describe） |

### Lens B（存储/回滚/运行时轴）

| # | 严重度 | 裁决 | 理由与落点 |
|---|---|---|---|
| M1 | MAJOR | **ACCEPT** | `prev_metadata` apply-time 捕获被幂等重放污染（`triggers.ts:498` 重放读 post-merge payload）→ correctness 非 taste。改**两列都 write-ahead 阶段捕获**，apply 不再捕获，`setPrevMetadata` 两阶段写删除 |
| M2 | MAJOR | **ACCEPT** | `insertPlannedRows.values()`（`reconcile-store.ts:41-55`）显式列映射非 spread → `prev_text` 不加映射会静默丢 + audit:schema fail。`PlannedRow` 类型 + `.values()` 同步加两列 |
| M3 | MAJOR | **ACCEPT** | schema-only 切片过不了自己的 audit:schema（写路径 gate ≠ 备份"随整行覆盖"）→ 切片 S1 列+writer 同 PR。`FK_ORDER`（constants.ts:168）/additive-列-不-bump 惯例确认（正交轴，无碍） |
| M4 | MAJOR | **ACCEPT** | hardDelete 改签名 guts 物删集成测试（reconcile-store.db.test.ts:134-146、reconcile-handler.db.test.ts:302-352 `newRows.toHaveLength(0)` vs 真 COLLECTION）→ (1) 注入 hardDelete test-double 执行真 raw DELETE 保物删覆盖；(2) 新增 real-Memory tombstone 集成测试（纯 mock 不能证明 tombstone） |
| M5 | MAJOR | **ACCEPT** | runbook restore hop 用 `addEventMemory`（`client.ts:185-208` infer:true + eventToText 信封）非逐字 + 误塑输入 → 新增 `restoreVerbatim(text,metadata)` 原语（`memory.add(...,{infer:false})`），runbook 改用它，executor 须核 mem0 infer:false 语义 |
| m6 | MINOR | **ACCEPT** | tombstone 在 `mem0data` 卷、不在逻辑备份边界（archive.ts 只备 collection+WAL）→ 耐久性弱于 WAL。**主次颠倒**：WAL `prev_text` 主恢复源，mem0 tombstone 副保底。Q2a/runbook 各一句 |
| m7 | MINOR | **ACCEPT** | client 缺失时半应用 MERGE（rewriteMemoryText 已跑 + hardDelete 跳）→ 若误 markApplied=永久 orphan。M3 明确：MERGE/RETRACT_NEW 且 client 缺失 → 整分支跳过（不跑 rewriteMemoryText）+ 不 markApplied，留重放 |
| m8 | MINOR | **ACCEPT** | 第二闸 `score===undefined` 时静默 fail-open → 加 console.warn + 可计数 marker（floor skipped no score），并入 Q3 检测日志 |
| m9 | MINOR | **CONFIRMED 非-finding** | MERGE 留 `textLemmatized` 陈旧=既有 re-embed-on-merge 缺口（register P2），本波不引入不加剧；raw-SQL 保留（P0-1 update() 红线）在此轴 sound。仅文档标注 out-of-scope |

**净结论**：两大机制意图（官方 `delete()` 给真 text tombstone——装机源码 index.mjs:6980→7164 逐行确认；WAL
`prev_text` 零迁移 additive）成立，但 draft 早期欠规格 3 处 load-bearing wiring（insertPlannedRows 写路径、
apply-vs-write-ahead 捕获时序、hardDelete 测试迁移）+ over-claim 1 处不工作的 restore hop——均已修入终稿。切片
依赖已按 M3/M4 校正。

---

## 附录 — Owner 决策实录（2026-07-03，AskUserQuestion）

开放问题五项处置：

1. **Q1b per-kind MERGE 抑制**：owner 拍「硬禁 MERGE（推荐）」——`weakness`/`event` 的 MERGE 一律确定性降级
   KEEP_BOTH，采纳完整案。
2. **`MERGE_RETRACT_SCORE_FLOOR`**：owner 拍 **0.5（推荐）**。代码注释按 Q1 论证 #4 原样标注
   「未经数据验证的保守地板值，非拟合结果」。
3. **只读 admin 端点**：按本稿推荐自决**暂不建**（检测面 = 结构化日志 + 场景 C SQL；端点留条件触发 follow-up）。
4. **Q3(a) 架构性禁硬删**：owner 拍「本波不做（推荐）」——(a) 留档为条件触发升级（误删率偏高且 runbook
   挽救不力时）。
5. **real-Memory tombstone 测试 CI 策略**：按本稿要求自决——**必须 author**；若 `new Memory(config)` 无法
   hermetic（触网/需 embedder key），按 YUK-501 式 CI-skip gate（skip 时打显式理由日志），纯 mock 不可替代。

Linear：YUK-557（parent YUK-538）。
