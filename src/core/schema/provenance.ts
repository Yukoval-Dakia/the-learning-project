// YUK-216 S2 (题源扩展 Strategy D) — provenance contracts + source-tier derivation.
//
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §2
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §2.1 / §2.3
//
// A question's "source tier" is a 4-level trust ranking driven by PROVENANCE,
// not by a bare reading of the `question.source` column. The source column holds
// an INGESTION ENTRYPOINT (e.g. 'vision_paper' / 'vision_single' — see
// app/api/ingestion/[id]/import/route.ts:416 writing `sessionEntrypoint`), which
// carries NO tier semantics on its own. So tier 1 (authentic) is keyed off the
// presence of an ingestion provenance marker in metadata, never off `source`.
//
//   tier 1 authentic  — real exam questions ingested from scans/papers.
//                        Marker: metadata.ingestion_session_id (top-level, non-empty).
//   tier 2 sourced    — existing questions fetched from the web by SourcingTask.
//                        source='web_sourced' + metadata.web_sourced (this file).
//   tier 3 material   — generated questions GROUNDED in fetched real material.
//                        source='quiz_gen' + metadata.quiz_gen.generation_method
//                        ='material_grounded' + material_source_document_id.
//   tier 4 generated  — purely generated (search_grounded / closed_book / variant).
//
// MIX-LAYER DEFENCE (plan §0 实证1 / R1): a non-ingestion question can land in the
// `question` table (e.g. embedded_check_generate.ts:237 writes source='embedded'
// with NO ingestion_session_id in metadata). deriveSourceTier MUST NOT misread such
// a row as tier 1 — the ONLY tier-1 judge is the ingestion_session_id key, so an
// embedded/manual/quiz_gen row without that key correctly falls through to tier 4.
import { z } from 'zod';

// ---------- 合约一：web_sourced provenance (tier 2) ----------
//
// Lands at question.metadata.web_sourced when a question is fetched by SourcingTask.
export const WebSourcedProvenance = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  // ISO string (same shape as quiz_gen source_pack.searched_at — string, not Date).
  fetched_at: z.string().min(1),
  // Whether the source URL matched the subject profile's source whitelist (§5
  // cold-start). OWNER-FORK OF-2 拍板 (plan §12): off-whitelist questions ARE
  // ingested but DEMOTED — whitelist_match=false sorts them BEHIND
  // whitelist_match=true within tier 2 at selection time. The verification gate
  // is NOT relaxed for them (solve-check etc. all still apply); demotion only
  // affects selection priority, never the quality bar.
  whitelist_match: z.boolean(),
  // Fingerprint of the extracted content (dedup / audit cross-evidence). Optional.
  extraction_hash: z.string().optional(),
});
export type WebSourcedProvenanceT = z.infer<typeof WebSourcedProvenance>;

// ---------- 合约二：material_grounded (tier 3) ----------
//
// Material provenance reuses the quiz_gen metadata namespace (the `question` table
// has no source_document_id column → zero-DDL). The grounded material's id lives at
// question.metadata.quiz_gen.material_source_document_id (declared on QuizGenMetadata
// in quiz_gen.ts; the REQUIRE-when-material_grounded superRefine is added by slice 3).
// No standalone Zod object here — the field is part of QuizGenMetadata. A narrow
// reader shape used by deriveSourceTier is defined inline below.

// ---------- 合约三：source_ref disambiguation (all new sources) ----------
//
// The `question.source_ref` column is overloaded across sources (a trigger ptr for
// quiz_gen, a URL for sourced, an ingestion session for ingested). To keep its
// meaning unambiguous, each new source co-writes a `metadata.source_ref_kind`
// (top-level — single source of truth aligned with the source_ref column, plan §2.2
// 合约三裁决). Zero-DDL (metadata is jsonb).
export const SourceRefKind = z.enum([
  // quiz_gen current behaviour: source_ref is a trigger-object pointer.
  'trigger_ptr',
  // sourced: source_ref = the fetched URL.
  'url',
  // tier-1 reverse-lookup anchor (mirrors metadata.ingestion_session_id).
  'ingestion_session',
  // a persisted source_document row id (e.g. tier-3 grounded material).
  'source_document',
]);
export type SourceRefKindT = z.infer<typeof SourceRefKind>;

// ---------- 合约四：tier derivation 判据 ----------
//
// Not a standalone Zod object — it is the deriveSourceTier function below. The
// "authentic must carry ingestion provenance" rule is encoded as the tier-1 branch.

export type SourceTier = 1 | 2 | 3 | 4;
export type SourceTierName = 'authentic' | 'sourced' | 'material' | 'generated';

// Minimal row subset — deliberately NOT bound to the Drizzle row type, so this stays
// a pure cross-subject function (core/schema layering) that is trivial to unit-test
// and reuse across call sites (review read models, verify gate, 组卷偏好).
export interface SourceTierInput {
  source: string; // question.source column
  metadata: Record<string, unknown> | null; // question.metadata jsonb
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Derive a question's source tier (1 authentic → 4 generated) from PROVENANCE.
 *
 * Decision order (provenance-first, spec §2 table). The first matching branch wins;
 * the bare `source` column is only consulted AFTER the ingestion-provenance check, so
 * a non-ingestion row carrying source='embedded'/'manual'/'quiz_gen' but no
 * ingestion_session_id can never be misread as tier 1 (mix-layer defence, plan R1).
 */
export function deriveSourceTier(q: SourceTierInput): {
  tier: SourceTier;
  name: SourceTierName;
} {
  const metadata = q.metadata ?? {};

  // tier 1 authentic — ONLY judge is the ingestion provenance key (NOT `source`).
  if (nonEmptyString(metadata.ingestion_session_id)) {
    return { tier: 1, name: 'authentic' };
  }

  // tier 2 sourced — web_sourced source + a parseable web_sourced provenance block.
  if (q.source === 'web_sourced') {
    const parsed = WebSourcedProvenance.safeParse(metadata.web_sourced);
    if (parsed.success) {
      return { tier: 2, name: 'sourced' };
    }
  }

  // tier 3 material — quiz_gen grounded in fetched real material.
  if (q.source === 'quiz_gen') {
    const quizGen = asObject(metadata.quiz_gen);
    if (
      quizGen &&
      quizGen.generation_method === 'material_grounded' &&
      nonEmptyString(quizGen.material_source_document_id)
    ) {
      return { tier: 3, name: 'material' };
    }
  }

  // tier 4 generated — everything else (search_grounded / closed_book / variant /
  // any non-ingestion row without higher-tier provenance).
  return { tier: 4, name: 'generated' };
}
