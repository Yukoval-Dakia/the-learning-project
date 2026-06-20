// YUK-358 / ADR-0040 决定7, rider-1 — the single-sourced verified-block detector
// (cross-subject, no IO). Extracted byte-equivalent from apply-note-patch.ts's
// inline isVerifiedBlock so the apply guard (core/blocks/apply-note-patch.ts) and
// the job-gate predicate (capabilities/notes/server/note-refine-policy.ts) share
// ONE口径 instead of two drifting copies.
//
// A block is user-owned (protected) when the human explicitly verified it
// (`attrs.user_verified === true`) or its provenance tier is `user_verified`
// (NoteSection.source_tier). Mirrors the read-channel detector used by the
// projection (body-blocks.ts) and UI (NoteBlocks.tsx).
export function isVerifiedBlock(node: Record<string, unknown>): boolean {
  const attrs = node.attrs;
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) return false;
  const a = attrs as Record<string, unknown>;
  return a.user_verified === true || a.source_tier === 'user_verified';
}
