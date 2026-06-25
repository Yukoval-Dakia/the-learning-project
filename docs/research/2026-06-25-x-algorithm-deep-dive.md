# X (Twitter) 2026 新一代开源推荐算法深潜报告

> **类型**：外部代码调研（research，非本项目设计/实现文档）
> **日期**：2026-06-25
> **调研对象**：`github.com/xai-org/x-algorithm` @ commit `0bfc279`（2026-05-15）
> **方法**：clone 源码（跳过 LFS 权重）→ 17-agent 工作流（12 组件 reader 逐文件实读 + 4 对抗 verifier 核验关键主张 + 1 综合）→ 全部结论 file:line grounded，verifier 修正过的主张采用修正版。
> **为何收录**：§10 给出"X 架构纪律 → 本项目 KG 学习/复习推荐引擎"的可迁移映射（候选隔离可缓存打分 / 双塔召回 / 多动作显式价值函数 / 内容理解独立层），并论证"消除手工特征"哲学为何**不**迁移到 n=1 冷启动产品。

**对象**：`xai-org/x-algorithm` @ commit `0bfc279`（"Open-source X Recommendation Algorithm"，2026-05-15）—— 基于 Grok 的 Rust + Python 重写版。
**证据基础**：12 个组件读者 + 4 个对抗核验者实读克隆代码（home-mixer 139 个 Rust 文件约 11.7k LOC、phoenix 9 个 Python、grox 59 个 Python 等）。所有 file:line 引用与逐字代码/数字均来自实读，verifier 修正过的结论一律采用修正版并标注 nuance。

---

## 1. 执行摘要

### 这是什么系统

X 的 For You 推荐栈，由三大块组成：

- **home-mixer**（Rust）——编排层。用一个可组合的 `candidate-pipeline` 框架（六类 trait：Source / Hydrator / Filter / Scorer / Selector / SideEffect）把整条 feed 拼起来，对外暴露两个 gRPC 服务（`ScoredPostsService` 出纯有机贴流，`ForYouFeedService` 出混入广告/关注推荐/prompt 的成品 feed）。
- **phoenix**（Python，JAX + dm-haiku，**不是 PyTorch、不是 Rust**）——模型层。两塔召回（双塔点积 top-K）+ Grok-1 移植的 transformer 排序器（19 路多标签 engagement head + 8 路连续 head），核心创新是**候选隔离注意力掩码**。
- **grox**（Python，asyncio 多进程）——内容理解层。9 条并行 plan 的 task-DAG 执行引擎，做 banger 质量分、spam、PTOS 安全策略、多模态 embedding、回复排序。**这是 2026 版相对旧版的全新增量**。
- **thunder**（Rust）——内存内网帖存储。Kafka 摄取 + per-user `DashMap` 时间线，给关注内容做亚毫秒查询（实际只做 recency 排序，无 ML）。

### 一段话讲清"For You 怎么搭出来"

收到请求 → home-mixer 先并行 hydrate 用户上下文（关注/拉黑/静音名单、user action sequence、Grok 主题、bloom filter、geo-IP 等十几路）→ 并行从 6 个源拉候选（Thunder 内网 + TweetMixer + Phoenix 召回主/topic/MoE 三簇 + Redis 缓存）→ 并行 hydrate 每条候选（正文/作者/视频时长/品牌安全/语言/互关 Jaccard…）→ 顺序过约 18 个规则 filter（去重/年龄/自帖/拉黑静音/已看已发/关键词…）→ 顺序跑三个 scorer（**PhoenixScorer** 调远程 transformer 拿每动作概率 → **RankingScorer** 算加权和 + 作者多样性衰减 + OON 降权 → **VMRanker** 远程价值模型可选 DPP 多样化）→ TopK 选择 → post-selection hydrate/filter（可见性过滤 VF）→ 截断 → ForYou 层混入广告/关注推荐/prompt → 序列化下发。打分后 fire-and-forget 触发一堆 side effect（写 Redis 缓存、发 Kafka 训练样本、记 served history）。

### 3-4 个最大的设计赌注

1. **用单个 Grok transformer 吃 engagement 序列、吐多动作概率，取代手工相关性特征**。README 宣称"消除了每一个手工特征和大部分启发式"。核验结论：**相关性信号层这话成立，整系统层这话被夸大**（详见 §7）。
2. **候选隔离不变量**（candidate isolation）：transformer 推理时候选之间不能互相 attend，只能 attend 到 {user, history, 自己}，从而每条帖的分数与同 batch 里有哪些其它帖无关 → 分数可缓存。**核验确认机制真实、有单测、正确**，但有 nuance（详见 §7）。
3. **双塔召回 + 多簇实验编排**：用户塔（重，跑完整 transformer）× 候选塔（轻，2 层 SiLU MLP）做 L2-归一化点积召回；生产侧并行跑 Fou/Lap7 两个实验簇 + 冷启动专用簇 + MoE 簇。
4. **打分是显式的"多动作加权和价值函数"**：21-22 个动作（含 not_interested/block/mute/report 等负反馈，带负权重）线性加权，外加 offset 重标定、作者多样性几何衰减、OON 乘子。**但所有数值权重不在开源里**（详见 §5、§7）。

---

## 2. 与 2023 旧版（twitter/the-algorithm）的代际差异

README 没有显式"差异"章节，但代码层面差异是具体的：

| 维度 | 2023 旧版（Scala 单体） | 2026 新版（本仓库） |
|---|---|---|
| 语言/进程 | Scala 单体 | Rust（home-mixer + thunder + candidate-pipeline）+ Python（phoenix + grox），多服务 |
| 排序模型 | light ranker / heavy ranker + 数百手工特征 | 单个 Grok-1 移植 transformer，吃 engagement 序列吐 19 路动作概率 |
| 相关性特征 | 大量手工特征工程 | 相关性信号层取消手工特征（模型吃序列）；但工程化的 tweet 级特征（fav/reply/repost/quote count、has_media、语言、is_retweet/quote/reply）仍由专用 hydrator 计算并按 `EnableContextFeatures` 开关送进模型（`models/candidate.rs:117-152` `as_tweet_info()`，`engagement_counts_hydrator.rs:45-48`） |
| 召回 | 多路重型召回 | 双塔神经召回（Phoenix）+ 内网 Thunder + TweetMixer + MoE 簇 |
| 内容理解 | 分散 | 独立 grox 服务（2026 新增），9 条并行 plan，VLM 做 banger/spam/PTOS/多模态 embed |
| 广告 | 外部 | `home-mixer/ads/`（2026 新增），两种 blender + 品牌安全规则引擎 |
| 推理脚本 | — | `phoenix/run_pipeline.py` 单一入口取代旧的 `run_ranker.py` + `run_retrieval.py`（README:30-31） |
| 缓存一致性 | 非显式 | 候选隔离注意力掩码使分数 batch-order-independent、可缓存（明确的架构选择） |
| Thrift 残留 | 全 Thrift | Strato 字段 ID 仍是负数（Scrooge 编码 Thrift 遗留：`UserFeatures` 字段 `-28831`/`-7422`/`-8003` 等）；thunder 做 Thrift→Protobuf 迁移桥 |

