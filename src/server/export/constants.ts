// Phase 1c.1 (Lane A): event-driven core + knowledge mesh + view + DROPs (judgment, user_appeal,
// 3 mastery stub columns). Breaking change → major bump.
export const SCHEMA_VERSION = '2.0';

// CF Worker free plan caps at 50 subrequests per request. We use 18 D1 SELECTs
// + a few R2 reads for assets + future-proof headroom. Cap inline assets at 45;
// users with more must use refs-only export + wrangler r2 cp sidecar.
// Paid plan = 1000 subrequests; bump to ~950 if you upgrade.
// (Note: D1/Workers no longer in use post sub-0b1; cap retained as a safety guardrail.)
export const MAX_INLINE_ASSETS = 45;

// FK topological order. Insert sweeps forward; wipe sweeps reverse. Any schema
// change that adds/removes/renames a table MUST update this array AND bump
// SCHEMA_VERSION in lockstep.
//
// Phase 1c.1 Step 1 (Lane A):
//   - removed: judgment + user_appeal (DROPped per data-assumptions §O2)
//   - added: knowledge_edge (ADR-0010), learning_session (ADR-0008), material_fsrs_state
//     (ADR-0006 v2 FSRS projection), event (ADR-0006 v2 action log)
//   - knowledge_mastery view: NOT in FK_ORDER (views are read-only, not exported)
//
// Topological constraints:
//   knowledge_edge.from/to → knowledge (FK)
//   event.session_id → learning_session (FK, nullable)
//   material_fsrs_state: polymorphic, no enforced FK
export const FK_ORDER = [
  'knowledge',
  'knowledge_edge',
  'source_asset',
  'source_document',
  'ingestion_session',
  'learning_session',
  'question_block',
  'question',
  'mistake',
  'review_event',
  'material_fsrs_state',
  'learning_item',
  'completion_evidence',
  'study_log',
  'artifact',
  'answer',
  'dreaming_proposal',
  'event',
  'tool_call_log',
  'cost_ledger',
] as const;

export type TableName = (typeof FK_ORDER)[number];
