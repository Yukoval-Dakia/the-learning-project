# 采集重想 + 检索底座设计

> **Status**: Design（owner brainstorm 2026-06-16）。代码 grounded by 两个测绘 workflow：检索 substrate 现状（wf276e5ek）+ 引擎拓扑（wf_c2248550）。8 个决策给了推荐默认值，owner 可在本 spec 内 override。
> **下一步**: owner review 本 spec → writing-plans 拆实施。
> **关联**: YUK-361（选题/校准/供给主线）、YUK-372（wire-up，L5 供给 cron 已 hold 待本 spec 重定义）、ADR-0042（选题档2）、ADR-0043（校准）、ADR-0038（verify）、ADR-0002（image-candidate accept 闸）、ADR-0018（变式生命周期）。

---

## 0. 一句话

把题目采集从「派单-等货」换成「持续囤料 + 检索匹配」，为此建一层**语义检索底座**；这层底座一次建成，**采集侧（matcher）和选题侧（三个 dormant 信号 / 错因复发 / KC 自动标注 / 变式家族）同时受益**，需求引擎从「派单工」升级成「掌舵者」。

---

## 1. 问题与框架

**供给瓶颈**：需求引擎（4 类 gap × 优先级）已经挺利，但供给侧跟不上，尤其采集。owner 拍板：四个痛点都痛——真题获取难 / 生成不可信 / 需求太精准两边都匹配不上 / 自有材料灌不进去。这说明问题不在某条路由，而在**整个供给架构相对需求引擎欠建**。

**框架级误判**：现引擎用 **request-then-fulfill**（派一个 target = KC×难度×题型×档 → 等一道匹配题回来）。这框对生成成立、对采集**根本不成立**——你没法按需从世界上「调」出一道 b≈0.3 的真题。

**新框：harvest-then-match**——采集变成持续后台 forage（不绑具体 target，把 authentic 料源源不断解析进 raw 池）；引擎改成「逛池子」（match 时才 KC-tag + 估难度），match 不到的残余缺口才丢给生成。采集与需求解耦，但**引擎通过「掌舵」而非「派单」继续影响采集**（见 §3）。

---

## 2. 两套引擎 + owner 担心的裁定

**两套引擎 = 选题引擎（consumes-pool）⟷ 供给/目标引擎（drives-acquisition）**。代码里互为镜像零耦合：选题侧 `collectComposerInputs` 只 SELECT、无一句 `boss.send`；供给侧 `dispatcher` 专做派单、从不选题。

**裁定 owner 担心（"A 让引擎不再影响采集"）= 误解**：
- 今天**根本没有常驻需求引擎在驱动采集**——`question-supply` 供给引擎 **DORMANT**（全仓只有测试调它，无 cron/job/route 点火）。今天采集是被动碎片化的：等 copilot 点播、等出卷流程、等录入。
- A **不切断引擎，反而第一次点亮它**：把引擎从「缺题才喊一嗓子的派单工」升级成「持续校准 forager 该爬什么、matcher 该提什么、什么才轮到生成」的掌舵者。

---

## 3. 目标架构：harvest-then-match 循环

```
        需求引擎(脑) ── steer 优先级 ──┐
              │                       ↓
              │              [源注册表]→ forager (后台持续囤 authentic 料)
              │                       ↓
              │                   raw 原料池
              │                       ↓
              └── drive ──→ matcher ──┤  ← 检索底座在这里承重
                          (扫缺口 → 检索池中料 → KC-tag + 估难度 + kind 分类)
                                      ↓
                        命中→promote        残余(池中无料)→生成(B)
                                  ↓               ↓
                              verify 闸(B5) ───────┘
                                      ↓
                                 active 题池
                                      ↓
                         选题引擎/调度引擎 (consumes-pool, 零改动)
```

**需求引擎 3 个注入点（比今天离散派单更连续）**：
1. **Seam ① forager 优先级**：gap 扫描结果（R1-R4 + priority 降序）→ forager 爬取队列优先级 + 约束（哪个 KC / minSourceTier / 需要的 kind）。forager 不无脑爬全网，被缺口图 steer 着定向囤料。
2. **Seam ② matcher 驱动**：引擎告诉 matcher「当前最缺这些缺口」，matcher 优先扫 raw 池里能填的料，match 时做 KC-tag + 估难度 + kind 分类。
3. **Seam ③ 残余路由生成**：matcher 兜不住的（池中确无料）→ 按 gap kind 路由到 quiz_gen，复用今天 `chooseAutoRoute`，只是它现在是**最后手段**而非首选。
4. **兜底闸 verify(B5)**：promote（来自池）或生成（来自残余）统一过 verify-then-promote 才进 active 池。

