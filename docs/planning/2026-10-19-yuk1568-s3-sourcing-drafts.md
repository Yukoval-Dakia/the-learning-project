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
               supply_trace(透传 verify intent),
               source_claim={source_url, actor_ref}（R1 F3：一页一题 URL
               终态 claim 与 INSERT 同 tx）})
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

### verify 面（同 revision 生命周期，P 处置；R1 F1+F2 修正）

`source_verify.ts` 新增 `publishVerifyLifecycleUpdate`：

- **权威选择（R1 F1）**：凡组当前有已发布 revision，该冻结四层契约即
  唯一内容权威——typed 候选（含不携 answer_shape/blank_order 的普通
  parts）的 points/规则/unit 身份不在 flat 行投影里，FromRow 重建会丢；
  对行归一发布的旧组，冻结层与行归一产物须经现役 publisher 的同一
  canonical seal 后比较。**只有从未发布的真 legacy 组**（current_revision_id
  为空）走 FromRow。不再按「有没有数学声明」分流。
- **核验输入绑定（R1 F2 的快照修复，R2 后补内容权威）**：`runSourceVerify` 起点用**一条
  SELECT**（`question` ⋈ `lifecycle`(coalesce(parent,id)=group_id) ⋈
  `question_revision`）取行 + 组身份 + 冻结 revision——同一语句快照，
  行内容与 revision/generation 身份不可错位拼装（原实现分读会拼出
  旧行+新 revision）。组已发布时先用现成
  `normalizeQuestionRowToContract` 对同快照行重建完整契约，再经
  `publishedContractSeal(...).canonical`（与现役 publisher 完全相同的封存）。
  只有该 canonical digest 等于冻结版且行 image_refs 全属于冻结 figure 材料
  才复用 legacy 输入。text/numeric/structured 槽因此保留原来的
  checks/solve/grounding，不经过草稿编辑器的 unmapped free 兜底。
  rubric、reference、judge 意图、材料与 structured 内容由发布归一的
  完整 digest 证明归属；structured 归一可能优先读叶答案/选项，所以
  额外检查 flat verifier 实际读取的 reference 字节与 choices 也在冻结
  材料/槽中，不能借叶内容掩盖被忽略的旧 flat 列。figure digest 仅复用冻结值重建归一输入，
  不假称重新查询或验证资产。solver 图片 id 从冻结 figure 材料取得，
  未封存的行级 bbox/placement 不作 figures_hint。
  不满足证明时，核验输入从**该 revision 的投影**构造（`revisionToDraftDocument` →
  `draftCanonicalIdentity` → `deriveKind`，与共享 submit 写行同一组
  原语，经 seam→tools 既有边再出口，零新增 capability→questions 债）；
  显式清空旧行 `rubric_json`、`judge_kind_override`、`structured`、
  `image_refs`、`figures`。例如 key A→B 的 withheld 编辑即使行 rubric
  仍是 A，也只把冻结 B 送入真实 solve comparison；旧私有 rubric/解析
  不得优先于冻结选择键。行只供来源级 provenance
  （web_sourced/source_ref/metadata）与 plumbing（id/version/draft_status）。
  所有有 revision 的分支均不把未封存的 metadata 答案/解析提示送给
  solver；来源证据和 KC 校验仍用行账本。无 revision 的真 legacy 组照旧行输入。
  KC 归属取行（组/行级账本，不在 revision 层）。
- **有损形状付费前 hold**：未通过上述 legacy 一致性证明时，投影对核验输入残缺（多 part/unit/slot 边界、scoring unit 多
  slot_refs、slot kind 不可映射 `unmapped_slot_kind`、多 select unit
  残缺 choices、select 键引用 spec 外 item、未投影材料/证据/非标准 presentation，
  或非选择键的私有评分材料；选择键仅可忽略已具名的私有 rubric/解析），只落
  `structure_completeness` fail（reason 具名），不跑确定性检查不花
  solve/grounding——fail 走既有 demote+verify_hold 路径，编辑改形状后
  可重验恢复（不封死 typed sourcing 可用面）。
- **标准展示可达（父定向核验后的更正）**：不再按 `presentation != null`
  整类 hold。复用 `defaultPresentation` 对冻结四层契约生成标准树，只接受
  stack 内 `text_math(part_ref)` + `option_list` / `blank_input` /
  `free_area`；再用 `publishedContractSeal` 比较实际冻结树与标准树的
  canonical 封存。所有 block/ref/bind/顺序/配置都必须相同（包括 part、
  slot、unit 身份）；jsonb 对象键序不影响比较。标准 select/blank 没有
  额外材料时可进入检查/solve；custom、material_ref、额外图文、改绑、
  增删块或非标准树不相等，仍付费前 hold。默认生成器可生成的
  matching_columns/ordering/break_tap 也不在 flat 可表达白名单内。
  此展示闸同样约束 legacy 复用分支，不因 row digest 匹配绕开 custom
  展示。公开材料/figure/证据的独立闸继续保留。
