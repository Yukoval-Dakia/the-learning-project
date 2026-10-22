// YUK-471 W3-C3 / YUK-587 — shared live-row → structural-snapshot field-picks.
//
// The auditor, genesis backfill, live seed and accept-time parity asserts all need the SAME live-row →
// structural-snapshot mapping. Duplicate field-picks are a drift hazard: a future schema change could
// silently diverge the seed/backfill snapshot shape from what the fold reproduces. Consolidating them
// here makes that impossible — every consumer picks the same fields.
//
// NO Zod parse — a `.parse()` throw on the hot path could abort a live write in prod, defeating the
// never-throw-on-the-hot-path contract the parity asserts uphold. A plain field-pick cannot throw; the
// row came straight from the DB so its types hold. (The strict genesis parse still runs at writeEvent in
// the backfill — that barrier is intentional there, not here.)

import type {
  ItemCalibrationRowSnapshotT,
  QuestionBlockRowSnapshotT,
} from '@/core/schema/event/genesis';
import type { item_calibration, question_block } from '@/db/schema';

/**
 * Map a live `knowledge` row to its structural snapshot. The embed_* columns are derived search-index
 * state, not fold truth, so they are deliberately omitted. Used by both the one-shot genesis backfill
 * and the migrate-time subject-root seed (YUK-587); sharing this mapper prevents their genesis payloads
 * from drifting apart.
 */
export { knowledgeLiveRowToSnapshot as knowledgeRowToSnapshot } from '@/kernel/records/knowledge-node-history';

export { artifactRowToSnapshot } from '@/kernel/records/artifact-history';

/**
 * Map a live `question_block` DB row to QuestionBlockRowSnapshotT, EXCLUDING the LEGACY
 * `extracted_prompt_md` column (the snapshot omits it — markdown views derive from `structured`,
 * ADR-0002; DROP deferred to Step 11.5). The strip is just "never pick it" so the deep-diff never sees
 * it (a row differing only in that legacy column folds clean), and the strict QuestionBlockRowSnapshot
 * would `unrecognized_keys`-reject a payload carrying it (design §5.2). Every OTHER column is fold truth
 * (carried verbatim). `structured` / `figures` REUSE the canonical StructuredQuestion / FigureRef
 * schemas (incl. the 0-1 normalized BBox refinements) — a row whose structured/figure bbox is out of
 * range FAILS the strict parse at the backfill's writeEvent (fail-loud, NOT clamp). Dates stay Date
 * (z.coerce.date() accepts both).
 */
export function questionBlockRowToSnapshot(
  row: typeof question_block.$inferSelect,
): QuestionBlockRowSnapshotT {
  return {
    id: row.id,
    ingestion_session_id: row.ingestion_session_id,
    source_document_id: row.source_document_id,
    source_asset_ids: row.source_asset_ids ?? [],
    page_spans: row.page_spans ?? [],
    structured: row.structured ?? null,
    figures: row.figures ?? [],
    layout_quality: row.layout_quality,
    reference_md: row.reference_md,
    wrong_answer_md: row.wrong_answer_md,
    image_refs: row.image_refs ?? [],
    crop_refs: row.crop_refs ?? [],
    visual_complexity: row.visual_complexity,
    extraction_confidence: row.extraction_confidence,
    status: row.status,
    knowledge_hint: row.knowledge_hint,
    merged_from_block_ids: row.merged_from_block_ids ?? [],
    imported_question_id: row.imported_question_id,
    imported_attempt_event_id: row.imported_attempt_event_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
    // EXCLUDED: extracted_prompt_md (legacy deprecated — stripped before the snapshot, design §5.2).
  };
}

/**
 * Map a live `item_calibration` DB row to ItemCalibrationRowSnapshotT — the FULL 17-column row,
 * every column carried verbatim (YUK-496 方案 A: the anchor-only fold has no mutation events, so
 * the whole row IS the snapshot — the goal/artifact full-row precedent). The soft jsonb columns
 * (cdm_json / kt_json) pass through untouched as opaque records; the backfill's writeEvent
 * parseEvent barrier validates the strict snapshot shape. Dates stay Date (z.coerce.date()
 * accepts both Date and the jsonb ISO string).
 */
export function itemCalibrationRowToSnapshot(
  row: typeof item_calibration.$inferSelect,
): ItemCalibrationRowSnapshotT {
  return {
    id: row.id,
    question_id: row.question_id,
    b: row.b,
    confidence: row.confidence,
    track: row.track,
    source: row.source,
    b_anchor: row.b_anchor,
    b_calib: row.b_calib,
    calibration_n: row.calibration_n,
    calibration_weight: row.calibration_weight,
    last_calibrated_at: row.last_calibrated_at,
    // YUK-439 — 后验列随锚快照携带（历史 genesis 无这些键，optional 解析）。
    b_post: row.b_post,
    posterior_variance: row.posterior_variance,
    calibration_source: row.calibration_source,
    irt_a: row.irt_a,
    irt_c: row.irt_c,
    cdm_json: row.cdm_json ?? null,
    kt_json: row.kt_json ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
