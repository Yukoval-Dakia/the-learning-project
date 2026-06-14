# 记忆架构设计：混合形态（KG 自建 + mem0 个性化层）

> **状态**：用户已拍板方向（2026-06-13），本稿为该决策的设计落地稿。
> **关联**：Linear YUK-322（调查全链路：机制定论 / 工具评估 / 调和层源码研究 / spike 实测均以评论回写在案）。
> **决策**：知识半边维持自建（参考 Graphiti 设计）；个性化半边挂 mem0 v3 运行时 + 自建调和层。
> **本稿自包含**：spike 工作目录 `/tmp/mem0-spike/` 为临时环境，关键事实已全部收编进本稿与 YUK-322 评论。

---

## 1. 背景与问题

学习工具需要两类长期记忆，性质不同：

| | 知识半边 | 个性化半边 |
|---|---|---|
| 内容 | 知识点树/边、提议、掌握度、FSRS 调度 | 学习者偏好、习惯、弱点、学习事件（episodic） |
| 真相形态 | 结构化、强 schema、UPDATE 主旋律 | 非结构化陈述、随对话自然涌现、会过时/互相矛盾 |
| 现状 | 已自建（knowledge 包 + PG 表 + AI 提议环） | 无系统化方案 |

调查结论（YUK-322，三档证据：源码/官方文档/issues）：

- **mem0 v3 是 ADD-only**：TS OSS 3.0.7 的 add() 管道硬编码 `event:"ADD"`，经典调和环（per-fact 检索 + ADD/UPDATE/DELETE/NONE 决策）只存在于 2.4.6，3.0.0 起移除；官方 NOT_PLANNED（issues #4896/#4904 closed，#4956 无回复）；**托管平台 v3 同样 ADD-only**，换托管版躲不开。
- 但 mem0 的**抽取质量实测好**（尤其配 glm-x-preview：时间锚保留、中文术语内联保真、《论语》引用无幻觉）——这是「挂 mem0 而非全自建」的核心理由。
- Graphiti 的核心增量是 **bi-temporal（valid_at/invalid_at）+ 写入期矛盾调和环（resolve_extracted_edge）**，与自家 KG（类型化边 + AI 提议 + 软归档 + 溯源）高度同构——只值得抄设计，不值得引运行时。
- **FSRS/掌握度等 UPDATE 主旋律的学习者状态不进 mem0**，留自家 Postgres 结构化表。mem0 只承接个性化/episodic 层。

## 2. 总体形态

