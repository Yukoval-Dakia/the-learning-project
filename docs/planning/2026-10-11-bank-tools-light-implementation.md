# Bank tools LIGHT 竖切 — 实施记录（search_bank / read_bank / check_bank）

状态：**2026-10-12 已找回原分支，完成本地 6 个 DB case 与源码修复；draft PR / exact-head CI 在本轮交付回执中绑定**（feat/bank-tools-light）。本文件保留 10-11 历史回执，当前状态以末节为准。
决策真相源：ADR-0072（D1–D6 + 硬边界 + 分阶段交付）与提案
`docs/planning/2026-10-11-question-bank-agent-tools-proposal.md`（接口细节真相源）。
本文只记录 LIGHT 落地时的工程决定；与 ADR/提案冲突处以 ADR/提案为准。

## 交付范围（LIGHT only）

1. `search_bank`：结构化硬过滤（subject / kind / draft / withheld-admission / source）
   + Postgres FTS 与暴力 pgvector 向量召回并行，RRF 融合；返回版本化 ref + 显式
   scope（含 within_refs）+ cursor；候选卡片 + 覆盖诚实声明。无 result_ref。
2. `read_bank`：按 ref 批量取版本化内容；ref 无法解析 / digest 不符 / 已撤回 →
   显式错误，绝不偷换 latest；缺图缺材料如实上报。
3. `check_bank`：仅确定性检查（D5）：记录关系读取 + 已有纯校验器的确定性复算。
   无语义（模型）检查。
4. 面替换：删除 `query_questions`（与 search_bank 同职责）；`get_question_context`
   保留为 learner-state 读面（ADR-0072 未决问题 3 归学习者大脑线裁决，
   coach/dreaming/maintenance/ingestion_block_edit 继续原样读取）。
5. 同分支修 embedding 失效 bug：`solution-generate.ts` 直写 `reference_md`
   绕过 `editQuestion` 的 hash 失效路径 → 补齐按 revision + 内容 digest 的失效。

## ref 编码（当前目标存储映射见末节；历史导入另需 registry）

**格式：`qrev1:<revision_id>:<integrity_digest 前 12 位 hex>`**

- `revision_id` = `question_revision.revision_id`（不可变行主键，cuid 全局唯一）；
  `integrity_digest` = 同行不可变内容指纹（发布 seam 内重算强制，`sha256:<64hex>`），
  ref 携带其 hex 前 12 位（48 bit，防 ref 抄写/换target 错位）。
- 理由：ADR-0072 D2 明言 ref 指向 `question_revision`，不裸指向可变指针
  （`question` / `question_group_lifecycle`）。revision_id 是当前 schema 中最稳定的
  版本身份；digest 前缀在读取不可变行后提供错引校验，且在未来 migration 线重键
  （re-key）存储时，digest 仍可验证内容身份 —— 这正是未决问题 1 交给 migration
  线的输入。单题 = 1-part 组，question 与 group 共用组版本语法，kind 由
  parts/materials 派生，不进 ref。
- 解析语义（read/check 共用）：查无此行 → `unresolvable`；digest 前缀不符 →
  `digest_mismatch`（过期/错引，显式错误，绝不回退 latest）；lifecycle
  `withdrawn=true` → `withdrawn`（硬边界 3）。
- 2026-10-11 takeover 已经由 `t3_thread_send` 通知 migration 线程
  `4bbfaeee-21f6-462e-b358-a012f9c96b4c` 请求确认，回执 delivery=started；映射仍待该线确认。

## 检索形态（D6 对齐）

- FTS：无 tsvector 列（今天没有），LIGHT 不加迁移 —— 查询时在 SQL 内对
  `prompt_md + reference_md + choices_md` 做 `to_tsvector('simple', …)`，中文用
  `regexp_replace(…, '([一-鿿])', '\1 ', 'g')` 逐字切分后进 simple 词典（提案
  允许的 simple match；数万行规模暴力可接受）。`ts_rank` 排序。
- 向量：既有 `question.embedding`（1024 维 DashScope text-embedding-v4，
  embed_version=2），查询经与池向量同一 embed seam（`embedText` + provider
  attempt 记账）嵌入；cosine `<=>` 暴力扫描。embed 失败 → 该通道记
  `unavailable_channels`，FTS 结果照常返回（诚实降级，不假装全库）。
