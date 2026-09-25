import { inArray, sql } from 'drizzle-orm';

import { sha256Hex } from '@/core/migration/canonical';
import type {
  CaptureEnvironment,
  MigrationCapture,
  RawAnswerRow,
  RawAxisRow,
  RawDifficultyLabelRow,
  RawEventRow,
  RawFamilyCalibrationRow,
  RawFsrsRow,
  RawItemCalibrationRow,
  RawKcTypedRow,
  RawLearningRecordMirrorRow,
  RawMasteryRow,
  RawQuestionLineageRow,
  RawSelectionObservationRow,
  RawSessionRow,
  RawSourceAssetRow,
} from '@/core/migration/types';
import type { Db, Tx } from '@/db/client';
import {
  answer,
  difficulty_calibration_label,
  event,
  item_calibration,
  item_family_calibration,
  kc_typed_state,
  learner_axis_state,
  learning_record,
  learning_session,
  mastery_state,
  material_fsrs_state,
  question,
  selection_observation,
  source_asset,
} from '@/db/schema';

// ====================================================================
// YUK-1048 — cutover checkpoint 捕获 reader（grounding §13）
// ====================================================================
//
// 精确观测，不是重算，也不是 replay 证明：
//   - 全部读取在【一个】REPEATABLE READ + READ ONLY 事务内（drizzle
//     accessMode:'read only' → BEGIN 后第一条 `SET TRANSACTION … READ ONLY`）。
//     REPEATABLE READ 给整个捕获一个一致快照（参照 capture-golden K4）；
//     READ ONLY 让「绝不写目标库」由 DB 强制，不靠自觉。
//   - 只 SELECT/带 WITH 的探测；pgboss 与迁移表先探 schema（to_regclass），
//     不存在则显式降级（present:false），不抛错。
//   - 可变运维字段（event.ingest_at、*.updated_at、answer.autosaved_at 等）
//     与不可变事实分开返回 —— canonical hash 只覆盖事实（§14）。
//
// 本模块【不写】任何表（包括平行 lane YUK-1044 的新表 —— 那些表在本
// worktree 不存在；分类目标以 src/core/migration/types.ts 的
// MigrationTargetRef 接缝表达）。

/** 捕获的事件动作集合（封闭集合；classifier 对每个成员都有规则）。 */
export const ASSESSMENT_EVENT_ACTIONS = [
  'attempt',
  'judge',
  'review',
  'correct',
  'experimental:judge_pending_attempt',
  'experimental:grading_checkpoint',
  'experimental:state_snapshot',
  'experimental:reproject_deferred',
] as const;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoRequired(value: Date | string): string {
  return iso(value) as string;
}

interface EnvProbeRow {
  [key: string]: unknown;
  snapshot_at: Date;
  server_version: string;
  database_name: string;
  host_endpoint: string | null;
}

interface MigrationProbeRow {
  [key: string]: unknown;
  present: boolean;
  n: number | null;
}

/**
 * 捕获迁移 cutover checkpoint。READ ONLY —— 幂等：同一 DB 状态重复调用
 * 返回语义等价的观测（rawFacts 逐字节稳定；environment.snapshot_at 是快照
 * 时刻，随快照变化，不进事实哈希）。
 */
