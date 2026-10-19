# YUK-1547 — resolved-contract publication + paid→published binding + free repair lane

测试门禁票 **YUK-1547**（第一天能用 / W0）的 P0 修复。Refs YUK-1507（双解/标定来源门与
published-digest 保留，不回退）。

## 根因

`question_admission_run` 的 receipt 应用路径在 admitted 判定时仍发布
`batch.input.contract`（冻结的付费输入 = 含 human_review 执行器的旧契约），丢弃了付费
双解 + 探针标定产出的 `receipt.result.resolved`（typed `select_key`/`blank_key` 判据 +
确定性执行器）。结果：lifecycle 显示 `admitted`，但 current revision 内容仍是
human_review 冻结层 → 真实发题（`readAutomaticallyServableQuestionIds` /
`decideAutomaticServing` 路径）拒绝。98 admitted 中 92 题处于此状态；只读取证显示
其中 50 题存在与当前版本绑定的成功 applied admitted@3 回执（49 无旧 unknown；
zx7n8 保留旧 @1/@2 unknown），其余 42 无当前匹配 paid 证据、不属于本 lane 的
修复对象，另行取证。

## 变更

1. **正常路径发布 resolved。** `question_admission_run.ts` 应用段改为调用共享构建器
   `buildAdmissionPublishInput`（新模块
   `src/capabilities/practice/server/admission/resolved-publication.ts`）：admitted ⇒ 发布
   `receipt.result.resolved`；withheld ⇒ 发布冻结输入契约（行为与修复前完全一致）。
   question 根行投影（`projectAdmittedQuestionRow`）同步改为来自同一 resolved 契约 —
   prompt/reference/choices/content-hash 不再声明与实际发题内容脱节。

2. **paid→published 回执绑定。** 新 revision 的 `published_by` 与同 tx 追加的
   `question_admission_verification` evidence 携带：
   `paid_effect` identity（`family/unit/entity_revision/input_digest`）、
   `receipt_digest`（`canonicalHash(receipt)`）、`input_admission_generation`、
   `resolved_contract_digest`（receipt 声明的 resolved 摘要，原样记录）与
   `published_contract_digest`（对实际发布层的 canonical seal，= 新 revision 的
   `integrity_digest`）。行自身的 `revision_id/revision_digest` 列仍是权威
   published-digest 绑定（#1784 机制不变）。链：付费行 → receipt → resolved →
   canonical 发布摘要 → revision，一一对应。

3. **presentation 三级链。** `resolved` 不带展示层 —— 副本实测（50 题 apply 成功但
   `issueAssessment` 全拒 `not_admitted:no_input_renderer`，select/blank 槽无展示层输入
   积木绑定即不可发）证明展示层是 admitted 发布的法律要件。发布文档按序取：
   ① resolved 自带 presentation —— 原样保留，先 `validatePresentation` 对**resolved 层**
   校验（坏显式布局 blocked，绝不悄悄替换）；② 冻结输入 presentation —— 原样携带同样
   校验；③ 两者皆无时 `defaultPresentation` —— 与统一 submit 闸（
   `src/server/questions/submit-question.ts presentationForDraft`）同一确定性构造器，
   但**前置形状闸门收窄到本轮批准范围**：可作答槽仅 blank 或 plain select
   （select items 无 `coordinates`/`gap_after_codepoint`）；配对
   （matching_columns）、排序（ordering）、断句（break_tap）、自定义 axes 及
   其他旧槽型一律 `presentation_default_unsupported_shape` blocked 并指名
   slot id/kind —— 构造器本身能生成这些变体，但本轮不自动产生，需显式
   presentation。过了形状门仍不可表达（如无计分单元绑定）⇒
   `presentation_default_inexpressible` blocked。两者皆 blocked 时 receipt
   保留、不算 admitted 成功。组合后对全部五层重算 canonical seal；绑定
   `presentation_source` 如实记录
   `resolved`/`carried_from_base`/`deterministic_default`/`none` 四种来源（`none` 仅当
   槽集不含 select/blank —— 即服务门 `BLOCK_INPUT_SLOT_KINDS` 与槽集不相交、原生可渲染
   时合法；含 select/blank 而表达不了的一律 blocked）。50 题真实清单全为
   49 plain select + 1 blank（父已核 `presentation-shape-inventory.json`），无非标准。

