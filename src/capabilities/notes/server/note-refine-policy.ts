import { ArtifactBodyBlocks } from '@/core/schema/business';
import type { NotePatchSummary, NotePatchT } from '@/core/schema/note-patch';

export const MUTATOR_MAX_OPS = 3;
export const MUTATOR_MAX_NEW_BLOCKS = 2;

export type NoteRefineApplyMode = 'mutator' | 'propose';

export function decideNoteRefineMode(summary: NotePatchSummary): NoteRefineApplyMode {
  return summary.ops_count <= MUTATOR_MAX_OPS && summary.new_blocks <= MUTATOR_MAX_NEW_BLOCKS
    ? 'mutator'
    : 'propose';
}

// C1a (YUK-358, ADR-0040 决定1) — pure predicate the note_refine job-gate uses
// to divert a mutator-sized patch to propose when it would overwrite/delete a
// user-verified block. Kept separate from `decideNoteRefineMode` (count-only)
// so that gate's existing unit semantics stay untouched. A block is verified
// when `attrs.user_verified === true` OR `attrs.source_tier === 'user_verified'`
// (mirrors applyNotePatch's isVerifiedBlock + the read-channel detector).
//
// NARROW口径: only replace_block | delete_block count — insert_after adds a
// sibling and never touches the verified block's content, so it is allowed.
export function patchTouchesVerifiedBlock(bodyBlocks: unknown, patch: NotePatchT): boolean {
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) return false;

  const verifiedIds = new Set<string>();
  for (const node of parsed.data.content ?? []) {
    const attrs = (node as { attrs?: unknown }).attrs;
    if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) continue;
    const a = attrs as Record<string, unknown>;
    const id = a.id;
    if (typeof id !== 'string') continue;
    if (a.user_verified === true || a.source_tier === 'user_verified') verifiedIds.add(id);
  }
  if (verifiedIds.size === 0) return false;

  return patch.ops.some(
    (op) =>
      (op.kind === 'replace_block' || op.kind === 'delete_block') &&
      verifiedIds.has(op.target_block_id),
  );
}
