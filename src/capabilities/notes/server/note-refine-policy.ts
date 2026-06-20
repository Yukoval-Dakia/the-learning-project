import { isVerifiedBlock } from '@/core/blocks/is-verified-block';
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
// — detected via the shared isVerifiedBlock (core/blocks/is-verified-block.ts),
// the same口径 applyNotePatch's guard + the read-channel detector consult.
//
// NARROW口径: only replace_block | delete_block count — insert_after adds a
// sibling and never touches the verified block's content, so it is allowed.
export function patchTouchesVerifiedBlock(bodyBlocks: unknown, patch: NotePatchT): boolean {
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) return false;

  // YUK-358 决定7 rider-1: detection delegates to the shared isVerifiedBlock口径
  // (flag OR source_tier) so the gate and applyNotePatch's guard never drift.
  const verifiedIds = new Set<string>();
  for (const node of parsed.data.content ?? []) {
    const record = node as Record<string, unknown>;
    const id = (record.attrs as { id?: unknown } | null | undefined)?.id;
    if (typeof id !== 'string') continue;
    if (isVerifiedBlock(record)) verifiedIds.add(id);
  }
  if (verifiedIds.size === 0) return false;

  return patch.ops.some(
    (op) =>
      (op.kind === 'replace_block' || op.kind === 'delete_block') &&
      verifiedIds.has(op.target_block_id),
  );
}