新版相对旧版的"代际感"主要在三点：**(a)** 排序从特征工程转向序列 transformer；**(b)** 内容理解独立成一个 VLM 驱动的 grox 服务；**(c)** 候选隔离不变量把可缓存性写进了模型架构本身。

---

## 3. 端到端请求生命周期

以 `ForYouCandidatePipeline`（`candidate_pipeline/for_you_candidate_pipeline.rs:141-203`）为顶层、内部经 `ScoredPostsSource` 调 `PhoenixCandidatePipeline`（`phoenix_candidate_pipeline.rs:185-350`）。框架执行模型见 `candidate_pipeline.rs:88-137` 的 `execute`。

**整体两层结构**：

- **Layer 1 = PhoenixCandidatePipeline**：产出已打分的 `PostCandidate`。
- **Layer 2 = ForYouCandidatePipeline**：包 Layer 1（经 `ScoredPostsSource`），再追加广告/WTF/prompt/push-to-home，全部 hydrator/filter/scorer 都为空（`for_you_candidate_pipeline.rs:247-257`），ForYou 层纯做组装与混排。

### 有序流水线（Layer 1 内部，每阶段并行/顺序见标注）

```
ScoredPostsQuery
  │
  ▼ [Query Hydration] —— 15 路并行 join_all（phoenix_candidate_pipeline.rs:185-232）
  │  ScoringSequence / RetrievalSequence / Blocked/Muted/Followed/Subscribed UserIds /
  │  CachedPosts / MutualFollow / UserDemographics / FollowedGrokTopics / FollowedStarterPacks /
  │  InferredGrokTopics / ImpressionBloomFilter / Ip / UserInferredGender
  │  （ImpressedPostsQueryHydrator 构造了但用 `let _` 丢弃，从未注册 —— 死代码）
  │
  ▼ [Sourcing] —— 6 源并行 join_all（:250-257），Err 静默丢弃（flatten）
  │  Thunder（内网）/ TweetMixer（OON，含内联 age 过滤）/ Phoenix（OON 主簇 Fou/Lap7）/
  │  PhoenixTopics（topic 簇）/ PhoenixMOE（MoE 簇，gated）/ CachedPosts（缓存命中则禁用其它全部源）
  │
  ▼ [Candidate Hydration] —— 10 hydrator 并行（:259-272）
  │  InNetwork / CoreData(TES) / Quote / VideoDuration / HasMedia / Subscription /
  │  Gizmoduck(作者) / BlockedBy / FilteredTopics / LanguageCode
  │
  ├──── clone → retrieved_candidates（PipelineResult，candidate_pipeline.rs:98 的全量 clone）
  │
  ▼ [Pre-Scoring Filters] —— 14 filter 顺序（:274-289）
  │  DropDuplicates / CoreDataHydration / Age / SelfTweet / RetweetDedup /
  │  IneligibleSubscription / PreviouslySeenPosts / PreviouslySeenPostsBackup /
  │  PreviouslyServedPosts / MutedKeyword / AuthorSocialgraph / Video / TopicIds / NewUserTopicIds
  │
  ▼ [Scoring] —— 3 scorer 顺序（:291-300）
  │  PhoenixScorer（gRPC 调 transformer，attach 原始 phoenix_scores）→
  │  RankingScorer（加权和 + offset + 作者多样性 + OON，纯 CPU）→
  │  VMRanker（远程价值模型，可选 DPP，gated EnableVMRanker）
  │
  ▼ [Selection] —— TopKScoreSelector（:302），按 score 降序取 TOP_K_CANDIDATES_TO_SELECT
  │
  ▼ [Post-Selection Hydration] —— 6 hydrator 并行（:304-315）
  │  VFCandidate（可见性）/ AdsBrandSafety / AdsBrandSafetyVf / TweetTypeMetrics /
  │  FollowingRepliedUsers / MutualFollowJaccard
  │
  ▼ [Post-Selection Filters] —— 3 filter 顺序（:317-321）
  │  VFFilter / AncillaryVFFilter / DedupConversation
  │
  ▼ [result_size 截断] → finalize() 钩子
  │
  ▼ [Side Effects] —— tokio::spawn fire-and-forget（:323-338）
     PhoenixExperiments / RerankingKafka(5%采样) / RedisPostCandidateCache /
     ScoredStats / MutualFollowStats / PhoenixRequestCache
```

随后 **Layer 2** 把这批 `FeedItem::Post` 与广告/WTF/prompt/push-to-home 经 `BlenderSelector` 混排（详见 §4、§8），再下发。

**test-user 硬旁路**：`params::TEST_USER_IDS` 里的用户在 `ScoredPostsServer`（`scored_posts_server.rs:45-49`）和 `ForYouFeedServer`（`for_you_server.rs:32-34`）都直接返回空，绕过整条流水线。**Gizmoduck 强制内网**：若 `allow_for_you_recommendations == Some(false)`，`in_network_only` 被强制为 `true`（`server.rs:75-76`）。

---

## 4. 组件深潜

### 4.1 home-mixer（编排）

两个 gRPC 服务由 `HomeMixerServer::register` 注册（`server.rs:397-420`），均启用 gzip+zstd 压缩、mTLS（`main.rs:55`）、dark-traffic 拒绝层（`main.rs:58-59`）：

- **`ScoredPostsService`**（`scored_posts_server.rs`）：`get_scored_posts`（生产）+ `get_debug_scored_posts`（debug，强制 B3 trace，返回 `debug_json` 含 retrieved/filtered/selected 计数）。出纯 `PostCandidate`，无广告/WTF/prompt。
- **`ForYouFeedService`**（`for_you_server.rs`）：`get_for_you_feed`（返回混合 `FeedItem`）+ `get_for_you_feed_urt`（解 URT cursor，序列化成 Thrift 二进制）。`ForYouFeedServer` 包 `ScoredPostsServer`，两者共享同一个 `PhoenixCandidatePipeline` 实例，内部直接函数调用而非走 gRPC。

**关键 timeout / 容错**：Gizmoduck viewer data 拉取硬 200ms（`VIEWER_ROLES_TIMEOUT_MS = 200`，`server.rs:33`），失败静默用默认 `ViewerData`。`PhoenixRequestCacheSideEffect` 容忍 <10% Redis 写失败（`phoenix_request_cache_side_effect.rs:126`）。

**广告混排策略**（`ads/mod.rs`，2026 新增）。`AdsBlender` trait 两实现，由 `AdsBlenderType` 参数选（`"safe_gap"` → `SafeGapAdsBlender`，否则 fallthrough → `PartitionOrganicAdsBlender`）：

