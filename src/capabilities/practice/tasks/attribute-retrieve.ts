// YUK-462 — practice-owned cause-attribution L1 retrieve stage.
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
// YUK-1015 EXTENSION: the candidate pool also accepts promoted misconception
// nodes (design §L1「词表 + 已晋升误区节点」), supplied by the caller via the
// optional `misconceptionCandidates` param — with an empty list the invariant
// above holds verbatim.
//
// SOFT-TRACK / RED LINE (ADR-0035): the attribution output this feeds is cause
// attribution only. It is NEVER consumed by θ̂ / p(L) / FSRS. This file touches
// none of those — it only shapes the candidate list. No schema, no migration:
// the vocab source is SubjectProfile.causeCategories (an in-code prior), not a
// Postgres table.

import type { SubjectProfile } from '@/subjects/profile';
import type { AttributionCandidate, AttributionInput } from './attribution';

/**
 * A cause candidate handed to the rerank stage. Structurally identical to
 * `CauseCategoryDeclarationT` ({ id, label, description?, review_priority?,
 * variant_targetable?, source_pack? }) — derived from the profile type so there
 * is zero type drift and no parallel declaration to keep in sync.
 */
export type CauseCandidate = AttributionCandidate;

/**
 * Minimal shape of a promoted misconception node feeding the candidate pool
 * (YUK-1015, design §L1「词表 + 已晋升误区节点」). The DB read happens in the
 * server layer (knowledge bounded reader) — this module stays IO-free.
 */
export interface MisconceptionCauseSource {
  /** The misconception row id — already `misc_<sha256-24>` from the promote writer. */
  id: string;
  title: string;
  reasoning: string | null;
}

/** Candidate-id namespace for promoted misconception nodes. */
export const MISCONCEPTION_CANDIDATE_PREFIX = 'misc_';

/**
 * Map a promoted misconception node onto the shared candidate shape. The row id
 * is already `misc_`-prefixed (deterministic identity,
 * `misconceptionIdForConjecture`) — used verbatim; the prefix is enforced
 * defensively for any future id shape so it can never collide with vocab cause
 * ids and always satisfies `CauseCategoryId`'s `^[a-z][a-z0-9_]*$` contract: a
 * rerank that picks it survives Zod parse + lands the `misc_` id in the stored
 * cause (the fine-grained node becomes the attribution — the two-granularity
 * point of YUK-1015). `source_pack` marks the non-vocab provenance in the
 * serialized candidate JSON.
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
 * Module-level singleton ICU word segmenter for the large-vocab scorer. Built
 * once (segmenter construction is non-trivial) and reused across calls.
 *
 * DETERMINISM CAVEAT (YUK-465): ICU word boundaries depend on the ICU build
 * bundled with the running Node, so this scorer is "ICU-version deterministic",
 * NOT byte-identical across Node upgrades. That is acceptable here because the
 * path is dormant (only fires when a profile's cause vocab exceeds K_SMALL,
 * which no shipped profile does today) and its output only orders a candidate
 * list — it never feeds θ̂ / p(L) / FSRS (ADR-0035 red line).
 */
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * Tokenize text into the set of distinct, lowercased, word-like tokens. The ICU
 * `isWordLike` flag drops punctuation/whitespace segments while KEEPING
 * single-char CJK units — a lone 汉字 is a valid semantic token (the previous
 * `split(/\s+/).filter(len > 1)` tokenizer silently dropped every single-char
 * CJK token, since CJK runs don't split on whitespace). Returns a Set so the
 * scorer counts each distinct shared token at most once.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const segment of WORD_SEGMENTER.segment(text.toLowerCase())) {
    if (segment.isWordLike) tokens.add(segment.segment);
  }
  return tokens;
}

/**
 * Stage 1 retriever. Deterministic, no LLM, no embedding, no DB.
 *
 * Candidate pool = `profile.causeCategories` ∪ `misconceptionCandidates`
 * (YUK-1015: promoted misconception nodes, appended AFTER the vocab so profile
 * declaration order is preserved and vocab wins scorer ties).
 *
 * - pool.length <= K_SMALL → return the whole pool UNFILTERED. With an empty
 *   misconceptionCandidates this returns `profile.causeCategories` VERBATIM
 *   (same reference, no copy/reorder) — the behavior-equivalence short-circuit.
 * - pool.length  > K_SMALL → score each candidate by simple keyword overlap
 *   against the attempt text and return the top K_MAX. The shipped-vocab-only
 *   path stays dormant (every profile vocab ≤ K_SMALL), but YUK-1015's misc
 *   union can push the POOL past K_SMALL while a vocab stays small — this
 *   scorer then activates for real. That is intended: when promoted
 *   misconceptions are plentiful, keyword-relevant miscs legitimately outrank
 *   zero-signal vocab entries; ties at ANY score keep input order (vocab
 *   first, miscs appended after), so declaration order still wins.
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
  // Behavior-equivalence short-circuit — empty misc input returns THE SAME
  // vocab array (no copy/reorder); with miscs, the whole union passes through.
  if (pool.length <= K_SMALL) return pool;

  // Large-vocab (future): deterministic keyword scorer. No LLM, no pgvector.
  // YUK-465 hardening — was bidirectional substring overlap on whitespace-split,
  // length>1 tokens. Two precision fixes for the dormant path:
  //   1. ICU word tokenization (`tokenize`) so CJK runs split into word-like
  //      units INCLUDING single-char 汉字 — the old `length > 1` filter silently
  //      dropped every single-char CJK semantic unit.
  //   2. EXACT token-set intersection instead of substring `includes`: a
  //      candidate scores once per distinct token it shares with the attempt
  //      text. Substring matching mis-fired on partial words / cross-boundary
  //      spans (e.g. '助词' matching inside '帮助词典'); set membership is
  //      boundary-exact.
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
  // Stable sort by descending score; ties keep input order (Array.prototype.sort
  // is stable in V8, and `vocab.map` preserved the profile's declaration order).
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, K_MAX).map((s) => s.candidate);
}