**逐 gap kind 验证引擎仍掌舵**（来自 `scanCoverageGaps` R1-R4）：

| gapKind | A 下引擎怎么掌舵 |
|---|---|
| **R1 frontier_zero** | 抬高该 KC 在 forager 的爬取优先级 → matcher 优先 promote 命中该 KC 的料 → 池空才生成 |
| **R2 source_quality** | 给 forager 设 `minSourceTier` 定向囤高档源 → matcher 优先 promote 高 tier 命中题 → 残余才生成 |
| **R3 diagnostic**（近-θ̂ 客观锚）| 引擎读 mastery θ̂ + effectiveB → forager 优先囤难度落 near-θ̂ band 客观题 → matcher 按 b 锚带难度估计 promote → 池中无可靠锚才生成。**θ̂→采集 链从「未跑过」变成连续跑** |
| **R4 format_diversity** | forager 定向囤 application/transfer 题型 → matcher 按 kind 优先 promote 缺的题型 → 残余生成 |

**选题侧零改动**：选题引擎 + 调度引擎站在 active 池下游，继续 `collectComposerInputs` 从 active 行 MFI 打分抽样。A 只往池里更连续、更对准缺口地补料，**选题 API 不变**——需求侧重写不波及消费侧契约。

### 3.1 引擎仲裁：harvest 默认 / request-then-fulfill 生成回退

harvest-then-match **不取代** request-then-fulfill——引擎对每个 gap **逐个仲裁两种模式**，同一张 gap map 既转向 harvest、又对填不上的缺口下生成订单。两模式配两条通道：

- **采集（authentic 真题）= harvest-then-match**（真题是低精度通道，没法按需「调」出一道 b≈0.3）。引擎对它是**方向盘不是下单**——即 §3 的三 seam：① 优先级转向（gap priority → forager 抓取优先队列）② 约束注入（minSourceTier / near-θ̂ band / kind → forager 的 query/filter 参数）③ 反馈闭环（填了的 gap 掉出地图、没填的升级重扫）。forager **偏置**往缺口爬但不保证拿到精确项；精确选择由 matcher 从落进来的料里做。
- **生成（quiz_gen / item-model 变式）= request-then-fulfill**（precise channel，「要什么给什么」）。这正是 Seam ③「残余 gap → 路由生成」的本质——**request-then-fulfill 没死，是兜底 / 即时通道**。

**仲裁逻辑**：每个 gap 先问「池里有料能 match 吗」→ 有 = harvest 模式 promote；**no-match ≠ 立即生成**——默认仍**等 harvest 补**（harvest-default）。**只有 `no-match ∧ 命中下列回退条件之一` 才回 request-then-fulfill 生成**（合取，否则缺口留在地图上等下轮 harvest——避免空池/nightly scan 把所有未命中 gap 立刻下发 quiz_gen、让生成兜底变成默认通道）：

| 回退触发（须 `no-match ∧ 此条`）| 为什么回 request-then-fulfill |
|---|---|
| 空池 + 精确 diagnostic gap（R3）| 需精确难度近-θ̂ 题校准，harvest 拿不到精确项 → 生成。**前提**：dispatch 须把 `difficultyBand`/θ̂ 透传给 quiz_gen（现仅传 knowledge_id/count/kind/generation_method，**不带难度** → 生成题难度随机、命不中 θ̂）。此透传是 quiz_gen 缺口 #1 / kind 重塑（A1）的前置——**未补前 diagnostic 回退不可靠** |
| 即时/同步需求 | 用户正练、等不了夜 harvest → on-demand 生成（copilot D14 用户面本就是 live request-then-fulfill）|
| 网上无此料 | 小众/个人化 KC，authentic 源不存在 → 生成是唯一源 |
| 持久缺口 | harvest 连续 N 轮填不上同一 gap → 升级到生成 |

**例外：R2 `source_quality` 不回生成**。该缺口要补**更高获取档**（`minSourceTier=2`），而 quiz_gen / material-grounded 落的是 generation/material 档、满足不了 R2 → 回生成只会新增仍不达档的低档题、缺口反复触发。**R2 只走 harvest / sourcing / manual**，不回生成兜底。