4. **终端判定消费者绑定修正。** 两处「该 base 是否已有终局核验」判定从
   `evidence.base_contract_digest`（= 付费输入摘要；resolved 发布后永远不等发布摘要）
   改为：publisher 写入的 `question_admission_verification.revision_digest` 列 ==
   当前 revision `integrity_digest` **或** 旧 `base_contract_digest` 字段回退兼容 —
   `question_admission_run.ts` claim 内 `terminal` 检查 与 `source_verify.ts` 的
   pair-race guard（防 admitted 被 demote 回 withheld → 再自动付费）。policy/outcome/
   pack 过滤不变，旧证据兼容不放宽。不重写旧 receipt 的 `base_contract_digest`。

5. **免费补发 lane（不写库可运行）。**
   `src/capabilities/practice/server/admission/resolved-repair.ts` +
   `scripts/yuk1547-repair-resolved-contracts.ts`（`ops:yuk1547-repair-resolved-contracts`）：
   - manifest 显式逐项绑定：`group_id` + expected current revision id/digest +
     admission generation + 精确付费 identity（`unit`/`input_digest`/`fence`）。
   - `plan`（默认姿态，零字段写入）：逐条在**普通事务**（advisory 锁 +
     FOR UPDATE 行锁，非 PG READ ONLY 事务）内评估后回滚提交，给出
     ready/already_repaired/blocked+reason，并用
     `readAutomaticallyServableQuestionIds` 报**当前真实可发数**（与真实发题同一
     part binding），不以 admitted 计数冒充。
   - `apply` 须 `--reason`（操作者原因进 repair 回执）与 `--out`（逐条 receipt +
     summary.json）。每 entry 独立事务：family 锁 → root/lifecycle 锁 → 精确付费行
     （state=applied、fence、entity_revision=expected digest）→ **从 input_json 重算
     paid-effect identity**（与 claimAdmissionBatch 同一配方：parse 后
     `computePaidEffectIdentity`，PK 列只是声明不是证明）→ 冻结 input 契约经
     `publishedContractSeal`/`publishedSealAccepts` 自封 → 冻结 input/application 与
     manifest revision 绑定核对 → 读当前 revision **全量 layers**、规范 seal 与
     存库 digest 双向校验 → 幂等绑定检查 → manifest CAS + **当前内容 canonical seal
     必须等于冻结 input 内容**（before/after 区分：只在未修过的前置状态要求；
     修后复跑走绑定分支不会撞此项）→ group blockers → 中央
     `publishQuestionGroup` → 根行投影（同一 resolved 契约）。
   - **幂等**：当前 revision `published_by.paid_receipt` 已携带**完整**付费绑定
     （family/entity_id/entity_revision/unit/input_digest/receipt_digest（按
     canonicalHash 重算核对）/resolved_contract_digest/published_contract_digest）
     且存库 layers canonical seal == resolved 发布目标 ⇒ `already_repaired`，
     publisher 之前返回，不铸 revision、不翻 generation、不追加重复 verification。
     部分匹配/异主绑定 ⇒ `current_revision_bound_to_other_receipt` 歧义停；
     同文档无绑定 ⇒ `same_document_without_receipt_binding` 歧义停。
   - **不重复入队**：发布事件 admission='admitted' ≠ 'withheld'，outbox 订阅
     （enqueue.ts `enqueuePublishedQuestionAdmission`）天然跳过 —— 这是唯一机制；
     `actor_ref='practice:question_admission_repair'` 只作审计区分，**不是**入队闸。
     不走 claim/send/recordApplication，不 UPDATE 旧付费行。
   - 失配/歧义/unknown/missing/stale/open 同base义务一律 blocked 拒收，不临时猜。
     同 base 的 `sending`/`receipt_ready`/`pending` 行阻塞该条；保留的 `unknown`
     行（如被 @3 取代的旧 @1/@2）不阻塞但逐条记入回执 `retained_unknown_rows`，
     永不消费、永不改写。

