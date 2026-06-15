// Phase 1c.1 Step 9.J: legacy tables (mistake / review_event / dreaming_proposal /
// ingestion_session) DROPped — major bump.
// P5.3 (YUK-183): additive nullable `memory_brief_note.long_term_freshness_score`
// column — minor bump. Column rides the whole-row dump/restore automatically.
// ②d backup-orphan fix (YUK reverse-lockstep): 7 persistent business tables that
// had silently dropped out of the wipe-then-restore payload joined FK_ORDER
// (artifact_block_ref, ai_task_runs, mistake_variant, goal, proposal_signals,
// practice_stream_item, memory_reconciliation_log) — minor bump. New tables ride
// the whole-row dump/restore automatically. Transient/operational tables
// (job_events, echo_jobs, editing_presence) were instead recorded in
// BACKUP_EXCLUDED_TABLES below.
export const SCHEMA_VERSION = '4.2';

// CF Worker free plan caps at 50 subrequests per request. We use 18 D1 SELECTs
// + a few R2 reads for assets + future-proof headroom. Cap inline assets at 45;
// users with more must use refs-only export + wrangler r2 cp sidecar.
// Paid plan = 1000 subrequests; bump to ~950 if you upgrade.
// (Note: D1/Workers no longer in use post sub-0b1; cap retained as a safety guardrail.)
export const MAX_INLINE_ASSETS = 45;

// FK topological order. Insert sweeps forward; wipe sweeps reverse. Any schema
// change that adds/removes/renames a table MUST update this array AND bump
// SCHEMA_VERSION in lockstep. The reverse-lockstep guardrail in archive.ts now
// ENFORCES this: every pgTable in src/db/schema.ts must appear here OR in
// BACKUP_EXCLUDED_TABLES, or the module throws at load.
//
// Phase 1c.1 Lane A + Step 9.J:
//   - removed: judgment + user_appeal (Step 1.4) + mistake + review_event +
//     dreaming_proposal + ingestion_session (Step 9.J)
//   - added: knowledge_edge (ADR-0010), learning_session (ADR-0008),
//     material_fsrs_state (ADR-0006 v2 FSRS projection), event (ADR-0006 v2)
//   - knowledge_mastery view: NOT in FK_ORDER (views are read-only, not exported)
//
// ②d backup-orphan fix (reverse-lockstep): added 7 persistent business tables that
// had silently fallen out of the backup payload — artifact_block_ref (cross-link +
// embedded-check refs), ai_task_runs (AI run ledger), mistake_variant (variant
// lifecycle), goal (North-Star entity), proposal_signals (slow-accumulated AI
// acceptance learning state), practice_stream_item (materialized schedule),
// memory_reconciliation_log (mem0 reconciliation WAL). These were a pre-existing
// data-loss hole on restore, not new tables.
//
// Topological constraints:
//   knowledge_edge.from/to → knowledge (FK)
//   event.session_id → learning_session (FK, nullable)
//   material_fsrs_state: polymorphic, no enforced FK
//   artifact_block_ref.from/to_artifact_id → artifact (FK) — MUST follow artifact
//   All other ②d additions use loose-coupling text refs (no hard FK), so their
//   position is unconstrained by Postgres FK enforcement (project convention).
export const FK_ORDER = [
  'knowledge',
  'knowledge_edge',
  'source_asset',
  'source_document',
  'learning_session',
  'question_block',
  'question',
  'material_fsrs_state',
  'memory_brief_note',
  'learning_record',
  'learning_item',
  'completion_evidence',
  'artifact',
  'artifact_block_ref',
  'answer',
  'event',
  'tool_call_log',
  'cost_ledger',
  'ai_task_runs',
  'mistake_variant',
  'goal',
  'proposal_signals',
  'practice_stream_item',
  'memory_reconciliation_log',
] as const;

export type TableName = (typeof FK_ORDER)[number];

// Tables that are intentionally NOT part of the wipe-then-restore backup payload.
// The reverse-lockstep guardrail in archive.ts treats membership here as "covered"
// so these no longer count as orphans. Each entry MUST carry a one-line reason —
// only transient / derived / operational state belongs here, never authored or
// slow-accumulated cognitive data.
export const BACKUP_EXCLUDED_TABLES: ReadonlySet<string> = new Set<string>([
  // SSE-replay telemetry of pg-boss job lifecycle; operational, re-derived as jobs
  // run (ADR-0005/0008). Not authored data — restoring stale replay rows is wrong.
  'job_events',
  // Sub-0c golden E2E health-check fixture (HTTP enqueue → worker → SSE). Transient
  // echo-job state, not business data.
  'echo_jobs',
  // Cross-process editing-presence state machine (YUK-321 M5); explicitly "纯状态机
  // 存储非业务实体". A restore starts from an empty presence backend — heartbeats are
  // re-established live, so persisting them would resurrect stale lock state.
  'editing_presence',
]);