```
┌─────────────────────────────────────────────────────────┐
│                      学习工具内核                          │
│                                                          │
│  知识半边（自建，已有）          个性化半边（新增）          │
│  ┌────────────────────┐       ┌────────────────────────┐ │
│  │ knowledge 包        │       │ mem0 v3 TS OSS         │ │
│  │ PG: 树/边/提议       │       │ (in-process + 自家      │ │
│  │ FSRS/掌握度          │       │  pgvector collection)  │ │
│  │                     │       ├────────────────────────┤ │
│  │ ＋Graphiti 设计借鉴： │       │ 自建调和层（pg-boss job）│ │
│  │  bi-temporal 时效    │       │ 自建读路径 wrapper       │ │
│  │  写入期调和环         │       │ reconciliation_log 审计 │ │
│  └────────────────────┘       └────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

两半边各自独立演进；交叉点只有一个：个性化记忆可携带 `knowledge_ids` metadata 指向知识点（沿用 mistakes 既有管线的实体解析思路），不反向把 mem0 当知识存储。

## 3. 个性化半边设计

### 3.1 运行时配置

- **mem0ai TS OSS 3.0.7**（in-process，无独立服务），vectorStore 指向自家 Postgres 的 pgvector（独立 collection 表，不与业务表混用）。
- **LLM**：抽取与调和均用 glm-x-preview（coding plan endpoint）。对照实验：质量优于 mimo（时间锚/术语保真/无幻觉），代价是更慢（11-20s vs 7-15s/段）。
- **Embedding**：阿里百炼 text-embedding-v4（C-MTEB 领先；实测与智谱 embedding 质量等价、时延同量级）。
- **遥测**：生产 compose 必须 `MEM0_TELEMETRY=false`（默认向 PostHog 上报每次 add/search/update/delete）。
- **history（SQLite sidecar）**：保留 `disableHistory: false`——spike 实测 `disableHistory: true` 有隐性副作用（DummyHistoryManager 无 getLastMessages → 抽取 prompt 的 "Last k Messages" 恒空，损伤 infer:true 抽取质量）。SQLite 单写者约束靠拓扑解决（见 3.5）：**所有 mem0 写操作收敛到 worker 进程**，`memory.db` 指向挂载卷。

### 3.2 mem0 已知约束（红线清单）

实施时必须遵守，每条均有源码实证（YUK-322 调和层研究评论）：

1. **公开 `update()` 禁用**：不接收 metadata 且会替换式清除旧 payload 的全部自定义字段 + `textLemmatized`（该记忆从此退出 BM25 关键词检索通道）。包 wrapper 封禁直调。
2. **metadata 必须顶层扁平字段**（filter key 限 `[a-zA-Z_][a-zA-Z0-9_]*`，无嵌套路径）。
3. **`gte/lte` 强制 `::numeric` cast**——ISO 日期字符串直接 SQL 报错。需要 DB 端时间过滤的字段，add 时写 epoch 毫秒（如 `created_ms`）。
4. **`limit` 已更名 `topK`**（3.0.0 breaking；传 `limit` 静默忽略、返回全量）。
5. **`deleteAll` 单次上限 100 条**（内部 list 默认 LIMIT 100）。
6. **add() 返回可能为空**（md5 精确去重静默吞条目），调和层须容忍空结果。
7. **add 管道无任何 hook**——调和层唯一干净接入点是 add() 返回之后。

### 3.3 数据模型：软取代（soft-supersede）

旧记忆**从不物理删除**，矛盾/过时一律 metadata 软取代——契合 evidence-first（可逆、可追溯）：

- payload 上的调和字段：`superseded_by`（新记忆 UUID）、`invalid_at`（ISO，给人读）、`created_ms`（epoch 毫秒，给 DB 端过滤）。
- 写入方式：**直写 Postgres jsonb merge**（spike 实测 WORKED——原子、零 re-embed、textLemmatized 完好）：

```sql
UPDATE <collection> SET payload = payload || jsonb_build_object(
  'superseded_by', $2::text,
  'invalid_at',    $3::text
) WHERE id = $1
```

> ⚠️ spike 实测坑：参数化 `jsonb_build_object` **必须显式 cast**（`$2::text` 等），否则 pg 报 `42P18 could not determine data type of parameter`。

- 查询端排除已取代（spike 实测两条路径语法**不同**，不可混用）：
  - `search()`：大写 `NOT: [{ superseded_by: '*' }]`（经 `_processMetadataFilters` 转译）；
  - `getAll()`：小写 `$not: [{ superseded_by: '*' }]`（直达 `buildFilterConditions`；大写 NOT 在 getAll 会被当普通 payload 键，语义错误）。
  - 等价 SQL 均为 `NOT (payload ? 'superseded_by')`；spike 实测过滤即时生效（标记后下一次 search 自动排除）。
- 本轮调和**自己刚 add 的新条**允许硬删（MERGE/RETRACT_NEW 场景：尚无下游引用，硬删 + reconciliation_log 留底足够；delete 的 "not found" 错误按幂等成功吞掉）。

### 3.4 调和层（核心自建件）

**触发**：`add()` 返回后投递 pg-boss job（`singletonKey: user_id` 串行化每用户队列，解并发竞态——mem0 自身无锁）。

**流程**（单 job）：

1. 对每条新增记忆 `search(text, { filters: { user_id, NOT: [{superseded_by:'*'}] }, topK: 5, threshold: 0.35 })`，剔除本批自身。
2. 全部新增记忆合并进**一次**调和 LLM 调用（沿用 2.4.6 单调用形制；旧记忆用顺序索引 "0".."n" + 本地 UUID 映射表，防 LLM 抄错 UUID）。
3. 动作空间（入库后决策，与 2.4.6 入库前决策不同）：
   - `KEEP_BOTH`——并存（episodic 事件类默认）；
   - `SUPERSEDE`——旧条软取代，新条胜（偏好/习惯类矛盾默认，recency 假设）;
   - `MERGE`——合并文本改写旧条 + 硬删新条；
   - `RETRACT_NEW`——新条是噪声/重复，硬删。
   - per-kind 规则写进 prompt（preference/habit 倾向单一最新真相；event/episodic 倾向并存靠时间轴区分）。
4. apply 前先写 `memory_reconciliation_log` 意图行（write-ahead），物理 delete 永远放最后一步；job 重试按日志幂等续跑。

**调和 prompt 措辞红线**：3.0.7 的 LangchainLLM 残留 prompt 嗅探——user prompt 同时含 `"smart memory manager"` 与 `"Compare newly retrieved facts"` 会被自动劫持进旧版 `MemoryUpdateSchema` 结构化输出。自定义动作枚举必须避开这两句。

**安全降级**：决策 JSON 解析失败 → 整批降级 `KEEP_BOTH` + 告警日志。v3 ADD-only 的天然优势：「不调和」的最坏结果只是冗余并存，不是数据丢失。

**spike 验证（2026-06-13，20/20 断言全过，研究包零推翻）**：

| 项 | 实测结果 |
|---|---|
| jsonb 软取代直写 | 原子、零 re-embed、textLemmatized 完好 |
| NOT / $not 过滤 | 两路径语法各自生效，标记后即时排除 |
| glm-x-preview 调和决策 | 3 组 9 条零误判，中文理由准确 |
| 延迟分布 | search ~200ms；LLM 4-27s；apply 0-14ms——**LLM 占 95-99%** |
| 全 NONE（无矛盾）批次 | LLM 判断快 5-7×（~4s vs 23-27s） |

延迟分布证实调和**必须走后台 job**，不做 add 后同步内联（add 本身已含抽取 LLM 2-5s+，交互路径不可叠加）。查询端 superseded 过滤兜底，调和延迟几秒到几十秒可接受——过渡窗口最坏只是「短暂看到两条相近记忆」。

### 3.5 审计与拓扑

- **自建 `memory_reconciliation_log`（Postgres）是唯一完整证据链**：`id, user_id, new_memory_id, old_memory_id, action, reason, llm_raw, planned_at, applied_at`。mem0 自身 history 缺 actor/reason、无 user_id 索引，且 jsonb 直写本就绕过它——只作辅助，不作依赖。
- **写拓扑**：add（抽取 LLM 2-5s+，同样不适合交互路径）与 reconcile 都经 pg-boss 进 worker 进程执行 → SQLite 单写者约束自然满足；API 进程只做 search/getAll 读（不写 SQLite）。
- **密钥**：mem0 相关 key（GLM / 百炼）走 compose env 注入，与现有 AI key 管理同轨；不落仓库。

### 3.6 读路径 wrapper

所有读收敛到一个 `searchMemories(query, opts)` seam（与 superseded 过滤同一落点）：

1. `memory.search` 取 `topK × 2~3` 候选（带 NOT superseded 过滤）；
2. 应用层 recency 重排：`score' = score × exp(-ln2 × ageDays / halfLifeDays)`，半衰期按 kind 区分（preference 长、event 短）——补 TS 端缺失的 temporal boost（Python 2.0.5 有 temporal_boost，TS 3.0.7 没有）；
3. 截断 topK 返回。

