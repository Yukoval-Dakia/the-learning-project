# YUK-1355 Lane B：共享付费效果协议（paid-effect）固定接口 + 实现检查点

状态：接口冻结供 A/C 消费 + 本 lane 实现。基线 `9806db675`，工作树 `tlp-migration-receipt-reference`，分支 `feat/yuk-1355-receipt-reference`。
上游计划：`tlp-yuk-1363-test-storage/docs/planning/2026-10-11-migration-next-durable-implementation.md`（bc698a329）。

本文是交给父级/A/C 的**固定类型协议**（immutable interface checkpoint）与 schema/SQL 草案。
对已导出签名的破坏性改动必须走新协议版本 + 父级协调，不允许就地改写。

## 1. 效果身份（effect identity）

```
PaidEffectIdentity = {
  family:          string   // 族名，如 'note_verify'（仅 control 面）、A/C 各自族名
  entityId:        string   // 业务实体 id（judge event / question / artifact …）
  entityRevision:  string   // 修订坐标（artifact 版本串 / 冻结 workSetId / rep 修订 …），非空自由文本
  unit:            string   // 实体内稳定单元判别；执行面坐标编码于此（如 'rejudge:<provider>/<model>'、'<method>/rep:<n>'）
  inputDigest:     string   // 'sha256:<64hex>'，输入信封 canonical JSON 的摘要
}
computePaidEffectInputDigest(input)      // 递归排序 key 的稳定 canonical JSON → sha256
computePaidEffectIdentity({family, entityId, entityRevision, unit, input})
```

- 身份**独立于投递**：deliveryId / tickId 永不进入摘要或主键。同输入跨任意次 nightly/timed
  tick 重投递是**同一个**效果行。
- 输入或 revision 变化 → 新身份 → **新行**；历史义务行永不删除、identity 列永不 UPDATE
  （“changed input/revision must not erase historical obligations”）。
- canonical JSON 只接受 null / boolean / finite number（-0 归一为 0）/ string / array /
  plain object；undefined、bigint、symbol、function、非有限数、非 plain object 一律抛
  `PaidEffectProtocolError`（拒绝静默丢字段的摘要漂移）。

## 2. 状态机（每效果行，主键即身份）

```
pending ──claimSend(CAS)──▶ sending ──recordResult──▶ receipt_ready ──recordApplication──▶ applied
                              │
                              ├─settleUnknown(lease 过期/delivery 终态无收据)─▶ unknown
                              │        └─(late recordResult，仅限属主 delivery)─▶ receipt_ready
                              └─ 无任何回到 pending 的路径；unknown 永不自动重放
```

- `pending`：intent 已持久化（identity + 完整输入信封 `input_json`），物理发送尚未授权。
- `sending`：恰一个 delivery 赢得 CAS（fence 单调 +1；delivery_id/backend/tick 落行；
  `send_lease_expires_at` 记录租约）。
- `unknown`：发送已授权但结果未知 → **持久未决义务**；`claimPaidEffectSend` 一律拒绝，
  包括新 tick 的新 delivery；仅属主 delivery 的迟到 `recordPaidEffectResult` 可将其
  单调升级为 `receipt_ready`（或运维处置，超出本层）。
- `receipt_ready`：不可变结果收据已写入（`result_json` 语义相等比较，不等即冲突）。
  应用失败停留在此态 = 可读未完成义务（workflow SUCCESS 与否无关）。
- `applied`：应用收据已写入；终态。

## 3. 事务/转换语义（src/server/durable/paid-effect-store.ts）

全部转换在调用方事务内 `SELECT … FOR UPDATE` 行锁上执行（主键=身份 → 跨后端竞态在
行上串行化，这就是 CAS）；跨身份同实体的 send 准入另经
`pg_advisory_xact_lock(hashtextextended('paid-effect:gate:v1:<family>:<entityId>', 0))`
串行化，封死两个 consumer 同读空后各自通过 gate 扫描的双发窗口。

**reserve 是唯一的 send admission**（append 无返回不能作为 admission）：

