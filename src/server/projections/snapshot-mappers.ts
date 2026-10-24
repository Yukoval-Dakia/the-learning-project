// Shared live-row → structural-snapshot field-picks.
//
// The auditor, genesis backfill, live seed and accept-time parity asserts all need
// the SAME mapping. Duplicating field-picks would let a schema change silently
// diverge the seed/backfill snapshot shape from what the fold reproduces, so every
// consumer picks fields here.
//
// No Zod parse: a `.parse()` throw on the hot path could abort a live write in prod.
// A plain field-pick cannot throw, and the row came straight from the DB. The strict
// genesis parse still runs at writeEvent in the backfill.

import type {
  ItemCalibrationRowSnapshotT,
  QuestionBlockRowSnapshotT,
} from '@/core/schema/event/genesis';
import type { item_calibration, question_block } from '@/db/schema';

export { artifactRowToSnapshot } from '@/kernel/records/artifact-history';
/**
 * Map a live `knowledge` row to its structural snapshot. The embed_* columns are
 * derived search-index state, not fold truth, so they are omitted. Shared by the
 * genesis backfill and the migrate-time subject-root seed.
 */
export { knowledgeLiveRowToSnapshot as knowledgeRowToSnapshot } from '@/kernel/records/knowledge-node-history';

/**
 * Map a live `question_block` row to QuestionBlockRowSnapshotT, excluding the legacy
 * `extracted_prompt_md` column (markdown views derive from `structured`). Excluding it
 * keeps the deep-diff clean and satisfies the strict snapshot schema. Every other
 * column is fold truth. `structured` / `figures` reuse the canonical schemas, so an
 * out-of-range bbox fails the backfill's strict parse rather than being clamped.
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
 * Map a live `item_calibration` row to ItemCalibrationRowSnapshotT — the full row,
 * carried verbatim. The anchor-only fold has no mutation events, so the whole row is
 * the snapshot. cdm_json / kt_json stay opaque records.
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
    // Posterior columns travel with the anchor; historical genesis rows lack the keys.
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
