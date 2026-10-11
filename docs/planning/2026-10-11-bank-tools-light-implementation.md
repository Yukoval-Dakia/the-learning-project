# Bank tools LIGHT 竖切 — 实施记录（search_bank / read_bank / check_bank）

状态：**实施中分支记录**（feat/bank-tools-light）。日期：2026-10-11。
决策真相源：ADR-0072（D1–D6 + 硬边界 + 分阶段交付）与提案
`docs/planning/2026-10-11-question-bank-agent-tools-proposal.md`（接口细节真相源）。
本文只记录 LIGHT 落地时的工程决定；与 ADR/提案冲突处以 ADR/提案为准。

## 交付范围（LIGHT only）

1. `search_bank`：结构化硬过滤（subject / kind / draft / withheld-admission / source）
   + Postgres FTS 与暴力 pgvector 向量召回并行，RRF 融合；返回版本化 ref + 显式
   scope + cursor；候选卡片 + 覆盖诚实声明。无 result_ref。
2. `read_bank`：按 ref 批量取版本化内容；ref 无法解析 / digest 不符 / 已撤回 →
   显式错误，绝不偷换 latest；缺图缺材料如实上报。
3. `check_bank`：仅确定性检查（D5）：记录关系读取 + 已有纯校验器的确定性复算。
   无语义（模型）检查。
4. 面替换：删除 `query_questions`（与 search_bank 同职责）；`get_question_context`
   保留为 learner-state 读面（ADR-0072 未决问题 3 归学习者大脑线裁决，
   coach/dreaming/maintenance/ingestion_block_edit 继续原样读取）。
5. 同分支修 embedding 失效 bug：`solution-generate.ts` 直写 `reference_md`
   绕过 `editQuestion` 的 hash 失效路径 → 补齐按 revision + 内容 digest 的失效。

## ref 编码（本分支拍板，待 migration 线确认）

**格式：`qrev1:<revision_id>:<integrity_digest 前 12 位 hex>`**

- `revision_id` = `question_revision.revision_id`（不可变行主键，cuid 全局唯一）；
  `integrity_digest` = 同行不可变内容指纹（发布 seam 内重算强制，`sha256:<64hex>`），
  ref 携带其 hex 前 12 位（48 bit，防 ref 抄写/换target 错位）。
- 理由：ADR-0072 D2 明言 ref 指向 `question_revision`，不裸指向可变指针
  （`question` / `question_group_lifecycle`）。revision_id 是当前 schema 中最稳定的
  版本身份；digest 前缀提供无需查库的完整性校验，且在未来 migration 线重键
  （re-key）存储时，digest 仍可验证内容身份 —— 这正是未决问题 1 交给 migration
  线的输入。单题 = 1-part 组，question 与 group 共用组版本语法，kind 由
  parts/materials 派生，不进 ref。
- 解析语义（read/check 共用）：查无此行 → `unresolvable`；digest 前缀不符 →
  `digest_mismatch`（过期/错引，显式错误，绝不回退 latest）；lifecycle
  `withdrawn=true` → `withdrawn`（硬边界 3）。
- **已尝试通知 migration 线（thread 4bbfaeee-21f6-462e-b358-a012f9c96b4c）
  确认；本 session 无 T3 传输（t3_thread_send 不可达，见交付报告），本文即
  确认请求的书面形式。**

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
- cursor：base64url(JSON{v,q,scope,limit,offset})，只续同一次检索（fingerprint
  不符 → 显式错误）；池为重算非快照，翻页间库可能变化 —— ref 版本化保证已
  返回项不漂移，工具描述如实声明。

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
| `ref_state` | ref 是否当前版/可服务（current/superseded/withdrawn/suspended/admission） | record_lookup |
| `contract_valid` | 对已存版本四层重跑发布期纯校验器（validateStructure/ResponseSpec/ScoringBasis） | deterministic_recompute |
| `material_assets_present` | 二进制材料资产在场且 sha256 与版本 digest 一致 | record_lookup |

自由文本 claim 不做解释（忠实归一化不了 → unknown + 支持类清单），与 D5 一致。
注：`contractIntegrityDigest` 用插入序 JSON.stringify，jsonb 读回不保序，无法
从行值重derive 存量 digest —— 「重算 digest」不作为检查项，`contract_valid`
以重跑校验器代替（同一发布闸的确定性子集）。

## 测试

- 单测（fast partition）：ref 编解码/解析语义、RRF 融合、cursor fingerprint、
  check 目录的纯解释层。
- DB 测试（db partition，**本分支未运行** —— 共享 Docker host 需协调窗，
  本 session 无法联系协调线程，交付报告如实列出；CI Gate 将在 push 后执行）。
- 查询嵌入一律确定性 fake；真实 provider 调用为零。
