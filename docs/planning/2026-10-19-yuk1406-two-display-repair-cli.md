# YUK-1406 两题 select label 显示修复运营 CLI（LIGHT 第一批）

阶段：**第一天能用**。关联：Refs YUK-1406（不关闭整票——其余 3 个 withheld 题不在本批）。

## 批准范围（冻结）

批准依据（均为仓库外冻结 artifact，运行时按路径+sha 核对，不把原文复制进库）：

- `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1406-stock-math-census-20261019/plan.md`
- `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1406-stock-math-census-20261019/first-batch-proposed-display-diff.json`（sha256 `22d50ce7…8d311`）
- `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1406-stock-math-census-20261019/stock-snapshot.json`
- `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1406-stock-math-census-20261019/canonical-execution-contract-d41.md`（固定执行契约）

两题、三处 patch，全部信息硬编码在 `scripts/yuk1406-repair-select-display.ts` 的
`APPROVED_REPAIR_SET`（选择「脚本内固定批准集合」而非外部 manifest-SHA 方案，使批准面
与发布 HEAD 一并受审）：

| group | source | question.version | current revision | admission gen | current digest |
| --- | --- | --- | --- | --- | --- |
| `cooygx01cb5iz5uqmln990lo` | quiz_gen | 1 | `r1vwwtbnei558aumi4zldej0` | 4 | `sha256:39683eef…ae39ad` |
| `ubm6yaiw98qdnpddjrjbnc78` | web_sourced | 2 | `b3od34uhqb5mw9rt7hdwj3ex` | 5 | `sha256:b57b535a…8af2e0` |

- `cooygx…::r` `opt_fdc7c7d5cbb9`（order 2）与 `opt_521d4d7a30fe`（order 3）；
  `ubm…::r` `opt_d4fdf0da62c9`（order 1）。
- `before` = 当前 revision 存储 `items[].label_md` 逐字（含修复前的 `C. `/`D. `/`B. `
  字母前缀）；`after` = 批准 diff 的 `preview.newSelectLabelBody`（#1827 正文-only 契约）。
- 其它 item 的 label 逐字保留（含 A/B 前缀），不做顺便清理；这是核准的**显示**修复，
  不推断或触碰任何数学边界、答案、评分规则。
- 已批准的付费上限：本批合计 **$0.05**（正常自动准入的 A/B + 适用 crosscheck 校准）。

## 运行方式

```bash
# 只读评估（零业务写）：frozen CAS + 重封校验 + slot/item/order/before 恒等
# + 幂等探测（带 --request-id 时）+ 未结准入守卫 + 真实可出数门
pnpm exec tsx scripts/yuk1406-repair-select-display.ts plan \
  --manifest <file> [--out <dir>] [--request-id <id>]

# 一次只允许一个 group；五要素必需
pnpm exec tsx scripts/yuk1406-repair-select-display.ts apply \
  --manifest <file> --group <group_id> --operator <name> \
  --reason "<why>" --request-id <id> --out <dir> --stop <path>
```

manifest 是严格 zod schema（`.strict()`，未知字段拒绝）：`version:1` +
`approval{plan_doc,diff_file,diff_sha256,contract_doc,budget_cap_usd}` +
`groups[]`（每题 source/question_version/current_revision_id/
current_integrity_digest/admission_generation/admission_state +
`select_slot{slot_id,part_id,expected_item_ids}` + `patches[]`）。
`assertManifestMatchesApproval` 把 manifest 与 `APPROVED_REPAIR_SET` 深度比对
（组级顺序无关、patch 顺序无关）：缺批准组、组外组、重复、>2 组、>3 patch、
任何字段漂移都拒绝。

## 不变量与守卫

- **STOP**：`--stop` 必需。`access(F_OK)` 下 ENOENT 视为无 STOP；文件存在或其它
  I/O 错误一律 fail closed。apply 开头查一次，事务内 publish 前再查一次。
  STOP 只挡本 CLI 的下一次发布，不撤销已提交发布、不截断已入队任务，
  也不是全局付费闸。
- **输出目录**：apply 前先 `mkdir -p` + 写探针文件证实可写，再进事务。
- **锁序与共同串行**：apply 事务先取操作级
  `pg_advisory_xact_lock(hashtextextended(OPERATION,0))`——覆盖本批准集两组，
  持到提交/回滚。两个并发 apply（同 request 跨组、或两组同时）在
  binding/guard 读取前就被串行化，不会双双读到「无绑定/无在飞」而重复发布
  （`question_revision` 无 request_id 唯一约束，故需显式边界）。该行级锁
  之后仍是 `lockAdmissionGroup`（root question FOR UPDATE → lifecycle
  FOR UPDATE），与 publisher/准入入队一致；其它写入方不取 advisory key，
  不构成死锁环。
- **root 恒等**：`parent_question_id IS NULL`、`source`、`question.version`
  与冻结值逐字相等。
- **幂等（DB 真相）**：新 revision 的 `published_by` 记录 operation /
  request_id / operator / reason / manifest_sha256 / 旧完整 identity（revision、
  digest、generation、question_version）/ 新 digest / 新 generation / patch 字段。
  同一 `request_id` 且绑定逐字段一致 → `already_applied`（返回原 revision/digest/
  event/generation）；request_id 绑到不同组或不同输入 → 拒绝。本地回执丢失、
  后台准入已推进，都不会触发重发布——按 `published_by->>'request_id'` 查回。
  原发布 event 的找回绑定**完整身份**（本 CLI actor、outcome=success、
  revision_id、integrity_digest、supersedes_revision_id、revision_ordinal、
  admission_generation、admission='withheld'，且无 dimension_update/
  verification 键），唯一匹配才返回；缺失或歧义 fail closed——同 revision
  的后续 dimension/准入事件不会被误认作原事件。
