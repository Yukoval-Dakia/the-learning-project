// Drizzle schema (Postgres) — single source of truth.
// Per architecture-review.md § Stack Pivot: Postgres types throughout;
// json columns are jsonb; booleans + timestamps native.
//
// Table definitions live in src/db/schema/*.ts by domain. This file is the
// one formal entry: a single named re-export layer for drizzle-kit and the
// @/db/schema consumers. No layering below the domain files; each re-export
// here is registered as a stable_contract ruling in
// scripts/capability-boundary-baseline.json.
//
// JSON column types come from src/core/schema/business.ts. Importing the
// inferred types (not the schemas) keeps these modules zod-free at runtime;
// generated.ts wraps these tables with drizzle-zod for validation.

export {
  ai_task_runs,
  copilot_continuation,
  copilot_evidence_checkpoint,
  cost_ledger,
  custom_provider,
  model_catalog_cache,
  provider_attempt,
  provider_attempt_admission,
  provider_session_admission,
  subagent_run,
  tool_call_log,
  tool_operation,
} from './schema/ai';
export {
  artifact,
  artifact_block_ref,
  artifact_edit_session,
  edge_reconciliation_log,
  editing_presence,
  hub_sync_reconciliation,
  memory_brief_note,
  memory_reconciliation_log,
  misconception_reconciliation_log,
  note_verification_claim,
} from './schema/artifacts';
export {
  assessment_identity_mapping,
  assessment_issuance,
  assessment_response_draft,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  model_admission_slice,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
} from './schema/assessment';
export {
  difficulty_calibration_evidence,
  difficulty_calibration_label,
  item_calibration,
  item_family_calibration,
  selection_observation,
} from './schema/calibration';
export {
  dag_orchestration_node,
  dag_orchestration_run,
  echo_jobs,
  event,
  event_subscription_checkpoint,
  event_subscription_delivery,
  event_subscription_effect,
  job_events,
  materialized_id_index,
  proposal_signals,
} from './schema/events';
export {
  cause_category_overlay,
  knowledge,
  knowledge_edge,
  misconception,
  misconception_edge,
  mistake_variant,
  source_asset,
  source_document,
  subject,
  subject_control_journal,
  subject_name_claim,
  subject_trait,
  subject_trait_binding,
  subject_trait_journal,
} from './schema/knowledge';
export {
  goal,
  intervention,
  kc_typed_state,
  knowledge_mastery,
  learner_axis_state,
  mastery_state,
  material_fsrs_state,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  placement_starter_cost_component,
} from './schema/learner-state';
export {
  answer,
  completion_evidence,
  ingestion_creation_receipt,
  learning_item,
  learning_record,
  learning_session,
  practice_stream_item,
} from './schema/learning';
export {
  paid_effect,
  paid_effect_authorization,
  paid_effect_cancellation,
  paid_effect_control,
} from './schema/paid-effects';
export {
  contract_epoch,
  judge_run_control,
  migration_apply_phase,
  migration_apply_run,
  prune_job_events_control,
  prune_job_events_disposition,
  prune_job_events_receipt,
  review_orphan_control,
  review_orphan_disposition,
  review_orphan_receipt,
  review_orphan_tick,
  session_orphan_control,
  session_orphan_disposition,
  session_orphan_receipt,
  session_orphan_tick,
  system_config,
  system_config_epoch,
  system_config_journal,
} from './schema/platform';
export {
  question,
  question_answer_anchor,
  question_block,
  question_generation_binding,
  question_generation_plan,
} from './schema/question';
export type { WorksheetRefusedItem } from './schema/worksheet';
export {
  worksheet_export,
  worksheet_export_item,
  worksheet_region_map_page,
} from './schema/worksheet';
