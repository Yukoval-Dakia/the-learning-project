# YUK-1568 第 3 片（首个 consumer）：sourcing 候选接统一草稿/提交链

2026-10-19。Refs YUK-1568（K1 答案语义迁移）、Refs YUK-1496（统一评估契约）、
Refs YUK-1559（C1 准入双解）。前置已合入：S1 #1812（answer_shape/blank_order
声明 + roundtrip + 中央再发布保护）、S2 #1815（共享 blank 比较器）、
YUK-1468（统一 edit_question / submit_question 领域服务）、YUK-1552（URL 归
一化判重）。本片是 S3 四个生产面迁移的**第一个可独立交付 consumer**：
`sourcing_web` 供给候选。不自称完整 K1、不自称七题已修。

## 原问题

`SourcingTask → web-candidates → candidate submit` 的落库终点是
`insertSourcedDraft`（flat insert）+ `publishQuestionGroupFromRow`（行归一重
建契约）。在这条旧链上：producer 即使能描述小问/槽位/答案对象也没有任何
字段可写；行归一从 flat 列反推契约，answer_shape / blank_order / parts /
units / 材料绑定无处承载；「flat 行是真相」与 K1「冻结四层契约是真相」
直接冲突。继续让 sourcing 走旧 writer 意味着新生产端仍在生产不可声明的
flat 行，K1 迁移永远追不完。

## 最终行为（本片落地）

### 声明面（producer 侧）

- `SourcedQuestion` 增加可选 `parts: DraftPart[]`（`src/core/schema/sourcing.ts`）
  ——直接复用 `question-draft` 的 `DraftPart`，answer_shape 经
  `DraftBlankSpec`、blank_order 经 `DraftPart` 携带，**不另造评分或 schema
  体系**。字段缺省 = 未声明候选（旧行为完全不变）。
- `SourcingTask` prompt（`tasks/sourcing.ts`）教可选声明与缺项纪律：题意
  有根据才声明；缺小问/缺单位/缺分值/缺槽位保持显式缺项（提交侧按未决
  withheld），禁止猜分隔符、推分值、吞证明小问、盲删选项字母或用
  regex 猜结构。malformed parts 使输出 parse 失败（fail-loud），不会被
  Zod strip 后当无声明继续。
- `web-candidates.ts` 零改动：`{...q, knowledge_ids}` 原样透传 parts；
  flat 字段（prompt/reference/choices/rubric）仍是 dedup/hash/extract 锚点。

### 提交面（candidate commit seam）

`tools/submit-question.ts` 的 `runCandidateSubmit` 在全部 guard 之后分流：

```
SourcingTaskOutput.parts 有声明
  → declaredCandidateDocument: DraftPart[]（sanitizeSourcedMarkup 清洗展示
    文本与文本答案键——与旧 flat 入库同口径、确定性、不改语义；结构/id/
    answer_shape/blank_order 逐字保留，不重铸不推断）→ QuestionDraftDocument
  → saveDraftEdit(request_id:`${req}:save`)
  → submitDraftQuestion(request_id:`${req}:submit`,
      expected_draft_version=save 回执版本, expected_revision=null,
      sourced={canonical_content_hash=flat 指纹, created_by=路由 ref,
               difficulty, metadata={web_sourced provenance, source_ref_kind,
               difficulty_evidence, route meta, hints, attribution, demand,
               supply_trace(折叠), vector hold, markup flag},
               supply_trace(透传 verify intent)})
  → 同事务：question 行 + publishQuestionGroup + verify_dispatch_intent +
    回执 → post-tx dispatchPendingVerifyIntents + canary event
```

`sourced` 是 `SubmitDraftInput` 新增的**可信系统注入**（仅新组首次提交有
效；编辑已发布组携带即 `invalid_request` 冲突 + 回执）。它解决三类事实：

1. `canonical_content_hash`：typed 契约的 `draftCanonicalIdentity` 投影对
   选择题等会改变 reference 文本（letter 键），若用投影哈希会和既有
   flat 行的 dedup 指纹失联——注入 flat 指纹保持同一 dedup 口径（insert
   列值与 merge claim 都用它）。
2. `web_sourced` provenance（含必填 `extract`）/`difficulty_evidence`/
   `created_by`/`difficulty`/向量近重 hold：`source_verify` 的
   `checkSourceConsistency` 等确定性核对从行 metadata 取 extract——这些
   必须与发布同事务落行（分步写入会被已派发的 verify 读到缺失态）。
