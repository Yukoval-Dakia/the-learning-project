// Versioned draft identity for question_block drafts (edit/submit round-trip).
// Wire form: `qdraft1:<blockId>:<version>` — the versioned string is the durable
// identity; consumers that join on question_block.id must normalize first.

export const DRAFT_REF_VERSION = 'qdraft1';

export function encodeDraftRef(blockId: string, version: number): string {
  return `${DRAFT_REF_VERSION}:${blockId}:${version}`;
}

export function parseDraftRef(raw: string): { blockId: string; version: number } | null {
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [version, blockId, v] = parts;
  if (version !== DRAFT_REF_VERSION) return null;
  const parsed = Number.parseInt(v, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return { blockId, version: parsed };
}