**策略一句话**：**默认偏好 authentic（gap 不急就等 harvest），`no-match ∧（急/持久/无源）` 才回 request-then-fulfill 生成**（R2 除外）。两条通道**都过 verify 闸（B5）才进 active 池**——生成合成料 verify-then-promote；**harvested authentic 同样过 verify（`source_verify`：抽取非空 / answer 一致 / KC-tag 校验）**，「轻量」指档位降权 + 去重，**不是跳过 verify**（无人值守 forage 的爬取/OCR 料仍可能有抽取、答案、KC-tag 错）。

---

## 4. 检索底座（统一层）

### 4.1 Thesis：一块底座，两侧受益

A 让 **matcher 成承重墙，而 matcher = 检索**。这块检索底座是整图的连接组织——驱动采集侧 match，**同时**解锁选题侧七个消费者（采集 matcher / misconceptionRecurrence / transferGap / examRelevance / 错因→题检索 / KC 自动标注 / 变式家族）。它们今天全卡在同三件缺失上：① 域内容零语义向量 ② 软维（错因/掌握/考纲）没物化成可索引列 ③ 没有统一 pool-fetch + 复合过滤 + 排名算子。

### 4.2 索引维度清单 + 现状

| 维度 | 现状 | 说明 |
|---|---|---|
| 语义 embedding（域实体内容向量）| ❌ MISSING | pgvector 扩展早启用（drizzle 0015），但题/KC/笔记/错题**零向量**；仅 mem0 facts 有向量（用户事实层，不能按内容匹配题）|
| KC containment（item↔KC 反查）| ◑ PARTIAL | jsonb `@>` 遍布 10+ 模块；只有 artifact/event 有 GIN，question/item/record 是 seq-scan |
| KC↔KC 图（prereq/related 邻域）| ✅ BUILT | `knowledge_edge` typed mesh + B-tree 索引 + weight，可两向遍历 |
| 错因家族（cause_category × KC 复发计数）| ❌ MISSING | 错因活在 event(judge/user_cause).payload jsonb + caused_by 链，无 cause 列可索引、无跨题聚合 |
| 难度锚 effectiveB | ✅ BUILT（最成熟）| `item_calibration` track='hard' 真读 + 纯函数解析（b_calib 攒够 label 前 NULL，NO-OP）|
| 难度带 near/below/above/stretch | ◑ PARTIAL | `difficultyBandFor(effectiveB, θ̂)` 相对 KC 的 θ̂ 内存归类，θ̂ 漂移不可预物化 |
| 题型 kind | ✅ BUILT | `question.kind` 真 SQL 列，可 eq/IN |
| 获取档 source_tier | ◑ DERIVED | `deriveSourceTier` read-time 派生，非物化列，无法 SQL WHERE/ORDER |
| 考纲权重 examRelevance | ❌ MISSING | SubjectProfile 无 examWeight/syllabus，需从零建数据源 |
| per-(KC,kind) 掌握度（transferGap 锚）| ❌ MISSING | `mastery_state` 唯一键单 KC 粒度无 kind 维 |
| 词法相似（CJK n-gram Jaccard）| ✅ BUILT | `maxNgramOverlap/shingles/jaccard` 已导出，但 0.7 阈值漏释义级近重 |
| tagging confidence（item→KC 强弱）| ❌ MISSING | `TaggingSuggestion.confidence` 只用于 judge 路由，最终只存 string[] |

### 4.3 ★ 语义检索设计（owner 直接问的）

**当前零域语义向量是底座的最大缺口。** 设计如下：

**(a) 嵌入什么**
- **第一批**：`question`（`prompt_md` + `reference_md` + `choices_md` 规范化拼接）、`knowledge`（KC 文本——**注**：`knowledge` 表当前只有 `name`/`domain`，**无 description 列**；KC 向量先用 `name` + `domain` + 关联 note 摘要的确定拼接，或新增 `description`/`summary` 列后用之，二选一见 §11）、**raw 原料池 candidate**（题面候选）。
- **第二批（按需）**：`note` 块、错因描述（cause_category 的人话定义，用于「作答错→错因家族」语义匹配的补充层）。
- **不嵌入**：mem0 facts（已有，是用户事实，不动）。

