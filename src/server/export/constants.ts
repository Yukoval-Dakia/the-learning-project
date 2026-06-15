// Phase 1c.1 Step 9.J: legacy tables (mistake / review_event / dreaming_proposal /
// ingestion_session) DROPped — major bump.
// P5.3 (YUK-183): additive nullable `memory_brief_note.long_term_freshness_score`
// column — minor bump. Column rides the whole-row dump/restore automatically.
// B1-W1 (ADR-0035): additive `mastery_state` + `item_calibration` tables — minor
// bump (4.1 → 4.2). Both ride the whole-row dump/restore via FK_ORDER below.
export const SCHEMA_VERSION = '4.2';

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
// Phase 1c.1 Lane A + Step 9.J:
//   - removed: judgment + user_appeal (Step 1.4) + mistake + review_event +
//     dreaming_proposal + ingestion_session (Step 9.J)
//   - added: knowledge_edge (ADR-0010), learning_session (ADR-0008),
//     material_fsrs_state (ADR-0006 v2 FSRS projection), event (ADR-0006 v2)
//   - knowledge_mastery view: NOT in FK_ORDER (views are read-only, not exported)
//
// Topological constraints:
//   knowledge_edge.from/to → knowledge (FK)
//   event.session_id → learning_session (FK, nullable)
//   material_fsrs_state: polymorphic, no enforced FK
//
// B1-W1 (ADR-0035): added mastery_state (after knowledge — diagnostic projection
// keyed by knowledge subject_id, no enforced FK) + item_calibration (after
// question — logical dependency on question_id, no enforced FK). 17 → 19.
// Like knowledge_mastery these are DERIVED (rebuildable from the event stream /
// re-estimable), so they are NOT in the CSV export body — but unlike the view
// they ARE physical tables that need wipe/insert sweep ordering, so they DO
// belong in FK_ORDER (CSV-body membership and FK_ORDER membership are orthogonal).
export const FK_ORDER = [
  'knowledge',
  'mastery_state',
  'knowledge_edge',
  'source_asset',
  'source_document',
  'learning_session',
  'question_block',
  'question',
  'item_calibration',
  'material_fsrs_state',
  'memory_brief_note',
  'learning_record',
  'learning_item',
  'completion_evidence',
  'artifact',
  'answer',
  'event',
  'tool_call_log',
  'cost_ledger',
] as const;

export type TableName = (typeof FK_ORDER)[number];