```ts
reservePaidEffect(db, input, {backend, deliveryId, tickId?, leaseExpiresAt, generation?}):
  {kind:'winner'; fence}                                  // 本 delivery 拥有物理发送（admit+claim 原子完成）
  | {kind:'held'; state; blockedBy: PaidEffectIdentity|null} // 不得发送：自身 sending/unknown，或 entity 门拦截（blockedBy 点名）
  | {kind:'completed'; state:'receipt_ready'|'applied'; result; application; applied} // 付费已发生，从不可变收据重放应用
// control 围栏（backend/generation）内嵌在 claim 事务里：fenced → 抛 PaidEffectControlFencedError，
// 绝不返回 winner。锁顺序固定：family-control advisory → identity 行锁 → entity advisory → control FOR SHARE，
// 与 switch 的 control FOR UPDATE 互斥（P1-2）。
```

**entity 门（P1-1：单一固定 predicate，无可选 scope，caller 无法绕过）**：

同一 (family, entityId) 下另一效果 B 处于 sending/unknown 时，X 的 claim 被阻断，
**只有 `item_prior_backfill` 的同 revision、不同 `feature/rep:<零基整数>` unit 互相豁免**。
`llasa` 是单次调用，没有并行 sibling；其他方法、任意 unit、C 的 provider/model 变化均不豁免。
纯谓词与 SQL 扫描共享 recognized-unit regex 和相同 family/revision/unit 条件。

- A 的同 revision feature rep:0 vs rep:1：允许；
- 同 revision **同 unit** 不同 input digest：阻断（对账后再买）；
- 不同 revision（新 workSetId / 新 questionRevision）下旧 sending/unknown：entity 级阻断。

序列化锁 key 固定为 `paid-effect:gate:v1:<family>:<entityId>`（不含 revision）。

其余转换：

```ts
admitPaidEffectIntent(tx, input): {kind:'admitted'} | {kind:'existing'; state}
  // 最低 public 入口先取 family-control advisory，再 INSERT / conflict 行锁。
  // ON CONFLICT DO NOTHING 后回读；已存在且 canonical input 不一致 → IdentityConflict（摘要碰撞守卫）
claimPaidEffectSend(tx, identity, {backend, deliveryId, tickId?, leaseExpiresAt, generation?}):
  {kind:'claimed'; fence} | {kind:'missing'} | {kind:'refused'; state; receiptKnown; blockedBy?}
  // 仅 pending 可 claim；control 围栏内嵌（fenced → 抛错）
recordPaidEffectResult(tx, identity, deliveryId, receipt, {fence}): 'recorded' | 'idempotent'
  // P1-4：fence 必填；仅属主 delivery 且 winner fence 匹配可写；语义相等 → idempotent；
  // 不等 → ReceiptConflict；sending/unknown → receipt_ready（unknown 迟到收据 = 单调信息增益，仍限属主）；
  // pending → ProtocolError
markPaidEffectUnknown(tx, identity, deliveryId, reason, {fence}): void
  // 已 unknown 的幂等重试也先核原 delivery + winner fence；合法重试保留原 reason/时间戳。
settleExpiredPaidEffectSends(db, {family?, now?}): number   // sending+租约过期 → unknown（分类，非重试）
notePaidEffectApplicationFailure(tx, identity, error): void // attempts+1 / last_application_error，状态保持 receipt_ready
recordPaidEffectApplication(tx, identity, application): 'applied' | 'idempotent'
readPaidEffect(db|tx, identity): PaidEffectSnapshot | null
listPaidEffectObligations(db, {family?, states?, limit?}): PaidEffectObligationView[]
```

应用失败**不重发**：apply 抛错只是不调用 recordApplication（可 note 失败），行停留在
`receipt_ready`；任何后续 delivery `claimPaidEffectSend` 都被 refused → 物理发送侧无路可回，
唯一前进路径是从收据重放应用。

收据/应用负载的确定性是调用方合同：服务端单列 `result_recorded_at`/`applied_at`，
重放比较只看调用方负载（jsonb 语义相等），时间戳不参与比较。

## 4. 后端控制（src/server/durable/paid-effect-control.ts）

**P1-R2 修正后的串行化模型**：所有 admission 与 switch 共享**同一条 family 级
advisory 事务锁** `paid-effect:control:v1:<family>`（`lockPaidEffectControlFamily`，
在各自事务内**最先**获取；Postgres 同事务内重入为 no-op）。行锁（FOR SHARE/
FOR UPDATE）在缺行时锁不到任何东西 —— 缺行 admission 读“默认 pgboss”与并发
switch 的 insert+scan+flip 互不可见的 race 由这条锁封死。probe 一律跑在
switch 的**同一事务**（同锁窗口、同快照），绝不另开连接。