3. `supply_trace`：不透明透传进 `verify_dispatch_intent` 行（supply 账本
   归属），与旧链 `writeVerifyDispatchIntent(supplyTrace)` 同口径。

声明缺项（无 key/points/槽位/material）→ `draftDocumentToContract` 记
conversion_issues → 提交返回 withheld（不铸 revision），草稿保留可修，
候选如实 `withheld draft_unpublishable` 回报——**不回退旧 flat 解释器
补全**。

### verify 面（同 revision 生命周期，P 处置）

`source_verify.ts` 新增 `publishVerifyLifecycleUpdate`：

- 未声明组 → 逐字走 `publishQuestionGroupFromRow`（旧行为不变）。
- 已声明组 → `loadQuestionGroupContractSnapshot` 取冻结四层契约 →
  `publishQuestionGroup` typed 发布：`expectedCurrentRevision` 钉住声明
  revision、`expectedAdmissionGeneration` 钉住锁后 generation；同 digest
  ⇒ 不铸新 revision、声明字节级保留；CAS/发布冲突一律抛错回滚同事务
  （与 FromRow fail-closed 同款纪律）。
- 接入 3 处 callsite（transient suspend / 正向 promote / fail-suspend）+
  `verify-and-promote.ts` owner-override 分支。核验通过只翻
  admission/suspension/verification 维度——**不授予 K1 admitted**；
  admitted + 声明仍过 `publishQuestionGroup` 的判分就绪闸（owner override
  原权限与 manual evidence 不变，不可判声明 ⇒ 拒发回滚）。
- C1 admission 守卫分支本就以当前 revision 层走 typed publish，无需改。

### seam 一处修正

`submitDraftQuestion` post-tx verify 派发原按 `receipt.status==='pending'`
门槛——新题 receipt 恒 `'withheld'`（admission withheld + verifyEnqueued）
→ intent 落库却从不即时派发（要等 worker 启动 recovery）。改按
`verify_enqueued === true` 判别：intent 写了就即时派发，失败留 durable
intent。与旧 flat 链的即时核验等价。

### flat writer 守卫

`insertSourcedDraft` 加 `assertNoDraftDeclarations` fail-closed：携带
parts 的候选撞进旧 writer 直接抛错（不静默吞声明）。jyeoo_fetch 及未声明
sourcing_web 候选照旧全走旧链——**旧 writer 未为新声明扩展**，只保旧无
声明路径。

## 保留 / 删除清单

| 项 | 处置 |
|---|---|
| KC 活体校验 / 外源 host 校验 / exact hash merge / 一页一题 URL claim（含 raced release）/ n-gram near-dup / 向量近重 hold / staged 资产 cleanup / demand-attribution | 全部原序保留（判重先于分流执行） |
| `web_sourced` provenance（url/title/fetched_at/whitelist_match/extraction_hash/extract）、`difficulty_evidence`、`supply_trace`（折叠进 metadata + intent）、`created_by`/`difficulty`、`canonical_content_hash`、`attribution_state`、route meta、`prompt_image_refs` | typed 路径经 `sourced` 注入同事务落行 |
| request claim/replay（外层 requestId + 派生 `:save`/`:submit`）、availability、draft_status='draft'、durable verify intent + 即时 dispatch、canary `experimental:submit_question` 事件（+draft_block_id） | 保留 |
| `judge_kind_override` / `rubric_json` / `structured` 行投影 / `kind` 标签 / `image_refs`/`figures`/`staged_asset_ids` | 不注入：typed 契约是权威（judge_kind_override/rubric_json 单值无法如实描述多 unit；structured 列改由 `draftDocumentToStructuredQuestion` 投影；kind 由 `deriveKind`）。声明+图像资产同现显式 `invalid_request`（本片不承载资产绑定，不静默降级） |
| `insertSourcedDraft` + `publishQuestionGroupFromRow` 对已声明候选的 flat insert+row publish | 删除（该分支不再存在）；旧 writer 仅保留给未声明 caller + fail-closed 守卫 |
| embed 向量戳 | 保留为 post-submit 投影更新（只写 embed_* + updated_at，hash 对齐行内投影文本；未命中/失败由 nightly backfill 兜底，等价旧 abstain） |

## 事务与重放（如实）

