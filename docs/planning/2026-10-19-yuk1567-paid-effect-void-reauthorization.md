# YUK-1567 — paid_effect 通用作废 + 新授权协议

Refs YUK-1355（durable paid-effect 协议本体）/ YUK-1547（背量收口窗口）/
YUK-1559（structured-submit 契约）。本文件记录 `unknown` 效应的
lead-authorized 作废 + successor 再授权机制，替代已退役的
`@2 → @3` marker 特例。

## 背景

YUK-1355 的 paid_effect 状态机 `pending → sending → (unknown | receipt_ready) →
applied` 刻意没有从 `unknown` 出发的路径：`unknown` 是持久未决义务，从不自动
重放，且 `paidEffectGateBlocks` 的固定实体门（同 family + entityId 的
`sending`/`unknown` 行阻止一切新 claim）保证它挡住后续发送。YUK-1547 曾用
jobData `reopen_paid_effect_identity` marker 在 gate 里开一个 `@2 → @3` 特例
（外加 applied kind-mismatch 例外）。该特例已被本票的通用协议取代并删除；
`paid_effect` 的 CHECK 约束与 backup 清单同步扩展。

## 状态与数据模型

- `paid_effect.state` 新增终态 `voided`（CHECK `paid_effect_state_ck` +
  `paid_effect_state_shape_ck` 同步扩展）。`voided` 是已决议：行保留全部历史
  证据列（identity / input_json / delivery 身份 / unresolved_reason /
  cost/result/task-run 痕迹），并要求 `delivery_id`/`delivery_backend`/
  `unresolved_reason` 非空、`voided_at`/`void_json` 非空、无 result/applied/
  lease —— 即"曾发送且未决"的完整形状。
- `paid_effect.voided_at` + `paid_effect.void_json`：作废回执
  （`PaidEffectVoidReceipt`），内容为 `authorizationId` / `reason` /
  `operator` / `basis` / `voidedFromState:'unknown'` / `previousFence` /
  `successor`（完整 successor identity）/ `successorDelivery`
  （backend + delivery id）。
- 新表 `paid_effect_authorization`（migration `0124`）：PK = 被作废 identity
  （FK → paid_effect），因此一行至多被授权作废一次。列：
  `authorization_id`（一次决议可作废多行）、`successor_entity_revision` /
  `successor_unit` / `successor_input_digest`（successor 完整身份坐标；
  family + entityId 与 PK 相同）、`successor_delivery_backend` /
  `successor_delivery_id`（绑定 delivery）、`reason` / `operator` / `basis`、
  `consumed_at` / `consumed_delivery_id`（消费审计标记）、`created_at`。
- 备份：`PAID_EFFECT_BACKUP_TABLES` 变为
  `[paid_effect_control, paid_effect, paid_effect_authorization]`；
  `SCHEMA_VERSION 4.28 → 4.29`。

## 协议不变量

1. **只能作废明确的 `unknown`。** `sending` 有活动发送、`pending` 是未领取
   intent、`receipt_ready`/`applied` 是已支付真相 —— 均拒绝。operator 必须
   在输入中显式给出 (unit, input_digest) + `expectedFence`（行锁 +
   state='unknown' + fence CAS；fence 在 void 时 +1，旧 delivery 的迟到
   receipt/unknown 写入由既有的 owner/fence CAS 拒绝 —— 与所有其它写路径
   同一道门）。
2. **身份列永不变更。** void 只写 state/fence/voided_at/void_json/
   updated_at；从不回退 `pending`、不删行、不伪造 receipt/applied。
3. **原子性。** `voidPaidEffectWithSuccessor` 在一个事务内完成：锁 family
   advisory → 锁被作废行（FOR UPDATE）→ 锁 entity advisory → 校验 successor
   行无冲突且未被其它授权绑定 → INSERT authorization 行 →
   `admitPaidEffectIntent` 落地 successor pending 行 → CAS 更新被作废行为
   `voided`。**崩溃在任一点 → 全部回滚**：不存在"只作废、无授权"或"只
   授权、无 reservation"的中间态，后台 producer 也不能从"已 voided 但
   successor 未落地"的缝隙抢跑。
4. **多行同实体可共享一个 authorization_id**（同一决策作废多个 blocker 指
   向同一 successor）：第一次调用已绑定 successor 的授权 + admitted
   intent 被后续调用识别，不重复插入。
5. **重复调用幂等。** 同 `authorizationId` 对已 `voided` 行重放 →
   `already_voided`（不产生第二张回执/授权）；不同 `authorizationId` →
   `PaidEffectAuthorizationError`，不是新回执。
