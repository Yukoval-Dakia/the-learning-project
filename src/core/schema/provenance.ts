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
  // The text the SourcingTask agent actually extracted from the declared source
  // page. Persisted at sourcing time so source_verify's source_consistency check can
  // run a DETERMINISTIC overlap (prompt/reference vs this extract) WITHOUT refetching
  // the network — mirroring the quiz_gen source_pack precedent where the agent's
  // self-reported snippets feed a deterministic maxNgramOverlap inside quiz_verify
  // (quiz_verify.ts:265-268). A row that fabricated/misattributed its URL carries an
  // extract that does NOT overlap the prompt, so the gate can reject it.
  //
  // REQUIRED (F2, PR #313): a sourced question whose declared URL cannot be anchored
  // by ANY persisted extract can be promoted to tier 2 with ZERO deterministic
  // grounding — that is precisely the fabricated-URL escape hatch. So the web_sourced
  // contract now demands a non-empty extract; source_verify's source_consistency
  // fails any web_sourced row missing it. NOTE: this REQUIRED bar applies to the
  // web_sourced provenance block ONLY. There is no other producer/consumer of
  // WebSourcedProvenance in the repo (sourcing.ts writes it, source_verify.ts +
  // deriveSourceTier read it) — no legacy non-sourced path constructs this shape, so
  // tightening it here has no cross-contract fallout.
  extract: z.string().min(1),
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

  // tier 2 sourced — web_sourced source + a parseable web_sourced provenance block
  // AND the top-level source_ref_kind discriminator set to 'url'. 合约三 (§2.2) makes
  // metadata.source_ref_kind the single source of truth that disambiguates the
  // overloaded source_ref column; tier-2 derivation must honour that contract rather
  // than inferring tier 2 from metadata.web_sourced alone, otherwise a row missing
  // the discriminator would bypass the disambiguation contract this slice defines.
  if (q.source === 'web_sourced' && metadata.source_ref_kind === 'url') {
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

// ---------- 合约五：tier + OF-2 selection comparator ----------
//
// The single selection-order comparator every "需要知识点 X 的题" consumer reuses
// (review-plan-tools tier-preference order + sourcing-sequence existing-pool sort).
// Two keys, in order:
//   1. source tier ascending (1 authentic → 4 generated; missing tier treated as 4).
//   2. OF-2 within-tier demotion (plan §12): whitelist_match === false sorts BEHIND
//      true | null. ONLY false is demoted — an unknown (null) match is NOT penalised.
// Stable: callers feed pre-ordered input (e.g. created_at / failure-first) and rely
// on this returning 0 for equal (tier, demotion) pairs so the prior order survives.
export interface SourceTierSortItem {
  // 1 authentic → 4 generated; null = unknown/absent (treated as 4 = lowest). Accepts a
  // bare number so read-model projections (zod number) feed in without a cast.
  tier: number | null;
  // metadata.web_sourced.whitelist_match (only meaningful for tier 2). null = unknown.
  whitelistMatch: boolean | null;
}

export function compareBySourceTierThenWhitelist(
  a: SourceTierSortItem,
  b: SourceTierSortItem,
): number {
  const at = a.tier ?? 4;
  const bt = b.tier ?? 4;
  if (at !== bt) return at - bt;
  // OF-2: within the same tier, off-whitelist (false) sorts after on-whitelist /
  // unknown (true | null). Only false is demoted.
  const ad = a.whitelistMatch === false ? 1 : 0;
  const bd = b.whitelistMatch === false ? 1 : 0;
  return ad - bd;
}
