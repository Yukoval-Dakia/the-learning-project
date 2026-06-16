// YUK-383 Phase 0 — deterministic entity -> embeddable text. Keeps the embed
// input stable so embed_version is the single re-embed trigger (change the join
// rule => bump EMBED_VERSION). KC has no description column today (spec §4.3a:
// name + domain first); fold description in here if that column ever lands.

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

export function knowledgeEmbedText(k: { name: string; domain: string | null }): string {
  const joined = [k.name, k.domain ?? ''].filter((s) => s?.trim()).join('\n');
  return clampEmbedText(joined);
}