6. **claim 期授权门**（`checkSuccessorAuthorization`，在固定实体门之后、
   CAS 之前、同一把 family+entity 锁下执行）：只要该实体的某 authorization
   其 successor 仍"开放"（missing 或
   `pending|sending|unknown|receipt_ready`）：
   - 对 successor identity 的 claim：delivery 必须逐项匹配绑定的
     backend + deliveryId，否则抛 `PaidEffectAuthorizationError`
     （fail-closed —— delivery 显式失败，而不是沉默 hold；job retry 会在
     bound delivery 的 lease 里循环失败，绝不退化到未授权发送）。匹配则
     放行并在 CAS 成功后把 `consumed_at`/`consumed_delivery_id` 记为审计。
   - 对任何其它 identity 的 claim：blocked，被作废行被回报为 blocker。
   - successor 到达终态（`applied`/`voided`）后该 authorization 不再参与
     gate。
   - successor 的 once-only 由既有的 `pending → sending` CAS 保证；
     `consumed_*` 是审计标记，不独立承担一次性。
   - 同一实体同时存在多个开放授权时按 successor 逐个串行（任一开放的
     非自身授权都 block）——与实体门"一个实体一次一个发送"语义一致。
7. **绑定在 claim 边界验证，不靠随机 job id 或 queue 单例。** 授权记录的
   `successor_delivery_backend` + `successor_delivery_id` 与实际发起
   claim 的 delivery 逐项比较；不同 delivery 持同一 successor identity 也
   会 throw。后台 producer（其它 job、subscription delivery、重试）抢跑
   successor → `PaidEffectAuthorizationError`。
8. **旧 receipt 永不被豁免。** admission claim 路径里"legacy
   receipt_ready 阻断新 @3"检查保留；授权只绕开实体门的 unresolved
   blocker，不豁免任何已记录 receipt。

## 已删除的旧特例（无未迁移 consumer）

- `AdmissionJobData.reopen_paid_effect_identity`（`admission@2` literal +
  input digest marker 字段）与 `admissionJobId` 的第 5 参 marker 混入。
- `PaidEffectSendClaimDelivery.admissionReopenMarker`、`findGateBlocker` 的
  `@1/@2 + marker` SQL 豁免、`claimLockedRow` 的 marker 传递。
- `AdmissionReopenMarker` 类型、`receipt.ts` 的
  `isKindMismatchSolveConflict` / `reopenMarkedRowEligibility` /
  `appliedVerdictBlocksClaim` / `KIND_MISMATCH_CONFLICT`，以及"applied
  verdict 除 marker 行外都 terminal"的逐行豁免（现为首个 applied 即
  terminal，不再逐行豁免）。
- `claimAdmissionBatch` 中 marker 预检 + `historicalTerminal && !marker` 特例；
  `pinned`/`byDigest` 行复用查询新增 `state != 'voided'` 排除（同 base 上旧
  @3 voided 行与新 @3 successor 并存时，resolved 历史行绝不再被选为
  复用 input 的来源）。

## CLI / 运维接口

共享的 evaluate/release/recover 逻辑住在
`src/capabilities/practice/server/admission/reauthorization.ts`（practice
能力包自持；两个 CLI 都是它的 live consumer）。

### `scripts/yuk1547-admission-reopen.ts`（TEST-only）

- `--preflight <receipt.json>`：保留原 provider 探针（唯一的 provider 调用点；
  void 释放本身不发 provider 请求）。
- `--plan <manifest.json> --out <plan.json>`：**只读** DB 评估 + 冻结写
  plan 工件（`-wx`，不覆盖）。manifest 由 operator 编写：
  `{authorization_id, operator, basis, reason, groups:[{group_id,
  base_digest, successor_unit, void:[{unit, input_digest, expected_fence}]}]}`。
  每个 group 的资格（`evaluateAdmissionVoidGroup`，与释放路径共用同一判定）：
  manifest 必须覆盖该实体**全部** `unknown` 行（含 fence 匹配）；无
  `sending`/`pending`/`receipt_ready` 行；无本 base applied verdict；
  无非终态 admission job / 未决 enqueue delivery / 未发现 publish event；
  无 terminal verification（否则 claim 直接 'historical'）；lifecycle
  withheld + current revision == base。plan 记录每组的 republish
  generations、successor 完整身份（含冻结 input 作为审计证据）、bound
  job id、ghost generations/job ids。**本脚本不 enqueue、不 republish、不
  改 paid_effect** —— 一次 `--execute` 把整批 job 预发出去会让 STOP/预算/
  unknown 门来不及拦后续付费（审查 P1-2），已由 driver 逐题释放取代。