固定锁序（无环）：**family-control advisory → identity 行（如适用）→
entity advisory（如适用）→ control 行**；note 侧：**family-control advisory →
artifact 行 → claim 行**（与既有 reservation/supersede/provider-start 的
artifact→claim 序一致，admission hook 永远最先）。

```ts
readPaidEffectControl(db|tx, family): {family, backend, generation, explicit}
  // 无行 = 引导默认：pg-boss, generation 0, explicit:false。绝不默认 dbos。
admitPaidEffectDeliveryControl(tx, family, {backend, deliveryId, generation?}):
  {kind:'admitted'} | {kind:'fenced'; reason:'backend_mismatch'|'stale_generation'|'missing_generation'; owner; generation}
  // 先锁 family advisory 再读 control 行。非 bootstrap 下两后端都必须携带
  // 原始 dispatch generation，防 pg-boss 0 → DBOS 1 → pg-boss 2 回切重入。
  // 唯一 legacy 例外是 pg-boss generation 0，包括 materialized bootstrap row。
  // 无 generation 的旧 job 只会 fenced/held；消费时不得读取 current generation 自动升级。
  // **实现锁序（如实）**：reserve/claim/admit/switch 都在事务入口先取
  // family advisory，随后 identity 行 → entity advisory → control 行；
  // note 侧 family advisory → artifact 行 → claim 行（与既有
  // reservation/supersede/provider-start 的 artifact→claim 序一致）。
switchPaidEffectBackend(db, family, to): {family, backend, generation}
  // 先锁 family advisory；被 family 的一切未完义务阻塞（P1-5：
  // pending/sending/unknown/receipt_ready）：paid_effect 扫描 + 固定 family
  // probe（note_verify → note_verification_claim 同 tx 投影）。并发 switch 的
  // 缺行插入竞态由同锁封闭。PAID_EFFECT_SWITCH_UNSUPPORTED_FAMILIES 中的族
  // （当前 note_verify）在义务扫描后被显式拒绝跨后端切换，直到原子 claim admission
  // 与持久化 dispatch generation producer/consumer 都接好并验证。当前 handler /
  // DBOS candidate 都没有传 generation；本轮不改 payload、不装配 runtime。
  // 成功 backend=to、generation+1；同 backend 幂等不 bump。
isPaidEffectControlUndefinedTable 已移除：42P01 会 abort 活事务，catch 后继续必 25P02。
paidEffectControlTableExists(tx): boolean              // to_regclass 无 abort 探测，事务内安全
lockPaidEffectControlFamily(tx, family): void        // 共享 family 串行锁（入口最先）
paidEffectDispatchRefSchema.parse(raw): VerifiedPaidEffectDispatchRef
  // 必填非负整数 generation，供父级验证原始 versioned dispatch metadata；不生成 metadata。
```

- pg-boss/DBOS **对称** admission；dispatch 侧 cutover 归父级。
- 陈旧 generation 检测覆盖 A→B→A 往返切换。

## 5. note_verify 消费面（control + 原子 claim 侧 admission）

- `note_verification_claim` 仍是 note 族付费权威；本层**不**为 note 写 paid_effect 行。
- **原子 admission hook（P1-R2-2，功能 owner 已释放单文件接线）**：
  `reserveNoteVerification(db, artifactId, opts?)` 新增可选 `controlAdmission:
  (tx: Tx) => Promise<void>`，在 reservation 事务内**最先**执行（锁序
  family-control advisory → artifact → claim）；拒绝 = 抛
  `PaidEffectControlFencedError` → 整个事务回滚（无 claim 行、无状态变化）。
  缺省不传 = 旧调用行为逐字节不变。默认 hook 由
  `buildNoteVerificationControlAdmission(ref)` 构造（shared family 锁 +
  owner/generation 同事务校验；**缺表探测用 to_regclass（无 abort），缺表仅
  pgboss 默认放行、dbos 硬拒 —— 绝不在活事务里 catch 42P01 后继续**）。
- 生产发送入口全部默认接线：pg-boss handler（`jobs/note_verify.ts`，per-job
  ref = {backend:'pg-boss', deliveryId: jobId}）；DBOS 适配器
  （`note-verify-family.ts`，ref = {backend:'dbos', deliveryId: workflowId}，
  explicit control 下无 generation → 硬拒绝）。handler 的 tx1 预检仅作 fail-fast；
  权威校验在 tx2 hook。fenced → 抛错（重投→DLQ，accepted job 不被 skip 消解）。