**(b) 模型**
- 复用 **百炼 `text-embedding-v4`（1024 维）** via 已有的 openai-compat embedder seam（`DASHSCOPE_API_KEY`）——与 mem0 同 embedder，但**落进 Drizzle 管理的 entity-keyed 列，不进 mem0 黑盒 collection**（决策 1）。
- 中文学习内容 multilingual 适配；**注意区分**：claude-context 的 `voyage-code-3` 是**代码检索**，不用于域内容。
- 每行存 `embed_model_id` + `embed_version`，为换模型/re-embed 留 discipline（见 (e)）。

**(c) 存储 schema**
- 域实体加 `embedding vector(1024)` 列（pgvector，Drizzle migration 管理，dims-must-match 不变量已文档化强制）。
- entity-keyed（按 question.id / knowledge.id / raw_pool.id），可 join 回业务行——这是相对 mem0 黑盒 collection 的关键优势：能和标量维（KC/kind/tier/effectiveB）在**同一查询**里复合过滤。
- ANN 索引：**n=1 规模（实体 tens-not-millions）下 HNSW 是 overkill**，可先用精确 cosine（`<=>`）顺序扫；量级真上来再加 HNSW/IVFFlat。诚实标：先精确、后索引。

**(d) embed-on-write pipeline**
- question / KC / raw-pool 行**写入或内容变更**时，enqueue 一个 embed job（pg-boss）计算 + 回填向量。域 ingestion 当前**无 embed step**——这是新增的横切环节。
- 内容变更触发 re-embed（不是 MERGE 不 re-embed——见 mem0 反模式 §9）。
- **一次性 backfill（关键）**：上线时对**存量** question/KC 跑一轮 embed——旧行不会再触发「写入/变更」，否则长期 NULL 向量、下游 KC-tag/变式/dedup 落空（Codex review）。n=1 量小（~分钟级）。**NULL embedding 降级路径**：matcher 退化为纯标量过滤（不崩，只是该行无语义召回）。

**(e) 检索原语（matcher 核心，七消费者共享）**
混合检索 = **语义 ANN top-K** ∩/+ **标量硬过滤** → **复合 rerank**：
1. **标量硬过滤**（先收窄候选集，便宜）：KC containment（jsonb `@>` / GIN）、kind（eq/IN）、难度带（effectiveB vs θ̂ 内存归类）、source_tier。
2. **语义召回**（在收窄集内）：query 向量 `<=>` 候选向量，取 top-K 概念近邻。
3. **复合 rerank**：`score = w1·语义相似 + w2·gap 优先级 + w3·难度贴合 + w4·tier`（权重 tunable，初值保守 + 留实测注释）。
- 这就是统一 **pool-fetch / matcher 算子**——替掉今天 `knowledgeContainmentOr` 5 处逐字复制 + tier 内存后置排序 + 难度带逐候选单查（§4.4）。

**(f) 各消费者怎么用同一原语**
- **采集 matcher**：给定 gap（KC×band×kind×tier），原语检索 raw 池候选 → rerank → promote。
- **KC 自动标注**：raw item 向量 → ANN over KC 向量 → 候选 KC 集喂 tagger（替「prompt 现挑 ≤200 节点 grid、超了静默丢」的规模化盲区；受控集 + 反幻觉过滤）。
- **变式家族**：question 向量 ANN → 找概念近邻 → 链接手工近重（补 root_question_id **FK 血缘**抓不到的相似家族）。
- **dedup**：语义相似补 n-gram Jaccard——抓 0.7 阈值漏的**释义级近重**（mem0 已有 semantic+BM25 hybrid 先例）。
- **⚠️ 区分**：`misconceptionRecurrence` **不是语义检索**——它是**物化标量聚合**（cause_category × KC 跨 attempt 复发计数 + 时间衰减 + 0-1 归一化），建在 event 聚合上，不走 embedding。语义只在「作答错文本→错因家族」匹配时做补充。

**(g) re-embed discipline（反 mem0 反模式）**
mem0 暴露过两个坑：MERGE 不 re-embed → 向量漂移；换 embedder model → 整 collection wipe-on-rebuild。底座必须：① 内容变更显式 re-embed ② 换模型走**后台批量 re-embed job**（按 embed_version 灰度），**不 wipe**。

### 4.4 统一 pool-fetch / matcher 算子