- 公共常量（`ads/util.rs:10-17`）：`MIN_POSTS_FOR_ADS = 5`、`MIN_REQUESTED_GAP = 3`、`DEFAULT_SPACING { requested: 3, min: 2 }`。
- **品牌安全分级**（`models/brand_safety.rs`）：`MediumRisk` 触发条件——有任一 medium-risk 标签，**或**从未被 Grok 评分过（缺 `GROK_SFA`/`GROK_NSFA_LIMITED`），**或** tweet ID ≥ `PTOS_CUTOFF_TWEET_ID = 2_054_275_414_225_846_272` 且缺 `PTOS_REVIEWED` 标签。`has_avoid` 只在 `MediumRisk` 触发（`util.rs:25-27`）。**默认 verdict 是 `MediumRisk`**（`scored_posts_server.rs:102`）——hydrate 失败的帖保守按"广告不宜邻接"处理。
- `SafeGapAdsBlender`：找"安全间隙"（前后帖都非 MediumRisk），按 spacing 把广告塞进最接近理想位的间隙，尾广告会被移除、位置重编号。
- `PartitionOrganicAdsBlender`：`max_from_safe = safe_count / 2`，三条广告邻接 drop 规则（`should_drop_bsr_low` / `should_drop_handle` 作者黑名单 / `should_drop_keyword` 文本关键词匹配）。
- `BlenderSelector`（`selectors/blender_selector.rs`）硬编码位置：prompt 在 `PROMPTS_POSITION`（前），WTF 在 `WHO_TO_FOLLOW_POSITION - 1`，**push-to-home 钉死 index 0**（`:103-114`）。

**Side effect 全表**（fire-and-forget，结果丢弃）。值得注意：`ServedCandidatesKafkaSideEffect` 只在 `is_shadow_traffic` 触发（非真实流量）；`RerankingKafkaSideEffect` 是 `random::<f64>() < 0.05` 随机 5% 采样（非 per-user 确定性）；`PhoenixRequestCacheSideEffect` 跨 DC 双写 atla+pdxa 两个 Redis 簇；`CacheRequestInfoSideEffect` 存在于文件树但**未接入任何 pipeline——死代码**。

### 4.2 candidate-pipeline（框架 trait）

九个扁平模块（`lib.rs:1-9`），编排逻辑全在 `candidate_pipeline.rs`。

**两个基础约束**：
- `PipelineQuery`（`candidate_pipeline.rs:59-62`）：必须暴露 `xai_feature_switches::Params` + 可选 `xai_decider::Decider`（均为第一方 infra 类型，**未开源**）。
- `PipelineCandidate`（`:64-65`）：blanket impl，任何 `Clone + Send + Sync + 'static` 自动满足，无方法要求。

**六类 stage trait**（外加 `CandidatePipeline` 编排 trait）的执行语义：

| Stage | 执行 | 错误处理 |
|---|---|---|
| QueryHydrator | 并行 join_all，serial merge | 错误静默丢弃 |
| Source | 并行 join_all | Err 经 `into_iter().flatten()` 静默丢（`:266`） |
| Hydrator | 并行 join_all | 长度不符 → 整批替换为 Err（`hydrator.rs:36-42`），不删候选 |
| Filter | **顺序** for 循环 | 同步；removed 进 `filtered_candidates` 累加器（不丢） |
| Scorer | **顺序** | Err 静默 skip，保留前一 scorer 的分（`scorer.rs:54-58`） |
| Selector | 同步单次 | 默认按 score 降序，NaN-safe fallback |
| SideEffect | `tokio::spawn` fire-and-forget | 结果 `let _` 丢弃 |

**框架级"陷阱"**（核验确认）：
- `hydrated_candidates.clone()`（`:98`）在 filter 前全量 clone，O(n) 开销，无懒求值。
- 无 backpressure / 限流 / 熔断 / 重试——任一 source/hydrator 挂起则整个 join_all 挂起。
- `Scorer` trait 注释有 copy-paste bug：第 44 行写"Dropping candidates in a **hydrator** is not allowed"（应为 scorer）。
- `SideEffect::enable` 取 `Arc<Q>` 而其它所有 trait 取 `&Q`——API 不一致。

**`CachedHydrator` blanket impl**（`hydrator.rs:72-189`）：定义 `CacheStore<K,V>` 接口（async get/insert），per-candidate 查缓存→命中走 `hydrate_from_cache`、miss 批量 `hydrate_from_client`，miss 成功后回写。

### 4.3 thunder（内存存储）

Rust + Tokio，per-user 内存时间线，单 gRPC 端点 `GetInNetworkPosts`。feeder 角色（`!is_serving`）读原始 tweet-events Kafka topic 重发更瘦的 proto；serving 角色（`is_serving`）读第二 topic 答 gRPC。

**数据结构**（`posts/post_store.rs`）：`posts: DashMap<i64, LightPost>` 是规范全量存储，三个 per-user `DashMap<i64, VecDeque<TinyPost>>`（original / secondary[回复+转发] / video）做时间线索引，外加 `deleted_posts` 墓碑集。`TinyPost` 只有 `{post_id, created_at}` 两字段，是指向 `posts` 的书签。并发用 `DashMap`（分片 RwLock），无全局锁。

**保留与裁剪**：默认 2 天（`172_800s`，仅 `Default` impl 用，生产走 CLI `args.post_retention_seconds`）；auto-trim 每 2 分钟（`main.rs:85`）；insert 时预过滤未来帖与超期帖。**已知小 bug**：video map 的 trim 计数被丢弃（`:470`，仅指标 bug 非正确性 bug）。

**服务行为**：唯一打分是 recency 排序（`sort_unstable_by_key(|post| Reverse(post.created_at))`，`thunder_service.rs:334-338`）——**无 ML、无 engagement 信号、无作者多样性**，ML 排序全在下游 home-mixer。zstd 压缩通道 + 信号量（满则立即返回 `RESOURCE_EXHAUSTED` 不排队）。两段查找（先 `TinyPost` 再 `LightPost`）避免大结构 copy。

**开源缺口**：**全部 4 个 Kafka topic 字符串是 `""`**（`kafka_utils.rs:15-19`），服务无法连任何真 Kafka；`config.rs` 与 `args.rs` 整个缺失（`lib.rs:8` 声明 `pub mod config` 但无文件），所有 per-author cap 常量值未知；`schema`/`o2`/`strato_client`/`metrics` 模块声明但无源文件；SASL 环境变量名也是 `""`。

**亚毫秒来源**：DashMap 并发读 + `spawn_blocking` 查找循环 + 两段查找 + zstd + 信号量快速拒绝。代码本身没有"亚毫秒"声明。

### 4.4 phoenix（THE 模型 —— 最深）

**最重要的代际事实**（两个核验者一致确认）：**phoenix 是 JAX + dm-haiku，不是 PyTorch、不是 Rust。** `pyproject.toml` 包名字面就是 `"grok-1" v0.1.0`，`jax==0.8.1` 硬钉，`dm-haiku==0.0.16`，无 torch/TF/FAISS/ScaNN/CUDA 专用依赖/Rust 工具链。所谓"Grok-based"只在"骨干 transformer 代码来自 Grok-1"这个窄义上成立。

#### 4.4.1 双塔召回（`recsys_retrieval_model.py`）

