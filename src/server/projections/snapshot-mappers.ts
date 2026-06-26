// YUK-471 W3-C3 (review) — the ONE shared artifact / question_block row→snapshot field-pick.
//
// The auditor (scripts/audit-projection.ts), the genesis backfill (scripts/backfill-genesis-events.ts),
// and the accept-time parity assert (src/server/projections/parity.ts, re-exported under the
// artifactLiveRowToSnapshot / questionBlockLiveRowToSnapshot names) all need the SAME live-row →
// structural-snapshot mapping. Three byte-identical copies were a drift hazard: a future schema change
// (esp. dropping the legacy question_block.extracted_prompt_md column) could silently diverge the audit
// / backfill snapshot shape from what the fold reproduces. Consolidating to one exported mapper makes
// that impossible — every consumer picks the same fields here.
//
// NO Zod parse — a `.parse()` throw on the hot path could abort a live write in prod, defeating the
// never-throw-on-the-hot-path contract the parity asserts uphold. A plain field-pick cannot throw; the
// row came straight from the DB so its types hold. (The strict genesis parse still runs at writeEvent in
// the backfill — that barrier is intentional there, not here.)

import type { ArtifactRowSnapshotT, QuestionBlockRowSnapshotT } from '@/core/schema/event/genesis';
import type { artifact, question_block } from '@/db/schema';

/**
 * Map a live `artifact` DB row to ArtifactRowSnapshotT. artifact has NO derived/embed columns
 * (design §5.1), so the FULL 22-column row IS the snapshot — every column is carried verbatim. The
 * jsonb columns (body_blocks / attrs / tool_state / verification_summary / generated_by / verified_by /
 * history) pass through untouched (the snapshot REUSES the canonical business schemas, so the backfill's
 * writeEvent parseEvent barrier validates them as ground truth). Dates stay Date (GenesisExperimental's
 * z.coerce.date() accepts both Date and the jsonb ISO string). The array columns default to [] at the
 * table, so they are always present.
 */
export function artifactRowToSnapshot(row: typeof artifact.$inferSelect): ArtifactRowSnapshotT {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    parent_artifact_id: row.parent_artifact_id,
    knowledge_ids: row.knowledge_ids ?? [],
    intent_source: row.intent_source,
    source: row.source,
    source_ref: row.source_ref,
    body_blocks: row.body_blocks,
    attrs: row.attrs ?? {},
    tool_kind: row.tool_kind,
    tool_state: row.tool_state,
    generation_status: row.generation_status,
    verification_status: row.verification_status,
    verification_summary: row.verification_summary,
    generated_by: row.generated_by,
    verified_by: row.verified_by,
    history: row.history ?? [],
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

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
