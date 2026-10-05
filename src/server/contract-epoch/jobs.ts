// ====================================================================
// YUK-1055 — pgboss outstanding job 处置分类（零 import，unit-partition 可测）
// ====================================================================
//
// cutover 时 pgboss 存量任务（YUK-1042 盘点对象）的三类处置：
//   'drain'     — 队列语义与判分/作答合同无关，或本身只产出触发；在任一
//                 active epoch 下运行都是正确的（含 fenced 短停后恢复）。
//   'translate' — payload 绑定旧合同（frozen question/profile/答案载体等），
//                 不能按原语义执行；须由迁移/运维显式转换或按 runbook 处置，
//                 绝不在 epoch 不匹配时运行。
//   'fenced'    — 默认兜底（含全部未列出队列与 *_dlq 恢复队列）：在错误
//                 epoch 下拒绝执行（ContractEpochFenceError → 重投预算耗尽
//                 后按既有 retry policy 落 failed/DLQ，不静默吞掉）。
//
// 运行期裁决见 boss-fence.ts：'drain' 只要求 state='active'（不比较 epoch 名），
// 'translate'/'fenced' 要求 marker.epoch === CODE_CONTRACT_EPOCH。
// 本表是 fail-closed 默认值：未枚举队列一律 'fenced'（宁可误拒，不可误跑）。

export type JobEpochDisposition = 'drain' | 'translate' | 'fenced';

/**
 * 显式分类表。key = pgboss queue name（pgboss.job.name）。
 * 维护纪律：新队列不在此表即 'fenced'；把队列改成 'drain'/'translate' 需要
 * 在注释里给出「为何与评估合同无关 / 为何必须显式转换」的一句话依据。
 */
export const JOB_EPOCH_DISPOSITION: Readonly<Record<string, JobEpochDisposition>> = {
  // ── drain：合同无关的 housekeeping / 只产触发 / 纯元数据清扫 ──
  // golden E2E 探针：无业务写。
  echo: 'drain',
  // job 遥测与孤儿会话清扫：只写运维/session 状态机表。
  prune_job_events: 'drain',
  prune_orphan_review_sessions: 'drain',
  prune_orphan_conversation_sessions: 'drain',
  prune_orphan_placement_sessions: 'drain',
  promote_conversation_idle: 'drain',
  // 订阅分发驱动：delivery 行本身已含 stable idempotency；版本翻译由
  // bootstrap 处理（runtime.ts），分发器只按寄存表跑当前版本。
  event_subscription_dispatch: 'drain',
  // 编排器只enqueue成员 job；成员各自带 disposition 自查。
  nightly_orchestrator: 'drain',
  // 被卡死的 provider run 对账/剪枝：运维真相表，与判分合同无关。
  ai_task_run_reconcile_nightly: 'drain',
  copilot_run_reconcile: 'drain',
  // mem0 管道：事件 outbox 摄取与简brief再生成是 epoch 无关的后台效应
  // （迁移不重放、不删 fact；grounding §9 memory triggers 不重发约束由
  // apply/replay lane 保证，不关队列态）。
  memory_event_ingest: 'drain',
  memory_brief_regen: 'drain',
  memory_brief_sweep: 'drain',
  memory_ingest_outbox_poll: 'drain',
  memory_ingest_outbox_recover: 'drain',
  memory_reconcile: 'drain',
  // 投影/审计类只读或写运维投影：不碰判分/作答真相。
  projection_oracle_sweep: 'drain',
  subject_profile_audit_nightly: 'drain',
  merge_attribution_sweep: 'drain',
  kg_borrow_shadow_sweep: 'drain',
  hub_auto_sync_nightly: 'drain',
  hub_sync_mutation_wake: 'drain',
  hub_sync_recovery: 'drain',
  note_verify: 'drain',
  note_generate: 'drain',
  note_refine: 'drain',

  // ── translate：payload/效应绑定旧判分·题目合同，须显式转换 ──
  // 判分执行链：frozen question/profile/body 属旧合同（grounding §4.2）。
  judge_run: 'translate',
  judge_pending_reconcile: 'translate',
  rejudge: 'translate',
  judge_calibration_sample: 'translate',
  // 题面供给/验证写口（旧 mutable question 行 + draft_status 语义）。
  quiz_gen: 'translate',
  quiz_verify: 'translate',
  source_verify: 'translate',
  variant_gen: 'translate',
  variant_verify: 'translate',
  supply_execute: 'translate',
  attribution_followup: 'translate',
  reference_answer_backfill: 'translate',
  answer_class_backfill: 'translate',
  // 干预诊断冻结上下文与发题绑定（§1 矩阵 intervention diagnostic 行）。
  prepare_intervention: 'translate',
  intervention_prepare_recovery: 'translate',
  // 摄入管线会直接写 question/answer 面（auto_enroll 判分也在 §4.2 表内）。
  ingestion_operation: 'translate',
  auto_enroll: 'translate',
  tencent_ocr_extract: 'translate',
  // durable verify intent 引用 pre-cutover 题行；恢复触发本身也是旧意图。
  verify_dispatch_recover: 'translate',
  // 校准/估计写难度与掌握投影 —— 输入是旧合同 attempt。
  item_prior_backfill: 'translate',
  recalibration_nightly: 'translate',
  kt_estimate_nightly: 'translate',
  axis_state_nightly: 'translate',
  embed_backfill: 'translate',
  kc_dedup_nightly: 'translate',
  confusable_contrast_nightly: 'translate',
  // 对话/提案型任务的 payload 引用题面/答题上下文（旧形态）。
  copilot_run: 'translate',
  session_summary: 'translate',
  coach_daily: 'translate',
  coach_weekly: 'translate',
  dreaming_nightly: 'translate',
  goal_scope_propose_nightly: 'translate',
  research_meeting_nightly: 'translate',
  research_meeting_agent_nightly: 'translate',
  frontier_fill_nightly: 'translate',
  knowledge_edge_propose_nightly: 'translate',
  knowledge_maintenance_nightly: 'translate',
  practice_stream_compose_nightly: 'translate',
  question_supply_nightly: 'translate',
  supply_planner: 'translate',
  jyeoo_staged_asset_reap: 'drain', // 资产回收只删 staged 文件/行，合同无关。
};

/** DLQ 恢复队列后缀（pg-boss `<queue>_dlq`）。 */
const DLQ_SUFFIX = '_dlq';

/**
 * 队列 → 处置分类（fail-closed：未枚举与 *_dlq 一律 'fenced'）。
 * DLQ 行永远不会被自动重放——它们是人工恢复残骸箱，只能 'fenced'。
 */
export function jobEpochDisposition(queueName: string): JobEpochDisposition {
  if (queueName.endsWith(DLQ_SUFFIX)) return 'fenced';
  return JOB_EPOCH_DISPOSITION[queueName] ?? 'fenced';
}