- **应用侧不变**：helper 锁后比对 expectedRevision/expectedGeneration
  （快照值=被验 revision），漂移抛错回滚；行版本检查、C1 独立证据、
  promotedElsewhere 语义原样。覆盖 transient/passed/failed/override；
  C1-kept 由主事务漂移闸覆盖。owner-override 的行依据+lifecycle 身份
  同样一条 SELECT 快照（不虚构 solver 证据）。
- 撤回语义保留：全部子 part tombstone ⇒ `archiveGroupLifecycle`（与
  FromRow 同款，declared 组不再被归一前先冲突拦死）。
- 核验通过只翻 admission/suspension/verification 维度——**不授予 K1
  admitted**；admitted + 声明仍过 `publishQuestionGroup` 的判分就绪闸
  （owner override 原权限与 manual evidence 不变）。

### URL 判重（R1 F3 修正）

最终 raced `claimHttpSourceDuplicate`（onTerminal:'release' + KC merge
原语）移入 shared submit 的新组 INSERT **同一事务**——经
`SubmitDraftInput.sourced.source_claim`（可信系统字段，不在 tool wire
schema、仅新组首提交生效）传入，seam 内在 exact-merge 之前执行。
`pg_advisory_xact_lock` 持到提交：并发同页候选串行化，后到者锁后重查
命中 → `duplicate_source` 冲突 + 回执。早段 `defer` 预检与旧 flat
persist 路径原样保留；原语经 `capabilities/practice/public.ts` 单项
re-export 给 server/questions consumer（既有 server→capability public
先例同形）。

### embed 戳（R1 F4 修正）

typed 路径不再用「stored 投影 vs stored 投影」的自洽假戳：
`ingestVector` 绑定的是 fetch 时实际送 embed 的 flat `questionText`；
只在行内投影与该向量真实输入逐字段一致时才复用（typed 投影常不等于
flat 文本——select 的 reference 投影成字母键）。写入时再以相同内容
CAS（`canonical_content_hash IS NOT DISTINCT FROM`）防内容身份变化。
canonical hash 会归一 whitespace/NFKC/image URL，**不是 exact embed-input
hash，不能证明任意原始字节变化都使 CAS 失配**。同 canonical 身份的
原文漂移即使写入旧输入的 exact embed 戳，后续 vector validity 仍以
`hash_mismatch` 拒绝它。不一致保持未嵌入（abstain）——交既有 nightly
`embed_backfill` 按行内文本重算；本修复不执行 embed/backfill 付费调用。

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
| embed 向量戳 | R1 F4 修正：仅当行内投影与向量真实输入（flat questionText）逐字段一致才复用戳，写入 canonical 内容身份 CAS（非 exact 字节 CAS）；不一致 abstain 交既有 nightly backfill，本修复不运行付费调用 |

## 事务与重放（如实）

- 分段（不谎报跨步原子）：`saveDraftEdit 内 tx` → `submitDraftQuestion
  内 tx`（锁 draft、契约转换、admission 检查、**一页一题 URL 终态
  claim（R1 F3：与 INSERT 同事务持 advisory xact lock）**、exact-merge、
  行 insert、publish、verify intent、回执）→ 可选 embed 更新 → 外层
  候选回执 tx。save 与 submit 是两笔事务：submit 失败留下可恢复的
  question_block 草稿（与 edit→submit 工作流同语义）。
- 派生身份固定 `${requestId}:save` / `${requestId}:submit`：崩溃重试时
  save 幂等重放同一 draft_ref（不铸新 draft）、submit 重放回执（不重复
  发布）；外层 requestId 指纹照旧含整个候选（含 parts）。
- submit 指纹绑定 `sourced` 的**身份部分**（hash/created_by/difficulty/
  source_claim），`metadata`/`supply_trace` 含 attempt 时间戳
  （fetched_at 等）不进指纹——否则重试必漂移成 request_id_reused。
- `expected_revision:null` + `expected_draft_version=save 回执版本`：新组
  的 CAS 双令牌。
- 冲突后果：`duplicate_exact`（seam 内 merge claim 复用同一去重原语）、
  `duplicate_source`（seam 内同 tx URL claim）、`near_dup`、
  `*_cas`/`publish_conflict` 原样透传；compat `executeStoreSourcedQuestion`
  对非五元组 reason 如实透传（detail 同载），与既有放宽同例。