- **用户塔**（重，`build_user_representation` :221-291）：把 `[user_embeddings ; history_embeddings]` 过完整 Grok transformer（`candidate_start_offset=None`），masked mean-pool over 序列位，再 L2 归一化（EPS=1e-12）。
- **候选塔**（轻，`CandidateTower` :46-112）：两层 SiLU MLP（`enable_linear_proj=True` 默认，hidden=`emb_size*2` → `emb_size`）+ L2 归一化；或 `enable_linear_proj=False` 纯 mean-pool + L2（零参数，单测 `test_mean_pooling_has_no_params` 断言 `total_params==0`）。两塔**非 siamese、架构不对称**，但共用同一张单体 hash embedding 表（`build_unified_emb_table`，按 `pad=65` + user/item/author 范围切片）。
- **相似度 = L2-归一化点积（即 cosine）**，无温度（`log_temperature` 参数声明即丢弃，`run_pipeline.py:275`）。**核验关键修正**：README/docstring 反复称"ANN（近似最近邻）搜索"，但**代码实际是 brute-force 精确搜索**——in-model `jnp.matmul` 全量打分 + `jax.lax.top_k`（`recsys_retrieval_model.py:362-388`），pipeline 侧 `corpus_repr @ user_repr` + `np.argpartition`（`run_pipeline.py:302-310`）。无 FAISS/ScaNN/HNSW/任何索引。对 537K demo 语料够用，生产 ANN 索引不在本次发布。

#### 4.4.2 Grok transformer 排序器（`grok.py` + `recsys_model.py`）

**架构事实**（核验确认，README 配置表与可运行代码冲突）：

- **不是 MoE。** 尽管是 Grok-1 移植（Grok-1 是 MoE），本移植**无 router、无 experts、无 MoELayer**，每层是单个 dense `DenseBlock`。
- FFN 是 **GeGLU**：`gelu(W1 x) * (V x)` 再下投影（`grok.py:440-466`）。FFN 宽度公式 `int(widening*emb)*2//3` 再向上取 8 的倍数（`emb=128, widen=2` → 176）。
- Norm = **RMSNorm，pre+post 双归一化三明治**：每子层 `h += LN(sublayer(LN(h)))`（`DecoderLayer` :482-524），与 Grok-1 一致。RMSNorm scale 零初始化，eps=1e-5，强制 fp32。
- **RoPE** base=1e4，同时作用于 query 和 key（`:351-353`）。
- **注意力 logit tanh 软上限**：`30.0 * tanh(x/30)` + `attn_output_multiplier=0.125`（两处可运行配置都是 0.125），softmax 在 fp32，mask 填 `-1e30`（`grok.py:363-379`）——全是 Grok-1 原样。
- **GQA 能力存在但未用**：`num_q_heads != num_kv_heads` 支持齐全，但每个配置都设相等 → 实跑是 MHA。
- `fprop_dtype = bfloat16`，softmax/RMSNorm/attn-logits 上采到 fp32。
- **`Linear` 权重零初始化**（`grok.py:171-179`，`init=Constant(0)`）——无 checkpoint 时所有投影为零，随机初始化的前向产出退化输出。这是"只有载入（缺席的）checkpoint 才有意义"的真实坑。

**维度/头/层——README 配置表与每个可运行配置都冲突**（核验逐项确认）：

| 参数 | `run_ranker.py` demo | dataclass 默认 | README "Mini Config" 表 |
|---|---|---|---|
| emb_size | 128 | (必填) | 128 |
| num_layers | 2 | — | **4** ❌ |
| num_q/kv_heads | 2/2 | — | **4** ❌ |
| key_size | 64 | — | **32** ❌ |
| widening_factor | 2 | 4.0 | 2 |
| attn_output_multiplier | 0.125 | 1.0 | — |
| history_seq_len | 32 | **128** | **127** ❌ |
| candidate_seq_len | 8 | **32** | **64** ❌ |
| num_actions | 19 | — | 19 ✓ |
| FFN size | 176 | — | — |
| MoE | 无（dense GeGLU） | — | — |

**核验对"256-dim / 4 heads / 2 layers / ~3GB"的逐项裁决**：emb_size=256 **错**（全仓库说 128）；4 heads **仅 README，可运行代码是 2**；2 layers **匹配 demo 脚本但 README 说 4**；"~3GB"**错置**——README 自己的 size breakdown 说 `model_params.npz` 只有 **3 MB**，`embedding_tables.npz` 各 1.4 GB，2.9 GB 是**整个下载 zip**（两模型的 embedding 表 + 语料），不是"mini 模型"。真实 checkpoint 几何在 LFS-skip 的 zip 内的 `config.json`，**磁盘上不存在**（见 §9）。

#### 4.4.3 输入布局（"tokenizer"）

序列布局（`recsys_model.py:520-626`）：`[ user_token | history_token × S | candidate_token × C ]` → `[B, 1+S+C, D]`，`candidate_start_offset = 1 + S`。每个"token"是多特征融合 embedding，非词片。巨型 hash embedding 表在上游查好后传入（`RecsysEmbeddings`），模型只持小投影/类别表。

- **user token**：2 个 user-hash embedding concat 后投影。
- **history token**：post(2 hash) + author(2 hash) + **actions（用户对该帖做了什么）** + product_surface（在哪展示）+ 可选 dwell。
- **candidate token**：post + author + surface + **post-age 桶**。**不对称**：candidate 故意无 action embedding（你还没操作过），改给 recency 桶。
- **actions 编码**：`actions_signed = 2*actions - 1`（0→-1, 1→+1）——"没点赞"是显式 `-1` 信号而非 null；全零位置用 valid_mask 清零。
- **product surface** 共享词表 vocab=16；**post age** 桶 `POST_AGE_MAX_MINUTES=4800`（80hrs）60min 粒度 → 82 桶；**dwell** 经 1→64→D 的 2 层 GELU MLP，且只用 `history_continuous_actions[:, :, 1]`（index 1 = dwell_time），其余 7 个连续槽定义但未喂入。

#### 4.4.4 注意力掩码与候选隔离不变量（核验：机制真实、有单测、正确）

掩码构造 `make_recsys_attn_mask`（`grok.py:39-71`）三步：(1) `tril` 全因果掩码；(2) `.at[cand:, cand:].set(0)` 抹掉整个候选×候选块（含对角）；(3) `.at[candidate_indices, candidate_indices].set(1)` 仅恢复对角自注意力。

净效果（per candidate row）：可 attend 到所有 user+history 位 + 自己，**不能 attend 任何其它候选**。每条候选的上下文化 embedding 是 `(user, history, 该单条候选)` 的纯函数 → 分数与 batch 内其它候选无关、可缓存。掩码逐层传入每个 decoder layer（`:604-612`），通过 `attn_logits = jnp.where(mask, attn_logits, -1e30)`（`:378`）软执行。

