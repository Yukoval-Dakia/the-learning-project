// YUK-383 Phase 0 — deterministic entity -> embeddable text. Keeps the embed
// input stable so embed_version is the single re-embed trigger (change the join
// rule => bump EMBED_VERSION). KC has no description column today (spec §4.3a:
// name + domain first); fold description in here if that column ever lands.

export function questionEmbedText(q: {
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
}): string {
  return [q.prompt_md, q.reference_md ?? '', ...(q.choices_md ?? [])]
    .filter((s) => s && s.trim())
    .join('\n');
}

export function knowledgeEmbedText(k: { name: string; domain: string | null }): string {
  return [k.name, k.domain ?? ''].filter((s) => s && s.trim()).join('\n');
}