- verify 侧（R1 F2）：`runSourceVerify` 在核验开始冻结组 current
  revision + admission generation；`publishVerifyLifecycleUpdate` 锁后
  比对，漂移 → 抛错回滚整笔（pg-boss 重试后在新 revision 上重新核验），
  同 tx 的先写（demote / FSRS enroll / C1-kept 复核记录）一并回滚。

## 第一天能用

- 未声明候选（含全部 jyeoo_fetch）：保留旧生产入口；首次行归一 revision
  与同快照行一致时保留原来源检查、求解与 grounding 路径，不再被草稿
  编辑器不支持 text/numeric 的标记终态拒收。
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

## 验证（本机实际执行——逐命令如实）

### 父定向核验后更正（基线 `51967a6ee`）

撤回上一实现对标准展示与 legacy 兼容的完成声明：`51967a6ee` 的
`presentation != null` 会挡住标准 typed 来源题；且直接将 normalizer
的键序 digest 与现役库存 canonical digest 比较，不能证明 legacy
兼容。此次两处修正在同一 `source_verify.ts` 与本文内完成，不新增模块。

静态可达依据（无合成输入/函数演练）：

- **标准 typed select/blank**：`server/questions/submit-question.ts:417–433`
  的 `presentationForDraft` 在无显式布局时调用
  `core/schema/assessment/presentation.ts:951–1040` 的 `defaultPresentation`。
  本核验分支使用同一函数、同一冻结 structure/spec/scoring 生成标准树；
  普通选项/空的结果是 stack + part_ref 题干 + 同 unit/slot 的
  option_list/blank_input，属于白名单且 canonical 封存相同，因此不再
  命中展示 hold。通过其他既有无损闸后，冻结 prompt/choices/key 送入
  `checksForTier(2)` 与真实 `runSolveCheck`，不是仅解除 hold 后空答案 fallback。
- **legacy canonical 一致性**：`server/questions/sourced-draft-insert.ts:217–227`
  调用 `publishQuestionGroupFromRow`；`kernel/records/assessment-publication.ts:1256–1259`
  以 `normalizeQuestionGroupToContract(root, liveParts)` 构建输入；无物理
  parts 时 `assessment-normalization.ts:861` 直接返回
  `normalizeQuestionRowToContract(root)`。publisher 在
  `assessment-publication.ts:789–803` 调用 `publishedContractSeal` 并取
  `seal.canonical`，`:989` 原样写入 revision.integrity_digest。本修复
  也对同快照行归一结果调用这一 `publishedContractSeal(...).canonical`。
  其实现 `assessment-normalization.ts:1023–1048` 对同四层/可选展示
  做同 schema parse + stable key JSON + SHA256；未另写 digest 算法。
  旧的 `contractIntegrityDigest` 仅是 normalizer 提交时兼容 seal，不能
  直接与现役 canonical 库存比较。图片 digest 仍取该冻结版资产输入。
- **旧 rubric A / 新 key B**：canonical 封存覆盖 scoring_basis 的真实键，
  从旧行重建的 A 不等于冻结 B；转冻结投影后 rubric/override 仍明确置空。
  新标准 presentation 放行不恢复旧 rubric 优先权，不提前修改工作行。

本次全量日志独立保存（上一记录原样保留）：
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1568-s3-20261019/r2-fix-codex-logs/presentation-canonical-YpZK0h/`。
中断后的进程核对：原检查 session 均已不存在，`lsof` 确认原日志无进程
占用，源码 SHA256 仍为
`1cc8a9202fba158b96c1f78b8e8141f811a40ef96855a9d0becb931a52cb0064`。
原 lint 与 question-writers 已取得 exit 0；原 typecheck/build/capability
audit 的最终退出码未取回，不计作最终通过（原日志保留）。仅后三项
另启 `*-resumed.log`，并将实际退出码保存到同名 `.exit`，无并发重复。
最终结果（实际进程退出码）：

| 命令 | exit / 完整日志 |
|---|---|
| `pnpm typecheck` | 0 / `typecheck-resumed.log` + `.exit` |
| `pnpm lint` | 0（179 warnings）/ `lint.log`（中断前已取得退出码） |
| `pnpm build` | 0 / `build-resumed.log` + `.exit` |
| `pnpm audit:capability-boundaries` | 0（443/48 不变）/ `audit-capability-boundaries-resumed.log` + `.exit` |
| `pnpm audit:question-writers` | 0 / `audit-question-writers.log`（中断前已取得退出码） |
| `git diff --check` | 0 |

`source-change.patch` / `source.sha256` 封存同一源码；中断后未再修改产品代码。
测试/断言/临时合成脚本（包括仅打印）、DB/容器/provider/runtime/HTTP业务/
浏览器/运营锁/stock 均 **NOT_RUN**。未新开 review/子代理；保持同 PR draft，
父继续定向核验与总看板/Linear 收口。

### R2 后首次实现的历史检查（基线 `93344bddc`，结果为 `51967a6ee`）

父随后确认本实现仍有上述标准展示误 hold 与 seal 算法差异，故以下
检查通过不构成功能完成；当前实现及证据以上节更正为准。

本轮只改 `source_verify.ts` 与本文；没有新投影模块，没有改
URL/shared submit/embed、owner override、双 CAS、row version 或 C1。
原 F1/F3/F4 保持父已确认的静态 closure。F2-R 与 N1 的上述修复为
源码路径说明，父负责定向核验；R1+R2 预算已用完，未再开 review/子代理。

本轮全量日志独立保存在：
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1568-s3-20261019/r2-fix-codex-logs/attempt-20261019-codex/`。
最终命令结果见下表；下节 R1 表仅是历史证据。