**核验修正与 nuance**：
- 机制**真实、正确、接入每层、有结构单测**（`test_recsys_model.py:79-92` 直接断言候选块非对角为零，外加 user/history 因果、候选自注意力、全候选边界等）。
- README 措辞"候选只 attend 用户上下文"**不精确**——候选实际 attend 到 **user AND 全 history AND 自己**（ground truth 是 `test_full_mask_structure` 的期望矩阵，c2 行 = `[1,1,1,0,1,0]`）。
- **没有端到端 logit batch-invariance 测试**——只测了掩码数组结构，从未喂两个不同候选集断言 logit 相等。"consistent & cacheable"是架构推论，不是本仓库实测验证的模型输出不变量。
- 可选 right-anchored RoPE（默认关）给所有候选同一 position id，进一步强化顺序无关（`test_candidates_share_position` 验证）。

#### 4.4.5 输出 head（全枚举）

两个 head（`recsys_model.py:664-680`），对最后一层候选切片 + final layer_norm 后：
- **离散 engagement head**：`unembeddings [D, num_actions]`，出**原始 logits**（sigmoid 在 runner 侧 `runners.py:397` 才加），**multi-label（每动作独立 sigmoid）非 softmax**。
- **连续 head**：`continuous_unembeddings [D, 8]`，sigmoid 压到 [0,1]。`num_continuous_actions=8`。

**19 个离散动作**（`runners.py:233-253`，0-based `ACTIONS`）：0 favorite / 1 reply / 2 repost / 3 photo_expand / 4 click / 5 profile_click / 6 vqv(视频质量观看) / 7 share / 8 share_via_dm / 9 share_via_copy_link / 10 dwell / 11 quote / 12 quoted_click / 13 follow_author / **14 not_interested ⚠ / 15 block_author ⚠ / 16 mute_author ⚠ / 17 report ⚠** / 18 dwell_time。`NEGATIVE_FEEDBACK_INDICES = [14,15,16,17]`（定义但本发布前向路径未消费）。**8 个连续槽**中 5-6 个是 `"reserved"` stub，仅 dwell_time/video_watch_time/scroll_depth 有名，仅 dwell_time 在输入侧被消费。

**坑**：`dwell_time` 同时出现在离散（idx 18，sigmoid）和连续（idx 1）列表，`p_dwell_time` 是 logit 的 sigmoid 而非真实时长。**两套 action 索引并存**：`runners.py` 用 0-based `ACTIONS`（fav=0），`run_pipeline.py` 用 proto enum 1-based `IDX_*`（fav=1, reply=4, repost=6, dwell=11），两者索引同一 logits 数组——真实 footgun。

**排序怎么用 head**：`run_ranker.py` 只按 `favorite_score`（`probs[:,:,0]`）排，其余 18 个算了不用于排序。`run_pipeline.py` 用硬编码线性混合 `fav*1.0 + reply*0.5 + rt*0.3 + dwell*0.2`（`:355-361`，用 proto enum 索引）——这是**仓库里唯一的"价值模型"权重表，且是硬编码 demo 启发式，非学习得到**。

#### 4.4.6 训练与从 Grok-1 移植的内容

**无训练代码**。穷尽 grep 确认：无 optimizer、无梯度步、无 `jax.grad`、无 train_step、无 BCE/CE 调用。`ContinuousActionConfig` 的 `loss_weight=0.0, loss_type="mae", tweedie_power=1.5` 是惰性 dataclass 字段。README 明确这是"持续训练的冻结 checkpoint 快照"，训练 loop 不开源。

**从 Grok-1 逐字移植**（`grok.py`）：RMSNorm、RotaryEmbedding、Linear（零初始化）、MultiHeadAttention（含 30*tanh 软上限、attn_output_multiplier、GQA reshape）、DenseBlock（GeGLU）、DecoderLayer（pre+post RMSNorm）、Transformer 栈、ffn_size、TrainingState。**recsys 新增**：`make_recsys_attn_mask` + `right_anchored_rope_positions`（候选隔离，核心新意）、`Transformer.__call__` 的 `candidate_start_offset` 分支、整个 `recsys_model.py`（PhoenixModel、build_inputs、block-reduce tokenizer、action/连续/post-age embedding、双 head）。

### 4.5 grox（内容理解，2026 新增）

asyncio 多进程 task-plan 执行引擎，per-post 内容理解。**不是单个推理服务，是编排图执行器**。

**进程拓扑**（`main.py:21-50`）：Dispatcher（轮询多个 TaskGenerator 流、限流、提交 task_queue）+ Engine（轮询 task_queue、交 `PlanMaster.exec`、起 MediaProcessor/ASRProcessor）+ GrpcServer，共享 `ScheduleContext`（multiprocessing.Manager DictProxy）。优雅关闭硬编码 `asyncio.sleep(300)` 5 分钟 drain。

**9 条并行 plan**（`PlanMaster.ALL_PLANS`）：每个 task **所有 9 plan 用 `asyncio.gather` 并发执行**，eligibility gate 在每个 plan 内部检查 → 通常 8/9 立即返回 None。Plan 是 DAG（`asyncio.gather` over 依赖 future，任一依赖 SKIPPED 则下游级联 SKIPPED）。

**分类器**（全继承 `ContentClassifier`，全用 `VisionSampler`，temperature=0.000001）：

| 分类器 | 检测 | 模型别名 | 阈值/要点 |
|---|---|---|---|
| BangerInitialScreen | 是否"banger"高质量爆款 + 主题分类 | VLM_PRIMARY | `quality_score >= 0.4` 为正；同时填 BANGER_INITIAL_SCREEN 和 GROK_RANKER；主题缓存 TTL 3600s |
| PostSafetyDeluxe | 非回复公开帖安全筛 | VLM_PRIMARY_CRITICAL | 不出二元 verdict，只填 TweetBoolMetadata |
| SpamEapiLowFollower | 低粉账号回复 spam | VLM_PRIMARY | 仅低粉 target；与 reply ranking 互斥 |
| ReplyScorer | 回复质量分 [0,3] | VLM_MINI_CRITICAL（主）+ VLM_PRIMARY_CRITICAL（fallback） | JSON 解析失败回退 non_reasoning 路径 |
| SafetyPtosCategory + Policy | **PTOS = Post-Time-Of-Send 实时安全** | VLM_SAFETY（标准）/ VLM_PRIMARY_CRITICAL + EAPI_REASONING（deluxe） | 两阶段：类别检测→逐类策略；deluxe 无条件注入 AdultContent 复查 |

PTOS 7 类违规：ViolentMedia / AdultContent / Spam / IllegalAndRegulatedBehaviors / HateOrAbuse / ViolentSpeech / SuicideOrSelfHarm。

**多模态 embedder V2 vs V5**：

| 维度 | V2 | V5 |
|---|---|---|
| 后端 | EMBED_PRIMARY / Qwen3-0.6B(`qwen3`) / Qwen3-8B(`qwen3_8b`) / RECSYS_EMBED_V4(`v4`) | RECSYS_EMBED_V5 |
| 输出维度 | 不截断 | **截断到 1024 + L2 重归一化**（暗示底模 Matryoshka 式可截断） |
| 视频 | ConvoVideo bytes / 帧展开 | 仅 ASR transcript 文本 |
| Grok summary | 可选 | 无（用 ASR transcript） |
| 实际用 | key "v3"(qwen3+summary)、"v4" | key "v5_1" |