### 3.7 边界（不做什么）

- FSRS、掌握度、复习调度、知识结构——全部留 PG 结构化表，**不进 mem0**。
- mem0 不做知识存储；个性化记忆至多以 `knowledge_ids` metadata 指向知识点。
- Memobase 维持纯参考（slot 模型按 kind 分桶的思路已吸收进调和 prompt 的 per-kind 规则），不挂运行时。
- 不钉旧版 2.4.6（EOL，失去上游修复）；不 hack TS-private `updateMemory`（版本锁定风险，仅留作无 SQL 通道时的备胎记录）。

## 4. 知识半边设计（Graphiti 借鉴）

自家 KG 已具备：类型化边、AI 提议环（proposals + 人审）、软归档、溯源。从 Graphiti 只抄两件事：

1. **bi-temporal 时效语义**：知识侧「事实性陈述」（如学习者对某知识点的状态快照、边的有效期）补 `valid_at` / `invalid_at` 两轴——「事实何时为真」与「记录何时写入」分离。落点是知识侧后续 schema 演进，不是本次实施范围。
2. **写入期调和环形制**（resolve_extracted_edge）：AI 提议新边/新陈述时，检索既有相邻事实喂给决策 prompt，让「新提议与旧事实矛盾」在写入期被显式判定（取代/并存），而非堆积到读取端。该形制与 3.4 的调和层同构——实现时共享 prompt 骨架与 log 表设计。

科目即视角、树按认知结构生长等既有 KG 原则不变（见 ADR 体系）。

## 5. 实施切分

不进 M5（YUK-321 范围已定）。建议独立 issue 链推进：