- note 义务 probe（`paid-effect-note-obligations.ts`）：switch 门同 tx 投影既有
  claim 状态（reserved/provider_started→sending，ambiguous→unknown，
  retry_wait→pending，result_ready→receipt_ready；completed/attempts_exhausted 不阻断），
  只读、不复制 claim 状态机。
- DBOS 适配器（`durable/note-verify-family.ts`）：workflow body 在 step 前 admission
  （backend 'dbos', deliveryId=workflowId）；fenced → 抛 `PaidEffectControlFencedError`
  （workflow ERROR，无付费调用）；42P01 → fenced（dbos 永不默认准入）。
- 两处族名同为 `'note_verify'` 字面量（单测锁死一致；jobs 侧不 import DBOS SDK，
  避免把 SDK 拖进 pg-boss worker bundle）。

## 5.5 A/C 固定 consumer 兼容性审阅（f007ed528 / 3cf13cf64，仅 git show immutable）

- **C（f007ed528，judge_calibration_sample）**：`CalibrationEffectIdentity{family, judgeEventId,
  workSetId, provider, model, inputDigest}` 映射为 `entityId=judgeEventId`、
  `entityRevision=workSetId`、`unit='rejudge:<provider>/<model>'`（provider/model 是身份坐标、
  不进 digest —— 与 C 的 inputDigest 定义一致）；`computeCalibrationEntityKey` 与 'entity'
  scope 门语义一致。其 provisional `CalibrationStagedExecutionPort`
  loadFamilyRecords/appendRecord 由 reserve/record/read/obligations 取代：append 无返回不作
  admission，reserve 的 winner/held/completed 判别是唯一准入；`stage:'intent'|'sent_unknown'|
  'completed'|'applied'` ↔ `pending|unknown|receipt_ready|applied`；`held_receipt_mismatch`
  = 捕获 `PaidEffectReceiptConflictError` 后族内 held 处置。裁决差异：C 的 provisional
  port 把旧 'intent' 也算 openObligation 拦截；本协议 pending 不跨身份拦截（未跨付费边界，
  可 claim 续走）——pinned decision，父级可推翻。anchor-only 时钟不冲突：store 时间戳是
  运维元数据，冻结 anchor 存在于身份/workset 数据内。
- **A（3cf13cf64 + 927a927e，item-prior per-rep）**：`identity(questionId, questionRevision, method,
  inputDigest, repIndex)` 映射为 `entityId=questionId`、`entityRevision=questionRevision`、
  `unit='<method>/rep:<repIndex>'`；固定 predicate 恰好覆盖 rep 语义：同 revision、同 feature 方法的不同 rep
  并行不互堵；llasa 单次调用与方法变化不豁免，同 unit 换 input 被阻断（对账），换 revision 被旧 unknown entity 级阻断。
  `admitRep` 原子 winner lease/token = `reservePaidEffect`（deliveryId+leaseExpiresAt 即 lease，
  fence 即 token）；`completeRep` 凭 winner 校验 = `recordPaidEffectResult(deliveryId, {fence})`，
  fence 必填，不可仅 identity 写。A 的 927a927e receipt/application 错误传播与本协议一致；
  domain readback matched/superseded 明确非 causal receipt —— 本协议同样不把域行存在当完成。

## 6. Schema 声明（src/db/schema.ts，本 lane 唯一 schema 提议权）与 SQL 草案（父级编号）

表：`paid_effect_control`、`paid_effect`（列与 CHECK 见 schema 声明；主键
`(family, entity_id, entity_revision, unit, input_digest)`；义务扫描索引
`(family, state)`）。父级迁移 SQL 草案：

