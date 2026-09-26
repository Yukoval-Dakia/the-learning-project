// ====================================================================
// YUK-1056 — cutover 队列/订阅处置常量（grounding §14 manifest 口径）
// ====================================================================
//
// 本模块是【策略常量】，无 IO：切换前 final backup manifest 把「每条 pgboss
// 队列在 cutover 如何处置 + 27 条 DLQ tombstone 的处置决定 + 订阅 outstanding
// delivery 翻译语义」作为结构化数据封存。事实来源：
//   - YUK-1042 census：docs/audit/2026-09-25-yuk1042-pgboss-dlq-census.md
//     （27 DLQ 行全部逐类盘点；worker 启动自清；group A 8 条 add_started 待 owner）。
//   - YUK-1055 启动 fences：src/server/contract-epoch/{rules,jobs,boss-fence}.ts
//     （drain/translate/fenced 运行期裁决 + epoch guard）。
//   - YUK-1055 订阅翻译：src/server/event-subscriptions/runtime.ts
//     bootstrapSubscription —— 版本 bump 时 outstanding delivery 按 stable
//     source_event_id 翻译，不盲标 bootstrap_skipped、不盲 replay。
//
// 诚实化：census 计数是【观测值快照】（导出时对账，漂移即不符）；disposition
// 是【已落位策略】；'owner_decision_required' 的行【不做】生产恢复动作 ——
// 本 lane 只登记策略与依据，执行归 owner。

export const DLQ_DISPOSITION_POLICY_VERSION = '2026-09-25-yuk1042' as const;

export type QueueDisposalKind =
  /** 保留 tombstone 行，不做人工干预；下个 worker 启动由 pgboss keep_until 维护自动清除。 */
  | 'archive_drop'
  /** 处置待 owner 显式裁决（ambiguous fence：recover 需 verify-then-release 手工操作）。 */
  | 'owner_decision_required'
  /** 效应用/确认效应已发生；如需重投必须按新合同显式转换，绝不原样 replay。 */
  | 'translate_or_drop'
  /** 队列无积压或有界 drain；cron/active 工作自然恢复，无需处置。 */
  | 'natural_drain';

/** YUK-1042 census §4 处置表（逐 DLQ 组）。`census_rows` 为 2026-09-25 快照观测值。 */
export interface DlqDisposition {
  /** pgboss.job.name（DLQ 队列名，`*_dlq` 后缀）。 */
  queue: string;
  /** census 快照行数（对账用；0 = 盘点时无积压）。 */
  census_rows: number;
  disposition: QueueDisposalKind;
  /** 处置依据（引用 census/rationale；歧义行说明裁决选项）。 */
  rationale: string;
  /** 执行状态：'recorded'=策略已登记无需执行；'auto_purge_on_worker_start'=worker 启动即自清；'owner_pending'=等 owner 裁决。 */
  execution_status: 'recorded' | 'auto_purge_on_worker_start' | 'owner_pending';
  /** owner 需要执行的动作（如有）。 */
  owner_action: string | null;
}