把 `question-supply` 的 `loadQuestionPool`（批量 `inArray` join calibration + JS effectiveB Map）**提升为全域统一算子**，替代现状逐候选 `resolveBAnchor` 单查 + `knowledgeContainmentOr` 5 处复制 + tier 内存后置排序。采集 matcher 和选题 candidate-signals 都调它（决策 3）。

### 4.5 向量库选型：pgvector（决定）vs Milvus/Zilliz（不用于域内容）

owner 已在 claude-context（代码检索，~13k chunks）用 **Zilliz Milvus**，故问域内容是否也走它。结论 **pgvector**，理由（context7 核 Milvus 2.6 + pgvector 官方 docs）：

1. **复合过滤的「权威列」之争（决定性）**：底座核心价值是「语义 × KC × kind × 难度带 × tier 复合过滤」，且这些标量维**权威源在 Postgres**。pgvector 在**一条 SQL** 里 `WHERE kc @> … AND kind IN … ORDER BY embedding <=> q`（HNSW + `iterative_scan` 保 LIMIT），直接 join 真实域列。Milvus filtered search 也支持标量过滤，但标量字段必须**存进 Milvus collection**——意味着把 KC/kind/tier/effectiveB **复制进 Milvus 并保持同步**（漂移风险，正是 §9 警告的 mem0 反模式），或**两跳**（Milvus 取近邻 → 回 Postgres join），失去单查复合过滤。
2. **规模**：n=1 = tens-to-低千 实体。Milvus 为 billion-scale 而生，严重 overkill；pgvector 精确/HNSW 绰绰有余。
3. **自托管**：pgvector 已在 NAS Postgres（drizzle 0015 启用），零新基建。Milvus standalone 重（etcd+minio+milvus 容器）；Zilliz Cloud = 数据出 NAS（违自托管 ethos）。
4. **运维**：少一套系统要跑/同步/备份；域向量与域行同库。

**Milvus/Zilliz 留在它擅长且已在用的地方**：claude-context 代码检索（大代码块语料、无需 join 域列）。**别把它扩到域内容**——会重新引入两跳/复制问题。逃生舱：真到大规模可上 `pgvectorscale`（StreamingDiskANN），n=1 用不着。

### 4.6 跨科错因 taxonomy（两层，决策 8 的「跨科路径」）

owner：per-subject 先行 + 讨论跨科意义与路径。

- **意义**：per-subject cause_category（古文「虚词误解」/ 数学「符号错误」）诊断「这个领域你哪错」。**跨科价值是 learner 级元认知信号**——有一类错因跨学科同构：审题不清 / 计算粗心 / 概念过度泛化 / 迁移失败 / 记号混淆。它们不是学科知识弱点，是**你的系统性习惯**。「你在所有科目都审题不清」是 per-subject 永远看不到的高阶洞见，喂个性化（mem0 关于「你」的长期事实）。
- **不需要统一各科 taxonomy**，只需各科 cause 各标一个 meta tag。
- **最终 taxonomy（owner 2026-06-16 拍板，文献 grounded；详见 `docs/design/2026-06-16-meta-cause-taxonomy-research.md` 含来源权威性表）**：4 学派（Reason/Rasmussen 人因 · Newman/Radatz 程序错误 · Chi/diSessa 概念变化 · Corbett BKT 心理测量）收敛到「错误出在哪个认知机制」。
  - **6 类机制主轴 `meta_cause`（互斥单选）**：`execution_slip`（执行失误，提示即自纠不复现 → 只提示不加难度）/ `knowledge_gap`（知识缺乏，首次即错跨情境一致不会 → 初教/FSRS 重排）/ `retrieval_failure`（已编码取不出，给提示就想起 → 无提示检索练习）/ `rule_misapplication`（规则对但用错情境/越界泛化/负迁移 → 条件辨识/反例）/ `flawed_model`（稳定可复现的错心智模型或 bug 规则，抗简单纠正 → **认知冲突题，最高出题价值**）/ `representation_failure`（调用领域知识前读题/转译就失败 → 练「据语境/题意转译」）。
  - **2 条正交标注轴（多标，不参与主分类）**：Axis A `metacog_flag`（元认知校准：blind_spot / false_fluency / regulation_gap / overconfident / poor_resolution / calibrated）；Axis B `bloom_level`（remember…create）。
  - **双层映射（关键）**：per-subject `cause_category` **不硬编死 meta**——一词多机制（古文「虚词误解」可落 representation / rule_misapp / flawed_model / knowledge_gap）。= 静态默认映射表（冷启先验）+ **实例级 `meta_cause` 字段**（AI judge 按「提示是否自纠 / 是否跨情境复现 / 信心是否脱节」判定，evidence-first 落 **event payload 的 `meta_cause` 字段 + correction 体系**可回滚——**不是** `ai/log.ts`，它只写 ai_task_runs/tool_call_log/cost_ledger，不持久化 judge 结构化判定，rejudge/纠错还原不了；Codex review）。
  - **violation 不进主类**：「故意跳步/不验算」是动机非能力 → 归 Axis A `regulation_gap`（Reason 2000 把 violation 与 error 正交），不误判成「不会」。
  - **落库字段**：`meta_cause`(主) / `meta_cause_secondary`(可空) / `metacog_flag` / `bloom_level`(可空) / `self_corrected_on_hint` / `recurred_cross_item`。
