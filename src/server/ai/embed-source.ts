// YUK-383 Phase 0 — deterministic entity -> embeddable text. Keeps the embed
// input stable so embed_version is the single re-embed trigger (change the join
// rule => bump EMBED_VERSION). KC has no description column today (spec §4.3a:
// name + domain first); fold description in here if that column ever lands.

import { createHash } from 'node:crypto';

// text-embedding-v4 rejects any single input over 8192 tokens (and a 400 fails
// the whole batch, not just the long item — see embedMany's chunking). We don't
// have a tokenizer here, so cap by characters with a conservative budget: for the
// worst case (CJK, ~1 token/char) ~6000 chars stays safely under 8192 tokens,
// while leaving normal-length prompts/references untouched. The tail (often a long
// reference_md) is what gets clipped; the prompt leads the join so it's preserved.
const EMBED_TEXT_MAX_CHARS = 6000;

function clampEmbedText(s: string): string {
  return s.length > EMBED_TEXT_MAX_CHARS ? s.slice(0, EMBED_TEXT_MAX_CHARS) : s;
}

export function questionEmbedText(q: {
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
}): string {
  const joined = [q.prompt_md, q.reference_md ?? '', ...(q.choices_md ?? [])]
    .filter((s) => s?.trim())
    .join('\n');
  return clampEmbedText(joined);
}

// YUK-393 — KC embed text now folds the EFFECTIVE domain (resolved by a
// getEffectiveDomain tree-walk at the call site), not the bare `k.domain` column.
// A child KC carries `domain = NULL` (only roots store a non-null domain — see
// getEffectiveDomain's root invariant), so the old bare-column join embedded
// every child as just its name. Two same-named KCs under different subject roots
// (e.g. a "周期" node under physics vs. a "周期" node under chemistry) then produced
// IDENTICAL embed text → a same-named cross-subject collision in cosine retrieval.
// Folding the effective domain disambiguates them. `effectiveDomain` is passed in
// (the walk needs a DB handle, which this pure text builder must not hold).
export function knowledgeEmbedText(k: { name: string; effectiveDomain: string | null }): string {
  const joined = [k.name, k.effectiveDomain ?? ''].filter((s) => s?.trim()).join('\n');
  return clampEmbedText(joined);
}

// YUK-393 — stable content fingerprint of an embed-source string. sha256 hex of
// the EXACT text that would be embedded (callers pass questionEmbedText(...) /
// knowledgeEmbedText(...)). Drives re-embed-on-change: a stored hash that differs
// from a freshly recomputed one means the embed input drifted → NULL the embedding
// so the next backfill re-embeds. Hashing the embed-source text (not raw columns)
// means the join rule and the clamp are part of the fingerprint for free.
export function embedHash(embedSourceText: string): string {
  return createHash('sha256').update(embedSourceText).digest('hex');
}