- **P1 运行时挂载**：mem0 3.0.7 + pgvector collection + glm/百炼配置 + telemetry off + wrapper 封禁 update()。
- **P2 调和层**：pg-boss job + 调和 prompt + jsonb 软取代 + `memory_reconciliation_log` 表（migration）+ 失败模式测试（解析失败降级 / 半途失败幂等续跑 / 并发 singletonKey）。
- **P3 读路径**：searchMemories wrapper（过滤 + recency 重排）+ 写入面接线（哪些对话/事件流喂 add——产品层决策，需单独讨论）。
- **P4 知识半边增量**：bi-temporal 字段 + 写入期调和环（共享 P2 的 prompt 骨架与 log 设计）。

## 6. 失败模式速查

| 失败模式 | 对策 |
|---|---|
| 调和 LLM 误判 SUPERSEDE/MERGE | 旧条只软取代不硬删 → 删 payload 键 + log 回滚即撤销；决策带 confidence，低于阈值降级 KEEP_BOTH |
| 决策 JSON 解析失败 | 整批 KEEP_BOTH + 告警（最坏=冗余并存，无丢失） |
| 并发 add 竞态 | pg-boss `singletonKey: user_id` 串行化 |
| apply 半途失败 | write-ahead log + 物理 delete 放最后 + "not found" 幂等吞掉；残留重复由下轮 md5 去重 + 调和收敛 |
| 误用公开 update() | wrapper 封禁 + 评审红线（metadata 与 textLemmatized 双清除） |
| mem0 升级行为漂移 | 约束清单（3.2）逐条有源码行号留痕于 YUK-322；升级时按清单回归 |

## 7. 开放问题

1. **写入面接线**（P3）：哪些信号喂 mem0 add——copilot 对话轮？练习提交后的总结？错题复盘？产品层决策，待与练习旅程（P2 architecture redesign）合流讨论。
2. **kind 分类法**：preference / habit / weakness / event 的最终枚举与 per-kind 半衰期参数，待真实数据校准。
3. **bi-temporal 落点**（P4）：知识侧哪些表先补 valid_at/invalid_at，与架构重设计 D 系决策的次序关系。

---

## 8. 实施锁定（2026-06-14，Map + 供应商研究后）

> §1-§7 当时按 greenfield 写。Map（5 路 fan-out）发现**个性化半边已有一套接好线的 mem0 pipeline**（YUK-140/YUK-232，5-6 月建）——所以这是 **in-place 重构**，不是绿地。本节对账现状 + 锁定实施细节，覆盖前文与之冲突处。

### 8.1 现状 pipeline（重构主体）

- 写：`writeEvent`（events/queries.ts，唯一 INSERT，`ingest_at IS NULL`=outbox 游标，ADR-0021）→ 每分钟 `memory_ingest_outbox_poll`（`FOR UPDATE SKIP LOCKED` 同 tx claim+enqueue+stamp）→ `memory_event_ingest` handler（triggers.ts:163 `client.addEventMemory`，infer:true，worker 进程）→ fan-out `memory_brief_regen`。
- 读：`MemoryClient.search`（client.ts:217-224，强制 `user_id:'self'`）两消费者——`search_memory_facts` 工具（copilot/dreaming/coach）+ brief regen searchFacts。
- facts 落 pgvector collection `learning_project_memories`（mem0 自管，**不在 Drizzle**）。
- **零调和层**（全仓 grep 无 superseded_by/reconciliation_log）。

### 8.2 范围校准

- **brief 子系统正交、不在重构内**：`memory_brief_note` 是 NOTE 层（自家 PG 表 + 自家 LLM task `MemoryBriefTask`，现 mimo-v2.5-pro，**维持不动**——设计只换 mem0 抽取/调和的 LLM）。唯一接线点：brief 的 searchFacts（triggers.ts:207）在 P3 后改走 `searchMemories` wrapper（带 superseded 过滤），否则会把已取代 fact 固化进 brief。
- **KG 侧已有软取代原语可复用**（P4）：`getEffectiveTruth` + `CorrectionKind=['supersede','retract','mark_wrong','restore']`（core/schema/event/known.ts，event 层）+ `knowledge_edge.archived_at`（写时间侧软归档）。P4 bi-temporal 补 `valid_at/invalid_at` 不另起炉灶，写入期调和环挂 `runProposeAndWrite`（knowledge/server/propose.ts）。
- **reconcile 队列**：沿用 memory_* 既有外挂注册（`registerMemoryHandlers` triggers.ts:392），不本批迁 capability manifest（记欠债：memory pipeline 整体外挂于 manifest 体系，违 CLAUDE.md「capability 包是 jobs 唯一登记面」——独立 follow-up）。