| 本轮命令 | exit / 日志 |
|---|---|
| `pnpm install --offline --frozen-lockfile --ignore-scripts` | 0 / `install.log`（仅准备新树依赖，无 lockfile 变更） |
| `pnpm typecheck` | 0 / `typecheck-sealed.log` |
| `pnpm lint` | 0（179 warnings）/ `lint-sealed.log` |
| `pnpm build` | 0 / `build-sealed.log` |
| `pnpm audit:capability-boundaries` | 0 / `audit-capability-boundaries.log`（443/48 不变） |
| `pnpm audit:question-writers` | 0 / `audit-question-writers.log` |
| `git diff --check` | 0 |

保留 `lint.log` 首轮 1 个格式错误及 179 warnings 的失败记录；仅格式修正，
后续 `lint-final.log` 已 exit 0（179 warnings）。`typecheck.log`、
`typecheck-final.log` 与 `build.log` 均 exit 0；最后一次材料闸收紧后再跑
sealed 三检查，以其结果为最终证据。源码封存在 `source-change.patch` /
`source.sha256`。没有新的可执行 follow-up 超出这两项父已确认问题；
Linear/总看板与最终验收继续由父线程统一维护，本 writer 不扩 ticket 范围。

没有编写或运行任何测试、断言、临时测试脚本、合成输入或 inline eval。
DB/容器/provider/HTTP 业务/浏览器/运营锁/stock/实际 sourcing 与 grounding
均 **NOT_RUN**；没有 merge/deploy，也不声称运行验收。

### R1 历史记录

R1 修复轮（两轮 fix commit：`fc6d15804` F1/F3/F4 + 本 commit F2 真收口）
的终态检查全量日志落协调目录（非 tail 截断）：
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1568-s3-20261019/fix-check-logs-f2-closure/<cmd>.log`
（工作树内镜像副本 `/tmp/yuk1568-s3-f2-closure-logs/`；前轮
`fc6d15804` 日志在 `fix-check-logs-398520032-r1fix/`）：

| 命令 | exit |
|---|---|
| `pnpm typecheck` | 0 |
| `pnpm lint` | 0（179 条预存 warning；`source_verify.ts` 2 条 noUnusedImports 为 base 预存） |
| `pnpm build` | 0 |
| `pnpm audit:schema` | 0 |
| `pnpm audit:question-writers` | 0（R1 修复中一度触发 UNRESOLVED_PAYLOAD 与 UNCONVERGED——分别改为字面量 `.set()` 与 `canonical_content_hash` CAS 后归零） |
| `pnpm audit:capability-boundaries` | 0（债基线精确 443/48 不变；`practice/public` 单项 re-export + facade 既有 public 边不构成 deep import） |
| `pnpm audit:draft-status` | 0 |
| `pnpm audit:draft-status-reads` | 0 |
| `pnpm audit:partition` | 0 |
| `pnpm audit:profile` | 0 |
| `pnpm audit:test-policy` | 0 |
| `pnpm audit:task-census` | 0 |
| `pnpm audit:structured-judge` | 0 |

- **如实撤回**：R1 前的回复中「全部 audit 已过」只对写日志当时的中间态
  成立；R1 修复轮改动后以本 HEAD 的重跑证据（上表）为准。
- **超范围记录（不算验收）**：R1 前作者曾以 `tsx -e` 内联调用
  `draftDocumentToContract` / `revisionToDraftDocument` /
  `QuestionDraftDocument.safeParse` 观察合成 doc 的声明往返——父已判定该
  执行超出 brief 允许的「typecheck/lint/build/只读查询」范围；此处仅保留
  事实记录（观测输出存在会话 transcript，无落盘文件、无断言、无 DB），
  不作为任何验证证据主张。修复轮遵守禁令，未再做任何此类演练。

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