### `scripts/yuk1547-admission-backlog.ts` —— 逐题释放

- `drive --authorized <plan.json>` 消费 plan 工件。启动时只读验证（
  `authorizedBindingFailures` 按阶段判定）：未释放组 = 目标行仍
  `unknown` 且 fence 匹配、无授权行、无 successor 行、无 bound job；
  已释放组 = 全部 `voided` 于该 authorization_id + 授权行 + successor 行 +
  bound job 存在；**部分作废 = 不一致态，fail**。每次 run 都重验。
- **每题释放**：authorized 组走到每题 `else` 分支、且 queue gate（空
  外部队列+未结 delivery，仅豁免 ghost job）/ unknown-rate / 合并账本预算
  全过之后，才在一个事务内完成：重锁重评估（plan drift → abort）→
  republish owner_hold→unverified_rules → `boss.send` bound job（
  `admissionJobId(group, revision, base, finalGeneration)`，同事务）→
  `voidPaidEffectWithSuccessor` 逐行作废 + 授权 + successor intent。提交
  后 subscriber 对绑定事件的 `boss.send(same id)` 返回 null → delivery
  直接 terminal；对 ghost 事件的副本 job 以 stale generation 运行 →
  `'stale'`，不 spend。未轮到的组保持 `unknown`，无可消费 successor。
- **恢复**：事务内崩溃全回滚；commit 后、intent 文件写出前崩溃 → 下轮
  `recoverAdmissionVoidSend` 探针（在 gates 之前运行——已提交的 bound job
  对 queue gate 是 foreign）从 DB 重建事件/job 证据并只补写文件；intent
  存在而 receipt 缺失 → 原既有 in-flight settle 路径。
- authorized 组对 `--sent` overlap guard 的豁免仅以该 manifest 为凭证；
  其余 overlap 仍 fatal。queue gate owned events 并入 republish 三元组；
  `TERMINAL_PAID_STATES` 含 `voided`；expected identity 覆盖为冻结的
  `(revision_id, final_generation)`。
- `check --authorized <plan.json>`：对 authorized 组做相位感知绑定验证
  而非普通 eligibility。

## 恢复 / 验收三场景（文字步骤；父执行真实 DB 验收）

1. **driver 释放事务中崩溃**：释放事务回滚 —— paid_effect 行仍为
   `unknown`（state/fence 未变）、无 `paid_effect_authorization` 行、无
   successor pending 行、pgboss.job 无绑定 job、lifecycle generation 未
   bump、无 publish event；下一轮 drive 走正常释放。崩溃在 commit 后、
   intent 写出前 → `recoverAdmissionVoidSend` 探针只读恢复证据并补写
   intent/publish 文件，不产生第二授权。
2. **错误 producer/delivery 抢 successor claim**：以非绑定 delivery id 对
   successor identity 调 `claimPaidEffectSend`（或直接让另一个 job 携带该
   身份进入 admission receipt 路径）→ `PaidEffectAuthorizationError`，
   `consumed_at` 保持 NULL，successor 行仍 `pending`；其后绑定 delivery 的
   claim 正常放行。对非 successor identity 的 claim → `held`（blocker 指向
   被作废行）。
3. **旧 job/迟到 receipt 在 void 后到达**：旧 delivery 以旧 fence 调
   `recordPaidEffectResult` / `markPaidEffectUnknown` →
   `PaidEffectDeliveryConflictError`（owner/fence CAS）；旧 job 若重新走完
   claim 路径也只会命中 `voided` 行 → `refused`/`held`。被作废行的
   `result_json`/`applied_at` 恒为空。

## 本地验证（本分支）

- `pnpm typecheck` PASS；`pnpm lint:ratchet` PASS（179 ≤ baseline 210）；
  `pnpm build` PASS（web + server/worker/migrate esbuild）。
- 未运行（按约束）：`pnpm test`、Docker/DB、runtime、provider/paid 请求、
  凭据/本机服务。
- 既有测试语义待 owner 裁决（本分支不改测试，相关断言当前与新 schema
  顺序不符在 CI 会失败属已知）：`src/server/export/paid-effect-backup.db.test.ts`
  第 138/139/260 行的字面量断言方案已提交 owner 决定区，未获批准前保持原样。
