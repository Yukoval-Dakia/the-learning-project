// Practice-owned cause-attribution stage 1. Given the attempt and resolved
// SubjectProfile, return candidate cause categories for stage 2
// (AttributionRerankTask) to rerank and pick `primary_category` from.
//
// Behavior-equivalence invariant: every shipped profile's cause vocabulary is
// <= K_SMALL, so this retriever returns `profile.causeCategories` verbatim — same
// array reference, no copy, no reorder. Stage 2 therefore sees the same candidate
// set the inline taxonomy used to embed. Promoted misconception candidates are
// optional; with none supplied the invariant holds unchanged.
//
// Attribution is a soft track (ADR-0035): its output never feeds theta-hat, p(L),
// or FSRS. This module only shapes the candidate list; the vocabulary source is
// SubjectProfile.causeCategories, not a database table.

import { MISC_CAUSE_ID_PREFIX } from '@/kernel/read-models/misc-cause-labels';
import type { SubjectProfile } from '@/subjects/profile';
import type { AttributionCandidate, AttributionInput } from './attribution';

/**
 * Alias of the shared candidate shape; deriving it from the profile type prevents a
 * parallel declaration from drifting.
 */
export type CauseCandidate = AttributionCandidate;

/**
 * Minimal promoted-misconception shape. The DB read happens in the server layer;
 * this module stays IO-free.
 */
export interface MisconceptionCauseSource {
  /** Misconception row id, already `misc_<sha256-24>` from the promote writer. */
  id: string;
  title: string;
  reasoning: string | null;
}

/** Candidate-id namespace for promoted misconception nodes. */
export const MISCONCEPTION_CANDIDATE_PREFIX = MISC_CAUSE_ID_PREFIX;

/**
 * Map a promoted misconception onto the shared candidate shape. The row id is
 * already `misc_`-prefixed; sanitize and re-prefix defensively so it satisfies
 * CauseCategoryId's `^[a-z][a-z0-9_]*$` and cannot collide with vocab ids.
 * `source_pack` marks the non-vocab provenance in the serialized candidate.
 */
export function misconceptionToCandidate(m: MisconceptionCauseSource): CauseCandidate {
  const sanitized = m.id.replace(/[^a-z0-9_]/g, '_');
  return {
    id: sanitized.startsWith(MISCONCEPTION_CANDIDATE_PREFIX)
      ? sanitized
      : `${MISCONCEPTION_CANDIDATE_PREFIX}${sanitized}`,
    label: m.title,
    ...(m.reasoning ? { description: m.reasoning } : {}),
    source_pack: { id: 'misconception', version: 'promoted' },
  };
}

/**
 * Passthrough threshold: >= every shipped profile vocabulary (max 11), so the
 * retriever is an identity passthrough for all current profiles.
 */
export const K_SMALL = 15;

/**
 * Top-K cap for a future large vocabulary; kept equal to K_SMALL so both thresholds
 * move together.
 */
export const K_MAX = 15;

/**
 * Module-level ICU segmenter (construction is expensive). ICU boundaries depend on
 * the Node build, so the dormant large-vocab scorer is ICU-version deterministic, not
 * byte-identical across Node upgrades. Acceptable: it only orders a candidate list and
 * never feeds theta-hat, p(L), or FSRS.
 */
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * Distinct lowercased word-like tokens. `isWordLike` drops punctuation while keeping
 * single-character CJK units, which the old whitespace-split, length>1 tokenizer
 * silently discarded.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const segment of WORD_SEGMENTER.segment(text.toLowerCase())) {
    if (segment.isWordLike) tokens.add(segment.segment);
  }
  return tokens;
}

/**
 * Deterministic stage-1 retriever: no LLM, embedding, or DB.
 *
 * Pool = profile vocabulary followed by optional misconception candidates.
 * - pool.length <= K_SMALL: return the pool unfiltered. With no misconceptions this
 *   is `profile.causeCategories` itself — the behavior-equivalence short-circuit.
 * - pool.length > K_SMALL: score by keyword overlap and return the top K_MAX. Ties
 *   keep input order, so vocabulary declaration order wins.
 */
export function retrieveCauseCandidates(
  input: AttributionInput,
  profile: SubjectProfile,
  misconceptionCandidates: readonly CauseCandidate[] = [],
): CauseCandidate[] {
  const vocab = profile.causeCategories;
  // Empty misc input → pool IS the vocab array (same reference, no copy).
  const pool: CauseCandidate[] = misconceptionCandidates.length
    ? [...vocab, ...misconceptionCandidates]
    : vocab;
  // Behavior-equivalence short-circuit; with miscs, the whole union passes through.
  if (pool.length <= K_SMALL) return pool;

  // Large-vocab path: exact token-set intersection instead of substring matching,
  // which mis-fired on partial words and cross-boundary spans. tokenize keeps
  // single-character CJK units.
  const hayTokens = tokenize(
    `${input.wrong_answer_md}\n${input.prompt_md}\n${input.reference_md ?? ''}\n${input.knowledge_context
      .map((k) => k.name)
      .join(' ')}`,
  );
  const scored = pool.map((candidate) => {
    const needleTokens = tokenize(`${candidate.label} ${candidate.description ?? ''}`);
    let score = 0;
    for (const token of needleTokens) if (hayTokens.has(token)) score++;
    return { candidate, score };
  });
  // Descending score; ties keep input order (Array#sort is stable and the pool preserved
  // vocabulary declaration order).
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, K_MAX).map((s) => s.candidate);
}
