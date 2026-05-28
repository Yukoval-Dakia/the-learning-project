import type { NotePatchSummary } from '@/core/schema/note-patch';

export const MUTATOR_MAX_OPS = 3;
export const MUTATOR_MAX_NEW_BLOCKS = 2;

export type NoteRefineApplyMode = 'mutator' | 'propose';

export function decideNoteRefineMode(summary: NotePatchSummary): NoteRefineApplyMode {
  return summary.ops_count <= MUTATOR_MAX_OPS && summary.new_blocks <= MUTATOR_MAX_NEW_BLOCKS
    ? 'mutator'
    : 'propose';
}