### 8.3 配置锁定（client.ts createMem0Config）— 研究实证基于**已装的 3.0.6 源码**

| 项 | 锁定值 | 依据 |
|---|---|---|
| LLM | provider `openai`（**非 anthropic**），model env `MEM0_LLM_MODEL` 默认 `glm-5.2`，baseURL **`https://open.bigmodel.cn/api/coding/paas/v4`**（coding plan 端点，**勿加 /v1**；global=`https://api.z.ai/api/coding/paas/v4`），key `ZHIPU_API_KEY` | openai provider 转发 `config.baseURL`（index.js:271）→ **整套 withXiaomiBaseUrl env-dance + YUK-232 mutex + 3 测试可整块删**；createMemoryClient 变回纯同步无全局副作用。**端点必须 coding 版**——标准 `/api/paas/v4` 对 coding-plan 模型返 403（owner 实测 2026-06-14） |
| Embedding | provider `openai`（compat），model `text-embedding-v4`，baseURL `https://dashscope.aliyuncs.com/compatible-mode/v1`（含 /v1），key `DASHSCOPE_API_KEY`，**1024 维** | 反正 wipe 重建，取官方推荐性价比最优维度 |
| 维度双写 | `embedder.config.embeddingDims` **==** `vectorStore.config.embeddingModelDims` == 1024 | 两字段名不同（前者把 `dimensions` 传百炼 v4，后者建 pgvector 列），必须同值否则插入维度不匹配 |
| disableHistory | `false` + 显式绝对 `historyDbPath`（默认相对 cwd 多进程踩坑） | `search()` 方法体零 history 写（只 add/update/delete 写 SQLite，index.js grep 决定性）→ app 进程读端安全，单写者只管写端（已在 worker） |
| update() | wrapper 不导出/不转发 | mem0 公开 `update(id,data)` 真实存在（index.js:7023），红线封禁 |
| collection | **wipe 重建**（owner 拍板 2026-06-14） | 换 embedding 模型旧向量语义失效；dev 多噪声，接受丢失 |
| mem0ai 版本 | **维持 3.0.6**（不升 3.0.7） | 研究全程基于 3.0.6 实装源码实证，升级引漂移风险无收益 |

> GLM-5.2 REST API 据查 06-14 可能尚未 GA（官方页只到 glm-5，公告「API 下周上线」）；owner 称其 plan 有 5.2/preview access。model id 做成 env，联调 404 时回退 `glm-5` 或换 owner 给的确切 id。

### 8.4 P1-P4 in-place 落点（每 P 一个 Linear 子 issue，链于 YUK-322）

- **P1 配置换血**：client.ts createMem0Config 按 §8.3 改 + 删 env-dance + update() 封禁 + 改 client.test.ts 硬断言 + .env.example/preflight env 名 + collection wipe（drop `learning_project_memories`，首 add 时 mem0 按新维度重建）+ 三步联调验证（GLM add / 百炼 embed 维度 / pgvector 列对齐）+ **disableHistory:false 的原生模块 plumbing（§8.6 实施期发现）**。
- **P2 调和层**（核心新增）：add() 返回后投 `memory_reconcile` pg-boss job（singletonKey:user_id）；调和 prompt（避开「smart memory manager」「Compare newly retrieved facts」劫持措辞，per-kind 规则）；jsonb 软取代直写（`superseded_by`/`invalid_at`/`created_ms`，参数显式 ::text cast）；`memory_reconciliation_log` 表（migration + audit:schema write-path，write-ahead 行）；失败模式测试（解析失败降级 KEEP_BOTH / 半途幂等续跑 / 并发 singletonKey）。addEventMemory metadata 补 `created_ms` + `kind`（喂 per-kind 规则）。
- **P3 读路径 + 写入面**：`searchMemories(query,opts)` wrapper（落 client 层，两消费者透明获益）——topK×2~3 召回 + `$not:[{superseded_by:'*'}]`/大写 `NOT` 过滤 + recency 重排（`score'=score×exp(-ln2·ageDays/halfLife)`，按 kind 半衰期，补 TS 端缺的 temporal boost）；两读点（search-memory-facts.ts + brief searchFacts）改走 wrapper。**写入面=产品决策**（现状是全 event 喂；要不要选择性喂 copilot 对话/练习总结——P3 时 surface）。
- **P4 知识侧 bi-temporal**：`knowledge_edge` 补 valid_at/invalid_at（不破 unique/索引读路径）+ 写入期调和环挂 propose.ts，复用 P2 prompt 骨架 + log 设计 + 现成 getEffectiveTruth/CorrectionKind。