- **两层聚合**：层内 `cause_category × KC`（per-subject，先做，喂 FSRS）+ 跨科 `meta_cause × effective_domain 派生轴`（后做；按「科目是视角不是结构」meta_cause **不挂 subject 列**）。
- **跨科洞见呈现 = 独立未来 feature（owner 拍板）**：本 spec 只建 `meta_cause` **数据层**让数据尽早累积；「跨科系统性弱点」的**数据可视化**是 owner 计划中的独立 feature，scope 待定（owner「现在没想好」），不进本 spec。

---

## 5. 八个决策（owner 2026-06-16 拍板）

| # | 分叉 | 决定（2026-06-16） |
|---|---|---|
| 1 | 向量库/列归属 | **pgvector，Drizzle entity-keyed 列**（非 mem0 黑盒、非 Milvus/Zilliz；选型见 §4.5）|
| 2 | KC-tag/估难度 时机 | **入池时打标为主轴** + embedding 取候选 KC 替「≤200 grid 静默丢」+ confidence 落库；**无历史数据 → 不建批量重标 job** |
| 3 | matcher 形态 | `loadQuestionPool` **提升为全域统一批量 pool-fetch 算子** |
| 4 | 源 + 版权 | **不设白名单，给 forager guide（引导式）**；**无版权 gate**（自用 n=1）；raw 池免审、promote 过 verify |
| 5 | forage 节奏/护栏 | **事件驱动（frontier 变化）+ nightly 双触发**；**暂不设成本限**（warning 水位观测可留）|
| 6 | 引擎点火 | nightly cron + 事件驱动，**把 dormant 的 question-supply 重定义为 forager-steerer**（收尾 YUK-361 Phase 8 点火环）|
| 7 | 三 dormant 信号解锁序 | **misconception → transfer → exam** ✅ |
| 8 | 错因 taxonomy 跨科 | **per-subject 复发先行** + 跨科 **6 类机制 `meta_cause` 主轴 + Axis A 元认知 / Axis B Bloom 正交轴**（两层，§4.6，文献 grounded，2026-06-16 拍板）|

---

## 6. 复用 vs 新建

**现成可复用**：ingestion pipeline（`src/server/ingestion/` + `r2.ts` 原图存储）、OCR-first/VLM-fallback（原图同步存铁律）、verify 闸（quiz_verify/source_verify per-source handler）、sourcing+quiz_gen 队列（`boss/handlers/`）、gap 扫描（`question-supply/target-discovery.ts` scanCoverageGaps 4 类信号）、θ̂/effectiveB 锚（`src/server/mastery/` 在线 Elo）、KC 树+KG（`knowledge_edge` + `buildTaggingGrid`）、n-gram 去重、openai-compat embedder seam（百炼 v4，mem0 同款）、`loadQuestionPool` 批量 pool-fetch 基线。

**真新建**：
- raw 原料池 schema（候选半成品 + 状态机 raw→matched→promoted/discarded + fingerprint 去重）
- forager（后台持续囤料进程，受需求引擎 steer；填上 question-supply 缺的点火环，语义「派单」→「囤料」）
- matcher（缺口↔池中料检索 + KC-tag + 估难度 + promote 决策）
- 源注册表（forager 爬哪些源 + 各源 tier/版权/频率）
- **检索底座**：域实体语义 embedding 列 + embed-on-write pipeline + 软维物化（错因家族 / per-(KC,kind) 掌握 / 考纲）+ 统一 pool-fetch 算子 + question.knowledge_ids GIN + tagging confidence 落库

---

## 7. 消费者矩阵（底座解锁谁）

