// YUK-1548 (D1/§8 W1–W3) — the canonical stored form and the `block:` draft
// ref scheme. `BlockV1` JSON inside a fenced code block whose info string is
// `tlp-block`; identical in chat reply_md, note codeBlock and material content_md.

import { BlockV1, type BlockV1T } from './block';

export const TLP_BLOCK_FENCE_INFO = 'tlp-block' as const;
export const BLOCK_REF_SCHEME = 'block:' as const;
export const BLOCK_REF_PATTERN = /^blk_[0-9a-f]{32}$/;
/**
 * `![alt](block:<ref>)` — draft-text placement syntax. Deliberately tolerant
 * of the ref token: any `block:` image ref that fails lookup is dropped at
 * commit (draft refs must never persist), not left as a literal.
 */
export const BLOCK_PLACE_PATTERN = /!\[(.{0,400}?)\]\(block:([A-Za-z0-9_-]{1,80})\)/g;

/** Deterministic JSON (sorted keys) — the bytes the digest is computed over. */
export function canonicalBlockJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBlockJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalBlockJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The canonical fenced form stored in Markdown. */
export function serializeBlockFence(block: BlockV1T): string {
  return `\`\`\`${TLP_BLOCK_FENCE_INFO}\n${canonicalBlockJson(block)}\n\`\`\``;
}

/**
 * Parse one fence body into a BlockV1. Input is the raw code-block body (the
 * JSON object, not including the backticks or info string). Returns the parsed
 * block or undefined — the UI renders the quiet fallback on failure.
 */
export function parseBlockFence(body: string): BlockV1T | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  const parsed = BlockV1.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