export async function captureMigrationCheckpoint(db: Db): Promise<MigrationCapture> {
  return db.transaction(
    async (tx) => {
      const env = await readEnvironment(tx);
      const rawFacts = await readRawFacts(tx);
      const ops = await readOpsFields(tx);
      const queues = await readQueues(tx, env.pgboss_schema_present);
      const subscriptionCheckpoints = await readSubscriptionCheckpoints(tx);
      const subscriptionDeliveries = await readSubscriptionDeliveries(tx);
      const aiTaskRuns = await readAiTaskRunCounts(tx);

      return {
        capture_schema_version: 1,
        environment: env,
        rawFacts,
        ops,
        queues,
        subscription_checkpoints: subscriptionCheckpoints,
        subscription_deliveries: subscriptionDeliveries,
        ai_task_runs: aiTaskRuns,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function readEnvironment(tx: Tx): Promise<CaptureEnvironment> {
  const envProbe = await tx.execute<EnvProbeRow>(sql`
    select
      now() as snapshot_at,
      current_setting('server_version') as server_version,
      current_database() as database_name,
      case when inet_server_addr() is null then null
           else inet_server_addr()::text || ':' || coalesce(inet_server_port()::text, '')
      end as host_endpoint
  `);
  const envRow = envProbe[0];
  if (envRow === undefined) {
    throw new Error('migration capture: environment probe returned no rows');
  }

  const pgbossProbe = await tx.execute<{ present: boolean }>(
    sql`select to_regclass('pgboss.job') is not null as present`,
  );
  const migrationProbe = await tx.execute<MigrationProbeRow>(sql`
    select
      to_regclass('drizzle.__drizzle_migrations') is not null as present,
      case when to_regclass('drizzle.__drizzle_migrations') is not null
           then (select count(*)::int from drizzle.__drizzle_migrations)
           else null
      end as n
  `);

  return {
    snapshot_at: isoRequired(envRow.snapshot_at),
    db_server_version: envRow.server_version,
    database_name: envRow.database_name,
    host_fingerprint:
      envRow.host_endpoint === null
        ? sha256Hex('unknown-endpoint').slice(0, 12)
        : sha256Hex(envRow.host_endpoint).slice(0, 12),
    migrations_applied: migrationProbe[0]?.n ?? null,
    pgboss_schema_present: pgbossProbe[0]?.present === true,
    isolation: 'repeatable read read only',
  };
}

async function readRawFacts(tx: Tx): Promise<MigrationCapture['rawFacts']> {
  const eventRows = await tx
    .select({
      id: event.id,
      dispatch_seq: event.dispatch_seq,
      session_id: event.session_id,
      actor_kind: event.actor_kind,
      actor_ref: event.actor_ref,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
      caused_by_event_id: event.caused_by_event_id,
      affected_scopes: event.affected_scopes,
      task_run_id: event.task_run_id,
      cost_micro_usd: event.cost_micro_usd,
      created_at: event.created_at,
    })
    .from(event)
    .where(inArray(event.action, [...ASSESSMENT_EVENT_ACTIONS]))
    // 确定性顺序：UPDATE 会移动堆内元组物理位置，无 ORDER BY 的 SELECT
    // 顺序随物理顺序漂移 → 同一事实集哈希不稳（幂等被破坏）。按 id 排序。
    .orderBy(event.id);
  const events: RawEventRow[] = eventRows.map((r) => ({
    ...r,
    session_id: r.session_id ?? null,
    outcome: r.outcome ?? null,
    caused_by_event_id: r.caused_by_event_id ?? null,
    task_run_id: r.task_run_id ?? null,
    cost_micro_usd: r.cost_micro_usd ?? null,
    created_at: isoRequired(r.created_at),
  }));

  const eventActionCountRows = await tx.execute<{ action: string; count: number }>(sql`
    select action, count(*)::int as count from event group by action order by action
  `);
  const event_action_counts = eventActionCountRows.map((r) => ({
    action: r.action,
    count: Number(r.count),
  }));

  const fsrsRows = await tx
    .select({
      id: material_fsrs_state.id,
      subject_kind: material_fsrs_state.subject_kind,
      subject_id: material_fsrs_state.subject_id,
      state: material_fsrs_state.state,
      due_at: material_fsrs_state.due_at,
      last_review_event_id: material_fsrs_state.last_review_event_id,
    })
    .from(material_fsrs_state)
    .orderBy(material_fsrs_state.id);
  const fsrs: RawFsrsRow[] = fsrsRows.map((r) => ({
    ...r,
    due_at: isoRequired(r.due_at),
  }));

  const masteryRows = await tx
    .select({
      id: mastery_state.id,
      subject_kind: mastery_state.subject_kind,
      subject_id: mastery_state.subject_id,
      theta_hat: mastery_state.theta_hat,
      evidence_count: mastery_state.evidence_count,
      success_count: mastery_state.success_count,
      fail_count: mastery_state.fail_count,
      last_outcome_at: mastery_state.last_outcome_at,
      theta_precision: mastery_state.theta_precision,
      last_theta_delta: mastery_state.last_theta_delta,
      theta_grid_json: mastery_state.theta_grid_json,
      rt_correct_ms: mastery_state.rt_correct_ms,
      calibration_residual: mastery_state.calibration_residual,
      fluency_illusion_flag: mastery_state.fluency_illusion_flag,
    })
    .from(mastery_state)
    .orderBy(mastery_state.id);
  const mastery: RawMasteryRow[] = masteryRows.map((r) => ({
    ...r,
    last_outcome_at: iso(r.last_outcome_at),
    last_theta_delta: r.last_theta_delta ?? null,
    calibration_residual: r.calibration_residual ?? null,
    fluency_illusion_flag: r.fluency_illusion_flag ?? null,
  }));

  const kcTypedRows = await tx
    .select({
      id: kc_typed_state.id,
      subject_kind: kc_typed_state.subject_kind,
      subject_id: kc_typed_state.subject_id,
      typed_state: kc_typed_state.typed_state,
      confused_with_kc_id: kc_typed_state.confused_with_kc_id,
      lifecycle: kc_typed_state.lifecycle,
      evidence_event_ids: kc_typed_state.evidence_event_ids,
      last_evidence_at: kc_typed_state.last_evidence_at,
    })
    .from(kc_typed_state)
    .orderBy(kc_typed_state.id);
  const kc_typed: RawKcTypedRow[] = kcTypedRows.map((r) => ({
    ...r,
    last_evidence_at: iso(r.last_evidence_at),
  }));

  const axisRows = await tx
    .select({
      id: learner_axis_state.id,
      subject_kind: learner_axis_state.subject_kind,
      subject_id: learner_axis_state.subject_id,
      drift_v: learner_axis_state.drift_v,
      boundary_a: learner_axis_state.boundary_a,
      ter: learner_axis_state.ter,
      n_obs: learner_axis_state.n_obs,
      provenance: learner_axis_state.provenance,
    })
    .from(learner_axis_state)
    .orderBy(learner_axis_state.id);
  const axis: RawAxisRow[] = axisRows.map((r) => ({
    ...r,
    drift_v: r.drift_v ?? null,
    boundary_a: r.boundary_a ?? null,
    ter: r.ter ?? null,
  }));

  // item_calibration：软轨占位列（irt_a/irt_c/cdm_json/kt_json —— audit allowlist
  // manual stub）不进捕获；硬轨与 b_anchor/b_calib 分离链是事实。
  const itemCalibrationRows = await tx
    .select({
      id: item_calibration.id,
      question_id: item_calibration.question_id,
      b: item_calibration.b,
      confidence: item_calibration.confidence,
      track: item_calibration.track,
      source: item_calibration.source,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
      calibration_n: item_calibration.calibration_n,
      calibration_weight: item_calibration.calibration_weight,
    })
    .from(item_calibration)
    .orderBy(item_calibration.id);
  const item_calibration_rows: RawItemCalibrationRow[] = itemCalibrationRows.map((r) => ({
    ...r,
    b: r.b ?? null,
    confidence: r.confidence ?? null,
    b_anchor: r.b_anchor ?? null,
    b_calib: r.b_calib ?? null,
    calibration_weight: r.calibration_weight ?? null,
  }));

  const familyRows = await tx
    .select({
      id: item_family_calibration.id,
      family_key: item_family_calibration.family_key,
      b_delta: item_family_calibration.b_delta,
      evidence_count: item_family_calibration.evidence_count,
      calibrated_n: item_family_calibration.calibrated_n,
      confidence: item_family_calibration.confidence,
    })
    .from(item_family_calibration)
    .orderBy(item_family_calibration.id);
  const family_calibration: RawFamilyCalibrationRow[] = familyRows.map((r) => ({ ...r }));

  const labelRows = await tx
    .select()
    .from(difficulty_calibration_label)
    .orderBy(difficulty_calibration_label.id);
  const difficulty_labels: RawDifficultyLabelRow[] = labelRows.map((r) => ({
    ...r,
    created_at: isoRequired(r.created_at),
  }));

  const selectionRows = await tx
    .select()
    .from(selection_observation)
    .orderBy(selection_observation.id);
  const selection_observations: RawSelectionObservationRow[] = selectionRows.map((r) => ({
    ...r,
    stream_item_id: r.stream_item_id ?? null,
    created_at: isoRequired(r.created_at),
  }));

  const answerRows = await tx
    .select({
      id: answer.id,
      question_id: answer.question_id,
      learning_item_id: answer.learning_item_id,
      input_kind: answer.input_kind,
      content_md: answer.content_md,
      image_refs: answer.image_refs,
      vision_extracted: answer.vision_extracted,
      tags: answer.tags,
      submitted_at: answer.submitted_at,
      session_id: answer.session_id,
      paper_artifact_id: answer.paper_artifact_id,
      part_ref: answer.part_ref,
      event_id: answer.event_id,
    })
    .from(answer)
    .orderBy(answer.id);
  const answers: RawAnswerRow[] = answerRows.map((r) => ({
    ...r,
    submitted_at: iso(r.submitted_at),
  }));

  const sessionRows = await tx
    .select({
      id: learning_session.id,
      type: learning_session.type,
      status: learning_session.status,
      source_document_id: learning_session.source_document_id,
      artifact_id: learning_session.artifact_id,
      started_at: learning_session.started_at,
      ended_at: learning_session.ended_at,
    })
    .from(learning_session)
    .orderBy(learning_session.id);
  const sessions: RawSessionRow[] = sessionRows.map((r) => ({
    ...r,
    source_document_id: r.source_document_id ?? null,
    artifact_id: r.artifact_id ?? null,
    started_at: isoRequired(r.started_at),
    ended_at: iso(r.ended_at),
  }));

  const mirrorRows = await tx
    .select({
      id: learning_record.id,
      kind: learning_record.kind,
      source: learning_record.source,
      attempt_event_id: learning_record.attempt_event_id,
      question_id: learning_record.question_id,
    })
    .from(learning_record)
    .where(sql`${learning_record.attempt_event_id} is not null`)
    .orderBy(learning_record.id);
  const learning_record_mirrors: RawLearningRecordMirrorRow[] = mirrorRows.map((r) => ({ ...r }));

  const questionRows = await tx
    .select({
      id: question.id,
      kind: question.kind,
      source: question.source,
      draft_status: question.draft_status,
      parent_question_id: question.parent_question_id,
      part_index: question.part_index,
      root_question_id: question.root_question_id,
      parent_variant_id: question.parent_variant_id,
      knowledge_ids: question.knowledge_ids,
      image_refs: question.image_refs,
      created_at: question.created_at,
    })
    .from(question)
    .orderBy(question.id);
  const question_lineage: RawQuestionLineageRow[] = questionRows.map((r) => ({
    ...r,
    draft_status: r.draft_status ?? null,
    parent_question_id: r.parent_question_id ?? null,
    part_index: r.part_index ?? null,
    root_question_id: r.root_question_id ?? null,
    parent_variant_id: r.parent_variant_id ?? null,
    created_at: isoRequired(r.created_at),
  }));

  const assetRows = await tx
    .select({
      id: source_asset.id,
      kind: source_asset.kind,
      storage_key: source_asset.storage_key,
      mime_type: source_asset.mime_type,
      byte_size: source_asset.byte_size,
      sha256: source_asset.sha256,
      created_at: source_asset.created_at,
    })
    .from(source_asset)
    .orderBy(source_asset.id);
  const source_assets: RawSourceAssetRow[] = assetRows.map((r) => ({
    ...r,
    created_at: isoRequired(r.created_at),
  }));

  // 投影基线：8 类 canonical fold owner 的 live 表行数（§10 entity-registry）。
  const projectionRows = await tx.execute<{ table_name: string; n: number }>(sql`
    select 'knowledge' as table_name, count(*)::int as n from knowledge
    union all select 'knowledge_edge', count(*)::int from knowledge_edge
    union all select 'goal', count(*)::int from goal
    union all select 'mistake_variant', count(*)::int from mistake_variant
    union all select 'learning_item', count(*)::int from learning_item
    union all select 'artifact', count(*)::int from artifact
    union all select 'question_block', count(*)::int from question_block
    union all select 'item_calibration', count(*)::int from item_calibration
  `);
  const projection_baseline: Record<string, number> = {};
  for (const r of projectionRows) {
    projection_baseline[r.table_name] = Number(r.n);
  }

  const aggregateRows = await tx.execute<{
    source_documents: number;
    question_image_refs: number;
  }>(sql`
    select
      (select count(*)::int from source_document) as source_documents,
      (select coalesce(sum(jsonb_array_length(image_refs)), 0)::int from question) as question_image_refs
  `);
  const aggregateRow = aggregateRows[0];

  return {
    events,
    fsrs,
    mastery,
    kc_typed,
    axis,
    item_calibration: item_calibration_rows,
    family_calibration,
    difficulty_labels,
    selection_observations,
    answers,
    sessions,
    learning_record_mirrors,
    question_lineage,
    source_assets,
    event_action_counts,
    projection_baseline,
    aggregate_counts: {
      source_documents: aggregateRow ? Number(aggregateRow.source_documents) : 0,
      question_image_refs_total: aggregateRow ? Number(aggregateRow.question_image_refs) : 0,
    },
  };
}

async function readOpsFields(tx: Tx): Promise<MigrationCapture['ops']> {
  const ingestRows = await tx.execute<{ id: string; ingest_at: Date | string | null }>(sql`
    select id, ingest_at from event
    where action in ${sql.raw(`(${ASSESSMENT_EVENT_ACTIONS.map((a) => `'${a}'`).join(', ')})`)}
      and ingest_at is not null
  `);
  const stateUpdatedRows = await tx.execute<{
    table_name: string;
    max_updated: Date | string | null;
  }>(sql`
    select 'material_fsrs_state' as table_name, max(updated_at) as max_updated from material_fsrs_state
    union all select 'mastery_state', max(updated_at) from mastery_state
    union all select 'kc_typed_state', max(updated_at) from kc_typed_state
    union all select 'learner_axis_state', max(updated_at) from learner_axis_state
    union all select 'item_family_calibration', max(updated_at) from item_family_calibration
    union all select 'answer', max(autosaved_at) as max_updated from answer
  `);
  const state_updated_at_max: Record<string, string | null> = {};
  for (const r of stateUpdatedRows) {
    state_updated_at_max[r.table_name] = r.max_updated === null ? null : isoRequired(r.max_updated);
  }
  return {
    event_ingest_at: ingestRows.map((r) => ({
      event_id: r.id,
      ingest_at: r.ingest_at === null ? null : isoRequired(r.ingest_at),
    })),
    state_updated_at_max,
  };
}

async function readQueues(tx: Tx, pgbossPresent: boolean): Promise<MigrationCapture['queues']> {
  if (!pgbossPresent) return [];
  const rows = await tx.execute<{ name: string; state: string; count: number }>(sql`
    select name, state, count(*)::int as count from pgboss.job group by name, state order by name, state
  `);
  return rows.map((r) => ({ name: r.name, state: r.state, count: Number(r.count) }));
}

async function readSubscriptionCheckpoints(
  tx: Tx,
): Promise<MigrationCapture['subscription_checkpoints']> {
  const rows = await tx.execute<{
    subscriber_id: string;
    subscriber_version: number;
    status: string;
    next_delivery_seq: string | number;
  }>(sql`
    select subscriber_id, subscriber_version, status, next_delivery_seq
    from event_subscription_checkpoint
    order by subscriber_id, subscriber_version
  `);
  return rows.map((r) => ({
    subscriber_id: r.subscriber_id,
    subscriber_version: Number(r.subscriber_version),
    status: r.status,
    next_delivery_seq: Number(r.next_delivery_seq),
  }));
}

async function readSubscriptionDeliveries(
  tx: Tx,
): Promise<MigrationCapture['subscription_deliveries']> {
  const rows = await tx.execute<{ subscriber_id: string; status: string; count: number }>(sql`
    select subscriber_id, status, count(*)::int as count
    from event_subscription_delivery
    group by subscriber_id, status
    order by subscriber_id, status
  `);
  return rows.map((r) => ({
    subscriber_id: r.subscriber_id,
    status: r.status,
    count: Number(r.count),
  }));
}

async function readAiTaskRunCounts(tx: Tx): Promise<MigrationCapture['ai_task_runs']> {
  const rows = await tx.execute<{ task_kind: string; status: string; count: number }>(sql`
    select task_kind, status, count(*)::int as count
    from ai_task_runs
    group by task_kind, status
    order by task_kind, status
  `);
  return rows.map((r) => ({
    task_kind: r.task_kind,
    status: r.status,
    count: Number(r.count),
  }));
}