**Stream generator → eligibility 映射**（16 个生成器各钉死一个 Kafka topic + 固定 eligibility 集，决定哪些 plan 跑）。值得注意：`PostStreamDelayedTaskGenerator` 注入**空** eligibility（不触发任何 plan，疑似 stub）。

**Grox 已知 bug/stub**（核验发现）：
- 多个阈值在开源里是**空字符串**：`FOLLOWER_COUNT_THRESHOLD_FOR_SPAM_DETECTION = ""`、`FOLLOWER_COUNT_THRESHOLD_FOR_REPLY_RANKING = ""`、`RECENT_POSTS_LIMIT = ""`、`PostEmbeddingSummarizer(prompt_file="")`——运行时会 TypeError/FileNotFoundError。
- `ctx.safemodel_sex_nudity.positive`（`task_write_safety...:2415`）但 `TaskContext` 无此字段——运行时 AttributeError。
- `safety_ptos.py:242` 条件以 `and` 开头——语法错误（被 redact 的首条件 elided）。
- `_THINKING_RESTRICTION_LINES = {"", ""}`——两项空串，`_strip_thinking_restrictions` 实为 no-op。
- ASR：ffmpeg 抽 16kHz mono PCM WAV，调通用 OpenAI 兼容 `/v1/chat/completions`（model="default"）；Kafka ACK 是 no-op；MID 是随机 UUID（非 tweet ID/offset）。

---

## 5. 打分与排序的真相

### 加权和公式（`ranking_scorer.rs`，live 路径）

核心 `apply(score, w) = score.unwrap_or(0.0) * w`（`:121-123`），缺失预测按 0 处理（中性贡献）。

```
combined = Σ_i  P(action_i) · weight_i      （21-22 项）
```

但**最终 score 不是裸点积**，加权和后还经三层后处理：

1. **offset/重标定**（`offset_score` :175-183）：`total_sum==0` → `max(0)`；`combined<0` → `(combined + negative_sum)/total_sum * NEGATIVE_SCORES_OFFSET`；否则 `combined + NEGATIVE_SCORES_OFFSET`。再过 `normalize_score`（`score_normalizer.rs` **缺席**）。
2. **作者多样性几何衰减**（:186-217）：`multiplier(position) = (1−floor)·decay^position + floor`，position = 该作者已在更高分位出现的帖数。第 1 帖 multiplier=1.0，后续向 floor 衰减。
3. **OON 乘子**（:220-239）：仅 `in_network == Some(false)` 被乘；优先级——有 topic → `TopicOonWeightFactor`；冷启动新用户（账龄 < 阈值且关注数 ≥ `NEW_USER_MIN_FOLLOWING`）→ `NEW_USER_OON_WEIGHT_FACTOR`；否则 `OonWeightFactor`。**新用户被刻意多喂 OON 内容。**

### 完整动作集（21-22 项，含极性，`ranking_scorer.rs:146-170` + `:68-84`）

| 正向（+，进 positive_sum） | 负向（−，进 negative_sum，已取负） |
|---|---|
| favorite, reply, retweet, photo_expand, click, profile_click, vqv(gated), share, share_via_dm, share_via_copy_link, dwell, quote, quoted_click, quoted_vqv(gated), follow_author | not_interested, block_author, mute_author, report, not_dwelled |
| 连续（不进 sum）：dwell_time(ContDwellTimeWeight), click_dwell_time(ContClickDwellTimeWeight) | |

**负反馈是真实排序输入**：预测你会 not_interested/block/mute/report 的概率以负权重主动压制该帖。极性方向在代码里，但量级不在。

### 核验关键结论：数值权重是否在仓库里？—— **不在，一个都没有**

两个核验者独立确认（穷尽 grep）：
- 所有权重经 `params.get(FavoriteWeight)` 等运行时从 feature-switch 配置取，**param-key 类型本身和数值都在缺席的 `crate::params` 模块**（`lib.rs` 不声明 `mod params`）。
- feature-switch 配置文件（`params::FS_PATH` 载入）**不在仓库**——这才是含权重的文件。全仓库除 `phoenix/pyproject.toml`（无关）无任何配置文件。
- `weighted_scorer.rs` 的硬编码常量 `p::FAVORITE_WEIGHT … p::REPORT_WEIGHT`、`NEGATIVE_SCORES_OFFSET`、`NEW_USER_OON_WEIGHT_FACTOR`、`NEW_USER_MIN_FOLLOWING`、`AuthorDiversityDecay`、`AuthorDiversityFloor`、`TOP_K_CANDIDATES_TO_SELECT`、`PROMPTS_POSITION` 等——**零定义**。
- **没有一个硬编码权重数值、默认值、或 fallback。** 一个匹配 `<action>weight = <number>` 的正则全仓库返回空。

**结论**：开源发布的是打分的**结构与动作分类法**，但隐藏了**系数**——真正调 feed 的那些数字不在本次发布里。同样缺席的还有 `build_prediction_request`（决定哪些特征序列化进模型）、`score_normalizer`、`candidates_util` 的 vqv 权重计算。

### 两套打分栈共存（核验发现）

`scorers/mod.rs` 只声明 `phoenix_scorer / ranking_scorer / vm_ranker`（stack B，live）。`weighted_scorer.rs` / `author_diversity_scorer.rs` / `oon_scorer.rs` **作为文件存在但未接入 mod.rs**——是死/legacy 单发变体（19 字段 `PhoenixScores`，缺 quoted_vqv/not_dwelled/click_dwell_time）。live 的 `ranking_scorer` 把加权和、多样性、OON 折叠进单个 scorer（21 字段）。**VMRanker** 是第三个 scorer（远程价值模型，可选服务端 DPP 多样化 `theta`/`max_selected_rank`），README 从未提及。

---

## 6. 信号面

### 用户上下文（query hydrators，20 个文件）

| 信号 | 字段 | 来源 |
|---|---|---|
| 拉黑/静音/关注/订阅名单 | `user_features.*_user_ids` | SocialGraph(Flock)，全部无 cap |
| **scoring sequence** | `scoring_sequence` | UserActionAggregation，默认 `DenseWithNotInterestedIn`（含负信号），传 prediction_id |
| **retrieval sequence** | `retrieval_sequence` | 同服务，默认 `Dense`（正向压缩），不传 prediction_id，length cap 独立 |
| 已看/已发去重 | seen_ids / served_ids / bloom_filter / served_history | 客户端 + ServedHistory |
| Grok 主题 | `followed_grok_topics: [bool;32]` / `inferred_grok_topics: [bool;32]` | Manhattan(显式关注) / Strato(ML 推断) |
| starter pack | `followed_starter_packs: [bool;20]` | Manhattan，2026 新信号 |
| 互关 MinHash | `viewer_minhash` | Strato，下游算 Jaccard（256 hash） |
| geo-IP / 人口属性 / 推断性别 | ip_location / user_demographics / user_inferred_gender | GeoIP / Manhattan / Manhattan+gRPC fallback |
| 设备 | ip_address / user_agent / mobile_device_ad_id(MAID,送广告) | 客户端 |

