// YUK-462 — cause-attribution L1 retrieve stage.
//
// Stage 1 of the retrieve→rerank-with-rationale attribution pipeline. Given the
// attempt input + resolved SubjectProfile, return the candidate cause categories
// that stage 2 (AttributionRerankTask) reranks and picks `primary_category` from.
//
// BEHAVIOR-EQUIVALENCE INVARIANT (the load-bearing claim of this refactor):
// every current subject profile has a cause vocab of size <= K_SMALL, so the
// retriever short-circuits and returns `profile.causeCategories` VERBATIM (the
// same array reference, no copy, no reorder). The set handed to stage 2 is then
// byte-identical to the inline taxonomy `buildAttributionPrompt` embeds today —
// so candidate-driven rerank faces the same selection problem as direct-select.
//
// SOFT-TRACK / RED LINE (ADR-0035): the attribution output this feeds is cause
// attribution only. It is NEVER consumed by θ̂ / p(L) / FSRS. This file touches
// none of those — it only shapes the candidate list. No schema, no migration:
// the vocab source is SubjectProfile.causeCategories (an in-code prior), not a
// Postgres table.

import type { SubjectProfile } from '@/subjects/profile';
import type { AttributionInput } from './attribute';

/**
 * A cause candidate handed to the rerank stage. Structurally identical to
 * `CauseCategoryDeclarationT` ({ id, label, description?, review_priority?,
 * variant_targetable?, source_pack? }) — derived from the profile type so there
 * is zero type drift and no parallel declaration to keep in sync.
 */
export type CauseCandidate = SubjectProfile['causeCategories'][number];

/**
 * Passthrough threshold. >= every current profile vocab size (max 11 today), so
 * the retriever is an identity passthrough for 100% of current profiles. The
 * equivalence guarantee holds as long as no shipped profile exceeds this.
 */
export const K_SMALL = 15;

/**
 * Large-vocab top-K cap (future). When a profile's vocab eventually exceeds
 * K_SMALL, the deterministic keyword scorer below trims to at most K_MAX
 * candidates. Kept equal to K_SMALL so the two thresholds move together.
 */
export const K_MAX = 15;

/**
 * Stage 1 retriever. Deterministic, no LLM, no embedding, no DB.
 *
 * - vocab.length <= K_SMALL → return the profile's `causeCategories` array
 *   UNCHANGED (same reference). This is the behavior-equivalence short-circuit.
 * - vocab.length  > K_SMALL → score each candidate by simple keyword overlap
 *   against the attempt text and return the top K_MAX. This branch is dormant
 *   for every current profile; it exists so a future large taxonomy degrades
 *   gracefully without an embedding service or pgvector dependency.
 */
export function retrieveCauseCandidates(
  input: AttributionInput,
  profile: SubjectProfile,
): CauseCandidate[] {
  const vocab = profile.causeCategories;
  // Behavior-equivalence short-circuit — return THE SAME array (no copy/reorder).
  if (vocab.length <= K_SMALL) return vocab;

  // Large-vocab (future): deterministic keyword scorer. No LLM, no pgvector.
  // Bidirectional substring overlap on whitespace-delimited tokens so it works
  // for both Latin words and short CJK runs (which don't split on whitespace):
  // a candidate scores for each attempt token it contains AND each of its own
  // tokens the attempt contains. Crude but deterministic and dependency-free.
  const hay =
    `${input.wrong_answer_md}\n${input.prompt_md}\n${input.reference_md ?? ''}\n${input.knowledge_context
      .map((k) => k.name)
      .join(' ')}`.toLowerCase();
  const hayTokens = hay.split(/\s+/).filter((token) => token.length > 1);
  const scored = vocab.map((candidate) => {
    const needle = `${candidate.label} ${candidate.description ?? ''}`.toLowerCase();
    const needleTokens = needle.split(/\s+/).filter((token) => token.length > 1);
    let score = 0;
    for (const token of needleTokens) if (hay.includes(token)) score++;
    for (const token of hayTokens) if (needle.includes(token)) score++;
    return { candidate, score };
  });
  // Stable-ish: sort by descending score; ties keep input order (map preserved it).
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, K_MAX).map((s) => s.candidate);
}