### 8.5 仍开放（不阻塞 P1/P2）

- P3 写入面信号选择（产品层，到 P3 surface）。
- kind 分类法最终枚举 + per-kind 半衰期（P2 起一个起步枚举 preference/habit/weakness/event，真实数据校准）。
- reconciliation_log 与 P4 知识侧写入期调和环是否共表（user_id 列对知识侧无意义）。

### 8.6 实施期发现：disableHistory:false 的原生模块代价（2026-06-14，P1 实施中浮现）

§8.3 锁 `disableHistory:false` 时把它当免费 flag，实施中发现并非如此，owner 复核后仍坚持 false：

- **唯一收益 = 抽取 prompt 的 "Last k Messages" 非空**。源码实证：`getLastMessages` **只** `SQLiteManager` 有；`MemoryHistoryManager`（`historyStore.provider:'memory'`）与 `DummyHistoryManager`（disableHistory:true）**都缺该方法** → 调用点 `typeof db.getLastMessages==='function'` 守卫 false → Last-k 恒空。故「Last-k 非空」的唯一路径 = `disableHistory:false` + 默认 `sqlite` provider = **必须 `better-sqlite3` 原生模块**。`memory` provider 是陷阱（零原生但 Last-k 仍空，等同 dummy）。
- **better-sqlite3 是 mem0ai 的 peerDependency（`^12.6.2`），不随 prod 安装**；旧 `disableHistory:true` 走 DummyHistoryManager 从不加载它。换 false = 新引入原生依赖。
- **P2 调和层不依赖 mem0 history**（读自建 Postgres `memory_reconciliation_log`，§3.5）。所以 disableHistory 取值只影响抽取质量，对 P2-P4 零影响——若日后想撤掉原生模块，回 `true` 不破调和层。
- **owner 决策（2026-06-14）**：坚持 `disableHistory:false`，接受原生模块进 prod 镜像 + 每次 Node 升级的脆性。

落地 plumbing（全在 P1 PR）：
- 顶层 `dependencies` 加 `better-sqlite3 ^12.6.2`；esbuild `build:server` + `build:worker` 均加 `--external:better-sqlite3`（原生 .node 不能 bundle）。
- Dockerfile 加 `sqlitedeps` flat-install stage + runner overlay COPY `better-sqlite3` / `bindings` / `file-uri-to-path`（镜像 sharp/sdk 模式；node:24 prebuild 无需构建链）。
- **拓扑（错开避跨容器 SQLite 写锁竞争）**：worker（唯一写者，所有 add()）→ 持久命名卷 `mem0data:/var/lib/mem0/history.db`；app（仅 search，history 永不被读但构造期仍开库）→ 容器内 `/tmp/mem0/history.db`（无卷、ephemeral）。两者 compose `environment` 强制 `MEM0_TELEMETRY=false`（§3.1）。
- dev：`.env.example` 设 `MEM0_HISTORY_DB_PATH=./.mem0/history.db`（repo 相对、gitignore；host user 不可写 `/var/lib`）。
- **本机 Node 26（ABI 147）无 better-sqlite3 prebuild → 源码编译**（mac Xcode CLT 即可）；Docker node:24（ABI 137）走 prebuild-install。
- **联调凭据（2026-06-14 owner 提供后解决）**：
  - 百炼：owner 的是**阿里云 workspace key**（`sk-ws-…`）+ workspace 专用端点 `https://ws-tcvd1h9009b55vr0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`（非通用 `dashscope.aliyuncs.com`）→ `.env` 设 `DASHSCOPE_API_KEY` + `MEM0_EMBEDDING_BASE_URL`（workspace 端点）。代码 default 端点维持通用 dashscope（主账号 key 用），workspace key 经 env 覆盖。实测 `text-embedding-v4` + `dimensions:1024` → HTTP 200 返 1024 维。
  - GLM：之前 glm-5.2 的 403 **是端点问题不是 key 问题**——同一把 `ZHIPU_API_KEY` 打 coding 端点 `…/api/coding/paas/v4`，glm-5.2/glm-5/glm-4.6 全 HTTP 200。故 GLM-OCR 与 mem0 LLM **共用同一把 key**，无需第二把；default 端点改 coding 版（见 §8.3 表）。
