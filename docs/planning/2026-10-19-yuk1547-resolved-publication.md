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

3. **presentation 保留。** `resolved` 不带展示层：冻结输入含 `presentation`（YUK-1497）时
   原样挂到 resolved 文档上并对**组合**重算 canonical seal —— 绝不静默丢层；
   publisher 的 `validatePresentation` + 绑定校验对非法嫁接 fail-closed（receipt 保留、
   记录 `notePaidEffectApplicationFailure`，不吞）。绑定的 `presentation_source`
   （`resolved`/`carried_from_base`/`none`）如实记录 receipt resolved 摘要与最终发布
   摘要的差别。

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
   - `plan`（默认姿态，只读事务）：逐条给出 ready/already_repaired/blocked+reason，
     并用 `readAutomaticallyServableQuestionIds` 报**当前真实可发数**（与真实发题同一
     part binding），不以 admitted 计数冒充。
   - `apply` 须 `--reason`（操作者原因进 repair 回执）与 `--out`（逐条 receipt +
     summary.json）。每 entry 独立事务：family 锁 → root/lifecycle 锁 → 精确付费行
     （state=applied、fence、entity_revision=expected digest）→ 冻结 input/application
     与当前冻结 revision 绑定核对 → 幂等绑定检查 → manifest CAS → group blockers →
     中央 `publishQuestionGroup` → 根行投影（同一 resolved 契约）。
   - **幂等**：当前 revision `published_by.paid_receipt` 已携带同一
     (unit,input_digest,resolved_digest) 绑定 ⇒ `already_repaired`，publisher 之前返回，
     不铸 revision、不翻 generation、不追加重复 verification。同文档无绑定 ⇒
     `same_document_without_receipt_binding` 歧义停。
   - **不重复入队**：发布事件 admission='admitted' ≠ 'withheld'，outbox 订阅
     （enqueue.ts）天然跳过；actor_ref 用 `practice:question_admission_repair` 作第二道
     区分。不走 claim/send/recordApplication，不 UPDATE 旧付费行。
   - 失配/歧义/unknown/missing/stale/open 同base义务一律 blocked 拒收，不临时猜。
     同 base 的 `sending`/`receipt_ready`/`pending` 行阻塞该条；保留的 `unknown`
     行（如被 @3 取代的旧 @1/@2）不阻塞但逐条记入回执 `retained_unknown_rows`，
     永不消费、永不改写。

## 边界

- 不改 core 比较器、模型、生产端、UI、测试、迁移、`paid_effect` 状态协议。
- `kernel/records/assessment-publication.ts` 与 `enqueue.ts` 均未改动（repair 复用既有
  接缝，无 kernel 变更）。
- 不引入 #1811（未合、HOLD）的任何代码。
- 真实数据验收（92 题 apply + 实际可发数）由协调线在副本/TEST 上执行；manifest 名单
  由父持，不落库入本仓库。

## 本 PR 未验证项（NOT_RUN）

- 仅过 typecheck/lint/build 与代码走读；未连接任何 DB、未跑 provider/付费、未部署。
- repair 的 apply 路径、幂等跳过、servable-after 数值未经真实运行。