| 消费者 | 需要的索引 | 解锁条件 |
|---|---|---|
| 采集 matcher | KC + 难度带 + kind + tier 复合检索 + 语义 | 统一 pool-fetch + question.knowledge_ids GIN + tier/带可复合过滤；question-supply 接 cron |
| misconceptionRecurrence | 错因家族 (cause × KC) 跨 attempt 复发计数 | event 聚合物化视图（去重粒度 + 时间衰减 + 0-1 归一化）；prompt/bucket/test 已就绪，落 reader |
| transferGap | per-(KC,kind) 掌握度 | mastery_state 加 kind 维 / Task 10 family calibration + 多 KC 读口 |
| examRelevance | KC→考纲权重 | 先建数据源（SubjectProfile 加 examWeight/syllabus 或独立表）+ reader（三信号最重）|
| 错因→题检索 | cause × KC × dueWithin × since 复合 | cause 维物化列/视图 + 索引（API 形状不变）|
| KC 自动标注 | item→KC 语义匹配 | KC embedding + item embedding → ANN 候选 KC（替 ≤200 grid）|
| 变式家族 | 题间语义相似 | question embedding + ANN（补 root_question_id FK 血缘）|

---

## 8. 分阶段 rollout（建议）

- **Phase 0 — 检索底座地基**：pgvector 域 embedding 列（question/KC/raw-pool）+ embed-on-write job + **一次性 backfill 存量 question/KC embed**（旧行不再触发写入；n=1 量小）+ 统一 pool-fetch 算子 + knowledge_ids GIN。（无行为变更，纯地基）
- **Phase 1 — A 采集循环**：raw 池 schema + forager（点亮 question-supply 为 forager-steerer，**nightly + 事件驱动**）+ matcher + 源注册表（forager **guide**，**无版权 gate**——决策 4）。（YUK-372 L5 在此被正式取代）
- **Phase 2 — KC 自动标注升级**：embedding 候选 KC + confidence 落库（解 ≤200 grid 盲区）。
- **Phase 3 — 选题侧解锁**：三 dormant 信号按序（misconception → transfer → exam）+ 变式家族相似度 + 语义 dedup。
- **横切**：错因家族物化（Phase 1/3 之间，misconception 前置）；考纲数据源（exam 前置，最重）。

---

## 9. 风险

- **Embedding 成本/漂移**：embed-on-write 是经常性 API 成本（n=1 量小可控）；必须 entity-keyed 列 + 显式 re-embed（避 mem0 MERGE-不-reembed / wipe-on-rebuild 坑）。
- **KC-tag 准确率**：入池 AI tagger 错标污染所有下游 KC 检索，无 FK 约束清理悬挂 id；matcher 需对错/陈旧 KC 容错。
- **错因家族稀疏 + n=1**：复发频次样本极少，misconception 晋升 ≥k 门槛可能长期不触发；守 **NEVER zero-fill**（undefined=无数据≠0）。
- **错因 taxonomy 跨科不可比**：cause_category 是 per-subject 字符串 id，跨科聚合需先统一/可映射 taxonomy（故决策 8 = per-subject 先行）。
- **web sourcing 近重判定**：引入语义相似后近重判定边界变模糊（与 n-gram 阈值需协调）。（版权：决策 4 = 自用 n=1 无版权 gate，不作风险项）
- **dormant 引擎接线**：question-supply 接 cron 时需验真实数据规模行为（无 GIN 的 jsonb 全表解析）+ cooldown 防 spam 正确性。
- **Embedding API 可用性/延迟**：embed-on-write 在 ingestion 链路上——百炼 API 故障/延迟会堵题目入库。**fallback：API 不可用时题目照常入库、embedding 留 NULL 排队补**（不阻塞 ingestion）+ API SLA 监控（CodeRabbit review）。

---

## 10. 现状债 / 命名 drift（实施时顺手清）

- **`mistake` 表已 DROP**（Phase 1c.1 Step 9.J / ADR-0006 v2）：「错题」不是题，是 event 派生关系（action='attempt', outcome='failure'）。raw 池/matcher 因此**无需单独「错题」概念**。
- **`mistake_variant` 命名 stale**：它是变式**提案生命周期账本**（draft→active→broken + variants_max=3 配额），变式题本体在 question 表（root_question_id/parent_variant_id/variant_depth）。且变式早扩到 by-kind 应用/迁移（YUK-282），不只来自错因。可考虑 rename（如 `variant_proposal`），不阻塞。
- **错因未物化**：活在 event payload + caused_by 链，JS 端 post-filter 非 SQL 索引——misconceptionRecurrence/错因→题检索都卡这。
- **question-supply DORMANT**：无生产 caller，A 落地等于点亮它（重定义为 forager-steerer）。