- **冻结 CAS**：`lifecycle.current_revision_id`、`scoring_admission_generation`、
  `scoring_admission_state='admitted'`、非 withdrawn/suspended、`revision.integrity_digest`
  全部与冻结值相等；任何漂移拒绝，不临时换最新值。
- **重封校验**：从真实当前 revision 读四层 + presentation（冻结 census 快照本
  身没有评分层——绝不重建或伪造），`publishedContractSeal` 重算并
  `publishedSealAccepts` 核对存储 digest；结构/槽/item 恒等与顺序、每个目标
  `label_md` 与 `before` 逐字相等。
- **只改三处 label**：克隆解析后契约、改值、再 `publishedContractSeal` 得新
  canonical digest；回滚检查（revert 后 canonical 与解析契约相等）证明除批准
  label 外零改动；新 digest 与旧不同（相同拒绝发布）。
- **未结准入守卫**（发布前，任一条命中即拒发并列出明细）。全部业务探针在
  **同一条 SQL**（CTE/union）里执行——同一快照，delivery 结算为 succeeded
  与 handler 提交 job 的交接不会从逐条 READ COMMITTED 间漏过；
  `to_regclass('pgboss.job')` 只是 schema 存在性探测（无 pgboss 的临时库上
  跳过该臂），不算业务读。订阅者 (id, version, actions) 直接取自
  `practiceCapability.subscriptions` 生产声明，版本升级自动换键，不猜。
  - 全局：`pgboss.job` 在飞 `question_admission_run`（created/retry/active）；
  - 全局：该订阅 id+version 的未结 delivery（pending/claimed/retry_wait）；
  - 全局：该订阅 actions 内、按 (subscriber_id, subscriber_version,
    source_event_id) 反连接**尚无 delivery 行的发布事件，不限年龄**——
    与 dispatcher discovery 谓词逐字一致；bootstrap 之前的历史由显式
    `bootstrap_skipped` 行覆盖，不存在「超龄即视为已派发」的截止；
  - 全局：admission family 非终态 `paid_effect`（pending/sending/receipt_ready）；
  - 本批组：该订阅 dead_letter delivery、该组 `paid_effect state='unknown'`
    ——本窗口结算已失败，下一题停（历史 unknown 不动、不阻塞）。
- **发布参数**（同一事务内 `publishQuestionGroup`）：
  `expectedCurrentRevision`/`expectedAdmissionGeneration` = manifest 冻结值；
  `availability` 沿 lifecycle 现值；`claimPolicy`/`suspension` 不传（保持）；
  `admission={state:'withheld',reason:'unverified_rules'}`，不携旧 evidence；
  不传 `verification`（不伪造 passed）；`actorRef='ops:yuk1406-repair-select-display'`。
  返回非 `published`（noop/admission_updated/conflict/withdrawn）一律抛错回滚。
- **不触碰**：question 行（prompt/choices_md/version/reference）、paid_effect、
  question_admission_verification、issuance、PDF、旧 revision（不可变）、
  embedding 列、`question.choices_md`（准入成功后由 admission job 的既有投影写入，
  不为绕未准入门先改）。
- **回执**：事务结果先于回执文件产生；回执写失败不误报未提交——stdout/stderr
  明确 `transaction_committed`，凭同一 `--request-id` 从 DB 找回原 identity。
  exit code：published/already_applied=0，blocked/throw=1，回执写失败=2。

## 副作用与费用边界

- 发布本身只写 canonical revision / lifecycle / publish event；不直接
  `verify_enqueued`、不写 embedding、不调 provider、不 `boss.send`。
- 新 withheld 发布事件经既有 `practice.question-admission-enqueue` 订阅自然入队
  `question_admission_run`：A/B（含适用 crosscheck/校准）可对**新 digest** 付费；
  旧 passed 证据不越代适用。该事件 actor 非 `practice:question_admission`，
  不会形成递归准入。
- 发布后组为 withheld → **暂不可发**，直至新准入 verdict admitted；
  `readAutomaticallyServableQuestionIds` 在 plan/apply 回执里报真实发行门状态。
- 走 pure publisher，不经 `server/questions/write.ts`：不触发其 embed-NULL 逻辑，
  本修复不直接派生 embedding 费用。旧向量可能因内容 hash 变化被读侧拒用；
  `embed_backfill` 只按 NULL/版本过期选行，不按 hash 失配选——这是既有回填边界，
  本次不为此追加付费、不手动清列。
- `reference_backfill` 等其它 cron 与本发布无订阅后继关系，同窗运行不等于本次
  因果。
- 运营顺序（属迁移线执行）：`plan` → apply 第一题 → 等原事件自然结算并核
  canonical paid/task-run 真实费用、路由与异常 → 再 apply 第二题。合计上限
  $0.05；出现 unknown/4xx/错路由/其他 group 或其他任务 → 停止下一题并报告，
  禁止自动重放 unknown。

## NOT_RUN（本 lane 不执行）

DB、容器、provider、业务 HTTP、运行锁、`plan`/`apply` 实际执行、新题发行、
PDF——全部由迁移线在有窗口的真实副本/生产按授权运行。本 PR 仅含 CLI 与本文档，
附静态验证：`pnpm typecheck`、`pnpm exec biome check`、`pnpm build`、相关既有
audit。日志存 `cli-author-checks/`（仓库外 tlp-status 目录）。