```sql
-- 011N_yuk1355_paid_effect.sql（编号/journal 归父级）
create table paid_effect_control (
  family text primary key,
  backend text not null check (backend in ('pg-boss','dbos')),
  generation integer not null default 0 check (generation >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table paid_effect (
  family text not null,
  entity_id text not null,
  entity_revision text not null check (entity_revision <> ''),
  unit text not null,
  input_digest text not null check (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  input_json jsonb not null,
  state text not null check (state in ('pending','sending','unknown','receipt_ready','applied')),
  fence integer not null default 0 check (fence >= 0),
  delivery_id text,
  delivery_backend text check (delivery_backend in ('pg-boss','dbos')),
  delivery_tick text,
  send_lease_expires_at timestamptz,
  result_json jsonb,
  result_recorded_at timestamptz,
  application_json jsonb,
  applied_at timestamptz,
  application_attempts integer not null default 0 check (application_attempts >= 0),
  last_application_error text,
  unresolved_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (family, entity_id, entity_revision, unit, input_digest),
  constraint paid_effect_state_shape_ck check (
    (state = 'pending'
       and delivery_id is null and delivery_backend is null
       and send_lease_expires_at is null and result_json is null and applied_at is null)
    or (state = 'sending'
       and delivery_id is not null and delivery_backend is not null
       and send_lease_expires_at is not null and result_json is null and applied_at is null)
    or (state = 'unknown'
       and delivery_id is not null and delivery_backend is not null
       and send_lease_expires_at is null and result_json is null and applied_at is null
       and unresolved_reason is not null)
    or (state = 'receipt_ready'
       and result_json is not null and result_recorded_at is not null
       and send_lease_expires_at is null and applied_at is null)
    or (state = 'applied'
       and result_json is not null and applied_at is not null and application_json is not null
       and send_lease_expires_at is null)
  )
);
create index paid_effect_obligation_idx on paid_effect (family, state);
-- 运行期 advisory lock（无需 SQL）：send 准入按 gate scope 串行化于
--   hashtextextended('paid-effect:gate:v1:<family>:<entityId>', 0)
-- 可选观测种子（非必需；缺行 = pgboss generation 0）：
-- insert into paid_effect_control (family, backend) values ('note_verify', 'pg-boss');
```

注意：drizzle-kit 不发射 `~` 正则 CHECK 与跨列 OR CHECK 时需要父级手改（与 0071
partial-index 先例同流程）；schema 声明与 SQL 的语义一致由本 lane 的 DB 测试锁定。

## 7. 测试与验证

- 离线（本 lane 运行）：`paid-effect-protocol.test.ts`（canonical/digest 确定性、身份独立于
  投递、control 纯决策、switch 阻塞谓词、gate scope 固定、双 'note_verify' 字面量一致）；
  `note_verify.control.test.ts`（pg-boss handler fenced→抛 retry-visible 错误 / admitted→执行）；
  更新 `note-verify-family.test.ts`（DBOS admission 装配 + fenced→ERROR）。
- DB（本 lane 只准备不运行，父级 scoped DB loop 执行）：`paid-effect-store.db.test.ts`
  ——CAS 竞态恰一赢家、不等收据拒绝、旧 unknown 新 delivery 拒绝、错误后端/陈旧
  generation fence、应用失败不重发、input/revision 变化不抹历史义务、intent 幂等 +
  摘要碰撞守卫、switch 全态阻塞与 generation 递增、reserve winner/held/completed 判别、
  固定 entity 门 predicate（rep 并行 / 同 unit 换 input 阻断 / 跨 revision 阻断）、
  跨身份并发 reserve 串行化、winner+fence 完成校验、claim 事务内 control 围栏、
  **缺行并发 claim vs switch 强制交错**（不得双赢）、**note reservation vs switch
  强制交错**（封 tx1/tx2 窗口）、**fenced note reservation 整体回滚**（无 claim 行）。
- 共享面最小改动：`vitest.shared.ts` 三行、`tests/helpers/db.ts` ALL_TABLES 两行
  （paid_effect / paid_effect_control，DB 测试隔离必需）。
- 本地 gate：scoped unit、`pnpm typecheck`、`pnpm lint`、`pnpm build`、
  `pnpm audit:test-policy`。真实 DB/进程恢复、DBOS 注册、cutover、exact-head CI 归父级。


## 8. Shared stage R1 repair, 2026-10-11

This batch resumes clean `9bbbd5af9b69fd22b068f0c9c7275b473cd6fe2d` and addresses the
new shared-stage R1 on fixed `9de7f8ab11f1da89318486c985398fbc8dbe49b4`, the owner omission and the test proof gap.
The earlier note-reference R1/R2 budget and results remain historical. Parent
will run new DB acceptance before the shared stage's sole R2. No third review
or child delegation ran here.