export const DLQ_DISPOSITIONS: readonly DlqDisposition[] = [
  {
    queue: 'dreaming_nightly_dlq',
    census_rows: 2,
    disposition: 'archive_drop',
    rationale:
      '2026-09-16/17 budget_timeout（pre-pi image Agent-SDK 时代瞬时 abort）；后续调度已正常完成，工作已被取代，重投会为过晚窗口重烧 nightly 预算。',
    execution_status: 'auto_purge_on_worker_start',
    owner_action: null,
  },
  {
    queue: 'knowledge_maintenance_nightly_dlq',
    census_rows: 2,
    disposition: 'archive_drop',
    rationale: '同上 —— 09-16/17 streamTask 瞬时 abort；后续 cron 已跑，处置 = tombstone 归档。',
    execution_status: 'auto_purge_on_worker_start',
    owner_action: null,
  },
  {
    queue: 'coach_daily_dlq',
    census_rows: 1,
    disposition: 'archive_drop',
    rationale: '09-18 budget_timeout 瞬时 abort；后续调度已覆盖，tombstone 归档。',
    execution_status: 'auto_purge_on_worker_start',
    owner_action: null,
  },
  {
    queue: 'quiz_gen_dlq',
    census_rows: 1,
    disposition: 'archive_drop',
    rationale:
      '09-17 供给链 budget_timeout；之后 12 个 quiz_gen 正常完成，无特定需求不值得付费重投。',
    execution_status: 'auto_purge_on_worker_start',
    owner_action: null,
  },
  {
    queue: 'quiz_verify_dlq',
    census_rows: 1,
    disposition: 'archive_drop',
    rationale:
      'mimo 空输出 → parse 失败（已知模型输出失败，fail-closed 设计内）。jo3i… 已走重派转 active；vddx47… 留 draft —— 若仍想要该 draft，cutover 后按 1055/1056 verify 路径重派，【不】重投旧 DLQ 行（payload 是旧合同形状）。',
    execution_status: 'auto_purge_on_worker_start',
    owner_action: '如仍需 vddx47… draft：cutover 后在新 verify 路径重派（不复投旧 DLQ 行）。',
  },
  {
    queue: 'note_refine_dlq',
    census_rows: 1,
    disposition: 'archive_drop',
    rationale:
      '目标 artifact 已 generation_status=ready + verification_status=verified；对 08-15 老 artifact 的 refine 属 best-effort 且已过期。',
    execution_status: 'auto_purge_on_worker_start',
    owner_action: null,
  },
  {
    queue: 'memory_event_ingest_dlq',
    census_rows: 11, // group B：enqueue unconfirmed（reconcile dispatch 被 singleton drop）
    disposition: 'translate_or_drop',
    rationale:
      'group B（11 行）：事件已完整抽取（mem0 row + ingest_completed 在位），仅 memory_reconcile 派发因 singletonKey 90s 槽位冲突被 pg-boss send=null 丢弃。observe 模式下 reconcile 意图从未持久化，handoff 无法 replay；reconcile 为 advisory（YUK-690 强制 KEEP_BOTH），丢弃【零业务效应】。建议 drop；如需补 reconcile 须物化意图或按 mem0 结果显式重投 —— 付费且无实质收益。',
    execution_status: 'auto_purge_on_worker_start',
    owner_action:
      '可选：登记 reconcile-completion 审计票（singleton drop 使 send=null 硬失败化了 advisory 派发）。',
  },
  {
    queue: 'memory_event_ingest_dlq',
    census_rows: 8, // group A：recovery_required / add_started 永久 stall
    disposition: 'owner_decision_required',
    rationale:
      'group A（8 行，review 事件 09-17 11:14–11:25）：add_started 标记在位但 0 mem0 行 —— 协议无法区分「付费 add 未落库」与「add 前崩溃」，claimMemoryIngest 按设计 fail-closed。恢复需显式 fence 裁决：(a) 核验外部真相（mem0 lookup 两次返回 0 = add 未落证）后移除标记重 ingest（8 次付费 add），或 (b) 接受 8 条 review 事件在 fact 层缺席（影响限 memory/brief 质量）。本 lane 不执行生产恢复。',
    execution_status: 'owner_pending',
    owner_action:
      '裁决 (a) verify-then-release 重 ingest（~8 次付费 add），或 (b) 接受缺席并记录。裁决前 tombstone 保留（worker 启动会清 DLQ 行——先导出 tombstone 存档，见 cutover-final-backup.sh）。',
  },
];

/** 全部 DLQ 处置行的 census 合计（对账：导出时按队列聚合比对）。 */
export function dlqCensusTotal(): number {
  return DLQ_DISPOSITIONS.reduce((sum, row) => sum + row.census_rows, 0);
}

// ───────────────────── 非 DLQ 队列的 cutover 处置语义 ─────────────────────
//
// 运行期裁决归 YUK-1055 JOB_EPOCH_DISPOSITION（drain/translate/fenced），
// 本表只把【策略语义】固化进 manifest —— 不复制分类表本体（单源在
// src/server/contract-epoch/jobs.ts）。

export const CUTOVER_QUEUE_SEMANTICS = {
  drain: '队列语义与判分/作答合同无关；任一 active epoch 下运行均正确。',
  translate:
    'payload 绑定旧合同；不在 epoch 不匹配时运行，由迁移/运维显式转换或按 runbook 处置（不删、不无限重试）。',
  fenced:
    '未枚举队列与 *_dlq 恢复队列默认 fenced：ContractEpochFenceError → 重投预算耗尽后落 failed/DLQ，不静默吞掉。',
} as const;

// ───────────────────── 订阅 outstanding 处置 ─────────────────────

export const SUBSCRIPTION_OUTSTANDING_POLICY = {
  /** YUK-1055 runtime.ts bootstrapSubscription：版本 bump 时按 stable source_event_id 翻译 outstanding delivery —— 不盲标 bootstrap_skipped，不盲 replay 历史。 */
  translation: 'translate_outstanding_stable_id',
  /** checkpoint status 词表（event_subscription_checkpoint.status 观测值）。 */
  checkpoint_statuses: ['active', 'bootstrap_skipped', 'stalled'] as const,
  note: 'pending 交付按 delivery 行级 stable id 保留；manifest 记录 checkpoints + delivery_by_status 作 disposition 对账。',
} as const;

// ───────────────────── contract epoch（引用，不复制） ─────────────────────
//
// preparing/ready/active 状态机与 CODE_CONTRACT_EPOCH/ASSESSMENT_CONTRACT_EPOCH
// 单源在 src/server/contract-epoch/rules.ts —— manifest 记录其值，不重复定义。

export const CUTOVER_OWNER_ACTIONS = [
  '执行 final backup（cutover-final-backup.sh）：pg_dump + DLQ tombstone 导出 + migration:capture manifest（生产读面，owner-gated）。',
  '裁决 memory_event_ingest_dlq group A（8 条 add_started）：verify-then-release 重 ingest 或接受缺席。',
  'restore 演练按 runbook 排期执行并归档 evidence（scripts/restore-drill.sh 产出 JSON）。',
  '停全部 writer 后核验 manifest queues/owner_actions 对账一致，再进入 preparing。',
] as const;