**架构要点**：retrieval 与 scoring **分两次独立调** UserActionAggregation 服务——召回用简单正向序列、排序用含负信号的更丰富序列（length / 聚合策略 / prediction_id 三处不同）。**新用户技巧**：Snowflake ID 直接解出账龄（`days_since_creation == 0`），新用户走 gRPC 实时性别预测 + 单独 topic 召回路径 + 冷启动专用 Phoenix 簇 + 提升的 OON 权重。**Shadow traffic 无条件开启全部 topic/context/人口 hydration**（即使 flag 对 live 关闭）。

### 候选特征（candidate hydrators，~22 个）

正文/作者(Gizmoduck)/转发引用链(TES CoreData)/视频时长/has_media/语言/订阅门控/品牌安全(双路 mutex by decider)/可见性(VF，OON 用更严的 `TimelineHomeRecommendations` 安全级)/互关 Jaccard(256 MinHash 位逐位比)/engagement counts(fav/reply/repost/quote，gated `EnableContextFeatures`)/filtered topics(A/B 实验臂)/following_replied_users(facepile)/tweet_type_metrics(永远跑的 bitset：转发/回复/订阅/视频/年龄桶/作者粉丝桶/视频时长桶/feed 新鲜度信号)。

### 序列信号

核心是 **UserActionSequence**——用户最近 engagement 历史的聚合，按 `UAS_WINDOW_TIME_MS` 窗口、`UAS_MAX_SEQUENCE_LENGTH` 截断（保留最近，丢最旧），含 action multi-hot + dwell + product surface。这是 Grok transformer 学相关性的唯一序列输入（README 设计哲学的落地）。

---

## 7. 对抗核验结论

| 核验 | 裁决 | 要点 |
|---|---|---|
| **候选隔离注意力独立性** | **部分为真** | 机制真实、正确、接入每层、有结构单测（`grok.py:39-71`，`test_recsys_model.py:79-92`）。但 (a) README"只 attend 用户上下文"不精确——实际 attend user **AND 全 history AND 自己**；(b) **无端到端 logit batch-invariance 测试**——只测掩码数组，"可缓存"是架构推论非实测不变量。 |
| **权重是否在仓库** | **假，明确** | 每个权重、offset 常量、新用户/OON 因子、多样性衰减/floor、整个 `params` + feature-switch 配置都按符号引用、**不在仓库**。无硬编码值、无默认、无配置文件。开源发布机器与动作分类法，但隐藏系数。 |
| **双塔数字（256/4heads/2layers/~3GB）** | **如述即假** | 无一项完整成立。可运行代码 emb=**128**；README"Mini Config"表说 4heads/4layers，demo 脚本说 2/2；真实几何在 LFS-skip zip 内 config.json，磁盘不存在。"~3GB"错置——那是整个下载 zip，模型参数只 ~3MB。双塔结构本身（user 塔×candidate 塔 + L2 点积 top-K）**确认为真**，但"ANN"是 README-only，代码实为 brute-force。 |
| **"无手工特征"调和** | **相关性层真、整系统假** | Grok 确实取代手工相关性评分公式（"for content relevance"——README 自己的限定词，诚实核心）。但 (a) 工程化 tweet 特征（engagement counts/has_media/语言/类型布尔）仍由专用 hydrator 计算并按 `EnableContextFeatures` 送进模型 input proto（`models/candidate.rs:117-152`）；(b) 模型周围密布启发式——~18 个规则 filter、三个 post-model 分数启发式（多样性/OON/新用户）、整个手写广告+品牌安全+位置引擎、可见性过滤、硬编码模块位置。README 自己已退到"**most** heuristics"——代码证实这才准确，"every single … and most heuristics"夸大了前半句。能审最强版本声明的文件（`crate::params` 权重、`build_prediction_request`、`score_normalizer`）恰恰不在开源里。 |

---

## 8. 工程与基础设施

- **语言/RPC**：home-mixer + thunder = Rust + Tokio + tonic gRPC（gzip+zstd 压缩、mTLS）；phoenix = JAX/Haiku；grox = asyncio Python 多进程。
- **Kafka**：训练样本/served history/impression/广告注入/内容理解全经 Kafka（多 cluster：Ads/Bluebird/Phoenix/ClientEvents/Aiml/Bluebird）。grox 摄取也是 Kafka（topic 名在配置）。
- **Redis**：候选缓存（zstd-6，TTL 180s，命中 ≥500 帖才算够，key 编码 user_id+topics+in_network_only+exclude_videos）+ Phoenix request 跨 DC 双写（atla+pdxa）+ cached posts query hydrator（300ms timeout）。
- **Navi/推理**：PhoenixScorer 经 `PhoenixPredictionClient` gRPC 调远程 transformer（egress sidecar + 直连 fallback），多簇路由（Fou/Lap7/新用户/MoE/topic 簇），decider A/B 切换。
- **缓存与一致性**：候选隔离不变量是可缓存性的架构基础——分数与 batch 组成无关。`CachedHydrator` blanket impl 提供 per-candidate 缓存。Thunder 用 DashMap 内存存储免外部 DB。
- **为什么快**：(1) 框架内每阶段独立并行（join_all）；(2) Thunder 亚毫秒内网查询（DashMap + spawn_blocking + zstd + 信号量快拒）；(3) 候选隔离让分数可缓存；(4) side effect fire-and-forget 不阻塞响应返回；(5) bfloat16 推理。

---

## 9. 开源了什么 / 没开源什么

**开源了**：整条流水线的结构骨架（六 trait 框架 + 全部 hydrator/filter/scorer/source/side-effect 的 Rust 实现）、Phoenix 模型架构（双塔 + Grok transformer + 候选隔离掩码 + 双 head，含单测）、grox 编排引擎与全部分类器/embedder/task/plan、thunder 存储逻辑、动作分类法、打分公式形状。

**没开源（关键缺口）**：

| 缺失 | 影响 |
|---|---|
| **模型权重（LFS）** | `phoenix/artifacts/oss-phoenix-artifacts.zip` 是 135 字节 LFS pointer（`oid sha256:fbc6017…`，`size 2903518802` ≈ 2.9GB），blob clone 时 skip。`model_params.npz` / `embedding_tables.npz` / **`config.json`（真实维度）** / sports_corpus / example_sequence 全缺。模型只能随机初始化（`PRNGKey(42)`），叠加零初始化 Linear → 退化输出。 |
| **真实配置/权重** | `crate::params` 模块整个缺失：所有 engagement 权重、offset 常量、阈值、TopK、feed 位置、Thunder/Phoenix cap、`FS_PATH`、`TEST_USER_IDS`。feature-switch 配置文件不在仓库。 |
| **模型输入边界** | `crate::util::phoenix_request::build_prediction_request`（决定哪些特征进模型）缺失——无法审"无手工特征进模型"的最强版本。`score_normalizer`、`candidates_util` 也缺。 |
| **训练代码** | 无 optimizer/梯度/loss——发布是冻结推理 checkpoint，训练 loop 不开源。 |
| **依赖服务** | gizmoduck（用户）、strato（KV）、tweet-mixer、TES（Tweet Entity Service）、Flock（社交图）、Phoenix 推理服务、AdIndex、Manhattan、VF stack、ReplyMixer、UserActionAggregation——全是外部第一方服务，仅有 client trait 声明。 |
| **基础设施类型** | `xai_feature_switches`、`xai_decider`、`xai_stats_macro` 等第一方 infra crate 未开源。 |
| **Thunder 配置** | `config.rs` / `args.rs` 缺失，4 个 Kafka topic 名为 `""`，per-author cap 全未知，schema/strato_client/metrics 模块声明无文件。 |
| **grox redact** | 多个阈值、prompt 路径、thinking restriction token 为空串。 |