- Lowest-level intent admission takes the family advisory before INSERT or
  conflict-row lock. All store row-locking writes now take that lock too, so
  composing a receipt/application write with admission cannot reverse the
  family/row order. Reserve/claim/control/switch already use the same key.
  The expiry classifier performs one standalone monotone UPDATE, takes no later
  advisory/control lock and creates no new send admission. Notes keep the
  family admission hook before artifact/claim locks; other claim transitions
  acquire no later family lock.
- The pure gate now requires the family coordinate with revision/unit. Its
  existing callers are protocol tests only. SQL admits only recognized A feature
  siblings of the same revision; C model changes, fake rep units, method changes,
  same-unit input drift and new revisions remain entity-gated.
- Both backend names require original dispatch generations after bootstrap.
  The additive verified-dispatch schema carries producer evidence; it never
  reads or stamps current ownership and changes no queued payload.
  `note_verify` cannot cut over while its retained handler and candidate host
  still omit generations. Tests seed explicit historical/restore control rows
  where they need to exercise post-cutover admission, rather than bypassing the
  production cutover guard. Live note obligations still return the exact
  switch-blocking counts before the readiness guard.
- Unknown idempotence checks the original delivery and winner fence first.
  Equal-result idempotence also checks both. Application replay remains
  intentionally independent of send delivery, requires a known result, and
  rejects an unequal application receipt.
- Prepared real-DB interleaves use two dedicated max-1 PostgreSQL connections
  and real transactions. Barriers pause after intent admission, after the real
  switch family-lock SQL, or after note reservation before COMMIT. A third
  observer asserts exact holder/waiter PIDs and family hash in `pg_locks` plus
  `pg_blocking_pids`. Every case asserts the one permitted winner, the rejected
  or held outcome, exact reason/counts and final durable state. The missing-row
  cases start with no effect/control row. A separate existing-row intent/claim
  versus reserve case guards the former lock inversion.

No DB, container, runtime, provider, credential, runtime-lock, push, PR or Linear
action is authorized for this implementation lane. Schema and `0119` need no
change. Parent owns new DB evidence and source-mutant DB negatives.

Prepared DB negative checks, each against this fixed batch with all assertions
retained:

1. Remove only `admitPaidEffectIntent`'s family-lock call. Pending-intent versus
   switch and intent-then-claim versus switch must fail the observable wait;
   switch-first must detect the premature `paid_effect` RowExclusiveLock.
2. Restore the old SQL sibling exemption `same revision AND different unit`.
   C's M1 unknown to M2 case and A's method/malformed-unit cases must fail.
3. Require missing generation only for DBOS. The real pg-boss 0/1/2 round-trip
   and note generation-2 old-job cases must fail.
4. Restore the early unknown return before owner/fence validation. The existing
   new-tick owner assertion and the new stale-fence assertion must fail.
5. Remove note reservation's in-transaction admission hook. The note race must
   fail its exact blocked-family-lock assertion; the fenced note reservation
   must also fail its rollback assertions.

These DB negatives are prepared expectations, not observed results. Parent must
restore the fixed source before running final DB acceptance and R2.


### Local validation for this repair

Node `24.19.0`, pnpm `11.13.1`. Final scoped units passed 20/20 in three
files. Typecheck, lint, lint ratchet and full build passed. Test-policy against
`9bbbd5af9`, partition, schema-writer, task-census, provider-lanes and
provider-attempt-truth audits passed. The lint ratchet is 172 warnings / 0 infos
within the unchanged 210 / 0 baseline.

The capability-boundary audit still fails with four inherited baseline
violations. Running the unchanged audit on an archived `9bbbd5af9` source tree
and this fixed source produced identical dependency snapshots and violations.
This lane added no dependency debt and did not edit the out-of-scope baseline.
Parent must reconcile the existing Notes/durable integration baseline before
claiming the overall gate is green. No Linear action ran under this lane's
explicit restriction.

Two executed unit source-mutant negatives restored the old sibling policy and
DBOS-only missing-generation rule. They failed at the expected assertions:
old gate 2 failed / 11 passed, old generation 1 failed / 12 passed. Fixed source
was restored and final units passed again. Logs and exact diff are in
`/tmp/yuk1355-shared-r1-*`; final commit-bound manifest is
`/tmp/yuk1355-shared-r1-delivery/manifest.json`.

The prepared store file has 28 real-DB cases, including all 22 inherited case
registrations with stronger behavior assertions where R1 changes the rule. No
DB case or DB source-mutant negative ran here. Runtime, provider, cutover,
restore, CI and independent R2 acceptance remain parent-owned.