- 分段（不谎报跨步原子）：`raced URL claim` → `saveDraftEdit 内 tx` →
  `submitDraftQuestion 内 tx`（锁 draft、契约转换、admission 检查、行
  insert、publish、verify intent、回执）→ 可选 embed 更新 → 外层候选
  回执 tx。save 与 submit 是两笔事务：submit 失败留下可恢复的
  question_block 草稿（与 edit→submit 工作流同语义）。
- 派生身份固定 `${requestId}:save` / `${requestId}:submit`：崩溃重试时
  save 幂等重放同一 draft_ref（不铸新 draft）、submit 重放回执（不重复
  发布）；外层 requestId 指纹照旧含整个候选（含 parts）。
- submit 指纹绑定 `sourced` 的**身份部分**（hash/created_by/difficulty），
  `metadata` 含 attempt 时间戳（fetched_at 等）不进指纹——否则重试必漂
  移成 request_id_reused。
- `expected_revision:null` + `expected_draft_version=save 回执版本`：新组
  的 CAS 双令牌。
- 冲突后果：`duplicate_exact`（seam 内 merge claim 复用同一去重原语）、
  `duplicate_source`（raced claim）、`near_dup`、`*_cas`/`publish_conflict`
  原样透传；compat `executeStoreSourcedQuestion` 对非五元组 reason 如实
  透传（detail 同载），与既有放宽同例。

## 第一天能用

- 未声明候选（含全部 jyeoo_fetch）：行为逐字节不变。
- 已声明候选：producer→candidate→draft→submit→withheld revision（声明进
  冻结契约、参与 integrity digest）→ durable source_verify intent 即时
  派发 → `draft_status='draft'` + withheld `unverified_rules` pending
  来源核验 → source_verify 正向 promote / hold / suspend 在同 revision
  上翻生命周期（声明字节级保留）→ C1 准入链照常接。
- declared answer_shape 的可判性由 S2 `declaredBlankGradeReadiness` 闸管；
  不可判声明 ⇒ 只能 withheld，绝不回退普通 exact 判分或直接 admitted。

## 明确不在本片 / 剩余 consumer

- `quiz_gen`（jobs/quiz_gen.ts FromRow）、`ingestion`（image-candidate-
  accept / assessment-capture / auto-enroll / import-completion /
  legacy-record-appliers / mistakes）、`proposal-appliers`（#1797 占用）、
  `write.ts`/`parts.ts`/`serving-actions`/`solution-generate`/
  `intervention-diagnostics`/`probe-lifecycle`/`quiz_verify` 其余 28 调用
  点处置：后续 slice，父协调。
- declared + 图像资产（staged/figures/structured/image_refs）的 typed
  承载：本片显式拒绝，后续按需扩（不许静默降级）。
- shared submit 的 source-URL/跨 KC 向量去重泛化（YUK-1569）：本片只保
  本 candidate 现有 guard，未扩为修 1569 全部入口。
- 存量 40 题 / 七题验收 / 存量重新发布（YUK-1573 冻结）：第 4 片独立方案。

## 验证（本机实际执行）

- `pnpm typecheck` exit 0；`pnpm lint` exit 0（179 条预存 warning，本 diff
  无新增）；`pnpm build` exit 0。
- audits exit 0：`audit:schema`、`audit:question-writers`（typed 写点均
  publisher-converged 或 exempt 列）、`audit:capability-boundaries`（债基线
  精确守恒 443/48，未新增 capability→server 边——facade 复用）、
  `audit:draft-status`、`audit:draft-status-reads`、`audit:partition`、
  `audit:profile`、`audit:test-policy`、`audit:task-census`、
  `audit:structured-judge`。
- `source_verify.ts` 2 条 `noUnusedImports` 为 base 预存（未因本 diff 新增）。

## NOT_RUN（未验证范围，如实）

- **runtime**：未跑 sourcing task / web-candidates / submit_question 真链
  路；producer→draft→revision 为源码路径推演。
- **DB**：未建库、未跑任何 DB 测试（owner 禁令）；事务/CAS/回执语义为
  源码推演非运行证据；声明 revision 的 hold/promote/suspend typed 更新未
  在真库跑过。
- **provider**：未调 LLM/embed/exa/jyeoo；向量近重/embedding 逻辑未实测。
- **browser/UI**：无 UI 改动。
- **七题验收**：存量 K1 七题不在本片范围（第 4 片）；未做 acceptance。
- **quiz_gen/ingestion 等剩余 consumer**：未迁移（见上节）。
