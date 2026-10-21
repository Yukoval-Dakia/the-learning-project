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

// Diverts a mutator-sized patch to propose when it would overwrite a verified
// block. Kept separate from the count gate so their semantics stay independent.
// Only replace/delete count: insert_after never touches the verified content.
export function patchTouchesVerifiedBlock(bodyBlocks: unknown, patch: NotePatchT): boolean {
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) return false;

  // Shared detector so the gate and applyNotePatch's guard cannot drift.
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