- 融合：RRF（k=60），通道截断上限各 200；候选池 = 通道命中并集 ∩ 硬过滤，
  `candidate_pool_size` 只声明这个有限池，不冒充语义匹配总数。
- cursor：v2 自包含本次有限候选池顺序/通道、query/scope/limit、卡片 digest 与 15 分钟有效期。
  续页不重跑召回或 embedding；重新校验原池的硬过滤、版本与自动可判范围。原池卡片变化/撤回
  或到期明确报错要求新搜索，不把新题/新版填入旧页。无新表、结果句柄或缓存 registry。
- within_refs 只接受明确列出的当前版本；空数组为空范围。存量索引针对可变
  工作副本，不冒充历史索引：旧版本返回 superseded 错误，历史内容仍可经
  read_bank 精确读取；不替换为新 ref。最终卡片查询重施全部硬过滤。

## 取代面（LIGHT 只切 Copilot）

- `query_questions` 全量删除（工具/注册/allowlist/throttle/snapshot/UI 标签/
  SKILL 与 write_quiz 文案同步），`search_bank` 接管其唯一职责（查重前列表）。
- 新三工具授予 `copilot` surface（`COPILOT_TOOLS`）；maintenance 维持
  chokepoint 过滤（与 query_questions 同款 containment）；备题员面
  （ADR-0069 第一刀）落地时按其任务注册再授予。
- `get_question_context`：保留全部现有授予（coach/dreaming/maintenance/
  ingestion_block_edit 原样读取；其 learner-state 层不在取代范围）；描述更新
  指引内容读取走 `read_bank`。不在 LIGHT 里做 per-face 响应裁剪 —— 结构上
  不存在按面分叉的响应通道，裁剪即改动受保护面的读取，超出本刀。

## check_bank v1 检查类（全部确定性）

| kind | 语义 | method |
| --- | --- | --- |
| `same_material_refs` | 多 ref 的版本化材料资产集合是否完全相同（窄事实：资产身份，不判「同一篇文章」语义） | record_lookup + 集合比较 |
| `ref_state` | ref 是否当前版；可服务检查复用发题 gate，回显精确可判 part_ids；单 ref 可指定 params.part_ids | record_lookup + deterministic_recompute |
| `contract_valid` | 对已存版本四层重跑发布期纯校验器（validateStructure/ResponseSpec/ScoringBasis） | deterministic_recompute |
| `material_assets_present` | 二进制材料资产在场且 sha256 与版本 digest 一致 | record_lookup |

自由文本 claim 不做解释（忠实归一化不了 → unknown + 支持类清单），与 D5 一致。
注：`contractIntegrityDigest` 用插入序 JSON.stringify，jsonb 读回不保序，无法
从行值重derive 存量 digest —— 「重算 digest」不作为检查项，`contract_valid`
以重跑校验器代替（同一发布闸的确定性子集）。

## Takeover 修复与边界证据

- cursor 全结构校验，含 scope 枚举、整数 limit/offset；最终卡片查询重施硬过滤，
  已召回候选失效时 coverage.complete=false。
- check_bank 自由文本 claim 原文解释并返回 unknown；非法 ref_state.assert 不回退
  is_current。语义模型调用为零。
- 自动公开快照仅保留 search scope/coverage、check 能力目录；不发布 bank 原文、
  答案、材料、检查证据，正式学习者投影仍归 UI 线。
- solution backfill 在 root→child 锁序内读取当前源文本再计算 embedding digest。
  embed_backfill UPDATE 对选中的 prompt/reference/choices/hash 做 null-safe CAS，
  provider 等待期间内容改变则拒绝旧向量；实际成功写入数才计数。
- read/check 将 bare SHA 与 sha256-prefixed digest 规范化比较，unverified digest
  继续不通过。缺图和真实摘要不符仍显示 unavailable。
- §9 八项保持：FSRS/kind seam、mastery/calibration、历史作答判分、OCR 字符抽取、
  提议确认撤销、pedagogy/today、日志费用导出备份、housekeeping 时区语义均无改动。
  新 search/read/check 仅由 practice manifest 注册 read 面，mirrorEvent=never；
  store_sourced_question 的 ingestion 实现与注册不变。

## 测试与行数

