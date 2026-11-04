// YUK-1548 — server-side block identity. Lives in kernel (never in the
// core/schema barrel) so the UI-facing contract stays free of node:crypto.

import { createHash } from 'node:crypto';
import { type BlockV1T, canonicalBlockJson } from '@/core/schema/blocks';

/** `sha256:<64hex>` of the canonical JSON — the block's frozen identity. */
export function blockDigest(block: BlockV1T): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalBlockJson(block), 'utf8').digest('hex')}`;
}

/** Content-derived compose ref: `blk_` + first 32 hex of the block digest. */
export function blockRefForDigest(digest: `sha256:${string}`): `blk_${string}` {
  return `blk_${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}
