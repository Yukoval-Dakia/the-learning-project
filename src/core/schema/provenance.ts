// Question source-tier contracts. Tier is derived from provenance, never from a
// bare reading of `question.source`: that column records the ingestion entrypoint
// and carries no tier semantics on its own.
//
//   tier 1 authentic  — ingested from scans/papers: metadata.ingestion_session_id.
//   tier 2 sourced    — web-sourced: source='web_sourced', metadata.web_sourced.
//   tier 3 material   — generated from fetched material: source='quiz_gen' +
//                        quiz_gen.generation_method='material_grounded' +
//                        material_source_document_id.
//   tier 4 generated  — everything else (search_grounded / closed_book / variant).
//
// deriveSourceTier must not misread a non-ingestion row (embedded/manual/quiz_gen)
// as tier 1: ingestion_session_id is the only tier-1 judge, so such rows fall
// through to tier 4.
import { z } from 'zod';

// ---------- web_sourced provenance (tier 2) ----------
//
// Lands at question.metadata.web_sourced when SourcingTask fetches a question.
export const WebSourcedProvenance = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  // ISO string (same shape as quiz_gen source_pack.searched_at — string, not Date).
  fetched_at: z.string().min(1),
  // Whether the source URL matched the subject profile's source whitelist.
  // Off-whitelist questions are still ingested; they sort BEHIND whitelisted ones
  // within tier 2. The verification gate is not relaxed for them.
  whitelist_match: z.boolean(),
  // Fingerprint of the extracted content (dedup / audit cross-evidence). Optional.
  extraction_hash: z.string().optional(),
  // Text the SourcingTask agent extracted from the declared source page. Persisted
  // so source_verify can run a deterministic overlap without refetching the
  // network. Required: a row whose URL cannot be anchored by any persisted extract
  // must not reach tier 2 — that is the fabricated-URL escape hatch.
  extract: z.string().min(1),
});
export type WebSourcedProvenanceT = z.infer<typeof WebSourcedProvenance>;

// ---------- material_grounded (tier 3) ----------
//
// Material provenance reuses the quiz_gen metadata namespace (no source_document_id
// column, zero DDL). The grounded material id lives at
// question.metadata.quiz_gen.material_source_document_id; the field is part of
// QuizGenMetadata, and deriveSourceTier reads it inline below.

// ---------- source-ref kinds ----------
//
// question.source_ref is overloaded (trigger ptr for quiz_gen, URL for sourced,
// ingestion session for ingested); source_ref_kind disambiguates it.

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

// ---------- tier derivation ----------
//
// Not a standalone Zod object — the rule lives in deriveSourceTier below.

export type SourceTier = 1 | 2 | 3 | 4;
export type SourceTierName = 'authentic' | 'sourced' | 'material' | 'generated';

// Minimal row subset, deliberately not bound to the Drizzle row type so this stays
// a pure cross-subject function reusable across read models and gates.
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
 * Derive a question's source tier (1 authentic → 4 generated) from provenance.
 *
 * Provenance-first: the first matching branch wins, and the bare `source` column is
 * only consulted after the ingestion check, so a non-ingestion row carrying
 * source='embedded'/'manual'/'quiz_gen' without ingestion_session_id cannot be
 * misread as tier 1.
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

  // tier 2 sourced — web_sourced source, parseable provenance block, and the
  // source_ref_kind discriminator set to 'url'. Without the discriminator a row
  // could bypass the source_ref disambiguation contract.
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

// ---------- selection comparator ----------
//
// Selection order shared by every "question for knowledge point X" consumer:
//   1. source tier ascending (missing tier treated as 4).
//   2. within-tier demotion: whitelist_match === false sorts behind true | null.
//      Only false is demoted; unknown (null) is not penalised.
// Stable: callers feed pre-ordered input and rely on 0 for equal pairs.
export interface SourceTierSortItem {
  // 1 authentic → 4 generated; null = unknown/absent (treated as 4). Accepts a bare
  // number so read-model projections feed in without a cast.
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
  // Within a tier, off-whitelist (false) sorts after on-whitelist / unknown.
  const ad = a.whitelistMatch === false ? 1 : 0;
  const bd = b.whitelistMatch === false ? 1 : 0;
  return ad - bd;
}