只保留一份真实 agent 工具 + PostgreSQL 边界套件，共 6 cases。没有 ref/RRF/cursor
内部 helper 单测；embedding/solution provider 是唯一 fake。

1. 硬过滤不能绕过：admitted/active/source/kind、withdrawn 排除、显式 within_refs
   空范围与精确范围、非法 cursor 拒绝；缺库 coverage.verdict=none，完整回显
   query/scope/count，零放宽、零填充。
2. ref 不偷换：编辑后仍读旧版，新版另列；错 digest/无法解析/撤回明确错误；
   within_refs 的历史版本明确拒绝，不偷换 current。
3. 材料覆盖诚实：缺图 incomplete；存在且 bare SHA 匹配 prefixed digest 的图完整。
   保留正反两支是为了分别捕获隐藏缺图与前缀导致的虚假缺图。
4. 学习者隔离：真实 PostgreSQL role 只允许 SELECT 四个 bank 表，不能读 learner
   表或写任何表；执行三工具后比较完整 event/FSRS 行，不仅比较行数。
5. 内容变更后旧向量不能恢复：embedding provider 持有旧输入期间，真实 reference
   backfill 提交新内容；旧向量 CAS 写入拒绝，search 不再召回旧向量。
6. 不扩大 claim：确定性 current 正常 supported，任意 claim/非法断言为 unknown。

行数按 `git diff --numstat a7b838b06a3e8bd86b0eb5626487a378e538099e` 计算；
测试含 fixture，以 `.test.`/`.spec.` 文件计；产品计 src/server/web/scripts 下非测试
TS/TSX/JS/JSX/JSON/SQL 文件；文档与 vitest 分区配置不计产品。
- 新增测试 **490 行**；新增产品 **2085 行**；测试/产品 = 23.5%，满足测试不超过产品。

## 验证回执与开放项

- typecheck、lint、build、test-policy、partition、capability-boundaries、
  architecture-deepening、provider-lanes、provider-attempt-truth、question-writers
  在最新修复后通过；lint 有 172 条既存 warnings，无 errors。
- 相关 scoped unit：tool-result-snapshot 与 tool-activity，2 files/2 cases PASS。
- Sol xhigh read-only 检查仅算同模型 self-check，发现上述 CAS 与 SHA prefix 两个 P1，
  均已修复。独立 review 由 Coordinator 固定 head 后安排 Claude Opus，不冒称独立审查通过。
- DB 6 cases 尚未运行；只在 Coordinator 明确 start + baseline 的窗口执行，不 prune，
  不操作他人容器。固定 head/命令/6 cases 单条请求由 t3_thread_send 发送。
- migration ref 映射确认、跨模型独立审查、协调 DB 验证与 exact-head CI 尚未完成；
  无真实 provider/浏览器/部署/学习效果证据。不开 PR。
- Linear capture：查重确认现有 YUK-1448 In Progress 覆盖本 LIGHT 修复与验收；本轮
  无需另开重复 follow-up，未将整体题源能力标为 Done。

## Owner 23:01 缺口与供题连接验收

- search_bank.coverage.verdict = enough / sparse / none，衡量本次召回候选池是否达到
  请求 limit，不能代替 agent 核验全部语义要求。requirements.not_verified 始终披露
  未证的语义与全库穷尽性；通道不可用/截断也分别披露。
- sparse/none 时 unsatisfied_constraints 完整保存 query、subject/kind/source/
  draft/admission/within_refs 的组合与 requested_count/retrieved_count；不声称每个
  约束单独无解。无放宽 SQL 过滤、无填充候选；向量召回也施既有 matcher 的
  MATCHER_COSINE_MAX_DISTANCE=0.35 防远距离向量填数。该阈值尚无本产品实际输出
  校准证据，不冒称相关性验收通过。
- gap_request 目标为 EvidenceDemandV1，直接复用其 schema 片段：
  claim.kind=content_coverage、claim.statement=query、inventory_goal.eligible_count=limit、
  causes=[coverage_gap]，保留完整 unsatisfied_constraints。
  它明确是需要 agent 补充上下文的 seed，不伪装成已立单/已派发。
- 映射还需 agent 补齐 demand_id/policy_version/subject_id/claim.knowledge_ids/
  evidence/task/difficulty/inventory_goal.horizon_days/control；这些不是检索工具应替
  agent 决定的教学、时限或费用。version=1，补齐后用 EvidenceDemandV1.parse 校验。
