# YUK-1547 — frozen42 scoped admission manifest + paid-apply derivative binding

Date: 2026-10-19. Stage: 第一天能用（W0）/ harness C1·C2·C6. Refs YUK-1547, YUK-1507.

## 背景

- Stage1 backlog 协调线批准了对固定 42 题队列执行正常付费准入：41 题
  `quiz_gen` / `marking_provenance=system_verified` + 1 题 `web_sourced` /
  `official`。成员冻结于
  `review/stage1-backlog112-20261019/yuk1547-p0-missing42-provenance-snapshot.json`
  （sha256 `4174af8532f222dca1c8dd2e4df8ff84f89513aa11052ff0216bcc804e224642`），
  分类为 `direct_admitted_without_dual_solve_receipt` ×42 —— 全部已 `admitted`
  但缺付费双解回执。
- 现部署的 backlog driver（commit `c779f1ad8` 起）`eligibilityFailure` 硬限定
  `source='web_sourced'` + `marking_provenance='official'`（112 窗口遗留），
  41 题 quiz_gen 因此全体被拒。
- #1816（`f7d8acb0a`）之后，付费 apply 在 admitted 判定时发布 resolved 契约：
  `question_admission_run` 以 `practice:question_admission` actor 调
  `publishQuestionGroup`，铸新 revision、`admission_generation` 进位、同事务
  提交 `experimental:assessment_publish` 事件 + `application_json`。

## 变更（仅 `scripts/yuk1547-admission-backlog.ts`）

### 1. 版本化显式 scope manifest

两种形状并存，按文件内容自动判定（数组=旧，对象=新）：

- **Legacy 数组**（112 窗口原样）：zod strip 后 digest，与已封 baseline
  `manifest_sha256` 完全同式，重开兼容逐字节保持；eligibility 保持
  `web_sourced`/`official` 硬编码缺省。
- **Scoped 对象** `{version: 1, scope: {...}, items: [...]}`：
  - `scope.id` 必填（cohort 身份），`scope.actor_ref` 可选；scope 与其余
    passthrough 字段全部进入 raw-input digest —— 输入完整绑定。
  - 每项必须声明 `source` 与 `marking_provenance`（可选 `state`），加上既有
    `id`/`version`/`revision_id`/`generation`/`integrity_digest`/
    `question_updated_at`/`lifecycle_updated_at`/`suspended`/`created_at`。
  - eligibility 逐项严格相等：DB 值 ≠ 清单声明 → failure（fail-closed）。
    不引入任何 skip/bypass 标志，不放宽既有 admitted/未挂起/未撤回/root/
    无 prior paid/无未结 job 约束。
  - 补充严格绑定（同样适用于 legacy 行，fail-closed 方向）：
    `suspended` 布尔与 `lifecycle_updated_at`（声明时）必须与 DB 一致。

### 2. Cohort actor 解析

- Legacy manifest → 旧 actor `stage1:backlog_readmission_b_112_20261019`
  逐字节保留（重开兼容）。
- Scoped manifest → `scope.actor_ref ?? 'stage1:<scope.id>'`，如实记录本
  cohort，不冒充 112。
- 已核所有窗口归因不依赖 actor：`windowOwnedEvents`（event_id + 三元组）、
  `windowInFlightSends`（intent → 三元组）、queue gate（同上 + 派生绑定）、
  settle 绑定（paid input 身份）全部不使用 actor_ref；enqueue handler 仅对
  `practice:question_admission` 特判 skip，其他 actor + `admission='withheld'`
  正常入队 → 换 actor 不破坏重开归因也不影响入队。

### 3. 派生事件绑定（#1816 缺口）

**可达缺口**：subscriber discovery 对所有 `assessment_publish` 事件无条件
insert `pending` delivery（`src/server/event-subscriptions/runtime.ts`
discovery anti-join 仅按 action 过滤）。付费 apply 的派生发布事件（新
revision / dimension_update，actor=`practice:question_admission`，
`admission_generation = send代 + 1`）会短暂产生非终态 delivery，被既有
gate 判为 foreign → 无谓 `queue_not_empty` STOP。

**修复（仅本 CLI）**：queue gate 的单条 SQL 内新增 `derived_event_ids`
子查询，与 pending_jobs/deliveries/undiscovered 共享同一 READ COMMITTED
快照。事件被认作本窗派生需同时满足：

- `actor_ref = 'practice:question_admission'`、`outcome='success'`；
- `payload.group_id` 命中本窗已记录 send 三元组 `(group, R, G)`；
- `payload.admission_generation = G + 1`；
- `payload.supersedes_revision_id`（dimension_update 缺省→R）= R；
- 存在 `paid_effect` applied @3 行：`input_json` 精确等于 `(group, R, G)`，
  且 `application_json.revision_id` = 事件 revision、
  `application_json.status` = 事件 admission；
- 非 dimension_update 事件另需新 revision 的
  `question_revision.published_by.paid_receipt.{input_digest,unit}` 绑定同
  一 paid 行。

事件与 `application_json` 同事务提交，绑定不可能指到 application 未记录
的事件；不按题号/actor/时间泛化豁免；派生 delivery 在 handler 中无条件
skip（actor 检查），永远不可能变成付费工作，owning 它不会吞掉真实未结
准入。其余外来 job/delivery/event 一律照原规则 STOP。

## 保持不变

- `sending`/`unknown`/`receipt_ready` paid 状态机、CAS/事务锁、STOP
  fail-closed、逐题 settle 后再发下一题、--sent 防重放。
- 313 条历史 ledger 必需且逐笔 `unknown_reserve` 绑定：cumulative 阈值比
  `knownUsd`，hard cap 比 `knownUsd + reserve` —— 语义原样，未见变动。
- 归因仍只走 paid receipt canonical id；新目录缓存不改归因层。
- `check`/`drive` CLI 面不变；scoped manifest 由形状自动判定。

## 证据源（只读封存）

- `review/stage1-backlog112-20261019/yuk1547-p0-missing42-provenance-snapshot.json`
  sha256 `4174af85…4642`（冻结成员 + provenance）。
- `review/stage1-frozen42-prep-20261019/current-bindings-readonly.json`
  sha256 `232cd000…c8`（42 项 current 绑定 + source/provenance，无漂移）—
  正式 manifest 由协调线按本 schema 生成，非本文件。

## NOT_RUN（本任务边界）

- 未读 TEST DB、未跑容器/锁/provider/付费、未编辑外部冻结证据。
- 无断言/测试代码（owner 规则）；验证仅 typecheck/lint/build 与只读分析。
- 真实窗口前置（父 lane）：生成正式 scoped manifest（42 项按
  `current-bindings-readonly.json`）、preflight receipt、合并后 ledger、
  `--sent` 名单、部署本 CLI 后开窗 drive。
