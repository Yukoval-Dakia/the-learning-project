---
status: accepted
---

# ADR-0072 — 题库 agent 工具：search_bank / read_bank / check_bank

**Status:** Accepted（设计方向，2026-10-11；2026-10-19 owner 批准 search 内逐条件语义核验）。三工具已在 main；2026-10-22 的 search v2 源码切片与迁移依赖见 [本片实施边界](../planning/2026-10-22-yuk1448-search-semantic-verification.md)，DB/provider/真实产品验收 NOT_RUN，不代表完整 L1/LIGHT。旧 LIGHT 的历史源码、6-case DB 证据与当时未交付能力见 [实施回执](../planning/2026-10-11-bank-tools-light-implementation.md#2026-10-12-cloud-接续与验收边界)。
**Decision source:** owner 2026-10-11「关键还在给 agent 什么工具」；Coordinator 对题库工具提案的评估意见（YUK-1448 评论，2026-10-11 13:10），其调整逐条采纳为本文决定。
**Tracking:** [YUK-1448](https://linear.app/yukoval-studios/issue/YUK-1448)。
**Related:** ADR-0069（单一备题员——本文修订其 D1 工具清单与硬边界 1）、ADR-0070（统一学习者大脑——本文增补其 D1 契约一项批量读面，见 D4）、ADR-0067（教研白板）、ADR-0068（通用学科）、[YUK-1468](https://linear.app/yukoval-studios/issue/YUK-1468)（备题员）、[YUK-1470](https://linear.app/yukoval-studios/issue/YUK-1470)（学习者大脑）、[YUK-1474](https://linear.app/yukoval-studios/issue/YUK-1474)（provider fallback chain，不在本 ADR 范围）；详细设计真相源（随本文同提交版本化）`docs/planning/2026-10-11-question-bank-agent-tools-proposal.md`（下称「提案」，含接口细节、42 条种子查询与机制攻击集）。

## 背景与问题

题库今天的 agent 检索面与 agent 的需要错位（本段为 2026-10-11 的历史基线，不是当前 main 状态）：`query_questions` 只按结构过滤（knowledge_id / subject / kind / source / 单一 difficulty / draft），且只授予 copilot 两个面——备题员（ADR-0069）等后台 agent 没有任何列库手段；`get_question_context` 把题目内容与学习者状态（attempts / review_history / fsrs_state / records）混在一个响应里，授予面虽宽却不能直接当题库读取面。`listQuestions` 读模型已支持文本子串（ILIKE）、多难度、visual_complexity、source_tier、draft_status、变式族与排序——工具只透出一小部分。语义检索基件已建好却无活消费者：`question.embedding`（vector(1024)、embed_version=2、embed_content_hash）只被 `poolFetch` 的 cosine 分支读取，而该分支的唯一调用者 `matcher()` 无生产调用方（sourcing-sequence / refill 均不传 queryEmbedding）；`solution-generate.ts` 直接 UPDATE `reference_md`，绕过 `editQuestion` 的 hash 失效路径，向量随之过期。全库没有 Postgres FTS（无 tsvector），没有按图、按材料、按「与这题相似」的检索。

本文是决策记录，不是实施 spec：请求/响应字段、错误与过期语义、检查清单以提案为真相源，本文只钉决定与边界。

## 决定

### D1 三个工具：search_bank 找候选、read_bank 取内容、check_bank 答检查；教学决策永远归 agent

`search_bank`（自然语言 + 题/作答/材料锚点 + 确定性 scope）返回带来源证据的候选与诚实覆盖信息；`read_bank`（批量 refs + include 分层 + focus 定位 + 分片续读）返回版本化内容与证据，原文 / 记录事实 / 派生分析分层；`check_bank` 回答 agent 显式提出的检查，verdict ∈ supported / contradicted / unknown，方法与依赖版本全披露。选什么、怎么组合、何时补题、何时停止由备题 agent 决定；工具不做教学效用排序、不组卷、不改 learner state（提案 §3）。**`search_bank` / `read_bank` 在 agent 面取代 `query_questions` 与 `get_question_context` 的题库内容层**；首批消费者是备题员第一刀（ADR-0069，三工具全授予）与 Copilot。LIGHT 的取代**只切换备题员与 Copilot 两个面**的取题路径；coach / dreaming / maintenance / ingestion_block_edit 继续经现有 `get_question_context` 读取不变，直至 read_bank 按面授权铺开（并入未决问题 3 一并裁决）。`get_question_context` 的学习者状态层不在取代范围——那是 learner-side 读取，归学习者大脑契约（D4）。

### D2 版本化内容引用 ref + 显式范围 + cursor；v1 无 result_ref 句柄

内容引用 `ref` 指向一次确定内容版本，解析失败或过期明确报错、绝不偷换 latest。映射基件已存在：`question_revision`（不可变：group_id + revision_ordinal + integrity_digest + supersedes 链）承载题与题组版本，`source_asset` / `source_document` 承载材料资产；`question` / `question_group_lifecycle` 是可变指针，ref 不裸指向它们。对象种类 = question / material / group；group 是已有题组（父题 + part），搜索不创建新组合。检索范围用确定性 `scope`（subject / collection / **within_refs** / related_to / exclude / kinds），续页用不透明 `cursor`；**v1 不实现 `result_ref` 结果句柄**——反复收窄用显式 within_refs + 新查询，句柄化与否按提案 §12 的独立比较再定。响应必须报告 candidate_pool_size、retrieval_truncated、page_has_more、unavailable_channels 与尚未核实的要求。

### D3 题画像 = 带版本的派生索引，不是入库前置条件

方法指纹、错法画像、作答统计（区分度、常见错答、用时）是从内容与**已准入判分证据**派生的索引：每项携带派生版本与来源、可重建可撤销、在响应里标注 inference；未准入过程证据保持 unverified。**search 用它们回答锚点查询**（「与这次作答相同错法机制」）；**read 在独立 analysis 层返回它们**，不与原文混排。不要求每题先补齐统一画像才有检索面——可靠字段直接用，推断特征只作召回与分析。

### D4 个性化数字来自学习者大脑，题库工具永不读写 learner state

题库工具不读、不写、不缓存任何学习者状态（作答、FSRS、mastery、预测）。**对 ADR-0070 D1 契约增补一项批量读面：输入候选 ref 列表，逐 ref 返回 P(correct)、uncertainty 与 prediction version**——备题 agent 把它与 search 结果在 agent 侧组合（覆盖提案 Q42「答对概率约 70%」）。该读面是 ADR-0070 契约的消费者入口，数字仍全部由代码产出（ADR-0070 硬边界 6 不变）；备题 agent 与 Copilot 是契约读者，不成为第二个 learner brain。

### D5 check_bank 保持确定性；search_bank v2 内做逐条件语义核验

`check_bank` v1 检查类别仍限于记录关系读取与已批准的确定性复算。claim 必须忠实解释；无法忠实归一化返回 unknown/ambiguous，不执行任意候选代码。

2026-10-19 owner 的 YUK-1448 LIGHT → FULL 规格覆盖旧“search 只召回、不模型核验”的阶段限制：唯一 `search_bank` 的显式 v2 在同版、有权限的必要内容上，逐候选核 required/preferred 与同题共同成立，method=model/mixed、原文定位与缺证留存。全局 enforced 仍只列确定性硬过滤，unknown 不计 matched。配置任务无工具，沿现有任务/attempt/费用账，不赋予准入、gold、组卷或发行权。实际对照验收仍须真实 provider；本次 NOT_RUN，不能把源码接线写成质量胜出。版本化组卷→issuance、L2 索引与 L3 缺口仍有未交义务。

### D6 规模形态：单学习者、≤数万条目——暴力 pgvector + Postgres FTS，不建独立检索服务

向量列已存在（1024 维、无索引——本来就是顺序扫描），当前 Postgres FTS 使用查询时 tsvector 表达式（无持久 tsvector 列），与现有 ILIKE / KC 包含 / 标量过滤融合；数万行规模下暴力 cosine 足够，不建 ivfflat/hnsw、不建独立检索服务。图像多向量（ColPali 式）等真实图查询证据出现再上（提案 §10）。检索算法内部可换（融合权重、扩展、阈值），已应用条件与响应语义保持稳定。

## 硬边界（后果）

1. **§9 八项承重不动**：bank 工具是 agent 读取面，不是练习流选题路径；按 kind 确定性选题 seam（ADR-0030）、pedagogy 确定性 shortlist 与 today 兜底（rewrite-prep §9-1/§9-6）原样运行，工具结果不直接进入练习流主选择。
2. **题库工具永不读写 learner state**：个性化数字只经 ADR-0070 契约批量读面（D4），工具内不拉取、不改写、不缓存学习者事实。
3. **ref 永不偷换 latest**：内容变更产生新版本引用；无法解析、已撤回或过期的引用返回明确错误，不静默降级。
4. **派生画像标注推断、带版本可重建**：推断特征不冒充记录事实；未准入证据保持 unverified；画像可整批重建撤销。
5. **check_bank 不放大 claim**：interpretation 忠实于原 claim，较窄事实只对较窄结论 supported；不能把难问题改写后仍报 supported；不为任意 claim 临时生成执行程序。
6. **工具响应不自动进学习者界面**：学习者可见内容与 agent 可见内容是独立投影，由 UI 线设计。
7. **范围之外**：覆盖率地图与缺口单留在供题/白板侧（ADR-0067/0069）；provider fallback chain 归 YUK-1474；`store_sourced_question` 仍是唯一入库闸，题库工具全部是 read 面。

## 分阶段交付（对齐 AGENTS.md 交付阶段）

- **LIGHT 竖切（先行）**：`search_bank` + `read_bank` 接通真实题库，agent 面取代 `query_questions` / `get_question_context` 的题库内容层；within_refs + cursor，无 result_ref；`check_bank` 只含 D5 的确定性检查；D3 派生画像首批只做已准入证据足够支撑的项。**owning line：migration**——三工具与备题员任务在 Start/DBOS 侧注册，ref ↔ 目标存储的解析映射定稿；**feature**——三工具实现、FTS/向量检索融合、派生画像索引、备题员接线（ADR-0069 第一刀）与 Copilot 面切换；**UI**——消费者能定位工具返回的同一版本化 ref，显示缺图/缺材料等缺口。验收按提案 §12 由 Coordinator 预注册：同任务同快照比较 baseline / search+read / search+read+check，机制攻击集 + 42 条种子查询 + 真实需求；付费调用受每周预算规则约束。
- **FULL**：三工具完整契约（多媒体真实读取、可靠批量检查、按证据逐项引入的索引增强——图像多向量、反向需求扩展、关系索引）。**owning line：migration**——ref 与版本映射随目标数据模型定稿；**feature**——按 §12 证据逐项引入检查与索引增强；**UI**——材料媒体、analysis 层与版本化引用的展示随 UI 重写设计。与迁移、功能改造、UI 重写一起排期；内部能力分段兑现，不要求首日覆盖全部学科检查（提案 §11）。

## 被拒绝的备选

- **单一 `prepare/find_questions(intent)` 按学习者匹配度排序返回整体方案**：把教学决策藏进工具、与备题 agent 职责重复、失败难归因——Coordinator 早期草案，被 D1 三工具职责划分取代。
- **暴露 SQL / 向量 / 全文等底层原语**：agent 被迫理解索引与数据布局、提示词随迁移漂移——留作内部实现与开发诊断，不作日常接口（提案 §4）。
- **v1 实现 `result_ref` 结果句柄**：生命周期与过期恢复成本未证收益——先 within_refs + cursor，按 §12 独立比较再定（D2）。
- **v1 接入语义检查**：未证优于 agent 直接 read 且增加费用——逐项过预注册比较才准入（D5）。
- **独立检索服务 / 图像多向量现在就上**：规模（单学习者、数万条目）不支持其成本——暴力 pgvector + FTS（D6）。
- **题画像作为入库前置画像表**：制造「不补齐不能用」的门槛且无法标注推断——改为带版本派生索引（D3）。

## 未决问题

- ref 的目标编码（`question_revision.revision_id` / `integrity_digest` vs 复合 group 引用）与历史 `question.id` 引用的迁移映射，随 migration 线定稿。
- FTS / 向量 / 字面量召回的融合形态（加权、RRF、阈值）与「尚未核实要求」的回显粒度，随 LIGHT 实测定。
- `get_question_context` 学习者状态层的最终归属（保留为 learner-side 工具还是并入 ADR-0070 读面），随学习者大脑第一刀定。
- D3 各画像的首批派生实现与数据充分性阈值；达到预注册样本量前不报数。
- result_ref 是否引入、首批语义检查项、图像多向量触发条件——均待提案 §12 证据。