- 已核全部 capability manifest 的工具注册、kernel allowlists 与工具输入：没有可
  提交 EvidenceDemand 的现有 agent tool。store_sourced_question 仅接收已获题目的
  candidate + optional demand_id/supply_trace（tools/store-sourced-question.ts:88-99），
  author_question 的 demand 是生成任务内部对象，均不是缺口台账入口。
  question_supply_nightly/supply_planner 是 jobs，不是 agent 可调用的缺口提交工具。
  现有 dispatchSupplyTarget/dispatchSupplyTargets 是 server owner service，输入
  QuestionSupplyTarget，不能将不完整 seed 直接传入。

**minimum missing link: a tool that files a gap**

Prerequisite contract（仅说明，不在 LIGHT 新建子系统）：agent 提交稳定 request_id、
完整 EvidenceDemandV1（claim.kind=content_coverage）与 search 的原样 constraints /
coverage 证据；服务端校验 subject/KC、预算/截止/用途和 hard constraints 可表述性；
经既有 supply target/dispatcher owner seam 幂等登记/派发，返回 demand_id、
filed|already_filed|blocked、dispatch/producer receipt 或明确 blocked reason。
不能丢弃 within_refs/source/kind 等限制后宣称已受理；不能直接写 question、改 learner
state 或绕过 store_sourced_question。未知结果需稳定 ID 重读，不盲重试付费动作。
Coordinator 排期为验收 prerequisite；没有此链接不能称端到端缺口供题验收完成。


## 2026-10-12 Cloud 接续与验收边界

### 固定来源与修复

远程 `feat/bank-tools-light` 实时核验为 `40777e5e970f40833c0779693cc808d0850d5e0f`，无 PR。
原 Mac 工作区未访问。当前 main `8fb160ed517c85a56cabbebfe1f1a19f137e4639` 与旧分支分别
独有 9 / 6 个提交；在原分支正常 merge，合成提交 `755919dd45f3a862e5e16d0b4c59b6489f050bb5`，
无冲突、无 rebase/force。没有纳入 #1703 的录入改动或 #1700 的学习者大脑候选。

本轮修正：

- 原 cursor 每次重算 live pool 违反提案 §5 的同一快照要求；现按上文 v2 续读原池，变化显式过期。
- `admitted` / `is_servable` 原先只检查 lifecycle，会把冻结计划仍需人工判分的旧题误报可服务。
  现经 `readAutomaticallyServableQuestionIds` 对实际小题逐一复核，返回
  `automatically_servable_part_ids`。单 ref 的 `check_bank` 可用 `params.part_ids`
  指定小题；必须全部在可判集合中，未知 id 不通过。不要求同组无关小题全部自动可判。
  未指定 part_ids 时，只判断该候选是否至少有一个可判小题，响应明确此窄结论。
  真正发给学习者的每个小题仍由正式 issuance 闸门校验。旧审计“自评 ≤20% / 或标自评”
  不适用于当前 100% 自动可判要求，未引入自评兜底。
- 首次 DB 运行 5/6：首例 fixture 的 reference/choices 均空，发布已正确 withheld；补成
  有选项与答案的真实可判 fixture，未放宽生产闸门。保留原失败日志。

### 当前目标存储的 ref 映射

`qrev1` 直接解析当前目标 `question_revision.revision_id` 与同一行不可变 digest；
`question_group_lifecycle.current_revision_id` 只用于状态说明，不作为失效 ref 的替代。
`scripts/migration-apply.ts:loadRevisionContracts` 也精确读取 registry 声明的 revision_id，
不存在时拒绝；两入口指向同一目标存储身份，无需另造 alias/wrapper。

历史 `question.id` 本身不含版本，不可转换成一个猜测的 current ref。
`src/core/migration/apply.ts:RevisionRegistryEntry` 的 v2 occurrence/snapshot 绑定先解析
`revision_id + part_ids + slot_id + scoring_unit_id`，再从已存在目标行编码 bank ref。
其 `snapshot_verified` / `question_asserted` 证据级别保持原样；缺 registry 或目标行仍 unresolved。
这只是当前源码映射核对，不代表跑过真实语料迁移，也不代表未来存储重键已完成。

### 权威设计、实现、证据逐项对应