---

## 10. 可迁移的设计洞见 → 用户的"知识图谱学习/复习推荐"项目

把 X 的架构映射到 the-learning-project（n=1 自用、冷启动、KG 组织错题/进度/note artifact）：

| X 的设计 | 迁移到学习推荐 | 落地建议 |
|---|---|---|
| **候选隔离不变量（per-candidate 可缓存打分）** | 给每个 KC/题打"该不该复习/学"的分时，**让每条候选的分只依赖 {用户状态, 该候选本身}，不依赖同批其它候选** | 你已有 FSRS（ts-fsrs）调度——保持每题分数是 `(用户 mastery 状态, 该题)` 的纯函数，与同批候选无关 → 分数可缓存、可解释、可单测。这正是你 calibration/cold-start 同构核（YUK-495）应守的不变量：**确定性、parse-barrier、时时刻刻守不变量**（与你"sonnet 弱于不变量代码"的教训一致，这类代码派 opus）。 |
| **双塔召回（user 塔 × candidate 塔，L2 点积 top-K）** | 用双塔做 KC/题召回：user 塔编码学习历史序列，candidate 塔编码题/KC | 候选塔可极轻（你的题库规模远小于 537K，**brute-force 精确点积完全够**——别上 ANN，X 自己 demo 也是 brute-force）。user 塔吃你的 engagement 序列（做对/做错/复习历史）。 |
| **多动作加权和 = 显式价值函数** | 别只预测单个"该复习概率"，预测多个学习动作（答对/答错/放弃/propose KC/dwell），线性加权成显式价值 | 与你"propose/KC 是内容轴、错因/mastery 是表现轴，两轴正交"（YUK-482）天然契合——把内容轴信号和表现轴信号作为不同 action head，权重显式可调。**负信号也建模**（如"预测会放弃/会答错到沮丧"带负权抑制）。权重是 owner 决策的显式数字，不藏。 |
| **内容理解独立成层（grox）** | 把"题/note 的内容理解"（KC 标注、难度分类、多模态 embed 带图手写题）独立成层，与召回/排序解耦 | 你的录入→判分 pipeline（GLM-OCR + Opus vision 整页判分，YUK-484/485）就是这一层。保持它独立、异步、可缓存标注结果——像 grox 写回 Strato，你写回 KG/DB。**整页 vision 判分 > 本地切割**（你已验证）对应 grox 的"VLM 兜底"分层。 |
| **shadow traffic 看全信号** | 在不影响 live 体验下收集全量信号 | 与你"数据门只 gate 翻转不 gate build"一致——先把信号收集 + 接线 + UI 穿到 live，只 defer 最终翻转。 |

**诚实的反向洞见（为什么"消除手工特征"不迁移到 n=1 冷启动产品）**：

X 能"用 Grok 序列模型取代手工特征"，前提是**海量用户 × 海量 engagement 流水持续训练一个大模型**。你的产品是 **n=1、冷启动、day-one 必须靠先验可用**（你的核心信念：`feedback_cold_start_first` + `project_cold_start_content_model`）。这意味着：

1. **你没有训练信号去 learn 相关性**——n=1 没有 batch、没有持续训练流、没有 5% 采样训练样本。X 的"让 transformer 做所有重活"在你这里=冷启动死循环（无数据→无模型→无推荐→无数据）。
2. **手工特征 + 先验规则对你恰恰是资产不是债务**——FSRS 的间隔重复理论、KC 图的 prerequisite 拓扑、错因分类，这些"手工 / 启发式"是你 day-one 可用的唯一来源。X 自己也保留了 ~18 个规则 filter、三个分数启发式、整个广告规则引擎——**连 X 都没真的"消除"启发式**，README 退到"most heuristics"。
3. **可迁移的是结构不变量，不是"无特征"哲学**：迁移候选隔离的可缓存打分、双塔召回的轻量结构、多动作显式价值函数；**不要迁移**"等数据翻 flag 让模型学一切"——对 n=1 这是错的框架（你的 `feedback_cold_start_first` 已锁定这点）。X 的 cold-start 处理（新用户专用模型簇 + 提升 OON + 单独 topic 召回 + Snowflake 解账龄）反而印证：**连 X 都给冷启动单独建先验路径**，而不是指望主模型从零学。

**结论映射**：抄 X 的**架构纪律**（per-candidate 不变量、双塔、显式多动作价值函数、内容理解独立层），拒绝 X 的**数据前提哲学**（消除手工特征、让大模型 learn 一切）——后者建立在你没有的海量训练流之上。

---

## 如果要再深挖（值得 follow-up 读的具体文件）

1. **`phoenix/recsys_model.py:520-680`** —— `build_inputs` 全量 token 组装 + 双 head 的完整数值流（本报告已覆盖主干，但 block-reduce 各投影矩阵的精确 shape 与 padding mask 传播值得逐行）。
2. **`phoenix/run_pipeline.py:118-389`** —— 端到端 retrieval→ranking 的唯一可运行路径，含 hash 函数（LCG，`pad=65`）、单体 emb 表重建、N_neg=64 全局负样本（算了即丢的 param-注册 wart）。
3. **`home-mixer/scorers/ranking_scorer.rs:42-275`** —— live 打分栈全貌（from_params 22 权重 + offset + 多样性 + OON 三层后处理），对照缺席的 `params` 模块理解哪些数字被隐藏。
4. **`home-mixer/candidate_pipeline/phoenix_candidate_pipeline.rs:185-440`** —— Layer 1 主接线 + Phoenix 多簇 prod 初始化（Fou/Lap7、空 EDS 字符串占位、死 ImpressedPostsQueryHydrator）。
5. **`grox/plans/` + `grox/generators/stream_generator.py`** —— 9 plan 的 DAG 组成 + stream→eligibility 全映射表（理解哪条 Kafka topic 触发哪些内容理解 task）。
6. **`phoenix/grok.py:39-109` + `phoenix/test_recsys_model.py`** —— 候选隔离掩码构造 + right-anchored RoPE + 全部结构单测（若要在自己项目复刻可缓存打分不变量，这是参考实现 + 测试范式）。
7. **`home-mixer/ads/partition_organic_blender.rs` + `models/brand_safety.rs`** —— 广告混排 + 品牌安全规则引擎全逻辑（PTOS cutoff snowflake、三条 drop 规则、botmaker rule 分类）。