## 追源：resolved 为何没有 presentation（YUK-1568 第三片 follow-up 清单）

直接缺口：`run-admission.ts`（~L594-605）`resolvedContract` 仅装配
structure/response_spec/scoring_basis/execution_plan 四层；`ResolvedAdmissionContract`
与 `definition-from-contract.ts` 的准入定义全程不携带 presentation。

上游缺口（本 PR 不迁）：统一 submit 闸 `submit-question.ts` 的
`presentationForDraft`（L374 起，显式优先否则 `defaultPresentation`）是唯一展示层
合成点；所有 `publishQuestionGroupFromRow` 行路径生产者都直通、不合成——该 50
题的 input 本身无 presentation（web_sourced/jyeoo 草稿走
`sourced-draft-insert.ts:204/231`，正是 from-row 路径）。同类裸发布口：
`quiz_gen.ts:1540`、`quiz_verify.ts:958/1022`、`source_verify.ts:663/951`、
`verify-and-promote.ts:309`、`serving-actions.ts:324/551`、`proposal-appliers.ts`
×3、`intervention-diagnostics.ts:688`、`probe-lifecycle.ts:225`，及 ingestion 侧
`auto-enroll.ts:700`、`assessment-capture.ts:390`、`legacy-record-appliers.ts:394`、
`mistakes.ts:122`、`image-candidate-accept.ts:1006`、`seed-synthetic.ts`。

第三片候选动作（待 coordination 批准，不在本 PR）：
- 将 `defaultPresentation` 合成收敛进 `publishQuestionGroup`/`publishQuestionGroupFromRow`
  seam（或让 from-row 先走 typed submit/edit 路径）——一次消除所有裸发布口；
- `ResolvedAdmissionContract`/`definition-from-contract` 声明 presentation 槽位
  （resolved 可自带展示层进入第 ① 级）；
- 存量无展示层 revision 的盘点与处置（属 manifest/协调线范围）。

## 边界

- 不改 core 比较器、模型、生产端、UI、测试、迁移、`paid_effect` 状态协议。
- `kernel/records/assessment-publication.ts` 与 `enqueue.ts` 均未改动（repair 复用既有
  接缝，无 kernel 变更）。
- 不引入 #1811（未合、HOLD）的任何代码。
- 真实数据验收（manifest 精确 50 题 apply + 实际可发数）由协调线在副本/TEST 上执行；
  42 题无当前匹配 paid 证据（41 旧 quiz_verify@1 + 1 旧 source_verify@1 直 admitted，
  属 1507 接续的独立来源），不在本 lane。manifest 名单由父持，不落库入本仓库。

## 副本实测记录（协调线，真实失败已封存清理）

- restored copy 上：50 plan ready / 50 apply repaired / 复跑 50 `already_repaired`
  （幂等 + 四表事件字节不变、172 paid 行与 jobs/schedules 完全不变）—— repair 机制
  本身验证通过。
- 但逐题 `issueAssessment` 全部 `not_admitted:no_input_renderer` —— 该 50 的 input 与
  resolved 均无 presentation，本次 follow-up 以 `deterministic_default` 补上。
- 证据：
  `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-20261019-yuk1547-p0-restored-copy/{issuance-results.json,repair-apply/summary.json}`。
- TEST 未补发、未部署；serving gate 未放松。

## 本 PR 未验证项（NOT_RUN）

- 仅过 typecheck/lint/build 与代码走读；未连接任何 DB、未跑 provider/付费、未部署。
- 带 `deterministic_default` 的发布路径、servable-after 复测需协调线在副本上重跑。