---

## 11. Open questions / owner gates（实施前要拍的）

> **全部已于 2026-06-16 拍板**（见 §5 + §4.6），保留原问以备回溯：1=不设白名单给 guide、无版权 gate；2=事件驱动+nightly、暂不设限；3=misconception→transfer→exam；4=per-subject 先行 + **6 类 `meta_cause` 主轴 + Axis A 元认知 / Axis B Bloom 正交轴**（§4.6，文献 grounded）；5=无历史数据 → 不建批量重标 job。跨科洞见**呈现 = 独立未来 feature**（数据层本 spec 建，可视化 owner 另开，scope 待定）。**本 spec 决策面已全闭合 → 可转 writing-plans。**

1. **源注册表 + 版权红线**：源清单 owner 手工白名单 vs 按 subject profile 派生？哪些源只允许「引用片段」不允许「整题入库」？forage 的 authentic 料是 raw 阶段免审 / promote 时审，还是 ADR-0002 类 owner-accept 闸？
2. **forage 触发节奏/成本护栏**：nightly batch vs on-frontier-change 事件驱动？warning 水位 + 硬顶各设在哪？
3. **三信号解锁优先级**：按推荐 misconception→transfer→exam，还是 owner 产品优先级不同？
4. **错因 taxonomy 统一时机**：per-subject 复发先行（单科可用、跨科留白）vs 先攻跨科统一（解锁跨科但前置重）？关系 misconception 晋升环何时落地。
5. **KC-tag 升级范围**：只补「embedding 候选 + confidence」，还是同时建 match 时语义重标 job（KC 树大改后批量重标历史题，涉历史回填成本）？

---

## 12. 生成(B leg) 形态决策（2026-06-17 owner 拍板）

补 §3 残余-fill 生成器(B leg) 三条形态决策（quiz_gen 能力测绘 + `kind` 爆炸半径 workflow grounded）：

### 12.1 生成直出 structured（不走 ingestion 恢复管道）

quiz_gen 主链现只产**扁平纯文本题**，不产 structured 树 / 组合题 / 图。**决策：生成端直接 emit `StructuredQuestion` 树**（复用 author_question 已有的结构直出 + `StructureTask` 的 `StructureNode` shape）。**不**把生成文本喂进 ingestion 的 `block-assembly`/`StructureTask`——那是「从扫描页**图片恢复**结构」的 vision 管道（输入页图 + OCR 块 + bbox），与生成需求反向：会丢掉「生成器本就知道的结构意图」+ 多一道「所见≠入库」漂移面。共享层 = **StructuredQuestion schema + verify 契约**，不是抽取管道。verify 从「重抽结构」变「**校验结构树自洽**」。

### 12.2 题型 = 两轴正交（kind → answer-class 轻标签）

**决策详见 YUK-386**（kind 8 值闭集 → 结构轴通用树 + ~4 值 answer-class 验证标签 `exact/keyword/semantic/steps`；6 步砍法 YUK-387~392）。对生成的影响：Step 5 删生成端 `kindsMatch` pin + 闭集 prompt，生成按「结构 guide + answer-class」产出。**合流 A1**（客观 answer-class → typed attempt-payload）/ **A5**（verify rollout = answer-class 开闸序）。

### 12.3 图片三分（算 / 画 / 采）

- **数学/公式/几何/电路/坐标 → 确定性渲染**（from spec：matplotlib / TikZ / mathjs——生成器吐图 spec，渲染器出图）。正确性可证、可复现、便宜；与已有 mathjs 数值 verifier 同源。
- **插画/场景/无事实负担装饰 → gpt-image 类生成**，配 ADR-0002 user-accept 闸，默认装饰用。
- **事实性图示（地图 / 标注生物 / 数据图表 / 作为考点的电路）→ 两条生成路都危险，优先采集真图**（接 YUK-227 + harvest A leg）。生成图把「所见≠入库」升到视觉层，难自动 verify。
- 口诀：**能算就别画、能画(确定)就别生成、能采(真图)就别赌生成。**