| 设计要求 | 本分支真实入口与范围 | 本轮证据 / 剩余验收 |
| --- | --- | --- |
| ADR-0072 D1/D6 找本地题库候选 | practice manifest 注册 search_bank；SQL 硬过滤、FTS + pgvector RRF、有限池 | 6 个 DB case 中硬过滤/版本/CAS 通过；向量 provider 用 fake，相关性未验收 |
| D2 不可变 ref 与搜索续页 | qrev1 → 当前目标 revision；within_refs 仅当前版；v2 原池续页 | 修改后旧 ref 仍读旧内容，未知/digest/撤回明确错误；续页重放稳定，新题不插队，池变化报错 |
| D1 read 完整契约的 LIGHT 子集 | read_bank 只接受已发布 revision refs + include；读取冻结文本/评分层与已有资产记录 | 材料缺失/digest 不符诚实返回；**未实现原始材料获取、未发布草稿正文、图像解码、长内容分页/focus**。search 可列无 ref 的草稿卡片，不能据此声称 read 可读草稿 |
| D5 确定性检查 | check_bank 四类记录/纯校验器检查，无模型语义检查 | unknown 不偷换 claim；可判范围按选定小题复用正式 gate。资产记录存在不等于已下载/解码字节 |
| D4 learner 隔离 | 三工具只读 bank 数据；学习者读取保留 get_question_context | 真实 PG 受限角色与 event/FSRS 完整行前后比较通过 |
| D1 注册与取代 | 既有 capability manifest 被现有 Copilot 组合根消费；query_questions 删除 | Copilot 接线已在源码中；**备题员独立任务、Start/DBOS 新注册及学习者 UI 同 ref 展示未交付** |
| 缺口进入供题链 | sparse/none → 完整 constraints + EvidenceDemandV1 seed | **未立单/未派发**。现有 target/dispatcher 不能完整承载 query/source/within_refs 等约束；供题 owner 须先确定受理契约，再接真实幂等写入口，不能丢约束报成功 |
| 本地与外部找题准确度 | 本分支只做本地 bank；既有外部路径为 supply_execute → jyeoo/web candidates → store_sourced_question → source_verify | 本轮未调用付费 provider/外部找题，未访问真实 DB。旧来源抓取/去重证据不能代替当前相关性、难度或自动判分验收 |
| 提案 §12 与 owner 23:01 比较 | 同快照、同任务比较旧工具 / search+read / search+read+check；42 种子 + 真实需求；盲评相关性、难度、可判性及工具次数/重复读取/耗时费用 | **未跑**；本轮 DB 不变量通过不能宣布找题准确度或整体 LIGHT 产品验收通过。Coordinator 继续沿原预注册口径组织，未新增评估体系 |

本轮沿原 6 cases，未增加测试矩阵；选定小题与续页边界补在原有准入/版本 case。
本地 typecheck、lint（172 既存 warnings）、build 及本分支相关 audits 通过。
能力边界为 429/0/48：相对 main 的 +1 embed owner edge 是恢复分支已有变更，本轮未再增 baseline。
独立只读初审固定合成提交 755919dd，确认 serving P1；修复后的验证审与 exact-head CI
见本轮最终交付回执。历史 Sol self-check 不冒称跨模型审查；本环境未提供 Claude Opus，
本轮独立审查为独立 agent，不能称旧计划要求的 Claude Opus 跨模型审查已完成。

PR 保持 draft，不 merge/deploy。共享 PLAN/.remember/Linear 由 Coordinator 更新；
本轮不重复建票，题库工具/实际质量/缺口写入未关闭 YUK-1448。


本轮独立审查回执：初审 `755919dd` 发现 lifecycle-only serving P1；唯一验证审
`fc231d92` 确认小题粒度/cursor 修复，并指出 ref 与准入分次读 live current 的并发 P1。
随后 search/check 的全部 bank 查询改为同一个 **READ ONLY / REPEATABLE READ** 事务，
embedding 与 provider-attempt 费用记账在事务外完成，cursor 仍不调用 provider。
原隔离 case 增加真实 PG RLS 策略：只允许上述事务中的 revision 读取，若工具或 helper
逃逸到事务外，实际 search/check 断言失败。预算内两轮审查已用完，不开展第三审；
最终修复由作者定向复核、原 6 cases 和 exact-head CI 验证，未冒称审查在最终修复后再通过。
